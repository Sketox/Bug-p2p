// Utilidades compartidas por los bancos de V&V (seguridad y validación distribuida).
//
// Las dos suites hacen lo mismo por debajo: levantar el servidor de señalización DE VERDAD en un
// puerto libre, hablarle por WebSocket como lo haría un navegador, y anotar lo que pasa. Nada de
// dobles ni de simulaciones: lo que se ataca y lo que se mide es el binario que se despliega.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Un puerto que el sistema operativo dé por libre ahora mismo. */
export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Levanta `signaling/src/server.ts` como proceso aparte y espera a que conteste `/health`.
 *
 * Como proceso aparte y no importándolo: así se prueba el arranque completo (lectura de `PORT`,
 * servidor HTTP, `WebSocketServer` sobre él) y un cuelgue del servidor durante un ataque de
 * inundación se ve como lo que es —el proceso deja de responder— en vez de tumbar al atacante.
 */
/** Compila `signaling/` una vez por ejecución: el banco corre contra el JS que se despliega. */
let compilado = false;
export function compilarSignaling() {
  if (compilado) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build', '--workspace', '@bug/signaling'], {
    cwd: repoRoot,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    throw new Error(`no compila la señalización:\n${r.stdout}\n${r.stderr}`);
  }
  compilado = true;
}

export async function startSignaling(env = {}) {
  compilarSignaling();
  const port = await freePort();
  // Se ejecuta el JavaScript compilado con `node` a secas, sin `npx` ni `tsx` de por medio: en
  // Windows esos lanzadores dejan un proceso intermedio que sobrevive al `kill`, y el puerto de una
  // prueba se quedaba ocupado en la siguiente. Además así se prueba exactamente el artefacto que
  // se despliega en la imagen, no una transpilación al vuelo.
  const child = spawn(process.execPath, [resolve(repoRoot, 'signaling', 'dist', 'server.js')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const salida = [];
  child.stdout.on('data', (d) => salida.push(String(d)));
  child.stderr.on('data', (d) => salida.push(String(d)));

  const url = `ws://127.0.0.1:${port}`;
  const health = `http://127.0.0.1:${port}/health`;

  const limite = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`la señalización murió al arrancar:\n${salida.join('')}`);
    }
    try {
      const r = await fetch(health);
      if (r.ok) break;
    } catch {
      /* todavía no escucha */
    }
    if (Date.now() > limite) throw new Error(`la señalización no arrancó:\n${salida.join('')}`);
    await sleep(200);
  }

  return {
    url,
    health,
    port,
    salida,
    /** ¿Sigue en pie? Es la comprobación que importa después de inundarlo. */
    async vivo(timeoutMs = 3000) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(health, { signal: ctrl.signal });
        clearTimeout(t);
        return r.ok;
      } catch {
        return false;
      }
    },
    stop() {
      return new Promise((ok) => {
        if (child.exitCode !== null) return ok();
        child.once('exit', () => ok());
        // En Windows, matar el árbol: `npx` lanza a `tsx`, que lanza a node.
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
        setTimeout(ok, 3000);
      });
    },
  };
}

/**
 * Un cliente de señalización con memoria: guarda todo lo que le llega para poder afirmar cosas
 * sobre ello después ("¿le llegó a Bob una señal firmada como Alice?").
 */
export class Cliente {
  constructor(url, etiqueta) {
    this.etiqueta = etiqueta;
    this.recibidos = [];
    this.cerrado = false;
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      try {
        this.recibidos.push(JSON.parse(String(raw)));
      } catch {
        this.recibidos.push({ t: '(no-json)', raw: String(raw) });
      }
    });
    this.ws.on('close', () => {
      this.cerrado = true;
    });
    this.ws.on('error', () => {
      /* al atacar se provocan cierres a propósito */
    });
    this.listo = new Promise((ok, fail) => {
      this.ws.once('open', ok);
      this.ws.once('error', fail);
    });
  }

  static async abrir(url, etiqueta) {
    const c = new Cliente(url, etiqueta);
    await c.listo;
    return c;
  }

  enviar(msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  }

  /** Espera a que llegue un mensaje que cumpla `pred`, o `null` si no llega a tiempo. */
  async espera(pred, ms = 1500) {
    const limite = Date.now() + ms;
    for (;;) {
      const hit = this.recibidos.find(pred);
      if (hit) return hit;
      if (Date.now() > limite) return null;
      await sleep(25);
    }
  }

  de(tipo) {
    return this.recibidos.filter((m) => m.t === tipo);
  }

  cerrar() {
    try {
      this.ws.close();
    } catch {
      /* ya estaba */
    }
  }
}

/** Escribe el informe en `vv/informes/` y devuelve la ruta. */
export function guardarInforme(nombre, datos) {
  const dir = resolve(repoRoot, 'vv', 'informes');
  mkdirSync(dir, { recursive: true });
  const marca = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ruta = resolve(dir, `${nombre}-${marca}.json`);
  writeFileSync(ruta, JSON.stringify(datos, null, 2), 'utf8');
  // Y una copia con nombre fijo, que es la que citan los documentos de V&V.
  writeFileSync(resolve(dir, `${nombre}-ultimo.json`), JSON.stringify(datos, null, 2), 'utf8');
  return ruta;
}

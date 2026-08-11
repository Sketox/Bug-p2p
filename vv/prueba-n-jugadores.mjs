#!/usr/bin/env node
// Abre N navegadores DE VERDAD contra una dirección, monta una partida y cuenta lo que pasa.
//
// Existe porque las pruebas de Cypress montan los nodos en iframes de una misma página: eso vale
// para comprobar la lógica, pero no reproduce lo que vive un jugador con su propia pestaña, su
// propia sesión y su propio handshake. Cuando alguien dice «lo intenté con 6 y dio error», esto es
// lo que hay que ejecutar antes de tocar nada — para saber si el problema es el juego o la red.
//
//   node vv/prueba-n-jugadores.mjs 6                          # contra la web local
//   node vv/prueba-n-jugadores.mjs 6 https://algo.trycloudflare.com
//
// Devuelve 1 si alguien se queda fuera, sin mesa o con un error en pantalla.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CUANTOS = Number(process.argv[2] ?? 6);
const WEB = process.argv[3] ?? 'http://localhost:3000';
const PUERTO_CDP = 9333;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const perfil = mkdtempSync(join(tmpdir(), 'bug-n-'));

class Pestaña {
  constructor(ws, nombre) {
    this.ws = ws;
    this.nombre = nombre;
    this.id = 0;
    this.pendientes = new Map();
    ws.on('message', (b) => {
      const m = JSON.parse(b.toString());
      const p = this.pendientes.get(m.id);
      if (p) {
        this.pendientes.delete(m.id);
        m.error ? p.rechaza(new Error(m.error.message)) : p.resuelve(m.result);
      }
    });
  }

  static async abrir(url, nombre) {
    const r = await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    const { webSocketDebuggerUrl } = await r.json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
    return new Pestaña(ws, nombre);
  }

  manda(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resuelve, rechaza) => this.pendientes.set(id, { resuelve, rechaza }));
  }

  async evalua(expresion) {
    const r = await this.manda('Runtime.evaluate', {
      expression: expresion,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value ?? null;
  }

  async hasta(expresion, queEs, intentos = 60) {
    for (let i = 0; i < intentos; i++) {
      const v = await this.evalua(expresion).catch(() => null);
      if (v) return v;
      await espera(500);
    }
    throw new Error(`${this.nombre}: no apareció ${queEs}`);
  }

  /** Lo que se ve en pantalla, para poder contarlo cuando algo falla. */
  texto() {
    return this.evalua('document.body.innerText.slice(0, 1200)');
  }
}

const escribir = (sel, texto) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(texto)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const pulsar = (texto) => `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(texto)}));
  if (!b || b.disabled) return null;
  b.click();
  return true;
})()`;

const NOMBRES = ['Ana', 'Beto', 'Caro', 'Dina', 'Elio', 'Fran', 'Gala', 'Hugo', 'Iker', 'Julia'];

console.log(`\n  ${CUANTOS} navegadores contra ${WEB}\n`);

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${PUERTO_CDP}`,
  `--user-data-dir=${perfil}`,
  '--no-first-run',
  '--window-size=1280,900',
]);
chrome.on('error', (e) => console.error('  ✕ Chrome:', e.message));

for (let i = 0; i < 40; i++) {
  try {
    await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/version`);
    break;
  } catch {
    await espera(500);
  }
}

let fallos = 0;
const pestañas = [];
try {
  // 1) El anfitrión crea la sala.
  const anfitrion = await Pestaña.abrir(WEB, NOMBRES[0]);
  pestañas.push(anfitrion);
  await anfitrion.hasta(`!!document.querySelector('input[placeholder="¿Cómo te llamas?"]')`, 'el menú');
  await anfitrion.evalua(escribir('input[placeholder="¿Cómo te llamas?"]', NOMBRES[0]));
  await espera(250);
  await anfitrion.evalua(pulsar('Crear sala'));
  const sala = await anfitrion.hasta(
    `document.querySelector('[data-testid="room-code"]')?.textContent?.trim() || null`,
    'el código de sala',
  );
  console.log(`  ${NOMBRES[0]} creó la sala ${sala}`);

  // 2) Los demás entran, de uno en uno, dando tiempo a que la malla se rehaga.
  for (let i = 1; i < CUANTOS; i++) {
    const p = await Pestaña.abrir(WEB, NOMBRES[i]);
    pestañas.push(p);
    await p.hasta(`!!document.querySelector('input[placeholder="¿Cómo te llamas?"]')`, 'el menú');
    await p.evalua(escribir('input[placeholder="¿Cómo te llamas?"]', NOMBRES[i]));
    await espera(250);
    await p.evalua(escribir('input[placeholder="CÓDIGO"]', sala));
    await espera(250);
    await p.evalua(pulsar('Unirse'));
    console.log(`  ${NOMBRES[i]} se une…`);
    await espera(1200);
  }

  // 3) ¿Se ven todos entre ellos? Es la comprobación que de verdad falla cuando la malla no cuaja.
  console.log('');
  for (const p of pestañas) {
    const visto = await p
      .hasta(`document.body.innerText.includes('${CUANTOS}/${CUANTOS}') ? '${CUANTOS}/${CUANTOS}' : null`, 'el censo completo', 40)
      .catch(() => null);
    if (visto) {
      console.log(`  ✓ ${p.nombre.padEnd(6)} ve a los ${CUANTOS}`);
    } else {
      fallos++;
      const t = (await p.texto()) ?? '';
      const pista = t.split('\n').filter(Boolean).slice(0, 4).join(' · ');
      console.log(`  ✕ ${p.nombre.padEnd(6)} NO ve a los ${CUANTOS} → ${pista.slice(0, 110)}`);
    }
  }

  // 4) Empezar la partida y comprobar que a todos les llega la mesa.
  console.log('');
  await anfitrion.evalua(pulsar('¡Empezar!'));
  for (const p of pestañas) {
    const mesa = await p
      .hasta(`document.body.innerText.includes('Pasar') || null`, 'la mesa repartida', 40)
      .catch(() => null);
    if (mesa) {
      console.log(`  ✓ ${p.nombre.padEnd(6)} tiene mesa`);
    } else {
      fallos++;
      const t = (await p.texto()) ?? '';
      console.log(`  ✕ ${p.nombre.padEnd(6)} SIN mesa → ${t.split('\n').filter(Boolean).slice(0, 3).join(' · ').slice(0, 110)}`);
    }
  }

  // 5) ¿Alguien tiene un error en pantalla?
  console.log('');
  for (const p of pestañas) {
    const t = (await p.texto()) ?? '';
    const malo = ['⚠', 'Application error', 'reconectando', 'SALA LLENA', 'Error'].find((x) => t.includes(x));
    if (malo) {
      fallos++;
      console.log(`  ⚠ ${p.nombre}: aparece «${malo}» en pantalla`);
    }
  }
  if (fallos === 0) console.log(`  Sin errores en pantalla. ${CUANTOS} jugadores, partida en marcha.`);
} catch (e) {
  fallos++;
  console.error('\n  ✕', e.message);
} finally {
  chrome.kill();
  await espera(500);
  try {
    rmSync(perfil, { recursive: true, force: true });
  } catch {
    /* el perfil temporal se queda; da igual */
  }
}

console.log(fallos === 0 ? '\n  RESULTADO: OK\n' : `\n  RESULTADO: ${fallos} problema(s)\n`);
process.exit(fallos === 0 ? 0 : 1);

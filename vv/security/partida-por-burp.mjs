#!/usr/bin/env node
// Juega una partida de verdad, en navegadores de verdad, ATRAVESANDO el proxy de Burp.
//
// Existe porque la evidencia de Burp es la única que no se puede sacar sola, y las vías obvias no
// valen: un cliente de Node cruza el proxy pero Burp no lo apunta en su historial de WebSockets, y
// Cypress **nunca** manda `localhost` por el proxy (lo excluye siempre). El navegador que abre el
// propio Burp sí lo hace, porque arranca con esa exclusión desactivada — y eso es justo lo que se
// reproduce aquí: un Chrome con `--proxy-bypass-list=<-loopback>`.
//
// Lo que deja en Burp es lo que hay que enseñar: los saludos que presentan a los jugadores. Ni una
// carta, ni una mano, ni el mazo — eso va cifrado por WebRTC y no pasa por ningún intermediario.
//
//   node vv/security/partida-por-burp.mjs [proxy] [web]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const proxy = process.argv[2] ?? '127.0.0.1:8081';
const web = process.argv[3] ?? 'http://localhost:3000';
const PUERTO_CDP = 9222;

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const perfil = mkdtempSync(join(tmpdir(), 'bug-burp-'));

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Una pestaña, manejada por el protocolo de depuración de Chrome. */
class Pestaña {
  constructor(ws) {
    this.ws = ws;
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

  static async abrir(url) {
    const r = await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    const { webSocketDebuggerUrl } = await r.json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
    return new Pestaña(ws);
  }

  manda(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resuelve, rechaza) => this.pendientes.set(id, { resuelve, rechaza }));
  }

  /** Evalúa en la página y devuelve el valor. Los `undefined` vuelven como null. */
  async evalua(expresion) {
    const r = await this.manda('Runtime.evaluate', {
      expression: expresion,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value ?? null;
  }

  /** Reintenta hasta que la expresión devuelva algo con valor. */
  async hasta(expresion, queEs, intentos = 40) {
    for (let i = 0; i < intentos; i++) {
      const v = await this.evalua(expresion).catch(() => null);
      if (v) return v;
      await espera(500);
    }
    throw new Error(`no apareció: ${queEs}`);
  }
}

// React escucha el evento, no la asignación: hay que usar el `setter` nativo para que se entere.
const escribir = (selector, texto) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
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

console.log(`\n  Chrome → proxy ${proxy} (sin excluir localhost) → ${web}\n`);

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${PUERTO_CDP}`,
  `--user-data-dir=${perfil}`,
  `--proxy-server=${proxy}`,
  // La clave de todo: sin esto Chrome se salta el proxy para `localhost` y Burp no ve nada.
  '--proxy-bypass-list=<-loopback>',
  '--no-first-run',
  '--window-size=1280,900',
]);
chrome.on('error', (e) => console.error('  ✕ Chrome:', e.message));

// Esperar a que el depurador conteste.
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/version`);
    break;
  } catch {
    await espera(500);
  }
}

try {
  const ana = await Pestaña.abrir(web);
  await ana.hasta(`!!document.querySelector('input[placeholder="¿Cómo te llamas?"]')`, 'el menú');
  await ana.evalua(escribir('input[placeholder="¿Cómo te llamas?"]', 'Ana'));
  await espera(300);
  await ana.evalua(pulsar('Crear sala'));

  const codigo = await ana.hasta(
    `document.querySelector('[data-testid="room-code"]')?.textContent?.trim() || null`,
    'el código de sala',
  );
  console.log(`  Ana creó la sala ${codigo}`);

  const beto = await Pestaña.abrir(web);
  await beto.hasta(`!!document.querySelector('input[placeholder="¿Cómo te llamas?"]')`, 'el menú');
  await beto.evalua(escribir('input[placeholder="¿Cómo te llamas?"]', 'Beto'));
  await espera(300);
  await beto.evalua(escribir('input[placeholder="CÓDIGO"]', codigo));
  await espera(300);
  await beto.evalua(pulsar('Unirse'));
  console.log('  Beto se unió — aquí es donde cruzan las señales por el servidor');

  await ana.hasta(`document.body.innerText.includes('¡Empezar!') || null`, 'el botón de empezar');
  await espera(800);
  await ana.evalua(pulsar('¡Empezar!'));

  const repartida = await ana
    .hasta(`document.body.innerText.includes('Pasar') || null`, 'la mesa repartida', 30)
    .catch(() => null);
  console.log(repartida ? '  Partida empezada: la mesa está repartida' : '  (la mesa tardó, pero la señalización ya pasó)');

  await espera(1500);
} finally {
  chrome.kill();
  await espera(500);
  try {
    rmSync(perfil, { recursive: true, force: true });
  } catch {
    /* el perfil temporal se queda; no importa */
  }
}

console.log('\n  Listo. En Burp: Proxy → WebSockets history, y filtra por 8787.\n');

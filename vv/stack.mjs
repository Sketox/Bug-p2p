#!/usr/bin/env node
// Levanta lo que las pruebas de extremo a extremo necesitan: la señalización y la web.
//
// Va en modo desarrollo (`next dev`) a propósito, y no con la imagen de producción, por una razón
// concreta: la ventana de depuración `window.__bug` —que expone el estado replicado y su huella—
// solo existe fuera de producción. Es lo que permite a Cypress comprobar que tres nodos
// convergieron sin tener que deducirlo mirando cartas en pantalla.
//
// Se usa desde `npm run e2e`, que espera a que los dos contesten antes de arrancar Cypress.

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const hijos = [];

function arrancar(nombre, args, env) {
  const p = spawn(npm, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  p.on('exit', (code) => {
    console.log(`[stack] ${nombre} terminó con código ${code}`);
    apagar(code ?? 0);
  });
  hijos.push(p);
  return p;
}

let apagando = false;
function apagar(code) {
  if (apagando) return;
  apagando = true;
  for (const p of hijos) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(p.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        p.kill('SIGTERM');
      }
    } catch {
      /* ya no estaba */
    }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => apagar(0));
process.on('SIGTERM', () => apagar(0));

arrancar('señalización', ['run', 'signaling'], { PORT: '8787' });
arrancar('web', ['run', 'web'], { PORT: '3000' });

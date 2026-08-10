#!/usr/bin/env node
// Abre TODO el material de V&V en esta máquina: los documentos, las evidencias y los paneles.
//
// Existe porque el material está repartido por naturaleza —unos archivos en `docs/vv/`, dos
// servicios en contenedores— y para enseñarlo había que ir recordando rutas y puertos. Esto lo
// abre de una vez, y dice en voz alta lo que falta en vez de abrir una pestaña en blanco.
//
//   npm run vv:ver
//
// Lo que no encuentre, lo explica: si no hay informe, cómo generarlo; si Jenkins no responde, cómo
// levantar el laboratorio.

import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Abre una ruta o URL con el programa que el sistema tenga asociado. */
function abrir(objetivo) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', objetivo]]
      : process.platform === 'darwin'
        ? ['open', [objetivo]]
        : ['xdg-open', [objetivo]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

const url = (rel) => 'file:///' + join(raiz, rel).split('\\').join('/');

/** ¿Contesta algo en esa dirección? Se usa para no abrir pestañas hacia un servicio apagado. */
async function responde(direccion) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    await fetch(direccion, { signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

const documentos = [
  ['docs/vv/presentacion.html', 'Presentación de defensa (31 diapositivas)', 'npm run vv:presentacion'],
  ['docs/vv/informe-pruebas.html', 'Informe con las 227 pruebas, una a una', 'npm run vv:informe'],
];

const paneles = [
  ['http://localhost:8080/job/bug-p2p/', 'Jenkins — el pipeline y sus construcciones'],
  ['http://localhost:9000/dashboard?id=bug-p2p', 'SonarQube — calidad del código'],
];

console.log('\n— Material de V&V de Bug —\n');

let faltan = 0;
for (const [rel, que, comando] of documentos) {
  if (existsSync(join(raiz, rel))) {
    console.log(`  ✓ ${que}\n      ${rel}`);
    abrir(url(rel));
  } else {
    faltan++;
    console.log(`  ✕ ${que} — no está generado todavía\n      genéralo con: ${comando}`);
  }
}

// Las evidencias son una carpeta: se abre en el explorador, no en el navegador.
const evidencias = join(raiz, 'docs/vv/evidencias');
if (existsSync(evidencias)) {
  console.log('  ✓ Capturas del juego y de los paneles\n      docs/vv/evidencias/');
  abrir(evidencias);
} else {
  faltan++;
  console.log('  ✕ Capturas — no están\n      genéralas con: npm run e2e');
}

let apagados = 0;
for (const [direccion, que] of paneles) {
  if (await responde(direccion)) {
    console.log(`  ✓ ${que}\n      ${direccion}`);
    abrir(direccion);
  } else {
    apagados++;
    console.log(`  ✕ ${que} — no responde`);
  }
}

if (apagados) {
  console.log('\n  Para levantar el laboratorio:');
  console.log('    docker compose -f vv/docker-compose.yml up -d');
  console.log('    node vv/setup.mjs');
  console.log('  Jenkins entra con admin / bug-vv.');
}
if (faltan) {
  console.log('\n  Para generarlo todo de una vez:  npm run vv:entregables');
}

console.log('\n  Los documentos escritos (plan, matriz, reporte, guía de pruebas) están en docs/vv/.\n');

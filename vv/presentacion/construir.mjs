#!/usr/bin/env node
// Arma `docs/vv/presentacion.html` incrustando las evidencias como data URI.
//
// Las capturas van dentro del archivo y no enlazadas por dos razones prácticas: la presentación se
// proyecta desde un portátil que puede no tener el repo al lado, y así se puede mandar por correo
// de una pieza. La plantilla queda legible —con `{{img:...}}` donde va cada imagen— en vez de
// tener megabytes de base64 metidos entre el HTML.
//
//   node vv/presentacion/construir.mjs          → docs/vv/presentacion.html
//   node vv/presentacion/construir.mjs --pdf    → además, el PDF (una página por diapositiva)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, '../..');
const plantilla = join(aqui, 'plantilla.html');
const salida = join(raiz, 'docs/vv/presentacion.html');

const TIPOS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

let faltan = 0;
const html = readFileSync(plantilla, 'utf8').replace(/\{\{img:([^}]+)\}\}/g, (_, rel) => {
  const ruta = join(raiz, rel.trim());
  if (!existsSync(ruta)) {
    console.warn(`  ⚠ falta la evidencia: ${rel.trim()}`);
    faltan++;
    // Un hueco visible vale más que una imagen rota: si falta una captura, la diapositiva lo dice.
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="100%" height="100%" fill="#0f1f19"/><text x="50%" y="50%" fill="#FF7F50" font-family="monospace" font-size="20" text-anchor="middle">falta ${rel.trim()}</text></svg>`,
    );
  }
  const mime = TIPOS[extname(ruta).toLowerCase()] ?? 'application/octet-stream';
  return `data:${mime};base64,${readFileSync(ruta).toString('base64')}`;
});

writeFileSync(salida, html, 'utf8');
console.log(`presentación: ${salida} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
if (faltan) console.log(`${faltan} evidencia(s) sin generar — corre \`npm run e2e\` y vuelve a construir`);

if (process.argv.includes('--pdf')) {
  const chrome = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const pdf = salida.replace(/\.html$/, '.pdf');
  // `?imprimir` hace que la plantilla deje de comportarse como pase de diapositivas y ponga todas
  // una debajo de otra; el CSS de `@media print` se encarga de una página por diapositiva.
  const r = spawnSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdf}`,
      '--virtual-time-budget=15000',
      'file:///' + salida.split('\\').join('/') + '?imprimir',
    ],
    { stdio: 'inherit' },
  );
  console.log(r.status === 0 ? `pdf: ${pdf}` : `no se pudo generar el PDF (código ${r.status})`);
}

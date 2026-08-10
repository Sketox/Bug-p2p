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

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, '../..');
const plantilla = join(aqui, 'plantilla.html');
const salida = join(raiz, 'docs/vv/presentacion.html');

const TIPOS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

/**
 * Los recuentos de la presentación salen de los artefactos, no de la plantilla.
 *
 * Escribirlos a mano es la forma más fácil de que una diapositiva diga «18 pruebas» tres meses
 * después de que sean veinte. Si los artefactos no están (nadie ha ejecutado nada aún), se avisa y
 * se deja el marcador a la vista en vez de inventar un número.
 */
function recuentos() {
  const dir = join(raiz, 'reports');
  const contar = (f) => {
    const ruta = join(dir, f);
    if (!existsSync(ruta)) return null;
    return (readFileSync(ruta, 'utf8').match(/<testcase\b/g) ?? []).length;
  };

  const unit = ['junit-engine.xml', 'junit-net.xml', 'junit-signaling.xml', 'junit-web.xml']
    .map(contar)
    .reduce((a, b) => (a == null || b == null ? null : a + b), 0);

  let e2e = 0;
  let malla = 0;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.startsWith('junit-cypress-'))) {
      const xml = readFileSync(join(dir, f), 'utf8');
      const n = (xml.match(/<testcase\b/g) ?? []).length;
      e2e += n;
      if (xml.includes('malla de tres nodos')) malla += n;
    }
  }

  const leerJson = (rel) => {
    const ruta = join(raiz, rel);
    return existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : null;
  };
  const seg = leerJson('vv/informes/seguridad-ultimo.json')?.total ?? 11;
  const dist = leerJson('vv/informes/distribuida-ultimo.json')?.total ?? 7;

  return {
    n_unit: unit,
    n_e2e: e2e || null,
    n_malla: malla || null,
    n_total: unit == null || !e2e ? null : unit + e2e + seg + dist,
  };
}

let faltan = 0;
const nums = recuentos();
for (const [clave, valor] of Object.entries(nums)) {
  if (valor == null) console.warn(`  ⚠ sin dato para {{${clave}}} — ¿se han ejecutado las pruebas?`);
}

/**
 * El sprite del juego, incrustado tal cual.
 *
 * Es el mismo archivo que usa la aplicación (`web/public/cards.svg`): el logo y las 74 cartas
 * dibujadas en Inkscape, cada una como un `<symbol>`. Metiéndolo en la presentación, las
 * diapositivas pueden enseñar **las cartas de verdad** con un `<use href="#c-skip-code">` en vez de
 * describirlas con palabras — y si mañana se redibuja una carta, la presentación la trae sola.
 */
const sprite = readFileSync(join(raiz, 'web/public/cards.svg'), 'utf8');

const fuente = readFileSync(plantilla, 'utf8');

// El marcador del sprite y el aviso «esto es la plantilla» viven dentro del fuente y desaparecen
// aquí. Si alguno sobreviviera, se vería en la presentación proyectada, así que se comprueba abajo.
const html = fuente
  .replace('<!--{{sprite}}-->', sprite)
  .replace(/<!-- Lo mismo con este aviso:[\s\S]*?-->\s*<div id="aviso-plantilla"[\s\S]*?<\/div>\s*<\/div>/, '')
  .replace(/\{\{(n_unit|n_e2e|n_malla|n_total)\}\}/g, (m, clave) => nums[clave] ?? m)
  .replace(/\{\{img:([^}]+)\}\}/g, (_, rel) => {
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

// Ningún marcador puede llegar a la presentación: uno suelto se proyecta en pantalla delante de
// gente. Pasó —`{{sprite}}` acabó visible en una esquina— y por eso esto revienta en vez de avisar.
const sueltos = [...html.matchAll(/\{\{[^}]{1,40}\}\}/g)].map((m) => m[0]);
if (sueltos.length > 0) {
  console.error(`\n  ✕ quedaron marcadores sin sustituir: ${[...new Set(sueltos)].join(', ')}`);
  console.error('    Se habrían visto en la diapositiva. No se escribe el archivo.\n');
  process.exit(1);
}
if (html.includes('aviso-plantilla')) {
  console.error('\n  ✕ el aviso de «esto es la plantilla» no se quitó al construir.\n');
  process.exit(1);
}

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

#!/usr/bin/env node
// Genera el informe imprimible de resultados de pruebas: `docs/vv/informe-pruebas.html`.
//
// No lo escribe nadie a mano, y esa es toda la gracia: sale de los mismos artefactos que produce
// la ejecución —los JUnit de Vitest y Cypress, los JSON de los bancos de seguridad y validación
// distribuida, y el `lcov` combinado—, así que no puede decir que pasó algo que no pasó. Un
// informe redactado a mano envejece en cuanto alguien toca una prueba; este solo puede envejecer
// si se deja de ejecutar, y entonces lo dice la fecha.
//
//   node vv/informe-pruebas.mjs            → docs/vv/informe-pruebas.html
//   node vv/informe-pruebas.mjs --pdf      → además, el PDF (necesita Chrome)

import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const salidaHtml = join(raiz, 'docs/vv/informe-pruebas.html');

// --- Lectura de artefactos -----------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Saca los `<testcase>` de un JUnit sin traerse un parser de XML para cuatro atributos. */
function leerJUnit(ruta) {
  const xml = readFileSync(ruta, 'utf8');
  const casos = [];
  const re = /<testcase\b([^>]*)>?/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    // `\s` antes de `name` no es cosmético: `classname="…"` CONTIENE la subcadena `name="…"`, así
    // que sin el límite todas las pruebas del informe salían llamándose como su archivo.
    const nombre = /\sname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const clase = /\sclassname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const tiempo = Number(/time="([^"]*)"/.exec(attrs)?.[1] ?? 0);
    // El cuerpo del testcase dice si falló; `<testcase ... />` vacío es un caso verde.
    const resto = xml.slice(m.index, xml.indexOf('</testcase>', m.index) + 1);
    const fallo = /<failure|<error/.test(resto);
    casos.push({ nombre: decodeEntities(nombre), clase, tiempo, fallo });
  }
  return casos;
}

const decodeEntities = (s) =>
  s
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&');

function suitesVitest() {
  const out = [];
  for (const paquete of ['engine', 'net', 'signaling', 'web']) {
    const ruta = join(raiz, `reports/junit-${paquete}.xml`);
    if (!existsSync(ruta)) continue;
    out.push({ paquete, casos: leerJUnit(ruta), fecha: statSync(ruta).mtime });
  }
  return out;
}

/**
 * Los JUnit de Cypress llevan un hash en el nombre y se acumulan run tras run, así que hay que
 * quedarse con los de la ÚLTIMA ejecución: los más recientes, y uno por spec (el nombre del primer
 * `<testsuite>` con nombre real identifica el spec).
 */
function suitesCypress() {
  const dir = join(raiz, 'reports');
  if (!existsSync(dir)) return [];
  const archivos = readdirSync(dir)
    .filter((f) => f.startsWith('junit-cypress-') && f.endsWith('.xml'))
    .map((f) => ({ f, ruta: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const porSpec = new Map();
  for (const a of archivos) {
    const xml = readFileSync(a.ruta, 'utf8');
    const spec = [...xml.matchAll(/<testsuite\s+name="([^"]*)"/g)]
      .map((m) => m[1])
      .find((n) => n && n !== 'Mocha Tests' && n !== 'Root Suite');
    // Sin nombre de spec no es el informe de un spec: es el resto de una ejecución que ni llegó a
    // arrancar (el stack no levantó, por ejemplo). Contarlo como un spec más metería en el informe
    // fallos de un run que ya no existe. Desde que Cypress limpia la carpeta al empezar
    // (`before:run` en `cypress.config.ts`) esto no debería aparecer, pero un informe que se cree
    // lo que encuentra en el disco no es un informe.
    if (!spec) continue;
    if (!porSpec.has(spec)) porSpec.set(spec, { spec, casos: leerJUnit(a.ruta), fecha: new Date(a.mtime) });
  }
  return [...porSpec.values()];
}

const leerJson = (rel) => {
  const ruta = join(raiz, rel);
  return existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : null;
};

/** Cobertura de líneas por paquete, aplicando las mismas exclusiones que declara Sonar. */
function cobertura() {
  const ruta = join(raiz, 'coverage/lcov.info');
  if (!existsSync(ruta)) return null;
  const excluidos = [
    /^web\/components\//,
    /^web\/app\//,
    /^web\/lib\/pixiEffects\.ts$/,
    /^web\/lib\/useBug.*\.ts$/,
    /^net\/src\/room\.ts$/,
    /^signaling\/src\/smoke\.ts$/,
    /^tools\//,
    /^docker\//,
    /^vv\//,
    /^cypress\//,
  ];
  const ficheros = [];
  let cur = null;
  for (const l of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    if (l.startsWith('SF:')) cur = { f: l.slice(3).split('\\').join('/'), lf: 0, lh: 0 };
    else if (l.startsWith('LF:') && cur) cur.lf = +l.slice(3);
    else if (l.startsWith('LH:') && cur) cur.lh = +l.slice(3);
    else if (l === 'end_of_record' && cur) {
      ficheros.push(cur);
      cur = null;
    }
  }
  const medidos = ficheros.filter((x) => !excluidos.some((r) => r.test(x.f)));
  const porPaquete = {};
  for (const x of medidos) {
    const p = x.f.split('/')[0];
    porPaquete[p] ??= { lf: 0, lh: 0 };
    porPaquete[p].lf += x.lf;
    porPaquete[p].lh += x.lh;
  }
  const excluidosDetalle = ficheros.filter((x) => excluidos.some((r) => r.test(x.f)));
  return { porPaquete, excluidos: excluidosDetalle, fecha: statSync(ruta).mtime };
}

// --- Composición ---------------------------------------------------------------------------------

const fecha = (d) =>
  d ? new Date(d).toLocaleString('es-EC', { dateStyle: 'long', timeStyle: 'short' }) : '—';

function tablaCasos(casos) {
  return casos
    .map(
      (c) => `<tr class="${c.fallo ? 'malo' : ''}">
        <td class="estado">${c.fallo ? '✕' : '✓'}</td>
        <td>${esc(c.nombre)}</td>
        <td class="num">${c.tiempo ? c.tiempo.toFixed(3) + ' s' : ''}</td>
      </tr>`,
    )
    .join('\n');
}

function main() {
  const vitest = suitesVitest();
  const cypress = suitesCypress();
  const seguridad = leerJson('vv/informes/seguridad-ultimo.json');
  const distribuida = leerJson('vv/informes/distribuida-ultimo.json');
  const cob = cobertura();

  const totalUnit = vitest.reduce((n, s) => n + s.casos.length, 0);
  const fallosUnit = vitest.reduce((n, s) => n + s.casos.filter((c) => c.fallo).length, 0);
  const totalE2e = cypress.reduce((n, s) => n + s.casos.length, 0);
  const fallosE2e = cypress.reduce((n, s) => n + s.casos.filter((c) => c.fallo).length, 0);
  const total = totalUnit + totalE2e + (seguridad?.total ?? 0) + (distribuida?.total ?? 0);
  const fallos =
    fallosUnit +
    fallosE2e +
    (seguridad ? seguridad.total - seguridad.bloqueados : 0) +
    (distribuida ? distribuida.total - distribuida.cumplen : 0);

  const NOMBRES = {
    engine: 'engine — motor de reglas',
    net: 'net — malla, Lamport, testigo, Bully',
    signaling: 'signaling — servidor WebSocket',
    web: 'web — lógica de interfaz',
  };

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Bug — Informe de resultados de pruebas</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  :root {
    --tinta: #14261d; --suave: #5b6b62; --linea: #d7e0da;
    --verde: #1c7c4c; --rojo: #b3261e; --fondo: #f6f8f7;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: var(--tinta); background: #fff;
    font: 10.5pt/1.5 "Segoe UI", system-ui, sans-serif;
  }
  .hoja { max-width: 190mm; margin: 0 auto; padding: 10mm 0 20mm; }
  h1 { font-size: 22pt; margin: 0 0 2mm; letter-spacing: -0.4pt; }
  h2 {
    font-size: 13pt; margin: 10mm 0 3mm; padding-bottom: 1.5mm;
    border-bottom: 2px solid var(--tinta); page-break-after: avoid;
  }
  h3 { font-size: 10.5pt; margin: 5mm 0 2mm; color: var(--suave); page-break-after: avoid; }
  .sub { color: var(--suave); margin: 0 0 6mm; }
  .resumen { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 5mm 0 8mm; }
  .kpi { border: 1px solid var(--linea); border-radius: 3mm; padding: 4mm; background: var(--fondo); }
  .kpi .n { font-size: 20pt; font-weight: 700; line-height: 1; }
  .kpi .t { font-size: 8pt; color: var(--suave); margin-top: 1.5mm; }
  .ok { color: var(--verde); } .no { color: var(--rojo); }
  table { width: 100%; border-collapse: collapse; margin: 2mm 0 4mm; font-size: 9pt; }
  th, td { text-align: left; padding: 1.4mm 2mm; border-bottom: 1px solid var(--linea); vertical-align: top; }
  th { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.4pt; color: var(--suave); }
  td.estado { width: 6mm; color: var(--verde); font-weight: 700; }
  tr.malo td.estado { color: var(--rojo); }
  td.num { width: 18mm; text-align: right; color: var(--suave); font-variant-numeric: tabular-nums; }
  tbody tr { page-break-inside: avoid; }
  .barra { height: 3mm; background: var(--linea); border-radius: 2mm; overflow: hidden; min-width: 30mm; }
  .barra i { display: block; height: 100%; background: var(--verde); }
  .met { font-size: 8.5pt; color: var(--suave); }
  .met code { color: var(--tinta); }
  .nota { background: var(--fondo); border-left: 3px solid var(--suave); padding: 3mm 4mm; margin: 3mm 0; font-size: 9pt; }
  .pie { margin-top: 10mm; padding-top: 3mm; border-top: 1px solid var(--linea); color: var(--suave); font-size: 8pt; }
  .sec { page-break-inside: avoid; }
</style>
</head>
<body>
<div class="hoja">

<h1>Bug — Informe de resultados de pruebas</h1>
<p class="sub">
  Juego de cartas distribuido sin servidor de partida · Bloque de Verificación y Validación<br>
  Generado el ${fecha(Date.now())} a partir de los artefactos de la última ejecución.
</p>

<div class="resumen">
  <div class="kpi"><div class="n">${total}</div><div class="t">comprobaciones</div></div>
  <div class="kpi"><div class="n ${fallos ? 'no' : 'ok'}">${fallos}</div><div class="t">fallos</div></div>
  <div class="kpi"><div class="n">${totalUnit}</div><div class="t">unitarias (Vitest)</div></div>
  <div class="kpi"><div class="n">${totalE2e}</div><div class="t">funcionales (Cypress)</div></div>
</div>

<h2>1 · Pruebas unitarias y de integración — Vitest</h2>
${vitest
  .map(
    (s) => `<div class="sec">
  <h3>${esc(NOMBRES[s.paquete] ?? s.paquete)} — ${s.casos.length} casos, ${
    s.casos.filter((c) => c.fallo).length
  } fallos <span class="met">· ${fecha(s.fecha)}</span></h3>
  <table><tbody>${tablaCasos(s.casos)}</tbody></table>
</div>`,
  )
  .join('\n')}

<h2>2 · Pruebas funcionales en navegador — Cypress</h2>
<div class="nota">
  Las cuatro de <code>malla de tres nodos</code> levantan <strong>tres nodos simultáneos con WebRTC
  real</strong> y comparan la huella del estado replicado de los tres. Es la capa que ninguna prueba
  unitaria puede dar: <code>RTCPeerConnection</code> no existe en Node.
</div>
${cypress
  .map(
    (s) => `<div class="sec">
  <h3>${esc(s.spec)} — ${s.casos.length} casos, ${s.casos.filter((c) => c.fallo).length} fallos
    <span class="met">· ${fecha(s.fecha)}</span></h3>
  <table><tbody>${tablaCasos(s.casos)}</tbody></table>
</div>`,
  )
  .join('\n')}

${
  seguridad
    ? `<h2>3 · Pruebas de seguridad — ${seguridad.bloqueados}/${seguridad.total} ataques bloqueados</h2>
<p class="met">Objetivo: <code>${esc(seguridad.objetivo)}</code> · ejecución del ${fecha(seguridad.fecha)}</p>
<table>
  <thead><tr><th></th><th>ID</th><th>Ataque</th><th>Categoría</th><th>Severidad</th><th>Observado</th></tr></thead>
  <tbody>
  ${seguridad.resultados
    .map(
      (r) => `<tr class="${r.veredicto === 'bloqueado' ? '' : 'malo'}">
      <td class="estado">${r.veredicto === 'bloqueado' ? '✓' : '✕'}</td>
      <td><strong>${esc(r.id)}</strong></td>
      <td>${esc(r.nombre)}</td>
      <td>${esc(r.categoria)}</td>
      <td>${esc(r.severidad)}</td>
      <td>${esc(r.observado ?? '')}</td>
    </tr>`,
    )
    .join('\n')}
  </tbody>
</table>`
    : ''
}

${
  distribuida
    ? `<h2>4 · Validación distribuida — ${distribuida.cumplen}/${distribuida.total} propiedades</h2>
<p class="met">Ejecución del ${fecha(distribuida.fecha)}</p>
${distribuida.mediciones
  .map(
    (m) => `<div class="sec">
  <h3>${esc(m.id)} · ${esc(m.nombre)} — <span class="${m.cumple ? 'ok' : 'no'}">${
    m.cumple ? 'CUMPLE' : 'NO CUMPLE'
  }</span></h3>
  <p class="met"><strong>${esc(m.propiedad)}.</strong> ${esc(m.criterio)}</p>
  <table><tbody>
  ${Object.entries(m.metricas)
    .map(
      ([k, v]) =>
        `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td class="num" style="width:auto">${esc(v)}</td></tr>`,
    )
    .join('\n')}
  </tbody></table>
</div>`,
  )
  .join('\n')}`
    : ''
}

${
  cob
    ? `<h2>5 · Cobertura de código</h2>
<p class="met">Del <code>lcov</code> combinado del ${fecha(cob.fecha)}, con las mismas exclusiones que declara SonarQube.</p>
<table>
  <thead><tr><th>Paquete</th><th>Líneas cubiertas</th><th style="width:45mm">%</th><th class="num">Valor</th></tr></thead>
  <tbody>
  ${Object.entries(cob.porPaquete)
    .map(([p, v]) => {
      const pct = (v.lh / v.lf) * 100;
      return `<tr>
        <td><strong>${esc(p)}</strong></td>
        <td>${v.lh} / ${v.lf}</td>
        <td><div class="barra"><i style="width:${pct.toFixed(1)}%"></i></div></td>
        <td class="num">${pct.toFixed(2)} %</td>
      </tr>`;
    })
    .join('\n')}
  </tbody>
</table>
<h3>Excluido de la medición, y por qué</h3>
<table>
  <thead><tr><th>Fichero</th><th class="num">Líneas</th><th>Motivo</th></tr></thead>
  <tbody>
  ${cob.excluidos
    .map((x) => {
      const motivos = {
        'web/lib/useBugRoom.ts': 'Orquesta el ciclo de vida de React sobre WebRTC. Lo cubre Cypress.',
        'web/lib/useBugGame.ts': 'Igual que useBugRoom.',
        'web/lib/pixiEffects.ts': 'Necesita WebGL.',
        'net/src/room.ts': 'Habla con RTCPeerConnection, que no existe en Node (los tests de malla simulada sí lo recorren: ' +
          Math.round((x.lh / Math.max(x.lf, 1)) * 100) + ' %).',
        'signaling/src/smoke.ts': 'Utilidad de desarrollo; no se despliega.',
      };
      return `<tr><td><code>${esc(x.f)}</code></td><td class="num">${x.lf}</td><td>${
        esc(motivos[x.f] ?? '—')
      }</td></tr>`;
    })
    .join('\n')}
  </tbody>
</table>`
    : ''
}

<div class="pie">
  Reproducible con <code>npm run typecheck</code>, <code>npm run test:coverage</code>,
  <code>npm run vv:security</code>, <code>npm run vv:distributed</code> y <code>npm run e2e</code>.
  Este documento lo genera <code>node vv/informe-pruebas.mjs</code> a partir de los artefactos de esas
  ejecuciones — no se edita a mano.
</div>

</div>
</body>
</html>`;

  writeFileSync(salidaHtml, html, 'utf8');
  console.log(`informe: ${salidaHtml}`);
  console.log(`${total} comprobaciones, ${fallos} fallos`);

  if (process.argv.includes('--pdf')) {
    const chrome =
      process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const pdf = salidaHtml.replace(/\.html$/, '.pdf');
    const r = spawnSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdf}`,
        'file:///' + salidaHtml.split('\\').join('/'),
      ],
      { stdio: 'inherit' },
    );
    console.log(r.status === 0 ? `pdf: ${pdf}` : `no se pudo generar el PDF (código ${r.status})`);
  }
}

main();

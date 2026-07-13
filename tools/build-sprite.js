// Genera `web/public/cards.svg` — el sprite con una carta (y el logo) por <symbol> — a partir de
// los .svg de Inkscape de la raíz del repo.  Uso: `npm run art`
//
// Los tres archivos de arte (NUMEROS/ESPECIALES/COMODINES) son ventanas distintas de un MISMO
// lienzo con las 50 cartas: aquí se recorta carta a carta (ver `collect-art.js`).
//
// Clave del asunto: el arte trae UNA muestra de cada especial (el "se fue el WiFi" solo existe en
// vino), pero el juego los necesita en los cuatro palos. Así que la tinta principal de esas cartas
// se sustituye por `currentColor`: el símbolo queda recoloreable y la UI le pone el color del palo.
// Las cartas de caos y los comodines conservan su color, que es parte de su identidad.

const fs = require('fs');
const path = require('path');
const { collect } = require('./collect-art.js');

const ROOT = path.join(__dirname, '..');
const art = (name) => path.join(ROOT, name);
const OUT_DIR = path.join(ROOT, 'web', 'public');

// --- Qué carta hay en cada sitio del lienzo (coordenadas del extractor) --------
const NUM_X = [15, 88, 163, 237, 311, 384, 456, 528, 599, 671]; // → 1..9, 0
const NUM_VALUE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
const NUM_ROW_Y = 11; // fila verde: la usamos de plantilla para los cuatro palos

const SPECIALS = [
  { id: 'draw2', x: 784, y: 37, recolor: true },
  { id: 'reverse', x: 856, y: 37, recolor: true },
  { id: 'copy_paste', x: 999, y: 37, recolor: false },
  { id: 'reboot', x: 789, y: 144, recolor: false },
  { id: 'skip', x: 856, y: 144, recolor: true },
  { id: 'coffee_spill', x: 932, y: 144, recolor: false },
  { id: 'trojan', x: 1005, y: 144, recolor: false },
  { id: 'wild', x: 783, y: 276, recolor: false },
  { id: 'wild_draw4', x: 855, y: 276, recolor: false },
];

const PAPER = '#e8e8e7'; // el "papel" de la carta: nunca se recolorea

function near(card, x, y) {
  return Math.abs(card.box.minX - x) < 6 && Math.abs(card.box.minY - y) < 6;
}

/** Tinta principal = el color (que no sea papel) con más superficie en la carta. */
function mainTint(card) {
  const area = new Map();
  for (const p of card.paths) {
    if (p.fill === PAPER) continue;
    const a = (p.box.maxX - p.box.minX) * (p.box.maxY - p.box.minY);
    area.set(p.fill, (area.get(p.fill) ?? 0) + a);
  }
  return [...area.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Un símbolo por carta, TODOS con la misma caja y el dibujo centrado dentro.
 *
 * Antes cada símbolo llevaba su propia caja (la de su dibujo: 60×93 los números, 65×100 los
 * especiales…). Como la UI los pinta a todos en un lienzo del mismo tamaño, cada carta se ajustaba
 * de una manera y el dibujo quedaba descentrado —una pizca hacia un lado, distinta en cada carta—.
 *
 * Ahora la caja es común (`BOX`) y se coloca CENTRADA en el dibujo: el arte queda en el medio, y
 * todas las cartas encajan igual.
 */
function symbolFor(id, card, recolor, box) {
  const tint = recolor ? mainTint(card) : null;
  const body = card.paths
    .map((p) => {
      let fill = p.fill;
      if (recolor && p.fill !== PAPER) {
        // La tinta principal se vuelve el color del palo; los detalles (sombras, acentos) se
        // derivan de él, para que una carta rosa no arrastre restos verdes del original.
        fill =
          p.fill === tint
            ? 'currentColor'
            : 'color-mix(in srgb, currentColor 62%, #12121a)';
      }
      const m = p.m.map((n) => +n.toFixed(5)).join(',');
      return `<path fill="${fill}" transform="matrix(${m})" d="${p.d}"/>`;
    })
    .join('');

  // Centro del dibujo → esquina de una caja común del mismo tamaño para todas.
  const cx = card.box.minX + card.w / 2;
  const cy = card.box.minY + card.h / 2;
  const vb = [cx - box.w / 2, cy - box.h / 2, box.w, box.h].map((n) => n.toFixed(2)).join(' ');
  return `<symbol id="c-${id}" viewBox="${vb}">${body}</symbol>`;
}

// --- Cartas -------------------------------------------------------------------
const cards = collect(art('NUMEROS.svg'));
const symbols = [];

const usadas = [
  ...NUM_X.map((x, i) => {
    const card = cards.find((c) => near(c, x, NUM_ROW_Y));
    if (!card) throw new Error(`no encuentro el número ${NUM_VALUE[i]} en (${x},${NUM_ROW_Y})`);
    return { id: `num-${NUM_VALUE[i]}`, card, recolor: true };
  }),
  ...SPECIALS.map((s) => {
    const card = cards.find((c) => near(c, s.x, s.y));
    if (!card) throw new Error(`no encuentro ${s.id} en (${s.x},${s.y})`);
    return { id: s.id, card, recolor: s.recolor };
  }),
];

// La caja común: la mayor de todas, con un pelín de aire. Todas las cartas se dibujan dentro de
// ella y centradas, así que en la mesa se ven del mismo tamaño y con el arte en el medio.
const BOX = {
  w: Math.max(...usadas.map((u) => u.card.w)) + 1,
  h: Math.max(...usadas.map((u) => u.card.h)) + 1,
};
console.log('caja común:', BOX.w.toFixed(2), '×', BOX.h.toFixed(2));

for (const u of usadas) symbols.push(symbolFor(u.id, u.card, u.recolor, BOX));

// La UI necesita la caja para pintar las cartas: se emite en vez de copiarla a mano (un número
// mágico que se desincroniza es exactamente cómo se descentran los dibujos).
fs.writeFileSync(
  path.join(ROOT, 'web', 'lib', 'cardBox.ts'),
  `// GENERADO por tools/build-sprite.js — no editar a mano (\`npm run art\`).\n` +
    `//\n` +
    `// La caja en la que está dibujada CADA carta del sprite. Todas comparten esta caja y llevan su\n` +
    `// dibujo centrado dentro, así que la UI las pinta todas igual y no hay que ajustar ninguna.\n` +
    `export const CARD_BOX = { w: ${BOX.w.toFixed(2)}, h: ${BOX.h.toFixed(2)} } as const;\n` +
    `export const CARD_VIEWBOX = '0 0 ${BOX.w.toFixed(2)} ${BOX.h.toFixed(2)}';\n`,
);

// --- Logo ---------------------------------------------------------------------
// Vive en su propio documento, en otra zona del lienzo. Va al mismo sprite y también recoloreable:
// el mismo "¡Bug!" sirve en verde para el menú y en claro para el reverso de las cartas.
const logoParts = collect(art('LOGO.svg')).filter(
  (c) => c.box.minX > 800 && c.box.minX < 1060 && c.box.minY > 415 && c.box.minY < 580,
);
const logoBox = logoParts.reduce(
  (b, c) => ({
    minX: Math.min(b.minX, c.box.minX),
    minY: Math.min(b.minY, c.box.minY),
    maxX: Math.max(b.maxX, c.box.maxX),
    maxY: Math.max(b.maxY, c.box.maxY),
  }),
  { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
);
const logoBody = logoParts
  .flatMap((c) => c.paths)
  .map(
    (p) =>
      `<path fill="currentColor" transform="matrix(${p.m.map((n) => +n.toFixed(5)).join(',')})" d="${p.d}"/>`,
  )
  .join('');
symbols.push(
  `<symbol id="c-logo" viewBox="${logoBox.minX.toFixed(2)} ${logoBox.minY.toFixed(2)} ${(logoBox.maxX - logoBox.minX).toFixed(2)} ${(logoBox.maxY - logoBox.minY).toFixed(2)}">${logoBody}</symbol>`,
);
console.log('logo:', logoParts.length, 'piezas');

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${symbols.join('')}</svg>`;
fs.writeFileSync(path.join(OUT_DIR, 'cards.svg'), sprite);
console.log('cards.svg:', symbols.length, 'símbolos,', (sprite.length / 1024).toFixed(0), 'kB');

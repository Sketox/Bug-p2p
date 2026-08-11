// Genera `web/public/cards.svg` — el sprite con una carta por <symbol> — a partir de `art/`.
// Uso: `npm run art`
//
// `art/CARTAS.svg` es el lienzo entero: los 40 números, los 10 especiales en sus 4 colores y los 2
// comodines. Cada carta es un grupo con nombre en Inkscape, y por el nombre se recorta (ver
// `collect-art.js`); el viewBox del archivo da igual.
//
// EL COLOR VIENE DEL ARTE. Antes no: el arte solo traía una muestra de cada especial, así que el
// sprite guardaba un dibujo y la UI lo teñía con `currentColor`, inventándose las sombras con un
// `color-mix`. Ahora cada carta está dibujada en su color de verdad y el sprite lleva las cuatro.
//
// Y las cuatro caben sin engordar el archivo porque son el MISMO dibujo con otros rellenos: la
// geometría se guarda una vez en <defs> y cada carta la referencia con sus colores. Si algún día
// una variante se dibuja distinta, se emite entera — el sprite sigue siendo fiel al arte.

const fs = require('node:fs');
const path = require('node:path');
const { cards, collect } = require('./collect-art.js');

const ROOT = path.join(__dirname, '..');
const art = (name) => path.join(ROOT, 'art', name);

// --- Qué carta es cada dibujo del lienzo ---------------------------------------------------
//
// La etiqueta la pone quien dibuja, en Inkscape. Ojo con los dos "Update de Windows": el del
// portátil con un alien roba 2 y el de la plaga de aliens roba 4.
const KIND_OF = {
  'DESCONECTAR': 'skip', // "Se fue el WiFi"
  'CTRL Z': 'reverse',
  '+2': 'draw2', // "Update de Windows" (+2)
  '+4': 'draw4', // "Update de Windows" (+4)
  'COPIAR Y PEGAR': 'copy_paste',
  'APAGAR': 'reboot', // "Apagar y volver a prender"
  'DERRAME DE CAFE': 'coffee_spill',
  'TROYANO': 'trojan',
  'COMODIN': 'wild', // "Reinicio de Router"
  'COMODIN +4': 'wild_draw4', // "BSOD"
};

/** Los cuatro palos, tal como están pintados en el arte. Es la paleta de la que sale `lib/cards.ts`. */
const SUIT_OF = {
  '#07d98c': 'code',
  '#a60d61': 'hardware',
  '#4227f2': 'internet',
  '#f27eb4': 'survival',
};
const COLORS = ['code', 'hardware', 'internet', 'survival'];

/** Los comodines son los únicos sin palo: llevan los cuatro colores en franjas. */
const WILD_KINDS = ['wild', 'wild_draw4'];

/**
 * ¿De qué color es esta carta? La del palo que más superficie ocupa.
 *
 * No vale "el primer color que aparezca": el Ctrl+Z lleva las teclas pintadas de morado aunque la
 * carta sea verde. La franja grande manda.
 */
function suitOf(card) {
  const area = new Map();
  for (const p of card.paths) {
    const suit = SUIT_OF[p.fill];
    if (!suit) continue;
    const a = (p.box.maxX - p.box.minX) * (p.box.maxY - p.box.minY);
    area.set(suit, (area.get(suit) ?? 0) + a);
  }
  const best = [...area.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) throw new Error(`la carta no tiene ningún color de palo`);
  return best[0];
}

// --- Recorte del lienzo ---------------------------------------------------------------------
const found = cards(art('CARTAS.svg'));

/** Cada carta del mazo, con su tipo, su color y su dibujo. */
const deck = [];
for (const c of found) {
  const num = /^[0-9]$/.test(c.label) ? Number(c.label) : null;
  const kind = num != null ? 'number' : KIND_OF[c.label];
  if (!kind) continue; // grupos que no son cartas (el dibujo de dentro, las filas de color…)

  const wild = WILD_KINDS.includes(kind);
  deck.push({
    id: wild ? `c-${kind}` : `c-${num != null ? `num-${num}` : kind}-${suitOf(c)}`,
    kind: num != null ? `num-${num}` : kind,
    color: wild ? null : suitOf(c),
    card: c,
  });
}

// Cada carta de color tiene que estar en los cuatro palos, y cada comodín una sola vez. Si el arte
// se queda a medias, el sprite saldría con huecos y la partida enseñaría cartas en blanco: mejor
// enterarse aquí.
const porTipo = new Map();
for (const d of deck) {
  if (!porTipo.has(d.kind)) porTipo.set(d.kind, []);
  porTipo.get(d.kind).push(d);
}
for (const [kind, variantes] of porTipo) {
  if (WILD_KINDS.includes(kind)) {
    if (variantes.length !== 1) throw new Error(`${kind}: esperaba 1 dibujo, hay ${variantes.length}`);
    continue;
  }
  const colores = variantes.map((v) => v.color).sort();
  const faltan = COLORS.filter((c) => !colores.includes(c));
  if (faltan.length || variantes.length !== 4) {
    throw new Error(`${kind}: esperaba los 4 colores, hay ${variantes.length} (faltan: ${faltan.join(', ') || '—'})`);
  }
}
const esperados = Object.keys(KIND_OF).length + 10; // 10 especiales + 2 comodines + los 10 números
if (porTipo.size !== esperados) {
  throw new Error(`esperaba ${esperados} dibujos distintos, encontré ${porTipo.size}: ${[...porTipo.keys()].join(', ')}`);
}

// --- La caja común --------------------------------------------------------------------------
//
// Todas las cartas se dibujan dentro de la MISMA caja y centradas en ella. Si cada símbolo llevara
// la suya (la de su dibujo), la UI —que las pinta a todas del mismo tamaño— ajustaría cada carta de
// una manera y el dibujo quedaría descentrado, una pizca distinta en cada una.
const BOX = {
  w: Math.max(...deck.map((d) => d.card.w)) + 1,
  h: Math.max(...deck.map((d) => d.card.h)) + 1,
};

const mat = (m) => m.map((n) => +n.toFixed(4)).join(',');
const viewBoxOf = (card) => {
  const cx = card.box.minX + card.w / 2;
  const cy = card.box.minY + card.h / 2;
  return [cx - BOX.w / 2, cy - BOX.h / 2, BOX.w, BOX.h].map((n) => n.toFixed(2)).join(' ');
};
/**
 * ¿Es esta carta la MISMA que la plantilla, solo que pintada de otro color?
 *
 * Lo es si tiene los mismos trazos, con la misma forma, movidos todos en bloque: entonces basta con
 * mirarla por la ventana de la plantilla (su viewBox) para verla igual, y no hace falta guardar el
 * dibujo otra vez. Lo que NO se compara es dónde cae en el lienzo — ahí es donde están, justamente,
 * las cuatro copias del mismo dibujo.
 */
function esLaMisma(card, plantilla) {
  if (card.paths.length !== plantilla.paths.length) return false;
  let delta = null;
  for (let i = 0; i < card.paths.length; i++) {
    const a = card.paths[i];
    const b = plantilla.paths[i];
    if (a.d !== b.d) return false;
    // La parte lineal de la matriz (escala y giro) tiene que ser idéntica...
    if (mat(a.m.slice(0, 4)) !== mat(b.m.slice(0, 4))) return false;
    // ...y el desplazamiento, el mismo para todos los trazos: la carta entera movida de sitio.
    const d = mat([a.m[4] - b.m[4], a.m[5] - b.m[5]]);
    if (delta == null) delta = d;
    else if (d !== delta) return false;
  }
  return true;
}

// --- Símbolos -------------------------------------------------------------------------------
const defs = [];
const symbols = [];

for (const [kind, variantes] of porTipo) {
  // La plantilla: el dibujo se guarda UNA vez, sin colores (los pone cada carta al referenciarlo).
  const plantilla = variantes[0].card;
  defs.push(
    ...plantilla.paths.map(
      (p, i) => `<path id="g-${kind}-${i}" transform="matrix(${mat(p.m)})" d="${p.d}"/>`,
    ),
  );

  for (const v of variantes) {
    const mismoDibujo = esLaMisma(v.card, plantilla);
    const body = mismoDibujo
      ? // El caso normal: los cuatro colores son el mismo dibujo. Cada path toma el relleno que
        // tiene en ESTA carta, así que sale exactamente como está pintada en el lienzo.
        v.card.paths.map((p, i) => `<use href="#g-${kind}-${i}" fill="${p.fill}"/>`).join('')
      : // Alguien redibujó esta variante: va entera, con su propia geometría.
        v.card.paths
          .map((p) => `<path fill="${p.fill}" transform="matrix(${mat(p.m)})" d="${p.d}"/>`)
          .join('');
    const box = mismoDibujo ? plantilla : v.card;
    symbols.push(`<symbol id="${v.id}" viewBox="${viewBoxOf(box)}">${body}</symbol>`);
  }
}

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

// --- Logo -----------------------------------------------------------------------------------
// Vive en su propio documento y sin etiquetas, así que se recorta por solapamiento. Va al mismo
// sprite y sí es recoloreable: el mismo "¡Bug!" sirve en verde para el menú y en claro para el
// reverso de las cartas.
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
  .map((p) => `<path fill="currentColor" transform="matrix(${mat(p.m)})" d="${p.d}"/>`)
  .join('');
symbols.push(
  `<symbol id="c-logo" viewBox="${logoBox.minX.toFixed(2)} ${logoBox.minY.toFixed(2)} ${(logoBox.maxX - logoBox.minX).toFixed(2)} ${(logoBox.maxY - logoBox.minY).toFixed(2)}">${logoBody}</symbol>`,
);

const sprite =
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">` +
  `<defs>${defs.join('')}</defs>${symbols.join('')}</svg>`;
fs.writeFileSync(path.join(ROOT, 'web', 'public', 'cards.svg'), sprite);

console.log(`caja común: ${BOX.w.toFixed(2)} × ${BOX.h.toFixed(2)}`);
console.log(`dibujos: ${porTipo.size} (${defs.length} trazos compartidos) · logo: ${logoParts.length} piezas`);
console.log(`cards.svg: ${symbols.length} símbolos, ${(sprite.length / 1024).toFixed(0)} kB`);

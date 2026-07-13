// Recorta un lienzo de Inkscape en las piezas que lo componen (cartas, logo).
//
// Recorre el árbol acumulando las transformaciones anidadas, calcula la caja de cada figura y las
// agrupa por solapamiento: el fondo de cada carta toca todo lo que lleva encima, y las cartas no
// se tocan entre sí, así que cada grupo resultante es exactamente una carta.

const fs = require('fs');

const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseTransform(str) {
  let m = I;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str))) {
    const n = t[2].trim().split(/[\s,]+/).map(Number);
    let cur;
    if (t[1] === 'matrix') cur = n;
    else if (t[1] === 'translate') cur = [1, 0, 0, 1, n[0], n[1] || 0];
    else if (t[1] === 'scale') cur = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    else {
      const a = (n[0] * Math.PI) / 180;
      cur = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
    }
    m = mul(m, cur);
  }
  return m;
}

/**
 * Extremos REALES de una Bézier cúbica en un eje.
 *
 * Tomar los puntos de control como cota es lo fácil y está mal: los controles caen FUERA de la
 * curva, así que la caja sale hinchada — y una caja hinchada de forma desigual descentra el dibujo
 * dentro de su propio recuadro. (Eso es exactamente lo que se veía en las cartas.)
 *
 * Los extremos están donde la derivada se anula: una cuadrática. Se resuelve y se evalúa la curva
 * en esas `t`.
 */
function cubicExtremes(p0, p1, p2, p3) {
  const points = [p0, p3]; // los extremos siempre están en la curva
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;

  const at = (t) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };

  if (Math.abs(a) < 1e-9) {
    // Degenera en lineal: una sola raíz.
    if (Math.abs(b) > 1e-9) {
      const t = -c / b;
      if (t > 0 && t < 1) points.push(at(t));
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      for (const t of [(-b + root) / (2 * a), (-b - root) / (2 * a)]) {
        if (t > 0 && t < 1) points.push(at(t));
      }
    }
  }
  return points;
}

function pathBox(d, m) {
  const nums = /[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi;
  // OJO con la `e`: partir los comandos por "cualquier letra" parece razonable y está MAL, porque
  // los números vienen en notación científica (`8.5e-7`) y esa `e` se colaba como si fuera un
  // comando. El recorrido se descuadraba a partir de ahí y la caja salía torcida — que es
  // exactamente por qué los dibujos aparecían descentrados dentro de las cartas.
  const cmds = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) || [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const hit = (px, py) => {
    const [tx, ty] = applyM(m, px, py);
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
  };

  /** Acota una cúbica por sus extremos de verdad. Se transforma primero: una afín conserva la curva. */
  const curve = (x0, y0, x1, y1, x2, y2, x3, y3) => {
    const [tx0, ty0] = applyM(m, x0, y0);
    const [tx1, ty1] = applyM(m, x1, y1);
    const [tx2, ty2] = applyM(m, x2, y2);
    const [tx3, ty3] = applyM(m, x3, y3);
    for (const px of cubicExtremes(tx0, tx1, tx2, tx3)) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
    }
    for (const py of cubicExtremes(ty0, ty1, ty2, ty3)) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  };
  for (const c of cmds) {
    const op = c[0];
    const rel = op === op.toLowerCase();
    const up = op.toUpperCase();
    const n = (c.slice(1).match(nums) || []).map(Number);
    if (up === 'Z') { x = sx; y = sy; continue; }
    let i = 0;
    while (i < n.length) {
      if (up === 'M' || up === 'L' || up === 'T') {
        x = rel ? x + n[i] : n[i];
        y = rel ? y + n[i + 1] : n[i + 1];
        i += 2;
        if (up === 'M' && i === 2) { sx = x; sy = y; }
      } else if (up === 'H') { x = rel ? x + n[i] : n[i]; i += 1; }
      else if (up === 'V') { y = rel ? y + n[i] : n[i]; i += 1; }
      else if (up === 'C') {
        const x1 = rel ? x + n[i] : n[i];
        const y1 = rel ? y + n[i + 1] : n[i + 1];
        const x2 = rel ? x + n[i + 2] : n[i + 2];
        const y2 = rel ? y + n[i + 3] : n[i + 3];
        const x3 = rel ? x + n[i + 4] : n[i + 4];
        const y3 = rel ? y + n[i + 5] : n[i + 5];
        curve(x, y, x1, y1, x2, y2, x3, y3);
        x = x3;
        y = y3;
        i += 6;
      } else if (up === 'S' || up === 'Q') {
        // Cuadrática: se eleva a cúbica y se acota con la misma precisión.
        const cx = rel ? x + n[i] : n[i];
        const cy = rel ? y + n[i + 1] : n[i + 1];
        const ex = rel ? x + n[i + 2] : n[i + 2];
        const ey = rel ? y + n[i + 3] : n[i + 3];
        curve(
          x, y,
          x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y),
          ex + (2 / 3) * (cx - ex), ey + (2 / 3) * (cy - ey),
          ex, ey,
        );
        x = ex;
        y = ey;
        i += 4;
      } else if (up === 'A') {
        x = rel ? x + n[i + 5] : n[i + 5];
        y = rel ? y + n[i + 6] : n[i + 6];
        i += 7;
      } else break;
      hit(x, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Devuelve las piezas (cartas) del lienzo, cada una con sus paths ya transformados. */
function collect(file) {
  const svg = fs.readFileSync(file, 'utf8');
  const body = svg.slice(svg.indexOf('<g\n     id="layer1"'));
  // El translate del layer1 solo encuadra la ventana del archivo; se ignora para trabajar siempre
  // en coordenadas del lienzo completo, iguales en los tres .svg.
  const frame = body.match(/transform="(translate\([-\d.,]+\))"/)?.[1] ?? '';

  const items = [];
  const stack = [I];
  const tokens = body.match(/<g\b[^>]*?\/>|<g\b[^>]*>|<\/g>|<path\b[^>]*\/>|<rect\b[^>]*\/>/g) || [];
  const fillOf = (tk) => {
    const attr = tk.match(/\sfill="([^"]+)"/);
    const style = tk.match(/fill:\s*(#[0-9a-fA-F]{6}|none)/);
    return (attr?.[1] ?? style?.[1] ?? '#000000').toLowerCase();
  };
  const num = (tk, name) => Number(tk.match(new RegExp(`\\s${name}="([-\\d.]+)"`))?.[1] ?? 0);

  for (const tk of tokens) {
    if (tk === '</g>') { stack.pop(); continue; }
    const tr = tk.match(/transform="([^"]+)"/);
    if (tk.startsWith('<g')) {
      if (tk.endsWith('/>')) continue; // un <g/> vacío no abre nivel
      const top = stack[stack.length - 1];
      stack.push(tr && tr[1] !== frame ? mul(top, parseTransform(tr[1])) : top);
      continue;
    }
    let m = stack[stack.length - 1];
    if (tr) m = mul(m, parseTransform(tr[1]));
    const fill = fillOf(tk);
    if (fill === 'none') continue;

    let d;
    if (tk.startsWith('<path')) {
      d = tk.match(/\sd="([^"]+)"/)?.[1];
    } else {
      const [x, y, w, h] = [num(tk, 'x'), num(tk, 'y'), num(tk, 'width'), num(tk, 'height')];
      if (w > 0 && h > 0) d = `M ${x},${y} H ${x + w} V ${y + h} H ${x} Z`;
    }
    if (!d) continue;
    items.push({ d, fill, m, box: pathBox(d, m) });
  }

  // Union-find por solapamiento
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[ra] = rb;
  };
  const touches = (a, b) =>
    a.minX <= b.maxX + 1 && b.minX <= a.maxX + 1 && a.minY <= b.maxY + 1 && b.minY <= a.maxY + 1;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (touches(items[i].box, items[j].box)) union(i, j);

  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });

  return [...groups.values()]
    .map((paths) => {
      const box = paths.reduce(
        (b, p) => ({
          minX: Math.min(b.minX, p.box.minX),
          minY: Math.min(b.minY, p.box.minY),
          maxX: Math.max(b.maxX, p.box.maxX),
          maxY: Math.max(b.maxY, p.box.maxY),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      );
      return { paths, box, w: box.maxX - box.minX, h: box.maxY - box.minY };
    })
    .filter((c) => c.w > 20 && c.h > 20);
}

module.exports = { collect };

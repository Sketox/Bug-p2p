import type { Card, CardKind, Color } from '@bug/engine';

// Metadatos de presentación de las cartas: nombres temáticos, colores y qué dibujo del sprite les
// toca.  El arte real vive en `web/public/cards.svg`, generado desde `art/CARTAS.svg` (el lienzo de
// Inkscape) con `npm run art` (ver `tools/build-sprite.js`).

/**
 * La paleta sale del arte, no al revés: son los cuatro colores con los que están pintadas las
 * cartas (#07d98c, #a60d61, #4227f2, #f27eb4). Si aquí pusiéramos otros, el "color actual" de la
 * mesa no coincidiría con el de las cartas que tienes en la mano.
 */
export const SUIT: Record<Color, { label: string; icon: string; hex: string; fg: string }> = {
  code: { label: 'Código', icon: '{ }', hex: '#07d98c', fg: '#04241a' },
  hardware: { label: 'Hardware', icon: '💻', hex: '#a60d61', fg: '#ffe9f4' },
  internet: { label: 'Internet', icon: '📶', hex: '#4227f2', fg: '#e8e6ff' },
  survival: { label: 'Café', icon: '☕', hex: '#f27eb4', fg: '#2b0a1b' },
};

const NAME: Record<Exclude<CardKind, 'number'>, string> = {
  skip: 'Se fue el WiFi',
  reverse: 'Ctrl+Z',
  draw2: 'Update de Windows (+2)',
  draw4: 'Update de Windows (+4)',
  wild: 'Reinicio de Router',
  wild_draw4: 'BSOD',
  copy_paste: 'Copiar y Pegar',
  reboot: 'Apagar y prender',
  coffee_spill: 'Derrame de Café',
  trojan: 'Virus Troyano',
};

export interface CardFace {
  /** Id del <symbol> del sprite (`#c-num-5-code`, `#c-skip-hardware`, `#c-wild`…). */
  symbol: string;
  name: string;
  /** Solo los dos comodines: son los únicos sin palo (los de las franjas de color). */
  isWild: boolean;
}

/**
 * Qué dibujo del sprite le toca a cada carta.
 *
 * Una carta = un dibujo, con su color ya pintado. Antes no: el sprite guardaba UN dibujo por tipo y
 * la UI lo teñía por CSS, porque el arte solo traía una muestra de cada especial. Ahora están las
 * cuatro dibujadas de verdad, así que aquí solo hay que pedir la que toca.
 */
export function cardFace(card: Card): CardFace {
  const name = card.kind === 'number' ? SUIT[card.color!].label : NAME[card.kind];
  if (card.color == null) return { symbol: `c-${card.kind}`, name, isWild: true }; // comodines
  const dibujo = card.kind === 'number' ? `num-${card.value}` : card.kind;
  return { symbol: `c-${dibujo}-${card.color}`, name, isWild: false };
}

/**
 * ¿Hay que preguntarle algo al jugador antes de mandar la jugada?
 *
 * Antes bastaba con mirar si la carta no tenía color. Ya no vale: las de Caos tienen el suyo y aun
 * así hay cosas que decidir (a quién infectas, qué carta pones de base), mientras que el Derrame de
 * Café o el Copiar y Pegar se juegan de un tirón como cualquier número.
 */
export function needsPrompt(card: Card): boolean {
  if (card.color == null) return true; // comodín: elige color
  return card.kind === 'trojan' || card.kind === 'reboot';
}

export const COLOR_OPTIONS: { color: Color; label: string; hex: string }[] = (
  Object.keys(SUIT) as Color[]
).map((color) => ({ color, label: SUIT[color].label, hex: SUIT[color].hex }));

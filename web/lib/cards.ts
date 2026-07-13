import type { Card, CardKind, Color } from '@bug/engine';

// Metadatos de presentación de las cartas: nombres temáticos, colores y qué dibujo del sprite les
// toca.  El arte real vive en `web/public/cards.svg`, generado desde los .svg de Inkscape de la
// raíz del repo con `npm run art` (ver `tools/build-sprite.js`).

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

/** Color de las cartas sin palo (comodines y caos): el sprite ya trae el suyo. */
const WILD_INK = '#e8e8e7';

const NAME: Record<Exclude<CardKind, 'number'>, string> = {
  skip: 'Se fue el WiFi',
  reverse: 'Ctrl+Z',
  draw2: 'Update de Windows',
  wild: 'Reinicio de Router',
  wild_draw4: 'BSOD',
  copy_paste: 'Copiar y Pegar',
  reboot: 'Apagar y prender',
  coffee_spill: 'Derrame de Café',
  trojan: 'Virus Troyano',
};

export interface CardFace {
  /** Id del <symbol> del sprite (`#c-num-5`, `#c-skip`…). */
  symbol: string;
  name: string;
  /**
   * Color con el que se pinta el dibujo. Los especiales de color son recoloreables (el arte trae
   * una sola muestra de cada uno), así que se les pasa el tono del palo; los comodines y las cartas
   * de caos ya vienen pintados y este valor no los toca.
   */
  ink: string;
  isWild: boolean;
}

export function cardFace(card: Card): CardFace {
  if (card.kind === 'number') {
    return {
      symbol: `c-num-${card.value}`,
      name: SUIT[card.color!].label,
      ink: SUIT[card.color!].hex,
      isWild: false,
    };
  }
  const name = NAME[card.kind];
  if (card.color) {
    return { symbol: `c-${card.kind}`, name, ink: SUIT[card.color].hex, isWild: false };
  }
  return { symbol: `c-${card.kind}`, name, ink: WILD_INK, isWild: true };
}

export const COLOR_OPTIONS: { color: Color; label: string; hex: string }[] = (
  Object.keys(SUIT) as Color[]
).map((color) => ({ color, label: SUIT[color].label, hex: SUIT[color].hex }));

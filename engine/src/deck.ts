import type { Card, CardKind, Color } from './types.js';
import { COLORS } from './types.js';

// Construcción del mazo de "Bug".
//
// Por cada color (4 colores × 29 = 116):
//   un 0, dos de cada 1-9                                              → 19
//   dos "Se fue el WiFi" (skip), dos "Ctrl+Z" (reverse)                → 4
//   un "Update de Windows" +2, un "Update de Windows" +4               → 2
//   una de cada Carta de Caos: Copiar y Pegar, Apagar y prender,
//   Derrame de Café, Virus Troyano                                     → 4
// Comodines, los únicos sin color (a franjas en el arte):
//   4 "Reinicio de Router" (wild) + 4 "BSOD" (wild_draw4)              → 8
// Total: 124 cartas.
//
// Las de Caos llevan color desde que el arte las trae pintadas en los cuatro palos: dejan de ser
// comodines encubiertos —que se podían soltar sobre cualquier cosa— y hay que jugarlas igualando,
// como todas. Que el Troyano tenga color es lo que lo vuelve una carta y no un botón.

function card(kind: CardKind, opts: { color?: Color; value?: number; n: number }): Card {
  const suffix =
    opts.color != null
      ? `${opts.color}-${opts.value ?? kind}`
      : `${kind}`;
  return {
    id: `${suffix}#${opts.n}`,
    kind,
    ...(opts.color != null ? { color: opts.color } : {}),
    ...(opts.value != null ? { value: opts.value } : {}),
  };
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  let n = 0;

  for (const color of COLORS) {
    // Un solo 0 por color.
    deck.push(card('number', { color, value: 0, n: n++ }));
    // Dos de cada 1-9.
    for (let value = 1; value <= 9; value++) {
      deck.push(card('number', { color, value, n: n++ }));
      deck.push(card('number', { color, value, n: n++ }));
    }
    // Dos de cada acción clásica.
    for (const kind of ['skip', 'reverse'] as const) {
      deck.push(card(kind, { color, n: n++ }));
      deck.push(card(kind, { color, n: n++ }));
    }
    // Los dos Updates de Windows: el que roba 2 y el que roba 4.
    deck.push(card('draw2', { color, n: n++ }));
    deck.push(card('draw4', { color, n: n++ }));
    // Una de cada Carta de Caos, en cada color.
    for (const kind of ['copy_paste', 'reboot', 'coffee_spill', 'trojan'] as const) {
      deck.push(card(kind, { color, n: n++ }));
    }
  }

  // Comodines.
  for (let i = 0; i < 4; i++) deck.push(card('wild', { n: n++ }));
  for (let i = 0; i < 4; i++) deck.push(card('wild_draw4', { n: n++ }));

  return deck;
}

export const DECK_SIZE = 124;

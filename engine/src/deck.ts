import type { Card, CardKind, Color } from './types.js';
import { COLORS } from './types.js';

// Construcción del mazo de "Bug".
//
// Base estilo UNO (108 cartas):
//   Por cada color: un 0, dos de cada 1-9, dos skip, dos reverse, dos draw2  → 25 × 4 = 100
//   4 wild + 4 wild_draw4                                                    → 8
// Cartas de Caos (exclusivas de Bug, sin color):
//   copy_paste × 4, reboot × 4, coffee_spill × 2, trojan × 4                 → 14
// Total: 122 cartas.

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
    // Dos de cada acción con color.
    for (const kind of ['skip', 'reverse', 'draw2'] as const) {
      deck.push(card(kind, { color, n: n++ }));
      deck.push(card(kind, { color, n: n++ }));
    }
  }

  // Comodines clásicos.
  for (let i = 0; i < 4; i++) deck.push(card('wild', { n: n++ }));
  for (let i = 0; i < 4; i++) deck.push(card('wild_draw4', { n: n++ }));

  // Cartas de Caos.
  for (let i = 0; i < 4; i++) deck.push(card('copy_paste', { n: n++ }));
  for (let i = 0; i < 4; i++) deck.push(card('reboot', { n: n++ }));
  for (let i = 0; i < 2; i++) deck.push(card('coffee_spill', { n: n++ }));
  for (let i = 0; i < 4; i++) deck.push(card('trojan', { n: n++ }));

  return deck;
}

export const DECK_SIZE = 122;

import type { Card, CardKind, Color, GameState, Player } from '../src/index.js';

let counter = 0;
/** Crea una carta de prueba con id único. */
export function c(kind: CardKind, color?: Color, value?: number): Card {
  return {
    id: `${kind}-${color ?? 'x'}-${value ?? 'x'}-${counter++}`,
    kind,
    ...(color != null ? { color } : {}),
    ...(value != null ? { value } : {}),
  };
}

export function player(id: string, hand: Card[]): Player {
  return { id, name: id, hand, status: 'active', saidBug: false };
}

/** Construye un estado controlado para probar reglas puntuales. */
export function makeState(opts: {
  players: Player[];
  top: Card;
  currentColor?: Color;
  turn?: number;
  direction?: 1 | -1;
  drawPile?: Card[];
  /** ¿El de turno ya robó? Hace falta para poder pasar (no se pasa de gratis). */
  drewThisTurn?: boolean;
}): GameState {
  return {
    seed: 1,
    players: opts.players,
    drawPile: opts.drawPile ?? [c('number', 'code', 5), c('number', 'internet', 3)],
    discardPile: [opts.top],
    currentColor: opts.currentColor ?? opts.top.color ?? 'code',
    turn: opts.turn ?? 0,
    direction: opts.direction ?? 1,
    finished: false,
    drewThisTurn: opts.drewThisTurn ?? false,
    seq: 0,
  };
}

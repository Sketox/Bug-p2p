import type { Card, Color, Direction, GameState } from './types.js';

/** Vista pública del estado: oculta las cartas de las manos ajenas (solo su conteo). */
export interface PublicView {
  seed: number;
  players: { id: string; name: string; handCount: number; status: string; saidBug: boolean }[];
  /** Carta tope del pozo (información pública). */
  topCard: Card;
  currentColor: Color;
  turn: number;
  direction: Direction;
  drawCount: number;
  finished: boolean;
  winner?: string;
  /**
   * Quién puso la carta del pozo. Es información pública (todos vieron quién jugó) y la UI la
   * necesita para saber si puedes interrumpir: contra tu propia carta, no.
   */
  lastPlayer?: string;
  /**
   * ¿El jugador en turno ya robó? La UI lo necesita para dos cosas: bloquear el botón de pasar
   * (no se pasa sin robar) y saber que ya no está obligado a nada.
   */
  drewThisTurn: boolean;
  seq: number;
  /** La mano del jugador que solicita la vista (si se indica). */
  yourHand?: Card[];
  /** id del jugador para el que se generó esta vista. */
  youId?: string;
}

/** Genera la vista que puede recibir un peer sin exponer las manos del resto. */
export function redactFor(state: GameState, viewerId?: string): PublicView {
  const top = state.discardPile[state.discardPile.length - 1]!;
  const you = state.players.find((p) => p.id === viewerId);
  return {
    seed: state.seed,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      status: p.status,
      saidBug: p.saidBug,
    })),
    topCard: top,
    currentColor: state.currentColor,
    turn: state.turn,
    direction: state.direction,
    drawCount: state.drawPile.length,
    finished: state.finished,
    ...(state.winner != null ? { winner: state.winner } : {}),
    ...(state.lastPlayer != null ? { lastPlayer: state.lastPlayer } : {}),
    drewThisTurn: state.drewThisTurn,
    seq: state.seq,
    ...(you ? { yourHand: you.hand, youId: you.id } : {}),
  };
}

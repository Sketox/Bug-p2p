// Tipos del dominio de "Bug". Motor PURO: sin red, sin UI, sin fecha/hora ni azar oculto.
// Todo el estado se deriva de forma determinista de una semilla + una secuencia de eventos,
// para que cada nodo de la malla P2P reconstruya exactamente la misma partida.

/** Los 4 "palos" del juego (equivalentes a los colores de UNO). */
export type Color = 'code' | 'hardware' | 'internet' | 'survival';

export const COLORS: readonly Color[] = ['code', 'hardware', 'internet', 'survival'];

/** Tipo/símbolo de cada carta. Solo los dos comodines no tienen color propio. */
export type CardKind =
  | 'number' // 0-9
  | 'skip' // "Se fue el WiFi"
  | 'reverse' // "Ctrl+Z"
  | 'draw2' // "Update de Windows" (+2)
  | 'draw4' // "Update de Windows" (+4) — como el +2, pero roba 4. NO es comodín: tiene color.
  | 'wild' // "Reinicio de Router"
  | 'wild_draw4' // "Pantalla Azul de la Muerte (BSOD)"
  // Cartas de Caos (mecánicas exclusivas de Bug). Tienen color, como cualquier otra:
  | 'copy_paste' // "Copiar y Pegar" — interrupción de turno
  | 'reboot' // "Apagar y volver a prender" — reinicia el pozo
  | 'coffee_spill' // "Derrame de Café" — todos pasan la mano
  | 'trojan'; // "Spam / Virus Troyano" — regalas 2 cartas a alguien

/**
 * Kinds sin color propio: se juegan sobre cualquier carta y quien los tira elige el color.
 *
 * Son solo los dos comodines — los únicos que el arte pinta con las cuatro franjas de color, que es
 * justo lo que significa "no soy de ningún palo". Las de Caos ESTABAN aquí: se jugaban siempre,
 * cayeran donde cayeran. Ahora tienen su color y se ganan el sitio como las demás: igualando.
 */
export const WILD_KINDS: readonly CardKind[] = ['wild', 'wild_draw4'];

/** Kinds considerados "Cartas de Caos" (mecánicas exclusivas de Bug). */
export const CHAOS_KINDS: readonly CardKind[] = ['copy_paste', 'reboot', 'coffee_spill', 'trojan'];

/** Una carta física del mazo. `id` es único y estable (para animaciones y trazas). */
export interface Card {
  readonly id: string;
  readonly kind: CardKind;
  /** Presente en todas menos en los comodines (`WILD_KINDS`). */
  readonly color?: Color;
  /** Solo presente en cartas `number` (0-9). */
  readonly value?: number;
}

export type Direction = 1 | -1;

export interface Player {
  readonly id: string;
  readonly name: string;
  hand: Card[];
  /** Marca de resiliencia para la malla P2P (no afecta a las reglas base). */
  status: 'active' | 'reconnecting' | 'down';
  /** true si el jugador ya gritó "¡Bug!" con 1 carta en mano (aún no penalizado). */
  saidBug: boolean;
}

export interface GameState {
  readonly seed: number;
  players: Player[];
  /** Mazo de robo (boca abajo). El tope es el último elemento. */
  drawPile: Card[];
  /** Pozo de descarte (boca arriba). El tope es el último elemento. */
  discardPile: Card[];
  /** Color activo (el elegido tras un comodín, o el de la carta tope). */
  currentColor: Color;
  /** Índice del jugador en turno dentro de `players`. */
  turn: number;
  direction: Direction;
  /** true cuando la partida terminó. */
  finished: boolean;
  /** id del ganador cuando `finished` es true. */
  winner?: string;
  /**
   * Quién puso la carta que está en el tope del pozo. Lo necesita "Copiar y Pegar": puedes
   * interrumpir la jugada de otro, pero no la tuya (ver `applyCopyPaste`).
   */
  lastPlayer?: string;
  /**
   * ¿El jugador en turno ya robó?
   *
   * Sostiene la regla de "no se pasa de gratis": pasar sin robar sería una forma de esquivar el
   * castigo de no tener jugada. Se pone a `false` sola en cuanto el turno cambia de manos.
   */
  drewThisTurn: boolean;
  /** Contador monotónico de eventos aplicados (útil para orden/depuración). */
  seq: number;
}

/** Carta tope del pozo (la que hay que igualar). */
export function topCard(state: GameState): Card {
  const top = state.discardPile.at(-1);
  if (!top) throw new Error('El pozo de descarte está vacío');
  return top;
}

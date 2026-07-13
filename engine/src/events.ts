import type { Color } from './types.js';

// Eventos = la única forma de mutar el estado. Un partido es una semilla + un log ordenado
// de estos eventos; aplicarlos en orden reconstruye el estado en cualquier nodo (Fase 4).

export type GameEvent =
  | {
      type: 'PLAY';
      playerId: string;
      cardId: string;
      /** Requerido en comodines/caos: color con el que continúa la partida. */
      chosenColor?: Color;
      /** trojan: a quién le entregas cartas. */
      target?: string;
      /** trojan: qué 2 cartas de tu mano entregas. */
      giveCardIds?: string[];
      /** reboot: carta no-especial de tu mano que colocas como nueva base (opcional). */
      rebootCardId?: string;
    }
  | { type: 'DRAW'; playerId: string }
  | { type: 'PASS'; playerId: string }
  | { type: 'SHOUT_BUG'; playerId: string }
  | { type: 'CALL_BUG'; accuserId: string; accusedId: string }
  /**
   * Abandono explícito: el jugador cierra la pestaña o pulsa "salir" (Fase 6).
   *
   * No es lo mismo que caerse. Una caída es una SOSPECHA (el nodo dejó de latir; puede volver) y
   * la resuelve la malla saltando su turno mientras tanto. Un abandono es un HECHO que el propio
   * jugador anuncia: se le marca `down`, sus cartas vuelven al mazo y la mesa deja de contar con
   * él para siempre. Por eso vive en el motor y no en la red: cambia las reglas de la partida
   * (a quién le toca, quién gana) y tiene que aplicarse igual en todos los nodos.
   */
  | { type: 'QUIT'; playerId: string }
  /**
   * Se acabó el tiempo del turno (Fase 6): el jugador roba 2 cartas de castigo y lo pierde.
   *
   * El tiempo NO lo mide el motor —que es puro y no sabe qué hora es—, sino el líder, que emite
   * este evento cuando el turno se le hace eterno. Igual que el `PASS` de recuperación: el líder
   * coordina, el motor manda. Si el jugador ya no estaba en turno cuando llega, se rechaza — en
   * todos los nodos por igual.
   */
  | { type: 'TIMEOUT'; playerId: string };

export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

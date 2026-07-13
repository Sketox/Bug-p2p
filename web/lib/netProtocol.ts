import type { GameEvent } from '@bug/engine';
import type { BullyMessage, Stamped, TokenState } from '@bug/net';

// Mensajes de JUEGO que viajan por los DataChannels (encima del transporte de @bug/net).
//
// Modelo Fase 4: ESTADO REPLICADO. No hay un host dueño de la partida repartiendo vistas. Todos
// los nodos tienen el motor, parten de la misma semilla y aplican el mismo log de eventos
// ordenado por Lamport → todos convergen al mismo estado por su cuenta. Lo que circula por la
// red son eventos, no estado.
//
// Fase 5: TOLERANCIA A FALLOS. Se añaden tres familias de mensajes:
//   - `hb`     → latidos: "sigo vivo, y este es el estado al que he convergido".
//   - `bully`  → elección de líder cuando el coordinador se cae.
//   - `sync`   → snapshot completo para el que se reconecta a media partida.
//
// El líder ya no es el anfitrión por decreto: es un cargo reemplazable que se elige, y su único
// trabajo es coordinar (atender reconexiones, regenerar el testigo perdido). Las reglas las sigue
// mandando el motor replicado, en todos los nodos por igual.

export interface LobbyPlayer {
  peerId: string;
  name: string;
}

/** Datos para reconstruir la partida desde cero: mismo seed + mismos jugadores = mismo reparto. */
export interface GameSetup {
  seed: number;
  players: LobbyPlayer[];
}

/**
 * Snapshot de la partida para un nodo que llega tarde o vuelve de una caída.
 *
 * No lleva el ESTADO del juego, sino su RECETA: la semilla, la historia completa de eventos y la
 * posición del testigo. Quien lo recibe recalcula el estado él mismo con su propio motor. Es la
 * diferencia entre que te den el resultado (y tener que fiarte) y que te den los ingredientes
 * (y comprobarlo tú): un nodo malicioso no puede inyectar un estado falso, porque el estado no
 * viaja — solo viajan eventos que el motor de cada uno valida.
 */
export interface RoomSnapshot {
  setup: GameSetup;
  log: Stamped<GameEvent>[];
  token: TokenState;
  /** Líder vigente, para que el que vuelve sepa a quién obedecer sin abrir una elección. */
  leaderId: string;
}

/** Latido: prueba de vida + huella del estado replicado (permite ver divergencias en vivo). */
export interface Heartbeat {
  /** Huella del estado al que ha convergido este nodo (`stateHash`). Debe coincidir en todos. */
  hash: string | null;
  /** Reloj de Lamport del emisor. */
  lamport: number;
  /** Testigo que conoce (seq + poseedor): delata a un nodo que se quedó atrás. */
  token: TokenState | null;
  /** Líder que reconoce. */
  leaderId: string | null;
}

export type NetMessage =
  | { k: 'lobby'; hostId: string; players: LobbyPlayer[]; started: boolean }
  /** Arranque: todos crean la misma partida inicial y el testigo empieza en el primer jugador. */
  | { k: 'start'; setup: GameSetup; token: TokenState }
  /**
   * Un evento sellado con Lamport. Se difunde a toda la malla.
   * `recovery`: lo emite el LÍDER en nombre de un jugador declarado caído, para destrabar la
   * partida (ver `useBugRoom.recoverStuckTurn`). Es la única excepción al anti-spoof, y está
   * acotada: solo el líder, solo un PASS, y solo si el jugador está caído.
   */
  | { k: 'event'; stamped: Stamped<GameEvent>; recovery?: boolean }
  /** Cesión (o regeneración, tras una caída) del testigo de turno. */
  | { k: 'token'; token: TokenState }
  /**
   * Un nodo que llega tarde (o se reconecta) pide ponerse al día.
   *
   * `repair`: no viene de nuevo, viene DESVIADO. Su huella de estado no coincide con la de los
   * demás y no se arregla sola, así que no quiere que le completen el log: quiere **tirar el suyo y
   * adoptar el ajeno entero** (ver `Replica.adopt`).
   */
  | { k: 'sync-req'; repair?: boolean }
  /**
   * La historia completa. Aplicarla reconstruye el estado exacto.
   *
   * `repair`: la pidió un nodo desviado. Al recibirla, en vez de fundirla con la suya, la adopta
   * entera — tirando su propia historia.
   */
  | { k: 'sync'; snapshot: RoomSnapshot; repair?: boolean }
  /** Prueba de vida periódica. Su ausencia es lo que dispara la detección de fallos. */
  | { k: 'hb'; hb: Heartbeat }
  /** Elección de líder (Bully): election / answer / coordinator. */
  | { k: 'bully'; msg: BullyMessage };

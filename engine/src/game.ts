import type { Card, CardKind, Color, GameState, Player } from './types.js';
import { topCard, WILD_KINDS } from './types.js';
import { buildDeck } from './deck.js';
import { makeRng, shuffle } from './rng.js';
import { EngineError, type GameEvent } from './events.js';

const HAND_SIZE = 7;
const BUG_PENALTY = 2;
/** Cartas que roba quien deja que se le acabe el tiempo del turno. */
const TIMEOUT_PENALTY = 2;

function isWild(card: Card): boolean {
  return WILD_KINDS.includes(card.kind);
}

/**
 * Cuánta gente cabe en una partida. El motor es el único que puede decidirlo —es donde viven las
 * reglas—, pero el aforo hay que hacerlo cumplir mucho antes: cuando alguien intenta ENTRAR a la
 * sala, no cuando el anfitrión pulsa "¡Empezar!" y descubre que sobra gente. De ahí que se exporte.
 * La señalización tiene su propia copia del número (no depende del motor, a propósito) y un test la
 * ata a esta.
 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;

/** Crea una partida determinista a partir de una semilla y la lista de jugadores. */
export function createGame(seed: number, players: { id: string; name: string }[]): GameState {
  if (players.length < MIN_PLAYERS)
    throw new EngineError('TOO_FEW_PLAYERS', `Se necesitan al menos ${MIN_PLAYERS} jugadores`);
  if (players.length > MAX_PLAYERS)
    throw new EngineError('TOO_MANY_PLAYERS', `Máximo ${MAX_PLAYERS} jugadores`);
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) throw new EngineError('DUP_PLAYER', 'IDs de jugador duplicados');

  const rng = makeRng(seed);
  const drawPile = shuffle(buildDeck(), rng);

  const gamePlayers: Player[] = players.map((p) => ({
    id: p.id,
    name: p.name,
    hand: drawPile.splice(drawPile.length - HAND_SIZE, HAND_SIZE),
    status: 'active',
    saidBug: false,
  }));

  // Pozo inicial: la primera carta numérica desde el tope (ignora especiales al inicio).
  let idx = drawPile.length - 1;
  while (idx >= 0 && drawPile[idx]!.kind !== 'number') idx--;
  if (idx < 0) throw new EngineError('NO_START_CARD', 'No hay carta numérica para iniciar el pozo');
  const first = drawPile.splice(idx, 1)[0]!;

  // Quién abre la partida: lo decide la SEMILLA, no la lista.
  //
  // Antes empezaba `players[0]`, que es siempre el anfitrión — el que crea la sala tenía la primera
  // jugada en todas las partidas. Ahora sale del mismo generador determinista que barajó el mazo:
  // es aleatorio para los jugadores y, a la vez, idéntico en todos los nodos (que es lo que
  // importa: no hay nadie que "sortee" y se lo comunique al resto; cada uno llega al mismo número).
  const turn = rng.int(gamePlayers.length);

  return {
    seed,
    players: gamePlayers,
    drawPile,
    discardPile: [first],
    currentColor: first.color!,
    turn,
    direction: 1,
    finished: false,
    drewThisTurn: false,
    seq: 0,
  };
}

/** ¿La carta puede jugarse sobre un tope/color dados? Pura: sirve también en la vista pública. */
export function canPlayOn(top: Card, currentColor: Color, card: Card): boolean {
  if (isWild(card)) return true;
  if (card.color === currentColor) return true;
  if (card.kind === 'number' && top.kind === 'number' && card.value === top.value) return true;
  if (card.kind === top.kind && card.kind !== 'number') return true;
  return false;
}

/** ¿La carta puede jugarse sobre el tope actual del pozo? */
export function canPlay(state: GameState, card: Card): boolean {
  const top = state.discardPile[state.discardPile.length - 1]!;
  return canPlayOn(top, state.currentColor, card);
}

// ---------------------------------------------------------------------------
// Helpers internos (operan sobre un estado ya clonado, así que pueden mutar).
// ---------------------------------------------------------------------------

function playerIndex(state: GameState, id: string): number {
  const i = state.players.findIndex((p) => p.id === id);
  if (i < 0) throw new EngineError('NO_PLAYER', `Jugador desconocido: ${id}`);
  return i;
}

/** Índice del siguiente jugador activo a `steps` pasos, respetando la dirección. */
function advance(state: GameState, from: number, steps: number): number {
  const n = state.players.length;
  // Sin nadie activo no hay a quién pasarle el turno. No debería ocurrir (`applyQuit` termina la
  // partida al quedar uno solo), pero un bucle infinito congelaría el navegador de TODOS los nodos.
  if (!state.players.some((p) => p.status !== 'down')) return from;
  let i = from;
  let moved = 0;
  while (moved < steps) {
    i = (i + state.direction + n) % n;
    if (state.players[i]!.status !== 'down') moved++;
  }
  return i;
}

/** Repone el mazo de robo barajando el pozo (dejando el tope) si hace falta. */
function refillIfEmpty(state: GameState): void {
  if (state.drawPile.length > 0 || state.discardPile.length <= 1) return;
  const top = state.discardPile.pop()!;
  const rng = makeRng(state.seed ^ (state.seq * 0x9e3779b1));
  state.drawPile = shuffle(state.discardPile, rng);
  state.discardPile = [top];
}

function drawCards(state: GameState, playerIdx: number, count: number): void {
  const player = state.players[playerIdx]!;
  for (let i = 0; i < count; i++) {
    refillIfEmpty(state);
    const card = state.drawPile.pop();
    if (!card) break; // sin cartas disponibles (caso extremo)
    player.hand.push(card);
  }
  syncBug(player);
}

/** Mantiene coherente la marca "¡Bug!": solo válida con exactamente 1 carta. */
function syncBug(player: Player): void {
  if (player.hand.length !== 1) player.saidBug = false;
}

function requireTurn(state: GameState, playerId: string): number {
  const i = playerIndex(state, playerId);
  if (i !== state.turn) throw new EngineError('NOT_YOUR_TURN', 'No es tu turno');
  return i;
}

// ---------------------------------------------------------------------------
// Reductor puro: apply(state, event) -> nuevo estado (no muta la entrada).
// ---------------------------------------------------------------------------

export function apply(prev: GameState, event: GameEvent): GameState {
  const state: GameState = structuredClone(prev);
  if (state.finished) throw new EngineError('GAME_OVER', 'La partida ya terminó');

  switch (event.type) {
    case 'PLAY':
      applyPlay(state, event);
      break;
    case 'DRAW':
      applyDraw(state, requireTurn(state, event.playerId));
      break;
    case 'PASS':
      applyPass(state, requireTurn(state, event.playerId));
      break;
    case 'SHOUT_BUG':
      applyShoutBug(state, playerIndex(state, event.playerId));
      break;
    case 'CALL_BUG':
      applyCallBug(state, event.accuserId, event.accusedId);
      break;
    case 'QUIT':
      applyQuit(state, event.playerId);
      break;
    case 'TIMEOUT':
      applyTimeout(state, requireTurn(state, event.playerId));
      break;
    default: {
      const _exhaustive: never = event;
      throw new EngineError('UNKNOWN_EVENT', `Evento desconocido: ${JSON.stringify(_exhaustive)}`);
    }
  }

  // El turno cambió de manos → el siguiente empieza sin haber robado. Se hace aquí, en un solo
  // sitio, y no en cada `advance()` repartido por el reductor: media docena de sitios donde
  // acordarse es media docena de sitios donde olvidarse.
  if (state.turn !== prev.turn) state.drewThisTurn = false;

  state.seq++;
  return state;
}

/**
 * Se acabó el tiempo. Robas 2 cartas y pierdes el turno.
 *
 * El castigo existe para que quedarse quieto no sea una estrategia: si no tienes jugada, robar es
 * tu obligación (ver `applyPass`), y esperar a que pase el reloj para no robar te sale más caro.
 */
function applyTimeout(state: GameState, playerIdx: number): void {
  drawCards(state, playerIdx, TIMEOUT_PENALTY);
  state.turn = advance(state, playerIdx, 1);
}

function applyPlay(state: GameState, event: Extract<GameEvent, { type: 'PLAY' }>): void {
  const playerIdx = playerIndex(state, event.playerId);
  const player = state.players[playerIdx]!;
  if (player.status === 'down') throw new EngineError('NOT_PLAYING', 'Ya no estás en la partida');

  const handIdx = player.hand.findIndex((c) => c.id === event.cardId);
  if (handIdx < 0) throw new EngineError('NOT_IN_HAND', 'No tienes esa carta');
  const card = player.hand[handIdx]!;

  // "Copiar y Pegar" es la única carta que se juega FUERA de turno: es una interrupción.
  // Cualquier otra cosa exige que sea tu turno.
  if (isInterrupt(state, playerIdx, card)) {
    applyCopyPaste(state, playerIdx, handIdx, event);
    return;
  }
  if (playerIdx !== state.turn) throw new EngineError('NOT_YOUR_TURN', 'No es tu turno');
  if (!canPlay(state, card)) throw new EngineError('ILLEGAL_MOVE', 'Esa carta no coincide con el pozo');

  // Descartar y comprobar victoria ANTES de resolver efectos (gana quien descarta su última).
  player.hand.splice(handIdx, 1);
  state.discardPile.push(card);
  state.lastPlayer = player.id;

  if (player.hand.length === 0) {
    state.finished = true;
    state.winner = player.id;
    return;
  }
  syncBug(player);

  // Color que continúa la partida.
  if (isWild(card)) {
    state.currentColor = resolveWildColor(state, event, player);
  } else {
    state.currentColor = card.color!;
  }

  resolveEffect(state, playerIdx, card, event);
  checkWinAfterEffect(state, playerIdx);
}

/**
 * La victoria también puede llegar POR EL EFECTO de la carta, no solo al descartarla.
 *
 * El caso que lo destapó: juegas el Virus Troyano con tres cartas y le regalas las dos que te
 * quedan. Descartas (te quedan 2 → no ganas todavía), y es el EFECTO el que te vacía la mano. Sin
 * esta comprobación te quedabas con cero cartas, en turno, sin nada que jugar: mesa muerta, nadie
 * ganaba, y la partida no terminaba nunca.
 *
 * La regla no cambia —ganas cuando te quedas sin cartas—; lo que cambia es CUÁNDO se mira.
 */
function checkWinAfterEffect(state: GameState, playerIdx: number): void {
  if (state.finished) return;
  const player = state.players[playerIdx]!;
  if (player.hand.length > 0) return;
  state.finished = true;
  state.winner = player.id;
}

/** ¿Esta jugada es una interrupción? Solo lo es un "Copiar y Pegar" jugado fuera de turno. */
function isInterrupt(state: GameState, playerIdx: number, card: Card): boolean {
  return card.kind === 'copy_paste' && playerIdx !== state.turn;
}

/**
 * Efectos que el portapapeles sabe copiar. Las cartas de CAOS quedan fuera a propósito: copiar un
 * troyano exigiría elegir víctima, copiar un "apagar y prender" exigiría una carta base… y una
 * interrupción tiene que resolverse sola, sin abrir otra pregunta al que la sufre. El portapapeles
 * no soporta el caos: si el tope es una carta de caos, solo te cuelas en la ronda.
 */
const COPYABLE: readonly CardKind[] = ['number', 'skip', 'reverse', 'draw2', 'wild', 'wild_draw4'];

/**
 * "Copiar y Pegar" — la interrupción (Fase 6).
 *
 * Se juega FUERA de tu turno: cortas la ronda, copias el efecto de la carta que acaba de caer al
 * pozo y la partida sigue desde ti. Es la única carta que rompe el turno, y por eso es la única
 * que no pasa por el testigo (ver `useBugRoom.needsToken`): un evento genuinamente concurrente,
 * como gritar "¡Bug!" — lo ordena Lamport, no la exclusión mutua.
 *
 * Es también el punto donde el diseño distribuido se pone a prueba de verdad: si el jugador en
 * turno estaba jugando su carta a la vez que alguien interrumpe, los dos eventos son concurrentes.
 * El log los ordena igual en todos los nodos, y el que pierda la carrera ve su jugada RECHAZADA
 * —"ya no es tu turno"— por el mismo motor determinista, en todas las réplicas a la vez. Nadie
 * arbitra: convergen.
 */
function applyCopyPaste(
  state: GameState,
  playerIdx: number,
  handIdx: number,
  event: Extract<GameEvent, { type: 'PLAY' }>,
): void {
  const player = state.players[playerIdx]!;

  // No puedes interrumpirte a ti mismo: si la carta del tope la pusiste tú, no hay nada que cortar
  // (y si no, bastaría con encadenar copias para no soltar nunca el turno).
  if (state.lastPlayer === player.id) {
    throw new EngineError('NO_SELF_INTERRUPT', 'No puedes interrumpir tu propia jugada');
  }

  const copied = topCard(state); // lo que se copia: la carta que está en el pozo AHORA

  const card = player.hand.splice(handIdx, 1)[0]!;
  state.discardPile.push(card);
  state.lastPlayer = player.id;

  if (player.hand.length === 0) {
    state.finished = true;
    state.winner = player.id;
    return;
  }
  syncBug(player);

  // "Pegar": se repite el efecto de la carta copiada, ahora como si la hubiera jugado el que
  // interrumpe. Si era de caos, no se replica nada — solo te has colado.
  if (COPYABLE.includes(copied.kind)) {
    if (copied.color) state.currentColor = copied.color;
    resolveEffect(state, playerIdx, copied, event);
  } else {
    state.turn = advance(state, playerIdx, 1);
  }
  checkWinAfterEffect(state, playerIdx); // por el mismo motivo que en `applyPlay`
}

function resolveWildColor(
  state: GameState,
  event: Extract<GameEvent, { type: 'PLAY' }>,
  player: Player,
): Color {
  // reboot puede fijar el color mediante la carta base; en los demás, el jugador elige.
  if (event.chosenColor) return event.chosenColor;
  if (event.rebootCardId) {
    const base = player.hand.find((c) => c.id === event.rebootCardId);
    if (base?.color) return base.color;
  }
  throw new EngineError('NEED_COLOR', 'Debes elegir un color para el comodín');
}

/** Aplica el efecto de la carta jugada y decide a quién le toca después. */
function resolveEffect(
  state: GameState,
  playerIdx: number,
  card: Card,
  event: Extract<GameEvent, { type: 'PLAY' }>,
): void {
  const twoPlayers = state.players.filter((p) => p.status !== 'down').length === 2;

  switch (card.kind) {
    case 'number':
    case 'wild':
    case 'copy_paste': // (Fase 0: se juega en turno como comodín; interrupción → Fase 4)
      state.turn = advance(state, playerIdx, 1);
      return;

    case 'reverse':
      state.direction = (state.direction * -1) as 1 | -1;
      // Con 2 jugadores, la reversa actúa como salto (regla estándar de UNO).
      state.turn = advance(state, playerIdx, twoPlayers ? 2 : 1);
      return;

    case 'skip':
      state.turn = advance(state, playerIdx, 2);
      return;

    case 'draw2': {
      const victim = advance(state, playerIdx, 1);
      drawCards(state, victim, 2);
      state.turn = advance(state, playerIdx, 2); // el castigado pierde el turno
      return;
    }

    case 'wild_draw4': {
      const victim = advance(state, playerIdx, 1);
      drawCards(state, victim, 4);
      state.turn = advance(state, playerIdx, 2);
      return;
    }

    case 'reboot': {
      // "Apagar y volver a prender": si trae carta base no-especial, la coloca como nuevo tope.
      if (event.rebootCardId) {
        const player = state.players[playerIdx]!;
        const baseIdx = player.hand.findIndex((c) => c.id === event.rebootCardId);
        const base = baseIdx >= 0 ? player.hand[baseIdx]! : undefined;
        if (!base) throw new EngineError('NO_BASE_CARD', 'No tienes esa carta base');
        if (isWild(base)) throw new EngineError('BAD_BASE_CARD', 'La carta base no puede ser especial');
        player.hand.splice(baseIdx, 1);
        state.discardPile.push(base);
        state.currentColor = base.color!;
        if (player.hand.length === 0) {
          state.finished = true;
          state.winner = player.id;
          return;
        }
        syncBug(player);
      }
      state.turn = advance(state, playerIdx, 1);
      return;
    }

    case 'coffee_spill': {
      // "Derrame de Café": todos pasan su mano completa al siguiente en la dirección actual.
      passHandsAround(state);
      state.turn = advance(state, playerIdx, 1);
      return;
    }

    case 'trojan': {
      // "Virus Troyano": entregas hasta 2 cartas a un jugador cualquiera.
      applyTrojan(state, playerIdx, event);
      state.turn = advance(state, playerIdx, 1);
      return;
    }
  }
}

function passHandsAround(state: GameState): void {
  // Solo circulan las manos de quien sigue en la mesa: darle la mano a un jugador que abandonó
  // sería sacar esas cartas de la partida para siempre.
  const active = state.players.filter((p) => p.status !== 'down');
  const n = active.length;
  if (n < 2) return;
  const hands = active.map((p) => p.hand);
  for (let i = 0; i < n; i++) {
    const target = (i + state.direction + n) % n;
    active[target]!.hand = hands[i]!;
  }
  for (const p of active) syncBug(p);
}

function applyTrojan(
  state: GameState,
  playerIdx: number,
  event: Extract<GameEvent, { type: 'PLAY' }>,
): void {
  if (!event.target) throw new EngineError('NEED_TARGET', 'Elige a quién infectar');
  const targetIdx = playerIndex(state, event.target);
  if (targetIdx === playerIdx) throw new EngineError('BAD_TARGET', 'No puedes infectarte a ti mismo');
  const player = state.players[playerIdx]!;
  const target = state.players[targetIdx]!;
  if (target.status === 'down') throw new EngineError('BAD_TARGET', 'Ese jugador abandonó la partida');
  const giveIds = (event.giveCardIds ?? []).slice(0, 2);
  for (const id of giveIds) {
    const gi = player.hand.findIndex((c) => c.id === id);
    if (gi < 0) throw new EngineError('NOT_IN_HAND', 'No tienes esa carta para entregar');
    target.hand.push(player.hand.splice(gi, 1)[0]!);
  }
  syncBug(player);
  syncBug(target);
}

function applyDraw(state: GameState, playerIdx: number): void {
  refillIfEmpty(state);
  const before = state.players[playerIdx]!.hand.length;
  drawCards(state, playerIdx, 1);
  state.drewThisTurn = true;

  const drawn = state.players[playerIdx]!.hand[before];
  // Si la carta robada se puede jugar, el turno se queda para que juegue o pase.
  if (drawn && canPlay(state, drawn)) return;
  state.turn = advance(state, playerIdx, 1);
}

/**
 * Pasar el turno — pero solo si ya has robado.
 *
 * Sin esta condición, pasar sería una puerta trasera: el jugador sin jugada se limitaría a pasar y
 * nunca robaría, que es justo el castigo que la falta de jugada debería costarle. Robar primero,
 * pasar después.
 */
function applyPass(state: GameState, playerIdx: number): void {
  if (!state.drewThisTurn) {
    throw new EngineError('MUST_DRAW', 'Tienes que robar antes de pasar');
  }
  state.turn = advance(state, playerIdx, 1);
}

function applyShoutBug(state: GameState, playerIdx: number): void {
  const player = state.players[playerIdx]!;
  if (player.hand.length === 1) player.saidBug = true;
}

function applyCallBug(state: GameState, accuserId: string, accusedId: string): void {
  playerIndex(state, accuserId); // valida que exista
  const accusedIdx = playerIndex(state, accusedId);
  const accused = state.players[accusedIdx]!;
  if (accused.hand.length === 1 && !accused.saidBug) {
    drawCards(state, accusedIdx, BUG_PENALTY);
  }
}

/**
 * Un jugador abandona la partida (Fase 6).
 *
 * Es idempotente a propósito: el mismo QUIT puede llegar dos veces por caminos distintos de la
 * malla, y el segundo no debe alterar el estado — si lo hiciera, dos nodos que recibieron distinto
 * número de copias dejarían de converger.
 */
function applyQuit(state: GameState, playerId: string): void {
  const idx = playerIndex(state, playerId);
  const player = state.players[idx]!;
  if (player.status === 'down') return;

  player.status = 'down';
  player.saidBug = false;

  // Sus cartas vuelven al fondo del mazo. Si se las llevara puestas, esas cartas desaparecerían
  // de la partida y el mazo podría quedarse sin reponer.
  state.drawPile.unshift(...player.hand);
  player.hand = [];

  // Si solo queda uno en la mesa, no hay partida que jugar: gana por abandono.
  const active = state.players.filter((p) => p.status !== 'down');
  if (active.length <= 1) {
    state.finished = true;
    if (active[0]) state.winner = active[0].id;
    return;
  }

  // Se fue en su turno: la mesa no puede quedarse esperando a un navegador que ya no existe.
  if (state.turn === idx) state.turn = advance(state, idx, 1);
}

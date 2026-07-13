import { describe, expect, it } from 'vitest';
import {
  apply,
  createGame,
  makeRng,
  type CardKind,
  type GameEvent,
  type GameState,
} from '@bug/engine';
import { Replica, stateHash } from '../src/replica.js';
import type { Stamped } from '../src/lamport.js';

// Convergencia de la malla: TRES nodos que reciben los mismos eventos en órdenes DISTINTOS
// deben terminar con exactamente el mismo estado de partida. Es la propiedad que sostiene todo
// el diseño descentralizado: si se cumple, nadie necesita ser dueño del estado.

const PLAYERS = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'carol', name: 'Carol' },
];
const SEED = 20260712;

/** Cartas de caos: piden parámetros extra (objetivo, cartas a regalar…). El bot las evita. */
const CHAOS: readonly CardKind[] = ['copy_paste', 'reboot', 'coffee_spill', 'trojan'];

const isValid = (state: GameState, event: GameEvent): boolean => {
  try {
    apply(state, event);
    return true;
  } catch {
    return false;
  }
};

/** Bot determinista: juega la primera carta legal de su mano; si no tiene ninguna, roba. */
function pickEvent(state: GameState): GameEvent | null {
  const player = state.players[state.turn]!;
  for (const card of player.hand) {
    if (CHAOS.includes(card.kind)) continue;
    const event: GameEvent = {
      type: 'PLAY',
      playerId: player.id,
      cardId: card.id,
      chosenColor: 'code', // solo lo usan los comodines; los demás lo ignoran
    };
    if (isValid(state, event)) return event;
  }
  const draw: GameEvent = { type: 'DRAW', playerId: player.id };
  return isValid(state, draw) ? draw : null;
}

/** Juega una partida entera y devuelve el log sellado con relojes de Lamport. */
function simulate(maxEvents = 80): Stamped<GameEvent>[] {
  let state = createGame(SEED, PLAYERS);
  const log: Stamped<GameEvent>[] = [];
  let lamport = 0;

  while (!state.finished && log.length < maxEvents) {
    const event = pickEvent(state);
    if (!event) break;
    state = apply(state, event);
    // Los eventos son causalmente secuenciales (cada jugada ve la anterior), así que el sello
    // crece de uno en uno; el `origin` es quien actuó.
    log.push({ lamport: ++lamport, origin: actorOf(event), event });
  }
  return log;
}

function actorOf(event: GameEvent): string {
  return event.type === 'CALL_BUG' ? event.accuserId : event.playerId;
}

/** Barajado determinista, para que el test no sea aleatorio entre ejecuciones. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rng = makeRng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const newReplica = () =>
  new Replica<GameState, GameEvent>({
    initial: createGame(SEED, PLAYERS),
    apply,
  });

describe('convergencia de la malla', () => {
  it('la simulación produce una partida con suficientes eventos para ser interesante', () => {
    const log = simulate();
    expect(log.length).toBeGreaterThan(10);
  });

  it('3 nodos con órdenes de entrega distintos convergen al mismo estado', () => {
    const log = simulate();

    const alice = newReplica(); // recibe en orden
    const bob = newReplica(); // recibe todo al revés (peor caso)
    const carol = newReplica(); // recibe barajado (red caótica)

    alice.deliverAll(log);
    bob.deliverAll([...log].reverse());
    carol.deliverAll(shuffled(log, 99));

    const h = stateHash(alice.state);
    expect(stateHash(bob.state)).toBe(h);
    expect(stateHash(carol.state)).toBe(h);

    // …y no es que hayan convergido a "nada": la partida realmente avanzó.
    expect(alice.state.seq).toBeGreaterThan(10);
    expect(alice.events).toHaveLength(log.length);
  });

  it('el estado convergido es el mismo que aplicando el log en orden, sin réplica', () => {
    const log = simulate();
    const oracle = log.reduce((s, st) => apply(s, st.event), createGame(SEED, PLAYERS));

    const nodo = newReplica();
    nodo.deliverAll(shuffled(log, 7));

    expect(stateHash(nodo.state)).toBe(stateHash(oracle));
  });

  it('un evento que llega tarde dispara replay y no corrompe el estado', () => {
    const log = simulate();
    const [primero, ...resto] = log;

    const nodo = newReplica();
    nodo.deliverAll(resto); // el primer evento se "perdió" en la red…
    const res = nodo.deliver(primero!); // …y aparece al final

    expect(res.replayed).toBe(true); // hubo que reordenar y recalcular

    const enOrden = newReplica();
    enOrden.deliverAll(log);
    expect(stateHash(nodo.state)).toBe(stateHash(enOrden.state));
  });

  it('reentregar un evento no lo aplica dos veces (idempotencia)', () => {
    const log = simulate();
    const nodo = newReplica();
    nodo.deliverAll(log);
    const antes = stateHash(nodo.state);

    const res = nodo.deliver(log[3]!); // la malla lo reenvía por otro camino
    expect(res.accepted).toBe(false);
    expect(stateHash(nodo.state)).toBe(antes);
    expect(nodo.events).toHaveLength(log.length);
  });
});

describe('eventos concurrentes', () => {
  it('dos eventos con el mismo sello se ordenan igual en todos los nodos', () => {
    const log = simulate(20);
    const t = log[log.length - 1]!.lamport + 1;

    // Bob y Carol acusan a la vez: mismo sello de Lamport, sin relación causal entre ellos.
    // El desempate por peerId hace que ambos nodos elijan la misma secuencia.
    const bobAcusa: Stamped<GameEvent> = {
      lamport: t,
      origin: 'bob',
      event: { type: 'CALL_BUG', accuserId: 'bob', accusedId: 'alice' },
    };
    const carolAcusa: Stamped<GameEvent> = {
      lamport: t,
      origin: 'carol',
      event: { type: 'CALL_BUG', accuserId: 'carol', accusedId: 'alice' },
    };

    const n1 = newReplica();
    n1.deliverAll([...log, bobAcusa, carolAcusa]);

    const n2 = newReplica();
    n2.deliverAll([...log, carolAcusa, bobAcusa]); // orden de llegada invertido

    expect(stateHash(n1.state)).toBe(stateHash(n2.state));
    expect(n1.events.map((e) => e.origin).slice(-2)).toEqual(['bob', 'carol']);
    expect(n2.events.map((e) => e.origin).slice(-2)).toEqual(['bob', 'carol']);
  });
});

describe('eventos inválidos', () => {
  it('una jugada fuera de turno se rechaza igual en todos los nodos', () => {
    const log = simulate(20);
    const state = newReplica();
    state.deliverAll(log);

    // Quien NO está en turno intenta robar (spoof / cliente modificado).
    const enTurno = state.state.players[state.state.turn]!.id;
    const tramposo = PLAYERS.map((p) => p.id).find((id) => id !== enTurno)!;

    const trampa: Stamped<GameEvent> = {
      lamport: log[log.length - 1]!.lamport + 1,
      origin: tramposo,
      event: { type: 'DRAW', playerId: tramposo },
    };

    const n1 = newReplica();
    n1.deliverAll([...log, trampa]);
    const n2 = newReplica();
    n2.deliverAll(shuffled([...log, trampa], 3));

    // El evento entra al log (es historia compartida) pero el reductor lo rechaza en ambos.
    expect(n1.rejectedCount).toBe(1);
    expect(n2.rejectedCount).toBe(1);

    // Y el estado es idéntico al de una partida donde la trampa nunca ocurrió.
    const limpio = newReplica();
    limpio.deliverAll(log);
    expect(stateHash(n1.state)).toBe(stateHash(limpio.state));
    expect(stateHash(n2.state)).toBe(stateHash(limpio.state));
  });
});

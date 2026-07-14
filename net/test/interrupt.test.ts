import { describe, expect, it } from 'vitest';
import { apply, createGame, type Card, type GameEvent, type GameState } from '@bug/engine';
import { Replica, stateHash } from '../src/replica.js';
import { TurnToken } from '../src/token.js';
import type { Stamped } from '../src/lamport.js';

// "Copiar y Pegar" en la malla: la carta que rompe el turno.
//
// Todo lo demás en esta partida pasa por el testigo — solo su poseedor juega, roba o pasa — y esa
// exclusión mutua es lo que evita que dos jugadores actúen a la vez. La interrupción, por
// definición, NO puede pasar por ahí: se juega justamente cuando no te toca. Así que es el único
// evento del juego que puede llegar de cualquiera, en cualquier momento, y competir de verdad con
// otro.
//
// Lo que sostiene el diseño en ese caso no es el testigo: es el LOG ORDENADO (Lamport) más un
// motor determinista. Los dos eventos concurrentes se ordenan igual en todos los nodos, y el que
// pierda la carrera ve su jugada rechazada — en todas las réplicas a la vez, sin que nadie arbitre.

const PLAYERS = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'carol', name: 'Carol' },
];
const SEED = 909;

class Node {
  readonly replica: Replica<GameState, GameEvent>;
  readonly token: TurnToken;
  lamport = 0;

  constructor(readonly id: string, holder: string) {
    this.replica = new Replica<GameState, GameEvent>({ initial: createGame(SEED, PLAYERS), apply });
    this.token = new TurnToken(id, holder, 0);
  }

  stamp(event: GameEvent, at?: number): Stamped<GameEvent> {
    this.lamport = at ?? this.lamport + 1;
    return { lamport: this.lamport, origin: this.id, event };
  }

  receive(s: Stamped<GameEvent>): void {
    this.lamport = Math.max(this.lamport, s.lamport) + 1;
    this.replica.deliver(s);
  }

  get state(): GameState {
    return this.replica.state;
  }
  get turnOwner(): string {
    return this.state.players[this.state.turn]!.id;
  }
  get hash(): string {
    return stateHash(this.state);
  }
  hand(id: string): Card[] {
    return this.state.players.find((p) => p.id === id)!.hand;
  }
}

/** Pone una partida en un punto concreto: `interruptor` tiene un Copiar y Pegar, y no es su turno. */
function armed() {
  const initial = createGame(SEED, PLAYERS);
  const firstIdx = initial.turn;
  const first = initial.players[firstIdx]!.id;
  const nodes = PLAYERS.map((p) => new Node(p.id, first));

  // El que corta es el SIGUIENTE al que abre. No vale cualquiera: quien está justo ANTES del que
  // abre le devolvería el turno al interrumpir (la ronda avanza uno), y entonces la jugada del
  // interrumpido seguiría siendo legal — que es justo lo contrario de lo que estos tests miden.
  // (Quién abre lo decide la semilla, así que las posiciones no se pueden dar por supuestas.)
  const interruptor = initial.players[(firstIdx + 1) % initial.players.length]!.id;

  // Se le pone la carta en la mano a mano (el reparto es aleatorio pero determinista; no vamos a
  // barajar semillas hasta que salga). Todos los nodos aplican el mismo apaño, así que siguen
  // partiendo del mismo estado.
  //
  // Y se le pone DEL COLOR DE LA MESA: el Copiar y Pegar tiene color, así que para cortar hay que
  // igualar el pozo como con cualquier otra carta. Lo que la interrupción se salta es el turno, no
  // las reglas — y sin el color, estos tests medirían un corte que el motor ya no permite.
  const paste: Card = { id: 'paste-test', kind: 'copy_paste', color: initial.currentColor };
  for (const n of nodes) {
    n.replica.state.players.find((p) => p.id === interruptor)!.hand.push(paste);
    n.replica.state.lastPlayer = first; // la carta del pozo la puso el que abre
  }
  return { nodes, first, interruptor, paste, node: (id: string) => nodes.find((n) => n.id === id)! };
}

describe('interrupción en la malla', () => {
  it('no necesita el testigo, y aun así todos los nodos convergen', () => {
    const { nodes, first, interruptor, paste, node } = armed();
    const cutter = node(interruptor);

    // El testigo lo tiene otro: el que interrumpe NO lo pide y NO lo espera.
    expect(cutter.token.held()).toBe(false);
    expect(node(first).token.held()).toBe(true);

    const cut = cutter.stamp({ type: 'PLAY', playerId: interruptor, cardId: paste.id });
    for (const n of nodes) n.receive(cut);

    // La ronda siguió desde el que cortó, y las tres réplicas coinciden.
    expect(nodes[0]!.turnOwner).not.toBe(first);
    expect(nodes[0]!.hash).toBe(nodes[1]!.hash);
    expect(nodes[1]!.hash).toBe(nodes[2]!.hash);
    expect(nodes[0]!.replica.rejectedCount).toBe(0);
  });

  it('el que tenía el turno cede el testigo cuando el estado deja de dárselo', () => {
    const { nodes, first, interruptor, paste, node } = armed();
    const holder = node(first);

    const cut = node(interruptor).stamp({ type: 'PLAY', playerId: interruptor, cardId: paste.id });
    for (const n of nodes) n.receive(cut);

    // Quien tenía el testigo ve, al aplicar la interrupción, que el turno ya no es suyo: lo cede a
    // quien ahora le toca. Es exactamente lo que hace `passTokenIfNeeded` en el hook de React.
    const handover = holder.token.passTo(holder.turnOwner);
    expect(handover).not.toBeNull();
    for (const n of nodes) n.token.receive(handover!);

    const next = node(holder.turnOwner);
    expect(next.token.held()).toBe(true);
    expect(next.turnOwner).toBe(next.id);
  });

  it('carrera: si la interrupción gana, la jugada del que tenía el turno se rechaza en TODOS los nodos', () => {
    const { nodes, first, interruptor, paste, node } = armed();

    // El jugador en turno tiene su carta lista (se la ponemos a mano en todas las réplicas, para
    // que el test ejercite siempre la carrera y no dependa de lo que salga en el reparto).
    const owner = node(first);
    const playable: Card = { id: 'jugable', kind: 'number', color: owner.state.currentColor, value: 7 };
    for (const n of nodes) n.replica.state.players.find((p) => p.id === first)!.hand.push(playable);

    // …y a la vez alguien corta. Dos eventos concurrentes: los sella Lamport y el log los ordena
    // igual en todas partes. Aquí la interrupción llega con marca menor y gana la carrera.
    const cut = node(interruptor).stamp({ type: 'PLAY', playerId: interruptor, cardId: paste.id }, 5);
    const late = owner.stamp({ type: 'PLAY', playerId: first, cardId: playable.id }, 6);

    // Cada nodo los recibe en un orden distinto (la red no garantiza nada).
    nodes[0]!.receive(cut);
    nodes[0]!.receive(late);
    nodes[1]!.receive(late); // este los ve al revés…
    nodes[1]!.receive(cut);
    nodes[2]!.receive(cut);
    nodes[2]!.receive(late);

    // …y aun así los tres acaban idénticos: el log reordena por Lamport y el motor rechaza la
    // jugada tardía ("ya no es tu turno") en los tres por igual.
    expect(nodes[0]!.hash).toBe(nodes[1]!.hash);
    expect(nodes[1]!.hash).toBe(nodes[2]!.hash);
    for (const n of nodes) expect(n.replica.rejectedCount).toBe(1);

    // La carta que perdió la carrera sigue en su mano: no se la ha tragado nadie.
    expect(nodes[0]!.hand(first).some((c) => c.id === playable.id)).toBe(true);
  });

  it('dos interrupciones a la vez: solo la primera corta; la segunda se resuelve igual en todos', () => {
    const { nodes, first, paste, node } = armed();
    const others = PLAYERS.filter((p) => p.id !== first).map((p) => p.id);
    const [cutterA, cutterB] = others as [string, string];

    // Los dos rivales tienen un Copiar y Pegar (del color de la mesa, o no podrían cortar) y los
    // dos cortan a la vez.
    const paste2: Card = {
      id: 'paste-test-2',
      kind: 'copy_paste',
      color: nodes[0]!.replica.state.currentColor,
    };
    for (const n of nodes) n.replica.state.players.find((p) => p.id === cutterB)!.hand.push(paste2);

    const first_cut = node(cutterA).stamp({ type: 'PLAY', playerId: cutterA, cardId: paste.id }, 5);
    const second_cut = node(cutterB).stamp({ type: 'PLAY', playerId: cutterB, cardId: paste2.id }, 6);

    nodes[0]!.receive(first_cut);
    nodes[0]!.receive(second_cut);
    nodes[1]!.receive(second_cut); // orden inverso
    nodes[1]!.receive(first_cut);
    nodes[2]!.receive(first_cut);
    nodes[2]!.receive(second_cut);

    // Da igual el orden de llegada: el log los ordena por Lamport y las tres réplicas convergen.
    expect(nodes[0]!.hash).toBe(nodes[1]!.hash);
    expect(nodes[1]!.hash).toBe(nodes[2]!.hash);
    expect(nodes[0]!.replica.rejectedCount).toBe(nodes[1]!.replica.rejectedCount);
  });
});

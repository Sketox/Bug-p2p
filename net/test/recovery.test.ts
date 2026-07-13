import { describe, expect, it } from 'vitest';
import { apply, createGame, type GameEvent, type GameState } from '@bug/engine';
import { Replica, stateHash } from '../src/replica.js';
import { TurnToken } from '../src/token.js';
import type { Stamped } from '../src/lamport.js';

// Tolerancia a fallos (Fase 5), probada donde de verdad importa: sobre la partida.
//
// Los tests de `bully` y `heartbeat` prueban los mecanismos por separado. Este prueba la
// PROPIEDAD DEL SISTEMA que justifica tenerlos: cuando un jugador se cae —incluso si se cae
// justo cuando le tocaba jugar, con el testigo en la mano— la partida NO se queda congelada,
// los supervivientes siguen convergiendo al mismo estado, y el que vuelve se pone al día sin
// que nadie le mande el estado: se lo recalcula él solo a partir del log.

const PLAYERS = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'carol', name: 'Carol' },
];
const SEED = 777;

/** Un nodo: su réplica del motor, su testigo y su reloj lógico. */
class Node {
  readonly replica: Replica<GameState, GameEvent>;
  readonly token: TurnToken;
  lamport = 0;

  constructor(
    readonly id: string,
    initialHolder: string,
  ) {
    this.replica = new Replica<GameState, GameEvent>({
      initial: createGame(SEED, PLAYERS),
      apply,
    });
    this.token = new TurnToken(id, initialHolder, 0);
  }

  stamp(event: GameEvent): Stamped<GameEvent> {
    return { lamport: ++this.lamport, origin: this.id, event };
  }

  receive(stamped: Stamped<GameEvent>): void {
    this.lamport = Math.max(this.lamport, stamped.lamport) + 1;
    this.replica.deliver(stamped);
  }

  get turnOwner(): string {
    const s = this.replica.state;
    return s.players[s.turn]!.id;
  }

  get hash(): string {
    return stateHash(this.replica.state);
  }
}

describe('tolerancia a fallos: caída del jugador en turno', () => {
  it('el líder destraba la partida y todos (incluido el que vuelve) convergen', () => {
    const initial = createGame(SEED, PLAYERS);
    const first = initial.players[initial.turn]!.id;

    const alice = new Node('alice', first);
    const bob = new Node('bob', first);
    const carol = new Node('carol', first);
    const all = [alice, bob, carol];

    // --- La partida avanza con normalidad hasta que le toca a Carol -------------------------
    const play = (node: Node, event: GameEvent) => {
      const stamped = node.stamp(event);
      for (const n of all) n.receive(stamped);
    };

    let guard = 0;
    while (alice.turnOwner !== 'carol' && guard++ < 20) {
      const owner = alice.turnOwner;
      play(all.find((n) => n.id === owner)!, { type: 'DRAW', playerId: owner });
      play(all.find((n) => n.id === owner)!, { type: 'PASS', playerId: owner });
    }
    expect(alice.turnOwner).toBe('carol');
    expect(alice.hash).toBe(bob.hash);

    // El testigo va llegando a Carol siguiendo el turno.
    const handover = { seq: 9, holder: 'carol' };
    for (const n of all) n.token.receive(handover);
    expect(carol.token.held()).toBe(true);

    // --- CAE CAROL, con el turno y el testigo en la mano -------------------------------------
    // Nadie puede jugar: el testigo está en un nodo muerto y el motor solo acepta jugadas del
    // jugador en turno, que es justamente el que ya no está. Sin recuperación, mesa congelada.
    const frozen = alice.hash;
    expect(alice.turnOwner).toBe('carol'); // atascada

    // El líder (Bob, elegido por Bully) fuerza el fin de su turno EN NOMBRE de Carol.
    //
    // Es un `TIMEOUT`, no un `PASS`: desde que no se puede pasar sin robar, un PASS forzado sería
    // una jugada ilegal — y además no hacía falta inventar nada, porque **un jugador caído es
    // exactamente un jugador que no juega a tiempo**. Roba 2 y pierde el turno, como cualquiera
    // que se queda mirando el reloj.
    const recovery = bob.stamp({ type: 'TIMEOUT', playerId: 'carol' });
    bob.receive(recovery);
    alice.receive(recovery);

    // …y regenera el testigo con un `seq` mayor, entregándolo a quien le toca ahora.
    const regenerated = bob.token.regenerate(bob.turnOwner);
    alice.token.receive(regenerated);

    expect(alice.hash).not.toBe(frozen); // la partida avanzó
    expect(alice.hash).toBe(bob.hash); // y los supervivientes siguen convergidos
    expect(alice.turnOwner).not.toBe('carol'); // el turno ya no está atrapado en el nodo caído
    expect(alice.token.holder).toBe(alice.turnOwner);

    // --- El testigo viejo de Carol es un fantasma --------------------------------------------
    // Si Carol resucita y anuncia el testigo que tenía (seq 9), nadie debe hacerle caso: el
    // testigo vigente nació con un seq mayor. Esto es lo que evita tener dos jugadores habilitados.
    expect(alice.token.receive({ seq: 9, holder: 'carol' })).toBe(false);
    expect(alice.token.holder).toBe(alice.turnOwner);

    // --- CAROL VUELVE ------------------------------------------------------------------------
    // No le mandamos el estado: le mandamos el LOG (el snapshot es la receta, no el plato). Ella
    // lo aplica con su propio motor y llega, sola, exactamente al mismo estado que los demás.
    carol.replica.deliverAll([...bob.replica.events]);
    carol.token.receive(bob.token.snapshot());

    expect(carol.hash).toBe(bob.hash);
    expect(carol.hash).toBe(alice.hash);
    expect(carol.token.holder).toBe(bob.token.holder);
    expect(carol.token.held()).toBe(false); // vuelve a la mesa, pero no le toca a ella
  });

  it('un TIMEOUT contra quien no está en turno lo rechaza el motor, en todos los nodos por igual', () => {
    // El líder no es una autoridad: es un coordinador. Si se equivoca (o si un nodo malicioso se
    // hace pasar por líder) e intenta castigar a quien NO está en turno, el reductor lo rechaza —
    // y lo rechaza igual en todos los nodos, porque es puro y determinista. Sin esto, "el líder"
    // sería el nombre elegante de "el que hace trampas".
    const initial = createGame(SEED, PLAYERS);
    const owner = initial.players[initial.turn]!.id;
    const victim = PLAYERS.find((p) => p.id !== owner)!.id;

    const alice = new Node('alice', owner);
    const bob = new Node('bob', owner);

    const abusive = bob.stamp({ type: 'TIMEOUT', playerId: victim }); // no es su turno
    const before = alice.hash;
    alice.receive(abusive);
    bob.receive(abusive);

    expect(alice.replica.rejectedCount).toBe(1);
    expect(bob.replica.rejectedCount).toBe(1);
    expect(alice.hash).toBe(before); // la partida no se movió
    expect(alice.hash).toBe(bob.hash); // y sigue habiendo convergencia
  });
});

import { describe, expect, it } from 'vitest';
import { apply, createGame, type GameEvent, type GameState } from '@bug/engine';
import { Replica, stateHash } from '../src/replica.js';
import { TurnToken } from '../src/token.js';
import type { Stamped } from '../src/lamport.js';

// Desconexión limpia (Fase 6), probada sobre la malla.
//
// La Fase 5 ya sostiene la partida cuando alguien DESAPARECE (deja de latir, el líder le salta el
// turno mientras tanto, y si vuelve, vuelve). Lo que se prueba aquí es lo otro: cuando alguien se
// DESPIDE. Es una diferencia de fondo, no de cortesía:
//
//   caída  → sospecha. Se le guarda el sitio; el líder le salta el turno cada ronda por si acaso.
//   adiós  → hecho. El motor lo saca de la rotación, en todos los nodos, para siempre.
//
// Por eso el adiós es un evento del MOTOR (`QUIT`) y no un mensaje de red: cambia las reglas de la
// mesa (a quién le toca, quién gana), así que tiene que aplicarse igual en todas las réplicas.

const PLAYERS = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'carol', name: 'Carol' },
];
const SEED = 4242;

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

function mesh() {
  const initial = createGame(SEED, PLAYERS);
  const first = initial.players[initial.turn]!.id;
  const nodes = PLAYERS.map((p) => new Node(p.id, first));
  const broadcast = (from: Node, event: GameEvent) => {
    const stamped = from.stamp(event);
    for (const n of nodes) n.receive(stamped);
    return stamped;
  };
  return { nodes, first, broadcast, node: (id: string) => nodes.find((n) => n.id === id)! };
}

describe('desconexión limpia: un jugador se despide', () => {
  it('la mesa lo saca de la rotación y los que quedan siguen convergidos', () => {
    const { nodes, broadcast, node } = mesh();
    const [alice, bob, carol] = nodes as [Node, Node, Node];

    // Bob cierra la pestaña: su navegador alcanza a lanzar el adiós antes de morir.
    broadcast(bob, { type: 'QUIT', playerId: 'bob' });

    // Todos los nodos aplican el mismo evento → todos llegan al mismo estado. Nadie tuvo que
    // mandarle a nadie una foto de la partida.
    expect(alice.hash).toBe(carol.hash);
    expect(alice.replica.state.players.find((p) => p.id === 'bob')!.status).toBe('down');

    // Y el turno ya no vuelve a pararse en él: la rotación lo ignora, ronda tras ronda.
    for (let i = 0; i < 6 && !alice.replica.state.finished; i++) {
      const owner = alice.turnOwner;
      expect(owner).not.toBe('bob');
      broadcast(node(owner), { type: 'DRAW', playerId: owner });
      if (alice.turnOwner === owner) broadcast(node(owner), { type: 'PASS', playerId: owner });
    }
    expect(alice.hash).toBe(carol.hash);
  });

  it('nadie puede echar a nadie: el adiós solo vale si lo firma el que se va', () => {
    // El anti-spoof de la Fase 4 (un peer solo emite eventos en su propio nombre) es lo que impide
    // que un jugador expulse a otro de la partida. La única excepción documentada —el PASS que el
    // líder emite por un caído— no cubre el QUIT, y es deliberado: saltar un turno no le quita el
    // sitio a nadie; echarlo, sí.
    const { nodes } = mesh();
    const [alice, bob] = nodes as [Node, Node];

    const forged = alice.stamp({ type: 'QUIT', playerId: 'bob' }); // Alice intenta echar a Bob
    const actor = forged.event.type === 'QUIT' ? forged.event.playerId : '';

    expect(actor).not.toBe(forged.origin); // el filtro de red lo detecta y ni lo entrega
    expect(bob.replica.state.players.find((p) => p.id === 'bob')!.status).toBe('active');
  });

  it('si el que se va tenía el testigo, lo cede al salir', () => {
    const { nodes, first, broadcast, node } = mesh();
    const leaver = node(first); // el que abre la partida: tiene turno y testigo
    const others = nodes.filter((n) => n.id !== first);

    expect(leaver.token.held()).toBe(true);

    broadcast(leaver, { type: 'QUIT', playerId: first });

    // Al despedirse, el motor ya movió el turno; el que se va cede el testigo a quien le toca
    // ahora. Sin esto, el testigo se iría con él y la mesa tendría que esperar a que el líder lo
    // regenerase (que también funciona, pero cuesta unos segundos de partida congelada).
    const handover = leaver.token.passTo(leaver.turnOwner);
    expect(handover).not.toBeNull();
    for (const n of others) n.token.receive(handover!);

    const next = others[0]!;
    expect(next.token.holder).toBe(next.turnOwner);
    expect(next.turnOwner).not.toBe(first);
    expect(others[0]!.hash).toBe(others[1]!.hash);
  });

  it('quedarse solo gana la partida: no hay mesa contra nadie', () => {
    const { nodes, broadcast } = mesh();
    const [alice, bob, carol] = nodes as [Node, Node, Node];

    broadcast(bob, { type: 'QUIT', playerId: 'bob' });
    broadcast(carol, { type: 'QUIT', playerId: 'carol' });

    for (const n of nodes) {
      expect(n.replica.state.finished).toBe(true);
      expect(n.replica.state.winner).toBe('alice');
    }
    expect(alice.hash).toBe(bob.hash); // hasta los que se fueron acaban en el mismo estado
  });

  it('un adiós repetido no descuadra a nadie (la malla reenvía)', () => {
    // Los mensajes se duplican: un nodo puede recibir el mismo QUIT por dos caminos, o volver a
    // verlo en el log que le manda otro al reconectarse. Si el segundo cambiara algo, dos nodos
    // que recibieron distinto número de copias dejarían de converger — y ahí se acaba el diseño.
    const { nodes, broadcast, node } = mesh();
    const [alice, bob, carol] = nodes as [Node, Node, Node];

    const goodbye = broadcast(bob, { type: 'QUIT', playerId: 'bob' });
    const afterOnce = alice.hash;

    carol.receive(goodbye); // reenvío: mismo evento, mismo sello
    node('alice').receive(goodbye);

    expect(alice.hash).toBe(afterOnce);
    expect(carol.hash).toBe(afterOnce);
  });
});

import { describe, expect, it } from 'vitest';
import { apply, createGame, type GameEvent, type GameState } from '@bug/engine';
import { Replica, stateHash } from '../src/replica.js';
import { TurnToken } from '../src/token.js';
import type { Stamped } from '../src/lamport.js';

// Reparación de una divergencia.
//
// El diseño converge MIENTRAS todos reciban los mismos eventos. Eso es cierto y está probado
// (`replication.test.ts`). Lo que no dice ese teorema es qué pasa cuando un nodo se pierde un
// evento y ya no se lo va a mandar nadie: se queda con OTRA partida en la cabeza, para siempre. Ve
// otro turno, otras manos, y no puede jugar. Ocurrió de verdad, en móviles que se suspenden.
//
// Pedir "los eventos que me faltan" no lo arregla: mi log no solo puede tener huecos, puede tener
// de más. La única salida es tirar la historia propia y adoptar la ajena entera.

const PLAYERS = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'carol', name: 'Carol' },
];
const SEED = 31415;

const nueva = () =>
  new Replica<GameState, GameEvent>({ initial: createGame(SEED, PLAYERS), apply });

/** Un evento sellado, para poblar logs a mano. */
const ev = (lamport: number, origin: string, event: GameEvent): Stamped<GameEvent> => ({
  lamport,
  origin,
  event,
});

describe('un nodo que se desvía', () => {
  it('se queda con otra partida: perder UN evento basta', () => {
    const sana = nueva();
    const desviada = nueva();

    const inicial = createGame(SEED, PLAYERS);
    const primero = inicial.players[inicial.turn]!.id;

    const jugada = ev(1, primero, { type: 'DRAW', playerId: primero });
    sana.deliver(jugada);
    // La desviada nunca lo recibe (se suspendió el móvil, se perdió el mensaje…).

    expect(stateHash(desviada.state)).not.toBe(stateHash(sana.state));
  });

  it('adoptar la historia ajena la devuelve a la partida', () => {
    const sana = nueva();
    const desviada = nueva();

    const inicial = createGame(SEED, PLAYERS);
    const primero = inicial.players[inicial.turn]!.id;
    const jugada = ev(1, primero, { type: 'DRAW', playerId: primero });
    sana.deliver(jugada);

    desviada.adopt(sana.events);

    expect(stateHash(desviada.state)).toBe(stateHash(sana.state));
    expect(desviada.events).toHaveLength(sana.events.length);
  });

  it('funciona aunque el desviado tenga eventos DE MÁS (no solo huecos)', () => {
    // Este es el caso que `deliverAll` no puede arreglar ni queriendo: completar el log no borra
    // lo que sobra. Un nodo con un evento fantasma —uno que emitió y que nadie más aceptó— seguiría
    // en su propia partida por muchos eventos que le manden.
    const sana = nueva();
    const desviada = nueva();

    const inicial = createGame(SEED, PLAYERS);
    const primero = inicial.players[inicial.turn]!.id;
    const otro = PLAYERS.find((p) => p.id !== primero)!.id;

    sana.deliver(ev(1, primero, { type: 'DRAW', playerId: primero }));

    // La desviada tiene un evento que la sana no tiene, y le falta el de la sana.
    desviada.deliver(ev(1, otro, { type: 'SHOUT_BUG', playerId: otro }));
    expect(stateHash(desviada.state)).not.toBe(stateHash(sana.state));

    // Completar el log NO basta: el fantasma sigue ahí.
    desviada.deliverAll(sana.events);
    expect(stateHash(desviada.state)).not.toBe(stateHash(sana.state));

    // Adoptar sí: se tira la historia propia entera.
    desviada.adopt(sana.events);
    expect(stateHash(desviada.state)).toBe(stateHash(sana.state));
  });

  it('tras adoptar, sigue jugando con normalidad (no queda tocada)', () => {
    const sana = nueva();
    const desviada = nueva();

    const inicial = createGame(SEED, PLAYERS);
    const primero = inicial.players[inicial.turn]!.id;

    sana.deliver(ev(1, primero, { type: 'DRAW', playerId: primero }));
    desviada.adopt(sana.events);

    // Una jugada nueva, entregada a las dos: siguen convergiendo.
    const siguiente = ev(2, primero, { type: 'PASS', playerId: primero });
    sana.deliver(siguiente);
    desviada.deliver(siguiente);

    expect(stateHash(desviada.state)).toBe(stateHash(sana.state));
  });
});

describe('el testigo, tras adoptar otra partida', () => {
  it('se acepta aunque su `seq` sea menor que el mío', () => {
    // El que se desvió puede haber inflado su `seq` en la partida que acaba de tirar. Compararlo
    // con el del resto no significa nada: viene de una historia que ya no existe. El testigo llega
    // CON la partida que se adopta, o el nodo se quedaría empuñando el de un mundo paralelo.
    const token = new TurnToken('carol', 'carol', 9); // seq alto, de su historia desviada

    expect(token.receive({ seq: 3, holder: 'alice' })).toBe(false); // regla normal: es historia vieja
    expect(token.holder).toBe('carol');

    expect(token.receive({ seq: 3, holder: 'alice' }, { force: true })).toBe(true);
    expect(token.holder).toBe('alice');
    expect(token.held()).toBe(false); // y deja de creerse en turno
  });
});

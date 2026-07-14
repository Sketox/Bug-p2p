import { describe, it, expect } from 'vitest';
import { apply } from '../src/index.js';
import { c, player, makeState } from './helpers.js';

// Abandono explícito (Fase 6). A diferencia de una caída —que es una sospecha de la malla y se
// resuelve saltando turnos mientras el jugador puede volver— el QUIT es un hecho que el propio
// jugador anuncia: cambia las reglas de la mesa, así que lo aplica el motor y converge en todos.

describe('QUIT — abandono', () => {
  it('marca al jugador como caído y devuelve su mano al mazo', () => {
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [c('number', 'code', 2), c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
    });
    const before = state.drawPile.length;

    const next = apply(state, { type: 'QUIT', playerId: 'b' });

    const b = next.players.find((p) => p.id === 'b')!;
    expect(b.status).toBe('down');
    expect(b.hand).toHaveLength(0);
    expect(next.drawPile).toHaveLength(before + 2); // sus 2 cartas vuelven a la partida
    expect(next.finished).toBe(false);
  });

  it('si abandona el que estaba en turno, la mesa no se congela', () => {
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [c('number', 'code', 2)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 1,
    });

    const next = apply(state, { type: 'QUIT', playerId: 'b' });

    expect(next.players[next.turn]!.id).toBe('c');
  });

  it('el turno salta al ausente para siempre (no hay que rescatarlo cada ronda)', () => {
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1), c('number', 'code', 5)]),
        player('b', [c('number', 'code', 2)]),
        player('c', [c('number', 'code', 4), c('number', 'code', 6)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
      drewThisTurn: true, // 'a' ya robó: puede pasar (si no, el motor se lo impediría)
    });

    const afterQuit = apply(state, { type: 'QUIT', playerId: 'b' });
    // 'a' sigue en turno: el que se fue no era él.
    expect(afterQuit.players[afterQuit.turn]!.id).toBe('a');

    const afterPass = apply(afterQuit, { type: 'PASS', playerId: 'a' });
    expect(afterPass.players[afterPass.turn]!.id).toBe('c'); // 'b' ya no cuenta
  });

  it('quedarse solo en la mesa gana la partida por abandono', () => {
    const state = makeState({
      players: [player('a', [c('number', 'code', 1)]), player('b', [c('number', 'code', 2)])],
      top: c('number', 'code', 9),
    });

    const next = apply(state, { type: 'QUIT', playerId: 'b' });

    expect(next.finished).toBe(true);
    expect(next.winner).toBe('a');
  });

  it('es idempotente: el mismo abandono dos veces deja el estado igual', () => {
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [c('number', 'code', 2)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
    });

    const once = apply(state, { type: 'QUIT', playerId: 'b' });
    const twice = apply(once, { type: 'QUIT', playerId: 'b' });

    // El `seq` avanza (se aplicó un evento), pero la mesa es idéntica: ni cartas duplicadas al
    // mazo ni turnos saltados de más. Es lo que garantiza que dos nodos que recibieron el QUIT un
    // número distinto de veces sigan convergiendo al mismo estado.
    expect({ ...twice, seq: 0 }).toEqual({ ...once, seq: 0 });
  });

  it('el Derrame de Café no le pasa la mano a quien ya abandonó', () => {
    const spill = c('coffee_spill', 'code');
    const cardOfA = c('number', 'code', 1);
    const cardOfC = c('number', 'code', 4);
    const state = makeState({
      players: [
        player('a', [spill, cardOfA]),
        player('b', [c('number', 'code', 2)]),
        player('c', [cardOfC]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
    });

    const afterQuit = apply(state, { type: 'QUIT', playerId: 'b' });
    const next = apply(afterQuit, { type: 'PLAY', playerId: 'a', cardId: spill.id });

    const hand = (id: string) => next.players.find((p) => p.id === id)!.hand.map((x) => x.id);
    expect(hand('b')).toEqual([]); // el ausente sigue fuera: no recibe cartas
    // Las manos circulan solo entre los que quedan en la mesa: la de 'a' va a 'c' y la de 'c' a 'a'.
    expect(hand('c')).toEqual([cardOfA.id]);
    expect(hand('a')).toEqual([cardOfC.id]);
  });

  it('el Troyano no puede infectar a un ausente', () => {
    const trojan = c('trojan', 'code');
    const state = makeState({
      players: [
        player('a', [trojan, c('number', 'code', 1), c('number', 'code', 5)]),
        player('b', [c('number', 'code', 2)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
    });

    const afterQuit = apply(state, { type: 'QUIT', playerId: 'b' });

    expect(() =>
      apply(afterQuit, {
        type: 'PLAY',
        playerId: 'a',
        cardId: trojan.id,
        target: 'b',
        giveCardIds: [afterQuit.players[0]!.hand[1]!.id],
      }),
    ).toThrow(/abandonó/);
  });
});

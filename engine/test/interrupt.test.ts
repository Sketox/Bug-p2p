import { describe, it, expect } from 'vitest';
import { apply } from '../src/index.js';
import { c, player, makeState } from './helpers.js';

// "Copiar y Pegar": la única carta que se juega FUERA de turno.
//
// Cortas la ronda, copias el efecto de la carta que acaba de caer al pozo, y la partida sigue
// desde ti. Es la carta que convierte el juego en un problema de concurrencia de verdad: dos
// jugadores pueden intentar actuar a la vez, y quien pierda la carrera se queda con la jugada
// rechazada — por el mismo motor determinista, igual en todos los nodos.

describe('Copiar y Pegar — interrupción fuera de turno', () => {
  it('se puede jugar aunque no sea tu turno, y la ronda sigue desde el que interrumpe', () => {
    const paste = c('copy_paste');
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1), c('number', 'code', 2)]),
        player('b', [paste, c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0, // le toca a 'a'
    });
    state.lastPlayer = 'a'; // 'a' acaba de poner la carta del pozo

    const next = apply(state, { type: 'PLAY', playerId: 'b', cardId: paste.id });

    // 'b' se coló sin ser su turno: la carta está en el pozo y el turno pasa al siguiente de 'b'.
    expect(next.discardPile[next.discardPile.length - 1]!.id).toBe(paste.id);
    expect(next.players[next.turn]!.id).toBe('c');
  });

  it('copia el efecto de la carta interrumpida: un +2 lo paga el siguiente al que interrumpe', () => {
    const paste = c('copy_paste');
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [paste, c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('draw2', 'code'), // 'a' acaba de soltar un "Update de Windows"
      turn: 0,
      drawPile: [c('number', 'internet', 7), c('number', 'internet', 8), c('number', 'code', 6)],
    });
    state.lastPlayer = 'a';

    const next = apply(state, { type: 'PLAY', playerId: 'b', cardId: paste.id });

    // El +2 se "pega" desde 'b': lo roba el siguiente de 'b', que es 'c'…
    expect(next.players.find((p) => p.id === 'c')!.hand).toHaveLength(3); // 1 + 2 robadas
    // …y 'c' pierde el turno, como con cualquier +2: vuelve a 'a'.
    expect(next.players[next.turn]!.id).toBe('a');
  });

  it('no puedes interrumpir tu propia jugada', () => {
    const paste = c('copy_paste');
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [paste, c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
    });
    state.lastPlayer = 'b'; // la carta del pozo la puso 'b'

    // Si se pudiera, bastaría con encadenar copias para no soltar nunca el turno.
    expect(() => apply(state, { type: 'PLAY', playerId: 'b', cardId: paste.id })).toThrow(
      /interrumpir tu propia/,
    );
  });

  it('el portapapeles no copia el caos: si el tope es una carta de caos, solo te cuelas', () => {
    // Copiar un troyano exigiría elegir víctima; copiar un "apagar y prender", una carta base. Una
    // interrupción tiene que resolverse sola, sin abrirle otra pregunta al que la sufre.
    const paste = c('copy_paste');
    const spill = c('coffee_spill');
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [paste, c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: spill,
      currentColor: 'code',
      turn: 0,
    });
    state.lastPlayer = 'a';

    const before = state.players.map((p) => p.hand.length);
    const after = apply(state, { type: 'PLAY', playerId: 'b', cardId: paste.id });

    // Las manos no rotaron (el derrame no se replicó): solo cambió la de 'b', que soltó la carta.
    expect(after.players.map((p) => p.hand.length)).toEqual([before[0], before[1]! - 1, before[2]]);
    expect(after.players[after.turn]!.id).toBe('c');
  });

  it('interrumpir con tu última carta gana la partida', () => {
    const paste = c('copy_paste');
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [paste]), // única carta
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
    });
    state.lastPlayer = 'a';

    const win = apply(state, { type: 'PLAY', playerId: 'b', cardId: paste.id });

    expect(win.finished).toBe(true);
    expect(win.winner).toBe('b');
  });

  it('el que se queda sin turno por una interrupción ve rechazada su jugada', () => {
    // Este es el caso que justifica todo el andamiaje: 'a' iba a jugar, pero 'b' interrumpió antes
    // (el log ordenó así los eventos concurrentes). La jugada de 'a' llega tarde y el motor la
    // rechaza — y la rechaza igual en todos los nodos, porque es puro y determinista.
    const paste = c('copy_paste');
    const cardOfA = c('number', 'code', 1);
    const state = makeState({
      players: [
        player('a', [cardOfA, c('number', 'code', 2)]),
        player('b', [paste, c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
    });
    state.lastPlayer = 'c';

    const interrupted = apply(state, { type: 'PLAY', playerId: 'b', cardId: paste.id });

    expect(() =>
      apply(interrupted, { type: 'PLAY', playerId: 'a', cardId: cardOfA.id }),
    ).toThrow(/No es tu turno/);
  });

  it('en tu propio turno sigue siendo un comodín normal (con su color)', () => {
    const paste = c('copy_paste');
    const state = makeState({
      players: [
        player('a', [paste, c('number', 'code', 1)]),
        player('b', [c('number', 'code', 3)]),
      ],
      top: c('number', 'hardware', 9),
      turn: 0,
    });

    const next = apply(state, {
      type: 'PLAY',
      playerId: 'a',
      cardId: paste.id,
      chosenColor: 'internet',
    });

    expect(next.currentColor).toBe('internet');
    expect(next.players[next.turn]!.id).toBe('b');
  });

  it('un ausente no puede interrumpir', () => {
    const paste = c('copy_paste');
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [paste, c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
    });
    state.lastPlayer = 'a';

    const gone = apply(state, { type: 'QUIT', playerId: 'b' });

    expect(() => apply(gone, { type: 'PLAY', playerId: 'b', cardId: paste.id })).toThrow(
      /No tienes esa carta|Ya no estás/,
    );
  });
});

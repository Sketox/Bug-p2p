import { describe, it, expect } from 'vitest';
import { apply } from '../src/index.js';
import { c, player, makeState } from './helpers.js';

// Las reglas del turno: robar deja de ser un capricho y el reloj corre.
//
//   · Si no tienes jugada, robar es tu obligación (no hay otra salida).
//   · No se pasa sin haber robado: pasar de gratis era la puerta trasera para esquivar el robo.
//   · Si se te acaba el tiempo sin hacer nada, robas 2 y pierdes el turno.
//
// El tiempo no lo mide el motor —es puro, no sabe qué hora es—: se lo cuenta el líder con un
// evento `TIMEOUT`, igual que el `PASS` de recuperación. El motor solo aplica la consecuencia, y la
// aplica igual en todos los nodos.

describe('no se pasa sin robar', () => {
  const mesa = (drew: boolean) =>
    makeState({
      players: [
        player('a', [c('number', 'internet', 1), c('number', 'internet', 2)]), // nada jugable
        player('b', [c('number', 'code', 3)]),
      ],
      top: c('number', 'code', 9),
      currentColor: 'code',
      turn: 0,
      drewThisTurn: drew,
    });

  it('pasar sin haber robado se rechaza', () => {
    expect(() => apply(mesa(false), { type: 'PASS', playerId: 'a' })).toThrow(/robar antes de pasar/);
  });

  it('tras robar, ya puedes pasar', () => {
    const next = apply(mesa(true), { type: 'PASS', playerId: 'a' });
    expect(next.players[next.turn]!.id).toBe('b');
  });

  it('robar marca el turno como "ya robado"', () => {
    // Se roba una carta que SÍ es jugable: el turno se queda contigo para que decidas, y ahora sí
    // tienes derecho a pasar.
    const state = makeState({
      players: [player('a', [c('number', 'internet', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      currentColor: 'code',
      turn: 0,
      drawPile: [c('number', 'code', 5)], // jugable
    });

    const afterDraw = apply(state, { type: 'DRAW', playerId: 'a' });

    expect(afterDraw.drewThisTurn).toBe(true);
    expect(afterDraw.players[afterDraw.turn]!.id).toBe('a'); // sigue siendo su turno
    expect(() => apply(afterDraw, { type: 'PASS', playerId: 'a' })).not.toThrow();
  });

  it('la marca se borra sola al cambiar el turno (no se hereda)', () => {
    // Si "ya robó" se quedara pegado, el siguiente jugador podría pasar sin robar — heredando un
    // derecho que no se ganó.
    const state = makeState({
      players: [player('a', [c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      currentColor: 'code',
      turn: 0,
      drewThisTurn: true,
    });

    const next = apply(state, { type: 'PASS', playerId: 'a' });

    expect(next.players[next.turn]!.id).toBe('b');
    expect(next.drewThisTurn).toBe(false);
    expect(() => apply(next, { type: 'PASS', playerId: 'b' })).toThrow(/robar antes de pasar/);
  });
});

describe('se acabó el tiempo', () => {
  it('robas 2 cartas de castigo y pierdes el turno', () => {
    const state = makeState({
      players: [
        player('a', [c('number', 'code', 1)]),
        player('b', [c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
      drawPile: [c('number', 'code', 5), c('number', 'internet', 3), c('number', 'code', 7)],
    });

    const next = apply(state, { type: 'TIMEOUT', playerId: 'a' });

    expect(next.players.find((p) => p.id === 'a')!.hand).toHaveLength(3); // 1 + 2 de castigo
    expect(next.players[next.turn]!.id).toBe('b');
    expect(next.drewThisTurn).toBe(false); // el siguiente empieza limpio
  });

  it('un TIMEOUT contra quien NO está en turno se rechaza', () => {
    // El líder es quien mira el reloj, pero no es una autoridad: si se equivoca (o si alguien se
    // hace pasar por él), el motor lo rechaza — y lo rechaza igual en todos los nodos.
    const state = makeState({
      players: [player('a', [c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      turn: 0,
    });

    expect(() => apply(state, { type: 'TIMEOUT', playerId: 'b' })).toThrow(/No es tu turno/);
  });
});

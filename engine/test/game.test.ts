import { describe, it, expect } from 'vitest';
import { createGame, canPlay, apply } from '../src/index.js';
import { c, player, makeState } from './helpers.js';

describe('createGame', () => {
  const players = [
    { id: 'a', name: 'Ana' },
    { id: 'b', name: 'Beto' },
    { id: 'd', name: 'Dina' },
  ];

  it('reparte 7 cartas a cada jugador', () => {
    const g = createGame(123, players);
    for (const p of g.players) expect(p.hand.length).toBe(7);
  });

  it('inicia el pozo con una carta numérica y fija el color', () => {
    const g = createGame(123, players);
    const top = g.discardPile[g.discardPile.length - 1]!;
    expect(top.kind).toBe('number');
    expect(g.currentColor).toBe(top.color);
  });

  it('es determinista: misma semilla → misma reparticón', () => {
    const g1 = createGame(999, players);
    const g2 = createGame(999, players);
    expect(g1.players.map((p) => p.hand.map((c) => c.id))).toEqual(
      g2.players.map((p) => p.hand.map((c) => c.id)),
    );
  });

  it('rechaza menos de 2 jugadores', () => {
    expect(() => createGame(1, [{ id: 'a', name: 'Ana' }])).toThrow(/2 jugadores/);
  });

  it('el que abre la partida sale de la semilla, no es siempre el primero de la lista', () => {
    // Antes empezaba `players[0]`, que es siempre el anfitrión: quien creaba la sala tenía la
    // primera jugada en TODAS las partidas.
    const quienEmpieza = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const g = createGame(seed, players);
      quienEmpieza.add(g.players[g.turn]!.id);
    }
    expect(quienEmpieza.size).toBeGreaterThan(1); // le toca a distintos, no siempre al mismo
  });

  it('…y aun así es el mismo en todos los nodos (misma semilla → mismo turno inicial)', () => {
    // Es la otra mitad de lo mismo: nadie "sortea" y se lo comunica al resto. Cada nodo llega al
    // mismo número por su cuenta, que es lo que permite que no haya árbitro.
    for (const seed of [1, 42, 777, 90210]) {
      expect(createGame(seed, players).turn).toBe(createGame(seed, players).turn);
    }
  });
});

describe('canPlay', () => {
  it('coincide por color', () => {
    const s = makeState({ players: [player('a', [])], top: c('number', 'code', 5) });
    expect(canPlay(s, c('skip', 'code'))).toBe(true);
  });
  it('coincide por número aunque cambie el color', () => {
    const s = makeState({ players: [player('a', [])], top: c('number', 'code', 5) });
    expect(canPlay(s, c('number', 'internet', 5))).toBe(true);
  });
  it('coincide por símbolo (skip sobre skip)', () => {
    const s = makeState({ players: [player('a', [])], top: c('skip', 'code') });
    expect(canPlay(s, c('skip', 'internet'))).toBe(true);
  });
  it('los comodines siempre se pueden jugar', () => {
    const s = makeState({ players: [player('a', [])], top: c('number', 'code', 5) });
    expect(canPlay(s, c('wild'))).toBe(true);
  });
  it('rechaza cartas que no coinciden', () => {
    const s = makeState({ players: [player('a', [])], top: c('number', 'code', 5) });
    expect(canPlay(s, c('number', 'internet', 3))).toBe(false);
  });
});

describe('jugar cartas (PLAY)', () => {
  it('juega una carta válida y pasa el turno', () => {
    const card = c('number', 'code', 7);
    const s = makeState({
      players: [player('a', [card, c('number', 'internet', 2)]), player('b', [])],
      top: c('number', 'code', 5),
    });
    const next = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id });
    expect(next.turn).toBe(1);
    expect(next.discardPile[next.discardPile.length - 1]!.id).toBe(card.id);
    expect(next.players[0]!.hand.length).toBe(1);
  });

  it('no muta el estado previo (pureza)', () => {
    const card = c('number', 'code', 7);
    const s = makeState({
      players: [player('a', [card]), player('b', [])],
      top: c('number', 'code', 5),
    });
    const snapshot = JSON.stringify(s);
    apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id });
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('rechaza jugar fuera de turno', () => {
    const card = c('number', 'code', 7);
    const s = makeState({
      players: [player('a', []), player('b', [card])],
      top: c('number', 'code', 5),
    });
    expect(() => apply(s, { type: 'PLAY', playerId: 'b', cardId: card.id })).toThrow(/turno/);
  });

  it('rechaza jugada ilegal', () => {
    const card = c('number', 'internet', 3);
    const s = makeState({
      players: [player('a', [card]), player('b', [])],
      top: c('number', 'code', 5),
    });
    expect(() => apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id })).toThrow(/coincide/);
  });
});

describe('efectos de especiales', () => {
  it('skip salta al siguiente jugador', () => {
    const card = c('skip', 'code');
    const s = makeState({
      players: [player('a', [card, c('number', 'code', 1)]), player('b', []), player('d', [])],
      top: c('skip', 'code'),
    });
    const next = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id });
    expect(next.turn).toBe(2); // saltó a 'b', le toca a 'd'
  });

  it('reverse invierte la dirección con 3+ jugadores', () => {
    const card = c('reverse', 'code');
    const s = makeState({
      players: [player('a', [card, c('number', 'code', 1)]), player('b', []), player('d', [])],
      top: c('reverse', 'code'),
    });
    const next = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id });
    expect(next.direction).toBe(-1);
    expect(next.turn).toBe(2); // hacia atrás desde 0 → 'd'
  });

  it('reverse actúa como skip con 2 jugadores', () => {
    const card = c('reverse', 'code');
    const s = makeState({
      players: [player('a', [card, c('number', 'code', 1)]), player('b', [])],
      top: c('reverse', 'code'),
    });
    const next = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id });
    expect(next.turn).toBe(0); // vuelve a 'a'
  });

  it('draw2: la víctima roba 2 y pierde el turno', () => {
    const card = c('draw2', 'code');
    const s = makeState({
      players: [player('a', [card, c('number', 'code', 1)]), player('b', []), player('d', [])],
      top: c('draw2', 'code'),
    });
    const next = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id });
    expect(next.players[1]!.hand.length).toBe(2);
    expect(next.turn).toBe(2); // 'b' castigado, juega 'd'
  });

  it('wild exige color y lo fija', () => {
    const card = c('wild');
    const s = makeState({
      players: [player('a', [card, c('number', 'code', 1)]), player('b', [])],
      top: c('number', 'code', 5),
    });
    expect(() => apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id })).toThrow(/color/);
    const next = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id, chosenColor: 'internet' });
    expect(next.currentColor).toBe('internet');
  });

  it('wild_draw4: la víctima roba 4 y es saltada', () => {
    const card = c('wild_draw4');
    const s = makeState({
      players: [player('a', [card, c('number', 'code', 1)]), player('b', []), player('d', [])],
      top: c('number', 'code', 5),
      drawPile: [
        c('number', 'code', 1),
        c('number', 'code', 2),
        c('number', 'code', 3),
        c('number', 'code', 4),
      ],
    });
    const next = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id, chosenColor: 'code' });
    expect(next.players[1]!.hand.length).toBe(4);
    expect(next.turn).toBe(2);
  });
});

describe('robar y pasar', () => {
  it('DRAW roba una carta; si no es jugable pasa el turno', () => {
    const s = makeState({
      players: [player('a', [c('number', 'internet', 9)]), player('b', [])],
      top: c('number', 'code', 5),
      drawPile: [c('number', 'hardware', 8)], // no coincide con color code ni valor 5
    });
    const next = apply(s, { type: 'DRAW', playerId: 'a' });
    expect(next.players[0]!.hand.length).toBe(2);
    expect(next.turn).toBe(1);
  });

  it('DRAW mantiene el turno si la carta robada es jugable', () => {
    const s = makeState({
      players: [player('a', [c('number', 'internet', 9)]), player('b', [])],
      top: c('number', 'code', 5),
      drawPile: [c('number', 'code', 8)], // coincide por color
    });
    const next = apply(s, { type: 'DRAW', playerId: 'a' });
    expect(next.turn).toBe(0);
  });
});

describe('victoria', () => {
  it('gana quien descarta su última carta', () => {
    const card = c('number', 'code', 7);
    const s = makeState({
      players: [player('a', [card]), player('b', [])],
      top: c('number', 'code', 5),
    });
    const next = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id });
    expect(next.finished).toBe(true);
    expect(next.winner).toBe('a');
  });

  it('no se puede jugar tras terminar', () => {
    const card = c('number', 'code', 7);
    let s = makeState({
      players: [player('a', [card]), player('b', [c('number', 'code', 2)])],
      top: c('number', 'code', 5),
    });
    s = apply(s, { type: 'PLAY', playerId: 'a', cardId: card.id });
    expect(() => apply(s, { type: 'PLAY', playerId: 'b', cardId: 'x' })).toThrow(/terminó/);
  });
});

describe('regla ¡Bug!', () => {
  it('acusar a quien no gritó Bug con 1 carta lo penaliza con 2', () => {
    const s = makeState({
      players: [player('a', [c('number', 'code', 1)]), player('b', [])],
      top: c('number', 'code', 5),
      turn: 1,
    });
    // 'a' tiene 1 carta y no gritó Bug → penalización
    const next = apply(s, { type: 'CALL_BUG', accuserId: 'b', accusedId: 'a' });
    expect(next.players[0]!.hand.length).toBe(3);
  });

  it('si gritó Bug, no hay penalización', () => {
    let s = makeState({
      players: [player('a', [c('number', 'code', 1)]), player('b', [])],
      top: c('number', 'code', 5),
    });
    s = apply(s, { type: 'SHOUT_BUG', playerId: 'a' });
    expect(s.players[0]!.saidBug).toBe(true);
    const next = apply(s, { type: 'CALL_BUG', accuserId: 'b', accusedId: 'a' });
    expect(next.players[0]!.hand.length).toBe(1);
  });
});

describe('cartas de caos', () => {
  it('trojan entrega 2 cartas a otro jugador', () => {
    const trojan = c('trojan');
    const g1 = c('number', 'code', 1);
    const g2 = c('number', 'code', 2);
    const s = makeState({
      players: [player('a', [trojan, g1, g2]), player('b', []), player('d', [])],
      top: c('number', 'code', 5),
    });
    const next = apply(s, {
      type: 'PLAY',
      playerId: 'a',
      cardId: trojan.id,
      chosenColor: 'code',
      target: 'd',
      giveCardIds: [g1.id, g2.id],
    });
    expect(next.players[2]!.hand.length).toBe(2); // 'd' recibió 2
    expect(next.players[0]!.hand.length).toBe(0); // 'a' se quedó sin cartas... pero no ganó por trojan
    expect(next.turn).toBe(1);
  });

  it('coffee_spill hace que todos pasen su mano al siguiente', () => {
    const spill = c('coffee_spill');
    const aCards = [spill, c('number', 'code', 1)];
    const bCards = [c('number', 'internet', 2), c('number', 'internet', 3)];
    const dCards = [c('number', 'hardware', 4)];
    const s = makeState({
      players: [player('a', aCards), player('b', bCards), player('d', dCards)],
      top: c('number', 'code', 5),
    });
    const next = apply(s, {
      type: 'PLAY',
      playerId: 'a',
      cardId: spill.id,
      chosenColor: 'code',
    });
    // 'a' jugó el spill (le queda 1 carta), que pasa a 'b'; 'b'→'d'; 'd'→'a'
    expect(next.players[1]!.hand.length).toBe(1); // recibió la mano de 'a' (1 carta)
    expect(next.players[2]!.hand.length).toBe(2); // recibió la de 'b'
    expect(next.players[0]!.hand.length).toBe(1); // recibió la de 'd'
  });

  it('reboot con carta base coloca un nuevo tope y color', () => {
    const reboot = c('reboot');
    const base = c('number', 'internet', 8);
    const s = makeState({
      players: [player('a', [reboot, base, c('number', 'code', 1)]), player('b', [])],
      top: c('number', 'code', 5),
    });
    const next = apply(s, {
      type: 'PLAY',
      playerId: 'a',
      cardId: reboot.id,
      rebootCardId: base.id,
    });
    expect(next.currentColor).toBe('internet');
    expect(next.discardPile[next.discardPile.length - 1]!.id).toBe(base.id);
    expect(next.players[0]!.hand.length).toBe(1);
  });
});

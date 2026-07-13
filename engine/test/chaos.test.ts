import { describe, it, expect } from 'vitest';
import { apply } from '../src/index.js';
import { c, player, makeState } from './helpers.js';

// Las decisiones que ahora toma el jugador (a quién infecta, qué regala, qué carta pone de base)
// las revalida el motor. La UI solo evita ofrecer jugadas imposibles; si aun así llegara una, el
// motor la rechaza — y la rechaza igual en todos los nodos, que es lo único que importa.

describe('Virus Troyano — lo que el motor no deja hacer', () => {
  const setup = (extra = [] as ReturnType<typeof c>[]) => {
    const trojan = c('trojan');
    const mine = [c('number', 'code', 1), c('number', 'code', 2), ...extra];
    const state = makeState({
      players: [
        player('a', [trojan, ...mine]),
        player('b', [c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
    });
    return { state, trojan, mine };
  };

  it('no puedes infectarte a ti mismo', () => {
    const { state, trojan, mine } = setup();
    expect(() =>
      apply(state, {
        type: 'PLAY',
        playerId: 'a',
        cardId: trojan.id,
        chosenColor: 'code',
        target: 'a',
        giveCardIds: [mine[0]!.id],
      }),
    ).toThrow(/ti mismo/);
  });

  it('hay que elegir víctima', () => {
    const { state, trojan } = setup();
    expect(() =>
      apply(state, { type: 'PLAY', playerId: 'a', cardId: trojan.id, chosenColor: 'code' }),
    ).toThrow(/Elige a quién/);
  });

  it('no puedes regalar cartas que no tienes', () => {
    const { state, trojan } = setup();
    expect(() =>
      apply(state, {
        type: 'PLAY',
        playerId: 'a',
        cardId: trojan.id,
        chosenColor: 'code',
        target: 'b',
        giveCardIds: ['carta-que-no-existe'],
      }),
    ).toThrow(/No tienes esa carta/);
  });

  it('si el regalo te deja sin cartas, GANAS (y la mesa no se queda muerta)', () => {
    // El bug que apareció jugando una partida entera de verdad: con 3 cartas juegas el troyano
    // (te quedan 2) y regalas esas 2. La comprobación de victoria estaba solo justo después de
    // descartar, así que nadie miraba tu mano DESPUÉS del efecto: te quedabas con cero cartas, en
    // turno, sin nada que jugar. Ni ganabas ni podías seguir: la partida no terminaba nunca.
    const trojan = c('trojan');
    const dos = [c('number', 'code', 1), c('number', 'code', 2)];
    const state = makeState({
      players: [
        player('a', [trojan, ...dos]), // exactamente 3 cartas
        player('b', [c('number', 'code', 3)]),
        player('c', [c('number', 'code', 4)]),
      ],
      top: c('number', 'code', 9),
      turn: 0,
    });

    const next = apply(state, {
      type: 'PLAY',
      playerId: 'a',
      cardId: trojan.id,
      chosenColor: 'code',
      target: 'b',
      giveCardIds: dos.map((x) => x.id),
    });

    expect(next.players.find((p) => p.id === 'a')!.hand).toHaveLength(0);
    expect(next.finished).toBe(true);
    expect(next.winner).toBe('a');
  });

  it('regala como mucho 2, aunque mandes más', () => {
    // El motor corta en 2 (`giveCardIds.slice(0, 2)`): un cliente manipulado no puede vaciarse la
    // mano de golpe soltándole seis cartas a otro.
    const extra = [c('number', 'code', 5), c('number', 'code', 6)];
    const { state, trojan, mine } = setup(extra);

    const next = apply(state, {
      type: 'PLAY',
      playerId: 'a',
      cardId: trojan.id,
      chosenColor: 'code',
      target: 'b',
      giveCardIds: mine.map((x) => x.id), // intenta regalar las 4
    });

    expect(next.players.find((p) => p.id === 'b')!.hand).toHaveLength(1 + 2); // solo 2 llegaron
    expect(next.players.find((p) => p.id === 'a')!.hand).toHaveLength(4 - 2); // y solo 2 salieron
  });
});

describe('Apagar y volver a prender — la carta base', () => {
  it('la base fija el color, sin preguntar', () => {
    const reboot = c('reboot');
    const base = c('number', 'internet', 5);
    const state = makeState({
      players: [player('a', [reboot, base, c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      currentColor: 'code',
      turn: 0,
    });

    const next = apply(state, { type: 'PLAY', playerId: 'a', cardId: reboot.id, rebootCardId: base.id });

    expect(next.currentColor).toBe('internet'); // manda la carta, no el jugador
    expect(next.discardPile[next.discardPile.length - 1]!.id).toBe(base.id);
    expect(next.players[0]!.hand).toHaveLength(1); // soltó dos cartas de golpe
  });

  it('la base no puede ser un comodín (un pozo que arranca en comodín no dice a qué igualar)', () => {
    const reboot = c('reboot');
    const wild = c('wild');
    const state = makeState({
      players: [player('a', [reboot, wild, c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      turn: 0,
    });

    // Se rechaza por los dos caminos, y por motivos distintos: un comodín no tiene color con el que
    // fijar la partida (así que ni siquiera se sabe qué color quedaría)…
    expect(() =>
      apply(state, { type: 'PLAY', playerId: 'a', cardId: reboot.id, rebootCardId: wild.id }),
    ).toThrow(/color/);

    // …y aunque mandes un color a mano para sortear eso, la base sigue sin valer.
    expect(() =>
      apply(state, {
        type: 'PLAY',
        playerId: 'a',
        cardId: reboot.id,
        rebootCardId: wild.id,
        chosenColor: 'code',
      }),
    ).toThrow(/no puede ser especial/);
  });

  it('sin base y sin color elegido, no hay jugada', () => {
    const reboot = c('reboot');
    const state = makeState({
      players: [player('a', [reboot, c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      turn: 0,
    });

    expect(() => apply(state, { type: 'PLAY', playerId: 'a', cardId: reboot.id })).toThrow(/color/);
  });

  it('si la base era tu última carta, ganas', () => {
    const reboot = c('reboot');
    const base = c('number', 'internet', 5);
    const state = makeState({
      players: [player('a', [reboot, base]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      turn: 0,
    });

    const next = apply(state, { type: 'PLAY', playerId: 'a', cardId: reboot.id, rebootCardId: base.id });

    expect(next.finished).toBe(true);
    expect(next.winner).toBe('a');
  });
});

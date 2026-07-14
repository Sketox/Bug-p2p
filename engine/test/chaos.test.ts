import { describe, it, expect } from 'vitest';
import { apply, canPlayOn } from '../src/index.js';
import { c, player, makeState } from './helpers.js';

// Las decisiones que ahora toma el jugador (a quién infecta, qué regala, qué carta pone de base)
// las revalida el motor. La UI solo evita ofrecer jugadas imposibles; si aun así llegara una, el
// motor la rechaza — y la rechaza igual en todos los nodos, que es lo único que importa.
//
// Y desde que las de Caos tienen color, la primera validación es la de siempre: hay que igualar el
// pozo. Antes eran comodines encubiertos y caían sobre cualquier cosa.

describe('las cartas de Caos tienen color: hay que igualar', () => {
  it('una carta de Caos de otro color no se puede jugar', () => {
    const trojan = c('trojan', 'internet');
    const state = makeState({
      players: [player('a', [trojan, c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9), // el pozo va de verde; el troyano es morado
      turn: 0,
    });

    expect(() =>
      apply(state, { type: 'PLAY', playerId: 'a', cardId: trojan.id, target: 'b' }),
    ).toThrow(/no coincide/);
  });

  it('pero sí sobre su color, o sobre otra carta de su tipo', () => {
    const top = c('coffee_spill', 'internet');
    expect(canPlayOn(top, 'internet', c('trojan', 'internet'))).toBe(true); // mismo color
    expect(canPlayOn(top, 'internet', c('coffee_spill', 'code'))).toBe(true); // mismo tipo
    expect(canPlayOn(top, 'internet', c('trojan', 'code'))).toBe(false); // ni color ni tipo
  });
});

describe('Virus Troyano — lo que el motor no deja hacer', () => {
  const setup = (extra = [] as ReturnType<typeof c>[]) => {
    const trojan = c('trojan', 'code');
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
        target: 'a',
        giveCardIds: [mine[0]!.id],
      }),
    ).toThrow(/ti mismo/);
  });

  it('hay que elegir víctima', () => {
    const { state, trojan } = setup();
    expect(() => apply(state, { type: 'PLAY', playerId: 'a', cardId: trojan.id })).toThrow(
      /Elige a quién/,
    );
  });

  it('no puedes regalar cartas que no tienes', () => {
    const { state, trojan } = setup();
    expect(() =>
      apply(state, {
        type: 'PLAY',
        playerId: 'a',
        cardId: trojan.id,
        target: 'b',
        giveCardIds: ['carta-que-no-existe'],
      }),
    ).toThrow(/No tienes esa carta/);
  });

  it('la partida sigue con el color del troyano, sin preguntar', () => {
    const trojan = c('trojan', 'survival');
    const state = makeState({
      players: [
        player('a', [trojan, c('number', 'survival', 1), c('number', 'code', 2)]),
        player('b', [c('number', 'code', 3)]),
      ],
      top: c('trojan', 'code'), // se juega por tipo, no por color
      currentColor: 'code',
      turn: 0,
    });

    const next = apply(state, { type: 'PLAY', playerId: 'a', cardId: trojan.id, target: 'b' });

    expect(next.currentColor).toBe('survival'); // el color lo trae la carta
  });

  it('si el regalo te deja sin cartas, GANAS (y la mesa no se queda muerta)', () => {
    // El bug que apareció jugando una partida entera de verdad: con 3 cartas juegas el troyano
    // (te quedan 2) y regalas esas 2. La comprobación de victoria estaba solo justo después de
    // descartar, así que nadie miraba tu mano DESPUÉS del efecto: te quedabas con cero cartas, en
    // turno, sin nada que jugar. Ni ganabas ni podías seguir: la partida no terminaba nunca.
    const trojan = c('trojan', 'code');
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
      target: 'b',
      giveCardIds: mine.map((x) => x.id), // intenta regalar las 4
    });

    expect(next.players.find((p) => p.id === 'b')!.hand).toHaveLength(1 + 2); // solo 2 llegaron
    expect(next.players.find((p) => p.id === 'a')!.hand).toHaveLength(4 - 2); // y solo 2 salieron
  });
});

describe('Apagar y volver a prender — la carta base', () => {
  it('la base fija el color, sin preguntar', () => {
    const reboot = c('reboot', 'code');
    const base = c('number', 'internet', 5);
    const state = makeState({
      players: [player('a', [reboot, base, c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      currentColor: 'code',
      turn: 0,
    });

    const next = apply(state, { type: 'PLAY', playerId: 'a', cardId: reboot.id, rebootCardId: base.id });

    expect(next.currentColor).toBe('internet'); // manda la base, no el color del reinicio
    expect(next.discardPile[next.discardPile.length - 1]!.id).toBe(base.id);
    expect(next.players[0]!.hand).toHaveLength(1); // soltó dos cartas de golpe
  });

  it('sin base, la partida sigue con el color del propio reinicio', () => {
    // Antes esta carta era un comodín y aquí se exigía elegir color. Ahora trae el suyo: se juega
    // como cualquier otra y no hay nada que preguntar.
    const reboot = c('reboot', 'code');
    const state = makeState({
      players: [player('a', [reboot, c('number', 'internet', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      currentColor: 'code',
      turn: 0,
    });

    const next = apply(state, { type: 'PLAY', playerId: 'a', cardId: reboot.id });

    expect(next.currentColor).toBe('code');
    expect(next.turn).toBe(1);
  });

  it('la base no puede ser un comodín (un pozo que arranca en comodín no dice a qué igualar)', () => {
    const reboot = c('reboot', 'code');
    const wild = c('wild');
    const state = makeState({
      players: [player('a', [reboot, wild, c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      turn: 0,
    });

    expect(() =>
      apply(state, { type: 'PLAY', playerId: 'a', cardId: reboot.id, rebootCardId: wild.id }),
    ).toThrow(/no puede ser un comodín/);
  });

  it('la base tampoco puede ser una carta de Caos', () => {
    // Tiene color, así que ya "valdría" para fijar el pozo — pero colarla de base sería soltarla
    // sin que su efecto llegue a dispararse: una puerta de atrás para deshacerse del Troyano.
    const reboot = c('reboot', 'code');
    const trojan = c('trojan', 'internet');
    const state = makeState({
      players: [player('a', [reboot, trojan, c('number', 'code', 1)]), player('b', [c('number', 'code', 3)])],
      top: c('number', 'code', 9),
      turn: 0,
    });

    expect(() =>
      apply(state, { type: 'PLAY', playerId: 'a', cardId: reboot.id, rebootCardId: trojan.id }),
    ).toThrow(/carta de Caos/);
  });

  it('si la base era tu última carta, ganas', () => {
    const reboot = c('reboot', 'code');
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

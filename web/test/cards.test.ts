import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDeck } from '@bug/engine';
import { cardFace, needsPrompt } from '@/lib/cards';

// El puente entre el motor y el arte: cada carta que el mazo puede repartir tiene que tener su
// dibujo en el sprite.
//
// Si no lo tiene, no explota nada — se pinta un hueco. Una carta en blanco en mitad de la partida,
// en la feria, sin un solo error en la consola. Por eso se comprueba aquí y no se confía en que el
// generador y la UI se pongan de acuerdo solos: son dos ficheros distintos que hay que mantener en
// paso (`tools/build-sprite.js` y `lib/cards.ts`).

const sprite = readFileSync(join(process.cwd(), 'public', 'cards.svg'), 'utf8');
const SYMBOLS = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]!));

describe('sprite y mazo', () => {
  it('cada carta del mazo tiene su dibujo, con su color', () => {
    const faltan = buildDeck()
      .map((card) => cardFace(card).symbol)
      .filter((symbol) => !SYMBOLS.has(symbol));

    expect([...new Set(faltan)]).toEqual([]);
  });

  it('el reverso de las cartas y el logo también están', () => {
    expect(SYMBOLS.has('c-logo')).toBe(true);
  });

  it('los dos comodines son los únicos sin color en el dibujo', () => {
    const wilds = buildDeck().filter((c) => cardFace(c).isWild);
    expect(new Set(wilds.map((c) => c.kind))).toEqual(new Set(['wild', 'wild_draw4']));
    expect(new Set(wilds.map((c) => cardFace(c).symbol))).toEqual(
      new Set(['c-wild', 'c-wild_draw4']),
    );
  });
});

describe('qué se le pregunta al jugador', () => {
  it('solo los comodines (color), el troyano (víctima) y el reinicio (base)', () => {
    const pregunta = new Set(
      buildDeck()
        .filter((c) => needsPrompt(c))
        .map((c) => c.kind),
    );

    // El Derrame de Café y el Copiar y Pegar salían aquí cuando no tenían color: se paraba la
    // partida para preguntar un color que hoy trae la carta.
    expect(pregunta).toEqual(new Set(['wild', 'wild_draw4', 'trojan', 'reboot']));
  });
});

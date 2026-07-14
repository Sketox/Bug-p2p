import { describe, it, expect } from 'vitest';
import { buildDeck, COLORS, DECK_SIZE, makeRng, shuffle } from '../src/index.js';

describe('mazo', () => {
  it('tiene 124 cartas (29 por color + 8 comodines)', () => {
    const deck = buildDeck();
    expect(deck.length).toBe(DECK_SIZE);
    expect(deck.length).toBe(4 * 29 + 8);
  });

  it('tiene ids únicos', () => {
    const deck = buildDeck();
    const ids = new Set(deck.map((c) => c.id));
    expect(ids.size).toBe(deck.length);
  });

  it('composición por color y comodines', () => {
    const deck = buildDeck();
    const count = (fn: (k: string) => boolean) => deck.filter((c) => fn(c.kind)).length;
    expect(count((k) => k === 'number')).toBe(4 * 19); // 0 + dos de 1-9
    expect(count((k) => k === 'skip')).toBe(8);
    expect(count((k) => k === 'reverse')).toBe(8);
    expect(count((k) => k === 'draw2')).toBe(4); // un Update +2 por color
    expect(count((k) => k === 'draw4')).toBe(4); // un Update +4 por color
    expect(count((k) => k === 'wild')).toBe(4);
    expect(count((k) => k === 'wild_draw4')).toBe(4);
    // Las de Caos: una de cada color.
    expect(count((k) => k === 'copy_paste')).toBe(4);
    expect(count((k) => k === 'reboot')).toBe(4);
    expect(count((k) => k === 'coffee_spill')).toBe(4);
    expect(count((k) => k === 'trojan')).toBe(4);
  });

  // El arte pinta con las cuatro franjas justo a los dos comodines, y esa es la regla: solo lo que
  // no tiene palo se puede soltar sobre cualquier cosa. Si una carta de Caos volviera a quedarse
  // sin color, volvería a ser jugable siempre sin que nadie lo hubiera decidido.
  it('solo los comodines van sin color; el resto lleva el suyo', () => {
    const deck = buildDeck();
    const sinColor = deck.filter((c) => c.color == null);
    expect(sinColor).toHaveLength(8);
    expect(new Set(sinColor.map((c) => c.kind))).toEqual(new Set(['wild', 'wild_draw4']));

    for (const color of COLORS) {
      expect(deck.filter((c) => c.color === color)).toHaveLength(29);
    }
  });
});

describe('rng determinista', () => {
  it('misma semilla → misma baraja', () => {
    const a = shuffle(buildDeck(), makeRng(42)).map((c) => c.id);
    const b = shuffle(buildDeck(), makeRng(42)).map((c) => c.id);
    expect(a).toEqual(b);
  });

  it('semillas distintas → baraja distinta', () => {
    const a = shuffle(buildDeck(), makeRng(1)).map((c) => c.id);
    const b = shuffle(buildDeck(), makeRng(2)).map((c) => c.id);
    expect(a).not.toEqual(b);
  });
});

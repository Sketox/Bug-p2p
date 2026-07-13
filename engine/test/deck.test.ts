import { describe, it, expect } from 'vitest';
import { buildDeck, DECK_SIZE, makeRng, shuffle } from '../src/index.js';

describe('mazo', () => {
  it('tiene 122 cartas (108 estándar + 14 de caos)', () => {
    const deck = buildDeck();
    expect(deck.length).toBe(DECK_SIZE);
  });

  it('tiene ids únicos', () => {
    const deck = buildDeck();
    const ids = new Set(deck.map((c) => c.id));
    expect(ids.size).toBe(deck.length);
  });

  it('composición estándar por color y comodines', () => {
    const deck = buildDeck();
    const count = (fn: (k: string) => boolean) => deck.filter((c) => fn(c.kind)).length;
    expect(count((k) => k === 'number')).toBe(4 * 19); // 0 + dos de 1-9
    expect(count((k) => k === 'skip')).toBe(8);
    expect(count((k) => k === 'reverse')).toBe(8);
    expect(count((k) => k === 'draw2')).toBe(8);
    expect(count((k) => k === 'wild')).toBe(4);
    expect(count((k) => k === 'wild_draw4')).toBe(4);
    expect(count((k) => k === 'copy_paste')).toBe(4);
    expect(count((k) => k === 'reboot')).toBe(4);
    expect(count((k) => k === 'coffee_spill')).toBe(2);
    expect(count((k) => k === 'trojan')).toBe(4);
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

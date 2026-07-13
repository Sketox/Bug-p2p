// PRNG determinista (mulberry32). Dado un mismo `seed`, produce la MISMA secuencia en todos
// los nodos → el barajado es reproducible sin exponer el mazo. Base para el estado replicado.

export interface Rng {
  /** Siguiente flotante en [0, 1). */
  next(): number;
  /** Entero en [0, maxExclusive). */
  int(maxExclusive: number): number;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
  };
}

/** Baraja una copia del arreglo con Fisher-Yates determinista. No muta la entrada. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

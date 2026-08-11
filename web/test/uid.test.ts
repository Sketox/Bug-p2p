import { afterEach, describe, expect, it, vi } from 'vitest';
import { azar32, azarCodigo, uid } from '@/lib/uid';

// El bug que este archivo impide que vuelva:
//
// `crypto.randomUUID` **no existe** fuera de un contexto seguro. Y "contexto seguro" es HTTPS o
// `localhost` — no `http://192.168.1.42:7787`, que es exactamente cómo entran los invitados cuando
// el anfitrión reparte su IP local. El anfitrión veía su sala perfecta (él está en `localhost`) y
// sus invitados, una pantalla con "Application error" y ni una pista de por qué.
//
// Los tests corren en Node, donde `crypto.randomUUID` sí está siempre. Así que para probar el caso
// que importa hay que quitarlo a mano: es el único modo de reproducir un navegador por IP.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('identificadores únicos', () => {
  it('usa `crypto.randomUUID` cuando el navegador lo tiene', () => {
    expect(uid()).toMatch(UUID_V4);
  });

  it('sigue funcionando SIN `randomUUID` (la web servida por IP, sin HTTPS)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });

    const generado = uid();
    expect(generado).toMatch(UUID_V4); // y sigue siendo un UUID v4 en toda regla
  });

  it('no repite (mil seguidos, sin `randomUUID`)', () => {
    // Que no lance no basta: si el respaldo devolviera siempre lo mismo, dos jugadores compartirían
    // identidad y se pelearían por el mismo sitio en la mesa.
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });

    const vistos = new Set(Array.from({ length: 1000 }, () => uid()));
    expect(vistos.size).toBe(1000);
  });

  it('y aguanta un navegador sin `crypto` en absoluto', () => {
    vi.stubGlobal('crypto', undefined);

    const vistos = new Set(Array.from({ length: 200 }, () => uid()));
    expect(vistos.size).toBe(200);
    expect(uid().length).toBeGreaterThan(8);
  });
});

// El código de sala se sacaba de `Math.random`, que en V8 es un xorshift128+: viendo unas pocas
// salidas se reconstruye su estado y se predicen las siguientes. Y con el código de sala en la mano
// se puede interferir en una partida ajena (ataque S2). Ahora sale de `crypto`.
describe('azar para el código de sala', () => {
  it('da la longitud pedida y solo caracteres tecleables', () => {
    for (let i = 0; i < 200; i++) expect(azarCodigo(4)).toMatch(/^[0-9A-Z]{4}$/);
  });

  it('no repite: 2000 códigos dan casi 2000 distintos', () => {
    const vistos = new Set(Array.from({ length: 2000 }, () => azarCodigo(4)));
    // Con 36^4 = 1 679 616 posibles, el cumpleaños dice ~1,2 colisiones esperadas. Se deja holgura.
    expect(vistos.size).toBeGreaterThan(1990);
  });

  it('reparte sin sesgo: ningún carácter se lleva más del doble de lo que le toca', () => {
    const cuenta = new Map<string, number>();
    for (const c of azarCodigo(36 * 200)) cuenta.set(c, (cuenta.get(c) ?? 0) + 1);
    const esperado = 200;
    for (const n of cuenta.values()) expect(n).toBeLessThan(esperado * 2);
    expect(cuenta.size).toBe(36);
  });

  it('sigue dando números sin `getRandomValues` (navegador prehistórico)', () => {
    vi.stubGlobal('crypto', {});
    const v = azar32();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(0x1_0000_0000);
  });
});

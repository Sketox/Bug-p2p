import { afterEach, describe, expect, it, vi } from 'vitest';
import { uid } from '@/lib/uid';

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

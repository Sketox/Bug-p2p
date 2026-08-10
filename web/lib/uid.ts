// Identificadores únicos que funcionan TAMBIÉN fuera de un contexto seguro.
//
// `crypto.randomUUID()` solo existe en *secure contexts*: HTTPS, o `localhost`. En `http://` a secas
// —que es exactamente cómo entran los invitados cuando el anfitrión reparte su IP local,
// `http://192.168.1.42:7787`— el navegador **no define la función**. No es que devuelva algo pobre:
// no está.
//
// Y eso reventaba la web entera. El identificador de jugador se pedía con `crypto.randomUUID()`
// dentro de un `try`, y el `catch` —puesto para el modo privado, donde falla `sessionStorage`—
// volvía a llamar a `crypto.randomUUID()`. Así que en cuanto alguien abría el juego por IP, la
// segunda llamada lanzaba sin nadie que la recogiera y la página moría con un "Application error"
// de React, sin decir por qué. El anfitrión veía su sala perfecta en `localhost` y sus invitados
// una pantalla en blanco.
//
// `crypto.getRandomValues` sí está siempre (no requiere contexto seguro), así que el UUID se arma a
// mano cuando hace falta. El último recurso con `Math.random` es para navegadores prehistóricos: no
// sirve para criptografía, pero esto no es una clave — es un nombre que solo tiene que no repetirse.

/**
 * Un UUID v4. Usa `crypto.randomUUID` si existe, y si no lo construye con `getRandomValues`.
 *
 * Identifica jugadores y cargas de página —que viajan en claro por la señalización, así que de
 * secreto no tienen nada— **y además genera el `secret` de reconexión** desde que se corrigió el
 * ataque S3. Eso sube el listón: un secreto predecible no sería secreto, y el mecanismo que impide
 * echar a alguien de su propia partida volvería a estar abierto.
 *
 * Las dos primeras ramas lo cumplen: `randomUUID` y `getRandomValues` son criptográficamente
 * seguras. La tercera no —`Math.random` no lo es, y el análisis estático lo señala—, pero es
 * inalcanzable para cualquiera que pueda jugar: un navegador sin `crypto.getRandomValues` (anterior
 * a 2011) tampoco tiene `RTCPeerConnection`, así que no llega a entrar en una sala. Se deja como
 * último recurso para que la página no muera con una excepción, que es lo que hacía antes.
 */
export function uid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // versión 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 4122
    const hex = [...b].map((n) => n.toString(16).padStart(2, '0'));
    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10, 16).join(''),
    ].join('-');
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

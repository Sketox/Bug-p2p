import { describe, it, expect } from 'vitest';
import {
  Cubo,
  MAX_PAYLOAD,
  Repeticiones,
  huellaSenal,
  parseClientMsg,
} from '../src/guard.js';

// Las defensas del servidor, probadas sin levantar sockets. Cada bloque de aquí corresponde a un
// ataque del banco (`vv/security/attack-suite.mjs`): estos tests son la red que impide que la
// mitigación se caiga sin que nadie se entere, y corren en cada commit sin tardar tres minutos.

describe('parseClientMsg: nada entra sin comprobarse (ataque S8)', () => {
  it('acepta los cuatro mensajes del protocolo bien formados', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'join', room: 'AB12', peerId: 'p1', name: 'Ana' })))
      .toEqual({ t: 'join', room: 'AB12', peerId: 'p1', name: 'Ana', epoch: undefined, secret: undefined });

    expect(
      parseClientMsg(
        JSON.stringify({ t: 'signal', room: 'AB12', from: 'p1', to: 'p2', data: { kind: 'offer' } }),
      ),
    ).toEqual({ t: 'signal', room: 'AB12', from: 'p1', to: 'p2', data: { kind: 'offer' } });

    expect(
      parseClientMsg(JSON.stringify({ t: 'introduce', room: 'AB12', peerId: 'p1', tried: ['p2'] })),
    ).toEqual({ t: 'introduce', room: 'AB12', peerId: 'p1', tried: ['p2'] });

    expect(parseClientMsg(JSON.stringify({ t: 'leave', room: 'AB12', peerId: 'p1' }))).toEqual({
      t: 'leave',
      room: 'AB12',
      peerId: 'p1',
    });
  });

  it('rechaza el mensaje que tumbaba el proceso: `tried` que no es una lista', () => {
    // Este es EL caso. El servidor hacía `new Set([peerId, ...msg.tried])`, y desparramar un
    // número lanza una excepción que, dentro de un manejador de eventos de Node, se lleva por
    // delante el proceso entero. Un jugador tumbaba la señalización de toda la sala desde la
    // consola del navegador.
    expect(parseClientMsg(JSON.stringify({ t: 'introduce', room: 'A', peerId: 'p', tried: 7 }))).toBeNull();
    expect(
      parseClientMsg(JSON.stringify({ t: 'introduce', room: 'A', peerId: 'p', tried: [1, 2] })),
    ).toBeNull();
  });

  it('rechaza JSON inválido, valores sueltos y tipos que no tocan', () => {
    for (const basura of [
      '{ no es json',
      '[]',
      'null',
      '"cadena"',
      '42',
      JSON.stringify({ t: 'inventado' }),
      JSON.stringify({ t: 'join' }),
      JSON.stringify({ t: 'join', room: {}, peerId: 42, name: [] }),
      JSON.stringify({ t: 'signal', room: 'A', from: null, to: 'b', data: {} }),
      JSON.stringify({ t: 'signal', room: 'A', from: 'a', to: 'b', data: 'texto' }),
    ]) {
      expect(parseClientMsg(basura), basura).toBeNull();
    }
  });

  it('rechaza campos desmesurados sin necesidad de mirar su contenido', () => {
    const largo = 'x'.repeat(500);
    expect(parseClientMsg(JSON.stringify({ t: 'join', room: largo, peerId: 'p', name: 'n' }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'join', room: 'A', peerId: largo, name: 'n' }))).toBeNull();
    expect(
      parseClientMsg(
        JSON.stringify({ t: 'introduce', room: 'A', peerId: 'p', tried: Array(100).fill('x') }),
      ),
    ).toBeNull();
  });

  it('deja pasar `data` opaco: aquí no se interpreta SDP', () => {
    const raro = { kind: 'lo-que-sea', anidado: { profundo: [1, 2, 3] } };
    const msg = parseClientMsg(JSON.stringify({ t: 'signal', room: 'A', from: 'a', to: 'b', data: raro }));
    expect(msg).not.toBeNull();
    expect((msg as { data: unknown }).data).toEqual(raro);
  });

  it('el tope de tamaño deja sitio de sobra para una señal real', () => {
    // Una oferta SDP con sus candidatos ronda los 2-4 KB.
    expect(MAX_PAYLOAD).toBeGreaterThan(16 * 1024);
  });
});

describe('Cubo: límite de ritmo con ráfaga (ataque S5)', () => {
  it('admite la ráfaga de entrada a una sala y luego corta el ritmo sostenido', () => {
    let t = 1_000_000;
    const cubo = new Cubo(120, 40, t);
    // Entrar a una sala son varios mensajes de golpe (join y la tanda de candidatos ICE).
    for (let i = 0; i < 120; i++) expect(cubo.admite(t), `mensaje ${i}`).toBe(true);
    expect(cubo.admite(t)).toBe(false);
  });

  it('se rellena con el tiempo: un cliente normal nunca lo nota', () => {
    let t = 1_000_000;
    const cubo = new Cubo(120, 40, t);
    for (let i = 0; i < 120; i++) cubo.admite(t);
    expect(cubo.admite(t)).toBe(false);
    t += 1000; // un segundo después hay 40 fichas nuevas
    for (let i = 0; i < 40; i++) expect(cubo.admite(t)).toBe(true);
    expect(cubo.admite(t)).toBe(false);
  });

  it('no acumula más allá de su capacidad', () => {
    let t = 1_000_000;
    const cubo = new Cubo(120, 40, t);
    t += 60_000; // un minuto parado
    for (let i = 0; i < 120; i++) expect(cubo.admite(t)).toBe(true);
    expect(cubo.admite(t)).toBe(false);
  });
});

describe('Repeticiones: la misma señal dos veces (ataque S4)', () => {
  it('descarta la repetición exacta dentro de la ventana', () => {
    const r = new Repeticiones(5000);
    const clave = huellaSenal('a', 'b', { kind: 'offer', sdp: 'v=0' });
    expect(r.repetida(clave, 1000)).toBe(false);
    expect(r.repetida(clave, 1100)).toBe(true);
    expect(r.repetida(clave, 5900)).toBe(true);
  });

  it('deja pasar la misma señal cuando ya pasó la ventana', () => {
    const r = new Repeticiones(5000);
    const clave = huellaSenal('a', 'b', { kind: 'offer', sdp: 'v=0' });
    expect(r.repetida(clave, 1000)).toBe(false);
    expect(r.repetida(clave, 6001)).toBe(false);
  });

  it('no confunde señales distintas: cada candidato ICE es uno nuevo', () => {
    const r = new Repeticiones();
    expect(r.repetida(huellaSenal('a', 'b', { c: 1 }), 1000)).toBe(false);
    expect(r.repetida(huellaSenal('a', 'b', { c: 2 }), 1000)).toBe(false);
    expect(r.repetida(huellaSenal('a', 'c', { c: 1 }), 1000)).toBe(false);
    expect(r.repetida(huellaSenal('b', 'a', { c: 1 }), 1000)).toBe(false);
  });
});

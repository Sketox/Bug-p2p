import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MAX_PLAYERS } from '@bug/engine';
import type { ServerMsg } from '../src/protocol.js';

// El aforo de una sala, probado contra el servidor DE VERDAD (no un doble).
//
// Aquí es donde tiene que probarse, porque aquí es donde se decide: si cada navegador contase por su
// cuenta cuánta gente hay, dos personas entrando a la vez verían nueve sitios libres y pasarían las
// dos. El servidor atiende los `join` de uno en uno, y por eso es el único que puede contar.
//
// Antes de esto, al jugador 11 no lo paraba nadie: entraba a la sala, salía en la lista, y el fallo
// no se descubría hasta que el anfitrión pulsaba "¡Empezar!" y el motor le tiraba un
// TOO_MANY_PLAYERS a la cara.

process.env.PORT = '0'; // que el sistema elija un puerto libre: los tests no pelean por el 8787
const { AFORO, httpServer } = await import('../src/server.js');

const url = () => {
  const dir = httpServer.address();
  if (!dir || typeof dir === 'string') throw new Error('el servidor no está escuchando');
  return `ws://127.0.0.1:${dir.port}`;
};

/** Abre un WebSocket y hace `join`; resuelve con el primer mensaje que conteste el servidor. */
function entrar(peerId: string, room = 'sala'): Promise<{ ws: WebSocket; primero: ServerMsg }> {
  return new Promise((ok, mal) => {
    const ws = new WebSocket(url());
    ws.once('error', mal);
    ws.once('open', () => ws.send(JSON.stringify({ t: 'join', room, peerId, name: peerId })));
    ws.once('message', (raw) => ok({ ws, primero: JSON.parse(String(raw)) as ServerMsg }));
    setTimeout(() => mal(new Error(`${peerId} no recibió respuesta`)), 5000);
  });
}

const abiertos: WebSocket[] = [];
const entrarYRecordar = async (peerId: string, room?: string) => {
  const r = await entrar(peerId, room);
  abiertos.push(r.ws);
  return r;
};

beforeAll(async () => {
  // `listen` es asíncrono: sin esto, el primer test correría contra un servidor todavía sin puerto.
  if (!httpServer.listening) await new Promise((ok) => httpServer.once('listening', ok));
});

afterAll(async () => {
  for (const ws of abiertos) ws.close();
  await new Promise((ok) => httpServer.close(ok));
});

describe('aforo de la sala', () => {
  it('cabe la misma gente que en una partida (las dos copias del número, atadas)', () => {
    // El servidor no importa el motor a propósito (no sabe qué es una carta, y así se despliega
    // solo), así que el número vive duplicado. Este test es lo que impide que las copias se separen.
    expect(AFORO).toBe(MAX_PLAYERS);
  });

  it(`deja entrar a ${MAX_PLAYERS} y rebota al siguiente`, async () => {
    const sala = 'llena';
    for (let i = 0; i < AFORO; i++) {
      const { primero } = await entrarYRecordar(`p${i}`, sala);
      expect(primero.t).toBe('peers'); // los que caben reciben el censo
    }

    const { primero } = await entrarYRecordar('el-que-sobra', sala);
    expect(primero).toEqual({ t: 'room-full', max: AFORO });
  });

  it('al rebotado le cierran la puerta: no se queda dentro a medias', async () => {
    const sala = 'cierre';
    for (let i = 0; i < AFORO; i++) await entrarYRecordar(`q${i}`, sala);

    const { ws } = await entrarYRecordar('sobra', sala);
    await new Promise((ok) => (ws.readyState === WebSocket.CLOSED ? ok(null) : ws.once('close', ok)));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('quien YA estaba dentro puede volver aunque la sala esté llena', async () => {
    // El caso que de verdad importa, y el fácil de romper: un jugador de la partida recarga la
    // página o se le va el WiFi un momento. Vuelve con su mismo peerId. Si el aforo lo tratara como
    // uno nuevo, lo echaría de su propio juego — y encima "por sala llena", cuando una de esas diez
    // plazas es la suya.
    const sala = 'vuelve';
    for (let i = 0; i < AFORO; i++) await entrarYRecordar(`r${i}`, sala);

    const { primero } = await entrarYRecordar('r3', sala); // r3 vuelve: mismo peerId
    expect(primero.t).toBe('peers');
    expect(primero).not.toEqual(expect.objectContaining({ t: 'room-full' }));
  });

  it('el aforo es por sala, no del servidor entero', async () => {
    for (let i = 0; i < AFORO; i++) await entrarYRecordar(`s${i}`, 'una');

    const { primero } = await entrarYRecordar('recien-llegado', 'otra');
    expect(primero.t).toBe('peers'); // otra sala, otra mesa: entra sin problema
  });
});

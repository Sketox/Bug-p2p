import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { PeerInfo, ServerMsg } from '../src/protocol.js';

// Lo que el servidor hace AHORA cuando llega alguien, probado contra el servidor de verdad.
//
// Antes repartía el censo entero y reenviaba un handshake con cada jugador de la sala. Ahora
// presenta a UNO —el introductor— y se aparta: los otros N-1 handshakes viajan por la malla, entre
// navegadores (eso se prueba en `net/test/mesh-signaling.test.ts`, que es donde vive esa lógica).
//
// Aquí se prueba la mitad que le toca al servidor, que son tres cosas concretas: que presenta a uno
// y no a todos, que avisa solo al introductor, y que sabe dar otro cuando el primero no sirve.

process.env.PORT = '0'; // que el sistema elija un puerto libre: los tests no pelean por el 8787
const { httpServer } = await import('../src/server.js');

const url = () => {
  const dir = httpServer.address();
  if (!dir || typeof dir === 'string') throw new Error('el servidor no está escuchando');
  return `ws://127.0.0.1:${dir.port}`;
};

const abiertos: WebSocket[] = [];

/**
 * Un cliente de señalización que apunta todo lo que le llega. Se queda escuchando (a diferencia del
 * de `aforo.test.ts`, que solo mira la primera respuesta) porque aquí importa tanto lo que recibe
 * el que entra como lo que reciben —o no reciben— los que ya estaban.
 */
class Cliente {
  readonly recibidos: ServerMsg[] = [];
  private ws!: WebSocket;

  static async entrar(peerId: string, room: string): Promise<Cliente> {
    const c = new Cliente();
    c.ws = new WebSocket(url());
    abiertos.push(c.ws);
    c.ws.on('message', (raw) => c.recibidos.push(JSON.parse(String(raw)) as ServerMsg));
    await new Promise((ok, mal) => {
      c.ws.once('open', ok);
      c.ws.once('error', mal);
    });
    c.ws.send(JSON.stringify({ t: 'join', room, peerId, name: peerId.toUpperCase() }));
    await c.esperar();
    return c;
  }

  pedirOtroIntroductor(room: string, peerId: string, tried: string[]): void {
    this.ws.send(JSON.stringify({ t: 'introduce', room, peerId, tried }));
  }

  /** Pulsar "salir": se despide como es debido. */
  despedirse(room: string, peerId: string): void {
    this.ws.send(JSON.stringify({ t: 'leave', room, peerId }));
  }

  /** Se le cae el WebSocket sin avisar (parpadeo de red, pestaña cerrada, móvil dormido). */
  caerse(): void {
    this.ws.terminate();
  }

  get despedidas(): { peerId: string; reason?: string }[] {
    return this.recibidos.flatMap((m) =>
      m.t === 'peer-left' ? [{ peerId: m.peerId, reason: m.reason }] : [],
    );
  }

  /** Un respiro para que el servidor conteste (todo esto es local: milisegundos de sobra). */
  esperar(ms = 60): Promise<void> {
    return new Promise((ok) => setTimeout(ok, ms));
  }

  /** El último `peers` que le llegó: con quién le dijeron que empezara. */
  get presentados(): PeerInfo[] {
    const ultimo = [...this.recibidos].reverse().find((m) => m.t === 'peers');
    return ultimo?.t === 'peers' ? ultimo.peers : [];
  }

  get avisosDeLlegada(): string[] {
    return this.recibidos.flatMap((m) => (m.t === 'peer-joined' ? [m.peer.peerId] : []));
  }

  cerrar(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  if (!httpServer.listening) await new Promise((ok) => httpServer.once('listening', ok));
});

afterAll(async () => {
  for (const ws of abiertos) ws.close();
  await new Promise((ok) => httpServer.close(ok));
});

describe('el servidor presenta a uno, no a la sala entera', () => {
  it('al primero que llega no le presenta a nadie', async () => {
    const ana = await Cliente.entrar('ana', 'vacia');
    expect(ana.presentados).toEqual([]);
  });

  it('con tres dentro, al cuarto le da UN introductor (no tres)', async () => {
    const sala = 'introduccion';
    await Cliente.entrar('ana', sala);
    await Cliente.entrar('bruno', sala);
    await Cliente.entrar('cira', sala);

    const dario = await Cliente.entrar('dario', sala);

    // Aquí está el cambio: uno. Antes esta lista traía a los tres, y con ella venían tres
    // handshakes por el servidor.
    expect(dario.presentados).toHaveLength(1);
    // Y es el más antiguo: el que más canales abiertos tiene, o sea el que puede pasarle el censo
    // más completo de la mesa.
    expect(dario.presentados[0]).toMatchObject({ peerId: 'ana', name: 'ANA' });
  });

  it('solo avisa al introductor de que llegó alguien; los demás se enteran por la malla', async () => {
    const sala = 'avisos';
    const ana = await Cliente.entrar('ana', sala);
    const bruno = await Cliente.entrar('bruno', sala);
    const cira = await Cliente.entrar('cira', sala);
    await ana.esperar();

    // Ana es la introductora de los dos: le toca esperar sus ofertas.
    expect(ana.avisosDeLlegada).toEqual(['bruno', 'cira']);
    // Bruno no se entera de cira por aquí. Se enterará por el censo que le cotillee ana, ya por el
    // DataChannel. Es exactamente el tráfico que el servidor deja de ver.
    expect(bruno.avisosDeLlegada).toEqual([]);
    expect(cira.avisosDeLlegada).toEqual([]);
  });

  it('si el introductor no sirve, da otro (y avisa a ese otro)', async () => {
    const sala = 'fantasma';
    await Cliente.entrar('ana', sala);
    const bruno = await Cliente.entrar('bruno', sala);

    const cira = await Cliente.entrar('cira', sala);
    expect(cira.presentados[0]?.peerId).toBe('ana');

    // Ana no contesta (su navegador ya no está, aunque el socket siga en pie). Cira pide otro.
    cira.pedirOtroIntroductor(sala, 'cira', ['ana']);
    await cira.esperar();

    expect(cira.presentados[0]?.peerId).toBe('bruno');
    expect(bruno.avisosDeLlegada).toEqual(['cira']); // y bruno sabe que tiene que esperarla
  });

  it('distingue al que SE DESPIDE del que se le cayó el socket', async () => {
    // Los dos salían por aquí idénticos, y esa confusión rompía partidas: a un jugador se le caía
    // el WebSocket un segundo y los demás derribaban sus canales directos con él —sanos— dejándolo
    // fuera de una partida que para él seguía. El servidor es el único que puede distinguirlos,
    // porque solo él sabe si llegó un `leave` o si el socket se murió sin decir nada.
    const sala = 'adioses';
    const ana = await Cliente.entrar('ana', sala);

    const bruno = await Cliente.entrar('bruno', sala);
    bruno.despedirse(sala, 'bruno'); // pulsó "salir"
    await ana.esperar();

    const cira = await Cliente.entrar('cira', sala);
    cira.caerse(); // se le fue el WiFi
    await ana.esperar(200);

    expect(ana.despedidas).toEqual([
      { peerId: 'bruno', reason: 'bye' },
      { peerId: 'cira', reason: 'offline' },
    ]);
  });

  it('cuando no queda nadie por probar, contesta la lista vacía y se acabó', async () => {
    // Importa que sea una respuesta y no un silencio: es lo que hace que el cliente deje de pedir
    // en vez de quedarse reintentando contra una sala donde ya lo intentó con todos.
    const sala = 'sin-nadie-mas';
    await Cliente.entrar('ana', sala);
    const bruno = await Cliente.entrar('bruno', sala);

    bruno.pedirOtroIntroductor(sala, 'bruno', ['ana']);
    await bruno.esperar();

    expect(bruno.presentados).toEqual([]);
  });
});

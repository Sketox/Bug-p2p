import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../src/room.js';
import type { ClientMsg, ServerMsg } from '../src/protocol.js';

// Qué hace la `Room` cuando la señalización le dice "no cabes".
//
// El otro test del aforo (`signaling/test/aforo.test.ts`) prueba al portero: que el servidor cuenta
// bien y rebota al que sobra. Este prueba al rebotado, y sobre todo una trampa: la `Room` reintenta
// la conexión con backoff cuando se le cae la señalización, y con razón —un corte de WiFi no debe
// tumbar una partida—. Pero "la sala está llena" NO es un corte: es un no definitivo. Sin
// distinguirlos, el que sobra se queda toda la tarde aporreando una puerta que ya le dijo que no.

const URL_SIGNAL = 'ws://señalización/ws';

/** Los sockets que la `Room` ha llegado a abrir. Su LONGITUD es lo que prueba que no reintenta. */
let sockets: FakeWS[] = [];

class FakeWS {
  static readonly OPEN = 1;
  readyState = 0;
  enviados: ClientMsg[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;

  constructor(_url: string) {
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(); // el socket abre; el `join` sale aquí dentro
    });
  }
  entregar(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(raw: string): void {
    this.enviados.push(JSON.parse(raw) as ClientMsg);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

const asentar = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('la sala está llena', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    vi.stubGlobal('WebSocket', FakeWS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const entrar = async () => {
    const room = new Room(URL_SIGNAL, 'AB12', { peerId: 'tarde', name: 'El que llega tarde' });
    const avisos: number[] = [];
    room.on('full', (max: number) => avisos.push(max));
    room.connect();
    await asentar();
    return { room, avisos };
  };

  it('avisa con el aforo, para que la pantalla pueda decir cuánta gente cabía', async () => {
    const { avisos } = await entrar();
    expect(sockets[0]!.enviados[0]).toMatchObject({ t: 'join', peerId: 'tarde' });

    sockets[0]!.entregar({ t: 'room-full', max: 10 });
    await asentar();

    expect(avisos).toEqual([10]);
  });

  it('no se queda aporreando la puerta: un "no cabes" no se reintenta', async () => {
    await entrar();
    sockets[0]!.entregar({ t: 'room-full', max: 10 });
    await asentar();

    // El rechazo cierra el socket, y un cierre es justo lo que dispara el backoff de reconexión.
    // Si la `Room` no distinguiera este cierre de un corte de red, aquí abriría otro socket. Y otro.
    await vi.advanceTimersByTimeAsync(60_000);
    await asentar();

    expect(sockets).toHaveLength(1);
  });
});

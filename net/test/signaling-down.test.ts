import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, createGame, type GameEvent, type GameState } from '@bug/engine';
import { Replica, stateHash } from '../src/replica.js';
import { Room, type RoomStatus } from '../src/room.js';
import type { ClientMsg, ServerMsg } from '../src/protocol.js';

// LA tesis del proyecto, probada sobre `Room` (que es donde vive, y donde nadie la miraba):
//
//   si la señalización muere a media partida, la partida NO se entera.
//
// Es la respuesta a "¿entonces no es un servidor disfrazado?". La señalización presenta a los
// jugadores y se aparta; las cartas viajan por los DataChannels, que son conexiones directas
// navegador↔navegador. Matar el contenedor no debería tocarlas.
//
// Para que este test SIGNIFIQUE algo, el DataChannel falso de abajo entrega los mensajes
// directamente al otro extremo, sin pasar por el servidor falso. Si alguien "arreglara" el código
// haciendo que las jugadas viajaran por la señalización, este test se caería — que es exactamente
// lo que queremos que pase.

// --- El DataChannel: un tubo directo entre dos peers -------------------------------------------
class FakeChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  peer?: FakeChannel;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;

  abrir(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('canal cerrado');
    this.peer?.onmessage?.({ data }); // ← directo al otro navegador. La señalización no se entera.
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
}

// --- RTCPeerConnection: hace el handshake y empalma los dos extremos del tubo -------------------
const PCS = new Map<number, FakePC>();
let pcSeq = 0;

class FakePC {
  readonly id = ++pcSeq;
  connectionState = 'new';
  canal?: FakeChannel;
  onicecandidate?: (e: { candidate: unknown }) => void;
  onconnectionstatechange?: () => void;
  ondatachannel?: (e: { channel: FakeChannel }) => void;

  constructor() {
    PCS.set(this.id, this);
  }

  // El SDP lleva el id del que oferta: así el otro extremo sabe con qué canal empalmarse.
  createDataChannel(): FakeChannel {
    return (this.canal = new FakeChannel());
  }
  async createOffer() {
    return { type: 'offer', sdp: `sdp:${this.id}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `sdp:${this.id}` };
  }
  async setLocalDescription() {}
  async addIceCandidate() {}

  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    if (d.type !== 'offer') return;
    const remoto = PCS.get(Number(d.sdp.split(':')[1]));
    if (!remoto?.canal) return;
    // Soy el que contesta: creo mi extremo y lo empalmo con el suyo.
    const mio = new FakeChannel();
    mio.peer = remoto.canal;
    remoto.canal.peer = mio;
    this.canal = mio;
    this.ondatachannel?.({ channel: mio });
    queueMicrotask(() => {
      mio.abrir();
      remoto.canal!.abrir();
    });
  }

  close(): void {
    this.connectionState = 'closed';
  }
}

// --- El servidor de señalización, con un interruptor para matarlo -------------------------------
class FakeSignaling {
  vivo = true;
  private sala = new Map<string, FakeWS>(); // peerId → su socket

  conectar(ws: FakeWS): void {
    // Muerto: el navegador ni siquiera llega a abrir el socket.
    queueMicrotask(() => (this.vivo ? ws.aceptar() : ws.close()));
  }

  recibir(ws: FakeWS, msg: ClientMsg): void {
    if (!this.vivo) return;
    if (msg.t === 'join') {
      ws.peerId = msg.peerId;
      const presentes = [...this.sala.entries()].map(([peerId, s]) => ({
        peerId,
        name: s.nombre,
        epoch: s.epoch,
      }));
      ws.nombre = msg.name;
      ws.epoch = msg.epoch;
      ws.entregar({ t: 'peers', peers: presentes } as ServerMsg);
      for (const [, otro] of this.sala) {
        otro.entregar({
          t: 'peer-joined',
          peer: { peerId: msg.peerId, name: msg.name, epoch: msg.epoch },
        } as ServerMsg);
      }
      this.sala.set(msg.peerId, ws);
    } else if (msg.t === 'signal') {
      this.sala.get(msg.to)?.entregar({ t: 'signal', from: msg.from, data: msg.data } as ServerMsg);
    } else if (msg.t === 'leave') {
      this.sala.delete(msg.peerId);
    }
  }

  /** `docker stop`: el servidor desaparece y todos los sockets se caen. */
  matar(): void {
    this.vivo = false;
    const abiertos = [...this.sala.values()];
    this.sala.clear();
    for (const ws of abiertos) ws.close();
  }

  /** `docker run` otra vez: un servidor NUEVO, y por tanto vacío. No recuerda la sala anterior. */
  revivir(): void {
    this.vivo = true;
    this.sala.clear();
  }
}

let SERVER: FakeSignaling;

class FakeWS {
  static readonly OPEN = 1;
  readyState = 0;
  peerId = '';
  nombre = '';
  epoch?: string;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;

  constructor(_url: string) {
    SERVER.conectar(this);
  }
  aceptar(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  entregar(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(raw: string): void {
    if (this.readyState === 1) SERVER.recibir(this, JSON.parse(raw) as ClientMsg);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

/** Deja que corran las promesas del handshake (no hay temporizadores en el camino feliz). */
const asentar = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const URL_SIGNAL = 'ws://señalización-que-vamos-a-matar/ws';
const PLAYERS = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
];
const SEED = 4242;

/**
 * Un jugador: su `Room` (la red de verdad) y su réplica del motor.
 *
 * `epoch` es su encarnación. Un jugador que RECARGA la página vuelve con el mismo `id` (su
 * identidad es estable, por eso recupera su mano) pero con una `epoch` nueva: es otro navegador.
 */
class Jugador {
  readonly room: Room;
  readonly replica: Replica<GameState, GameEvent>;
  lamport = 0;
  estado: RoomStatus = 'connecting';

  constructor(
    readonly id: string,
    readonly epoch = `epoch-${id}-1`,
  ) {
    this.room = new Room(URL_SIGNAL, 'AB12', { peerId: id, name: id, epoch });
    this.replica = new Replica<GameState, GameEvent>({ initial: createGame(SEED, PLAYERS), apply });
    this.room.on('status', (s: RoomStatus) => (this.estado = s));
    // Lo que llega por el DataChannel se aplica al motor: esto es "la partida sigue".
    this.room.on('message', ({ data }: { data: any }) => {
      this.lamport = Math.max(this.lamport, data.lamport) + 1;
      this.replica.deliver(data);
    });
  }

  /** Juega y difunde por los DataChannels (NO por la señalización). */
  jugar(event: GameEvent): void {
    const stamped = { lamport: ++this.lamport, origin: this.id, event };
    this.replica.deliver(stamped);
    this.room.broadcast(stamped);
  }

  get canalCon(): (peerId: string) => boolean {
    return (peerId) => this.room.peers().find((p) => p.peerId === peerId)?.open === true;
  }
  get hash(): string {
    return stateHash(this.replica.state);
  }
  get turno(): string {
    const s = this.replica.state;
    return s.players[s.turn]!.id;
  }
}

describe('la señalización se cae a media partida', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    PCS.clear();
    pcSeq = 0;
    SERVER = new FakeSignaling();
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('RTCPeerConnection', FakePC);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('los DataChannels sobreviven y las jugadas siguen llegando y convergiendo', async () => {
    const alice = new Jugador('alice');
    const bob = new Jugador('bob');

    alice.room.connect();
    await asentar();
    bob.room.connect();
    await asentar();

    // Se encontraron por la señalización y tienen un canal directo abierto.
    expect(alice.estado).toBe('online');
    expect(alice.canalCon('bob')).toBe(true);
    expect(bob.canalCon('alice')).toBe(true);

    // Una jugada antes del apagón, para saber que la tubería funciona.
    const primero = alice.turno;
    const antes = alice.hash;
    const p1 = primero === 'alice' ? alice : bob;
    p1.jugar({ type: 'DRAW', playerId: primero });
    await asentar();
    expect(alice.hash).toBe(bob.hash);
    expect(alice.hash).not.toBe(antes);

    // --- docker stop ------------------------------------------------------------------------
    SERVER.matar();
    await asentar();

    // La sala sabe que se quedó sin punto de encuentro, y lo reintentará…
    expect(alice.estado).toBe('reconnecting');
    expect(bob.estado).toBe('reconnecting');

    // …pero los canales directos NO se han tocado. Aquí es donde se juega el proyecto.
    expect(alice.canalCon('bob')).toBe(true);
    expect(bob.canalCon('alice')).toBe(true);

    // --- Y la partida sigue, con la infraestructura muerta ------------------------------------
    const enTurno = alice.turno;
    const jugador = enTurno === 'alice' ? alice : bob;
    const otro = enTurno === 'alice' ? bob : alice;
    const antesDelApagon = alice.hash;

    jugador.jugar({ type: 'DRAW', playerId: enTurno });
    await asentar();

    expect(otro.hash).toBe(jugador.hash); // la jugada cruzó de un navegador al otro…
    expect(alice.hash).not.toBe(antesDelApagon); // …la partida avanzó de verdad…
    // …y avanzó porque el motor la ACEPTÓ. Sin esto, el test pasaría en verde aunque las jugadas
    // llegaran y se rechazaran todas: dos nodos igual de atascados también "convergen".
    expect(alice.replica.rejectedCount).toBe(0);
    expect(bob.replica.rejectedCount).toBe(0);
    expect(SERVER.vivo).toBe(false); // …y el servidor lleva muerto todo el rato.

    alice.room.destroy();
    bob.room.destroy();
  });

  it('cuando vuelve, la sala se recompone SIN tocar los canales que seguían sanos', async () => {
    const alice = new Jugador('alice');
    const bob = new Jugador('bob');
    alice.room.connect();
    await asentar();
    bob.room.connect();
    await asentar();
    expect(alice.canalCon('bob')).toBe(true);

    // Contamos los cortes de canal, para ver si el canal bueno sobrevive a la vuelta.
    let cortes = 0;
    alice.room.on('peerclose', () => cortes++);

    SERVER.matar();
    await asentar();
    expect(alice.canalCon('bob')).toBe(true); // el apagón no lo tocó
    expect(cortes).toBe(0);

    // --- `docker run` otra vez: servidor NUEVO, y vacío ---------------------------------------
    SERVER.revivir();
    // Los dos reintentan con backoff (1s, 2s…): dejamos correr el reloj.
    await vi.advanceTimersByTimeAsync(3000);
    await asentar();

    // Se recomponen: vuelven a estar online y con canal.
    expect(alice.estado).toBe('online');
    expect(bob.estado).toBe('online');
    expect(alice.canalCon('bob')).toBe(true);
    expect(bob.canalCon('alice')).toBe(true);

    // Y AQUÍ está el arreglo: ni un solo corte. Antes, al re-anunciarse los dos en el servidor
    // nuevo, cada uno tiraba el canal del otro y rehacía el handshake — con el canal sano y a
    // media partida. Ahora la `epoch` delata que es el mismo navegador de siempre y no se toca.
    expect(cortes).toBe(0);

    // Lo que importa: la partida no se rompió.
    const enTurno = alice.turno;
    const jugador = enTurno === 'alice' ? alice : bob;
    const otro = enTurno === 'alice' ? bob : alice;
    const antes = alice.hash;
    jugador.jugar({ type: 'DRAW', playerId: enTurno });
    await asentar();

    expect(otro.hash).toBe(jugador.hash);
    expect(alice.hash).not.toBe(antes);
    expect(alice.replica.rejectedCount).toBe(0);

    alice.room.destroy();
    bob.room.destroy();
  });

  it('pero si el peer RECARGÓ de verdad, su canal viejo sí se tira y se rehace', async () => {
    // La otra cara del arreglo, y la que lo hace peligroso si se hace mal: no renovar nunca sería
    // igual de roto que renovar siempre. Un peer que recarga vuelve con el MISMO peerId —su
    // identidad es estable a propósito— pero su RTCPeerConnection es nuevo, así que el canal que
    // yo tenía con él es basura y hay que rehacerlo. Aquí se comprueba que se distingue.
    const alice = new Jugador('alice');
    const bob = new Jugador('bob');
    alice.room.connect();
    await asentar();
    bob.room.connect();
    await asentar();
    expect(alice.canalCon('bob')).toBe(true);

    let cortes = 0;
    alice.room.on('peerclose', (id: string) => id === 'bob' && cortes++);

    // Bob recarga: mismo peerId, encarnación NUEVA, navegador nuevo.
    bob.room.destroy();
    const bob2 = new Jugador('bob', 'epoch-bob-2');
    bob2.room.connect();
    await asentar();

    // Alice tiró el canal muerto y rehízo el handshake con el Bob nuevo.
    expect(cortes).toBe(1);
    expect(alice.canalCon('bob')).toBe(true);
    expect(bob2.canalCon('alice')).toBe(true);

    // Y se puede seguir jugando con él.
    const enTurno = alice.turno;
    const jugador = enTurno === 'alice' ? alice : bob2;
    const otro = enTurno === 'alice' ? bob2 : alice;
    jugador.jugar({ type: 'DRAW', playerId: enTurno });
    await asentar();
    expect(otro.hash).toBe(jugador.hash);

    alice.room.destroy();
    bob2.room.destroy();
  });

  it('nadie nuevo puede entrar mientras esté caída: es lo único que se pierde', async () => {
    const alice = new Jugador('alice');
    const bob = new Jugador('bob');
    alice.room.connect();
    await asentar();
    bob.room.connect();
    await asentar();

    SERVER.matar();
    await asentar();

    // Carol llega a la fiesta con la puerta cerrada: no encuentra a nadie.
    const carol = new Jugador('carol');
    carol.room.connect();
    await vi.advanceTimersByTimeAsync(0);
    await asentar();

    expect(carol.room.peers()).toHaveLength(0);
    expect(carol.estado).toBe('reconnecting');
    // Y los que ya jugaban siguen con su canal, ajenos al que se quedó fuera.
    expect(alice.canalCon('bob')).toBe(true);

    alice.room.destroy();
    bob.room.destroy();
    carol.room.destroy();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../src/room.js';
import type { ClientMsg, PeerInfo, ServerMsg } from '../src/protocol.js';

// La señalización la hace LA MALLA, no el servidor.
//
// El servidor de señalización nunca va a desaparecer del todo —dos máquinas que no se conocen no
// pueden encontrarse solas; el arranque es irreducible y lo tienen igual BitTorrent, Bitcoin e
// IPFS—, pero sí puede encogerse hasta el primer contacto. Eso es lo que se prueba aquí:
//
//   1. el que llega hace UN handshake por el servidor (con el introductor), no N;
//   2. las presentaciones con el resto de la mesa viajan por los DataChannels ya abiertos;
//   3. si el servidor muere justo DESPUÉS de ese primer contacto, el recién llegado completa su
//      malla igual — que es la prueba de que el resto ya no dependía de él;
//   4. y si el introductor resulta ser un fantasma, se pide otro (porque ahora es la única puerta).
//
// Para que esto signifique algo, el servidor falso de abajo CUENTA las señales que pasan por él.
// Si alguien "arreglara" el código haciendo que los handshakes volvieran al servidor, los números
// dejarían de cuadrar — que es exactamente lo que queremos que pase.

// --- El DataChannel: un tubo directo entre dos peers -------------------------------------------
class FakeChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  peer?: FakeChannel;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;

  abrir(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.onopen?.();
  }
  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('canal cerrado');
    this.peer?.onmessage?.({ data }); // ← directo al otro navegador. El servidor no se entera.
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
}

// --- RTCPeerConnection ---------------------------------------------------------------------
//
// A diferencia del doble de `signaling-down.test.ts`, aquí el canal NO se abre al recibir la
// oferta: se abre cuando la RESPUESTA llega de vuelta al que ofertó. Es más fiel a WebRTC y, sobre
// todo, hace que el camino de vuelta sea carga real del test — si una respuesta se perdiera por la
// malla, el canal se quedaría a medias y el test se caería. Con el canal abriéndose solo con la
// oferta, media señalización podía estar rota sin que nadie se enterara.
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

  // El SDP lleva el id de quien lo emite: así el otro extremo sabe con qué canal empalmarse.
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
    const remoto = PCS.get(Number(d.sdp.split(':')[1]));
    if (!remoto) return;
    if (d.type === 'offer') {
      if (!remoto.canal) return;
      // Soy el que contesta: creo mi extremo y lo empalmo. Todavía sin abrir.
      const mio = new FakeChannel();
      mio.peer = remoto.canal;
      remoto.canal.peer = mio;
      this.canal = mio;
      this.ondatachannel?.({ channel: mio });
    } else if (d.type === 'answer') {
      // Soy el que ofertó y me llegó la respuesta: AHORA se abre el tubo, por los dos lados.
      if (!this.canal || !remoto.canal) return;
      queueMicrotask(() => {
        this.canal!.abrir();
        remoto.canal!.abrir();
      });
    }
  }

  close(): void {
    this.connectionState = 'closed';
  }
}

// --- El servidor de señalización: el de verdad, en pequeño --------------------------------------
const ficha = (ws: FakeWS): PeerInfo => ({ peerId: ws.peerId, name: ws.nombre, epoch: ws.epoch });

class FakeSignaling {
  vivo = true;
  /** Señales WebRTC que han pasado por aquí. Es LA métrica del test. */
  senales = 0;
  private sala = new Map<string, FakeWS>();

  conectar(ws: FakeWS): void {
    queueMicrotask(() => (this.vivo ? ws.aceptar() : ws.close()));
  }

  /** El más antiguo de la sala que no esté descartado (igual que `pickIntroducer` del servidor). */
  private introductor(descartados: Set<string>): FakeWS | undefined {
    for (const [id, ws] of this.sala) if (!descartados.has(id)) return ws;
    return undefined;
  }

  recibir(ws: FakeWS, msg: ClientMsg): void {
    if (!this.vivo) return;
    if (msg.t === 'join') {
      ws.peerId = msg.peerId;
      ws.nombre = msg.name;
      ws.epoch = msg.epoch;
      // Se presenta a UNO, no al censo entero.
      const intro = this.introductor(new Set([msg.peerId]));
      ws.entregar({ t: 'peers', peers: intro ? [ficha(intro)] : [] });
      if (intro) intro.entregar({ t: 'peer-joined', peer: ficha(ws) });
      this.sala.set(msg.peerId, ws);
    } else if (msg.t === 'introduce') {
      const otro = this.introductor(new Set([msg.peerId, ...msg.tried]));
      ws.entregar({ t: 'peers', peers: otro ? [ficha(otro)] : [] });
      const yo = this.sala.get(msg.peerId);
      if (otro && yo) otro.entregar({ t: 'peer-joined', peer: ficha(yo) });
    } else if (msg.t === 'signal') {
      this.senales++;
      this.sala.get(msg.to)?.entregar({ t: 'signal', from: msg.from, data: msg.data });
    } else if (msg.t === 'leave') {
      // Lo pidió él: esto sí es marcharse. El servidor de verdad avisa a TODA la sala de quién se
      // fue (a diferencia de las llegadas, que solo las oye el introductor).
      this.expulsar(msg.peerId, 'bye');
    }
  }

  private expulsar(peerId: string, reason: 'bye' | 'offline'): void {
    this.sala.delete(peerId);
    for (const otro of this.sala.values()) otro.entregar({ t: 'peer-left', peerId, reason });
  }

  /**
   * A UN jugador se le cae el WebSocket, pero el servidor sigue vivo y los demás siguen conectados.
   *
   * Es el caso que rompía partidas y que no cubría ningún test: `signaling-down.test.ts` mata el
   * servidor ENTERO, y entonces no queda nadie a quien avisar. Aquí sí queda: el servidor le cuenta
   * a la sala que ese jugador se fue, cuando lo único que pasó es que perdió el tablón de anuncios.
   */
  caerSocket(peerId: string): void {
    const ws = this.sala.get(peerId);
    this.expulsar(peerId, 'offline');
    ws?.close();
  }

  /** `docker stop`: el servidor desaparece y todos los sockets se caen. */
  matar(): void {
    this.vivo = false;
    const abiertos = [...this.sala.values()];
    this.sala.clear();
    for (const ws of abiertos) ws.close();
  }
}

let SERVER: FakeSignaling;

class FakeWS {
  static readonly OPEN = 1;
  readyState = 0;
  peerId = '';
  nombre = '';
  epoch?: string;
  /**
   * El navegador de este peer ya no está, pero su socket sigue abierto (cerró el portátil, se
   * durmió el móvil). El servidor no tiene forma de saberlo y lo sigue ofreciendo de introductor.
   */
  sordo = false;
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
    if (this.sordo) return;
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

/** Deja correr las promesas del handshake (no hay temporizadores en el camino feliz). */
const asentar = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

const URL_SIGNAL = 'ws://un-punto-de-encuentro/ws';

class Jugador {
  readonly room: Room;
  /** Mensajes de JUEGO recibidos. La señalización de malla no debe aparecer nunca aquí. */
  readonly recibidos: { from: string; data: unknown }[] = [];

  constructor(
    readonly id: string,
    epoch = `epoch-${id}-1`,
  ) {
    this.room = new Room(URL_SIGNAL, 'AB12', { peerId: id, name: id, epoch });
    this.room.on('message', (m: { from: string; data: unknown }) => this.recibidos.push(m));
  }

  /** Los peers con los que tengo canal directo ABIERTO, ordenados para poder compararlos. */
  abiertos(): string[] {
    return this.room
      .peers()
      .filter((p) => p.open)
      .map((p) => p.peerId)
      .sort();
  }

  /** Su propio socket falso, para poder dejarlo sordo (fingir que el navegador se fue). */
  get socket(): FakeWS {
    return (this.room as unknown as { ws: FakeWS }).ws;
  }
}

/** Mete a los jugadores en la sala, de uno en uno, y espera a que la malla se asiente. */
async function entrar(...jugadores: Jugador[]): Promise<void> {
  for (const j of jugadores) {
    j.room.connect();
    await asentar();
  }
}

describe('señalización por la malla', () => {
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

  it('el que llega hace UN handshake por el servidor, y el resto de la malla se hace sola', async () => {
    // Tres dentro. Ana es la primera, así que es a quien el servidor presenta siempre.
    const ana = new Jugador('ana');
    const bruno = new Jugador('bruno');
    const cira = new Jugador('cira');
    await entrar(ana, bruno, cira);

    // Ya son una malla completa: cada uno con canal directo a los otros dos.
    expect(ana.abiertos()).toEqual(['bruno', 'cira']);
    expect(bruno.abiertos()).toEqual(['ana', 'cira']);
    expect(cira.abiertos()).toEqual(['ana', 'bruno']);

    // Y el canal bruno↔cira se negoció SIN pasar por el servidor: cira entró haciendo un solo
    // handshake (con ana) y a bruno llegó por la malla. Dos señales por handshake: oferta y
    // respuesta. Ana↔bruno y ana↔cira son los dos únicos que vio el servidor.
    expect(SERVER.senales).toBe(4);

    // --- Ahora entra una cuarta, con tres personas dentro -------------------------------------
    // Bea es "menor" que bruno y que cira: son ELLOS los que le ofrecen conexión, no ella. Así se
    // ejercita el lado de la regla que decide quién oferta cuando dos se descubren a la vez.
    const antes = SERVER.senales;
    const bea = new Jugador('bea');
    await entrar(bea);

    expect(bea.abiertos()).toEqual(['ana', 'bruno', 'cira']);
    expect(bruno.abiertos()).toEqual(['ana', 'bea', 'cira']);
    expect(cira.abiertos()).toEqual(['ana', 'bea', 'bruno']);

    // AQUÍ está el proyecto: con tres personas dentro, el servidor solo vio UN handshake.
    // Antes de esto habría visto tres (seis señales), uno con cada jugador de la sala.
    expect(SERVER.senales - antes).toBe(2);

    // Y el otro lado de la regla: zoe es "mayor" que todos, así que es ella quien oferta a los
    // demás por la malla. Mismo resultado, mismo coste para el servidor.
    const antesDeZoe = SERVER.senales;
    const zoe = new Jugador('zoe');
    await entrar(zoe);

    expect(zoe.abiertos()).toEqual(['ana', 'bea', 'bruno', 'cira']);
    expect(SERVER.senales - antesDeZoe).toBe(2);

    for (const j of [ana, bruno, cira, bea, zoe]) j.room.destroy();
  });

  it('si el servidor muere justo tras el primer contacto, el recién llegado completa su malla igual', async () => {
    // Esta es la que demuestra que sirvió de algo. Antes, matar la señalización a mitad de la
    // entrada dejaba al nuevo a medias: conectado con uno o dos y sin forma de alcanzar al resto,
    // porque TODOS los handshakes pasaban por ahí. Ahora solo el primero pasa por ahí.
    const ana = new Jugador('ana');
    const bruno = new Jugador('bruno');
    const cira = new Jugador('cira');
    await entrar(ana, bruno, cira);

    const bea = new Jugador('bea');
    // `docker stop` EN EL INSTANTE en que se abre su primer canal: el del introductor. A partir de
    // aquí no hay servidor, ni para ella ni para nadie.
    bea.room.on('peeropen', () => {
      if (SERVER.vivo) SERVER.matar();
    });

    bea.room.connect();
    await asentar();

    expect(SERVER.vivo).toBe(false); // el servidor lleva muerto desde el primer canal…
    // …y aun así completó la malla entera: los otros dos handshakes viajaron por los DataChannels.
    expect(bea.abiertos()).toEqual(['ana', 'bruno', 'cira']);
    expect(bruno.abiertos()).toEqual(['ana', 'bea', 'cira']);
    expect(cira.abiertos()).toEqual(['ana', 'bea', 'bruno']);

    // Y la malla se usa para lo suyo: una jugada cruza de un navegador al otro sin infraestructura.
    bea.room.broadcast({ k: 'hola' });
    await asentar();
    expect(cira.recibidos).toContainEqual({ from: 'bea', data: { k: 'hola' } });

    for (const j of [ana, bruno, cira, bea]) j.room.destroy();
  });

  it('si el introductor es un fantasma, se pide otro (y se entra igual)', async () => {
    // El servidor presenta al más antiguo, pero "tener el socket abierto" no es "estar vivo": el
    // portátil se cerró y nadie se ha enterado. Como ahora el introductor es la ÚNICA puerta de
    // entrada, un fantasma dejaría al que llega fuera para siempre.
    const ana = new Jugador('ana');
    const bruno = new Jugador('bruno');
    await entrar(ana, bruno);
    expect(bruno.abiertos()).toEqual(['ana']);

    ana.socket.sordo = true; // ana sigue "en la sala" para el servidor, pero no hay nadie

    const cira = new Jugador('cira');
    cira.room.connect();
    await asentar();

    // Le tocó ana de introductora y no contesta: sigue en la puerta.
    expect(cira.abiertos()).toEqual([]);

    // Pasa el plazo de espera, pide otro introductor, y el servidor le da a bruno.
    await vi.advanceTimersByTimeAsync(6000);
    await asentar();

    expect(cira.abiertos()).toEqual(['bruno']);

    for (const j of [ana, bruno, cira]) j.room.destroy();
  });

  it('el que se va y vuelve se reconecta con TODA la mesa, no solo con su introductor', async () => {
    // El agujero que abre presentar a uno solo, y que hay que tapar: el `peer-joined` del que
    // regresa ya no lo oye la sala entera, solo su introductor. Si los demás se quedaran con él en
    // la lista de "idos", volvería a una mesa donde solo una persona le habla — y como el resto lo
    // da por ausente, ni le llegan las jugadas ni le guardan el sitio.
    const ana = new Jugador('ana');
    const bruno = new Jugador('bruno');
    const cira = new Jugador('cira');
    await entrar(ana, bruno, cira);
    expect(cira.abiertos()).toEqual(['ana', 'bruno']);

    // Bruno se va (cierra la pestaña): el servidor se lo dice a los dos que quedan.
    bruno.room.destroy();
    await asentar();
    expect(ana.abiertos()).toEqual(['cira']);
    expect(cira.abiertos()).toEqual(['ana']);

    // Y vuelve: mismo peerId (su identidad es estable), navegador nuevo.
    const bruno2 = new Jugador('bruno', 'epoch-bruno-2');
    await entrar(bruno2);

    // El servidor solo le presentó a ana. A cira llegó por la malla, y cira lo readmitió porque
    // aparecía en un censo — que es la prueba de vida buena: solo se anuncian canales abiertos.
    expect(bruno2.abiertos()).toEqual(['ana', 'cira']);
    expect(cira.abiertos()).toEqual(['ana', 'bruno']);

    for (const j of [ana, cira, bruno2]) j.room.destroy();
  });

  it('a uno se le cae el WebSocket y NADIE derriba sus canales sanos', async () => {
    // El fallo, tal y como se veía jugando: a Cira le parpadea el WiFi un segundo. El servidor
    // sigue en pie, así que le cuenta a la sala "Cira se fue" — y Ana y Bruno cierran unos canales
    // directos que estaban perfectos. Cira, ya sin señalización, no puede rehacerlos: se queda
    // mirando una partida que para los otros dos sigue, y sin un solo error en pantalla.
    //
    // Perder el WebSocket no es irse: por ahí no viajan las cartas.
    const ana = new Jugador('ana');
    const bruno = new Jugador('bruno');
    const cira = new Jugador('cira');
    await entrar(ana, bruno, cira);
    expect(ana.abiertos()).toEqual(['bruno', 'cira']);

    let cortes = 0;
    ana.room.on('peerclose', () => cortes++);
    bruno.room.on('peerclose', () => cortes++);

    SERVER.caerSocket('cira');
    await asentar();

    expect(cortes).toBe(0); // ni un canal derribado
    expect(ana.abiertos()).toEqual(['bruno', 'cira']);
    expect(bruno.abiertos()).toEqual(['ana', 'cira']);
    expect(cira.abiertos()).toEqual(['ana', 'bruno']);

    // Y lo que importa de verdad: Cira sigue jugando con los dos.
    cira.room.broadcast({ k: 'event', quien: 'cira' });
    await asentar();
    expect(ana.recibidos).toContainEqual({ from: 'cira', data: { k: 'event', quien: 'cira' } });
    expect(bruno.recibidos).toContainEqual({ from: 'cira', data: { k: 'event', quien: 'cira' } });

    for (const j of [ana, bruno, cira]) j.room.destroy();
  });

  it('pero si SE DESPIDE de verdad, sus canales sí se cierran', async () => {
    // La otra cara: no reaccionar nunca sería tan malo como reaccionar siempre. Quien pulsa "salir"
    // manda un `leave`, y eso el servidor sí puede afirmarlo — lo dijo él.
    const ana = new Jugador('ana');
    const bruno = new Jugador('bruno');
    const cira = new Jugador('cira');
    await entrar(ana, bruno, cira);

    cira.room.destroy(); // "salir" → manda `leave`
    await asentar();

    expect(ana.abiertos()).toEqual(['bruno']);
    expect(bruno.abiertos()).toEqual(['ana']);

    for (const j of [ana, bruno]) j.room.destroy();
  });

  it('la señalización de la malla no se cuela en los mensajes del juego', async () => {
    // `Room` es transporte puro salvo por su clave reservada. Si la señalización que retransmite
    // subiera a la capa de arriba, el juego recibiría mensajes que no entiende — y lo que es peor,
    // un `roster` o un `relay` acabarían en el log de eventos de la partida.
    const ana = new Jugador('ana');
    const bruno = new Jugador('bruno');
    const cira = new Jugador('cira');
    await entrar(ana, bruno, cira);

    // Hubo señalización por la malla (el canal bruno↔cira se hizo así), pero arriba no llegó nada.
    expect(ana.recibidos).toEqual([]);
    expect(bruno.recibidos).toEqual([]);
    expect(cira.recibidos).toEqual([]);

    // Y lo que sí es del juego, sube.
    ana.room.broadcast({ k: 'lobby', players: [] });
    await asentar();
    expect(bruno.recibidos).toEqual([{ from: 'ana', data: { k: 'lobby', players: [] } }]);

    for (const j of [ana, bruno, cira]) j.room.destroy();
  });
});

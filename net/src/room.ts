import type { ClientMsg, PeerInfo, ServerMsg, Signal } from './protocol.js';

// Malla WebRTC. Cada peer mantiene una conexión directa (DataChannel) con cada otro peer.
// Convención sin "glare": el que ACABA de entrar inicia la conexión hacia los que ya estaban.
// Transporte puro: envía/recibe JSON arbitrario; no sabe nada de reglas del juego.

// STUN por defecto (descubre la IP pública; resuelve la mayoría de casos LAN/NAT simple).
// El TURN (relay para redes restrictivas) se inyecta por configuración en Fase 3.
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export interface RoomOptions {
  /** Servidores ICE (STUN/TURN). Si se omite, usa solo STUN público. */
  iceServers?: RTCIceServer[];
}

type RoomEvent = 'roster' | 'message' | 'peeropen' | 'peerclose' | 'status';
type Handler = (payload: any) => void;

interface Conn {
  info: PeerInfo;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  open: boolean;
}

export type RoomStatus = 'connecting' | 'online' | 'reconnecting' | 'closed';

/** Reintentos de la señalización: 1s, 2s, 4s… hasta un techo. */
const RETRY_BASE = 1000;
const RETRY_MAX = 8000;
/** Reintentos del canal directo con un peer que sigue en la sala pero cuyo DataChannel murió. */
const PEER_RETRY_DELAY = 1500;
const PEER_RETRY_LIMIT = 4;

export class Room {
  private ws?: WebSocket;
  private conns = new Map<string, Conn>();
  private listeners = new Map<RoomEvent, Set<Handler>>();
  private closed = false;
  private readonly iceServers: RTCIceServer[];
  /** Backoff de reconexión a la señalización. */
  private retries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** Peers que salieron de la sala de verdad: a esos no se les reintenta nada. */
  private left = new Set<string>();
  /** Intentos de rehacer el canal directo con cada peer. */
  private peerRetries = new Map<string, number>();

  constructor(
    private readonly url: string,
    readonly roomId: string,
    readonly self: PeerInfo,
    options: RoomOptions = {},
  ) {
    this.iceServers = options.iceServers ?? DEFAULT_ICE;
  }

  // --- API de eventos -------------------------------------------------------
  on(event: RoomEvent, cb: Handler): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }
  private emit(event: RoomEvent, payload?: unknown): void {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }

  // --- Conexión de señalización --------------------------------------------
  //
  // La señalización se cae (se corta el WiFi, el servidor se reinicia, el túnel expira). Eso NO
  // debe tumbar la partida: las cartas viajan por los DataChannels, que siguen vivos por su
  // cuenta. Pero sin señalización nadie nuevo puede entrar ni volver, así que se reintenta con
  // backoff exponencial hasta recuperarla. Al re-entrar, el servidor nos devuelve el censo de la
  // sala y rehacemos los canales que hicieran falta.
  connect(): void {
    if (this.closed) return;
    this.emit('status', (this.retries === 0 ? 'connecting' : 'reconnecting') as RoomStatus);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.sendSignaling({
        t: 'join',
        room: this.roomId,
        peerId: this.self.peerId,
        name: this.self.name,
        epoch: this.self.epoch,
      });
      this.emit('status', 'online' as RoomStatus);
    };
    ws.onmessage = (ev) => this.onSignaling(JSON.parse(String(ev.data)) as ServerMsg);
    ws.onclose = () => {
      if (this.closed) return;
      this.emit('status', 'reconnecting' as RoomStatus);
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(RETRY_BASE * 2 ** this.retries, RETRY_MAX);
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private sendSignaling(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onSignaling(msg: ServerMsg): void {
    switch (msg.t) {
      case 'peers':
        // Acabo de entrar (o de volver): inicio la conexión hacia cada peer del censo.
        for (const info of msg.peers) this.renewConn(info, true);
        break;
      case 'peer-joined':
        // Alguien entró o RE-entró: él iniciará hacia mí. Si tenía un canal con él, `renewConn`
        // decide si sigue valiendo (misma encarnación) o hay que rehacerlo (recargó la página).
        this.left.delete(msg.peer.peerId);
        this.renewConn(msg.peer, false);
        break;
      case 'peer-left':
        this.left.add(msg.peerId);
        this.dropConn(msg.peerId);
        break;
      case 'signal':
        this.onPeerSignal(msg.from, msg.data as Signal);
        break;
    }
  }

  /**
   * Rehace desde cero la conexión con un peer… salvo que no haga falta.
   *
   * Un peer se re-anuncia por dos motivos que llegan aquí IGUAL (mismo peerId, porque la identidad
   * es estable a propósito):
   *
   *   a) recargó la página  → su RTCPeerConnection es nuevo; mi canal con él es basura.
   *   b) volvió la señalización → su RTCPeerConnection es el de siempre; mi canal está perfecto.
   *
   * Tratar (b) como (a) —que es lo que se hacía— corta un canal sano y rehace el handshake a media
   * partida, sin que nada estuviera roto. La `epoch` los distingue: cambia en cada carga de página,
   * así que si coincide con la que ya tengo, es literalmente el mismo navegador al otro lado.
   *
   * Se exige además que el canal esté ABIERTO: una `epoch` igual con el canal muerto (se cayó la
   * red, no la pestaña) sí hay que rehacerla.
   */
  private renewConn(info: PeerInfo, initiator: boolean): void {
    const actual = this.conns.get(info.peerId);
    if (actual) {
      const mismoNavegador = !!info.epoch && actual.info.epoch === info.epoch;
      if (mismoNavegador && actual.open) {
        actual.info = info; // pudo cambiarse el nombre; el canal se queda como está
        return;
      }
      this.dropConn(info.peerId);
    }
    this.peerRetries.delete(info.peerId);
    this.createConn(info, initiator);
  }

  /**
   * El canal directo con un peer murió, pero el peer sigue en la sala (no llegó su `peer-left`):
   * fue un corte de red, no una salida. Reintentamos el handshake. Para no chocar de frente
   * (ambos ofreciendo a la vez), inicia solo el del peerId mayor; el otro espera la oferta.
   */
  private retryPeer(info: PeerInfo): void {
    if (this.closed || this.left.has(info.peerId)) return;
    const attempts = this.peerRetries.get(info.peerId) ?? 0;
    if (attempts >= PEER_RETRY_LIMIT) return;
    this.peerRetries.set(info.peerId, attempts + 1);

    setTimeout(() => {
      if (this.closed || this.left.has(info.peerId) || this.conns.has(info.peerId)) return;
      this.createConn(info, this.self.peerId > info.peerId);
    }, PEER_RETRY_DELAY);
  }

  // --- Conexiones WebRTC ----------------------------------------------------
  private createConn(info: PeerInfo, initiator: boolean): Conn {
    const existing = this.conns.get(info.peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const conn: Conn = { info, pc, open: false };
    this.conns.set(info.peerId, conn);
    this.emit('roster', this.peers());

    pc.onicecandidate = (e) => {
      if (e.candidate) this.relay(info.peerId, { kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      // Caída inesperada del canal: se reintenta (puede ser un corte pasajero, no una salida).
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this.dropConn(info.peerId, true);
      }
    };

    if (initiator) {
      const channel = pc.createDataChannel('bug');
      this.wireChannel(conn, channel);
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => this.relay(info.peerId, { kind: 'offer', sdp: offer.sdp! }))
        .catch(() => this.dropConn(info.peerId));
    } else {
      pc.ondatachannel = (e) => this.wireChannel(conn, e.channel);
    }
    return conn;
  }

  private wireChannel(conn: Conn, channel: RTCDataChannel): void {
    conn.channel = channel;
    channel.onopen = () => {
      conn.open = true;
      this.emit('peeropen', conn.info.peerId);
      this.emit('roster', this.peers());
    };
    channel.onclose = () => this.dropConn(conn.info.peerId, true);
    channel.onmessage = (e) => {
      try {
        this.emit('message', { from: conn.info.peerId, data: JSON.parse(String(e.data)) });
      } catch {
        /* mensaje no-JSON: ignorado */
      }
    };
  }

  private async onPeerSignal(from: string, signal: Signal): Promise<void> {
    let conn = this.conns.get(from);
    if (!conn) conn = this.createConn({ peerId: from, name: from }, false);
    const pc = conn.pc;
    try {
      if (signal.kind === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.relay(from, { kind: 'answer', sdp: answer.sdp! });
      } else if (signal.kind === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      } else if (signal.kind === 'ice') {
        await pc.addIceCandidate(signal.candidate);
      }
    } catch {
      /* señal fuera de orden: se ignora (ICE reintenta) */
    }
  }

  private relay(to: string, signal: Signal): void {
    this.sendSignaling({ t: 'signal', room: this.roomId, from: this.self.peerId, to, data: signal });
  }

  private dropConn(peerId: string, retry = false): void {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    // Se saca del mapa ANTES de cerrar, y no después: cerrar el canal dispara su propio `onclose`,
    // que vuelve a entrar aquí. Si la entrada siguiera puesta, la reentrada la daría por buena y
    // anunciaría el cierre dos veces (dos `peerclose`, dos reintentos). Fuera del mapa, la
    // reentrada no encuentra nada y se va por donde vino.
    this.conns.delete(peerId);
    try {
      conn.channel?.close();
      conn.pc.close();
    } catch {
      /* noop */
    }
    this.emit('peerclose', peerId);
    this.emit('roster', this.peers());
    if (retry) this.retryPeer(conn.info);
  }

  // --- Envío de datos -------------------------------------------------------
  /** Peers actualmente en la sala (incluye los que aún están conectando). */
  peers(): { peerId: string; name: string; open: boolean }[] {
    return [...this.conns.values()].map((c) => ({ peerId: c.info.peerId, name: c.info.name, open: c.open }));
  }

  broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const conn of this.conns.values()) {
      if (conn.open && conn.channel) conn.channel.send(data);
    }
  }

  sendTo(peerId: string, msg: unknown): boolean {
    const conn = this.conns.get(peerId);
    if (conn?.open && conn.channel) {
      conn.channel.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  destroy(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.sendSignaling({ t: 'leave', room: this.roomId, peerId: this.self.peerId });
    for (const id of [...this.conns.keys()]) this.dropConn(id);
    this.ws?.close();
  }
}

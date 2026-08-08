import {
  MESH_MAX_HOPS,
  MESH_SIGNAL,
  type ClientMsg,
  type MeshMsg,
  type PeerInfo,
  type ServerMsg,
  type Signal,
} from './protocol.js';

// Malla WebRTC. Cada peer mantiene una conexión directa (DataChannel) con cada otro peer.
// Transporte puro: envía/recibe JSON arbitrario; no sabe nada de reglas del juego.
//
// LA SEÑALIZACIÓN SE HACE SOLA. El servidor solo interviene en el primer contacto: presenta al que
// llega con UN peer de la sala (el introductor) y reenvía ese único handshake. A partir de ahí:
//
//   1. el introductor le cotillea su censo por el DataChannel recién abierto (`roster`);
//   2. las ofertas/respuestas con el resto de la mesa viajan como `relay`, dando saltos por la
//      malla — es señalización, pero sobre las propias conexiones directas;
//   3. si el servidor muere justo después del primer contacto, el recién llegado **completa su
//      malla igual** (lo prueba `test/mesh-signaling.test.ts`).
//
// Convenciones sin "glare" (dos peers ofreciéndose a la vez), que son dos porque hay dos caminos:
//   - por el servidor → inicia el que ACABA de entrar; al introductor se le avisa para que espere.
//   - por la malla    → inicia el del `peerId` mayor. Es una regla que los dos lados calculan igual
//                       sin hablarlo, que es justo lo que hace falta cuando se descubren a la vez.

// STUN por defecto (descubre la IP pública; resuelve la mayoría de casos LAN/NAT simple).
// El TURN (relay para redes restrictivas) se inyecta por configuración en Fase 3.
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export interface RoomOptions {
  /** Servidores ICE (STUN/TURN). Si se omite, usa solo STUN público. */
  iceServers?: RTCIceServer[];
  /**
   * Prueba de que el `peerId` es nuestro, para la señalización.
   *
   * No es una credencial de jugador ni cifra nada: solo impide que otro reclame nuestro sitio en
   * la sala mientras estamos desconectados (ver `ClientMsg.join`). Se guarda junto al `peerId`, en
   * el mismo `sessionStorage`, y por eso lo elige la capa de arriba y no esta.
   */
  secret?: string;
}

type RoomEvent = 'roster' | 'message' | 'peeropen' | 'peerclose' | 'status' | 'full';
type Handler = (payload: any) => void;

/**
 * Por dónde se está negociando esta conexión.
 *
 * `signaling` → por el servidor. Solo el introductor (y quien nos lo pidió antes de que la malla
 *               existiera). Es el primer contacto, y no hay otra forma de hacerlo.
 * `mesh`      → por los DataChannels ya abiertos. Todo lo demás.
 *
 * Se guarda porque las respuestas tienen que volver por donde vino la oferta: si un peer nos
 * descubrió por la malla y le contestáramos por el servidor, el servidor volvería a ver todos los
 * handshakes y no habríamos quitado nada.
 */
type Via = 'signaling' | 'mesh';

interface Conn {
  info: PeerInfo;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  open: boolean;
  via: Via;
}

export type RoomStatus = 'connecting' | 'online' | 'reconnecting' | 'closed';

/**
 * ¿Esto que llegó por el DataChannel es señalización de la malla, y no un mensaje del juego?
 *
 * Se comprueba de verdad —clave reservada Y tipo conocido— en vez de fiarse de la clave a secas:
 * lo que entra por aquí lo manda otro navegador, y `Room` es el sitio donde se decide si un JSON
 * ajeno acaba abriendo conexiones WebRTC. Un `~sig` a medias se descarta y sube como mensaje
 * normal, donde el juego lo ignorará por no entenderlo.
 */
function esMeshMsg(data: unknown): data is MeshMsg {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.k !== MESH_SIGNAL) return false;
  if (m.t === 'roster') return Array.isArray(m.peers);
  return (
    m.t === 'relay' &&
    typeof m.id === 'string' &&
    typeof m.hop === 'number' &&
    typeof m.from === 'string' &&
    typeof m.to === 'string' &&
    typeof m.peer === 'object' &&
    m.peer !== null &&
    typeof m.data === 'object' &&
    m.data !== null
  );
}

/** Reintentos de la señalización: 1s, 2s, 4s… hasta un techo. */
const RETRY_BASE = 1000;
const RETRY_MAX = 8000;
/** Reintentos del canal directo con un peer que sigue en la sala pero cuyo DataChannel murió. */
const PEER_RETRY_DELAY = 1500;
const PEER_RETRY_LIMIT = 4;
/**
 * Cuánto se espera a que el introductor conteste antes de pedir otro.
 *
 * El servidor presenta a uno solo, y ese uno puede ser un fantasma: su WebSocket sigue abierto pero
 * el navegador ya no está (el portátil se cerró, el móvil se durmió). Antes daba igual —se
 * intentaba con todos a la vez—, ahora es la puerta de entrada, así que hay que notar que no abre.
 */
const INTRODUCER_TIMEOUT = 5000;
/** Cuántos `id` de relay se recuerdan para descartar duplicados de la inundación. */
const SEEN_LIMIT = 400;

export class Room {
  private ws?: WebSocket;
  private conns = new Map<string, Conn>();
  private listeners = new Map<RoomEvent, Set<Handler>>();
  private closed = false;
  private readonly iceServers: RTCIceServer[];
  /** Ver `RoomOptions.secret`. Solo viaja al servidor de señalización, nunca a otros peers. */
  private readonly secret?: string;
  /** Backoff de reconexión a la señalización. */
  private retries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** Peers que salieron de la sala de verdad: a esos no se les reintenta nada. */
  private left = new Set<string>();
  /** Intentos de rehacer el canal directo con cada peer. */
  private peerRetries = new Map<string, number>();
  /** Introductores que el servidor ya nos dio (para no pedir dos veces el mismo). */
  private tried = new Set<string>();
  private introTimer?: ReturnType<typeof setTimeout>;
  /** `id` de los relays ya vistos, para descartar los duplicados de la inundación. */
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  /**
   * Identificador de ESTA sala en memoria, para que mis relays no repitan `id` con los de la carga
   * anterior de la página.
   *
   * Sin esto había un fallo de los silenciosos: el `id` era `peerId:contador`, el `peerId` sobrevive
   * a un F5 —tiene que hacerlo— pero el contador vuelve a empezar. El que recargaba mandaba otra vez
   * `bruno:1`, y sus vecinos **seguían recordando el `bruno:1` de antes**: lo descartaban por
   * duplicado y su respuesta no llegaba a ninguna parte. Volvía a la mesa conectado con su
   * introductor y con nadie más, sin un solo error por ningún lado.
   */
  private readonly relayTag = Math.random().toString(36).slice(2, 10);
  /** Contador para que mis relays lleven un `id` único (`peerId:carga:n`). */
  private relaySeq = 0;

  constructor(
    private readonly url: string,
    readonly roomId: string,
    readonly self: PeerInfo,
    options: RoomOptions = {},
  ) {
    this.iceServers = options.iceServers ?? DEFAULT_ICE;
    this.secret = options.secret;
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
      // Servidor nuevo (o el de siempre, tras un corte): la lista de introductores descartados era
      // de la sesión anterior y ya no dice nada. Se empieza de cero.
      this.tried.clear();
      this.sendSignaling({
        t: 'join',
        room: this.roomId,
        peerId: this.self.peerId,
        name: this.self.name,
        epoch: this.self.epoch,
        // La prueba de que este peerId es mío. Sin ella, el mecanismo que me deja volver tras un
        // F5 le sirve a cualquiera para echarme y ocupar mi sitio. Ver `ClientMsg.join`.
        secret: this.secret,
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
        // El introductor: con él —y solo con él— se hace el handshake por el servidor. Al resto de
        // la mesa se llega por la malla, con el censo que él nos pase.
        //
        // Viene como lista porque puede estar vacía: la sala no tiene a nadie (soy el primero) o ya
        // se probó con todos. En ese caso no hay a quién esperar, y no se pide otro.
        for (const info of msg.peers) {
          this.tried.add(info.peerId);
          this.renewConn(info, true, 'signaling');
        }
        if (msg.peers.length > 0) this.watchIntroducer();
        break;
      case 'peer-joined':
        // Me eligieron de introductor de alguien: él iniciará hacia mí. Si ya tenía un canal con
        // él, `renewConn` decide si sigue valiendo (misma encarnación) o hay que rehacerlo (recargó
        // la página).
        this.left.delete(msg.peer.peerId);
        this.renewConn(msg.peer, false, 'signaling');
        break;
      case 'peer-left':
        // Solo se le cierra la puerta al que dijo que se iba.
        //
        // Antes se cerraba siempre, y ahí había una forma silenciosa de romper una partida: a un
        // jugador se le caía el WebSocket un segundo —el túnel parpadea, el móvil se duerme— y el
        // servidor se lo contaba a todos como si se hubiera marchado. Todos derribaban sus canales
        // directos con él, que estaban SANOS, y como él ya no tenía señalización no podía rehacer
        // ninguno. Acababa mirando una partida que para los demás seguía, sin un solo error.
        //
        // El WebSocket no es por donde se juega. Que se caiga no dice nada sobre si alguien sigue
        // ahí: eso lo sabe el canal directo (si sigue abierto, sigue ahí) y, si muere, lo decide el
        // detector de fallos por ausencia de latidos. Este mensaje ya no manda sobre eso.
        if (msg.reason === 'bye') {
          this.left.add(msg.peerId);
          this.dropConn(msg.peerId);
        }
        break;
      case 'signal':
        void this.onPeerSignal(msg.from, msg.data as Signal, 'signaling');
        break;
      case 'room-full':
        // No cabemos, y esto es un "no" definitivo, no un corte de red. Si dejáramos que el
        // `onclose` de siempre programara la reconexión, estaríamos aporreando con backoff una
        // puerta que ya nos dijo que está llena, para siempre. Se cierra la sala y se avisa arriba,
        // que es quien tiene una pantalla para explicarlo.
        this.emit('full', msg.max);
        this.destroy();
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
  private renewConn(info: PeerInfo, initiator: boolean, via: Via): void {
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
    this.createConn(info, initiator, via);
  }

  /**
   * El introductor puede ser un fantasma: su WebSocket sigue en pie pero al otro lado no hay
   * nadie. Como ahora es la ÚNICA puerta de entrada, hay que notarlo y pedir otro.
   *
   * La condición no es "no se abrió el canal con él", sino **"no tengo canal abierto con nadie"**:
   * si ya estoy dentro de la malla (por ejemplo, porque solo se cayó y volvió la señalización y mis
   * canales seguían sanos), no hay ninguna puerta que forzar.
   */
  private watchIntroducer(): void {
    if (this.closed || this.introTimer) return;
    this.introTimer = setTimeout(() => {
      this.introTimer = undefined;
      if (this.closed || this.openPeers().length > 0) return;
      this.sendSignaling({
        t: 'introduce',
        room: this.roomId,
        peerId: this.self.peerId,
        tried: [...this.tried],
      });
    }, INTRODUCER_TIMEOUT);
  }

  /**
   * El canal directo con un peer murió, pero el peer sigue en la sala (no llegó su `peer-left`):
   * fue un corte de red, no una salida. Reintentamos el handshake. Para no chocar de frente
   * (ambos ofreciendo a la vez), inicia solo el del peerId mayor; el otro espera la oferta.
   */
  private retryPeer(info: PeerInfo, via: Via): void {
    if (this.closed || this.left.has(info.peerId)) return;
    const attempts = this.peerRetries.get(info.peerId) ?? 0;
    if (attempts >= PEER_RETRY_LIMIT) return;
    this.peerRetries.set(info.peerId, attempts + 1);

    setTimeout(() => {
      if (this.closed || this.left.has(info.peerId) || this.conns.has(info.peerId)) return;
      this.createConn(info, this.self.peerId > info.peerId, via);
    }, PEER_RETRY_DELAY);
  }

  // --- Conexiones WebRTC ----------------------------------------------------
  private createConn(info: PeerInfo, initiator: boolean, via: Via): Conn {
    const existing = this.conns.get(info.peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const conn: Conn = { info, pc, open: false, via };
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
      // Acabo de ganar un vecino: se lo cuento a TODOS (a él, quiénes hay; a los demás, que llegó
      // él). Es lo que sustituye al censo que antes repartía el servidor.
      this.gossipRoster();
    };
    channel.onclose = () => this.dropConn(conn.info.peerId, true);
    channel.onmessage = (e) => {
      let data: unknown;
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return; /* mensaje no-JSON: ignorado */
      }
      // La señalización por la malla no sube: se queda aquí, que es de quien es. Arriba solo llegan
      // los mensajes del juego.
      if (esMeshMsg(data)) {
        this.onMeshMsg(conn.info.peerId, data);
        return;
      }
      this.emit('message', { from: conn.info.peerId, data });
    };
  }

  // --- Señalización por la malla --------------------------------------------
  //
  // Lo que sigue es el servidor de señalización, pero hecho por los peers. Tres piezas: contar
  // quién hay (`gossipRoster`), llevar una señal hasta su destinatario dando saltos (`forward`) y
  // atender lo que llega (`onMeshMsg`).

  /** Peers con los que tengo canal ABIERTO: los únicos por los que puedo retransmitir nada. */
  private openPeers(): PeerInfo[] {
    return [...this.conns.values()].filter((c) => c.open).map((c) => c.info);
  }

  private sendMesh(peerId: string, msg: MeshMsg): boolean {
    const conn = this.conns.get(peerId);
    if (!conn?.open || !conn.channel) return false;
    conn.channel.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Cuenta a cada vecino con quién más estoy hablando (excluyéndole a él, que ya se sabe).
   *
   * Se llama cada vez que se abre un canal, y por eso converge: cuando entra alguien nuevo, su
   * introductor le manda la mesa entera Y le cuenta a la mesa que llegó él. Los dos lados acaban
   * sabiendo del otro, y la regla del `peerId` mayor decide quién ofrece.
   */
  private gossipRoster(): void {
    const abiertos = this.openPeers();
    for (const vecino of abiertos) {
      const peers = abiertos.filter((p) => p.peerId !== vecino.peerId);
      if (peers.length > 0) this.sendMesh(vecino.peerId, { k: MESH_SIGNAL, t: 'roster', peers });
    }
  }

  /**
   * Empuja un relay hacia su destinatario.
   *
   * Primero por el camino corto: si tengo canal con él, se lo doy en mano. Si no, se inunda a los
   * vecinos —menos al que me lo pasó— y que lo lleven ellos. La inundación es tosca, pero en una
   * malla de diez donde casi todos se ven con casi todos, "casi siempre" es un solo salto; el
   * `hop` la corta y el `id` descarta las copias que lleguen por varios caminos.
   */
  private forward(msg: MeshMsg & { t: 'relay' }, exceptoDe: string | null): boolean {
    if (this.sendMesh(msg.to, msg)) return true;
    if (msg.hop >= MESH_MAX_HOPS) return false;
    const siguiente = { ...msg, hop: msg.hop + 1 };
    let enviado = false;
    for (const vecino of this.openPeers()) {
      if (vecino.peerId === exceptoDe || vecino.peerId === msg.to) continue;
      enviado = this.sendMesh(vecino.peerId, siguiente) || enviado;
    }
    return enviado;
  }

  /** ¿Ya pasó por aquí este relay? La inundación hace que la misma señal llegue por varios lados. */
  private yaVisto(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) this.seen.delete(this.seenOrder.shift()!);
    return false;
  }

  private onMeshMsg(from: string, msg: MeshMsg): void {
    if (this.closed) return;

    if (msg.t === 'roster') {
      for (const info of msg.peers) {
        if (info.peerId === this.self.peerId) continue;
        // Estaba en la lista de "se fueron" y resulta que alguien tiene un canal ABIERTO con él:
        // ha vuelto. Y esto no es un detalle — desde que el servidor solo avisa al introductor, el
        // `peer-joined` del que regresa no lo ve el resto de la mesa. Sin esto, un jugador que
        // recarga se reconectaría con su introductor y con nadie más, y los demás lo darían por
        // ido para siempre. El censo de la malla es mejor fuente que el servidor: solo se anuncian
        // canales abiertos, así que aparecer en uno ES la prueba de vida.
        this.left.delete(info.peerId);
        if (this.conns.has(info.peerId)) continue;
        // Los dos lados calculan esto igual y sale lo contrario en cada uno: uno ofrece, el otro
        // espera. Sin la regla, dos peers que se descubren a la vez se ofrecen a la vez y ninguna
        // de las dos ofertas prospera.
        if (this.self.peerId > info.peerId) this.createConn(info, true, 'mesh');
      }
      return;
    }

    if (this.yaVisto(msg.id)) return;

    // No es para mí: la paso. (Retransmitir señalización ajena es exactamente el trabajo que antes
    // hacía el servidor, y ahora lo hace cualquiera que tenga un canal abierto.)
    if (msg.to !== this.self.peerId) {
      this.forward(msg, from);
      return;
    }

    // Si lo tenía por ido, ya no: me está ofreciendo conexión por la malla, o sea que está de
    // vuelta. Mismo razonamiento que en el censo de arriba.
    this.left.delete(msg.from);
    void this.onPeerSignal(msg.from, msg.data, 'mesh', msg.peer);
  }

  /**
   * Llega una señal WebRTC de `from`, por donde sea. Si aún no tenía conexión con él, se crea aquí
   * en modo "el que contesta".
   *
   * `info` viene cuando la señal llegó por la malla: es la ficha del emisor, que el servidor ya no
   * nos presentó. Sin ella, el peer entraría en la mesa llamándose como su propio identificador.
   */
  private async onPeerSignal(
    from: string,
    signal: Signal,
    via: Via,
    info?: PeerInfo,
  ): Promise<void> {
    let conn = this.conns.get(from);
    if (!conn) conn = this.createConn(info ?? { peerId: from, name: from }, false, via);
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

  /**
   * Manda una señal WebRTC a `to`, por el camino que le corresponda.
   *
   * Aquí es donde el servidor deja de ver los N-1 handshakes: si esta conexión se está negociando
   * por la malla, la señal se va por los DataChannels y el servidor no se entera.
   *
   * El `sendSignaling` del final es a la vez el camino del primer contacto y la red de seguridad:
   * si la malla no encontró por dónde llevarla (todos mis vecinos se cayeron a la vez, por
   * ejemplo), mejor entrar por el servidor que no entrar.
   */
  private relay(to: string, signal: Signal): void {
    const conn = this.conns.get(to);
    if (conn?.via === 'mesh') {
      const id = `${this.self.peerId}:${this.relayTag}:${++this.relaySeq}`;
      // Se apunta como visto ANTES de soltarlo. La inundación puede devolvérmelo dando la vuelta a
      // la malla, y sin esto lo volvería a inundar yo: cada vuelta multiplicaría las copias en vez
      // de morirse. Que la mía sea la primera marca lo corta en seco.
      this.yaVisto(id);
      const sobre = {
        k: MESH_SIGNAL,
        t: 'relay',
        id,
        hop: 0,
        from: this.self.peerId,
        to,
        peer: this.self,
        data: signal,
      } as const;
      if (this.forward(sobre, null)) return;
    }
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
    if (retry) this.retryPeer(conn.info, conn.via);
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
    if (this.introTimer) clearTimeout(this.introTimer);
    this.sendSignaling({ t: 'leave', room: this.roomId, peerId: this.self.peerId });
    for (const id of [...this.conns.keys()]) this.dropConn(id);
    this.ws?.close();
  }
}

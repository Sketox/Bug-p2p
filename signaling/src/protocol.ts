// Protocolo de señalización (WebSocket). SOLO sirve para el handshake WebRTC:
// presentar peers y reenviar ofertas/respuestas ICE. No transporta nada del juego.
// ⚠️ Debe mantenerse en sync con `net/src/protocol.ts`.

export interface PeerInfo {
  peerId: string;
  name: string;
  /**
   * Encarnación: qué CONEXIÓN es, no quién es. Nueva en cada carga de la página.
   *
   * El `peerId` es estable a propósito (sobrevive a un F5, y por eso recuperas tu mano). Pero eso
   * dejaba dos situaciones indistinguibles para la malla: "este peer recargó" (su WebRTC es nuevo,
   * mi canal con él ya no sirve) y "solo se cayó la señalización" (su WebRTC sigue vivo, mi canal
   * es perfecto). Con la encarnación se distinguen: mismo peerId + misma encarnación = el mismo
   * navegador de siempre, no hay nada que rehacer.
   *
   * Opcional: si no viene, la malla renueva el canal por si acaso (que es lo que hacía siempre).
   */
  epoch?: string;
}

/** Mensajes que el cliente envía al servidor. */
export type ClientMsg =
  /**
   * Entrar (o volver) a una sala.
   *
   * `secret` es lo que convierte al `peerId` en TUYO. El `peerId` es público —viaja en el censo de
   * la malla, cualquiera de la mesa lo ve— y el servidor desaloja la sesión anterior cuando ese
   * peerId vuelve, porque así es como funciona la reconexión tras un F5. Sin un secreto, esas dos
   * cosas juntas son un botón para echar a alguien de su propia partida y ocupar su sitio: basta
   * con decir que eres él (ataque S3 del banco de seguridad).
   *
   * Nunca sale del navegador que lo generó salvo hacia el servidor, y no se comparte con los demás
   * jugadores. Es opcional para no romper a un cliente viejo, pero un peerId reclamado con secreto
   * solo se recupera presentando el mismo.
   */
  | { t: 'join'; room: string; peerId: string; name: string; epoch?: string; secret?: string }
  | { t: 'signal'; room: string; from: string; to: string; data: unknown }
  /**
   * "El introductor que me diste no contesta: dame otro."
   *
   * Desde que el servidor solo presenta a UNO (ver `ServerMsg.peers`), ese uno se volvió un punto
   * único de fallo para entrar: si su WebSocket sigue abierto pero el navegador ya no está —cerró
   * el portátil, se durmió el móvil—, el que llega se queda en la puerta para siempre. Con esto
   * pide otro, diciendo a cuáles ya intentó. Cuando no queden candidatos, el servidor contesta con
   * la lista vacía y se acabó.
   */
  | { t: 'introduce'; room: string; peerId: string; tried: string[] }
  | { t: 'leave'; room: string; peerId: string };

/** Mensajes que el servidor envía al cliente. */
export type ServerMsg =
  /**
   * Con quién empezar. **Es UNO, no el censo**: el introductor.
   *
   * El que llega hace un solo handshake por aquí, y el resto de presentaciones —con los otros N-1
   * jugadores— viajan ya por la malla, retransmitidas por ese introductor (ver `MeshMsg` en
   * `net/src/protocol.ts`). Así el servidor deja de ver N handshakes y pasa a ver uno: se queda en
   * nodo de arranque, como las semillas DNS de Bitcoin o los bootstrap de IPFS.
   *
   * Va como lista, y no como un solo peer, porque a veces son cero (la sala está vacía: eres el
   * primero) y porque el formato admite ampliarlo sin tocar al cliente.
   */
  | { t: 'peers'; peers: PeerInfo[] }
  /**
   * "Llegó alguien y va a ofrecerte conexión: espérale."
   *
   * Ya NO va a toda la sala: solo al introductor elegido. Los demás se enteran del recién llegado
   * por la malla (el introductor les pasa su censo), no por aquí.
   */
  | { t: 'peer-joined'; peer: PeerInfo }
  /**
   * Alguien ya no está en el tablón de anuncios. **`reason` importa mucho**, porque son dos cosas
   * completamente distintas que antes llegaban idénticas:
   *
   *   `bye`     → lo dijo él (mensaje `leave`): cerró la sala a propósito. Se ha ido.
   *   `offline` → se le cayó el WebSocket. Eso es perder la SEÑALIZACIÓN, no irse de la partida:
   *               sus canales directos con los demás pueden estar perfectamente vivos, y las cartas
   *               viajan por ahí, no por aquí.
   *
   * Sin la distinción, un parpadeo de red de un jugador hacía que TODOS los demás derribaran sus
   * canales sanos con él y lo dejaran fuera de una partida que seguía funcionando para él.
   */
  | { t: 'peer-left'; peerId: string; reason?: 'bye' | 'offline' }
  | { t: 'signal'; from: string; data: unknown } // señal WebRTC reenviada
  | { t: 'room-full'; max: number } // no cabes: la sala llegó a su aforo
  | { t: 'error'; message: string };

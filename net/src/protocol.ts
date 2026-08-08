// Protocolo de señalización visto desde el cliente (mirror de `signaling/src/protocol.ts`).
export interface PeerInfo {
  peerId: string;
  name: string;
  /** Encarnación: qué CONEXIÓN es, no quién es. Nueva en cada carga de la página. Ver el mirror. */
  epoch?: string;
}

export type ClientMsg =
  /** `secret` prueba que el `peerId` es tuyo al volver de un F5. Ver el mirror. */
  | { t: 'join'; room: string; peerId: string; name: string; epoch?: string; secret?: string }
  | { t: 'signal'; room: string; from: string; to: string; data: unknown }
  /** "El introductor que me diste no contesta: dame otro." Ver el mirror. */
  | { t: 'introduce'; room: string; peerId: string; tried: string[] }
  | { t: 'leave'; room: string; peerId: string };

export type ServerMsg =
  /** Con quién empezar. Es UNO (el introductor), no el censo. Ver el mirror. */
  | { t: 'peers'; peers: PeerInfo[] }
  | { t: 'peer-joined'; peer: PeerInfo }
  /** Se fue (`bye`) o se le cayó el socket (`offline`). No es lo mismo — ver el mirror. */
  | { t: 'peer-left'; peerId: string; reason?: 'bye' | 'offline' }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'room-full'; max: number }
  | { t: 'error'; message: string };

/** Señales WebRTC que viajan por el canal de señalización (dentro de `data`). */
export type Signal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

// --- Señalización POR LA MALLA ----------------------------------------------------------------
//
// Todo lo de arriba pasa por el servidor. Lo de aquí abajo NO: viaja por los DataChannels que ya
// están abiertos, de navegador a navegador. Es la parte que hace que el servidor solo haga falta
// para el PRIMER contacto.
//
// La idea: el que llega hace un único handshake por el servidor, con el introductor. En cuanto
// tiene ese canal, el introductor le pasa su censo (`roster`) y las presentaciones con el resto de
// la mesa viajan como `relay` **retransmitidas por los peers**. Si el servidor se muere justo
// después del primer contacto, el recién llegado completa su malla igual.

/**
 * Clave reservada para la señalización que viaja por la malla.
 *
 * `Room` es transporte puro —lleva el JSON que le den, sin mirarlo— salvo por esta clave, que
 * intercepta y no entrega arriba. Empieza por `~` justo para no chocar nunca con los mensajes de
 * juego (`lobby`, `event`, `token`…), que son palabras normales.
 */
export const MESH_SIGNAL = '~sig';

/** Cuántos peers puede atravesar un `relay` antes de darse por perdido. */
export const MESH_MAX_HOPS = 3;

export type MeshMsg =
  /**
   * Una señal WebRTC (offer/answer/ICE) dirigida a `to`, que va a llegar dando saltos por la malla.
   *
   * Lleva la ficha del emisor (`peer`) porque el destinatario puede no haber oído hablar de él
   * nunca: sin esto lo daría de alta con su peerId de nombre y saldría un "a3f9…" en la mesa.
   *
   * `id` es para descartar duplicados: cuando no hay canal directo con `to` se inunda a todos los
   * vecinos, y en una malla casi completa la misma señal llega por varios caminos. Aplicar dos
   * veces la misma oferta rompe el handshake.
   */
  | {
      k: typeof MESH_SIGNAL;
      t: 'relay';
      id: string;
      hop: number;
      from: string;
      to: string;
      peer: PeerInfo;
      data: Signal;
    }
  /**
   * "Estos son los peers con los que YO tengo canal abierto ahora mismo."
   *
   * Es el sustituto del censo que antes daba el servidor, y se cotillea: cada vez que se me abre un
   * canal se lo mando a todos mis vecinos. Solo van los canales ABIERTOS, y eso no es un detalle —
   * es lo que garantiza que quien reciba el censo tenga un camino real por el que hacerle llegar su
   * oferta a ese peer.
   */
  | { k: typeof MESH_SIGNAL; t: 'roster'; peers: PeerInfo[] };

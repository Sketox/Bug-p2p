// Protocolo de señalización visto desde el cliente (mirror de `signaling/src/protocol.ts`).
export interface PeerInfo {
  peerId: string;
  name: string;
  /** Encarnación: qué CONEXIÓN es, no quién es. Nueva en cada carga de la página. Ver el mirror. */
  epoch?: string;
}

export type ClientMsg =
  | { t: 'join'; room: string; peerId: string; name: string; epoch?: string }
  | { t: 'signal'; room: string; from: string; to: string; data: unknown }
  | { t: 'leave'; room: string; peerId: string };

export type ServerMsg =
  | { t: 'peers'; peers: PeerInfo[] }
  | { t: 'peer-joined'; peer: PeerInfo }
  | { t: 'peer-left'; peerId: string }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'room-full'; max: number }
  | { t: 'error'; message: string };

/** Señales WebRTC que viajan por el canal de señalización (dentro de `data`). */
export type Signal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

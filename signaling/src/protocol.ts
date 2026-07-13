// Protocolo de señalización (WebSocket). SOLO sirve para el handshake WebRTC:
// presentar peers y reenviar ofertas/respuestas ICE. No transporta nada del juego.
// ⚠️ Debe mantenerse en sync con `net/src/protocol.ts`.

export interface PeerInfo {
  peerId: string;
  name: string;
}

/** Mensajes que el cliente envía al servidor. */
export type ClientMsg =
  | { t: 'join'; room: string; peerId: string; name: string }
  | { t: 'signal'; room: string; from: string; to: string; data: unknown }
  | { t: 'leave'; room: string; peerId: string };

/** Mensajes que el servidor envía al cliente. */
export type ServerMsg =
  | { t: 'peers'; peers: PeerInfo[] } // peers ya presentes (para el que entra)
  | { t: 'peer-joined'; peer: PeerInfo } // avisa a los demás
  | { t: 'peer-left'; peerId: string }
  | { t: 'signal'; from: string; data: unknown } // señal WebRTC reenviada
  | { t: 'error'; message: string };

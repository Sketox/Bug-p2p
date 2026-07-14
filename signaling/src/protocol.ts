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
  | { t: 'join'; room: string; peerId: string; name: string; epoch?: string }
  | { t: 'signal'; room: string; from: string; to: string; data: unknown }
  | { t: 'leave'; room: string; peerId: string };

/** Mensajes que el servidor envía al cliente. */
export type ServerMsg =
  | { t: 'peers'; peers: PeerInfo[] } // peers ya presentes (para el que entra)
  | { t: 'peer-joined'; peer: PeerInfo } // avisa a los demás
  | { t: 'peer-left'; peerId: string }
  | { t: 'signal'; from: string; data: unknown } // señal WebRTC reenviada
  | { t: 'room-full'; max: number } // no cabes: la sala llegó a su aforo
  | { t: 'error'; message: string };

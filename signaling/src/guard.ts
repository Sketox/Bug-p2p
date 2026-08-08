// Defensas del servidor de señalización: validación de entrada, límites de tasa y detección de
// repeticiones.
//
// Vive aparte del servidor por dos razones. Una, que así se prueba sola (`test/guard.test.ts`) sin
// levantar sockets. Y otra más importante para el reporte de V&V: cada función de aquí existe
// porque un ataque concreto del banco (`vv/security/attack-suite.mjs`) funcionó contra el servidor
// que había antes. El identificador del ataque está anotado en cada una.

import type { ClientMsg } from './protocol.js';

/** Tamaño máximo de un mensaje. Una señal WebRTC real ronda los 2-4 KB. (Ataque S7) */
export const MAX_PAYLOAD = 64 * 1024;
/** Salas simultáneas. El anfitrión es el portátil de un jugador, no un centro de datos. (S6) */
export const MAX_ROOMS = 200;
/** Conexiones abiertas a la vez en todo el servidor. (S6) */
export const MAX_SOCKETS = 512;
/**
 * Conexiones abiertas a la vez desde una misma dirección. (S6)
 *
 * Generoso a propósito: en una feria los jugadores salen por el NAT del edificio y el servidor los
 * ve a todos con la misma IP. El límite no está para contar personas, sino para que una sola
 * máquina no pueda abrir tres mil sockets y dejar sin arranque a los demás.
 */
export const MAX_SOCKETS_POR_IP = 64;
/** Longitudes máximas de los campos de texto que llegan de fuera. */
const MAX_ROOM = 16;
const MAX_ID = 64;
const MAX_NAME = 32;
const MAX_TRIED = 32;

const esTexto = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

const esTextoOpcional = (v: unknown, max: number): boolean =>
  v === undefined || (typeof v === 'string' && v.length <= max);

/**
 * Convierte lo que llegó por el cable en un mensaje del protocolo, o devuelve `null`.
 *
 * Que esto exista es la lección del ataque S8: el servidor daba por hecha la forma de lo que
 * recibía. Con `{ t: 'introduce', tried: 7 }` bastaba —`[...7]` lanza una excepción, y una
 * excepción dentro del manejador de `message` se lleva por delante el proceso entero— para que un
 * solo jugador tumbara la señalización de toda la sala desde la consola del navegador.
 *
 * La regla es sencilla: nada entra al servidor sin que aquí se haya comprobado su tipo, su largo y
 * su forma. Lo que no encaja se descarta; no se intenta arreglar.
 */
export function parseClientMsg(raw: string): ClientMsg | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;

  const m = msg as Record<string, unknown>;
  switch (m.t) {
    case 'join':
      if (!esTexto(m.room, MAX_ROOM) || !esTexto(m.peerId, MAX_ID)) return null;
      if (!esTexto(m.name, MAX_NAME)) return null;
      if (!esTextoOpcional(m.epoch, MAX_ID) || !esTextoOpcional(m.secret, MAX_ID)) return null;
      return {
        t: 'join',
        room: m.room,
        peerId: m.peerId,
        name: m.name,
        epoch: m.epoch as string | undefined,
        secret: m.secret as string | undefined,
      };

    case 'signal':
      if (!esTexto(m.room, MAX_ROOM) || !esTexto(m.from, MAX_ID) || !esTexto(m.to, MAX_ID)) {
        return null;
      }
      // `data` va opaco a propósito: aquí no se interpreta SDP. Solo se exige que sea un objeto,
      // porque lo único que se hace con él es reenviarlo.
      if (typeof m.data !== 'object' || m.data === null) return null;
      return { t: 'signal', room: m.room, from: m.from, to: m.to, data: m.data };

    case 'introduce': {
      if (!esTexto(m.room, MAX_ROOM) || !esTexto(m.peerId, MAX_ID)) return null;
      if (!Array.isArray(m.tried) || m.tried.length > MAX_TRIED) return null;
      if (!m.tried.every((x) => esTexto(x, MAX_ID))) return null;
      return { t: 'introduce', room: m.room, peerId: m.peerId, tried: m.tried as string[] };
    }

    case 'leave':
      if (!esTexto(m.room, MAX_ROOM) || !esTexto(m.peerId, MAX_ID)) return null;
      return { t: 'leave', room: m.room, peerId: m.peerId };

    default:
      return null;
  }
}

/**
 * Cubo de fichas por conexión. (Ataque S5)
 *
 * Se rellena a `porSegundo` y admite ráfagas de `capacidad`, que es la forma correcta de limitar
 * esto: al entrar en una sala se mandan varios mensajes seguidos (join, y luego una tanda de
 * candidatos ICE que el navegador escupe de golpe), así que un límite plano por segundo cortaría
 * conexiones legítimas. Lo que no es legítimo es mantener el ritmo alto indefinidamente.
 */
export class Cubo {
  private fichas: number;
  private ultimo: number;

  /**
   * El instante inicial entra por parámetro, como el reloj del detector de fallos: así los tests
   * miden con un reloj virtual y no hay que dormir tres segundos para comprobar que se rellena.
   */
  constructor(
    private readonly capacidad = 120,
    private readonly porSegundo = 40,
    desde = Date.now(),
  ) {
    this.fichas = capacidad;
    this.ultimo = desde;
  }

  /** ¿Se admite este mensaje? `false` = pasarse de la raya. */
  admite(ahora = Date.now()): boolean {
    this.fichas = Math.min(
      this.capacidad,
      this.fichas + ((ahora - this.ultimo) / 1000) * this.porSegundo,
    );
    this.ultimo = ahora;
    if (this.fichas < 1) return false;
    this.fichas -= 1;
    return true;
  }
}

/**
 * Detector de repeticiones para las señales. (Ataque S4)
 *
 * Reenviar veinte veces la misma oferta capturada no cuesta nada al atacante y le rompe el
 * handshake al que la recibe: aplicar dos veces una oferta deja la `RTCPeerConnection` en un estado
 * del que no vuelve.
 *
 * Se puede descartar por igualdad exacta sin miedo a estorbar al tráfico legítimo, y la razón está
 * en el propio WebRTC: cada SDP lleva su `ice-ufrag` y su `ice-pwd`, que se sortean por sesión, y
 * cada candidato ICE es distinto del anterior. Dos señales byte a byte idénticas en cinco segundos
 * no son un reintento: son la misma señal dos veces.
 */
export class Repeticiones {
  private vistas = new Map<string, number>();

  constructor(private readonly ventanaMs = 5000) {}

  /** `true` si esta señal ya se vio dentro de la ventana. */
  repetida(clave: string, ahora = Date.now()): boolean {
    // Limpieza perezosa: no hace falta un temporizador para algo que se consulta constantemente.
    if (this.vistas.size > 512) {
      for (const [k, t] of this.vistas) if (ahora - t > this.ventanaMs) this.vistas.delete(k);
    }
    const antes = this.vistas.get(clave);
    if (antes !== undefined && ahora - antes <= this.ventanaMs) return true;
    this.vistas.set(clave, ahora);
    return false;
  }
}

/** La huella de una señal, para compararla con las anteriores. */
export function huellaSenal(from: string, to: string, data: unknown): string {
  return `${from}>${to}:${JSON.stringify(data)}`;
}

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, PeerInfo, ServerMsg } from './protocol.js';

// Servidor de señalización de Bug.
//
// Responsabilidad única, y desde la señalización por la malla, MÁS PEQUEÑA que antes: presentar al
// que llega con **un** peer de la sala (el introductor) y reenviar ese único handshake. Las demás
// presentaciones —con los otros N-1 jugadores— ya no pasan por aquí: viajan por los DataChannels,
// retransmitidas por los propios peers (ver `MeshMsg` en `net/src/protocol.ts`).
//
// Lo que queda aquí es el arranque, que es irreducible: dos máquinas que no se conocen no pueden
// encontrarse solas. Es el mismo papel que las semillas DNS de Bitcoin o los nodos bootstrap de
// IPFS — dar el primer contacto y apartarse.
//
// No conoce cartas, turnos ni estado de juego (eso vive 100% en los nodos).

const PORT = Number(process.env.PORT ?? 8787);

/**
 * Aforo de una sala. Es el `MAX_PLAYERS` del motor, copiado a mano.
 *
 * Copiado, y no importado, por lo mismo que el protocolo vive duplicado aquí: este servidor no
 * depende del juego —no sabe qué es una carta— y así puede desplegarse solo. Un test ata las dos
 * copias, que para eso está.
 *
 * Y se hace cumplir AQUÍ, no en el navegador, porque es el único sitio donde contar es fiable: si
 * cada cliente contase por su cuenta, dos personas entrando a la vez verían nueve y pasarían las
 * dos. El servidor atiende los `join` de uno en uno.
 */
export const AFORO = 10;

interface Client {
  ws: WebSocket;
  peerId: string;
  name: string;
  room: string;
  /** Qué carga de la página es esta (ver `PeerInfo.epoch`). Se reenvía tal cual: aquí no se mira. */
  epoch?: string;
}

/** room -> peerId -> Client */
const rooms = new Map<string, Map<string, Client>>();

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomPeers(room: string): Map<string, Client> {
  let r = rooms.get(room);
  if (!r) {
    r = new Map();
    rooms.set(room, r);
  }
  return r;
}

const info = (c: Client): PeerInfo => ({ peerId: c.peerId, name: c.name, epoch: c.epoch });

/**
 * A quién presentar al que llega.
 *
 * Se elige **el más antiguo** de la sala (el `Map` conserva el orden de entrada) que no esté en
 * `descartados`. No es arbitrario: el introductor tiene que pasarle al nuevo el censo de la mesa, y
 * solo puede contar los canales que ya tiene abiertos. El más antiguo es justamente el que más
 * tiene; el último en entrar podría estar todavía a medio handshake y darle un censo vacío.
 *
 * Devuelve `undefined` cuando no queda nadie: sala vacía (eres el primero) o ya se intentó con
 * todos. Ambos casos se contestan igual, con la lista vacía.
 */
function pickIntroducer(
  peers: Map<string, Client>,
  descartados: Set<string>,
): Client | undefined {
  for (const c of peers.values()) {
    if (!descartados.has(c.peerId)) return c;
  }
  return undefined;
}

/**
 * Sacar a alguien del tablón, diciendo por qué.
 *
 * `bye` solo cuando lo pide él con un `leave`. Un socket que se cierra es `offline`, y punto: desde
 * aquí no hay forma de distinguir "cerró la pestaña" de "se le fue el WiFi un segundo", y **tratar
 * lo segundo como una marcha rompía partidas**. Quien sí puede distinguirlo es cada jugador, que
 * tiene un canal directo con él y sabe si sigue respondiendo.
 */
function leave(client: Client, reason: 'bye' | 'offline'): void {
  const r = rooms.get(client.room);
  if (!r) return;
  // Si el peerId ya lo ocupa OTRA conexión, este cliente es una sesión vieja que fue reemplazada
  // por una reconexión (Fase 5): su cierre no debe expulsar al que acaba de entrar.
  if (r.get(client.peerId) !== client) return;
  r.delete(client.peerId);
  for (const other of r.values()) {
    send(other.ws, { t: 'peer-left', peerId: client.peerId, reason });
  }
  if (r.size === 0) rooms.delete(client.room);
}

// Servidor HTTP para health-checks de la plataforma de deploy; el WebSocket comparte el puerto.
const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('bug-signaling ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let self: Client | null = null;

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      send(ws, { t: 'error', message: 'JSON inválido' });
      return;
    }

    switch (msg.t) {
      case 'join': {
        const peers = roomPeers(msg.room);
        // Reconexión (Fase 5): el mismo peerId vuelve tras una caída de red. La sesión anterior
        // puede seguir "abierta" en el servidor (el cierre TCP tarda en notarse), así que la
        // desalojamos y dejamos entrar a la nueva. Sin esto, un jugador que se reconecta rápido
        // chocaría contra su propio fantasma y no podría volver a su partida.
        const stale = peers.get(msg.peerId);

        // Aforo. Solo lo choca quien NO estaba ya dentro: el que vuelve (mismo peerId) no ocupa una
        // plaza nueva, ocupa la suya. Cerrarle la puerta por "sala llena" a alguien que está EN la
        // partida —recargó la página, se le fue el WiFi— sería expulsarlo de su propio juego, que
        // es justo lo contrario de lo que este límite protege.
        if (!stale && peers.size >= AFORO) {
          send(ws, { t: 'room-full', max: AFORO });
          ws.close();
          return; // sin `self`: este cliente nunca entró, así que su cierre no expulsa a nadie
        }

        if (stale) {
          peers.delete(msg.peerId);
          try {
            stale.ws.close();
          } catch {
            /* ya estaba muerta */
          }
        }
        self = { ws, peerId: msg.peerId, name: msg.name, room: msg.room, epoch: msg.epoch };

        // Presentarle a UNO, no a todos. Aquí es donde el servidor se encoge: antes reenviaba N
        // handshakes (uno con cada jugador de la sala) y ahora reenvía uno. Los otros N-1 los hace
        // el recién llegado por la malla, a través de este introductor.
        const introductor = pickIntroducer(peers, new Set([msg.peerId]));
        send(ws, { t: 'peers', peers: introductor ? [info(introductor)] : [] });
        // Y avisar SOLO al introductor, que es quien tiene que esperar su oferta. Los demás se
        // enterarán de que llegó alguien por el censo que les cotillee él.
        if (introductor) send(introductor.ws, { t: 'peer-joined', peer: info(self) });

        peers.set(self.peerId, self);
        break;
      }

      case 'introduce': {
        // El introductor anterior no dio señales de vida. Se busca otro entre los que no ha
        // probado. Cuando se acaban, la lista vacía cierra el asunto: el cliente deja de pedir.
        const r = rooms.get(msg.room);
        if (!r) {
          send(ws, { t: 'peers', peers: [] });
          break;
        }
        const otro = pickIntroducer(r, new Set([msg.peerId, ...msg.tried]));
        send(ws, { t: 'peers', peers: otro ? [info(otro)] : [] });
        if (otro) {
          const yo = r.get(msg.peerId);
          if (yo) send(otro.ws, { t: 'peer-joined', peer: info(yo) });
        }
        break;
      }

      case 'signal': {
        const r = rooms.get(msg.room);
        const target = r?.get(msg.to);
        if (target) send(target.ws, { t: 'signal', from: msg.from, data: msg.data });
        break;
      }

      case 'leave': {
        if (self) leave(self, 'bye'); // lo pidió él: esto sí es marcharse
        self = null;
        break;
      }
    }
  });

  // El socket se cerró sin avisar. Puede ser cualquier cosa —cerró la pestaña, se durmió el móvil,
  // parpadeó el WiFi— y desde aquí son indistinguibles. Así que se cuenta como lo que es: perdió la
  // señalización. Si además dejó de jugar, lo notarán sus compañeros por falta de latidos.
  ws.on('close', () => {
    if (self) leave(self, 'offline');
  });
  ws.on('error', () => {
    if (self) leave(self, 'offline');
  });
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[signaling] escuchando en :${PORT} (ws + http /health)`);
});

// Para las pruebas: poder apagarlo al terminar (con `PORT=0` el sistema elige un puerto libre).
export { httpServer };

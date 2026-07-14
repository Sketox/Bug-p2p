import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, PeerInfo, ServerMsg } from './protocol.js';

// Servidor de señalización de Bug.
// Responsabilidad única: agrupar peers por sala y reenviar sus señales WebRTC.
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

function leave(client: Client): void {
  const r = rooms.get(client.room);
  if (!r) return;
  // Si el peerId ya lo ocupa OTRA conexión, este cliente es una sesión vieja que fue reemplazada
  // por una reconexión (Fase 5): su cierre no debe expulsar al que acaba de entrar.
  if (r.get(client.peerId) !== client) return;
  r.delete(client.peerId);
  for (const other of r.values()) {
    send(other.ws, { t: 'peer-left', peerId: client.peerId });
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
        // Avisar al recién llegado quiénes ya están.
        const existing: PeerInfo[] = [...peers.values()].map((c) => ({
          peerId: c.peerId,
          name: c.name,
          epoch: c.epoch,
        }));
        send(ws, { t: 'peers', peers: existing });
        // Avisar a los demás que llegó alguien.
        for (const other of peers.values()) {
          send(other.ws, {
            t: 'peer-joined',
            peer: { peerId: self.peerId, name: self.name, epoch: self.epoch },
          });
        }
        peers.set(self.peerId, self);
        break;
      }

      case 'signal': {
        const r = rooms.get(msg.room);
        const target = r?.get(msg.to);
        if (target) send(target.ws, { t: 'signal', from: msg.from, data: msg.data });
        break;
      }

      case 'leave': {
        if (self) leave(self);
        self = null;
        break;
      }
    }
  });

  ws.on('close', () => {
    if (self) leave(self);
  });
  ws.on('error', () => {
    if (self) leave(self);
  });
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[signaling] escuchando en :${PORT} (ws + http /health)`);
});

// Para las pruebas: poder apagarlo al terminar (con `PORT=0` el sistema elige un puerto libre).
export { httpServer };

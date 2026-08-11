import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { PeerInfo, ServerMsg } from './protocol.js';
import {
  Cubo,
  MAX_PAYLOAD,
  MAX_ROOMS,
  MAX_SOCKETS,
  MAX_SOCKETS_POR_IP,
  Repeticiones,
  huellaSenal,
  parseClientMsg,
} from './guard.js';

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

/**
 * room -> peerId -> secreto con el que se reclamó.
 *
 * Va aparte de `rooms` porque tiene que sobrevivir a que el socket se caiga: justo mientras estás
 * desconectado es cuando alguien podría intentar quedarse con tu sitio. Se borra entera cuando la
 * sala se queda vacía, que es cuando la partida ya no existe.
 */
const claims = new Map<string, Map<string, string>>();

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
  // Quien dice adiós suelta también su reserva del peerId: no va a volver.
  if (reason === 'bye') claims.get(client.room)?.delete(client.peerId);
  if (r.size === 0) {
    rooms.delete(client.room);
    // Sala vacía = partida terminada. Guardar las reservas de nadie sería una fuga de memoria
    // lenta y, encima, dejaría peerIds bloqueados para siempre.
    claims.delete(client.room);
  }
}

// Servidor HTTP para health-checks de la plataforma de deploy; el WebSocket comparte el puerto.
//
// `HEAD` cuenta tanto como `GET`, y no es un detalle académico: es el método con el que sondean por
// defecto media docena de herramientas —`wait-on`, que es quien espera al servidor antes de lanzar
// las pruebas de extremo a extremo, entre ellas— y varios balanceadores. Con solo `GET`, el
// servidor estaba vivo y contestando y aun así se le daba por caído. Node no deriva `HEAD` de
// `GET` por su cuenta; sí se encarga de no mandar el cuerpo cuando el método es `HEAD`.
const httpServer = createServer((req, res) => {
  const sondeo = req.method === 'GET' || req.method === 'HEAD';
  if (sondeo && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('bug-signaling ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

// Techo de conexiones, aplicado en el SOCKET y no en el WebSocket. (Ataque S6)
//
// Tres mil conexiones desde una máquina dejaban el servidor tardando segundos hasta en contestar
// `/health`. No es un ataque sofisticado: es un bucle de veinte líneas. Y aquí el anfitrión es el
// portátil de un jugador, no un centro de datos.
//
// Lo importante es DÓNDE se corta. Rechazar al abrirse el WebSocket llega tarde: para entonces ya
// se pagó el handshake HTTP de cada intento, que es justo el trabajo que el atacante quiere que
// hagas. Cortando en `connection` del servidor TCP, el socket que se pasa de cuota se destruye
// antes de leer un solo byte.
//
// El límite por IP es el que de verdad protege: el techo global, por sí solo, deja que un atacante
// llene el cupo y expulse a todos los demás. Por IP, quien se pasa se queda sin sitio él.
const porIp = new Map<string, number>();
let abiertos = 0;

httpServer.on('connection', (socket) => {
  const ip = socket.remoteAddress ?? 'desconocida';
  const desdeEstaIp = porIp.get(ip) ?? 0;
  if (abiertos >= MAX_SOCKETS || desdeEstaIp >= MAX_SOCKETS_POR_IP) {
    socket.destroy();
    return;
  }
  abiertos++;
  porIp.set(ip, desdeEstaIp + 1);
  socket.once('close', () => {
    abiertos--;
    const n = (porIp.get(ip) ?? 1) - 1;
    if (n <= 0) porIp.delete(ip);
    else porIp.set(ip, n);
  });
});

// `maxPayload` corta los mensajes desmesurados en la propia librería, antes de que se copien a
// memoria: una señal WebRTC real ocupa unos kilobytes, y aceptar 32 MB era una forma barata de
// llenar la RAM del anfitrión desde una pestaña (ataque S7).
const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws) => {
  let self: Client | null = null;
  const cubo = new Cubo();
  const repeticiones = new Repeticiones();

  const rechazar = (motivo: string): void => {
    send(ws, { t: 'error', message: motivo });
    ws.close();
  };

  const manejar = (raw: unknown): void => {
    // Pasarse de ritmo cuesta la conexión. Con la ráfaga que admite el cubo, un cliente normal no
    // lo nota ni entrando a la sala (join + tanda de candidatos ICE de golpe). Ataque S5.
    if (!cubo.admite()) {
      rechazar('demasiados mensajes');
      return;
    }

    // Nada entra sin pasar por aquí: tipo, longitud y forma. Ataque S8.
    const msg = parseClientMsg(String(raw));
    if (!msg) {
      send(ws, { t: 'error', message: 'mensaje inválido' });
      return;
    }

    switch (msg.t) {
      case 'join': {
        // Una conexión, una sala. Sin esto, un solo socket podía darse de alta en miles de salas
        // (ataque S6) y, peor, `self` apuntaría a la última mientras las anteriores quedan
        // huérfanas en el mapa.
        if (self) {
          rechazar('ya estás en una sala');
          return;
        }
        // Techo de salas simultáneas. Se aplica solo a las salas NUEVAS: una partida en curso
        // nunca se queda sin sitio porque un atacante haya llenado el mapa.
        if (!rooms.has(msg.room) && rooms.size >= MAX_ROOMS) {
          rechazar('el servidor está al límite de salas');
          return;
        }

        // ¿Es tuyo este peerId? El secreto lo decide. Ataque S3.
        //
        // Reclamar una identidad que ya está en la sala exige presentar el mismo secreto con el
        // que se reservó, y un secreto vacío no vale para reclamar nada: si valiera, bastaría con
        // no mandarlo para volver a poder echar a cualquiera. Que un cliente antiguo (sin secreto)
        // no pueda recuperar su sitio tras un F5 es el precio, y es el correcto: perder la mano es
        // molesto, que te la robe otro es peor.
        const reservas = claims.get(msg.room) ?? new Map<string, string>();
        const reservado = reservas.get(msg.peerId);
        const presentado = msg.secret ?? '';
        if (reservado !== undefined && (presentado === '' || reservado !== presentado)) {
          rechazar('esa identidad ya está en uso');
          return;
        }

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
        // A partir de aquí, ese peerId de esa sala es de quien presentó este secreto.
        reservas.set(msg.peerId, presentado);
        claims.set(msg.room, reservas);

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
        //
        // Se pregunta por uno mismo y por la sala en la que se entró: los campos del mensaje no
        // mandan sobre quién eres. Si mandaran, cualquiera podría provocar que el servidor le
        // anunciara un `peer-joined` a un tercero en nombre de otro.
        if (msg.peerId !== self?.peerId || msg.room !== self.room) {
          send(ws, { t: 'error', message: 'no puedes pedir presentaciones para otro' });
          break;
        }
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
        // El `from` lo pone el servidor, no el cliente.
        //
        // Antes se reenviaba tal cual venía, y eso es exactamente un canal para colocarse en medio
        // (ataques S1 y S2): Mallory mandaba su propia oferta SDP firmada como Alice, Bob la
        // aceptaba creyendo que hablaba con Alice, y el DataChannel "cifrado extremo a extremo" de
        // Bob acababa cifrado contra Mallory. Ni siquiera hacía falta estar en la sala.
        //
        // Que el cifrado de WebRTC no ayude aquí es lo importante de entender: protege el
        // contenido del canal, no la identidad de quien lo abrió. Esa la garantiza —o no— la
        // señalización.
        if (msg.from !== self?.peerId || msg.room !== self.room) {
          send(ws, { t: 'error', message: 'solo puedes enviar señales en tu nombre' });
          break;
        }
        // Señal idéntica repetida en cinco segundos = repetición, no reintento (ataque S4).
        if (repeticiones.repetida(huellaSenal(msg.from, msg.to, msg.data))) break;

        const r = rooms.get(msg.room);
        const target = r?.get(msg.to);
        if (target) send(target.ws, { t: 'signal', from: self.peerId, data: msg.data });
        break;
      }

      case 'leave': {
        // El peerId del mensaje no se mira a propósito: solo puedes irte tú. Enviar un `leave` con
        // el nombre de otro sería expulsarlo, y un `bye` no es "se cayó" — es "se fue": los demás
        // lo sacan de la rotación de turnos y devuelven sus cartas al mazo.
        if (self) leave(self, 'bye');
        self = null;
        break;
      }
    }
  };

  // Cinturón, además de los tirantes de `parseClientMsg`.
  //
  // Node no tiene red de seguridad aquí: una excepción dentro de un manejador de eventos sube
  // hasta `uncaughtException` y **mata el proceso**. En un servidor de señalización eso significa
  // que un mensaje raro de un jugador deja sin arranque a toda la feria. La validación de entrada
  // debería impedirlo; esto es para el fallo que no se nos ocurrió.
  ws.on('message', (raw) => {
    try {
      manejar(raw);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[signaling] mensaje que reventó el manejador:', err);
      send(ws, { t: 'error', message: 'mensaje inválido' });
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

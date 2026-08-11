// Hace pasar señalización REAL del juego por el proxy de Burp, para que su historial de WebSockets
// enseñe mensajes del juego y no el recargador de Next.js.
//
//   node trafico-por-burp.mjs [proxy] [señalización]

import WebSocket from 'ws';
import { HttpProxyAgent } from 'http-proxy-agent';

const proxy = process.argv[2] ?? 'http://127.0.0.1:8081';
const url = process.argv[3] ?? 'ws://localhost:8787/ws';
const agent = new HttpProxyAgent(proxy);
const sala = 'BURP';

/** Un jugador: entra por el proxy, cuenta lo que le llega y habla cuando se le pide. */
function jugador(peerId, name) {
  const ws = new WebSocket(url, { agent });
  const recibido = [];
  ws.on('message', (b) => {
    const m = JSON.parse(b.toString());
    recibido.push(m.t);
    console.log(`  ${peerId} ← ${m.t}`);
  });
  ws.on('error', (e) => console.error(`  ${peerId} ✕`, e.message));
  return { ws, recibido, enviar: (m) => ws.send(JSON.stringify(m)) };
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const abierto = (j) => new Promise((r) => j.ws.on('open', r));

console.log(`\n  proxy ${proxy}  →  ${url}\n`);

const ana = jugador('p-ana', 'Ana');
await abierto(ana);
ana.enviar({ t: 'join', room: sala, peerId: 'p-ana', name: 'Ana', secret: 's-ana' });
await espera(400);

const beto = jugador('p-beto', 'Beto');
await abierto(beto);
beto.enviar({ t: 'join', room: sala, peerId: 'p-beto', name: 'Beto', secret: 's-beto' });
await espera(600);

// Un handshake WebRTC de verdad: oferta y respuesta cruzando el servidor.
beto.enviar({
  t: 'signal',
  room: sala,
  from: 'p-beto',
  to: 'p-ana',
  data: { type: 'offer', sdp: 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n' },
});
await espera(300);
ana.enviar({
  t: 'signal',
  room: sala,
  from: 'p-ana',
  to: 'p-beto',
  data: { type: 'answer', sdp: 'v=0\r\no=- 7614219274584779017 2 IN IP4 127.0.0.1\r\n' },
});
await espera(300);
ana.enviar({
  t: 'signal',
  room: sala,
  from: 'p-ana',
  to: 'p-beto',
  data: { candidate: 'candidate:1 1 udp 2130706431 192.168.1.42 54321 typ host' },
});
await espera(400);

beto.enviar({ t: 'leave', room: sala, peerId: 'p-beto' });
await espera(300);
ana.ws.close();
beto.ws.close();

console.log(`\n  Ana recibió: ${ana.recibido.join(', ') || '(nada)'}`);
console.log(`  Beto recibió: ${beto.recibido.join(', ') || '(nada)'}\n`);

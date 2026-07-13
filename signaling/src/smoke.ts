// Test de humo del servidor de señalización.
//
// 1) Dos clientes se unen a la misma sala: se descubren y las señales se reenvían de A a B.
// 2) Reconexión (Fase 5): B vuelve con el MISMO peerId tras caerse. El servidor debe desalojar
//    su sesión fantasma y dejarle entrar —si no, un jugador que se reconecta chocaría contra sí
//    mismo—, avisar a A de que ha vuelto, y encaminar las señales a la conexión NUEVA.
import { WebSocket } from 'ws';

const URL = process.env.SIG_URL ?? 'ws://localhost:8787';
const results: string[] = [];

const done = (ok: boolean, why = ''): never => {
  console.log(results.join('\n'));
  if (why) console.log(why);
  console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL');
  process.exit(ok ? 0 : 1);
};

setTimeout(() => done(false, 'timeout global'), 6000);

/** Cliente de prueba: conecta y recuerda lo que le llega. */
function client(): { ws: WebSocket; on: (t: string, fn: (m: any) => void) => void } {
  const ws = new WebSocket(URL);
  const handlers = new Map<string, (m: any) => void>();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    handlers.get(m.t)?.(m);
  });
  return { ws, on: (t, fn) => handlers.set(t, fn) };
}

const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));
const open = (ws: WebSocket) => new Promise<void>((r) => ws.on('open', () => r()));
/** Espera a que llegue un mensaje de tipo `t`, o falla por timeout. */
const expectMsg = (c: ReturnType<typeof client>, t: string, what: string) =>
  new Promise<any>((resolve) => {
    c.on(t, (m) => resolve(m));
    setTimeout(() => done(false, `no llegó: ${what}`), 4000);
  });

async function main() {
  // --- 1. Handshake normal ---------------------------------------------------
  const a = client();
  await open(a.ws);
  send(a.ws, { t: 'join', room: 'r1', peerId: 'A', name: 'Ana' });
  const peersA = await expectMsg(a, 'peers', 'censo inicial de A');
  results.push(`A ve peers iniciales: ${peersA.peers.length} (espera 0)`);

  const b = client();
  await open(b.ws);
  const aSeesB = expectMsg(a, 'peer-joined', 'A no vio entrar a B');
  send(b.ws, { t: 'join', room: 'r1', peerId: 'B', name: 'Beto' });
  const peersB = await expectMsg(b, 'peers', 'censo inicial de B');
  results.push(`B ve peers iniciales: ${peersB.peers.length} (espera 1: Ana)`);
  results.push(`A detecta que entró ${(await aSeesB).peer.name}`);

  const bSignal = expectMsg(b, 'signal', 'B no recibió la señal de A');
  send(a.ws, { t: 'signal', room: 'r1', from: 'A', to: 'B', data: { hello: 1 } });
  results.push(`B recibió señal de ${(await bSignal).from}`);

  // --- 2. B se cae y vuelve con el mismo peerId ------------------------------
  const bGone = new Promise<void>((r) => b.ws.on('close', () => r()));
  const b2 = client();
  await open(b2.ws);
  const aSeesReturn = expectMsg(a, 'peer-joined', 'A no vio volver a B');
  send(b2.ws, { t: 'join', room: 'r1', peerId: 'B', name: 'Beto' });

  const censo = await expectMsg(b2, 'peers', 'censo de B tras reconectar');
  results.push(`B (reconectado) ve peers: ${censo.peers.length} (espera 1: Ana)`);
  await bGone;
  results.push('la sesión fantasma de B fue desalojada por el servidor');
  results.push(`A detecta que ${(await aSeesReturn).peer.name} ha vuelto`);

  const b2Signal = expectMsg(b2, 'signal', 'la señal no llegó a la conexión nueva de B');
  send(a.ws, { t: 'signal', room: 'r1', from: 'A', to: 'B', data: { hello: 2 } });
  const sig = await b2Signal;
  results.push(`B (reconectado) recibió señal de ${sig.from}: ${JSON.stringify(sig.data)}`);

  done(censo.peers.length === 1 && sig.data.hello === 2);
}

void main();

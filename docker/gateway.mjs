// Puerta de entrada del contenedor: UN solo puerto para todo.
//
// Dentro del contenedor viven dos procesos —la web (Next) y la señalización (WebSocket)— pero de
// puertas afuera se ven como un único sitio:
//
//     http(s)://…/          → la web
//     ws(s)://…/ws          → la señalización
//     http(s)://…/health    → "ok", para el que despliegue
//
// Esto no es una comodidad: es lo que hace que la imagen sea PORTÁTIL. Quien la levanta y la
// publica con un túnel obtiene una URL que no existía antes; si la señalización viviera en otro
// puerto, habría que rehacer el build de la web con esa URL dentro. Compartiendo puerto, el
// navegador la deduce sola de su propio origen (ver `web/lib/signal.ts` → `sameOrigin`).
//
// Con TUNNEL=1 hay un tercer proceso, `cloudflared`, que publica ese puerto en internet y anuncia
// la URL por consola. Va DENTRO para que jugar entre casas sea un solo `docker run`, sin bajarse
// ningún archivo ni tener el código.
//
// Recordatorio de lo que este servidor NO hace: no ve una sola carta. Las partidas viajan directas
// navegador↔navegador por WebRTC. Esto solo presenta a los jugadores y luego se aparta.

import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const PORT = Number(process.env.PORT ?? 7787);
const WEB_PORT = 3000; // Next, dentro del contenedor
const SIGNAL_PORT = 8787; // señalización, dentro del contenedor
const TUNNEL = /^(1|true|yes|on)$/i.test(process.env.TUNNEL ?? '');

// --- Los dos procesos de dentro ---------------------------------------------
const child = (name, cmd, args, env) => {
  const p = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  p.on('exit', (code) => {
    // Si uno de los dos se cae, el contenedor entero debe morir: un juego sin señalización (o sin
    // web) no es medio juego, es un contenedor sano mintiendo sobre su estado.
    console.error(`[gateway] "${name}" terminó con código ${code}; cerrando el contenedor`);
    process.exit(code ?? 1);
  });
  return p;
};

child('web', 'node', ['web/server.js'], { PORT: String(WEB_PORT), HOSTNAME: '127.0.0.1' });
child('signaling', 'node', ['signaling/server.js'], { PORT: String(SIGNAL_PORT) });

// --- Reenvío ----------------------------------------------------------------
const forward = (req, res, port) => {
  const proxied = httpRequest(
    { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('todavía arrancando…'); // los procesos de dentro tardan un instante en escuchar
  });
  req.pipe(proxied);
};

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('bug ok');
    return;
  }
  forward(req, res, WEB_PORT);
});

// El apretón de manos de WebSocket es un `Upgrade` de HTTP: se toma el socket en crudo y se
// empalma con el de la señalización. A partir de ahí, esto es una tubería tonta.
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  const upstream = connect(SIGNAL_PORT, '127.0.0.1', () => {
    const headers = Object.entries(req.headers)
      .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))
      .join('\r\n');
    upstream.write(`GET ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

// --- El túnel (opcional: TUNNEL=1) ------------------------------------------
// Tu casa no tiene dirección pública —el router hace NAT—, así que nadie de fuera puede llamar a tu
// máquina. `cloudflared` abre la conexión al revés: sale él hacia Cloudflare y le prestan una URL
// pública mientras dure. Esa URL es la invitación.
//
// A diferencia de la web y la señalización, si el túnel se cae NO se tumba el contenedor: los que
// ya están jugando siguen (sus cartas van por WebRTC, no por aquí) y quien esté en la misma WiFi
// sigue entrando por la IP local. Matar el contenedor sí les haría daño. Así que se reintenta.
const announce = (url) => {
  const marco = '─'.repeat(url.length + 4);
  console.log(
    `\n┌${marco}┐\n│  ${url}  │\n└${marco}┘\n` +
      `  Esa es la invitación: quien abra ese enlace entra a jugar.\n` +
      `  No necesita Docker, ni el código, ni instalar nada.\n`,
  );
};

const startTunnel = (intento = 0) => {
  const p = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // cloudflared anuncia la URL por stderr, enterrada entre sus propios logs: se pesca al vuelo.
  let anunciada = false;
  const buscarUrl = (chunk) => {
    if (anunciada) return;
    const url = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (url) {
      anunciada = true;
      announce(url);
    }
  };
  p.stdout.on('data', buscarUrl);
  p.stderr.on('data', buscarUrl);

  p.on('error', (err) => {
    console.error(`[gateway] no se pudo lanzar cloudflared: ${err.message}`);
  });

  p.on('exit', (code) => {
    const espera = Math.min(2 ** intento, 30);
    console.error(`[gateway] el túnel terminó (código ${code}); reintentando en ${espera}s`);
    setTimeout(() => startTunnel(intento + 1), espera * 1000).unref();
  });
};

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[bug] escuchando en :${PORT}  (web en /, señalización en /ws)`);
  if (TUNNEL) {
    console.log('[bug] abriendo el túnel… (la URL sale en unos segundos)');
    startTunnel();
  } else {
    console.log(`[bug] sin túnel. Misma WiFi: http://<tu-ip-local>:${PORT}  ·  Otras redes: -e TUNNEL=1`);
  }
});

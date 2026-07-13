# 🐛 Bug

Juego de cartas estilo UNO, multijugador y **peer-to-peer**: las cartas viajan directas
de un navegador a otro por WebRTC, sin servidor de juego. Solo hace falta un punto de
encuentro inicial (señalización) para que los jugadores se presenten; a partir de ahí,
el anfitrión deja de ser necesario para que la partida siga.

**Imagen Docker:** [`sketox/bug`](https://hub.docker.com/r/sketox/bug) · un solo puerto,
todo incluido (web + señalización).

## Reglas (v1)

- Mazo de 108 cartas: 4 colores (rojo, amarillo, verde, azul), números 0-9, y especiales
  (Salta, Reversa, +2, Comodín, Comodín +4).
- Cada jugador empieza con 7 cartas.
- En tu turno: juega una carta que coincida en color, número o símbolo, o roba.
- Gana quien se queda sin cartas.

## Jugar

### Misma WiFi

```bash
docker run -p 8080:8080 sketox/bug
```

Abre `http://localhost:8080`, pon tu nombre y **Crear sala**. Los demás abren
`http://<IP-del-anfitrión>:8080` y escanean el QR o teclean el código de la sala.

### Casas distintas (con túnel)

No hace falta clonar el repo: basta el `docker-compose.yml` suelto.

```bash
curl -O https://raw.githubusercontent.com/Sketox/Bug-p2p/main/docker-compose.yml
docker compose up
```

En los logs aparecerá una URL pública (`https://algo.trycloudflare.com`). Esa es la
invitación: compártela (o el QR) y tus amigos solo la abren en el navegador — no
necesitan Docker ni instalar nada.

> Una casa no tiene dirección pública: el router hace NAT. El túnel le presta una
> dirección pública mientras dura la partida — el mismo problema de *bootstrap* que
> resuelven los trackers de BitTorrent o las semillas DNS de Bitcoin.

## Arquitectura

- **`engine/`** — motor de reglas puro (sin red ni UI), testeado de forma aislada.
- **`net/`** — capa P2P: WebRTC, protocolo de mensajes, replicación de estado.
- **`signaling/`** — servidor de señalización (WebSocket): solo hace el handshake
  inicial (SDP/ICE) y se aparta.
- **`web/`** — la interfaz (Next.js).
- **`docker/`** — empaqueta web + señalización en un único puerto.

Modelo **host-authoritative**: un peer mantiene el estado canónico de la partida; los
demás envían intenciones (jugar, robar) y reciben el estado actualizado. Si el host se
cae a media partida... la partida sigue, porque el host nunca vio una sola carta ajena
después del *handshake* inicial — el estado vive replicado entre pares.

## Desarrollo (sin Docker)

Requiere Node.js. Es un monorepo con workspaces (`engine`, `net`, `signaling`, `web`).

```bash
npm install
```

Hacen falta **dos terminales**: una para la señalización, otra para la web.

```bash
npm run signaling    # levanta el WebSocket de señalización en :8787
```

```bash
cd web && cp .env.example .env.local   # solo la primera vez
cd ..
npm run web           # levanta Next.js en :3000 (dev, con hot-reload)
```

Abre `http://localhost:3000`. Para probar con otro dispositivo en la misma WiFi, cambia
`NEXT_PUBLIC_SIGNAL_URL` en `web/.env.local` a `ws://<tu-IP-local>:8787`.

```bash
npm test              # corre los tests de engine + net + web
npm run build          # build de producción de todos los paquetes
```

### Con Docker (todo-en-uno, sin instalar Node)

```bash
docker build -t bug .
docker run -p 8080:8080 bug
```

Útil para probar exactamente lo que se despliega, sin tocar Node ni npm.

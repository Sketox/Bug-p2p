# Imagen todo-en-uno de Bug: la web y la señalización en un solo puerto.
#
# Quien la levanta se convierte en el ANFITRIÓN de la partida: sirve el juego y hace de punto de
# encuentro. Los demás solo abren su enlace en el navegador — no necesitan Docker ni instalar nada.
#
# Y ojo con lo que este contenedor NO es: no es un servidor de juego. No ve una carta, no sabe de
# quién es el turno, no guarda ninguna partida. Las cartas viajan directas navegador↔navegador por
# WebRTC; esto solo presenta a los jugadores y se aparta. Si se cae a media partida, la partida
# sigue.
#
#   docker run -p 8080:8080 <imagen>      →  http://localhost:8080

# --- 1. Dependencias --------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY engine/package.json engine/
COPY net/package.json net/
COPY web/package.json web/
COPY signaling/package.json signaling/
RUN npm ci --no-audit --no-fund

# --- 2. Compilación ---------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
# El motor a JS, la señalización a JS, y la web a su salida autocontenida (`standalone`).
RUN npm run build --workspace @bug/engine \
 && npm run build --workspace @bug/signaling \
 && npm run build --workspace @bug/web

# --- 3. Imagen final --------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# La web: `server.js` + lo que Next decidió que necesita de verdad.
COPY --from=build /repo/web/.next/standalone/web ./web
COPY --from=build /repo/web/.next/standalone/node_modules ./node_modules
COPY --from=build /repo/web/.next/static ./web/.next/static
COPY --from=build /repo/web/public ./web/public

# La señalización: su server compilado y su única dependencia (`ws`).
COPY --from=build /repo/signaling/dist ./signaling
COPY --from=build /repo/node_modules/ws ./node_modules/ws

# El túnel, para poder jugar entre casas distintas con un solo `docker run` (ver TUNNEL más abajo).
# Se saca de la imagen oficial en vez de descargarlo: sin curl, sin checksum que verificar a mano.
COPY --from=cloudflare/cloudflared:latest /usr/local/bin/cloudflared /usr/local/bin/cloudflared

# La puerta de entrada, que junta las dos en un solo puerto.
COPY docker/gateway.mjs ./gateway.mjs

EXPOSE 8080
ENV PORT=8080
# Sin healthcheck no hay forma de distinguir "arrancando" de "roto" al desplegar.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -q -O- http://127.0.0.1:8080/health || exit 1

CMD ["node", "gateway.mjs"]

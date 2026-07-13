# Imagen del servidor de señalización de Bug (standalone, desplegable en cualquier lado).
FROM node:20-alpine
WORKDIR /app

# Solo necesita su propio package.json (deps: ws, tsx).
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

# La plataforma inyecta PORT; por defecto 8787.
ENV PORT=8787
EXPOSE 8787

CMD ["npx", "tsx", "src/server.ts"]

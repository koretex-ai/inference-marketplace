# Dispatcher container for Coolify (or any Docker host).
# Customer gateway (/v1/*) and node WebSocket (/node) are served on the SAME port.
FROM node:22-alpine
WORKDIR /app

# Install deps first for layer caching. tsx is a devDependency, so install all deps.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY deploy ./deploy
# Build the single-file agent bundle the dispatcher serves at /agent.js (P1 installer).
RUN npm run bundle
# Build the browser wallet bundle the dispatcher serves at /wallet.js (Phantom embedded login).
RUN npm run wallet:bundle

ENV PORT=8787
EXPOSE 8787

# Coolify health check hits this; also used by Docker HEALTHCHECK.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/dispatcher/index.ts"]

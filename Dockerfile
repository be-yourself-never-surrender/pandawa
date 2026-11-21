FROM node:24-slim AS builder
WORKDIR /app

COPY package.json tsconfig.server.json ./
COPY web/package.json ./web/
RUN npm install --no-audit --no-fund && npm --prefix web install --no-audit --no-fund

COPY server ./server
COPY web ./web
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PANDAWA_PORT=7777
ENV PANDAWA_HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends python3 tmux ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY runtime ./runtime

VOLUME ["/app/data"]
EXPOSE 7777

CMD ["node", "dist/server/index.js"]

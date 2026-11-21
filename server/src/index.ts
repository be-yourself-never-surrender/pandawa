import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { PORT, HOST, WEB_DIST_DIR, ensureDirectories } from "./config.js";
import { seedInitialData } from "./db/seed.js";
import { verifyToken } from "./auth/authService.js";
import { createApiRouter } from "./routes/api.js";
import { startCronScheduler, stopCronScheduler } from "./scheduler/cronEngine.js";
import { syncTelegramPollers, stopAllTelegramPollers } from "./channels/channelManager.js";

ensureDirectories();
seedInitialData();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const clients = new Set<WebSocket>();

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const token = url.searchParams.get("token") || "";
  if (!verifyToken(token).valid) {
    ws.close(4001, "Unauthorized");
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

function broadcast(event: Record<string, unknown>): void {
  const payload = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pandawa", version: "3.0.0" });
});

app.use("/api", createApiRouter(broadcast));

// Serve built React SPA if present
if (fs.existsSync(WEB_DIST_DIR)) {
  app.use(express.static(WEB_DIST_DIR));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
  });
}

startCronScheduler(broadcast);
syncTelegramPollers(broadcast);

server.listen(PORT, HOST, () => {
  console.log(`[Pandawa v2.0] Server running at http://${HOST}:${PORT}`);
});

function shutdown(): void {
  stopCronScheduler();
  stopAllTelegramPollers();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

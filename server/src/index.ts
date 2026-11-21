import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import {
  PORT,
  HOST,
  WEB_DIST_DIR,
  PYTHON_WORKER_DIR,
  WORKSPACE_DIR,
  ensureDirectories,
} from "./config.js";
import { seedInitialData } from "./db/seed.js";
import { verifyToken } from "./auth/authService.js";
import { createApiRouter } from "./routes/api.js";
import { startCronScheduler, stopCronScheduler } from "./scheduler/cronEngine.js";
import { startHeartbeatDaemon, stopHeartbeatDaemon } from "./engine/heartbeatDaemon.js";
import { syncTelegramPollers, stopAllTelegramPollers } from "./channels/channelManager.js";
import { killAllManagedProcesses } from "./tools/processManager.js";
import { setTerminalBroadcast } from "./tools/terminalManager.js";
import { shutdownAllStdioMcp } from "./mcp/mcpClient.js";
import { reindexSemanticBrain } from "./brains/semanticMemory.js";

ensureDirectories();
seedInitialData();

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const server = http.createServer(app);

// Use noServer: true on both WebSocketServers to cleanly route /ws and /ws/terminal without upgrade clashes
const wss = new WebSocketServer({ noServer: true });
const termWss = new WebSocketServer({ noServer: true });

const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

function getPythonBin(): string {
  const venvUnix = path.join(PYTHON_WORKER_DIR, ".venv", "bin", "python3");
  if (fs.existsSync(venvUnix)) return venvUnix;
  return process.platform === "win32" ? "python" : "python3";
}

// Real-Time 60fps Interactive xterm.js <-> Python PTY <-> tmux Bridge
termWss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const sessionName = (url.searchParams.get("name") || "main").trim();
  const cols = Math.max(20, Math.min(400, Number(url.searchParams.get("cols") || 120)));
  const rows = Math.max(8, Math.min(200, Number(url.searchParams.get("rows") || 32)));
  const bridgeScript = path.join(PYTHON_WORKER_DIR, "pty_bridge.py");

  if (!fs.existsSync(bridgeScript)) {
    ws.send(JSON.stringify({ type: "error", message: "pty_bridge.py not found." }));
    ws.close();
    return;
  }

  const py = getPythonBin();
  const child = spawn(py, [bridgeScript, sessionName, WORKSPACE_DIR, String(cols), String(rows)], {
    cwd: WORKSPACE_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line && ws.readyState === WebSocket.OPEN) {
        ws.send(line);
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString("utf8").trim();
    if (msg && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: msg }));
    }
  });

  child.on("close", () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit" }));
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    try {
      const txt = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed = JSON.parse(txt) as { type?: string; data?: string; cols?: number; rows?: number };
      if (parsed.type === "input" && typeof parsed.data === "string") {
        const b64 = Buffer.from(parsed.data, "utf8").toString("base64");
        child.stdin.write(JSON.stringify({ type: "input", b64 }) + "\n");
      } else if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        child.stdin.write(
          JSON.stringify({ type: "resize", cols: Number(parsed.cols), rows: Number(parsed.rows) }) + "\n"
        );
      }
    } catch {
      // ignore malformed frames
    }
  });

  const cleanup = () => {
    try {
      child.stdin.end();
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const token = url.searchParams.get("token") || "";
  if (!verifyToken(token).valid) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else if (url.pathname === "/ws/terminal") {
    termWss.handleUpgrade(req, socket, head, (ws) => {
      termWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
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
  res.json({ ok: true, service: "pandawa", version: "6.5.0" });
});

setTerminalBroadcast(broadcast);
app.use("/api", createApiRouter(broadcast));

// Serve built React SPA if present
if (fs.existsSync(WEB_DIST_DIR)) {
  app.use(express.static(WEB_DIST_DIR));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
  });
}

startCronScheduler(broadcast);
startHeartbeatDaemon(broadcast);
syncTelegramPollers(broadcast);
// Warm semantic brain index asynchronously on startup
setTimeout(() => {
  reindexSemanticBrain().catch(() => {});
}, 2500);

server.listen(PORT, HOST, () => {
  console.log(`[Pandawa OS v6.5] Living Agentic OS running at http://${HOST}:${PORT}`);
});

function shutdown(): void {
  stopCronScheduler();
  stopHeartbeatDaemon();
  stopAllTelegramPollers();
  killAllManagedProcesses();
  shutdownAllStdioMcp();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

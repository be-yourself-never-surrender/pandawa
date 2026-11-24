import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "server", "index.js");

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  const extra = lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : "";
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms${extra}`);
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Failed to resolve ephemeral port")));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// IEEE 802.3 CRC-32 for genuine ZIP archive creation
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Pure-JS ZIP archive builder (Store method 0 + UTF-8 flag + CRC32 + Central Directory + EOCD).
 * Exercises real Python zipfile extraction via POST /api/files/upload.
 */
export function createZipBase64(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // Fixed DOS time/date (2026-01-01 12:00:00)
  const dosTime = 0x6000;
  const dosDate = 0x5c21;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name), "utf8");
    const dataBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content ?? ""), "utf8");
    const crc = crc32(dataBuf);

    // Local File Header (30 bytes + filename)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    lfh.writeUInt16LE(0, 8); // compression method: store
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(dataBuf.length, 18);
    lfh.writeUInt32LE(dataBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len

    localParts.push(lfh, nameBuf, dataBuf);

    // Central Directory File Header (46 bytes + filename)
    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(20, 4); // version made by
    cdfh.writeUInt16LE(20, 6); // version needed
    cdfh.writeUInt16LE(0x0800, 8); // UTF-8 flag
    cdfh.writeUInt16LE(0, 10); // store
    cdfh.writeUInt16LE(dosTime, 12);
    cdfh.writeUInt16LE(dosDate, 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(dataBuf.length, 20);
    cdfh.writeUInt32LE(dataBuf.length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30); // extra len
    cdfh.writeUInt16LE(0, 32); // comment len
    cdfh.writeUInt16LE(0, 34); // disk start
    cdfh.writeUInt16LE(0, 36); // internal attrs
    cdfh.writeUInt32LE(0, 38); // external attrs
    cdfh.writeUInt32LE(offset, 42);

    centralParts.push(cdfh, nameBuf);
    offset += 30 + nameBuf.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]).toString("base64");
}

export function signWhatsAppPayload(rawBody, appSecret) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const digest = crypto.createHmac("sha256", appSecret).update(buf).digest("hex");
  return `sha256=${digest}`;
}

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Real local node:http server supporting OpenAI (/v1/models, /v1/chat/completions),
 * Anthropic (/v1/messages), and Gemini (/models/:model:generateContent & :streamGenerateContent).
 */
export async function startMockLlmServer(initialHandler) {
  let activeHandler = initialHandler || (async () => ({ content: "OK" }));
  const requests = [];

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", "http://127.0.0.1");
      const rawBody = await readHttpBody(req);
      let body = null;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }

      const rec = {
        method: req.method || "GET",
        url: req.url || "/",
        path: urlObj.pathname,
        query: Object.fromEntries(urlObj.searchParams.entries()),
        headers: { ...req.headers },
        rawBody,
        body,
        timestamp: Date.now(),
      };
      requests.push(rec);

      const isModelsProbe = req.method === "GET" && urlObj.pathname.endsWith("/models");
      let kind = "openai";
      if (urlObj.pathname.includes("/messages")) kind = "anthropic";
      else if (urlObj.pathname.includes(":generateContent") || urlObj.pathname.includes(":streamGenerateContent")) {
        kind = "gemini";
      }

      const ctx = {
        ...rec,
        kind,
        isModelsProbe,
        requests,
        attemptIndex: requests.length - 1,
      };

      const result = await activeHandler(ctx);

      if (isModelsProbe) {
        if (urlObj.pathname.endsWith("/v1beta/models") || urlObj.pathname.endsWith("/models")) {
          if (result && typeof result === "object" && ("status" in result || "body" in result)) {
            const st = result.status ?? 200;
            sendJson(res, st, result.body ?? { models: [{ name: "models/gemini-2.5-flash" }] }, result.headers);
            return;
          }
          sendJson(res, 200, {
            object: "list",
            data: [{ id: "mock-gpt-4.1" }, { id: "mock-gpt-mini" }],
            models: [{ name: "models/gemini-2.5-flash" }],
          });
          return;
        }
      }

      const normalized = typeof result === "string" ? { content: result } : (result || { content: "OK" });

      if (normalized.delayMs) {
        await sleep(normalized.delayMs);
      }

      if (normalized.rawSseChunks) {
        res.writeHead(normalized.status ?? 200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...(normalized.headers || {}),
        });
        for (const chunk of normalized.rawSseChunks) {
          res.write(chunk);
        }
        res.end();
        return;
      }

      if (normalized.status && normalized.status >= 400) {
        const errBody = normalized.body ?? {
          error: { message: normalized.error || `Injected error ${normalized.status}`, type: "api_error" },
        };
        if (typeof errBody === "string") {
          res.writeHead(normalized.status, { "Content-Type": "text/plain", ...(normalized.headers || {}) });
          res.end(errBody);
        } else {
          sendJson(res, normalized.status, errBody, normalized.headers);
        }
        return;
      }

      const contentText = normalized.content ?? "";
      const toolCalls = Array.isArray(normalized.toolCalls) ? normalized.toolCalls : [];

      if (kind === "openai") {
        const isStream = Boolean(body && typeof body === "object" && body.stream);
        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          if (contentText) {
            res.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-e2e",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: contentText }, finish_reason: null }],
              })}\n\n`
            );
          }
          if (toolCalls.length > 0) {
            res.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-e2e",
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: toolCalls.map((tc, i) => ({
                        index: i,
                        id: tc.id || `call_e2e_${i + 1}`,
                        type: "function",
                        function: {
                          name: tc.name,
                          arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
                        },
                      })),
                    },
                    finish_reason: null,
                  },
                ],
              })}\n\n`
            );
          }
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-e2e",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 15, completion_tokens: 10 },
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const message = {
          role: "assistant",
          content: toolCalls.length > 0 && !contentText ? null : contentText,
        };
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls.map((tc, i) => ({
            id: tc.id || `call_e2e_${i + 1}`,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
            },
          }));
        }
        sendJson(res, 200, {
          id: "chatcmpl-e2e",
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 15, completion_tokens: 10 },
        });
        return;
      }

      if (kind === "anthropic") {
        const isStream = Boolean(body && typeof body === "object" && body.stream);
        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: { id: "msg_e2e", type: "message", role: "assistant", usage: { input_tokens: 10, output_tokens: 1 } },
            })}\n\n`
          );
          let blockIdx = 0;
          if (contentText) {
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIdx,
                content_block: { type: "text", text: "" },
              })}\n\n`
            );
            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "text_delta", text: contentText },
              })}\n\n`
            );
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`);
            blockIdx++;
          }
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIdx,
                content_block: { type: "tool_use", id: tc.id || `toolu_${i + 1}`, name: tc.name, input: {} },
              })}\n\n`
            );
            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIdx,
                delta: {
                  type: "input_json_delta",
                  partial_json: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
                },
              })}\n\n`
            );
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`);
            blockIdx++;
          }
          res.write(
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn" },
              usage: { output_tokens: 8 },
            })}\n\n`
          );
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          res.end();
          return;
        }

        const blocks = [];
        if (contentText) blocks.push({ type: "text", text: contentText });
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          blocks.push({
            type: "tool_use",
            id: tc.id || `toolu_${i + 1}`,
            name: tc.name,
            input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : (tc.arguments || {}),
          });
        }
        sendJson(res, 200, {
          id: "msg_e2e",
          type: "message",
          role: "assistant",
          content: blocks,
          stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
          usage: { input_tokens: 10, output_tokens: 8 },
        });
        return;
      }

      // Gemini
      const parts = [];
      if (contentText) parts.push({ text: contentText });
      for (const tc of toolCalls) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : (tc.arguments || {}),
          },
        });
      }
      const gemPayload = {
        candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
      };
      if (urlObj.pathname.includes(":streamGenerateContent")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(gemPayload)}\n\n`);
        res.end();
        return;
      }
      sendJson(res, 200, gemPayload);
    } catch (err) {
      sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    resetRequests() {
      requests.length = 0;
    },
    setHandler(fn) {
      activeHandler = fn;
    },
    async waitForRequest(predicate, timeoutMs = 15000) {
      return waitFor(() => requests.find(predicate), { timeoutMs, label: "mock LLM request" });
    },
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Real local node:http Telegram Bot API protocol server:
 * - GET/POST /bot<token>/getUpdates (event-driven long poll)
 * - POST /bot<token>/sendMessage (records sent messages + supports injected failures)
 */
export async function startMockTelegramServer() {
  let nextUpdateId = 1000;
  const updatesQueue = [];
  const getUpdatesCalls = [];
  const sentMessages = [];
  let pendingWaiter = null;
  let persistentSendFailure = null;
  let nextSendFailure = null;
  let getUpdatesFailure = null;
  let closed = false;

  function wakeWaiter() {
    if (pendingWaiter) {
      const fn = pendingWaiter;
      pendingWaiter = null;
      fn();
    }
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || "/", "http://127.0.0.1");
    const m = urlObj.pathname.match(/^\/bot([^/]+)\/([A-Za-z0-9_]+)$/);
    if (!m) {
      sendJson(res, 404, { ok: false, description: "Unknown Telegram Bot API path" });
      return;
    }
    const token = decodeURIComponent(m[1]);
    const method = m[2];
    const rawBody = await readHttpBody(req);
    let body = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = {};
      }
    }

    if (method === "getUpdates") {
      const offset = Number(urlObj.searchParams.get("offset") ?? body.offset ?? 0);
      getUpdatesCalls.push({ token, offset, timestamp: Date.now() });

      if (getUpdatesFailure) {
        sendJson(res, getUpdatesFailure.status, getUpdatesFailure.body);
        return;
      }

      const pickReady = () => updatesQueue.filter((u) => u.update_id >= offset);
      let ready = pickReady();
      if (ready.length === 0 && !closed) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (pendingWaiter === done) pendingWaiter = null;
            resolve();
          }, 1200);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          pendingWaiter = done;
          req.once("close", () => {
            if (pendingWaiter === done) pendingWaiter = null;
            clearTimeout(timer);
            resolve();
          });
        });
        ready = pickReady();
      }
      sendJson(res, 200, { ok: true, result: ready });
      return;
    }

    if (method === "sendMessage") {
      if (nextSendFailure) {
        const fail = nextSendFailure;
        nextSendFailure = null;
        sendJson(res, fail.status, fail.body);
        return;
      }
      if (persistentSendFailure) {
        sendJson(res, persistentSendFailure.status, persistentSendFailure.body);
        return;
      }

      const rec = {
        token,
        chatId: String(body.chat_id ?? ""),
        text: String(body.text ?? ""),
        body,
        timestamp: Date.now(),
      };
      sentMessages.push(rec);
      sendJson(res, 200, {
        ok: true,
        result: { message_id: sentMessages.length, chat: { id: body.chat_id }, text: rec.text },
      });
      return;
    }

    sendJson(res, 200, { ok: true, result: true });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    getUpdatesCalls,
    sentMessages,
    pushMessage(chatId, text, from = { id: 9001, username: "e2e_user", first_name: "E2E" }) {
      const update = {
        update_id: nextUpdateId++,
        message: {
          message_id: nextUpdateId,
          chat: { id: chatId, type: "private" },
          from,
          date: Math.floor(Date.now() / 1000),
          text,
        },
      };
      updatesQueue.push(update);
      wakeWaiter();
      return update;
    },
    waitForSentMessage(predicate, timeoutMs = 15000) {
      return waitFor(() => sentMessages.find(predicate), { timeoutMs, label: "Telegram sendMessage" });
    },
    setNextSendFailure(status, body = { ok: false, error_code: status, description: `Error ${status}` }) {
      nextSendFailure = { status, body };
    },
    setSendFailure(status, body = { ok: false, error_code: status, description: `Error ${status}` }) {
      persistentSendFailure = { status, body };
    },
    clearSendFailure() {
      persistentSendFailure = null;
      nextSendFailure = null;
    },
    setGetUpdatesFailure(status, body = { ok: false, error_code: status, description: `Error ${status}` }) {
      getUpdatesFailure = { status, body };
    },
    clearGetUpdatesFailure() {
      getUpdatesFailure = null;
    },
    async close() {
      closed = true;
      wakeWaiter();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Real local node:http WhatsApp Graph API protocol server:
 * - POST /v21.0/:phoneNumberId/messages
 */
export async function startMockWhatsAppServer() {
  const sentMessages = [];
  let persistentSendFailure = null;
  let nextSendFailure = null;

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || "/", "http://127.0.0.1");
    const m = urlObj.pathname.match(/^\/v\d+\.\d+\/([^/]+)\/messages$/);
    if (!m || req.method !== "POST") {
      sendJson(res, 404, { error: { message: "Unknown Graph API route" } });
      return;
    }

    const phoneNumberId = decodeURIComponent(m[1]);
    const rawBody = await readHttpBody(req);
    let body = {};
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      body = {};
    }

    if (nextSendFailure) {
      const fail = nextSendFailure;
      nextSendFailure = null;
      sendJson(res, fail.status, fail.body);
      return;
    }
    if (persistentSendFailure) {
      sendJson(res, persistentSendFailure.status, persistentSendFailure.body);
      return;
    }

    const rec = {
      phoneNumberId,
      authHeader: req.headers.authorization || "",
      to: String(body.to || ""),
      text: String(body?.text?.body ?? ""),
      body,
      rawBody,
      timestamp: Date.now(),
    };
    sentMessages.push(rec);

    sendJson(res, 200, {
      messaging_product: "whatsapp",
      contacts: [{ input: rec.to, wa_id: rec.to }],
      messages: [{ id: `wamid.e2e.${sentMessages.length}` }],
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    sentMessages,
    waitForSentMessage(predicate, timeoutMs = 15000) {
      return waitFor(() => sentMessages.find(predicate), { timeoutMs, label: "WhatsApp Graph sendMessage" });
    },
    setNextSendFailure(status, body = { error: { message: `Graph error ${status}`, code: status } }) {
      nextSendFailure = { status, body };
    },
    setSendFailure(status, body = { error: { message: `Graph error ${status}`, code: status } }) {
      persistentSendFailure = { status, body };
    },
    clearSendFailure() {
      persistentSendFailure = null;
      nextSendFailure = null;
    },
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Spawns an isolated real `node dist/server/index.js` child process backed by a temp PANDAWA_DATA_DIR.
 */
export async function startPandawaServer(opts = {}) {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Missing compiled server entrypoint: ${SERVER_ENTRY}. Run npm run build:server first.`);
  }

  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-e2e-"));
  const password = opts.password ?? "PandawaE2E#2026!";

  const env = {
    ...process.env,
    ...(opts.env || {}),
    PANDAWA_ROOT: REPO_ROOT,
    PANDAWA_DATA_DIR: dataDir,
    PANDAWA_HOST: "127.0.0.1",
    PANDAWA_PORT: String(port),
    PANDAWA_DEFAULT_PASSWORD: password,
  };
  if (opts.telegramBaseUrl) env.PANDAWA_TELEGRAM_API_BASE = opts.telegramBaseUrl;
  else delete env.PANDAWA_TELEGRAM_API_BASE;
  if (opts.whatsappBaseUrl) env.PANDAWA_WHATSAPP_GRAPH_API_BASE = opts.whatsappBaseUrl;
  else delete env.PANDAWA_WHATSAPP_GRAPH_API_BASE;

  const logs = [];
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (d) => {
    logs.push(d.toString("utf8"));
    if (logs.length > 200) logs.shift();
  });
  child.stderr?.on("data", (d) => {
    logs.push(d.toString("utf8"));
    if (logs.length > 200) logs.shift();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const openSockets = new Set();

  try {
    await waitFor(
      async () => {
        if (exited) {
          throw new Error(`Pandawa server exited prematurely with code ${exitCode}.\nLogs:\n${logs.join("")}`);
        }
        const resp = await fetch(`${baseUrl}/health`);
        if (!resp.ok) return false;
        const json = await resp.json();
        return json?.ok === true ? json : false;
      },
      { timeoutMs: 15000, intervalMs: 50, label: "Pandawa /health" }
    );

    const loginResp = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const loginJson = await loginResp.json();
    if (!loginResp.ok || !loginJson?.token) {
      throw new Error(`Login failed (${loginResp.status}): ${JSON.stringify(loginJson)}`);
    }
    const token = loginJson.token;

    async function api(method, apiPath, body, extraHeaders = {}) {
      const url = apiPath.startsWith("/api") ? `${baseUrl}${apiPath}` : `${baseUrl}/api${apiPath}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      };
      const init = { method, headers };
      if (body !== undefined && method !== "GET" && method !== "HEAD") {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
        init.body = typeof body === "string" ? body : JSON.stringify(body);
      }
      const resp = await fetch(url, init);
      const text = await resp.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: resp.status, ok: resp.ok, data, text, headers: resp.headers };
    }

    async function rawFetch(urlPath, init = {}) {
      const resp = await fetch(`${baseUrl}${urlPath}`, init);
      const text = await resp.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: resp.status, ok: resp.ok, data, text, headers: resp.headers };
    }

    async function connectWs() {
      const ticketRes = await api("POST", "/api/auth/ws-ticket");
      if (!ticketRes.ok || !ticketRes.data?.ticket) {
        throw new Error(`Failed to get WS ticket: ${ticketRes.status}`);
      }
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticketRes.data.ticket)}`);
      openSockets.add(ws);
      const events = [];

      ws.on("message", (buf) => {
        try {
          events.push(JSON.parse(buf.toString("utf8")));
        } catch {
          // ignore non-json frames
        }
      });
      ws.once("close", () => openSockets.delete(ws));

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Timed out opening /ws")), 5000);
        ws.once("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws.once("error", (err) => {
          clearTimeout(t);
          reject(err);
        });
      });

      await waitFor(() => events.find((e) => e.type === "connected"), { timeoutMs: 5000, label: "WS connected event" });

      return {
        ws,
        events,
        waitForEvent(predicate, timeoutMs = 15000) {
          return waitFor(() => events.find(predicate), { timeoutMs, label: "WS event" });
        },
        close() {
          openSockets.delete(ws);
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        },
      };
    }

    async function stop() {
      for (const ws of Array.from(openSockets)) {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
      openSockets.clear();

      if (!exited) {
        child.kill("SIGTERM");
        const dead = await Promise.race([
          new Promise((resolve) => child.once("exit", () => resolve(true))),
          sleep(2000).then(() => false),
        ]);
        if (!dead && !exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          await Promise.race([
            new Promise((resolve) => child.once("exit", () => resolve(true))),
            sleep(1500),
          ]);
        }
      }

      for (let i = 0; i < 6; i++) {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(120);
        }
      }
    }

    return {
      port,
      baseUrl,
      dataDir,
      password,
      token,
      logs,
      api,
      rawFetch,
      connectWs,
      stop,
    };
  } catch (err) {
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function purgeStarterEntities(harness) {
  // Remove any channels targeting starter entities first
  const chList = await harness.api("GET", "/api/channels");
  for (const ch of chList.data?.channels || []) {
    await harness.api("DELETE", `/api/channels/${encodeURIComponent(ch.id)}`);
  }
  await harness.api("PUT", "/api/topology", { nodes: [], edges: [] });
  await harness.api("DELETE", "/api/teams/team_pandawa?cascade=true");
  await harness.api("DELETE", "/api/agents/agent_yudhistira");
  await harness.api("DELETE", "/api/agents/agent_arjuna");
  await harness.api("DELETE", "/api/brains/brain_team_core");
  await harness.api("DELETE", "/api/brains/brain_main");
}

/**
 * Bootstraps a clean custom team + custom provider + custom agents + topology wiring.
 * Optionally purges starter entities (`team_pandawa`, `agent_yudhistira`, `brain_team_core`, `brain_main`).
 */
export async function bootstrapCustomTeam(harness, opts = {}) {
  if (opts.purgeStarter !== false) {
    await purgeStarterEntities(harness);
  }

  const suffix = crypto.randomBytes(3).toString("hex");
  const provRes = await harness.api("POST", "/api/providers", {
    name: opts.providerName || `CustomMockLLM-${suffix}`,
    kind: opts.providerKind || "openai",
    baseUrl: opts.llmBaseUrl,
    apiKey: opts.apiKey !== undefined ? opts.apiKey : "sk-e2e-custom-key",
    defaultModel: opts.defaultModel || "mock-gpt-4.1",
    enabled: true,
  });
  if (!provRes.ok || !provRes.data?.provider?.id) {
    throw new Error(`Failed to create custom provider: ${provRes.status} ${provRes.text}`);
  }
  const provider = provRes.data.provider;

  const teamRes = await harness.api("POST", "/api/teams", {
    name: opts.teamName || `Alpha Squad ${suffix}`,
    slug: opts.teamSlug || `alpha-squad-${suffix}`,
    description: opts.teamDescription || "Custom E2E team without starter IDs",
    collaboration_mode: opts.collaborationMode || "execute",
    max_rounds: opts.maxRounds ?? 2,
  });
  if (!teamRes.ok || !teamRes.data?.id) {
    throw new Error(`Failed to create custom team: ${teamRes.status} ${teamRes.text}`);
  }
  let team = teamRes.data;

  const defaultSpecs = [
    { key: "lead", name: "PlannerAlpha", purpose: "strategy", title: "Team Lead", toolPacks: ["brain", "team", "workspace"] },
    { key: "specialist", name: "BuilderBeta", purpose: "coding", title: "Engineer", toolPacks: ["brain", "team", "workspace"] },
    { key: "reviewer", name: "VerifierGamma", purpose: "review", title: "QA Reviewer", toolPacks: ["brain", "team", "workspace"] },
  ];
  const agentSpecs = opts.agents || defaultSpecs;

  const agents = [];
  const agentsByKey = {};
  for (const spec of agentSpecs) {
    const agRes = await harness.api("POST", "/api/agents", {
      name: spec.name,
      slug: spec.slug || `${spec.name.toLowerCase()}-${suffix}`,
      title: spec.title || spec.name,
      purpose: spec.purpose || "general",
      provider_id: spec.providerId || provider.id,
      model: spec.model ?? (opts.defaultModel || "mock-gpt-4.1"),
      toolPacks: spec.toolPacks || ["brain", "team", "workspace"],
      system_prompt: spec.systemPrompt || `You are ${spec.name} (${spec.purpose || "general"}).`,
      max_iterations: spec.maxIterations ?? 8,
    });
    if (!agRes.ok || !agRes.data?.id) {
      throw new Error(`Failed to create custom agent ${spec.name}: ${agRes.status} ${agRes.text}`);
    }
    agents.push(agRes.data);
    if (spec.key) agentsByKey[spec.key] = agRes.data;
  }

  const leadId = opts.leadAgentId ?? agentsByKey.lead?.id ?? agents[0]?.id ?? "";
  const reviewerId = opts.reviewerAgentId ?? agentsByKey.reviewer?.id ?? "";
  const senderId = opts.senderAgentId ?? agentsByKey.sender?.id ?? leadId;

  const patchRes = await harness.api("PATCH", `/api/teams/${team.id}`, {
    lead_agent_id: leadId,
    reviewer_agent_id: reviewerId,
    sender_agent_id: senderId,
  });
  if (!patchRes.ok) {
    throw new Error(`Failed to patch team role IDs: ${patchRes.status} ${patchRes.text}`);
  }

  const tbNodeId = `node_tb_${team.id}`;
  const provNodeId = `node_prov_${provider.id}`;
  const nodes = [
    {
      id: tbNodeId,
      type: "team_brain",
      refId: team.team_brain_id,
      label: team.name,
      position: { x: 250, y: 200 },
      data: { teamId: team.id },
    },
    {
      id: provNodeId,
      type: "provider",
      refId: provider.id,
      label: provider.name,
      position: { x: 700, y: 200 },
      data: { providerId: provider.id },
    },
  ];
  const edges = [];

  for (let i = 0; i < agents.length; i++) {
    const ag = agents[i];
    const agNodeId = `node_ag_${ag.id}`;
    nodes.push({
      id: agNodeId,
      type: "agent",
      refId: ag.id,
      label: ag.name,
      position: { x: 480, y: 100 + i * 120 },
      data: { agentId: ag.id },
    });
    edges.push({
      id: `edge_tb_${ag.id}`,
      source: tbNodeId,
      target: agNodeId,
      relation: "brain_link",
      permission: "read_write",
    });
    edges.push({
      id: `edge_prov_${ag.id}`,
      source: provNodeId,
      target: agNodeId,
      relation: "model_binding",
      permission: "read",
    });
  }

  if (opts.wireTopology !== false) {
    const topoRes = await harness.api("PUT", "/api/topology", { nodes, edges });
    if (!topoRes.ok) {
      throw new Error(`Failed to save custom topology: ${topoRes.status} ${topoRes.text}`);
    }
  }

  const teamsGet = await harness.api("GET", "/api/teams");
  const refreshedTeam = (teamsGet.data?.teams || []).find((t) => t.id === team.id) || team;

  return {
    provider,
    team: refreshedTeam,
    agents,
    agentsByKey,
    nodes,
    edges,
    tbNodeId,
    provNodeId,
  };
}

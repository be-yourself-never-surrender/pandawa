import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import { DATA_DIR } from "../config.js";
import { getDb } from "../db/database.js";
import {
  decryptChannelConfig,
  enqueueChannelWork,
  ensureApprovalChannelNotificationHook,
  executeChannelMission,
  handleChannelControlCommand,
  type ChannelRow,
} from "./channelManager.js";

const WA_SESSIONS_DIR = path.join(DATA_DIR, "whatsapp_sessions");

export type WhatsAppRuntimeStatus = "disconnected" | "connecting" | "qr" | "connected" | "logged_out" | "error";

export interface WhatsAppStateSnapshot {
  channelId: string;
  status: WhatsAppRuntimeStatus;
  qrDataUrl: string;
  phoneNumber: string;
  lastError: string;
  lastMessageAt: string;
}

interface WaHandle {
  channelId: string;
  sock: WASocket | null;
  status: WhatsAppRuntimeStatus;
  qrDataUrl: string;
  phoneNumber: string;
  lastError: string;
  lastMessageAt: string;
  disposed: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
}

const handles = new Map<string, WaHandle>();
const threadSessions = new Map<string, string>();
const activeChatSessions = new Map<string, string>();
const waChatQueues = new Map<string, Promise<void>>();
let _broadcast: ((ev: Record<string, unknown>) => void) | undefined;

const silentLogger = pino({ level: "silent" });

function getWhatsAppGraphApiBase(): string {
  return (process.env.PANDAWA_WHATSAPP_GRAPH_API_BASE || "https://graph.facebook.com").replace(/\/+$/, "");
}

function sessionAuthDir(channelId: string): string {
  const safe = channelId.replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(WA_SESSIONS_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(WA_SESSIONS_DIR, 0o700);
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore chmod errors
    }
  }
  return dir;
}

function normalizePhoneDigits(raw: string): string {
  return raw.replace(/@.*$/, "").replace(/[^0-9]/g, "");
}

function parseAllowedNumbers(cfg: Record<string, string>): Set<string> {
  const raw = (cfg.allowedNumbers || cfg.phoneNumber || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => normalizePhoneDigits(s))
      .filter(Boolean)
  );
}

function emitWaState(h: WaHandle): void {
  _broadcast?.({
    type: "whatsapp_status",
    channelId: h.channelId,
    status: h.status,
    qrDataUrl: h.qrDataUrl,
    phoneNumber: h.phoneNumber,
    lastError: h.lastError,
    lastMessageAt: h.lastMessageAt,
  });
}

function cleanupSocketListeners(sock: WASocket | null): void {
  if (!sock) return;
  try {
    const ev = sock.ev as unknown as { removeAllListeners?: (event?: string) => void };
    ev.removeAllListeners?.("creds.update");
    ev.removeAllListeners?.("connection.update");
    ev.removeAllListeners?.("messages.upsert");
  } catch {
    // ignore listener cleanup errors
  }
  try {
    sock.end(undefined);
  } catch {
    // ignore socket end errors
  }
}

function resolveBaileysJids(key: {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
}): { replyJid: string; senderJid: string; replyDigits: string; senderDigits: string } {
  const rawRemote = key.remoteJid || "";
  const altRemote = key.remoteJidAlt || "";
  const replyJid = rawRemote.endsWith("@lid") && altRemote ? altRemote : rawRemote || altRemote;
  const senderJid =
    (key.participant?.endsWith("@lid") && key.participantAlt ? key.participantAlt : key.participant || key.participantAlt) ||
    replyJid;

  return {
    replyJid,
    senderJid,
    replyDigits: normalizePhoneDigits(replyJid),
    senderDigits: normalizePhoneDigits(senderJid),
  };
}

function extractBaileysText(message: Record<string, unknown> | null | undefined): string {
  if (!message) return "";
  if (typeof message.conversation === "string") return message.conversation;
  const ext = message.extendedTextMessage as { text?: string } | undefined;
  if (ext?.text) return ext.text;
  const img = message.imageMessage as { caption?: string } | undefined;
  if (img?.caption) return img.caption;
  const doc = message.documentMessage as { caption?: string } | undefined;
  if (doc?.caption) return doc.caption;
  const vid = message.videoMessage as { caption?: string } | undefined;
  if (vid?.caption) return vid.caption;
  return "";
}

async function sendChunkedBaileysText(sock: WASocket, jid: string, text: string): Promise<void> {
  const maxChunk = 3800;
  for (let i = 0; i < text.length; i += maxChunk) {
    await sock.sendMessage(jid, { text: text.slice(i, i + maxChunk) });
  }
}

function dispatchWhatsAppInbound(params: {
  channelId: string;
  platformKey: string;
  platformLabel: string;
  chatKey: string;
  senderDisplay: string;
  text: string;
  replyFn: (out: string) => Promise<void>;
}): void {
  const db = getDb();
  const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1").get(params.channelId) as
    | ChannelRow
    | undefined;
  if (!ch) return;

  const trimmed = params.text.trim();
  if (!trimmed) return;

  const runDispatch = async () => {
    if (trimmed.startsWith("/")) {
      const handled = await handleChannelControlCommand({
        platformKey: params.platformKey,
        platformLabel: params.platformLabel,
        threadCache: threadSessions,
        activeSessions: activeChatSessions,
        ch,
        chatKey: params.chatKey,
        text: trimmed,
        replyFn: params.replyFn,
        broadcast: _broadcast,
      });
      if (handled) return;
    }

    enqueueChannelWork(waChatQueues, `${params.channelId}:${params.chatKey}`, async () => {
      await executeChannelMission({
        platformKey: params.platformKey,
        platformLabel: params.platformLabel,
        threadCache: threadSessions,
        activeSessions: activeChatSessions,
        channelId: params.channelId,
        chatKey: params.chatKey,
        senderDisplay: params.senderDisplay,
        text: trimmed,
        replyFn: params.replyFn,
        broadcast: _broadcast,
      });
    });
  };

  runDispatch().catch(() => {});
}

export async function startWhatsAppQrChannel(
  channelId: string,
  broadcast?: (ev: Record<string, unknown>) => void
): Promise<WhatsAppStateSnapshot> {
  if (broadcast) _broadcast = broadcast;
  ensureApprovalChannelNotificationHook();

  const existing = handles.get(channelId);
  if (existing && !existing.disposed && (existing.status === "connected" || existing.status === "qr" || existing.status === "connecting")) {
    return getWhatsAppStatus(channelId)!;
  }

  if (existing) {
    existing.disposed = true;
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    cleanupSocketListeners(existing.sock);
    handles.delete(channelId);
  }

  const handle: WaHandle = {
    channelId,
    sock: null,
    status: "connecting",
    qrDataUrl: "",
    phoneNumber: "",
    lastError: "",
    lastMessageAt: "",
    disposed: false,
    reconnectTimer: null,
    reconnectAttempts: 0,
  };
  handles.set(channelId, handle);
  emitWaState(handle);

  const connect = async () => {
    if (handle.disposed) return;
    cleanupSocketListeners(handle.sock);
    handle.sock = null;

    try {
      const authDir = sessionAuthDir(channelId);
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      let version: [number, number, number] | undefined;
      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
      } catch {
        // fallback to Baileys bundled WA version
      }

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger: silentLogger as never,
        browser: Browsers.macOS("Pandawa OS"),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });

      handle.sock = sock;

      sock.ev.on("creds.update", () => {
        saveCreds().catch(() => {});
      });

      sock.ev.on("connection.update", async (update) => {
        if (handle.disposed || handle.sock !== sock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            handle.qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
            handle.status = "qr";
            handle.lastError = "";
            emitWaState(handle);
          } catch (err) {
            handle.lastError = err instanceof Error ? err.message : String(err);
            emitWaState(handle);
          }
        }

        if (connection === "open") {
          handle.status = "connected";
          handle.qrDataUrl = "";
          handle.lastError = "";
          handle.reconnectAttempts = 0;
          handle.phoneNumber = normalizePhoneDigits(sock.user?.id || "");
          emitWaState(handle);
        }

        if (connection === "close") {
          const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          handle.qrDataUrl = "";
          cleanupSocketListeners(sock);

          if (loggedOut) {
            handle.status = "logged_out";
            handle.lastError = "WhatsApp session logged out. Click Connect to scan a new QR code.";
            emitWaState(handle);
            return;
          }

          handle.status = "disconnected";
          handle.lastError = code ? `Connection closed (code ${code}), reconnecting...` : "Reconnecting...";
          emitWaState(handle);

          if (!handle.disposed) {
            handle.reconnectAttempts += 1;
            const delay = Math.min(60_000, 3000 * Math.pow(2, Math.min(handle.reconnectAttempts - 1, 5)));
            if (handle.reconnectTimer) clearTimeout(handle.reconnectTimer);
            handle.reconnectTimer = setTimeout(() => {
              connect().catch(() => {});
            }, delay);
          }
        }
      });

      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (handle.disposed || handle.sock !== sock || type !== "notify") return;
        const db = getDb();
        const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1").get(channelId) as
          | ChannelRow
          | undefined;
        if (!ch) return;

        const cfg = decryptChannelConfig(ch.config_json);
        const allowed = parseAllowedNumbers(cfg);
        const ownDigits = normalizePhoneDigits(sock.user?.id || "");

        for (const msg of messages) {
          const resolved = resolveBaileysJids(
            msg.key as {
              remoteJid?: string | null;
              remoteJidAlt?: string | null;
              participant?: string | null;
              participantAlt?: string | null;
            }
          );
          if (!resolved.replyJid || resolved.replyJid === "status@broadcast") continue;

          const text = extractBaileysText(msg.message as Record<string, unknown> | undefined).trim();
          if (!text) continue;

          const isSelfNote =
            Boolean(msg.key.fromMe) &&
            Boolean(ownDigits) &&
            (resolved.senderDigits === ownDigits || resolved.replyDigits === ownDigits);

          if (msg.key.fromMe) {
            if (!isSelfNote) continue;
            if (!text.startsWith("!") && !text.startsWith("/")) continue;
          }

          if (allowed.size > 0 && !allowed.has(resolved.senderDigits) && !allowed.has(resolved.replyDigits)) {
            continue;
          }

          const cleanPrompt = isSelfNote && text.startsWith("!") ? text.slice(1).trim() : text;
          if (!cleanPrompt) continue;

          handle.lastMessageAt = new Date().toISOString();
          emitWaState(handle);

          const senderDisplay = msg.pushName || resolved.senderDigits || "WhatsApp";
          const targetJid = resolved.replyJid;

          dispatchWhatsAppInbound({
            channelId,
            platformKey: "wa_qr",
            platformLabel: "WhatsApp",
            chatKey: resolved.replyDigits || targetJid,
            senderDisplay,
            text: cleanPrompt,
            replyFn: async (out) => {
              const activeSock = handle.sock || sock;
              await sendChunkedBaileysText(activeSock, targetJid, out);
            },
          });
        }
      });
    } catch (err) {
      handle.status = "error";
      handle.lastError = err instanceof Error ? err.message : String(err);
      emitWaState(handle);
    }
  };

  connect().catch(() => {});
  return getWhatsAppStatus(channelId)!;
}

export async function logoutWhatsAppQrChannel(channelId: string): Promise<void> {
  const h = handles.get(channelId);
  if (h) {
    h.disposed = true;
    if (h.reconnectTimer) clearTimeout(h.reconnectTimer);
    try {
      await h.sock?.logout();
    } catch {
      // ignore logout error
    }
    cleanupSocketListeners(h.sock);
    handles.delete(channelId);
  }
  const safe = channelId.replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(WA_SESSIONS_DIR, safe);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  _broadcast?.({
    type: "whatsapp_status",
    channelId,
    status: "disconnected",
    qrDataUrl: "",
    phoneNumber: "",
    lastError: "",
    lastMessageAt: "",
  });
}

export async function sendWhatsAppQrMessage(
  channelId: string,
  toPhoneOrJid: string,
  text: string
): Promise<{ ok: boolean; detail: string }> {
  const h = handles.get(channelId);
  if (!h || !h.sock || h.status !== "connected") {
    return { ok: false, detail: `WhatsApp QR session is not connected (status=${h?.status || "disconnected"})` };
  }
  const targetRaw = toPhoneOrJid.trim() || h.phoneNumber;
  if (!targetRaw) return { ok: false, detail: "No destination phone number available" };
  const jid = targetRaw.includes("@") ? targetRaw : `${normalizePhoneDigits(targetRaw)}@s.whatsapp.net`;
  await sendChunkedBaileysText(h.sock, jid, text);
  return { ok: true, detail: `Sent to ${jid}` };
}

export function getWhatsAppStatus(channelId: string): WhatsAppStateSnapshot | null {
  const h = handles.get(channelId);
  if (!h) return null;
  return {
    channelId: h.channelId,
    status: h.status,
    qrDataUrl: h.qrDataUrl,
    phoneNumber: h.phoneNumber,
    lastError: h.lastError,
    lastMessageAt: h.lastMessageAt,
  };
}

export function getAllWhatsAppStatuses(): WhatsAppStateSnapshot[] {
  return Array.from(handles.values()).map((h) => ({
    channelId: h.channelId,
    status: h.status,
    qrDataUrl: h.qrDataUrl,
    phoneNumber: h.phoneNumber,
    lastError: h.lastError,
    lastMessageAt: h.lastMessageAt,
  }));
}

export function syncWhatsAppSockets(broadcast?: (ev: Record<string, unknown>) => void): void {
  if (broadcast) _broadcast = broadcast;
  ensureApprovalChannelNotificationHook();
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM channels WHERE type = 'whatsapp_qr' AND enabled = 1")
    .all() as unknown as ChannelRow[];

  const activeIds = new Set(rows.map((r) => r.id));

  for (const [id, h] of handles.entries()) {
    if (!activeIds.has(id)) {
      h.disposed = true;
      if (h.reconnectTimer) clearTimeout(h.reconnectTimer);
      cleanupSocketListeners(h.sock);
      handles.delete(id);
    }
  }

  for (const ch of rows) {
    if (handles.has(ch.id)) continue;
    const safe = ch.id.replace(/[^a-zA-Z0-9_-]/g, "");
    const credsPath = path.join(WA_SESSIONS_DIR, safe, "creds.json");
    if (fs.existsSync(credsPath)) {
      startWhatsAppQrChannel(ch.id, broadcast).catch(() => {});
    }
  }
}

export function stopAllWhatsAppSockets(): void {
  for (const h of handles.values()) {
    h.disposed = true;
    if (h.reconnectTimer) clearTimeout(h.reconnectTimer);
    cleanupSocketListeners(h.sock);
  }
  handles.clear();
}

// =========================================================================
// WHATSAPP OFFICIAL META CLOUD API (2-WAY WEBHOOK)
// =========================================================================

export async function sendWhatsAppCloudMessage(
  cfg: Record<string, string>,
  toPhone: string,
  text: string
): Promise<{ ok: boolean; detail: string }> {
  const phoneNumberId = (cfg.phoneNumberId || "").trim();
  const accessToken = (cfg.accessToken || "").trim();
  const recipient = normalizePhoneDigits(toPhone || cfg.allowedNumbers?.split(/[,;\s]+/)[0] || "");
  if (!phoneNumberId || !accessToken) {
    return { ok: false, detail: "WhatsApp Cloud API missing phoneNumberId or accessToken" };
  }
  if (!recipient) {
    return { ok: false, detail: "WhatsApp Cloud API missing recipient phone number" };
  }

  const base = getWhatsAppGraphApiBase();
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 3800) {
    chunks.push(text.slice(i, i + 3800));
  }

  let lastStatus = 200;
  for (const chunk of chunks) {
    const resp = await fetch(`${base}/v21.0/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { preview_url: false, body: chunk },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    lastStatus = resp.status;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, detail: `Meta Cloud API HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }
  }
  return { ok: true, detail: `Meta Cloud API HTTP ${lastStatus}` };
}

export function verifyWhatsAppCloudSignature(rawBody: Buffer | undefined, signatureHeader: string, appSecret: string): boolean {
  if (!appSecret.trim()) return true;
  if (!rawBody || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret.trim()).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function handleWhatsAppCloudInbound(
  channelId: string,
  body: Record<string, unknown>,
  broadcast?: (ev: Record<string, unknown>) => void
): Promise<{ processed: number }> {
  if (broadcast) _broadcast = broadcast;
  ensureApprovalChannelNotificationHook();
  const db = getDb();
  const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND type = 'whatsapp_cloud' AND enabled = 1").get(channelId) as
    | ChannelRow
    | undefined;
  if (!ch) return { processed: 0 };

  const cfg = decryptChannelConfig(ch.config_json);
  const allowed = parseAllowedNumbers(cfg);
  const entries = Array.isArray(body?.entry) ? (body.entry as Array<Record<string, unknown>>) : [];
  let processed = 0;

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? (entry.changes as Array<Record<string, unknown>>) : [];
    for (const change of changes) {
      const val = (change.value || {}) as Record<string, unknown>;
      const messages = Array.isArray(val.messages) ? (val.messages as Array<Record<string, unknown>>) : [];
      const contacts = Array.isArray(val.contacts) ? (val.contacts as Array<Record<string, unknown>>) : [];

      for (const m of messages) {
        const from = normalizePhoneDigits(String(m.from || ""));
        const textObj = m.text as { body?: string } | undefined;
        const text = String(textObj?.body || "").trim();
        if (!from || !text) continue;
        if (allowed.size > 0 && !allowed.has(from)) continue;

        const contactName = String(
          ((contacts.find((c) => normalizePhoneDigits(String(c.wa_id || "")) === from)?.profile as { name?: string })?.name) ||
            from
        );

        processed += 1;
        dispatchWhatsAppInbound({
          channelId,
          platformKey: "wa_cloud",
          platformLabel: "WA Cloud",
          chatKey: from,
          senderDisplay: contactName,
          text,
          replyFn: async (out) => {
            await sendWhatsAppCloudMessage(cfg, from, out);
          },
        });
      }
    }
  }
  return { processed };
}

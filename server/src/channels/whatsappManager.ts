import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
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
  resolveChannelRouteSummary,
  type ChannelRow,
} from "./channelManager.js";
import {
  MAX_INBOUND_MEDIA_BYTES,
  guessMimeType,
  isImageMimeOrExt,
  saveInboundChannelMedia,
} from "./channelMedia.js";
import type { LLMImageAttachment } from "../providers/llmClient.js";

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
  const docCap = message.documentWithCaptionMessage as
    | { message?: { documentMessage?: { caption?: string } } }
    | undefined;
  if (docCap?.message?.documentMessage?.caption) return docCap.message.documentMessage.caption;
  const vid = message.videoMessage as { caption?: string } | undefined;
  if (vid?.caption) return vid.caption;
  return "";
}

function extractBaileysMediaInfo(
  rawMessage: WAMessage["message"] | null | undefined
): { kind: "image" | "document" | "audio" | "video"; filename?: string; mimeType?: string } | null {
  const normalized = extractMessageContent(rawMessage) as Record<string, unknown> | undefined;
  const m = normalized || (rawMessage as Record<string, unknown> | undefined);
  if (!m) return null;
  if (m.imageMessage) {
    const im = m.imageMessage as { mimetype?: string };
    return { kind: "image", mimeType: im.mimetype || "image/jpeg" };
  }
  const docObj =
    (m.documentMessage as { mimetype?: string; fileName?: string } | undefined) ||
    ((m.documentWithCaptionMessage as { message?: { documentMessage?: { mimetype?: string; fileName?: string } } })
      ?.message?.documentMessage);
  if (docObj) {
    return { kind: "document", filename: docObj.fileName, mimeType: docObj.mimetype || "application/octet-stream" };
  }
  if (m.audioMessage) {
    const au = m.audioMessage as { mimetype?: string };
    return { kind: "audio", mimeType: au.mimetype || "audio/ogg" };
  }
  if (m.videoMessage) {
    const vid = m.videoMessage as { mimetype?: string };
    return { kind: "video", mimeType: vid.mimetype || "video/mp4" };
  }
  return null;
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
  images?: LLMImageAttachment[];
  preparePayload?: () => Promise<{ text: string; images?: LLMImageAttachment[] }>;
  replyFn: (out: string) => Promise<void>;
}): void {
  const db = getDb();
  const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1").get(params.channelId) as
    | ChannelRow
    | undefined;
  if (!ch) return;

  const trimmed = params.text.trim();
  if (!trimmed && !params.preparePayload) return;

  const runDispatch = async () => {
    if (!params.preparePayload && trimmed.startsWith("/")) {
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
      let finalText = trimmed;
      let finalImages = params.images;
      if (params.preparePayload) {
        const prepared = await params.preparePayload();
        finalText = prepared.text.trim();
        finalImages = prepared.images;
      }
      if (!finalText) return;
      await executeChannelMission({
        platformKey: params.platformKey,
        platformLabel: params.platformLabel,
        threadCache: threadSessions,
        activeSessions: activeChatSessions,
        channelId: params.channelId,
        chatKey: params.chatKey,
        senderDisplay: params.senderDisplay,
        text: finalText,
        images: finalImages,
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

          const normalizedContent = extractMessageContent(msg.message);
          const text = extractBaileysText(
            (normalizedContent || msg.message) as Record<string, unknown> | undefined
          ).trim();
          const mediaInfo = extractBaileysMediaInfo(msg.message);
          if (!text && !mediaInfo) continue;

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
          if (!cleanPrompt && !mediaInfo) continue;

          handle.lastMessageAt = new Date().toISOString();
          emitWaState(handle);

          const senderDisplay = msg.pushName || resolved.senderDigits || "WhatsApp";
          const targetJid = resolved.replyJid;
          const route = resolveChannelRouteSummary(ch);
          const routedTeamId = route.targetType === "team" ? route.targetId : undefined;

          dispatchWhatsAppInbound({
            channelId,
            platformKey: "wa_qr",
            platformLabel: "WhatsApp",
            chatKey: resolved.replyDigits || targetJid,
            senderDisplay,
            text: cleanPrompt,
            ...(mediaInfo
              ? {
                  preparePayload: async () => {
                    const buf = await downloadMediaMessage(msg, "buffer", {});
                    const saved = await saveInboundChannelMedia({
                      buffer: Buffer.from(buf),
                      filename: mediaInfo.filename,
                      mimeType: mediaInfo.mimeType,
                      teamId: routedTeamId,
                      prefix: `wa_${mediaInfo.kind}`,
                    });
                    const combined = cleanPrompt
                      ? `${cleanPrompt}\n\n${saved.promptContext}`
                      : `User sent an attachment via WhatsApp.\n\n${saved.promptContext}`;
                    return {
                      text: combined,
                      images: saved.visionImage ? [saved.visionImage] : undefined,
                    };
                  },
                }
              : {}),
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

export async function sendWhatsAppQrMedia(
  channelId: string,
  toPhoneOrJid: string,
  filePath: string,
  caption?: string
): Promise<{ ok: boolean; detail: string }> {
  const h = handles.get(channelId);
  if (!h || !h.sock || h.status !== "connected") {
    return { ok: false, detail: `WhatsApp QR session is not connected (status=${h?.status || "disconnected"})` };
  }
  if (!fs.existsSync(filePath)) return { ok: false, detail: `File not found: ${filePath}` };
  const targetRaw = toPhoneOrJid.trim() || h.phoneNumber;
  if (!targetRaw) return { ok: false, detail: "No destination phone number available" };
  const jid = targetRaw.includes("@") ? targetRaw : `${normalizePhoneDigits(targetRaw)}@s.whatsapp.net`;
  const buf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const mime = guessMimeType(filePath);
  if (isImageMimeOrExt(mime, filePath)) {
    await h.sock.sendMessage(jid, { image: buf, ...(caption ? { caption } : {}) });
  } else {
    await h.sock.sendMessage(jid, {
      document: buf,
      mimetype: mime,
      fileName: filename,
      ...(caption ? { caption } : {}),
    });
  }
  return { ok: true, detail: `Sent media ${filename} to ${jid}` };
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

export async function sendWhatsAppCloudMedia(
  cfg: Record<string, string>,
  toPhone: string,
  filePath: string,
  caption?: string
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
  if (!fs.existsSync(filePath)) return { ok: false, detail: `File not found: ${filePath}` };

  const base = getWhatsAppGraphApiBase();
  const buf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const mime = guessMimeType(filePath);
  const isImg = isImageMimeOrExt(mime, filePath);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([buf], { type: mime }), filename);

  const upResp = await fetch(`${base}/v21.0/${encodeURIComponent(phoneNumberId)}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!upResp.ok) {
    const errText = await upResp.text().catch(() => "");
    return { ok: false, detail: `Meta Cloud media upload HTTP ${upResp.status}: ${errText.slice(0, 200)}` };
  }
  const upJson = (await upResp.json()) as { id?: string };
  if (!upJson.id) return { ok: false, detail: "Meta Cloud media upload did not return media id" };

  const msgType = isImg ? "image" : "document";
  const sendResp = await fetch(`${base}/v21.0/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: msgType,
      [msgType]: {
        id: upJson.id,
        ...(caption?.trim() ? { caption: caption.trim().slice(0, 1000) } : {}),
        ...(!isImg ? { filename } : {}),
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!sendResp.ok) {
    const errText = await sendResp.text().catch(() => "");
    return { ok: false, detail: `Meta Cloud send ${msgType} HTTP ${sendResp.status}: ${errText.slice(0, 200)}` };
  }
  return { ok: true, detail: `Meta Cloud ${msgType} OK (${filename})` };
}

async function downloadWhatsAppCloudMedia(
  cfg: Record<string, string>,
  mediaId: string
): Promise<{ buffer: Buffer; mimeType?: string } | null> {
  const accessToken = (cfg.accessToken || "").trim();
  if (!accessToken || !mediaId) return null;
  const base = getWhatsAppGraphApiBase();
  const metaResp = await fetch(`${base}/v21.0/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!metaResp.ok) return null;
  const meta = (await metaResp.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!meta.url) return null;
  if (meta.file_size && meta.file_size > MAX_INBOUND_MEDIA_BYTES) {
    throw new Error(`WhatsApp Cloud media exceeds 20 MB limit.`);
  }
  const binResp = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!binResp.ok) return null;
  const buffer = Buffer.from(await binResp.arrayBuffer());
  if (buffer.byteLength > MAX_INBOUND_MEDIA_BYTES) {
    throw new Error(`WhatsApp Cloud media exceeds 20 MB limit.`);
  }
  return { buffer, mimeType: meta.mime_type };
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
        if (!from || (allowed.size > 0 && !allowed.has(from))) continue;

        const msgType = String(m.type || "text");
        const textObj = m.text as { body?: string } | undefined;
        const text = String(textObj?.body || "").trim();
        const mediaObj =
          msgType === "image" || msgType === "document" || msgType === "audio" || msgType === "video"
            ? (m[msgType] as { id?: string; caption?: string; mime_type?: string; filename?: string } | undefined)
            : undefined;

        if (!text && !mediaObj?.id) continue;

        const contactName = String(
          ((contacts.find((c) => normalizePhoneDigits(String(c.wa_id || "")) === from)?.profile as { name?: string })?.name) ||
            from
        );

        const route = resolveChannelRouteSummary(ch);
        const routedTeamId = route.targetType === "team" ? route.targetId : undefined;
        processed += 1;

        dispatchWhatsAppInbound({
          channelId,
          platformKey: "wa_cloud",
          platformLabel: "WA Cloud",
          chatKey: from,
          senderDisplay: contactName,
          text,
          ...(mediaObj?.id
            ? {
                preparePayload: async () => {
                  const dl = await downloadWhatsAppCloudMedia(cfg, mediaObj.id!);
                  if (!dl) {
                    return { text: String(mediaObj.caption || text || "").trim() };
                  }
                  const saved = await saveInboundChannelMedia({
                    buffer: dl.buffer,
                    filename: mediaObj.filename,
                    mimeType: mediaObj.mime_type || dl.mimeType,
                    teamId: routedTeamId,
                    prefix: `wacloud_${msgType}`,
                  });
                  const caption = String(mediaObj.caption || text || "").trim();
                  return {
                    text: caption
                      ? `${caption}\n\n${saved.promptContext}`
                      : `User sent an attachment via WhatsApp Cloud.\n\n${saved.promptContext}`,
                    images: saved.visionImage ? [saved.visionImage] : undefined,
                  };
                },
              }
            : {}),
          replyFn: async (out) => {
            await sendWhatsAppCloudMessage(cfg, from, out);
          },
        });
      }
    }
  }
  return { processed };
}

import { PANDAWA_VERSION, generateId } from "../config.js";
import { getDb, getSetting, setSetting } from "../db/database.js";
import { decryptSecret } from "../auth/cryptoVault.js";
import { runAgentTurn } from "../engine/agentRunner.js";
import { runTeamMission, resolveTeamRoles, type TeamMissionAttribution } from "../engine/teamEngine.js";
import { getTeamMembers } from "../engine/contextCompiler.js";
import {
  approveLatest,
  getApprovalMode,
  listPendingApprovals,
  registerSessionApprovalRoute,
  rejectLatest,
  resolveApproval,
  setApprovalRequestedHook,
} from "../engine/approvalManager.js";
import { clearMissionController, abortMission, registerMissionController } from "../engine/missionController.js";
import { listTerminals } from "../tools/terminalManager.js";
import { sendWhatsAppCloudMessage, sendWhatsAppQrMessage } from "./whatsappManager.js";
import type { LLMMessage } from "../providers/llmClient.js";

export interface ChannelRow {
  id: string;
  name: string;
  type: string;
  config_json: string;
  target_type: string;
  target_id: string;
  enabled: number;
}

interface PollerHandle {
  channelId: string;
  name: string;
  active: boolean;
  offset: number;
  lastPollAt: string;
  lastError: string;
  abort: AbortController;
}

export interface ChannelRouteSummary {
  valid: boolean;
  targetType: "team" | "agent";
  targetId: string;
  targetName: string;
  mode?: string;
  leadAgentName?: string;
  reviewerAgentName?: string;
  senderAgentName?: string;
  model?: string;
  errorMessage?: string;
}

const pollers = new Map<string, PollerHandle>();
const tgThreadSessions = new Map<string, string>();
const tgActiveChatSessions = new Map<string, string>();
const tgChatQueues = new Map<string, Promise<void>>();
let _broadcast: ((ev: Record<string, unknown>) => void) | undefined;
let _approvalHookInstalled = false;

export const SECRET_CHANNEL_FIELDS = new Set([
  "botToken",
  "webhookUrl",
  "secret",
  "accessToken",
  "appSecret",
  "verifyToken",
  "signingSecret",
]);

function getTelegramApiBase(): string {
  return (process.env.PANDAWA_TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
}

export function decryptChannelConfig(configJson: string): Record<string, string> {
  try {
    const raw = JSON.parse(configJson || "{}") as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = SECRET_CHANNEL_FIELDS.has(k) ? decryptSecret(String(v || "")) : String(v || "");
    }
    return out;
  } catch {
    return {};
  }
}

export function enqueueChannelWork(
  queueMap: Map<string, Promise<void>>,
  queueKey: string,
  fn: () => Promise<void>
): void {
  const prev = queueMap.get(queueKey) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (queueMap.get(queueKey) === next) {
        queueMap.delete(queueKey);
      }
    });
  queueMap.set(queueKey, next);
}

export function getOrCreateChannelThreadSession(params: {
  platformKey: string;
  cache: Map<string, string>;
  channelId: string;
  chatKey: string;
  label: string;
  targetType: "team" | "agent";
  targetId: string;
}): string {
  const db = getDb();
  const mapKey = `${params.channelId}:${params.chatKey}`;
  const settingKey = `${params.platformKey}_thread_${params.channelId}_${params.chatKey}`;

  let sessionId = params.cache.get(mapKey) || (getSetting(settingKey) || "").trim();
  if (sessionId) {
    const exists = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as { id?: string } | undefined;
    if (exists?.id) {
      params.cache.set(mapKey, sessionId);
      return sessionId;
    }
  }

  sessionId = generateId("ses");
  db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
    sessionId,
    params.label.slice(0, 64),
    params.targetType,
    params.targetId
  );
  params.cache.set(mapKey, sessionId);
  setSetting(settingKey, sessionId);
  return sessionId;
}

export function clearChannelThreadSession(params: {
  platformKey: string;
  cache: Map<string, string>;
  channelId: string;
  chatKey: string;
}): void {
  const mapKey = `${params.channelId}:${params.chatKey}`;
  const settingKey = `${params.platformKey}_thread_${params.channelId}_${params.chatKey}`;
  params.cache.delete(mapKey);
  setSetting(settingKey, "");
}

export function loadChannelChronologicalHistory(sessionId: string, limit = 20): LLMMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC LIMIT ?
       ) ORDER BY created_at ASC`
    )
    .all(sessionId, limit) as Array<{ role: string; content: string }>;
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

export function resolveChannelRouteSummary(ch: ChannelRow): ChannelRouteSummary {
  const db = getDb();
  const targetId = (ch.target_id || "").trim();
  const targetType: "team" | "agent" = ch.target_type === "agent" ? "agent" : "team";

  if (!targetId) {
    return {
      valid: false,
      targetType,
      targetId: "",
      targetName: "(unassigned)",
      errorMessage: `Channel "${ch.name}" has no routed Team or Agent configured. Open Channels or Brain Canvas to assign one.`,
    };
  }

  if (targetType === "agent") {
    const agent = db.prepare("SELECT id, name, model, enabled FROM agents WHERE id = ?").get(targetId) as
      | { id: string; name: string; model: string; enabled: number }
      | undefined;
    if (!agent) {
      return {
        valid: false,
        targetType: "agent",
        targetId,
        targetName: "(missing agent)",
        errorMessage: `Channel "${ch.name}" targets missing agent "${targetId}". Re-route it in Channels or Brain Canvas.`,
      };
    }
    return {
      valid: agent.enabled === 1,
      targetType: "agent",
      targetId: agent.id,
      targetName: agent.name,
      model: agent.model || "default",
      ...(agent.enabled !== 1
        ? { errorMessage: `Target agent "${agent.name}" (${agent.id}) is currently disabled.` }
        : {}),
    };
  }

  const team = db
    .prepare(
      "SELECT id, name, collaboration_mode, lead_agent_id, reviewer_agent_id, sender_agent_id, enabled FROM teams WHERE id = ?"
    )
    .get(targetId) as
    | {
        id: string;
        name: string;
        collaboration_mode: string;
        lead_agent_id?: string;
        reviewer_agent_id?: string;
        sender_agent_id?: string;
        enabled: number;
      }
    | undefined;
  if (!team) {
    return {
      valid: false,
      targetType: "team",
      targetId,
      targetName: "(missing team)",
      errorMessage: `Team not found: "${targetId}". Re-route channel "${ch.name}" in Channels or Brain Canvas.`,
    };
  }

  const members = getTeamMembers(team.id);
  if (members.length === 0) {
    return {
      valid: false,
      targetType: "team",
      targetId: team.id,
      targetName: team.name,
      mode: team.collaboration_mode,
      errorMessage: `Team "${team.name}" (${team.id}) has no enabled agents wired to its Team Brain. Connect agents on Brain Canvas first.`,
    };
  }

  const { lead, reviewer, sender } = resolveTeamRoles(team, members);
  return {
    valid: team.enabled === 1,
    targetType: "team",
    targetId: team.id,
    targetName: team.name,
    mode: team.collaboration_mode,
    leadAgentName: lead.name,
    reviewerAgentName: reviewer.name,
    senderAgentName: sender.name,
    model: sender.model || "default",
    ...(team.enabled !== 1 ? { errorMessage: `Team "${team.name}" (${team.id}) is disabled.` } : {}),
  };
}

export function formatChannelTeamReply(_attribution: TeamMissionAttribution, content: string): string {
  return (content || "").trim() || "(Empty response)";
}

export function formatChannelAgentReply(_agentName: string, _model: string, content: string): string {
  return (content || "").trim() || "(Empty response)";
}

function buildRouteLines(ch: ChannelRow, route: ChannelRouteSummary): string {
  if (!route.valid && route.errorMessage) {
    return `- Channel: ${ch.name}\n- Route: INVALID (${route.errorMessage})`;
  }
  if (route.targetType === "agent") {
    return `- Channel: ${ch.name}\n- Route: Agent -> ${route.targetName} (${route.model || "default"})`;
  }
  return (
    `- Channel: ${ch.name}\n` +
    `- Route: Team -> ${route.targetName} (${route.mode || "execute"})\n` +
    `- Prompt Receiver (Lead): ${route.leadAgentName || "auto"}\n` +
    `- Reviewer / QA: ${route.reviewerAgentName || "auto"}\n` +
    `- Result Sender (Reply): ${route.senderAgentName || "auto"}`
  );
}

export async function handleChannelControlCommand(params: {
  platformKey: string;
  platformLabel: string;
  threadCache: Map<string, string>;
  activeSessions: Map<string, string>;
  ch: ChannelRow;
  chatKey: string;
  text: string;
  replyFn: (out: string) => Promise<void>;
  broadcast?: (ev: Record<string, unknown>) => void;
}): Promise<boolean> {
  const trimmed = params.text.trim();
  if (!trimmed.startsWith("/")) return false;

  const [cmdRaw, arg1] = trimmed.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@[a-z0-9_]+$/i, "");
  const mapKey = `${params.ch.id}:${params.chatKey}`;
  const activeSessionId = params.activeSessions.get(mapKey);
  const route = resolveChannelRouteSummary(params.ch);

  if (cmd === "/start" || cmd === "/help") {
    const body =
      `Pandawa OS v${PANDAWA_VERSION} (${params.platformLabel})\n` +
      `${buildRouteLines(params.ch, route)}\n` +
      `\nSend any message to run your ${route.targetType === "agent" ? "agent" : "team"}, or use:\n` +
      `/status · /stop · /new · /approve [id] · /auto [id] · /reject [id] · /term · /help`;
    await params.replyFn(body);
    return true;
  }

  if (cmd === "/new" || cmd === "/clear" || cmd === "/reset") {
    clearChannelThreadSession({
      platformKey: params.platformKey,
      cache: params.threadCache,
      channelId: params.ch.id,
      chatKey: params.chatKey,
    });
    await params.replyFn(`[${route.targetName}] Started a fresh Pandawa session thread.`);
    return true;
  }

  if (cmd === "/stop" || cmd === "/cancel") {
    if (!activeSessionId) {
      await params.replyFn(`[${route.targetName}] No active mission is currently running in this chat.`);
      return true;
    }
    const stopped = abortMission(activeSessionId);
    await params.replyFn(
      stopped
        ? `[${route.targetName}] Abort signal sent to active mission (${activeSessionId}).`
        : `[${route.targetName}] Active mission (${activeSessionId}) already finished.`
    );
    return true;
  }

  if (cmd === "/approve" || cmd === "/auto" || cmd === "/reject") {
    const approve = cmd !== "/reject";
    const switchToAuto = cmd === "/auto";
    const reason = approve ? undefined : `Rejected via ${params.platformLabel}`;

    if (arg1) {
      const ok = resolveApproval(arg1, approve, {
        switchToAuto,
        reason,
        broadcast: params.broadcast,
      });
      await params.replyFn(
        ok
          ? `Approval ${arg1} -> ${approve ? (switchToAuto ? "APPROVED + AUTO MODE (session)" : "APPROVED") : "REJECTED"}`
          : `Approval ${arg1} not found or already resolved.`
      );
      return true;
    }

    // Prefer chat/channel-scoped pending approval first so concurrent chats never approve the wrong request
    let outcome = approve
      ? approveLatest({ channelId: params.ch.id, chatId: params.chatKey, switchToAuto, broadcast: params.broadcast })
      : rejectLatest({ channelId: params.ch.id, chatId: params.chatKey, reason, broadcast: params.broadcast });

    if (!outcome.ok) {
      outcome = approve
        ? approveLatest({ channelId: params.ch.id, switchToAuto, broadcast: params.broadcast })
        : rejectLatest({ channelId: params.ch.id, chatId: params.chatKey, reason, broadcast: params.broadcast });
    }
    if (!outcome.ok && activeSessionId) {
      outcome = approve
        ? approveLatest({ sessionId: activeSessionId, switchToAuto, broadcast: params.broadcast })
        : rejectLatest({ sessionId: activeSessionId, reason, broadcast: params.broadcast });
    }
    if (!outcome.ok) {
      const anyPending = listPendingApprovals();
      if (anyPending.length === 1 && !anyPending[0].channelId) {
        const only = anyPending[0];
        const ok = resolveApproval(only.id, approve, {
          switchToAuto,
          reason,
          broadcast: params.broadcast,
        });
        if (ok) outcome = { ok: true, id: only.id, record: only };
      }
    }

    if (!outcome.ok || !outcome.id) {
      await params.replyFn("No pending approval requests for this chat right now.");
      return true;
    }

    await params.replyFn(
      `Approval ${outcome.id} -> ${approve ? (switchToAuto ? "APPROVED + AUTO MODE (session)" : "APPROVED") : "REJECTED"}`
    );
    return true;
  }

  if (cmd === "/term" || cmd === "/terminals") {
    const tRes = await listTerminals(activeSessionId ? { sessionId: activeSessionId } : undefined);
    const listToShow =
      tRes.sessions.length > 0 || !activeSessionId ? tRes.sessions : (await listTerminals()).sessions;
    const msgOut =
      listToShow.length === 0
        ? "No active shared terminals."
        : listToShow.map((s) => `- ${s.displayName || s.name} [${s.ownerAgent}] cwd=${s.cwd} cmd=${s.currentCommand}`).join("\n");
    await params.replyFn(`Active Pandawa Terminals:\n${msgOut}`);
    return true;
  }

  if (cmd === "/status") {
    const chatPending = listPendingApprovals({ channelId: params.ch.id, chatId: params.chatKey });
    const allPending = listPendingApprovals();
    const tRes = await listTerminals(activeSessionId ? { sessionId: activeSessionId } : undefined);
    const modeNow = getApprovalMode(activeSessionId);
    await params.replyFn(
      `Pandawa OS v${PANDAWA_VERSION} Status\n` +
        `${buildRouteLines(params.ch, route)}\n` +
        `- Active Mission: ${activeSessionId ? `RUNNING (${activeSessionId})` : "idle"}\n` +
        `- Approval Mode: ${modeNow}\n` +
        `- Pending Approvals (this chat / total): ${chatPending.length} / ${allPending.length}\n` +
        `- Active Terminals: ${tRes.sessions.length}\n` +
        `Commands: /status, /stop, /approve [id], /auto [id], /reject [id], /term, /new, /help`
    );
    return true;
  }

  return false;
}

export async function executeChannelMission(params: {
  platformKey: string;
  platformLabel: string;
  threadCache: Map<string, string>;
  activeSessions: Map<string, string>;
  channelId: string;
  chatKey: string;
  senderDisplay: string;
  text: string;
  replyFn: (out: string) => Promise<void>;
  broadcast?: (ev: Record<string, unknown>) => void;
}): Promise<void> {
  const db = getDb();
  const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1").get(params.channelId) as
    | ChannelRow
    | undefined;
  if (!ch) return;

  const route = resolveChannelRouteSummary(ch);
  if (!route.valid) {
    await params.replyFn(`[${ch.name}] Pandawa configuration error: ${route.errorMessage || "Invalid target."}`);
    return;
  }

  const sessionId = getOrCreateChannelThreadSession({
    platformKey: params.platformKey,
    cache: params.threadCache,
    channelId: ch.id,
    chatKey: params.chatKey,
    label: `[${params.platformLabel}:${params.senderDisplay}] ${params.text.slice(0, 48)}`,
    targetType: route.targetType,
    targetId: route.targetId,
  });

  const history = loadChannelChronologicalHistory(sessionId, 20);

  db.prepare("INSERT INTO messages (id, session_id, role, agent_name, content) VALUES (?, ?, 'user', ?, ?)").run(
    generateId("msg"),
    sessionId,
    `${params.platformLabel} (${params.senderDisplay})`,
    params.text
  );
  db.prepare("UPDATE sessions SET target_type = ?, target_id = ?, updated_at = datetime('now') WHERE id = ?").run(
    route.targetType,
    route.targetId,
    sessionId
  );

  const mapKey = `${ch.id}:${params.chatKey}`;
  const controller = registerMissionController(sessionId);
  params.activeSessions.set(mapKey, sessionId);
  registerSessionApprovalRoute(sessionId, { channelId: ch.id, chatId: params.chatKey });

  const forwardEvent = (ev: Record<string, unknown>) => {
    params.broadcast?.({ ...ev, sessionId, channelId: ch.id });
  };

  try {
    let formattedReply = "";
    if (route.targetType === "agent") {
      const res = await runAgentTurn({
        agentId: route.targetId,
        sessionId,
        prompt: params.text,
        history,
        signal: controller.signal,
        onEvent: forwardEvent,
      });
      formattedReply = formatChannelAgentReply(res.agentName, res.model, res.content);
      db.prepare(
        "INSERT INTO messages (id, session_id, role, agent_id, agent_name, model_used, content, tool_calls_json, meta_json) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)"
      ).run(
        generateId("msg"),
        sessionId,
        res.agentId,
        res.agentName,
        res.model,
        res.content,
        JSON.stringify(res.toolTrace),
        JSON.stringify({
          channelId: ch.id,
          channelName: ch.name,
          platform: params.platformLabel,
          chatId: params.chatKey,
          respondingAgentName: res.agentName,
        })
      );
    } else {
      const res = await runTeamMission({
        teamId: route.targetId,
        sessionId,
        userPrompt: params.text,
        history,
        signal: controller.signal,
        onEvent: forwardEvent,
      });
      formattedReply = formatChannelTeamReply(res.attribution, res.synthesis.content);
      // Enrich final assistant message meta with origin channel metadata for Activity Log
      const latestAssistant = db
        .prepare("SELECT id, meta_json FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1")
        .get(sessionId) as { id: string; meta_json: string } | undefined;
      if (latestAssistant) {
        let metaObj: Record<string, unknown> = {};
        try {
          metaObj = JSON.parse(latestAssistant.meta_json || "{}");
        } catch {
          metaObj = {};
        }
        metaObj.channelId = ch.id;
        metaObj.channelName = ch.name;
        metaObj.platform = params.platformLabel;
        metaObj.chatId = params.chatKey;
        metaObj.attribution = res.attribution;
        db.prepare("UPDATE messages SET meta_json = ? WHERE id = ?").run(JSON.stringify(metaObj), latestAssistant.id);
      }
    }

    await params.replyFn(formattedReply);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await params.replyFn(`Pandawa error: ${errMsg}`);
  } finally {
    clearMissionController(sessionId, controller);
    if (params.activeSessions.get(mapKey) === sessionId) {
      params.activeSessions.delete(mapKey);
    }
  }
}

export async function dispatchChannelNotification(
  channelId: string,
  title: string,
  message: string
): Promise<{ ok: boolean; detail: string }> {
  const db = getDb();
  const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  if (!ch) return { ok: false, detail: "Channel not found" };

  const cfg = decryptChannelConfig(ch.config_json);

  try {
    if (ch.type === "whatsapp_qr") {
      const to = (cfg.allowedNumbers || "").split(/[,;\s]+/)[0] || "";
      return await sendWhatsAppQrMessage(ch.id, to, `*${title}*\n\n${message.slice(0, 3800)}`);
    }

    if (ch.type === "whatsapp_cloud") {
      const to = (cfg.allowedNumbers || "").split(/[,;\s]+/)[0] || "";
      return await sendWhatsAppCloudMessage(cfg, to, `*${title}*\n\n${message.slice(0, 3800)}`);
    }

    if (ch.type === "discord" && cfg.webhookUrl) {
      const resp = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `**${title}**\n${message.slice(0, 1800)}` }),
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: resp.ok, detail: `Discord HTTP ${resp.status}` };
    }

    if (ch.type === "slack" && cfg.webhookUrl) {
      const resp = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${title}*\n${message.slice(0, 3500)}` }),
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: resp.ok, detail: `Slack HTTP ${resp.status}` };
    }

    if (ch.type === "telegram" && cfg.botToken && cfg.chatId) {
      const url = `${getTelegramApiBase()}/bot${cfg.botToken}/sendMessage`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text: `${title}\n\n${message.slice(0, 3800)}`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: resp.ok, detail: `Telegram HTTP ${resp.status}` };
    }

    if (ch.type === "webhook" && cfg.outboundUrl) {
      const resp = await fetch(cfg.outboundUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.secret ? { "X-Pandawa-Secret": cfg.secret } : {}),
        },
        body: JSON.stringify({ title, message, timestamp: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: resp.ok, detail: `Webhook HTTP ${resp.status}` };
    }

    return { ok: false, detail: "Channel missing required endpoint credentials" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function sendTelegramText(botToken: string, chatId: string | number, text: string): Promise<void> {
  const base = getTelegramApiBase();
  const safeText = text || "(Empty response)";
  const chunks: string[] = [];
  for (let i = 0; i < safeText.length; i += 3800) {
    chunks.push(safeText.slice(i, i + 3800));
  }
  for (const chunk of chunks) {
    const resp = await fetch(`${base}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`Telegram sendMessage HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
    }
  }
}

async function sendTelegramTyping(botToken: string, chatId: string | number): Promise<void> {
  try {
    await fetch(`${getTelegramApiBase()}/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // non-fatal typing indicator error
  }
}

async function runTelegramPoller(channelId: string, handle: PollerHandle): Promise<void> {
  const offsetSettingKey = `tg_offset_${channelId}`;
  const savedOffset = Number(getSetting(offsetSettingKey) || 0);
  if (Number.isFinite(savedOffset) && savedOffset > 0) {
    handle.offset = savedOffset;
  }

  while (handle.active) {
    try {
      const db = getDb();
      const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1").get(channelId) as
        | ChannelRow
        | undefined;
      if (!ch) break;

      const cfg = decryptChannelConfig(ch.config_json);
      const botToken = (cfg.botToken || "").trim();
      const allowedChatId = (cfg.chatId || "").trim();
      if (!botToken) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const url = `${getTelegramApiBase()}/bot${botToken}/getUpdates?timeout=25&offset=${handle.offset}`;
      const resp = await fetch(url, { signal: handle.abort.signal });
      handle.lastPollAt = new Date().toISOString();

      if (!resp.ok) {
        handle.lastError = `HTTP ${resp.status}`;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      handle.lastError = "";
      const json = (await resp.json()) as {
        ok?: boolean;
        result?: Array<{
          update_id: number;
          message?: { chat?: { id: number | string }; text?: string; from?: { username?: string; first_name?: string } };
        }>;
      };

      const updates = json.result || [];
      let offsetChanged = false;

      for (const upd of updates) {
        const nextOffset = upd.update_id + 1;
        if (nextOffset > handle.offset) {
          handle.offset = nextOffset;
          offsetChanged = true;
        }

        const msg = upd.message;
        const text = msg?.text?.trim();
        const chatId = msg?.chat?.id;
        if (!text || chatId === undefined) continue;
        const chatKey = String(chatId);
        if (allowedChatId && chatKey !== allowedChatId) continue;

        const liveCh =
          (db.prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1").get(channelId) as ChannelRow | undefined) || ch;
        const sender = msg?.from?.username || msg?.from?.first_name || "Telegram";

        const replyFn = async (out: string) => {
          try {
            await sendTelegramText(botToken, chatId, out);
          } catch (sendErr) {
            handle.lastError = sendErr instanceof Error ? sendErr.message : String(sendErr);
          }
        };

        // Check fast non-blocking control commands FIRST so they execute even while a mission is paused/running
        const cmdCheck = text.trim();
        if (cmdCheck.startsWith("/")) {
          const handled = await handleChannelControlCommand({
            platformKey: "tg",
            platformLabel: "Telegram",
            threadCache: tgThreadSessions,
            activeSessions: tgActiveChatSessions,
            ch: liveCh,
            chatKey,
            text: cmdCheck,
            replyFn,
            broadcast: _broadcast,
          });
          if (handled) continue;
        }

        // Dispatch regular mission via per-(channelId, chatId) FIFO queue WITHOUT blocking getUpdates polling!
        enqueueChannelWork(tgChatQueues, `${channelId}:${chatKey}`, async () => {
          sendTelegramTyping(botToken, chatId).catch(() => {});
          const typingInterval = setInterval(() => {
            sendTelegramTyping(botToken, chatId).catch(() => {});
          }, 4500);
          try {
            await executeChannelMission({
              platformKey: "tg",
              platformLabel: "Telegram",
              threadCache: tgThreadSessions,
              activeSessions: tgActiveChatSessions,
              channelId,
              chatKey,
              senderDisplay: `@${sender}`,
              text,
              replyFn,
              broadcast: _broadcast,
            });
          } finally {
            clearInterval(typingInterval);
          }
        });
      }

      if (offsetChanged) {
        try {
          setSetting(offsetSettingKey, String(handle.offset));
        } catch {
          // non-fatal
        }
      }
    } catch (err) {
      if (!handle.active) break;
      handle.lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function ensureApprovalChannelNotificationHook(): void {
  if (_approvalHookInstalled) return;
  _approvalHookInstalled = true;

  setApprovalRequestedHook((record) => {
    try {
      const db = getDb();
      const preview = JSON.stringify(record.args).slice(0, 320);
      const body =
        `Pandawa Approval Required (${record.id})\n` +
        `Agent: ${record.agentName}\n` +
        `Tool: ${record.toolName}\n` +
        `Args: ${preview}\n\n` +
        `Reply:\n/approve ${record.id}\n/auto ${record.id}\n/reject ${record.id}`;

      const targets = record.channelId
        ? (db
            .prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1")
            .all(record.channelId) as unknown as ChannelRow[])
        : (db
            .prepare(
              "SELECT * FROM channels WHERE type IN ('telegram', 'whatsapp_qr', 'whatsapp_cloud') AND enabled = 1"
            )
            .all() as unknown as ChannelRow[]);

      for (const ch of targets) {
        const cfg = decryptChannelConfig(ch.config_json);
        if (ch.type === "telegram" && cfg.botToken?.trim()) {
          const destChat = record.chatId || cfg.chatId?.trim();
          if (destChat) {
            sendTelegramText(cfg.botToken.trim(), destChat, body).catch(() => {});
          }
        } else if (ch.type === "whatsapp_qr") {
          const to = record.chatId || (cfg.allowedNumbers || "").split(/[,;\s]+/)[0] || "";
          sendWhatsAppQrMessage(ch.id, to, body).catch(() => {});
        } else if (ch.type === "whatsapp_cloud") {
          const to = record.chatId || (cfg.allowedNumbers || "").split(/[,;\s]+/)[0] || "";
          if (to) sendWhatsAppCloudMessage(cfg, to, body).catch(() => {});
        }
      }
    } catch {
      // ignore notification error
    }
  });
}

export function syncTelegramPollers(broadcast?: (ev: Record<string, unknown>) => void): void {
  if (broadcast) _broadcast = broadcast;
  ensureApprovalChannelNotificationHook();

  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM channels WHERE type = 'telegram' AND enabled = 1")
    .all() as unknown as ChannelRow[];

  const activeIds = new Set(rows.map((r) => r.id));

  for (const [id, handle] of pollers.entries()) {
    if (!activeIds.has(id)) {
      handle.active = false;
      handle.abort.abort();
      pollers.delete(id);
    }
  }

  for (const ch of rows) {
    if (pollers.has(ch.id)) continue;
    const cfg = decryptChannelConfig(ch.config_json);
    if (!cfg.botToken?.trim()) continue;

    const handle: PollerHandle = {
      channelId: ch.id,
      name: ch.name,
      active: true,
      offset: 0,
      lastPollAt: "",
      lastError: "",
      abort: new AbortController(),
    };
    pollers.set(ch.id, handle);
    runTelegramPoller(ch.id, handle).catch(() => {});
  }
}

export function stopAllTelegramPollers(): void {
  for (const handle of pollers.values()) {
    handle.active = false;
    handle.abort.abort();
  }
  pollers.clear();
}

export function getTelegramPollerStatuses(): Array<{
  channelId: string;
  name: string;
  active: boolean;
  lastPollAt: string;
  lastError: string;
}> {
  return Array.from(pollers.values()).map((h) => ({
    channelId: h.channelId,
    name: h.name,
    active: h.active,
    lastPollAt: h.lastPollAt,
    lastError: h.lastError,
  }));
}

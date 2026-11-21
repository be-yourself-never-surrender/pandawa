import { generateId } from "../config.js";
import { getDb } from "../db/database.js";
import { decryptSecret } from "../auth/cryptoVault.js";
import { runAgentTurn } from "../engine/agentRunner.js";
import { runTeamMission } from "../engine/teamEngine.js";
import {
  getApprovalMode,
  listPendingApprovals,
  resolveApproval,
  setApprovalRequestedHook,
} from "../engine/approvalManager.js";
import { listTerminals } from "../tools/terminalManager.js";

interface ChannelRow {
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

const pollers = new Map<string, PollerHandle>();
let _broadcast: ((ev: Record<string, unknown>) => void) | undefined;

const SECRET_CHANNEL_FIELDS = new Set(["botToken", "webhookUrl", "secret"]);

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
    if (ch.type === "discord" && cfg.webhookUrl) {
      const resp = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `**${title}**\n${message.slice(0, 1800)}` }),
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: resp.ok, detail: `Discord HTTP ${resp.status}` };
    }

    if (ch.type === "telegram" && cfg.botToken && cfg.chatId) {
      const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
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
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 3800) {
    chunks.push(text.slice(i, i + 3800));
  }
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
      signal: AbortSignal.timeout(15_000),
    });
  }
}

async function runTelegramPoller(ch: ChannelRow, cfg: Record<string, string>, handle: PollerHandle): Promise<void> {
  const botToken = (cfg.botToken || "").trim();
  const allowedChatId = (cfg.chatId || "").trim();
  if (!botToken) return;

  while (handle.active) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=25&offset=${handle.offset}`;
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
          message?: { chat?: { id: number }; text?: string; from?: { username?: string; first_name?: string } };
        }>;
      };

      for (const upd of json.result || []) {
        handle.offset = Math.max(handle.offset, upd.update_id + 1);
        const msg = upd.message;
        const text = msg?.text?.trim();
        const chatId = msg?.chat?.id;
        if (!text || chatId === undefined) continue;
        if (allowedChatId && String(chatId) !== allowedChatId) continue;

        // Instant Remote OS Control Commands from Telegram (Approval Gate, Terminals, Jobs, Status)
        if (text.startsWith("/")) {
          const [cmdRaw, arg1] = text.split(/\s+/);
          const cmd = cmdRaw.toLowerCase();
          if (cmd === "/approve" || cmd === "/auto" || cmd === "/reject") {
            const pending = listPendingApprovals();
            const targetId = arg1 || pending[0]?.id;
            if (!targetId) {
              await sendTelegramText(botToken, chatId, "No pending approval requests right now.").catch(() => {});
              continue;
            }
            const ok = resolveApproval(targetId, cmd !== "/reject", {
              switchToAuto: cmd === "/auto",
              reason: cmd === "/reject" ? "Rejected via Telegram" : undefined,
              broadcast: _broadcast,
            });
            await sendTelegramText(
              botToken,
              chatId,
              ok
                ? `✅ Approval ${targetId} -> ${cmd === "/reject" ? "REJECTED" : cmd === "/auto" ? "APPROVED + AUTO MODE" : "APPROVED"}`
                : `Approval ${targetId} not found or already resolved.`
            ).catch(() => {});
            continue;
          }
          if (cmd === "/term" || cmd === "/terminals") {
            const tRes = await listTerminals();
            const msgOut =
              tRes.sessions.length === 0
                ? "No active shared terminals."
                : tRes.sessions
                    .map((s) => `• ${s.name} [${s.ownerAgent}] cwd=${s.cwd} cmd=${s.currentCommand}`)
                    .join("\n");
            await sendTelegramText(botToken, chatId, `🖥️ Active Pandawa Terminals:\n${msgOut}`).catch(() => {});
            continue;
          }
          if (cmd === "/status") {
            const pending = listPendingApprovals();
            const tRes = await listTerminals();
            await sendTelegramText(
              botToken,
              chatId,
              `⚡ Pandawa v6.0 Live Status\n• Approval Mode: ${getApprovalMode()}\n• Pending Approvals: ${pending.length}\n• Active Terminals: ${tRes.sessions.length}\nCommands: /approve [id], /auto [id], /reject [id], /term, /status`
            ).catch(() => {});
            continue;
          }
        }

        const db = getDb();
        const sessionId = generateId("ses");
        const sender = msg?.from?.username || msg?.from?.first_name || "Telegram";
        db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
          sessionId,
          `[Telegram:${sender}] ${text.slice(0, 48)}`,
          ch.target_type === "agent" ? "agent" : "team",
          ch.target_id || "team_pandawa"
        );
        db.prepare(
          "INSERT INTO messages (id, session_id, role, agent_name, content) VALUES (?, ?, 'user', ?, ?)"
        ).run(generateId("msg"), sessionId, `Telegram (@${sender})`, text);

        try {
          let reply = "";
          if (ch.target_type === "agent") {
            const res = await runAgentTurn({
              agentId: ch.target_id,
              sessionId,
              prompt: text,
              onEvent: _broadcast,
            });
            reply = res.content;
          } else {
            const res = await runTeamMission({
              teamId: ch.target_id || "team_pandawa",
              sessionId,
              userPrompt: text,
              onEvent: _broadcast,
            });
            reply = res.synthesis.content;
          }
          await sendTelegramText(botToken, chatId, reply || "(Empty response)");
        } catch (err) {
          await sendTelegramText(
            botToken,
            chatId,
            `Pandawa error: ${err instanceof Error ? err.message : String(err)}`
          ).catch(() => {});
        }
      }
    } catch (err) {
      if (!handle.active) break;
      handle.lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function syncTelegramPollers(broadcast?: (ev: Record<string, unknown>) => void): void {
  if (broadcast) _broadcast = broadcast;

  // Bridge live Approval Gate requests out to enabled Telegram bots so users can approve from mobile!
  setApprovalRequestedHook((record) => {
    try {
      const db = getDb();
      const tgChannels = db
        .prepare("SELECT * FROM channels WHERE type = 'telegram' AND enabled = 1")
        .all() as unknown as ChannelRow[];
      for (const ch of tgChannels) {
        const cfg = decryptChannelConfig(ch.config_json);
        if (!cfg.botToken?.trim() || !cfg.chatId?.trim()) continue;
        const preview = JSON.stringify(record.args).slice(0, 320);
        const body =
          `🛡️ Pandawa Approval Required (${record.id})\n` +
          `Agent: ${record.agentName}\n` +
          `Tool: ${record.toolName}\n` +
          `Args: ${preview}\n\n` +
          `Reply:\n/approve ${record.id}\n/auto ${record.id}\n/reject ${record.id}`;
        sendTelegramText(cfg.botToken.trim(), cfg.chatId.trim(), body).catch(() => {});
      }
    } catch {
      // ignore notification error
    }
  });

  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM channels WHERE type = 'telegram' AND enabled = 1")
    .all() as unknown as ChannelRow[];

  const activeIds = new Set(rows.map((r) => r.id));

  // Stop removed/disabled pollers
  for (const [id, handle] of pollers.entries()) {
    if (!activeIds.has(id)) {
      handle.active = false;
      handle.abort.abort();
      pollers.delete(id);
    }
  }

  // Start new enabled telegram pollers
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
    runTelegramPoller(ch, cfg, handle).catch(() => {});
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

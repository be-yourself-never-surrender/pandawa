import { getDb } from "../db/database.js";

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  config_json: string;
  target_type: string;
  target_id: string;
  enabled: number;
}

export async function dispatchChannelNotification(
  channelId: string,
  title: string,
  message: string
): Promise<{ ok: boolean; detail: string }> {
  const db = getDb();
  const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  if (!ch) return { ok: false, detail: "Channel not found" };

  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(ch.config_json || "{}") as Record<string, string>;
  } catch {
    cfg = {};
  }

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

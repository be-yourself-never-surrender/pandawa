import fs from "node:fs";
import os from "node:os";
import { generateId } from "../config.js";
import { getDb, getSetting, setSetting, logAudit } from "../db/database.js";
import { readBrainFile, resolveBrainPath, writeBrainFile } from "../brains/brainFs.js";
import { getTeamMembers } from "./contextCompiler.js";
import { runAgentTurn } from "./agentRunner.js";
import { listTerminals } from "../tools/terminalManager.js";
import { listBackgroundJobs } from "./backgroundRunner.js";
import { dispatchChannelNotification } from "../channels/channelManager.js";

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  teamId: string;
  notifyChannelId: string;
  checklistPath: string;
  lastPulseAt: string;
  lastStatus: string;
}

export interface HeartbeatLogRow {
  id: string;
  status: "ok" | "alert" | "error";
  summary: string;
  alerted: number;
  duration_ms: number;
  created_at: string;
}

const DEFAULT_HEARTBEAT_MD = `# Pandawa Autonomous Heartbeat Checklist

This checklist runs periodically whenever the **Proactive Heartbeat Daemon** is enabled.
Agents inspect live terminals, workspace state, background jobs, and open team tasks.

## Routine Checks
1. Check open/blocked tasks on the Shared Team Task Board (\`team_todo_manage\`).
2. Check active shared terminals (\`term_list\`) for crashed servers or unhandled errors if any are running.
3. Review recent failed background jobs and surface concrete recovery steps if needed.
4. Add your own custom watches below (e.g., monitor an API URL with \`http_request\`, watch a project folder, or check disk/service health).

## Output Rule
- If everything is healthy and nothing requires the user's attention, reply with EXACTLY: \`HEARTBEAT_OK\`
- Only trigger an alert if there is a genuine issue, blocker, or high-value proactive finding.
`;

let timer: NodeJS.Timeout | null = null;
let pulsing = false;
let _broadcast: ((ev: Record<string, unknown>) => void) | undefined;

function resolvePrimaryBrainFolder(): string {
  const db = getDb();
  const mainRow = db
    .prepare("SELECT folder_path FROM brains WHERE layer = 'main' ORDER BY created_at ASC LIMIT 1")
    .get() as { folder_path?: string } | undefined;
  if (mainRow?.folder_path) return mainRow.folder_path;
  const anyRow = db
    .prepare("SELECT folder_path FROM brains ORDER BY created_at ASC LIMIT 1")
    .get() as { folder_path?: string } | undefined;
  return anyRow?.folder_path || "";
}

function resolveHeartbeatTeamId(): string {
  const db = getDb();
  const configured = (getSetting("heartbeat_team_id") || "").trim();
  if (configured) {
    const valid = db
      .prepare("SELECT id FROM teams WHERE id = ? AND enabled = 1")
      .get(configured) as { id?: string } | undefined;
    if (valid?.id) return valid.id;
  }
  const firstEnabled = db
    .prepare("SELECT id FROM teams WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1")
    .get() as { id?: string } | undefined;
  if (firstEnabled?.id) return firstEnabled.id;
  const anyTeam = db
    .prepare("SELECT id FROM teams ORDER BY created_at ASC LIMIT 1")
    .get() as { id?: string } | undefined;
  return anyTeam?.id || "";
}

export function ensureHeartbeatChecklist(): string {
  const configured = (getSetting("heartbeat_checklist_path") || "").trim();
  let rel = configured;
  if (rel === "main-brain/HEARTBEAT.md") {
    const db = getDb();
    const hasStarterBrain = db
      .prepare("SELECT 1 as ok FROM brains WHERE folder_path = 'main-brain' OR slug = 'main-brain' LIMIT 1")
      .get() as { ok?: number } | undefined;
    if (!hasStarterBrain && !fs.existsSync(resolveBrainPath(rel))) {
      rel = "";
    }
  }
  if (!rel) {
    const primaryFolder = resolvePrimaryBrainFolder();
    if (!primaryFolder) return "";
    rel = `${primaryFolder}/HEARTBEAT.md`;
  }
  const full = resolveBrainPath(rel);
  if (!fs.existsSync(full)) {
    writeBrainFile(rel, DEFAULT_HEARTBEAT_MD);
  }
  return rel;
}

export function getHeartbeatConfig(): HeartbeatConfig {
  const checklistPath = ensureHeartbeatChecklist();
  return {
    enabled: getSetting("heartbeat_enabled") === "1",
    intervalMinutes: Math.max(5, Math.min(1440, Number(getSetting("heartbeat_interval_min") || 30))),
    teamId: resolveHeartbeatTeamId(),
    notifyChannelId: getSetting("heartbeat_notify_channel_id") || "",
    checklistPath,
    lastPulseAt: getSetting("heartbeat_last_pulse_at") || "",
    lastStatus: getSetting("heartbeat_last_status") || "idle",
  };
}

export function updateHeartbeatConfig(patch: Partial<{
  enabled: boolean;
  intervalMinutes: number;
  teamId: string;
  notifyChannelId: string;
  checklistMarkdown: string;
}>): HeartbeatConfig {
  if (patch.enabled !== undefined) setSetting("heartbeat_enabled", patch.enabled ? "1" : "0");
  if (patch.intervalMinutes !== undefined) {
    const clamped = Math.max(5, Math.min(1440, Math.round(Number(patch.intervalMinutes) || 30)));
    setSetting("heartbeat_interval_min", String(clamped));
  }
  if (patch.teamId !== undefined) {
    const tid = String(patch.teamId || "").trim() || resolveHeartbeatTeamId();
    setSetting("heartbeat_team_id", tid);
  }
  if (patch.notifyChannelId !== undefined) setSetting("heartbeat_notify_channel_id", String(patch.notifyChannelId || ""));
  if (typeof patch.checklistMarkdown === "string" && patch.checklistMarkdown.trim()) {
    const rel = ensureHeartbeatChecklist();
    if (rel) {
      writeBrainFile(rel, patch.checklistMarkdown);
    }
  }
  const next = getHeartbeatConfig();
  logAudit("admin", "heartbeat.configure", "daemon", `enabled=${next.enabled}, every ${next.intervalMinutes}m`);
  rescheduleHeartbeat();
  _broadcast?.({ type: "heartbeat_config_updated", config: next });
  return next;
}

export function listHeartbeatLogs(limit = 30): HeartbeatLogRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM heartbeat_logs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as HeartbeatLogRow[];
}

export async function runHeartbeatPulse(trigger: "daemon" | "manual" = "daemon"): Promise<{
  ok: boolean;
  status: "ok" | "alert" | "error";
  summary: string;
  alerted: boolean;
  durationMs: number;
}> {
  if (pulsing) {
    return { ok: false, status: "ok", summary: "A heartbeat pulse is already running.", alerted: false, durationMs: 0 };
  }
  pulsing = true;
  const started = Date.now();
  const cfg = getHeartbeatConfig();
  const db = getDb();

  try {
    if (!cfg.teamId) {
      throw new Error("No enabled team available for Heartbeat pulse.");
    }

    let checklist = DEFAULT_HEARTBEAT_MD;
    if (cfg.checklistPath) {
      try {
        checklist = readBrainFile(cfg.checklistPath).content;
      } catch {
        // use default
      }
    }

    const [terms, jobs] = await Promise.all([listTerminals(), Promise.resolve(listBackgroundJobs(8))]);
    const openTasks = db
      .prepare("SELECT id, title, owner_agent, status FROM team_tasks WHERE team_id = ? AND status != 'done' LIMIT 15")
      .all(cfg.teamId) as Array<{ id: string; title: string; owner_agent: string; status: string }>;

    const team = db
      .prepare("SELECT id, name, lead_agent_id FROM teams WHERE id = ?")
      .get(cfg.teamId) as { id: string; name: string; lead_agent_id?: string } | undefined;
    const members = getTeamMembers(cfg.teamId);
    const lead =
      (team?.lead_agent_id ? members.find((m) => m.id === team.lead_agent_id) : undefined) ||
      members.find((m) => m.purpose === "strategy") ||
      members[0];
    if (!lead) {
      throw new Error(`No enabled agent wired to team "${team?.name || cfg.teamId}" for Heartbeat pulse.`);
    }

    const systemSnapshot =
      `## Live OS Snapshot (${new Date().toISOString()} | trigger: ${trigger})\n` +
      `- Host Free RAM: ${Math.round(os.freemem() / 1024 / 1024)} MB / ${Math.round(os.totalmem() / 1024 / 1024)} MB\n` +
      `- Active Shared Terminals (${terms.sessions.length}): ${
        terms.sessions.map((s) => `${s.name}[${s.currentCommand}@${s.cwd}]`).join(", ") || "none"
      }\n` +
      `- Recent Background Jobs: ${
        jobs.slice(0, 5).map((j) => `${j.id}:${j.status}`).join(", ") || "none"
      }\n` +
      `- Open Team Tasks (${openTasks.length}): ${
        openTasks.map((t) => `[${t.status}] ${t.title} (${t.owner_agent})`).join("; ") || "none"
      }\n`;

    const res = await runAgentTurn({
      agentId: lead.id,
      teamId: cfg.teamId,
      maxIterations: 10,
      prompt:
        `You are executing a **Pandawa Proactive Heartbeat Pulse**.\n\n` +
        `${systemSnapshot}\n\n` +
        `## Heartbeat Checklist (${cfg.checklistPath}):\n${checklist}\n\n` +
        `Inspect only what is needed. If everything is healthy and nothing requires user attention, reply with EXACTLY \`HEARTBEAT_OK\` (so we don't spam alerts). Otherwise give a crisp, actionable status alert.`,
      extraSystemNote:
        "Proactive Heartbeat Daemon mode: avoid noise; reply HEARTBEAT_OK unless genuine attention or action is needed.",
      onEvent: (ev) => {
        if (ev.type !== "agent_token") _broadcast?.({ ...ev, heartbeat: true });
      },
    });

    const durationMs = Date.now() - started;
    const raw = (res.content || "").trim();
    const isOk = /^HEARTBEAT_OK\b/i.test(raw) || (raw.includes("HEARTBEAT_OK") && raw.length < 180);
    const status: "ok" | "alert" = isOk ? "ok" : "alert";
    const summary = raw.slice(0, 1500);

    let alerted = false;
    if (status === "alert") {
      // Post finding to Team Blackboard
      db.prepare(
        `INSERT INTO blackboard_entries (id, team_id, session_id, author_agent_id, author_name, entry_type, title, content)
         VALUES (?, ?, '', ?, ?, 'finding', ?, ?)`
      ).run(
        generateId("bb"),
        cfg.teamId,
        lead.id,
        `${lead.name} (Heartbeat)`,
        "Proactive Heartbeat Alert",
        summary.slice(0, 1200)
      );

      // Dispatch to configured channel (or first enabled channel if none explicitly picked)
      const targetChannel =
        cfg.notifyChannelId ||
        (db.prepare("SELECT id FROM channels WHERE enabled = 1 LIMIT 1").get() as { id?: string } | undefined)?.id ||
        "";
      if (targetChannel) {
        const out = await dispatchChannelNotification(targetChannel, "🫀 Pandawa Heartbeat Alert", summary);
        alerted = out.ok;
      }
    }

    const logId = generateId("hb");
    db.prepare(
      `INSERT INTO heartbeat_logs (id, status, summary, alerted, duration_ms) VALUES (?, ?, ?, ?, ?)`
    ).run(logId, status, summary, alerted ? 1 : 0, durationMs);

    const nowIso = new Date().toISOString();
    setSetting("heartbeat_last_pulse_at", nowIso);
    setSetting("heartbeat_last_status", status);

    _broadcast?.({
      type: "heartbeat_pulse",
      id: logId,
      status,
      summary: summary.slice(0, 400),
      alerted,
      durationMs,
      timestamp: nowIso,
    });

    return { ok: true, status, summary, alerted, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      `INSERT INTO heartbeat_logs (id, status, summary, alerted, duration_ms) VALUES (?, 'error', ?, 0, ?)`
    ).run(generateId("hb"), msg.slice(0, 1000), durationMs);
    setSetting("heartbeat_last_pulse_at", new Date().toISOString());
    setSetting("heartbeat_last_status", "error");
    return { ok: false, status: "error", summary: msg, alerted: false, durationMs };
  } finally {
    pulsing = false;
  }
}

function rescheduleHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const cfg = getHeartbeatConfig();
  if (!cfg.enabled) return;
  const ms = cfg.intervalMinutes * 60_000;
  timer = setInterval(() => {
    runHeartbeatPulse("daemon").catch(() => {});
  }, ms);
}

export function startHeartbeatDaemon(broadcast?: (ev: Record<string, unknown>) => void): void {
  if (broadcast) _broadcast = broadcast;
  ensureHeartbeatChecklist();
  rescheduleHeartbeat();
}

export function stopHeartbeatDaemon(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

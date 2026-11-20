import { getDb } from "../db/database.js";
import { generateId } from "../config.js";
import { runAgentTurn } from "../engine/agentRunner.js";
import { runTeamMission } from "../engine/teamEngine.js";

interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  target_type: string;
  target_id: string;
  prompt: string;
  enabled: number;
}

function matchCronField(field: string, value: number): boolean {
  const f = field.trim();
  if (f === "*") return true;
  if (f.startsWith("*/")) {
    const step = Number(f.slice(2));
    return Number.isFinite(step) && step > 0 && value % step === 0;
  }
  const parts = f.split(",");
  for (const part of parts) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (value >= a && value <= b) return true;
    } else if (Number(part) === value) {
      return true;
    }
  }
  return false;
}

export function cronMatchesNow(expr: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, mon, dow] = fields;
  return (
    matchCronField(min, now.getMinutes()) &&
    matchCronField(hour, now.getHours()) &&
    matchCronField(dom, now.getDate()) &&
    matchCronField(mon, now.getMonth() + 1) &&
    matchCronField(dow, now.getDay())
  );
}

export async function executeCronJob(
  jobId: string,
  broadcast?: (ev: Record<string, unknown>) => void
): Promise<{ ok: boolean; output: string }> {
  const db = getDb();
  const job = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as CronJobRow | undefined;
  if (!job) throw new Error(`Cron job not found: ${jobId}`);

  db.prepare("UPDATE cron_jobs SET last_run_at = datetime('now'), last_status = 'running' WHERE id = ?").run(jobId);

  try {
    const sessionId = generateId("ses");
    db.prepare(
      "INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)"
    ).run(sessionId, `[Cron] ${job.name}`, job.target_type === "agent" ? "agent" : "team", job.target_id);

    let output = "";
    if (job.target_type === "agent") {
      const res = await runAgentTurn({
        agentId: job.target_id,
        sessionId,
        prompt: job.prompt,
        onEvent: broadcast,
      });
      output = res.content;
    } else {
      const res = await runTeamMission({
        teamId: job.target_id,
        sessionId,
        userPrompt: job.prompt,
        onEvent: broadcast,
      });
      output = res.synthesis.content;
    }

    db.prepare(
      "UPDATE cron_jobs SET last_status = 'success', last_output = ? WHERE id = ?"
    ).run(output.slice(0, 4000), jobId);
    return { ok: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE cron_jobs SET last_status = 'error', last_output = ? WHERE id = ?").run(
      msg.slice(0, 2000),
      jobId
    );
    return { ok: false, output: msg };
  }
}

let timer: NodeJS.Timeout | null = null;
let lastCheckedMinute = "";

export function startCronScheduler(broadcast?: (ev: Record<string, unknown>) => void): void {
  if (timer) return;
  timer = setInterval(() => {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (minuteKey === lastCheckedMinute) return;
    lastCheckedMinute = minuteKey;

    try {
      const db = getDb();
      const jobs = db.prepare("SELECT * FROM cron_jobs WHERE enabled = 1").all() as unknown as CronJobRow[];
      for (const job of jobs) {
        if (cronMatchesNow(job.schedule, now)) {
          executeCronJob(job.id, broadcast).catch(() => {});
        }
      }
    } catch {
      // ignore scheduler tick errors
    }
  }, 15_000);
}

export function stopCronScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

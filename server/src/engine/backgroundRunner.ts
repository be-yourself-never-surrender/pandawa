import { generateId } from "../config.js";
import { getDb } from "../db/database.js";
import type { LLMImageAttachment, LLMMessage } from "../providers/llmClient.js";
import { runAgentTurn } from "./agentRunner.js";
import { runTeamMission } from "./teamEngine.js";
import { registerMissionController, clearMissionController, abortMission } from "./missionController.js";
import { dispatchChannelNotification } from "../channels/channelManager.js";

export interface BackgroundJobRow {
  id: string;
  session_id: string;
  target_type: string;
  target_id: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "aborted";
  progress_text: string;
  result_preview: string;
  error_text: string;
  notify_channel_id: string;
  created_at: string;
  started_at: string;
  finished_at: string;
}

export function listBackgroundJobs(limit = 40): BackgroundJobRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as BackgroundJobRow[];
}

export function getBackgroundJob(id: string): BackgroundJobRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as unknown as BackgroundJobRow | undefined;
}

export function cancelBackgroundJob(id: string, broadcast?: (ev: Record<string, unknown>) => void): boolean {
  const job = getBackgroundJob(id);
  if (!job) return false;
  const stopped = abortMission(job.session_id);
  const db = getDb();
  db.prepare(
    `UPDATE background_jobs SET status = 'aborted', progress_text = 'Aborted by user', finished_at = datetime('now') WHERE id = ?`
  ).run(id);
  broadcast?.({ type: "background_job_updated", jobId: id, sessionId: job.session_id, status: "aborted" });
  return stopped || job.status === "queued" || job.status === "running";
}

export function enqueueBackgroundMission(params: {
  sessionId: string;
  targetType: "team" | "agent";
  targetId: string;
  prompt: string;
  enrichedPrompt: string;
  images?: LLMImageAttachment[];
  history?: LLMMessage[];
  activeAgentIds?: string[];
  modeOverride?: string;
  notifyChannelId?: string;
  broadcast: (ev: Record<string, unknown>) => void;
}): { jobId: string; sessionId: string } {
  const db = getDb();
  const jobId = generateId("job");

  db.prepare(
    `INSERT INTO background_jobs (id, session_id, target_type, target_id, prompt, status, progress_text, notify_channel_id)
     VALUES (?, ?, ?, ?, ?, 'queued', 'Queued in Pandawa Background Daemon...', ?)`
  ).run(
    jobId,
    params.sessionId,
    params.targetType,
    params.targetId,
    params.prompt.slice(0, 2000),
    params.notifyChannelId || ""
  );

  params.broadcast({
    type: "background_job_updated",
    jobId,
    sessionId: params.sessionId,
    status: "queued",
    progressText: "Queued in Pandawa Background Daemon...",
  });

  // Launch decoupled asynchronous execution (survives browser close!)
  setImmediate(async () => {
    const controller = registerMissionController(params.sessionId);
    const updateProgress = (progress: string) => {
      try {
        db.prepare("UPDATE background_jobs SET progress_text = ? WHERE id = ?").run(progress.slice(0, 280), jobId);
      } catch {
        // ignore
      }
    };

    try {
      db.prepare(
        `UPDATE background_jobs SET status = 'running', started_at = datetime('now'), progress_text = 'Running autonomously...' WHERE id = ?`
      ).run(jobId);
      params.broadcast({
        type: "background_job_updated",
        jobId,
        sessionId: params.sessionId,
        status: "running",
        progressText: "Running autonomously...",
      });

      const onEvent = (ev: Record<string, unknown>) => {
        params.broadcast({ ...ev, sessionId: params.sessionId, jobId });
        if (ev.type === "team_phase" && ev.detail) {
          updateProgress(String(ev.detail));
        } else if (ev.type === "tool_call") {
          updateProgress(`${ev.agentName}: ${ev.toolName} (step ${ev.step || "?"})`);
        }
      };

      let summaryText = "";
      if (params.targetType === "agent") {
        const res = await runAgentTurn({
          agentId: params.targetId,
          sessionId: params.sessionId,
          prompt: params.enrichedPrompt,
          images: params.images,
          history: params.history,
          signal: controller.signal,
          onEvent,
        });
        summaryText = res.content;

        const msgId = generateId("msg");
        db.prepare(
          `INSERT INTO messages (id, session_id, role, agent_id, agent_name, model_used, content, reasoning, tool_calls_json, meta_json)
           VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          msgId,
          params.sessionId,
          res.agentId,
          res.agentName,
          res.model,
          res.content,
          res.reasoning,
          JSON.stringify(res.toolTrace),
          JSON.stringify({
            avatar: res.avatar,
            providerName: res.providerName,
            durationMs: res.durationMs,
            stepsUsed: res.stepsUsed,
            backgroundJobId: jobId,
          })
        );
      } else {
        const res = await runTeamMission({
          teamId: params.targetId,
          sessionId: params.sessionId,
          userPrompt: params.enrichedPrompt,
          images: params.images,
          history: params.history,
          activeAgentIds: params.activeAgentIds,
          modeOverride: params.modeOverride,
          signal: controller.signal,
          onEvent,
        });
        summaryText = res.synthesis.content;
      }

      db.prepare(
        `UPDATE background_jobs
         SET status = 'completed', progress_text = 'Completed', result_preview = ?, finished_at = datetime('now')
         WHERE id = ?`
      ).run(summaryText.slice(0, 1500), jobId);

      params.broadcast({
        type: "background_job_updated",
        jobId,
        sessionId: params.sessionId,
        status: "completed",
        progressText: "Completed",
        resultPreview: summaryText.slice(0, 400),
      });

      if (params.notifyChannelId) {
        await dispatchChannelNotification(
          params.notifyChannelId,
          `Pandawa Background Mission Completed (${jobId})`,
          summaryText.slice(0, 3200)
        ).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAborted = /aborted|stopped by user/i.test(msg);
      const nextStatus = isAborted ? "aborted" : "failed";
      db.prepare(
        `UPDATE background_jobs
         SET status = ?, progress_text = ?, error_text = ?, finished_at = datetime('now')
         WHERE id = ?`
      ).run(nextStatus, isAborted ? "Aborted by user" : "Failed", msg.slice(0, 1000), jobId);

      params.broadcast({
        type: "background_job_updated",
        jobId,
        sessionId: params.sessionId,
        status: nextStatus,
        error: msg,
      });

      if (params.notifyChannelId && !isAborted) {
        await dispatchChannelNotification(
          params.notifyChannelId,
          `Pandawa Background Mission Failed (${jobId})`,
          msg
        ).catch(() => {});
      }
    } finally {
      clearMissionController(params.sessionId, controller);
    }
  });

  return { jobId, sessionId: params.sessionId };
}

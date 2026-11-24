import { exec } from "node:child_process";
import { promisify } from "node:util";
import { WORKSPACE_DIR, generateId, resolveTeamWorkspaceDir } from "../config.js";
import { getDb } from "../db/database.js";
import type { LLMImageAttachment, LLMMessage } from "../providers/llmClient.js";
import { getTeamMembers, type AgentRecord } from "./contextCompiler.js";
import { runAgentTurn, type AgentRunResult } from "./agentRunner.js";
import { toolRequiresApproval, requestApproval } from "./approvalManager.js";
import { clearSessionFileLocks } from "../tools/toolRegistry.js";

const execAsync = promisify(exec);

export interface VerificationCheckResult {
  title: string;
  command: string;
  exitCode: number;
  passed: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface LeadTriageSummary {
  action: "direct_reply" | "delegate";
  reason?: string;
  delegatedAgents: string[];
  skippedReview: boolean;
}

export interface TeamMissionAttribution {
  teamId: string;
  teamName: string;
  leadAgentId: string;
  leadAgentName: string;
  reviewerAgentId: string;
  reviewerAgentName: string;
  senderAgentId: string;
  senderAgentName: string;
  senderModel: string;
  mode: string;
}

export function resolveTeamRoles(
  team: { lead_agent_id?: string | null; reviewer_agent_id?: string | null; sender_agent_id?: string | null },
  members: AgentRecord[]
): {
  lead: AgentRecord;
  specialists: AgentRecord[];
  reviewer: AgentRecord;
  sender: AgentRecord;
} {
  const lead =
    (team.lead_agent_id ? members.find((m) => m.id === team.lead_agent_id) : undefined) ||
    members.find((m) => m.purpose === "strategy") ||
    members[0];
  const specialists = members.filter((m) => m.id !== lead.id);
  const reviewer =
    (team.reviewer_agent_id ? members.find((m) => m.id === team.reviewer_agent_id) : undefined) ||
    specialists.find((m) => m.purpose === "review") ||
    members.find((m) => m.purpose === "review") ||
    lead;
  const sender =
    (team.sender_agent_id ? members.find((m) => m.id === team.sender_agent_id) : undefined) ||
    lead;
  return { lead, specialists, reviewer, sender };
}

export interface TeamInteractionStats {
  workspaceDir: string;
  teamMessages: number;
  blackboardEntries: number;
  peerConsults: number;
  activeTasks: number;
}

export interface TeamMissionResult {
  teamId: string;
  teamName: string;
  mode: string;
  attribution: TeamMissionAttribution;
  triage?: LeadTriageSummary;
  contributions: AgentRunResult[];
  synthesis: AgentRunResult;
  blackboardCount: number;
  verified?: boolean;
  verificationChecks?: VerificationCheckResult[];
  interactions?: TeamInteractionStats;
}

function collectTeamInteractionStats(
  teamId: string,
  sessionId: string,
  runs: AgentRunResult[]
): TeamInteractionStats {
  const db = getDb();
  const teamMessages = (
    db
      .prepare("SELECT COUNT(*) as c FROM team_messages WHERE team_id = ? AND session_id = ?")
      .get(teamId, sessionId) as { c: number }
  ).c;
  const blackboardEntries = (
    db
      .prepare("SELECT COUNT(*) as c FROM blackboard_entries WHERE team_id = ? AND session_id = ?")
      .get(teamId, sessionId) as { c: number }
  ).c;
  const activeTasks = (
    db
      .prepare("SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ? AND session_id = ?")
      .get(teamId, sessionId) as { c: number }
  ).c;
  const peerConsults = runs.reduce(
    (sum, r) => sum + r.toolTrace.filter((t) => t.name === "consult_teammate").length,
    0
  );
  return {
    workspaceDir: resolveTeamWorkspaceDir(teamId),
    teamMessages,
    blackboardEntries,
    peerConsults,
    activeTasks,
  };
}

export async function runProgrammaticVerifyCommands(
  tasks: Array<{ title: string; verifyCmd?: string }>,
  options?: {
    cwd?: string;
    reviewerId?: string;
    sessionId?: string;
    signal?: AbortSignal;
    onEvent?: (ev: Record<string, unknown>) => void;
    skipApproval?: boolean;
  }
): Promise<VerificationCheckResult[]> {
  const results: VerificationCheckResult[] = [];
  const cwd = options?.cwd || WORKSPACE_DIR;
  const seen = new Set<string>();

  for (const t of tasks) {
    const cmd = (t.verifyCmd || "").trim();
    if (!cmd || seen.has(cmd)) continue;
    seen.add(cmd);

    if (!options?.skipApproval && toolRequiresApproval("shell_exec", options?.sessionId)) {
      const decision = await requestApproval({
        agentId: options?.reviewerId || "verifier",
        agentName: "Pandawa Programmatic Verifier",
        toolName: "verify_cmd",
        args: { task: t.title, command: cmd },
        sessionId: options?.sessionId,
        signal: options?.signal,
        onEvent: options?.onEvent,
      });
      if (!decision.approved) {
        results.push({
          title: t.title,
          command: cmd,
          exitCode: -1,
          passed: false,
          stdout: "",
          stderr: `Verification command rejected by user${decision.reason ? `: ${decision.reason}` : "."}`,
          durationMs: 0,
        });
        continue;
      }
    }

    const started = Date.now();
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      results.push({
        title: t.title,
        command: cmd,
        exitCode: 0,
        passed: true,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 2000),
        durationMs: Date.now() - started,
      });
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      results.push({
        title: t.title,
        command: cmd,
        exitCode: typeof e.code === "number" ? e.code : 1,
        passed: false,
        stdout: String(e.stdout || "").slice(0, 4000),
        stderr: String(e.stderr || e.message || String(err)).slice(0, 2500),
        durationMs: Date.now() - started,
      });
    }
  }
  return results;
}

/**
 * Machine-enforced verification gate:
 * If programmatic verify commands were run, ALL must exit 0 for verified=true
 * (prevents false-positive VERDICT: PASS hallucinations from LLM reviewers).
 */
export function computeVerificationVerdict(checks: VerificationCheckResult[], reviewerText: string): boolean {
  const reviewerRejected = /VERDICT:\s*NEEDS_FIX/i.test(reviewerText);
  const reviewerPassed = /VERDICT:\s*PASS/i.test(reviewerText) && !reviewerRejected;
  if (checks.length > 0) {
    return checks.every((c) => c.passed) && !reviewerRejected;
  }
  return reviewerPassed;
}

interface TeamRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  team_brain_id: string | null;
  collaboration_mode: string;
  max_rounds: number;
  lead_agent_id?: string;
  reviewer_agent_id?: string;
  sender_agent_id?: string;
}

interface PlannedTask {
  title: string;
  owner: string;
  files?: string[];
  verifyCmd?: string;
  instructions: string;
}

function saveMessage(params: {
  sessionId: string;
  role: string;
  agentId?: string;
  agentName?: string;
  modelUsed?: string;
  content: string;
  reasoning?: string;
  toolCalls?: unknown[];
  meta?: Record<string, unknown>;
}): string {
  const db = getDb();
  const id = generateId("msg");
  db.prepare(
    `INSERT INTO messages (id, session_id, role, agent_id, agent_name, model_used, content, reasoning, tool_calls_json, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.sessionId,
    params.role,
    params.agentId || "",
    params.agentName || "",
    params.modelUsed || "",
    params.content,
    params.reasoning || "",
    JSON.stringify(params.toolCalls || []),
    JSON.stringify(params.meta || {})
  );
  try {
    db.prepare(
      `INSERT INTO messages_fts (message_id, session_id, agent_name, content) VALUES (?, ?, ?, ?)`
    ).run(id, params.sessionId, params.agentName || params.role, params.content);
  } catch {
    // ignore FTS index errors
  }
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(params.sessionId);
  return id;
}

function isFatalMissionError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if ((err as { statusCode?: number })?.statusCode === 422) return true;
  if (err instanceof Error && /Mission stopped by user/i.test(err.message)) return true;
  return false;
}

function makeFallbackAgentResult(agent: AgentRecord, phaseLabel: string, err: unknown): AgentRunResult {
  const errMsg = err instanceof Error ? err.message : String(err);
  return {
    agentId: agent.id,
    agentName: agent.name,
    avatar: agent.avatar,
    model: agent.model,
    providerName: "Error",
    content: `[${agent.name} (${phaseLabel}) error: ${errMsg}]`,
    reasoning: "",
    toolTrace: [],
    promptTokens: 0,
    completionTokens: 0,
    durationMs: 0,
  };
}

function makeFallbackSynthesis(
  sender: AgentRecord,
  teamName: string,
  contributions: AgentRunResult[],
  err: unknown,
  checks?: VerificationCheckResult[]
): AgentRunResult {
  const errMsg = err instanceof Error ? err.message : String(err);
  const excerpts = contributions
    .slice(-4)
    .map((c) => `- **${c.agentName}**: ${c.content.slice(0, 500)}`);
  const checkSummary =
    checks && checks.length > 0
      ? `\n\nVerification checks:\n${checks
          .map((c) => `- ${c.title}: ${c.passed ? "PASS (exit 0)" : `FAIL (exit ${c.exitCode})`}`)
          .join("\n")}`
      : "";
  return {
    agentId: sender.id,
    agentName: sender.name,
    avatar: sender.avatar,
    model: sender.model,
    providerName: "Error",
    content:
      `[${teamName} synthesis fallback — ${sender.name} encountered an error: ${errMsg}]\n\n` +
      (excerpts.length > 0 ? `Recent agent outputs:\n${excerpts.join("\n")}` : "No prior agent outputs recorded.") +
      checkSummary,
    reasoning: "",
    toolTrace: [],
    promptTokens: 0,
    completionTokens: 0,
    durationMs: 0,
  };
}

export interface LeadTriagePlan {
  action: "direct_reply" | "delegate";
  reply?: string;
  reason?: string;
  needsReview: boolean;
  tasks: PlannedTask[];
}

function normalizeTaskList(arr: Array<Record<string, unknown>>, specialists: AgentRecord[]): PlannedTask[] {
  return arr
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      title: String(item.title || "Execution Task").slice(0, 120),
      owner: String(item.owner || item.agentName || item.agent || specialists[0]?.name || ""),
      files: Array.isArray(item.files) ? item.files.map(String) : [],
      verifyCmd: item.verifyCmd ? String(item.verifyCmd) : item.verify_cmd ? String(item.verify_cmd) : "",
      instructions: String(item.instructions || item.instruction || item.description || item.title || ""),
    }))
    .filter((t) => t.instructions.trim().length > 0)
    .slice(0, 8);
}

export function parseLeadTriagePlan(rawText: string, specialists: AgentRecord[]): LeadTriagePlan {
  const candidates: Array<{ parsed: unknown; stripPattern?: string }> = [];

  // 1. Scan fenced code blocks from last to first
  const fenced = Array.from(rawText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).reverse();
  for (const m of fenced) {
    try {
      const parsed = JSON.parse(m[1].trim());
      candidates.push({ parsed, stripPattern: m[0] });
      break;
    } catch {
      // try previous fenced block
    }
  }

  // 2. Fallback to raw JSON object or top-level array
  if (candidates.length === 0) {
    const trimmed = rawText.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        candidates.push({ parsed: JSON.parse(trimmed), stripPattern: trimmed });
      } catch {
        // continue to substring scan
      }
    }
    if (candidates.length === 0) {
      const firstObj = rawText.indexOf("{");
      const lastObj = rawText.lastIndexOf("}");
      const firstArr = rawText.indexOf("[");
      const lastArr = rawText.lastIndexOf("]");
      const slices: Array<{ pos: number; raw: string }> = [];
      if (firstObj !== -1 && lastObj > firstObj) {
        slices.push({ pos: firstObj, raw: rawText.slice(firstObj, lastObj + 1) });
      }
      if (firstArr !== -1 && lastArr > firstArr) {
        slices.push({ pos: firstArr, raw: rawText.slice(firstArr, lastArr + 1) });
      }
      slices.sort((a, b) => a.pos - b.pos);
      for (const s of slices) {
        try {
          candidates.push({ parsed: JSON.parse(s.raw), stripPattern: s.raw });
          break;
        } catch {
          // try next slice
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { action: "delegate", needsReview: true, tasks: [] };
  }

  const { parsed, stripPattern } = candidates[0];
  if (Array.isArray(parsed)) {
    return {
      action: "delegate",
      needsReview: true,
      tasks: normalizeTaskList(parsed as Array<Record<string, unknown>>, specialists),
    };
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const actionRaw = String(obj.action || obj.mode || "").trim().toLowerCase();
    const isDirect =
      actionRaw === "direct_reply" ||
      actionRaw === "direct" ||
      (Array.isArray(obj.tasks) &&
        obj.tasks.length === 0 &&
        (typeof obj.reply === "string" || typeof obj.answer === "string" || typeof obj.response === "string"));

    if (isDirect) {
      let reply = String(obj.reply ?? obj.answer ?? obj.response ?? "").trim();
      if (!reply && stripPattern) {
        reply = rawText.replace(stripPattern, "").trim();
      }
      if (!reply) {
        return { action: "delegate", needsReview: true, tasks: [] };
      }
      const reason = String(obj.reason || obj.summary || "").trim() || undefined;
      return {
        action: "direct_reply",
        reply,
        ...(reason ? { reason } : {}),
        needsReview: false,
        tasks: [],
      };
    }

    if (Array.isArray(obj.tasks) || actionRaw === "delegate") {
      const tasks = Array.isArray(obj.tasks)
        ? normalizeTaskList(obj.tasks as Array<Record<string, unknown>>, specialists)
        : [];
      const needsReview = obj.needsReview === false || obj.needs_review === false ? false : true;
      const reason = String(obj.reason || obj.planSummary || "").trim() || undefined;
      return {
        action: "delegate",
        ...(reason ? { reason } : {}),
        needsReview,
        tasks,
      };
    }
  }

  return { action: "delegate", needsReview: true, tasks: [] };
}

function matchAgentByName(name: string, candidates: AgentRecord[]): AgentRecord {
  const q = name.trim().toLowerCase();
  return (
    candidates.find((c) => c.name.toLowerCase() === q) ||
    candidates.find((c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())) ||
    candidates[0]
  );
}

async function maybeAutoReflect(params: {
  team: TeamRow;
  sessionId: string;
  synthesizer: AgentRecord;
  userPrompt: string;
  contributions: AgentRunResult[];
  synthesis: AgentRunResult;
  signal?: AbortSignal;
  onEvent?: (ev: Record<string, unknown>) => void;
}): Promise<void> {
  if (params.signal?.aborted) return;
  const totalTools =
    params.contributions.reduce((acc, c) => acc + c.toolTrace.length, 0) + params.synthesis.toolTrace.length;
  if (totalTools < 3) return;

  try {
    params.onEvent?.({
      type: "team_phase",
      phase: "auto_reflection",
      detail: `${params.synthesizer.avatar} ${params.synthesizer.name} distilling reusable lessons into Team Brain...`,
    });
    await runAgentTurn({
      agentId: params.synthesizer.id,
      teamId: params.team.id,
      sessionId: params.sessionId,
      maxIterations: 3,
      signal: params.signal,
      prompt:
        `Post-Mission Self-Reflection (internal, do NOT write a long essay):\n` +
        `Mission: ${params.userPrompt.slice(0, 600)}\n` +
        `Total tool calls executed by team: ${totalTools}\n` +
        `Final Outcome Summary:\n${params.synthesis.content.slice(0, 1800)}\n\n` +
        `If the team uncovered a durable environment fact, user preference, architectural decision, or bug fix worth remembering in future sessions, call \`remember_fact\` (1-2 concise items max). ` +
        `If a repeatable multi-step workflow emerged, optionally call \`learn_skill\`. Otherwise reply "NO_NEW_MEMORY".`,
      extraSystemNote:
        "You are running Pandawa's automatic post-mission closed-loop reflection. Be ultra-selective: store only high-value durable facts or skills.",
      onEvent: (ev) => {
        // Don't stream internal reflection text tokens to chat bubble
        if (ev.type !== "agent_token") params.onEvent?.(ev);
      },
    });
  } catch {
    // non-fatal reflection
  }
}

export async function runTeamMission(params: {
  teamId: string;
  sessionId: string;
  userPrompt: string;
  images?: LLMImageAttachment[];
  history?: LLMMessage[];
  activeAgentIds?: string[];
  modeOverride?: string;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<TeamMissionResult> {
  const db = getDb();
  const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(params.teamId) as TeamRow | undefined;
  if (!team) throw new Error(`Team not found: ${params.teamId}`);

  let members = getTeamMembers(team.id);
  if (params.activeAgentIds && params.activeAgentIds.length > 0) {
    const allow = new Set(params.activeAgentIds);
    const filtered = members.filter((m) => allow.has(m.id));
    if (filtered.length > 0) members = filtered;
  }

  if (members.length === 0) {
    const err = new Error(
      `Team "${team.name}" (${team.id}) has no enabled agents wired to its Team Brain. Open Brain Canvas and connect at least one enabled agent.`
    ) as Error & { statusCode?: number };
    err.statusCode = 422;
    throw err;
  }

  const mode = params.modeOverride || team.collaboration_mode || "deliberate";
  const { lead, specialists, reviewer, sender } = resolveTeamRoles(team, members);

  const attribution: TeamMissionAttribution = {
    teamId: team.id,
    teamName: team.name,
    leadAgentId: lead.id,
    leadAgentName: lead.name,
    reviewerAgentId: reviewer.id,
    reviewerAgentName: reviewer.name,
    senderAgentId: sender.id,
    senderAgentName: sender.name,
    senderModel: sender.model || "",
    mode,
  };

  params.onEvent?.({
    type: "team_phase",
    teamId: team.id,
    teamName: team.name,
    mode,
    phase: "activation",
    attribution,
    members: members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, purpose: m.purpose, model: m.model })),
  });

  const contributions: AgentRunResult[] = [];

  try {
    // =========================================================================
    // MODE: EXECUTE (Smart Triage -> Selective Specialists -> Verify -> Deliver)
    // =========================================================================
    if (mode === "execute") {
      const builders = specialists.filter((m) => m.id !== reviewer.id);
      const fallbackRoster = builders.length > 0 ? builders : specialists.length > 0 ? specialists : [lead];
      const selectableRoster = specialists.length > 0 ? specialists : [lead];

      // Phase 1: Smart Triage & Selective Task Decomposition by Lead
      params.onEvent?.({
        type: "team_phase",
        phase: "triage",
        detail: `${lead.avatar} ${lead.name} triaging request (direct answer vs selective delegation)...`,
      });

      let planRes: AgentRunResult;
      let planError = "";
      try {
        planRes = await runAgentTurn({
          agentId: lead.id,
          teamId: team.id,
          sessionId: params.sessionId,
          images: params.images,
          history: params.history,
          maxIterations: 8,
          signal: params.signal,
          prompt:
            `User Mission (EXECUTE & SMART TRIAGE MODE):\n${params.userPrompt}\n\n` +
            `Available Specialists:\n` +
            selectableRoster.map((m) => `- **${m.name}** (${m.title} | purpose: ${m.purpose})`).join("\n") +
            `\nReviewer/QA: **${reviewer.name}** (${reviewer.title})\n\n` +
            `First, triage this request using **Smart Triage**:\n` +
            `1. **Direct Reply**: If this is a casual greeting, simple chat, quick explanation, or direct question you can answer immediately WITHOUT waking specialists or running execution tools, respond with this JSON block:\n` +
            `\`\`\`json\n{"action":"direct_reply","reason":"short reason","reply":"your complete final response to the user"}\n\`\`\`\n` +
            `2. **Selective Delegation**: If real work, code/terminal execution, investigation, or specialist expertise is needed, delegate ONLY to the exact specialist(s) required (never wake unrelated teammates). Set \`"needsReview": false\` for lightweight non-code lookups/summaries that need no QA audit, or \`"needsReview": true\` when builds, edits, commands, or security checks must be verified:\n` +
            `\`\`\`json\n{"action":"delegate","needsReview":true,"reason":"short reason","tasks":[{"title":"...", "owner":"<exact specialist name>", "files":["path/a"], "verifyCmd":"command to verify (optional)", "instructions":"exact actionable steps"}]}\n\`\`\`\n` +
            `END your response with ONE valid \`\`\`json ... \`\`\` block (1 to ${Math.min(5, selectableRoster.length + 1)} tasks if delegating).`,
          extraSystemNote:
            `You are the Lead Architect & Smart Triage Commander for ${team.name}. Answer lightweight chat directly with action="direct_reply"; otherwise selectively delegate only necessary tasks to the right specialist(s) without overlapping files.`,
          onEvent: params.onEvent,
        });
      } catch (err) {
        if (isFatalMissionError(err, params.signal)) throw err;
        planError = err instanceof Error ? err.message : String(err);
        planRes = makeFallbackAgentResult(lead, "Execution Plan", err);
      }

      const triagePlan: LeadTriagePlan = planError
        ? { action: "delegate", needsReview: true, tasks: [] }
        : parseLeadTriagePlan(planRes.content, selectableRoster);

      if (!planError && triagePlan.action === "direct_reply" && triagePlan.reply) {
        const directTriage: LeadTriageSummary = {
          action: "direct_reply",
          ...(triagePlan.reason ? { reason: triagePlan.reason } : {}),
          delegatedAgents: [],
          skippedReview: true,
        };
        const directAttribution: TeamMissionAttribution = {
          ...attribution,
          senderAgentId: lead.id,
          senderAgentName: lead.name,
          senderModel: planRes.model || attribution.senderModel,
        };
        const directSynthesis: AgentRunResult = {
          ...planRes,
          content: triagePlan.reply,
        };

        params.onEvent?.({
          type: "team_phase",
          phase: "triage_direct",
          detail: `${lead.avatar} ${lead.name} answered directly (0 specialists woken).`,
        });

        const directInteractions = collectTeamInteractionStats(team.id, params.sessionId, [planRes]);

        saveMessage({
          sessionId: params.sessionId,
          role: "assistant",
          agentId: lead.id,
          agentName: `${lead.name} · Direct Reply`,
          modelUsed: planRes.model,
          content: directSynthesis.content,
          reasoning: planRes.reasoning,
          toolCalls: planRes.toolTrace,
          meta: {
            avatar: lead.avatar,
            providerName: planRes.providerName,
            phase: "triage_direct",
            triage: directTriage,
            attribution: directAttribution,
            interactions: directInteractions,
            durationMs: planRes.durationMs,
            promptTokens: planRes.promptTokens,
            completionTokens: planRes.completionTokens,
          },
        });

        await maybeAutoReflect({
          team,
          sessionId: params.sessionId,
          synthesizer: lead,
          userPrompt: params.userPrompt,
          contributions: [],
          synthesis: directSynthesis,
          signal: params.signal,
          onEvent: params.onEvent,
        });

        const bbCount = directInteractions.blackboardEntries;

        params.onEvent?.({
          type: "team_done",
          teamId: team.id,
          sessionId: params.sessionId,
          blackboardCount: bbCount,
          attribution: directAttribution,
          triage: directTriage,
          interactions: directInteractions,
        });

        return {
          teamId: team.id,
          teamName: team.name,
          mode,
          attribution: directAttribution,
          triage: directTriage,
          contributions: [],
          synthesis: directSynthesis,
          blackboardCount: bbCount,
          interactions: directInteractions,
        };
      }

      contributions.push(planRes);
      saveMessage({
        sessionId: params.sessionId,
        role: "agent",
        agentId: planRes.agentId,
        agentName: `${planRes.agentName} (Execution Plan)`,
        modelUsed: planRes.model,
        content: planRes.content,
        reasoning: planRes.reasoning,
        toolCalls: planRes.toolTrace,
        meta: {
          avatar: planRes.avatar,
          providerName: planRes.providerName,
          phase: "planning",
          durationMs: planRes.durationMs,
          ...(planError ? { error: planError } : {}),
        },
      });

      // Persist planned tasks to Shared Team Task Board
      let plannedTasks = triagePlan.tasks;
      const rosterForMatch = plannedTasks.length > 0 ? selectableRoster : fallbackRoster;
      if (plannedTasks.length === 0) {
        plannedTasks = fallbackRoster.slice(0, 2).map((m) => ({
          title: `${m.title}: Execute mission`,
          owner: m.name,
          instructions: params.userPrompt,
        }));
      }

      const taskRecords: Array<{ id: string; task: PlannedTask; agent: AgentRecord }> = [];
      for (const pt of plannedTasks) {
        const assigned = matchAgentByName(pt.owner, rosterForMatch);
        const tid = generateId("tsk");
        db.prepare(
          `INSERT INTO team_tasks (id, team_id, session_id, title, owner_agent, status, notes)
           VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`
        ).run(tid, team.id, params.sessionId, pt.title, assigned.name, pt.files?.join(", ") || "");
        taskRecords.push({ id: tid, task: pt, agent: assigned });
      }
      params.onEvent?.({ type: "team_task_updated", teamId: team.id, count: taskRecords.length });

      // Group tasks by assigned agent so each agent runs one coherent multi-step session without conflicting with itself
      const tasksByAgent = new Map<string, typeof taskRecords>();
      for (const tr of taskRecords) {
        const list = tasksByAgent.get(tr.agent.id) || [];
        list.push(tr);
        tasksByAgent.set(tr.agent.id, list);
      }

      const delegatedAgents = Array.from(tasksByAgent.values()).map((items) => items[0].agent.name);
      params.onEvent?.({
        type: "team_phase",
        phase: "delegation",
        detail: `${lead.avatar} ${lead.name} delegated ${taskRecords.length} task(s) to: ${delegatedAgents.join(", ")}`,
      });

      const hasVerifyCmds = taskRecords.some((tr) => Boolean(tr.task.verifyCmd?.trim()));
      const shouldRunReview = triagePlan.needsReview || hasVerifyCmds;
      const triageSummary: LeadTriageSummary = {
        action: "delegate",
        ...(triagePlan.reason ? { reason: triagePlan.reason } : {}),
        delegatedAgents,
        skippedReview: !shouldRunReview,
      };

      const maxFixCycles = Math.max(1, Math.min(3, team.max_rounds || 2));
      let verified = false;
      let lastFeedback = "";
      let lastChecks: VerificationCheckResult[] = [];

      for (let cycle = 1; cycle <= maxFixCycles; cycle++) {
        if (params.signal?.aborted) throw new Error("Mission stopped by user.");

        params.onEvent?.({
          type: "team_phase",
          phase: cycle === 1 ? "execution_build" : `fix_cycle_${cycle}`,
          detail:
            cycle === 1
              ? `Selected specialist(s) (${delegatedAgents.join(", ")}) executing assigned tasks...`
              : `Fix Cycle ${cycle}/${maxFixCycles}: Specialists resolving verification failures...`,
        });

        // Phase 2: Parallel Multi-Step Execution per Assigned Specialist
        const teamWorkspaceDir = resolveTeamWorkspaceDir(team.id);
        const execResults = await Promise.all(
          Array.from(tasksByAgent.entries()).map(async ([agentKey, items]) => {
            const member = items[0].agent;
            const taskListText = items
              .map(
                (it, idx) =>
                  `${idx + 1}. [Task \`${it.id}\`] **${it.task.title}**\n` +
                  `   - Owned Files: ${it.task.files?.length ? it.task.files.join(", ") : "(coordinate via team_message)"}\n` +
                  `   - Verify Command: ${it.task.verifyCmd || "(run build/tests in terminal)"}\n` +
                  `   - Instructions: ${it.task.instructions}`
              )
              .join("\n\n");

            const activePeerSummaries = Array.from(tasksByAgent.entries())
              .filter(([id]) => id !== agentKey)
              .map(([, peerItems]) => {
                const pAgent = peerItems[0].agent;
                const titles = peerItems.map((pi) => pi.task.title).join("; ");
                return `- **${pAgent.name}** (${pAgent.title}): ${titles}`;
              });

            const peerCoordinationBlock =
              activePeerSummaries.length > 0
                ? `\nParallel Teammates Executing Right Now (use \`team_message\`, \`team_inbox\`, or \`consult_teammate\` for real coordination):\n${activePeerSummaries.join("\n")}\n`
                : "";

            try {
              const res = await runAgentTurn({
                agentId: member.id,
                teamId: team.id,
                sessionId: params.sessionId,
                images: cycle === 1 ? params.images : undefined,
                signal: params.signal,
                prompt:
                  `Overall User Mission:\n${params.userPrompt}\n\n` +
                  `Team Workspace Root (isolated to ${team.name}): \`${teamWorkspaceDir}\`\n\n` +
                  `Your Assigned Execution Tasks:\n${taskListText}\n` +
                  peerCoordinationBlock +
                  (lastFeedback
                    ? `\n⚠️ VERIFICATION FAILED IN PREVIOUS ROUND — FIX THESE EXACT ISSUES:\n${lastFeedback}\n`
                    : "") +
                  `\nACTUALLY DO THE WORK using your workspace, code, and persistent terminal tools (\`term_open\`, \`term_exec\`, \`term_read\`).\n` +
                  `- Use \`team_message\` / \`team_inbox\` to hand off real contracts, ports, or file paths, and \`consult_teammate\` whenever you need live verification or input from a peer.\n` +
                  `- Update your task status with \`team_todo_manage\` when finished.\n` +
                  `- Run self-checks before reporting back with exact file paths, commands run, and observed output.`,
                extraSystemNote: `You are executing Round ${cycle} in Pandawa Execute & Verify Mode. Build real artifacts inside ${team.name}'s isolated workspace and interact genuinely with teammates.`,
                onEvent: params.onEvent,
              });

              for (const it of items) {
                db.prepare("UPDATE team_tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(it.id);
              }
              return res;
            } catch (err) {
              if (isFatalMissionError(err, params.signal)) throw err;
              return makeFallbackAgentResult(member, "Execution", err);
            }
          })
        );

        for (const r of execResults) {
          contributions.push(r);
          saveMessage({
            sessionId: params.sessionId,
            role: "agent",
            agentId: r.agentId,
            agentName: cycle === 1 ? `${r.agentName} (Build)` : `${r.agentName} (Fix #${cycle})`,
            modelUsed: r.model,
            content: r.content,
            reasoning: r.reasoning,
            toolCalls: r.toolTrace,
            meta: {
              avatar: r.avatar,
              providerName: r.providerName,
              phase: cycle === 1 ? "execution_build" : "fix_cycle",
              stepsUsed: r.stepsUsed,
              durationMs: r.durationMs,
            },
          });
        }

        if (params.signal?.aborted) throw new Error("Mission stopped by user.");

        if (!shouldRunReview) {
          params.onEvent?.({
            type: "team_phase",
            phase: "verification_skipped",
            detail: "QA verification skipped per Lead Smart Triage (lightweight task).",
          });
          break;
        }

        // Phase 3: Programmatic Verification Runner + Reviewer Inspection
        params.onEvent?.({
          type: "team_phase",
          phase: "verification",
          detail: `${reviewer.avatar} ${reviewer.name} running programmatic exit-code verification & QA checks...`,
        });

        // 3A. Machine-enforced execution of all planned verifyCmd checks
        const progChecks = await runProgrammaticVerifyCommands(
          taskRecords.map((tr) => ({ title: tr.task.title, verifyCmd: tr.task.verifyCmd })),
          {
            cwd: resolveTeamWorkspaceDir(team.id),
            reviewerId: reviewer.id,
            sessionId: params.sessionId,
            signal: params.signal,
            onEvent: params.onEvent,
          }
        );
        lastChecks = progChecks;

        const progReportText =
          progChecks.length > 0
            ? `## Programmatic Verification Runner (Machine Exit Codes)\n` +
              progChecks
                .map(
                  (c) =>
                    `- **${c.title}** | \`${c.command}\` → **${c.passed ? "PASS (exit 0)" : `FAIL (exit ${c.exitCode})`}** (${c.durationMs}ms)\n` +
                    (c.stdout ? `  STDOUT: ${c.stdout.slice(0, 800)}\n` : "") +
                    (c.stderr ? `  STDERR: ${c.stderr.slice(0, 800)}\n` : "")
                )
                .join("\n")
            : "(No explicit verifyCmd provided by planner — run real build/test checks in terminal now.)";

        const buildDigest = execResults
          .map((r) => `### ${r.avatar} ${r.agentName} (${r.stepsUsed || 0} steps, ${r.toolTrace.length} tool calls)\n${r.content}`)
          .join("\n\n");

        let verifyRes: AgentRunResult;
        let verifyError = "";
        try {
          verifyRes = await runAgentTurn({
            agentId: reviewer.id,
            teamId: team.id,
            sessionId: params.sessionId,
            signal: params.signal,
            prompt:
              `User Mission:\n${params.userPrompt}\n\n` +
              `Specialist Execution Reports (Cycle ${cycle}/${maxFixCycles}):\n${buildDigest}\n\n` +
              `${progReportText}\n\n` +
              `PERFORM REAL VERIFICATION NOW:\n` +
              `1. Review programmatic exit-code results above and actually inspect real artifacts via \`workspace_read\`, \`term_read\`, \`team_inbox\`, and \`blackboard_read\` (never trust claims without checking files/logs).\n` +
              `2. Use \`consult_teammate\` if anything needs clarification or extra check from a specialist, and run any additional build/test checks via \`term_exec\`.\n` +
              `3. Start your final conclusion line with EXACTLY \`VERDICT: PASS\` ONLY if all checks genuinely pass, OR \`VERDICT: NEEDS_FIX\` followed by the exact failing command/error.`,
            extraSystemNote:
              "You are the Verification Gate in Execute & Verify Mode. Machine exit codes are authoritative; never rubber-stamp failing builds.",
            onEvent: params.onEvent,
          });
        } catch (err) {
          if (isFatalMissionError(err, params.signal)) throw err;
          verifyError = err instanceof Error ? err.message : String(err);
          verifyRes = makeFallbackAgentResult(reviewer, `Verify #${cycle}`, err);
        }

        contributions.push(verifyRes);
        const cyclePassed = verifyError ? false : computeVerificationVerdict(progChecks, verifyRes.content);
        saveMessage({
          sessionId: params.sessionId,
          role: "agent",
          agentId: verifyRes.agentId,
          agentName: `${verifyRes.agentName} (Verify #${cycle} · ${cyclePassed ? "PASS" : verifyError ? "ERROR" : "NEEDS FIX"})`,
          modelUsed: verifyRes.model,
          content: progChecks.length > 0 ? `${progReportText}\n\n---\n\n${verifyRes.content}` : verifyRes.content,
          reasoning: verifyRes.reasoning,
          toolCalls: verifyRes.toolTrace,
          meta: {
            avatar: verifyRes.avatar,
            providerName: verifyRes.providerName,
            phase: "verification",
            programmaticChecks: progChecks,
            passed: cyclePassed,
            stepsUsed: verifyRes.stepsUsed,
            durationMs: verifyRes.durationMs,
            ...(verifyError ? { error: verifyError } : {}),
          },
        });

        if (cyclePassed) {
          verified = true;
          break;
        }
        lastFeedback = `${progReportText}\n\nReviewer Critique:\n${verifyRes.content}`.slice(0, 3200);
      }

      // Phase 4: Final Synthesis Delivery (via configured Result Sender)
      params.onEvent?.({
        type: "team_phase",
        phase: "consensus_synthesis",
        detail: `${sender.avatar} ${sender.name} compiling final verified mission report...`,
      });

      const allNotes = contributions
        .slice(-8)
        .map((c) => `### ${c.avatar} ${c.agentName} [${c.model}]\n${c.content.slice(0, 2200)}`)
        .join("\n\n");

      const verificationStatusLabel = verified
        ? "✅ VERIFIED PASS"
        : shouldRunReview
        ? "⚠️ COMPLETED WITH NOTES"
        : "ℹ️ LIGHTWEIGHT DELEGATION (QA skipped per Smart Triage)";

      let synthesis: AgentRunResult;
      let synthError = "";
      try {
        synthesis = await runAgentTurn({
          agentId: sender.id,
          teamId: team.id,
          sessionId: params.sessionId,
          maxIterations: 5,
          signal: params.signal,
          prompt:
            `Original User Mission:\n${params.userPrompt}\n\n` +
            `Verification Status: ${verificationStatusLabel}\n\n` +
            `Execution & Verification Log:\n${allNotes}\n\n` +
            `Deliver a crisp, executive final summary to the user: what was actually built/executed, exact file paths & live terminal sessions (with \`tmux attach\` or URLs if any), verification results, and any next step.`,
          extraSystemNote: `You are delivering the final verified execution report for ${team.name}.`,
          onEvent: params.onEvent,
        });
      } catch (err) {
        if (isFatalMissionError(err, params.signal)) throw err;
        synthError = err instanceof Error ? err.message : String(err);
        synthesis = makeFallbackSynthesis(sender, team.name, contributions, err, lastChecks);
      }

      const execInteractions = collectTeamInteractionStats(team.id, params.sessionId, [
        ...contributions,
        synthesis,
      ]);

      saveMessage({
        sessionId: params.sessionId,
        role: "assistant",
        agentId: synthesis.agentId,
        agentName: `${synthesis.agentName} · ${verified ? "Verified Delivery" : "Team Execution Report"}`,
        modelUsed: synthesis.model,
        content: synthesis.content,
        reasoning: synthesis.reasoning,
        toolCalls: synthesis.toolTrace,
        meta: {
          avatar: synthesis.avatar,
          providerName: synthesis.providerName,
          phase: "consensus",
          verified,
          triage: triageSummary,
          attribution,
          interactions: execInteractions,
          durationMs: synthesis.durationMs,
          promptTokens: synthesis.promptTokens,
          completionTokens: synthesis.completionTokens,
          ...(synthError ? { error: synthError } : {}),
        },
      });

      await maybeAutoReflect({
        team,
        sessionId: params.sessionId,
        synthesizer: sender,
        userPrompt: params.userPrompt,
        contributions,
        synthesis,
        signal: params.signal,
        onEvent: params.onEvent,
      });

      const bbCount = execInteractions.blackboardEntries;

      const synthesisAttribution: TeamMissionAttribution = {
        ...attribution,
        senderModel: synthesis.model || attribution.senderModel,
      };
      params.onEvent?.({
        type: "team_done",
        teamId: team.id,
        sessionId: params.sessionId,
        blackboardCount: bbCount,
        verified,
        attribution: synthesisAttribution,
        triage: triageSummary,
        interactions: execInteractions,
      });

      return {
        teamId: team.id,
        teamName: team.name,
        mode,
        attribution: synthesisAttribution,
        triage: triageSummary,
        contributions,
        synthesis,
        blackboardCount: bbCount,
        verified,
        verificationChecks: lastChecks,
        interactions: execInteractions,
      };
    }

    // =========================================================================
    // MODE: SEQUENTIAL (Relay Chain)
    // =========================================================================
    if (mode === "sequential") {
      const relayOrder = [lead, ...members.filter((m) => m.id !== lead.id)];
      const isSingleSameSender = relayOrder.length === 1 && sender.id === relayOrder[0].id;
      let runningContext = "";

      for (const member of relayOrder) {
        if (params.signal?.aborted) throw new Error("Mission stopped by user.");
        params.onEvent?.({
          type: "team_phase",
          phase: "relay",
          detail: `${member.avatar} ${member.name} is contributing...`,
        });

        let res: AgentRunResult;
        let turnError = "";
        try {
          res = await runAgentTurn({
            agentId: member.id,
            teamId: team.id,
            sessionId: params.sessionId,
            images: runningContext ? undefined : params.images,
            signal: params.signal,
            prompt: runningContext
              ? `User Mission:\n${params.userPrompt}\n\nPrior Teammate Contributions:\n${runningContext}\n\nNow contribute your specialist perspective or actions (${member.title}) concisely and directly.`
              : `User Mission:\n${params.userPrompt}\n\nLead off with your specialist analysis/execution (${member.title}) concisely.`,
            history: params.history,
            extraSystemNote:
              `You are collaborating inside ${team.name} (Relay Mode). Build directly on teammates' work, share active terminals, and post key decisions to the Team Blackboard.`,
            onEvent: params.onEvent,
          });
        } catch (err) {
          if (isFatalMissionError(err, params.signal)) throw err;
          turnError = err instanceof Error ? err.message : String(err);
          res = makeFallbackAgentResult(member, "Relay", err);
        }

        contributions.push(res);
        runningContext += `\n### ${member.avatar} ${member.name} (${member.title})\n${res.content}\n`;

        if (!isSingleSameSender) {
          saveMessage({
            sessionId: params.sessionId,
            role: "agent",
            agentId: res.agentId,
            agentName: res.agentName,
            modelUsed: res.model,
            content: res.content,
            reasoning: res.reasoning,
            toolCalls: res.toolTrace,
            meta: {
              avatar: res.avatar,
              providerName: res.providerName,
              phase: "relay",
              stepsUsed: res.stepsUsed,
              durationMs: res.durationMs,
              ...(turnError ? { error: turnError } : {}),
            },
          });
        }
      }

      if (params.signal?.aborted) throw new Error("Mission stopped by user.");

      let synthesis: AgentRunResult;
      let synthError = "";
      let seqInteractions: TeamInteractionStats;
      if (isSingleSameSender) {
        synthesis = contributions[0];
        seqInteractions = collectTeamInteractionStats(team.id, params.sessionId, contributions);
        saveMessage({
          sessionId: params.sessionId,
          role: "assistant",
          agentId: synthesis.agentId,
          agentName: `${synthesis.agentName} · Relay Delivery`,
          modelUsed: synthesis.model,
          content: synthesis.content,
          reasoning: synthesis.reasoning,
          toolCalls: synthesis.toolTrace,
          meta: {
            avatar: synthesis.avatar,
            providerName: synthesis.providerName,
            phase: "consensus",
            attribution,
            interactions: seqInteractions,
            stepsUsed: synthesis.stepsUsed,
            durationMs: synthesis.durationMs,
            promptTokens: synthesis.promptTokens,
            completionTokens: synthesis.completionTokens,
          },
        });
      } else {
        params.onEvent?.({
          type: "team_phase",
          phase: "consensus_synthesis",
          detail: `${sender.avatar} ${sender.name} delivering final ${team.name} relay response...`,
        });

        try {
          synthesis = await runAgentTurn({
            agentId: sender.id,
            teamId: team.id,
            sessionId: params.sessionId,
            maxIterations: 5,
            signal: params.signal,
            prompt:
              `Original User Request:\n${params.userPrompt}\n\n` +
              `Sequential Relay Contributions:\n${runningContext}\n\n` +
              `Deliver the final unified response for the user on behalf of ${team.name}.`,
            history: params.history,
            extraSystemNote: `You are delivering the final relay synthesis of ${team.name}.`,
            onEvent: params.onEvent,
          });
        } catch (err) {
          if (isFatalMissionError(err, params.signal)) throw err;
          synthError = err instanceof Error ? err.message : String(err);
          synthesis = makeFallbackSynthesis(sender, team.name, contributions, err);
        }

        seqInteractions = collectTeamInteractionStats(team.id, params.sessionId, [...contributions, synthesis]);
        saveMessage({
          sessionId: params.sessionId,
          role: "assistant",
          agentId: synthesis.agentId,
          agentName: `${synthesis.agentName} · Relay Delivery`,
          modelUsed: synthesis.model,
          content: synthesis.content,
          reasoning: synthesis.reasoning,
          toolCalls: synthesis.toolTrace,
          meta: {
            avatar: synthesis.avatar,
            providerName: synthesis.providerName,
            phase: "consensus",
            attribution,
            interactions: seqInteractions,
            stepsUsed: synthesis.stepsUsed,
            durationMs: synthesis.durationMs,
            promptTokens: synthesis.promptTokens,
            completionTokens: synthesis.completionTokens,
            ...(synthError ? { error: synthError } : {}),
          },
        });
      }

      await maybeAutoReflect({
        team,
        sessionId: params.sessionId,
        synthesizer: sender,
        userPrompt: params.userPrompt,
        contributions,
        synthesis,
        signal: params.signal,
        onEvent: params.onEvent,
      });

      const bbCount = seqInteractions.blackboardEntries;

      const seqAttribution: TeamMissionAttribution = {
        ...attribution,
        senderModel: synthesis.model || attribution.senderModel,
      };
      params.onEvent?.({
        type: "team_done",
        teamId: team.id,
        sessionId: params.sessionId,
        blackboardCount: bbCount,
        attribution: seqAttribution,
        interactions: seqInteractions,
      });

      return {
        teamId: team.id,
        teamName: team.name,
        mode,
        attribution: seqAttribution,
        contributions,
        synthesis,
        blackboardCount: bbCount,
        interactions: seqInteractions,
      };
    }

    // =========================================================================
    // DEFAULT: MUSYAWARAH PEER DELIBERATION (deliberate / parallel / consensus)
    // =========================================================================
    const activeSpecialists = specialists.length > 0 ? specialists : [lead];

    params.onEvent?.({
      type: "team_phase",
      phase: "deliberation_round_1",
      detail: `Peer specialists (${activeSpecialists.map((a) => a.name).join(", ")}) collaborating in parallel...`,
    });

    const round1Results = await Promise.all(
      activeSpecialists.map(async (member) => {
        if (params.signal?.aborted) throw new Error("Mission stopped by user.");
        try {
          const res = await runAgentTurn({
            agentId: member.id,
            teamId: team.id,
            sessionId: params.sessionId,
            images: params.images,
            signal: params.signal,
            prompt:
              `User Mission:\n${params.userPrompt}\n\n` +
              `As **${member.name}** (${member.title}), provide your focused specialist contribution (and execute any concrete checks/tools needed in shared terminals or workspace) for the ${team.name} Team Blackboard.`,
            history: params.history,
            extraSystemNote:
              `You are in Round 1 of ${team.name} Peer Deliberation. Your peers are working alongside you in parallel using the shared Main Brain, Team Brain, and persistent terminals. Use \`team_message\` if you want to coordinate mid-turn.`,
            onEvent: params.onEvent,
          });
          return res;
        } catch (err) {
          if (isFatalMissionError(err, params.signal)) throw err;
          return makeFallbackAgentResult(member, "Deliberation", err);
        }
      })
    );

    for (const res of round1Results) {
      contributions.push(res);
      const bbId = generateId("bb");
      db.prepare(
        `INSERT INTO blackboard_entries (id, team_id, session_id, author_agent_id, author_name, entry_type, title, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        bbId,
        team.id,
        params.sessionId,
        res.agentId,
        res.agentName,
        "proposal",
        `${res.agentName} Perspective`,
        res.content.slice(0, 1200)
      );

      saveMessage({
        sessionId: params.sessionId,
        role: "agent",
        agentId: res.agentId,
        agentName: res.agentName,
        modelUsed: res.model,
        content: res.content,
        reasoning: res.reasoning,
        toolCalls: res.toolTrace,
        meta: {
          avatar: res.avatar,
          providerName: res.providerName,
          phase: "peer_deliberation",
          stepsUsed: res.stepsUsed,
          durationMs: res.durationMs,
        },
      });
    }

    if (params.signal?.aborted) throw new Error("Mission stopped by user.");

    if (mode === "deliberate" && team.max_rounds >= 2 && reviewer && activeSpecialists.length >= 2) {
      params.onEvent?.({
        type: "team_phase",
        phase: "peer_critique",
        detail: `${reviewer.avatar} ${reviewer.name} cross-reviewing peer proposals on Team Blackboard...`,
      });
      const peerDigest = round1Results
        .map((r) => `### ${r.avatar} ${r.agentName} (${r.model})\n${r.content}`)
        .join("\n\n");

      let critiqueRes: AgentRunResult;
      let critiqueError = "";
      try {
        critiqueRes = await runAgentTurn({
          agentId: reviewer.id,
          teamId: team.id,
          sessionId: params.sessionId,
          signal: params.signal,
          prompt:
            `User Mission:\n${params.userPrompt}\n\n` +
            `Peer Proposals on Team Blackboard:\n${peerDigest}\n\n` +
            `Perform a concise **Peer Cross-Critique**: verify any concrete claims in workspace/terminal if applicable, spot contradictions, missing edge cases, security/operational risks, and confirm what is strongest.`,
          extraSystemNote: `You are performing Round 2 Peer Cross-Review for ${team.name}.`,
          onEvent: params.onEvent,
        });
      } catch (err) {
        if (isFatalMissionError(err, params.signal)) throw err;
        critiqueError = err instanceof Error ? err.message : String(err);
        critiqueRes = makeFallbackAgentResult(reviewer, "Cross-Review", err);
      }

      contributions.push(critiqueRes);
      saveMessage({
        sessionId: params.sessionId,
        role: "agent",
        agentId: critiqueRes.agentId,
        agentName: `${critiqueRes.agentName} (Cross-Review)`,
        modelUsed: critiqueRes.model,
        content: critiqueRes.content,
        reasoning: critiqueRes.reasoning,
        toolCalls: critiqueRes.toolTrace,
        meta: {
          avatar: critiqueRes.avatar,
          providerName: critiqueRes.providerName,
          phase: "peer_critique",
          stepsUsed: critiqueRes.stepsUsed,
          durationMs: critiqueRes.durationMs,
          ...(critiqueError ? { error: critiqueError } : {}),
        },
      });
    }

    if (params.signal?.aborted) throw new Error("Mission stopped by user.");

    params.onEvent?.({
      type: "team_phase",
      phase: "consensus_synthesis",
      detail: `${sender.avatar} ${sender.name} synthesizing unified ${team.name} consensus...`,
    });

    const allPeerNotes = contributions
      .map((c) => `### ${c.avatar} ${c.agentName} [${c.model}]\n${c.content}`)
      .join("\n\n");

    let synthesis: AgentRunResult;
    let synthError = "";
    try {
      synthesis = await runAgentTurn({
        agentId: sender.id,
        teamId: team.id,
        sessionId: params.sessionId,
        signal: params.signal,
        prompt:
          `Original User Request:\n${params.userPrompt}\n\n` +
          `Teammate Deliberation & Blackboard Contributions:\n${allPeerNotes}\n\n` +
          `Synthesize the **Unified ${team.name} Consensus Response** directly for the user. ` +
          `Combine the best insights from each teammate, resolve trade-offs cleanly, and give a clear, actionable answer.`,
        history: params.history,
        extraSystemNote:
          `You are delivering the final unified Team Consensus of ${team.name}. Speak cleanly and authoritatively on behalf of the team.`,
        onEvent: params.onEvent,
      });
    } catch (err) {
      if (isFatalMissionError(err, params.signal)) throw err;
      synthError = err instanceof Error ? err.message : String(err);
      synthesis = makeFallbackSynthesis(sender, team.name, contributions, err);
    }

    const delibInteractions = collectTeamInteractionStats(team.id, params.sessionId, [...contributions, synthesis]);

    saveMessage({
      sessionId: params.sessionId,
      role: "assistant",
      agentId: synthesis.agentId,
      agentName: `${synthesis.agentName} · Team Consensus`,
      modelUsed: synthesis.model,
      content: synthesis.content,
      reasoning: synthesis.reasoning,
      toolCalls: synthesis.toolTrace,
      meta: {
        avatar: synthesis.avatar,
        providerName: synthesis.providerName,
        phase: "consensus",
        attribution,
        interactions: delibInteractions,
        stepsUsed: synthesis.stepsUsed,
        durationMs: synthesis.durationMs,
        promptTokens: synthesis.promptTokens,
        completionTokens: synthesis.completionTokens,
        ...(synthError ? { error: synthError } : {}),
      },
    });

    await maybeAutoReflect({
      team,
      sessionId: params.sessionId,
      synthesizer: sender,
      userPrompt: params.userPrompt,
      contributions,
      synthesis,
      signal: params.signal,
      onEvent: params.onEvent,
    });

    const bbCount = delibInteractions.blackboardEntries;

    const delibAttribution: TeamMissionAttribution = {
      ...attribution,
      senderModel: synthesis.model || attribution.senderModel,
    };
    params.onEvent?.({
      type: "team_done",
      teamId: team.id,
      sessionId: params.sessionId,
      blackboardCount: bbCount,
      attribution: delibAttribution,
      interactions: delibInteractions,
    });

    return {
      teamId: team.id,
      teamName: team.name,
      mode,
      attribution: delibAttribution,
      contributions,
      synthesis,
      blackboardCount: bbCount,
      interactions: delibInteractions,
    };
  } finally {
    clearSessionFileLocks(params.sessionId);
  }
}

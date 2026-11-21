import { generateId } from "../config.js";
import { getDb } from "../db/database.js";
import type { LLMImageAttachment, LLMMessage } from "../providers/llmClient.js";
import { getTeamMembers, type AgentRecord } from "./contextCompiler.js";
import { runAgentTurn, type AgentRunResult } from "./agentRunner.js";
import { clearSessionFileLocks } from "../tools/toolRegistry.js";

export interface TeamMissionResult {
  teamId: string;
  teamName: string;
  mode: string;
  contributions: AgentRunResult[];
  synthesis: AgentRunResult;
  blackboardCount: number;
  verified?: boolean;
}

interface TeamRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  team_brain_id: string | null;
  collaboration_mode: string;
  max_rounds: number;
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

function pickSynthesizer(members: AgentRecord[]): AgentRecord {
  const strat = members.find((m) => m.purpose === "strategy" || m.slug === "yudhistira");
  return strat || members[0];
}

function parsePlannedTasks(rawText: string, specialists: AgentRecord[]): PlannedTask[] {
  const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/i) || rawText.match(/(\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[1]) as Array<Record<string, unknown>>;
      if (Array.isArray(arr) && arr.length > 0) {
        return arr
          .map((item) => ({
            title: String(item.title || "Execution Task").slice(0, 120),
            owner: String(item.owner || specialists[0]?.name || ""),
            files: Array.isArray(item.files) ? item.files.map(String) : [],
            verifyCmd: item.verifyCmd ? String(item.verifyCmd) : item.verify_cmd ? String(item.verify_cmd) : "",
            instructions: String(item.instructions || item.description || item.title || ""),
          }))
          .filter((t) => t.instructions.trim().length > 0)
          .slice(0, 8);
      }
    } catch {
      // fall through to default split
    }
  }
  return [];
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
  if (params.signal?.aborted || params.synthesis.dryRun) return;
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
    throw new Error(`Team "${team.name}" has no enabled agents wired to its Team Brain.`);
  }

  const mode = params.modeOverride || team.collaboration_mode || "deliberate";
  const synthesizer = pickSynthesizer(members);
  const specialists = members.filter((m) => m.id !== synthesizer.id);
  const reviewer =
    specialists.find((m) => m.purpose === "review" || m.slug === "sadewa") ||
    members.find((m) => m.purpose === "review") ||
    synthesizer;

  params.onEvent?.({
    type: "team_phase",
    teamId: team.id,
    teamName: team.name,
    mode,
    phase: "activation",
    members: members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, purpose: m.purpose, model: m.model })),
  });

  const contributions: AgentRunResult[] = [];

  try {
    // =========================================================================
    // MODE: EXECUTE (Plan -> Parallel Build in Shared Terminals -> Verify -> Fix Loop)
    // =========================================================================
    if (mode === "execute") {
      const builders = specialists.filter((m) => m.id !== reviewer.id);
      const executionRoster = builders.length > 0 ? builders : specialists.length > 0 ? specialists : [synthesizer];

      // Phase 1: Architect & Task Decomposition
      params.onEvent?.({
        type: "team_phase",
        phase: "planning",
        detail: `${synthesizer.avatar} ${synthesizer.name} architecting execution plan & splitting tasks...`,
      });

      const planRes = await runAgentTurn({
        agentId: synthesizer.id,
        teamId: team.id,
        sessionId: params.sessionId,
        images: params.images,
        history: params.history,
        maxIterations: 8,
        signal: params.signal,
        prompt:
          `User Mission (EXECUTE & VERIFY MODE):\n${params.userPrompt}\n\n` +
          `Available Execution Specialists:\n` +
          executionRoster.map((m) => `- **${m.name}** (${m.title} | purpose: ${m.purpose})`).join("\n") +
          `\nReviewer/QA: **${reviewer.name}** (${reviewer.title})\n\n` +
          `Inspect the workspace or brain briefly if needed, then produce a concrete execution plan with non-overlapping file scopes.\n` +
          `END your response with a JSON code block (\`\`\`json ... \`\`\`) listing 1 to ${Math.min(5, executionRoster.length + 1)} concrete tasks:\n` +
          `[{"title":"...", "owner":"<exact specialist name>", "files":["path/a"], "verifyCmd":"command to verify", "instructions":"exact actionable build steps"}]`,
        extraSystemNote:
          "You are the Lead Architect in Pandawa Execute & Verify mode. Split work cleanly so parallel teammates don't overwrite the same files.",
        onEvent: params.onEvent,
      });

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
          dryRun: planRes.dryRun,
        },
      });

      if (planRes.dryRun) {
        return {
          teamId: team.id,
          teamName: team.name,
          mode,
          contributions,
          synthesis: planRes,
          blackboardCount: 0,
        };
      }

      // Persist planned tasks to Shared Team Task Board
      let plannedTasks = parsePlannedTasks(planRes.content, executionRoster);
      if (plannedTasks.length === 0) {
        plannedTasks = executionRoster.slice(0, 2).map((m) => ({
          title: `${m.title}: Execute mission`,
          owner: m.name,
          instructions: params.userPrompt,
        }));
      }

      const taskRecords: Array<{ id: string; task: PlannedTask; agent: AgentRecord }> = [];
      for (const pt of plannedTasks) {
        const assigned = matchAgentByName(pt.owner, executionRoster);
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

      const maxFixCycles = Math.max(1, Math.min(3, team.max_rounds || 2));
      let verified = false;
      let lastFeedback = "";

      for (let cycle = 1; cycle <= maxFixCycles; cycle++) {
        if (params.signal?.aborted) throw new Error("Mission stopped by user.");

        params.onEvent?.({
          type: "team_phase",
          phase: cycle === 1 ? "execution_build" : `fix_cycle_${cycle}`,
          detail:
            cycle === 1
              ? `Specialists executing assigned tasks in persistent shared terminals...`
              : `Fix Cycle ${cycle}/${maxFixCycles}: Specialists resolving verification failures...`,
        });

        // Phase 2: Parallel Multi-Step Execution per Assigned Specialist
        const execResults = await Promise.all(
          Array.from(tasksByAgent.entries()).map(async ([, items]) => {
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

            try {
              const res = await runAgentTurn({
                agentId: member.id,
                teamId: team.id,
                sessionId: params.sessionId,
                images: cycle === 1 ? params.images : undefined,
                signal: params.signal,
                prompt:
                  `Overall User Mission:\n${params.userPrompt}\n\n` +
                  `Your Assigned Execution Tasks:\n${taskListText}\n\n` +
                  (lastFeedback
                    ? `⚠️ VERIFICATION FAILED IN PREVIOUS ROUND — FIX THESE EXACT ISSUES:\n${lastFeedback}\n\n`
                    : "") +
                  `ACTUALLY DO THE WORK using your workspace, code, and persistent terminal tools (\`term_open\`, \`term_exec\`, \`term_read\`).\n` +
                  `- Use \`team_message\` to share running ports, terminal session names, or API contracts with teammates.\n` +
                  `- Update your task status with \`team_todo_manage\` when finished.\n` +
                  `- Run self-checks before reporting back with exact file paths, commands run, and observed output.`,
                extraSystemNote: `You are executing Round ${cycle} in Pandawa Execute & Verify Mode. Build real artifacts and verify them in persistent shared terminals.`,
                onEvent: params.onEvent,
              });

              for (const it of items) {
                db.prepare("UPDATE team_tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(it.id);
              }
              return res;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              return {
                agentId: member.id,
                agentName: member.name,
                avatar: member.avatar,
                model: member.model,
                providerName: "Error",
                content: `[${member.name} execution error: ${errMsg}]`,
                reasoning: "",
                toolTrace: [],
                promptTokens: 0,
                completionTokens: 0,
                durationMs: 0,
              } satisfies AgentRunResult;
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

        // Phase 3: Real Verification Loop (Reviewer actually runs checks in terminal!)
        params.onEvent?.({
          type: "team_phase",
          phase: "verification",
          detail: `${reviewer.avatar} ${reviewer.name} running real verification & tests in shared terminal...`,
        });

        const buildDigest = execResults
          .map((r) => `### ${r.avatar} ${r.agentName} (${r.stepsUsed || 0} steps, ${r.toolTrace.length} tool calls)\n${r.content}`)
          .join("\n\n");

        const verifyRes = await runAgentTurn({
          agentId: reviewer.id,
          teamId: team.id,
          sessionId: params.sessionId,
          signal: params.signal,
          prompt:
            `User Mission:\n${params.userPrompt}\n\n` +
            `Specialist Execution Reports (Cycle ${cycle}/${maxFixCycles}):\n${buildDigest}\n\n` +
            `PERFORM REAL VERIFICATION NOW:\n` +
            `1. Check active terminals (\`term_list\` / \`term_read\`) and workspace files (\`workspace_list\` / \`workspace_read\`).\n` +
            `2. Run actual build, syntax, unit test, or HTTP/curl checks in a persistent terminal (\`term_exec\`).\n` +
            `3. Start your final conclusion line with EXACTLY \`VERDICT: PASS\` if everything genuinely works, OR \`VERDICT: NEEDS_FIX\` followed by the exact failing command/error and who should fix it.`,
          extraSystemNote:
            "You are the Verification Gate in Pandawa Execute & Verify Mode. Never rubber-stamp—run real commands to verify.",
          onEvent: params.onEvent,
        });

        contributions.push(verifyRes);
        saveMessage({
          sessionId: params.sessionId,
          role: "agent",
          agentId: verifyRes.agentId,
          agentName: `${verifyRes.agentName} (Verify #${cycle})`,
          modelUsed: verifyRes.model,
          content: verifyRes.content,
          reasoning: verifyRes.reasoning,
          toolCalls: verifyRes.toolTrace,
          meta: {
            avatar: verifyRes.avatar,
            providerName: verifyRes.providerName,
            phase: "verification",
            stepsUsed: verifyRes.stepsUsed,
            durationMs: verifyRes.durationMs,
          },
        });

        if (/VERDICT:\s*PASS/i.test(verifyRes.content) && !/VERDICT:\s*NEEDS_FIX/i.test(verifyRes.content)) {
          verified = true;
          break;
        }
        lastFeedback = verifyRes.content.slice(0, 2800);
      }

      // Phase 4: Final Synthesis Delivery
      params.onEvent?.({
        type: "team_phase",
        phase: "consensus_synthesis",
        detail: `${synthesizer.avatar} ${synthesizer.name} compiling final verified mission report...`,
      });

      const allNotes = contributions
        .slice(-8)
        .map((c) => `### ${c.avatar} ${c.agentName} [${c.model}]\n${c.content.slice(0, 2200)}`)
        .join("\n\n");

      const synthesis = await runAgentTurn({
        agentId: synthesizer.id,
        teamId: team.id,
        sessionId: params.sessionId,
        maxIterations: 5,
        signal: params.signal,
        prompt:
          `Original User Mission:\n${params.userPrompt}\n\n` +
          `Verification Status: ${verified ? "✅ VERIFIED PASS" : "⚠️ COMPLETED WITH NOTES"}\n\n` +
          `Execution & Verification Log:\n${allNotes}\n\n` +
          `Deliver a crisp, executive final summary to the user: what was actually built/executed, exact file paths & live terminal sessions (with \`tmux attach\` or URLs if any), verification results, and any next step.`,
        extraSystemNote: "You are delivering the final verified execution report for Team Pandawa.",
        onEvent: params.onEvent,
      });

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
          durationMs: synthesis.durationMs,
          promptTokens: synthesis.promptTokens,
          completionTokens: synthesis.completionTokens,
        },
      });

      await maybeAutoReflect({
        team,
        sessionId: params.sessionId,
        synthesizer,
        userPrompt: params.userPrompt,
        contributions,
        synthesis,
        signal: params.signal,
        onEvent: params.onEvent,
      });

      const bbCount = (
        db.prepare("SELECT COUNT(*) as c FROM blackboard_entries WHERE team_id = ? AND session_id = ?").get(
          team.id,
          params.sessionId
        ) as { c: number }
      ).c;

      params.onEvent?.({
        type: "team_done",
        teamId: team.id,
        sessionId: params.sessionId,
        blackboardCount: bbCount,
        verified,
      });

      return {
        teamId: team.id,
        teamName: team.name,
        mode,
        contributions,
        synthesis,
        blackboardCount: bbCount,
        verified,
      };
    }

    // =========================================================================
    // MODE: SEQUENTIAL (Relay Chain)
    // =========================================================================
    if (mode === "sequential") {
      let runningContext = "";
      for (const member of members) {
        if (params.signal?.aborted) throw new Error("Mission stopped by user.");
        params.onEvent?.({
          type: "team_phase",
          phase: "relay",
          detail: `${member.avatar} ${member.name} is contributing...`,
        });
        const res = await runAgentTurn({
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
            "You are collaborating inside a Pandawa Agentic Team (Relay Mode). Build directly on teammates' work, share active terminals, and post key decisions to the Team Blackboard.",
          onEvent: params.onEvent,
        });
        contributions.push(res);
        runningContext += `\n### ${member.avatar} ${member.name} (${member.title})\n${res.content}\n`;

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
            dryRun: res.dryRun,
          },
        });
      }

      const last = contributions[contributions.length - 1];
      await maybeAutoReflect({
        team,
        sessionId: params.sessionId,
        synthesizer,
        userPrompt: params.userPrompt,
        contributions,
        synthesis: last,
        signal: params.signal,
        onEvent: params.onEvent,
      });

      return {
        teamId: team.id,
        teamName: team.name,
        mode,
        contributions,
        synthesis: last,
        blackboardCount: (
          db.prepare("SELECT COUNT(*) as c FROM blackboard_entries WHERE team_id = ? AND session_id = ?").get(
            team.id,
            params.sessionId
          ) as { c: number }
        ).c,
      };
    }

    // =========================================================================
    // DEFAULT: MUSYAWARAH PEER DELIBERATION (deliberate / parallel / consensus)
    // =========================================================================
    const activeSpecialists = specialists.length > 0 ? specialists : [synthesizer];

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
              `As **${member.name}** (${member.title}), provide your focused specialist contribution (and execute any concrete checks/tools needed in shared terminals or workspace) for the Pandawa Team Blackboard.`,
            history: params.history,
            extraSystemNote:
              "You are in Round 1 of Pandawa Musyawarah (Peer Deliberation). Your peers are working alongside you in parallel using the shared Main Brain, Team Brain, and persistent terminals. Use `team_message` if you want to coordinate mid-turn.",
            onEvent: params.onEvent,
          });
          return res;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            agentId: member.id,
            agentName: member.name,
            avatar: member.avatar,
            model: member.model,
            providerName: "Error",
            content: `[${member.name} could not complete turn: ${errMsg}]`,
            reasoning: "",
            toolTrace: [],
            promptTokens: 0,
            completionTokens: 0,
            durationMs: 0,
          } satisfies AgentRunResult;
        }
      })
    );

    for (const res of round1Results) {
      contributions.push(res);
      if (!res.dryRun) {
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
      }

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
          dryRun: res.dryRun,
        },
      });
    }

    if (round1Results.every((r) => r.dryRun)) {
      const summaryContent =
        `## Pandawa Agentic OS — Ready for Live Multi-AI Execution\n\n` +
        `**Team:** ${team.name} (\`${mode}\` mode)\n` +
        `**Wired Peers (${members.length}):** ${members.map((m) => `${m.avatar} **${m.name}** (\`${m.model || "unset"}\`)`).join(" · ")}\n\n` +
        `All agents successfully compiled their **Living Brain -> Team Brain -> [[wikilinks]]** topology!\n\n` +
        `👉 Next step: Open **Multi-AI Hub** in the sidebar, paste at least one API key (or Custom Base URL), and run your mission live!`;

      const drySynth: AgentRunResult = {
        agentId: synthesizer.id,
        agentName: `${synthesizer.name} (Team Consensus)`,
        avatar: synthesizer.avatar,
        model: synthesizer.model,
        providerName: "Dry-Run",
        content: summaryContent,
        reasoning: "",
        toolTrace: [],
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        dryRun: true,
      };

      saveMessage({
        sessionId: params.sessionId,
        role: "assistant",
        agentId: synthesizer.id,
        agentName: `${synthesizer.name} · Team Consensus`,
        modelUsed: synthesizer.model,
        content: summaryContent,
        meta: { avatar: synthesizer.avatar, phase: "consensus", dryRun: true },
      });

      return {
        teamId: team.id,
        teamName: team.name,
        mode,
        contributions,
        synthesis: drySynth,
        blackboardCount: 0,
      };
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

      const critiqueRes = await runAgentTurn({
        agentId: reviewer.id,
        teamId: team.id,
        sessionId: params.sessionId,
        signal: params.signal,
        prompt:
          `User Mission:\n${params.userPrompt}\n\n` +
          `Peer Proposals on Team Blackboard:\n${peerDigest}\n\n` +
          `Perform a concise **Peer Cross-Critique**: verify any concrete claims in workspace/terminal if applicable, spot contradictions, missing edge cases, security/operational risks, and confirm what is strongest.`,
        extraSystemNote: "You are performing Round 2 Peer Cross-Review in Pandawa Musyawarah.",
        onEvent: params.onEvent,
      });

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
        },
      });
    }

    if (params.signal?.aborted) throw new Error("Mission stopped by user.");

    params.onEvent?.({
      type: "team_phase",
      phase: "consensus_synthesis",
      detail: `${synthesizer.avatar} ${synthesizer.name} synthesizing unified Pandawa Team consensus...`,
    });

    const allPeerNotes = contributions
      .map((c) => `### ${c.avatar} ${c.agentName} [${c.model}]\n${c.content}`)
      .join("\n\n");

    const synthesis = await runAgentTurn({
      agentId: synthesizer.id,
      teamId: team.id,
      sessionId: params.sessionId,
      signal: params.signal,
      prompt:
        `Original User Request:\n${params.userPrompt}\n\n` +
        `Teammate Deliberation & Blackboard Contributions:\n${allPeerNotes}\n\n` +
        `Synthesize the **Unified Pandawa Team Consensus Response** directly for the user. ` +
        `Combine the best insights from each teammate, resolve trade-offs cleanly, and give a clear, actionable answer.`,
      history: params.history,
      extraSystemNote:
        "You are delivering the final unified Team Consensus of Team Pandawa. Speak cleanly and authoritatively on behalf of the team.",
      onEvent: params.onEvent,
    });

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
        stepsUsed: synthesis.stepsUsed,
        durationMs: synthesis.durationMs,
        promptTokens: synthesis.promptTokens,
        completionTokens: synthesis.completionTokens,
      },
    });

    await maybeAutoReflect({
      team,
      sessionId: params.sessionId,
      synthesizer,
      userPrompt: params.userPrompt,
      contributions,
      synthesis,
      signal: params.signal,
      onEvent: params.onEvent,
    });

    const bbCount = (
      db.prepare("SELECT COUNT(*) as c FROM blackboard_entries WHERE team_id = ? AND session_id = ?").get(
        team.id,
        params.sessionId
      ) as { c: number }
    ).c;

    params.onEvent?.({
      type: "team_done",
      teamId: team.id,
      sessionId: params.sessionId,
      blackboardCount: bbCount,
    });

    return {
      teamId: team.id,
      teamName: team.name,
      mode,
      contributions,
      synthesis,
      blackboardCount: bbCount,
    };
  } finally {
    clearSessionFileLocks(params.sessionId);
  }
}

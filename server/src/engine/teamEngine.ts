import { generateId } from "../config.js";
import { getDb } from "../db/database.js";
import type { LLMMessage } from "../providers/llmClient.js";
import { getTeamMembers, type AgentRecord } from "./contextCompiler.js";
import { runAgentTurn, type AgentRunResult } from "./agentRunner.js";

export interface TeamMissionResult {
  teamId: string;
  teamName: string;
  mode: string;
  contributions: AgentRunResult[];
  synthesis: AgentRunResult;
  blackboardCount: number;
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
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(params.sessionId);
  return id;
}

function pickSynthesizer(members: AgentRecord[]): AgentRecord {
  const strat = members.find((m) => m.purpose === "strategy" || m.slug === "yudhistira");
  return strat || members[0];
}

export async function runTeamMission(params: {
  teamId: string;
  sessionId: string;
  userPrompt: string;
  history?: LLMMessage[];
  activeAgentIds?: string[];
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

  const mode = team.collaboration_mode || "deliberate";
  const synthesizer = pickSynthesizer(members);
  const specialists = members.filter((m) => m.id !== synthesizer.id);

  params.onEvent?.({
    type: "team_phase",
    teamId: team.id,
    teamName: team.name,
    mode,
    phase: "activation",
    members: members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, purpose: m.purpose, model: m.model })),
  });

  const contributions: AgentRunResult[] = [];

  if (mode === "sequential") {
    // Relay Chain: each teammate builds on the previous peer's contribution
    let runningContext = "";
    for (const member of members) {
      params.onEvent?.({
        type: "team_phase",
        phase: "relay",
        detail: `${member.avatar} ${member.name} is contributing...`,
      });
      const res = await runAgentTurn({
        agentId: member.id,
        teamId: team.id,
        sessionId: params.sessionId,
        prompt: runningContext
          ? `User Mission:\n${params.userPrompt}\n\nPrior Teammate Contributions:\n${runningContext}\n\nNow contribute your specialist perspective (${member.title}) concisely and directly.`
          : `User Mission:\n${params.userPrompt}\n\nLead off with your specialist analysis (${member.title}) concisely.`,
        history: params.history,
        extraSystemNote:
          "You are collaborating inside a Pandawa Agentic Team (Relay Mode). Build directly on teammates' insights and post key decisions to the Team Blackboard when helpful.",
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
          durationMs: res.durationMs,
          dryRun: res.dryRun,
        },
      });
    }

    const last = contributions[contributions.length - 1];
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

  // Default: Musyawarah Peer Deliberation (`deliberate` / `parallel` / `consensus`)
  // Phase 1: Parallel Peer Specialist Analysis -> posts findings to Team Blackboard
  const activeSpecialists = specialists.length > 0 ? specialists : [synthesizer];

  params.onEvent?.({
    type: "team_phase",
    phase: "deliberation_round_1",
    detail: `Peer specialists (${activeSpecialists.map((a) => a.name).join(", ")}) analyzing mission in parallel...`,
  });

  const round1Results = await Promise.all(
    activeSpecialists.map(async (member) => {
      try {
        const res = await runAgentTurn({
          agentId: member.id,
          teamId: team.id,
          sessionId: params.sessionId,
          prompt:
            `User Mission:\n${params.userPrompt}\n\n` +
            `As **${member.name}** (${member.title}), provide your focused specialist contribution for the Pandawa Team Blackboard. ` +
            `Highlight key insights, concrete recommendations, risks, or code/actions from your domain. Keep it crisp and high-signal.`,
          history: params.history,
          extraSystemNote:
            "You are in Round 1 of Pandawa Musyawarah (Peer Deliberation). Your peers are working alongside you in parallel using the shared Main Brain and Team Brain.",
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
    // Record on Team Blackboard automatically so every peer & the UI sees structured peer inputs
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
        durationMs: res.durationMs,
        dryRun: res.dryRun,
      },
    });
  }

  // If ALL specialists were dry-run (no API keys configured yet), return unified dry-run summary without extra call
  if (round1Results.every((r) => r.dryRun)) {
    const summaryContent =
      `## Pandawa Agentic Team — Ready for Live Multi-AI Execution\n\n` +
      `**Team:** ${team.name} (\`${mode}\` mode)\n` +
      `**Wired Peers (${members.length}):** ${members.map((m) => `${m.avatar} **${m.name}** (\`${m.model || "unset"}\`)`).join(" · ")}\n\n` +
      `All agents successfully compiled their **Main Brain -> Team Brain -> Personal Knowledge** topology from the Canvas!\n\n` +
      `👉 Next step: Go to **Multi-AI Providers** in the left sidebar, add at least one API key (or Custom Base URL), and send your mission again to watch the Pandawa Team deliberate & execute live!`;

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

  // Phase 2 (optional peer critique round if mode === 'deliberate' && reviewer exists)
  const reviewer = activeSpecialists.find((m) => m.purpose === "review" || m.slug === "sadewa");
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
      prompt:
        `User Mission:\n${params.userPrompt}\n\n` +
        `Peer Proposals on Team Blackboard:\n${peerDigest}\n\n` +
        `Perform a concise **Peer Cross-Critique**: spot contradictions, missing edge cases, security/operational risks, and confirm what is strongest.`,
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
        durationMs: critiqueRes.durationMs,
      },
    });
  }

  // Phase 3: Team Consensus Synthesis
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
    prompt:
      `Original User Request:\n${params.userPrompt}\n\n` +
      `Teammate Deliberation & Blackboard Contributions:\n${allPeerNotes}\n\n` +
      `Synthesize the **Unified Pandawa Team Consensus Response** directly for the user. ` +
      `Combine the best insights from each teammate, resolve trade-offs cleanly, and give a clear, actionable answer. ` +
      `If the team discovered an important long-term lesson or preference, consider saving it with \`remember_fact\`.`,
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
      durationMs: synthesis.durationMs,
      promptTokens: synthesis.promptTokens,
      completionTokens: synthesis.completionTokens,
    },
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
}

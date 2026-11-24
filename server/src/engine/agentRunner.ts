import { generateId } from "../config.js";
import { getDb, getSetting } from "../db/database.js";
import { decryptSecret } from "../auth/cryptoVault.js";
import {
  callLLM,
  type LLMImageAttachment,
  type LLMMessage,
  type ProviderRecord,
} from "../providers/llmClient.js";
import { compileAgentRuntime, type CompiledAgentRuntime } from "./contextCompiler.js";
import {
  getToolsForPacks,
  executeTool,
  releaseAgentFileLocks,
  markTeamMessageRead,
} from "../tools/toolRegistry.js";
import { getAllLiveMcpTools } from "../mcp/mcpClient.js";

export interface AgentRunResult {
  agentId: string;
  agentName: string;
  avatar: string;
  model: string;
  providerName: string;
  content: string;
  reasoning: string;
  toolTrace: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  stepsUsed?: number;
  usedFallbackProvider?: boolean;
}

function isProviderReady(p: ProviderRecord | null): p is ProviderRecord {
  if (!p || !p.enabled) return false;
  const isLocal =
    p.base_url.includes("127.0.0.1") ||
    p.base_url.includes("localhost") ||
    p.base_url.includes(":11434");
  if (isLocal) return true;
  const k = decryptSecret(p.api_key || "").trim();
  return k.length > 0 && k.toLowerCase() !== "ollama";
}

function resolveRunnableProvider(runtime: CompiledAgentRuntime): {
  provider: ProviderRecord | null;
  model: string;
  usedFallback: boolean;
} {
  if (isProviderReady(runtime.provider)) {
    return {
      provider: runtime.provider,
      model: runtime.model || runtime.provider.default_model,
      usedFallback: false,
    };
  }

  // Try explicitly wired fallback provider nodes on Canvas first
  const wiredReady = runtime.fallbackProviders.find((f) => isProviderReady(f.provider));
  if (wiredReady) {
    return {
      provider: wiredReady.provider,
      model: wiredReady.model || wiredReady.provider.default_model,
      usedFallback: true,
    };
  }

  // Only auto-pick a system provider if the agent has NO provider assigned at all
  if (!runtime.agent.provider_id && !runtime.provider) {
    const db = getDb();
    const candidates = db
      .prepare("SELECT * FROM providers WHERE enabled = 1 ORDER BY updated_at DESC")
      .all() as unknown as ProviderRecord[];
    const ready = candidates.find(
      (c) =>
        isProviderReady(c) &&
        decryptSecret(c.api_key || "").trim().toLowerCase() !== "ollama"
    );
    if (ready) {
      return { provider: ready, model: runtime.model || ready.default_model, usedFallback: true };
    }
  }

  return { provider: null, model: runtime.model || "unconfigured", usedFallback: false };
}

function totalMessageChars(msgs: LLMMessage[]): number {
  return msgs.reduce((acc, m) => acc + (m.content?.length || 0), 0);
}

/**
 * LLM-Powered Semantic Compaction (replaces naive truncation):
 * Preserves system prompt + original mission + recent coherent tool pairs,
 * while asking the model to distill older steps into a high-signal checkpoint.
 */
async function compactMessagesWithLLM(params: {
  messages: LLMMessage[];
  provider: ProviderRecord;
  model: string;
  signal?: AbortSignal;
  charLimit?: number;
  onEvent?: (ev: Record<string, unknown>) => void;
  agentName: string;
}): Promise<LLMMessage[]> {
  const limit = params.charLimit ?? 54_000;
  const { messages } = params;
  if (totalMessageChars(messages) <= limit || messages.length <= 10) return messages;

  // Keep messages[0] (system) and messages[1] (initial user prompt or early context)
  const head = messages.slice(0, 2);
  // Find a safe tail cut boundary that never starts on an orphaned 'tool' message
  let tailStart = Math.max(2, messages.length - 8);
  while (tailStart > 2 && messages[tailStart].role === "tool") {
    tailStart--;
  }
  // Ensure tailStart doesn't detach a tool response from its preceding assistant tool_calls
  if (tailStart < messages.length && messages[tailStart].role === "tool") {
    tailStart = messages.length;
  }
  const middle = messages.slice(2, tailStart);
  const tail = messages.slice(tailStart);
  if (middle.length < 3) return messages;

  const transcript = middle
    .map((m) => {
      if (m.role === "tool") return `[TOOL ${m.name || "result"}]: ${m.content.slice(0, 800)}`;
      if (m.tool_calls?.length) {
        const calls = m.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 180)})`).join(", ");
        return `[ASSISTANT]: ${m.content.slice(0, 500)} | calls: ${calls}`;
      }
      return `[${m.role.toUpperCase()}]: ${m.content.slice(0, 700)}`;
    })
    .join("\n")
    .slice(0, 24_000);

  let summary = "";
  try {
    const res = await callLLM({
      provider: params.provider,
      model: params.model,
      temperature: 0.2,
      maxTokens: 1200,
      signal: params.signal,
      messages: [
        {
          role: "system",
          content:
            "You are a precision execution state compactor for an autonomous AI agent. Compress the prior work log into a dense, lossless checkpoint.",
        },
        {
          role: "user",
          content:
            `Summarize these ${middle.length} earlier execution steps into concise bullet sections:\n` +
            `1. Goal & Decisions\n2. Files Created / Modified (exact paths)\n3. Active Terminal Sessions & Running Processes\n4. Verified Outputs & Remaining Errors/Blockers\n5. Next Steps\n\n` +
            `WORK LOG:\n${transcript}`,
        },
      ],
    });
    summary = res.content.trim();
  } catch {
    // Graceful fallback if compaction call fails
    summary = middle
      .filter((m) => m.role !== "tool")
      .map((m) => `- [${m.role}]: ${m.content.slice(0, 320)}`)
      .join("\n")
      .slice(0, 5000);
  }

  params.onEvent?.({
    type: "context_compacted",
    agentName: params.agentName,
    compactedCount: middle.length,
    summaryChars: summary.length,
  });

  const compactedNote: LLMMessage = {
    role: "user",
    content: `[PANDAWA SEMANTIC COMPACTION — ${middle.length} earlier steps distilled to keep context sharp]\n\n${summary}`,
  };
  return [...head, compactedNote, ...tail];
}

function getBackupProviders(excludeId: string): ProviderRecord[] {
  const db = getDb();
  const candidates = db
    .prepare("SELECT * FROM providers WHERE enabled = 1 AND id != ? AND length(trim(api_key)) > 0 ORDER BY updated_at DESC")
    .all(excludeId) as unknown as ProviderRecord[];
  return candidates.filter((c) => {
    const k = decryptSecret(c.api_key || "");
    return k.trim().length > 0 && k !== "ollama";
  });
}

function fetchUnreadTeamMessages(params: {
  teamId?: string;
  sessionId?: string;
  agentName: string;
  seenIds: Set<string>;
  markRead?: boolean;
}): Array<{ id: string; from_agent: string; to_agent: string; kind: string; content: string }> {
  if (!params.teamId || !params.sessionId) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, from_agent, to_agent, kind, content, read_by_json
       FROM team_messages
       WHERE team_id = ? AND session_id = ?
       ORDER BY created_at ASC`
    )
    .all(params.teamId, params.sessionId) as Array<{
    id: string;
    from_agent: string;
    to_agent: string;
    kind: string;
    content: string;
    read_by_json: string;
  }>;

  const myName = params.agentName.toLowerCase();
  const fresh: Array<{ id: string; from_agent: string; to_agent: string; kind: string; content: string }> = [];
  for (const r of rows) {
    if (params.seenIds.has(r.id)) continue;
    params.seenIds.add(r.id);
    if (r.from_agent.toLowerCase() === myName) continue;
    let readers: string[] = [];
    try {
      const parsed = JSON.parse(r.read_by_json || "[]");
      if (Array.isArray(parsed)) readers = parsed.map((x) => String(x).toLowerCase());
    } catch {
      readers = [];
    }
    if (readers.includes(myName)) continue;
    const to = r.to_agent.toLowerCase();
    if (to === "all" || to === myName || myName.includes(to) || to.includes(myName)) {
      fresh.push({ id: r.id, from_agent: r.from_agent, to_agent: r.to_agent, kind: r.kind, content: r.content });
      if (params.markRead !== false) {
        markTeamMessageRead(r.id, r.read_by_json, params.agentName);
      }
    }
  }
  return fresh;
}

export async function runAgentTurn(params: {
  agentId: string;
  prompt: string;
  images?: LLMImageAttachment[];
  history?: LLMMessage[];
  teamId?: string;
  sessionId?: string;
  maxIterations?: number;
  consultDepth?: number;
  extraSystemNote?: string;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<AgentRunResult> {
  const started = Date.now();
  const runtime = compileAgentRuntime(params.agentId, params.teamId, params.sessionId);
  let { provider, model, usedFallback } = resolveRunnableProvider(runtime);

  params.onEvent?.({
    type: "agent_start",
    agentId: runtime.agent.id,
    agentName: runtime.agent.name,
    avatar: runtime.agent.avatar,
    model,
    brains: runtime.summary.brainNames,
    mountedPaths: runtime.summary.mountedPaths,
  });

  if (!provider) {
    const errMsg =
      `No configured AI provider for ${runtime.agent.name} ` +
      `(assigned provider: "${runtime.provider?.name || "none"}", model: "${runtime.model || "unset"}"). ` +
      `Open Multi-AI Hub to add an API key or assign a ready provider before running a live mission.`;

    params.onEvent?.({
      type: "agent_error",
      agentId: runtime.agent.id,
      agentName: runtime.agent.name,
      error: errMsg,
    });

    const err = new Error(errMsg) as Error & { statusCode?: number };
    err.statusCode = 422;
    throw err;
  }

  // Pull live discovered tools from enabled MCP servers
  const liveMcp = await getAllLiveMcpTools();
  const tools = getToolsForPacks(runtime.toolPacks, liveMcp.definitions);

  const systemText = params.extraSystemNote
    ? `${runtime.systemPrompt}\n\n---\n\n${params.extraSystemNote}`
    : runtime.systemPrompt;

  // Track already-existing team messages so we only inject NEW mid-turn peer updates
  const seenTeamMsgIds = new Set<string>();
  fetchUnreadTeamMessages({
    teamId: params.teamId,
    sessionId: params.sessionId,
    agentName: runtime.agent.name,
    seenIds: seenTeamMsgIds,
    markRead: false,
  });

  let messages: LLMMessage[] = [
    { role: "system", content: systemText },
    ...(params.history || []),
    {
      role: "user",
      content: params.prompt,
      ...(params.images && params.images.length > 0 ? { images: params.images } : {}),
    },
  ];

  // Compact initial history if already huge
  if (totalMessageChars(messages) > 54_000) {
    messages = await compactMessagesWithLLM({
      messages,
      provider,
      model,
      signal: params.signal,
      onEvent: params.onEvent,
      agentName: runtime.agent.name,
    });
  }

  const configuredMax = Number(runtime.agent.max_iterations || 35);
  const maxIter = Math.min(100, Math.max(1, params.maxIterations ?? configuredMax));
  const rawBudget = getSetting("max_tokens_per_mission");
  const tokenBudget = rawBudget !== null ? Number(rawBudget) : 250_000; // 0 = unlimited
  const toolTrace: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let finalContent = "";
  let combinedReasoning = "";
  let stepsUsed = 0;
  let lateInboxWakeups = 0;

  try {
    for (let step = 0; step < maxIter; step++) {
      if (params.signal?.aborted) {
        throw new Error("Mission stopped by user.");
      }
      if (tokenBudget > 0 && totalPromptTokens + totalCompletionTokens >= tokenBudget) {
        finalContent =
          (finalContent ? `${finalContent}\n\n` : "") +
          `[Token budget cap reached: ${totalPromptTokens + totalCompletionTokens}/${tokenBudget} tokens. Increase or set max_tokens_per_mission=0 in Settings if needed.]`;
        break;
      }
      stepsUsed = step + 1;

      // Dynamic LLM Semantic Compaction during long multi-step executions (35-100 steps)
      if (step >= 3 && totalMessageChars(messages) > 58_000) {
        messages = await compactMessagesWithLLM({
          messages,
          provider,
          model,
          signal: params.signal,
          onEvent: params.onEvent,
          agentName: runtime.agent.name,
        });
      }

      let res;
      try {
        res = await callLLM({
          provider,
          model,
          messages,
          tools,
          temperature: runtime.agent.temperature,
          maxTokens: runtime.agent.max_tokens,
          signal: params.signal,
          onToken: (delta) => {
            params.onEvent?.({
              type: "agent_token",
              agentId: runtime.agent.id,
              agentName: runtime.agent.name,
              avatar: runtime.agent.avatar,
              model,
              delta,
            });
          },
        });
      } catch (primaryErr) {
        if (params.signal?.aborted) throw primaryErr;
        const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        const failureList: string[] = [`[Primary: ${provider.name} (${model})] ${primaryMsg}`];

        const backups = runtime.fallbackProviders.filter(
          (f) => f.provider.id !== provider!.id && isProviderReady(f.provider)
        );
        if (backups.length === 0) {
          throw new Error(failureList[0]);
        }

        let succeeded = false;
        for (const fb of backups) {
          params.onEvent?.({
            type: "provider_fallback",
            agentId: runtime.agent.id,
            agentName: runtime.agent.name,
            fromProvider: provider.name,
            toProvider: fb.provider.name,
            toModel: fb.model || fb.provider.default_model,
            reason: primaryMsg.slice(0, 140),
          });
          const nextModel = fb.model || fb.provider.default_model;
          try {
            res = await callLLM({
              provider: fb.provider,
              model: nextModel,
              messages,
              tools,
              temperature: runtime.agent.temperature,
              maxTokens: runtime.agent.max_tokens,
              signal: params.signal,
              onToken: (delta) => {
                params.onEvent?.({
                  type: "agent_token",
                  agentId: runtime.agent.id,
                  agentName: runtime.agent.name,
                  avatar: runtime.agent.avatar,
                  model: nextModel,
                  delta,
                });
              },
            });
            provider = fb.provider;
            model = nextModel;
            usedFallback = true;
            succeeded = true;
            break;
          } catch (fbErr) {
            if (params.signal?.aborted) throw fbErr;
            const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
            failureList.push(`[Fallback: ${fb.provider.name} (${nextModel})] ${fbMsg}`);
          }
        }
        if (!succeeded || !res) {
          throw new Error(failureList.join("; "));
        }
      }

      totalPromptTokens += res.promptTokens;
      totalCompletionTokens += res.completionTokens;
      if (res.reasoning) {
        combinedReasoning += (combinedReasoning ? "\n" : "") + res.reasoning;
      }

      if (res.toolCalls.length === 0) {
        if ((params.consultDepth ?? 0) === 0 && lateInboxWakeups < 2 && step < maxIter - 1) {
          const lateMsgs = fetchUnreadTeamMessages({
            teamId: params.teamId,
            sessionId: params.sessionId,
            agentName: runtime.agent.name,
            seenIds: seenTeamMsgIds,
            markRead: true,
          });
          if (lateMsgs.length > 0) {
            lateInboxWakeups++;
            messages.push({ role: "assistant", content: res.content || "(Drafting response)" });
            messages.push({
              role: "user",
              content:
                `[LIVE TEAMMATE MESSAGE(S) RECEIVED BEFORE FINALIZING]\n` +
                lateMsgs.map((m) => `- **[${m.kind}] ${m.from_agent} → ${m.to_agent}:** ${m.content}`).join("\n") +
                `\n\nIncorporate or act on this teammate update before giving your final response.`,
            });
            continue;
          }
        }
        finalContent = res.content;
        break;
      }

      messages.push({
        role: "assistant",
        content: res.content,
        tool_calls: res.toolCalls,
      });

      const attachedImagesThisStep: LLMImageAttachment[] = [];

      for (const tc of res.toolCalls) {
        if (params.signal?.aborted) throw new Error("Mission stopped by user.");
        params.onEvent?.({
          type: "tool_call",
          agentId: runtime.agent.id,
          agentName: runtime.agent.name,
          step: stepsUsed,
          maxSteps: maxIter,
          toolName: tc.name,
          args: tc.arguments,
        });

        const toolOutput = await executeTool(tc.name, tc.arguments, {
          runtime,
          teamId: params.teamId,
          sessionId: params.sessionId,
          consultDepth: params.consultDepth ?? 0,
          signal: params.signal,
          onImageCaptured: (img) => attachedImagesThisStep.push(img),
          consultPeer: async (peerId: string, question: string) => {
            const peerRes = await runAgentTurn({
              agentId: peerId,
              teamId: params.teamId,
              sessionId: params.sessionId,
              consultDepth: (params.consultDepth ?? 0) + 1,
              maxIterations: 10,
              signal: params.signal,
              prompt: `Your Pandawa teammate **${runtime.agent.name}** (${runtime.agent.title}) is consulting you mid-execution:\n\n${question}\n\nYou have full access to shared terminals, workspace, and brain tools if you need to inspect or verify anything. Respond concisely and directly.`,
              extraSystemNote: "You are responding to a live peer consultation from a Pandawa teammate.",
              onEvent: params.onEvent,
            });
            return peerRes.content;
          },
          mcpLookup: liveMcp.lookup,
          onEvent: params.onEvent,
        });

        toolTrace.push({ name: tc.name, args: tc.arguments, result: toolOutput });

        params.onEvent?.({
          type: "tool_result",
          agentId: runtime.agent.id,
          agentName: runtime.agent.name,
          toolName: tc.name,
          preview: toolOutput.slice(0, 320),
        });

        messages.push({
          role: "tool",
          name: tc.name,
          tool_call_id: tc.id,
          content: toolOutput,
        });
      }

      // If any tool captured a visual screenshot/image, feed it directly to the vision model!
      if (attachedImagesThisStep.length > 0) {
        messages.push({
          role: "user",
          content: `[Visual Capture Attached: ${attachedImagesThisStep.map((i) => i.name || "screenshot.png").join(", ")}] Inspect the image(s) carefully to verify UI layout, errors, or page content.`,
          images: attachedImagesThisStep,
        });
      }

      // Deliver any live mid-execution teammate messages sent while we were running tools!
      const newPeerMsgs = fetchUnreadTeamMessages({
        teamId: params.teamId,
        sessionId: params.sessionId,
        agentName: runtime.agent.name,
        seenIds: seenTeamMsgIds,
      });
      if (newPeerMsgs.length > 0) {
        messages.push({
          role: "user",
          content:
            `[LIVE TEAMMATE MESSAGE(S) RECEIVED MID-EXECUTION]\n` +
            newPeerMsgs.map((m) => `- **[${m.kind}] ${m.from_agent} → ${m.to_agent}:** ${m.content}`).join("\n"),
        });
      }

      if (step === maxIter - 1) {
        try {
          const wrapRes = await callLLM({
            provider,
            model,
            messages: [
              ...messages,
              {
                role: "user",
                content:
                  "Max tool step limit reached. Summarize what you executed and observed concisely without calling additional tools.",
              },
            ],
            tools: [],
            temperature: runtime.agent.temperature,
            maxTokens: runtime.agent.max_tokens,
            signal: params.signal,
          });
          totalPromptTokens += wrapRes.promptTokens;
          totalCompletionTokens += wrapRes.completionTokens;
          finalContent = wrapRes.content || res.content || `Completed ${stepsUsed} autonomous tool execution steps.`;
        } catch {
          finalContent = res.content || `Completed ${stepsUsed} autonomous tool execution steps.`;
        }
      }
    }
  } catch (runErr) {
    const errMsg = runErr instanceof Error ? runErr.message : String(runErr);
    params.onEvent?.({
      type: "agent_error",
      agentId: runtime.agent.id,
      agentName: runtime.agent.name,
      error: errMsg,
    });
    throw runErr;
  } finally {
    releaseAgentFileLocks(params.sessionId, runtime.agent.name);
    params.onEvent?.({
      type: "agent_done",
      agentId: runtime.agent.id,
      agentName: runtime.agent.name,
      model,
      providerName: provider.name,
      content: finalContent,
      stepsUsed,
      durationMs: Date.now() - started,
    });
  }

  const durationMs = Date.now() - started;

  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO usage_logs (id, session_id, agent_id, provider_id, model, prompt_tokens, completion_tokens, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("use"),
      params.sessionId || "",
      runtime.agent.id,
      provider.id,
      model,
      totalPromptTokens,
      totalCompletionTokens,
      durationMs
    );
  } catch {
    // ignore usage logging error
  }

  return {
    agentId: runtime.agent.id,
    agentName: runtime.agent.name,
    avatar: runtime.agent.avatar,
    model,
    providerName: provider.name,
    content: finalContent,
    reasoning: combinedReasoning,
    toolTrace,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    durationMs,
    stepsUsed,
    usedFallbackProvider: usedFallback,
  };
}

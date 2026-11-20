import { generateId } from "../config.js";
import { getDb } from "../db/database.js";
import { callLLM, type LLMMessage, type ProviderRecord } from "../providers/llmClient.js";
import { compileAgentRuntime, type CompiledAgentRuntime } from "./contextCompiler.js";
import { getToolsForPacks, executeTool } from "../tools/toolRegistry.js";

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
  usedFallbackProvider?: boolean;
  dryRun?: boolean;
}

function isProviderReady(p: ProviderRecord | null): p is ProviderRecord {
  if (!p || !p.enabled) return false;
  const isLocal =
    p.base_url.includes("127.0.0.1") ||
    p.base_url.includes("localhost") ||
    p.base_url.includes(":11434");
  return Boolean(p.api_key && p.api_key.trim().length > 0) || isLocal;
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
  // Try any configured enabled provider with an API key (excluding unconfigured localhost unless explicitly bound)
  const db = getDb();
  const candidates = db
    .prepare("SELECT * FROM providers WHERE enabled = 1 AND length(trim(api_key)) > 0 ORDER BY updated_at DESC")
    .all() as unknown as ProviderRecord[];
  const nonOllama = candidates.find((c) => c.api_key !== "ollama");
  if (nonOllama) {
    return {
      provider: nonOllama,
      model: nonOllama.default_model,
      usedFallback: true,
    };
  }
  return { provider: null, model: runtime.model || "unconfigured", usedFallback: false };
}

function compressHistory(history: LLMMessage[], maxChars = 24_000): LLMMessage[] {
  let total = history.reduce((acc, m) => acc + (m.content?.length || 0), 0);
  if (total <= maxChars || history.length <= 6) return history;

  const head = history.slice(0, 2);
  const tail = history.slice(-6);
  const middle = history.slice(2, -6);
  const summaryLines = middle.map((m) => `[${m.role}${m.name ? `/${m.name}` : ""}]: ${m.content.slice(0, 240)}`);
  const compressedMsg: LLMMessage = {
    role: "system",
    content: `[Compressed Earlier Context — ${middle.length} messages summarized]\n${summaryLines.join("\n").slice(0, 4000)}`,
  };
  return [...head, compressedMsg, ...tail];
}

export async function runAgentTurn(params: {
  agentId: string;
  prompt: string;
  history?: LLMMessage[];
  teamId?: string;
  sessionId?: string;
  maxIterations?: number;
  extraSystemNote?: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<AgentRunResult> {
  const started = Date.now();
  const runtime = compileAgentRuntime(params.agentId, params.teamId, params.sessionId);
  const { provider, model, usedFallback } = resolveRunnableProvider(runtime);

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
    const dryContent =
      `[Pandawa Dry-Run · No API Key Configured Yet]\n\n` +
      `**${runtime.agent.avatar} ${runtime.agent.name}** (${runtime.agent.title}) is wired and ready!\n` +
      `- **Assigned Model:** \`${runtime.model || "not set"}\` (purpose: \`${runtime.agent.purpose}\`)\n` +
      `- **Connected Brains:** ${runtime.summary.brainNames.join(", ") || "None"}\n` +
      `- **Mounted Knowledge Files:** ${runtime.summary.mountedPaths.join(", ") || "None"} (${runtime.summary.totalFiles} files, ${runtime.summary.totalChars} chars compiled)\n` +
      `- **Active Tool Packs:** ${runtime.toolPacks.join(", ")}\n\n` +
      `To run live AI responses, open **Multi-AI Providers** in the sidebar and add an API key (OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, or any Custom Base URL).`;

    params.onEvent?.({
      type: "agent_done",
      agentId: runtime.agent.id,
      agentName: runtime.agent.name,
      content: dryContent,
      dryRun: true,
    });

    return {
      agentId: runtime.agent.id,
      agentName: runtime.agent.name,
      avatar: runtime.agent.avatar,
      model,
      providerName: "Unconfigured (Dry-Run)",
      content: dryContent,
      reasoning: "",
      toolTrace: [],
      promptTokens: 0,
      completionTokens: 0,
      durationMs: Date.now() - started,
      dryRun: true,
    };
  }

  const tools = getToolsForPacks(runtime.toolPacks);
  const systemText = params.extraSystemNote
    ? `${runtime.systemPrompt}\n\n---\n\n${params.extraSystemNote}`
    : runtime.systemPrompt;

  const baseHistory = compressHistory(params.history || []);
  const messages: LLMMessage[] = [
    { role: "system", content: systemText },
    ...baseHistory,
    { role: "user", content: params.prompt },
  ];

  const maxIter = params.maxIterations ?? 5;
  const toolTrace: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let finalContent = "";
  let combinedReasoning = "";

  for (let step = 0; step < maxIter; step++) {
    const res = await callLLM({
      provider,
      model,
      messages,
      tools,
      temperature: runtime.agent.temperature,
      maxTokens: runtime.agent.max_tokens,
    });

    totalPromptTokens += res.promptTokens;
    totalCompletionTokens += res.completionTokens;
    if (res.reasoning) {
      combinedReasoning += (combinedReasoning ? "\n" : "") + res.reasoning;
    }

    if (res.toolCalls.length === 0) {
      finalContent = res.content;
      break;
    }

    messages.push({
      role: "assistant",
      content: res.content,
      tool_calls: res.toolCalls,
    });

    for (const tc of res.toolCalls) {
      params.onEvent?.({
        type: "tool_call",
        agentId: runtime.agent.id,
        agentName: runtime.agent.name,
        toolName: tc.name,
        args: tc.arguments,
      });

      const toolOutput = await executeTool(tc.name, tc.arguments, {
        runtime,
        teamId: params.teamId,
        sessionId: params.sessionId,
        onEvent: params.onEvent,
      });

      toolTrace.push({ name: tc.name, args: tc.arguments, result: toolOutput });

      params.onEvent?.({
        type: "tool_result",
        agentId: runtime.agent.id,
        agentName: runtime.agent.name,
        toolName: tc.name,
        preview: toolOutput.slice(0, 300),
      });

      messages.push({
        role: "tool",
        name: tc.name,
        tool_call_id: tc.id,
        content: toolOutput,
      });
    }

    if (step === maxIter - 1) {
      finalContent = res.content || "Completed tool execution steps.";
    }
  }

  const durationMs = Date.now() - started;

  // Record usage stats
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

  params.onEvent?.({
    type: "agent_done",
    agentId: runtime.agent.id,
    agentName: runtime.agent.name,
    model,
    providerName: provider.name,
    content: finalContent,
    durationMs,
  });

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
    usedFallbackProvider: usedFallback,
  };
}

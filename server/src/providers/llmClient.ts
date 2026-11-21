import { decryptSecret } from "../auth/cryptoVault.js";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRecord {
  id: string;
  name: string;
  kind: string; // 'openai' | 'anthropic' | 'gemini'
  base_url: string;
  api_key: string;
  default_model: string;
  models_json: string;
  headers_json: string;
  enabled: number;
}

export interface LLMCompletionResult {
  content: string;
  reasoning: string;
  toolCalls: LLMToolCall[];
  promptTokens: number;
  completionTokens: number;
  model: string;
  providerId: string;
  durationMs: number;
}

function parseCustomHeaders(headersJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(headersJson || "{}");
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    // ignore
  }
  return {};
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const val = JSON.parse(raw);
    return val && typeof val === "object" ? (val as Record<string, unknown>) : { raw };
  } catch {
    return { raw };
  }
}

async function* iterateSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data) yield data;
      }
    }
  }
  if (buffer.trim().startsWith("data:")) {
    const data = buffer.trim().slice(5).trim();
    if (data) yield data;
  }
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/aborted|abort/i.test(msg)) return false;
  return /\((429|500|502|503|504|529)\)|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Mission aborted by user.");
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Mission aborted by user."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function callLLM(params: {
  provider: ProviderRecord;
  model?: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<LLMCompletionResult> {
  const { provider, messages, tools = [], temperature = 0.6, maxTokens = 4096, onToken, signal } = params;
  const model = params.model || provider.default_model;
  const apiKey = decryptSecret(provider.api_key || "");

  const isLocal =
    provider.base_url.includes("127.0.0.1") ||
    provider.base_url.includes("localhost") ||
    provider.base_url.includes(":11434");

  if (!apiKey && !isLocal) {
    throw new Error(
      `Provider "${provider.name}" has no API key configured. Open Multi-AI Hub to add an API key or assign a configured provider.`
    );
  }

  const kind = (provider.kind || "openai").toLowerCase();
  const customHeaders = parseCustomHeaders(provider.headers_json);

  const maxAttempts = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("Mission aborted by user.");
    const started = Date.now();
    try {
      if (kind === "anthropic") {
        return await callAnthropic({ provider, apiKey, model, messages, tools, temperature, maxTokens, customHeaders, started, onToken, signal });
      }
      if (kind === "gemini") {
        return await callGemini({ provider, apiKey, model, messages, tools, temperature, maxTokens, customHeaders, started, onToken, signal });
      }
      return await callOpenAICompat({ provider, apiKey, model, messages, tools, temperature, maxTokens, customHeaders, started, onToken, signal });
    } catch (err) {
      lastErr = err;
      if (signal?.aborted || attempt === maxAttempts || !isRetryableError(err)) {
        throw err;
      }
      await sleepAbortable(1200 * attempt, signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function callOpenAICompat(args: {
  provider: ProviderRecord;
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  temperature: number;
  maxTokens: number;
  customHeaders: Record<string, string>;
  started: number;
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<LLMCompletionResult> {
  const { provider, apiKey, model, messages, tools, temperature, maxTokens, customHeaders, started, onToken, signal } = args;
  const base = provider.base_url.replace(/\/+$/, "");
  const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;

  const formattedMessages = messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id || "call_0", content: m.content };
    }
    return { role: m.role, content: m.content };
  });

  const useStream = Boolean(onToken);
  const body: Record<string, unknown> = {
    model,
    messages: formattedMessages,
    temperature,
    max_tokens: maxTokens,
    ...(useStream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const headers: Record<string, string> = { "Content-Type": "application/json", ...customHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI-compat API error (${resp.status}) [${provider.name}]: ${errText.slice(0, 500)}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  if (useStream && resp.body && contentType.includes("text/event-stream")) {
    let content = "";
    let reasoning = "";
    let promptTokens = 0;
    let completionTokens = 0;
    const tcMap = new Map<number, { id: string; name: string; argsRaw: string }>();

    for await (const data of iterateSseData(resp.body)) {
      if (data === "[DONE]") break;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              reasoning?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens || promptTokens;
          completionTokens = chunk.usage.completion_tokens || completionTokens;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onToken?.(delta.content);
        }
        if (delta.reasoning_content || delta.reasoning) {
          reasoning += delta.reasoning_content || delta.reasoning || "";
        }
        for (const tc of delta.tool_calls || []) {
          const idx = tc.index ?? 0;
          const cur = tcMap.get(idx) || { id: tc.id || `tc_${Date.now()}_${idx}`, name: "", argsRaw: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.argsRaw += tc.function.arguments;
          tcMap.set(idx, cur);
        }
      } catch {
        // ignore partial chunk
      }
    }

    const toolCalls: LLMToolCall[] = Array.from(tcMap.values()).map((t) => ({
      id: t.id,
      name: t.name || "unknown",
      arguments: safeJsonParse(t.argsRaw || "{}"),
    }));

    return {
      content,
      reasoning,
      toolCalls,
      promptTokens,
      completionTokens,
      model,
      providerId: provider.id,
      durationMs: Date.now() - started,
    };
  }

  // Non-streaming fallback
  const data = (await resp.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const msg = data.choices?.[0]?.message;
  const content = msg?.content || "";
  if (content && onToken) onToken(content);
  const toolCalls: LLMToolCall[] = (msg?.tool_calls || []).map((tc, idx) => ({
    id: tc.id || `tc_${Date.now()}_${idx}`,
    name: tc.function?.name || "unknown",
    arguments: safeJsonParse(tc.function?.arguments || "{}"),
  }));

  return {
    content,
    reasoning: msg?.reasoning_content || msg?.reasoning || "",
    toolCalls,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    model,
    providerId: provider.id,
    durationMs: Date.now() - started,
  };
}

async function callAnthropic(args: {
  provider: ProviderRecord;
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  temperature: number;
  maxTokens: number;
  customHeaders: Record<string, string>;
  started: number;
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<LLMCompletionResult> {
  const { provider, apiKey, model, messages, tools, temperature, maxTokens, customHeaders, started, onToken, signal } = args;
  const base = provider.base_url.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1/messages") ? base : `${base}/v1/messages`;

  const systemParts: string[] = [];
  const anthropicMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      anthropicMessages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      anthropicMessages.push({ role: "assistant", content: blocks.length ? blocks : m.content });
    } else if (m.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id || "tool_0", content: m.content }],
      });
    }
  }

  const useStream = Boolean(onToken);
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: anthropicMessages,
    ...(useStream ? { stream: true } : {}),
  };
  if (systemParts.length > 0) {
    // Enable Anthropic ephemeral prompt caching on the compiled Brain system prompt!
    body.system = [
      {
        type: "text",
        text: systemParts.join("\n\n"),
        cache_control: { type: "ephemeral" },
      },
    ];
  }
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...customHeaders,
    },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error (${resp.status}) [${provider.name}]: ${errText.slice(0, 500)}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  if (useStream && resp.body && contentType.includes("text/event-stream")) {
    let content = "";
    let reasoning = "";
    let promptTokens = 0;
    let completionTokens = 0;
    const toolBlocks = new Map<number, { id: string; name: string; jsonBuf: string }>();

    for await (const data of iterateSseData(resp.body)) {
      try {
        const ev = JSON.parse(data) as {
          type?: string;
          index?: number;
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
        };
        if (ev.type === "message_start" && ev.message?.usage?.input_tokens) {
          promptTokens = ev.message.usage.input_tokens;
        } else if (ev.type === "message_delta" && ev.usage?.output_tokens) {
          completionTokens = ev.usage.output_tokens;
        } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          toolBlocks.set(ev.index ?? 0, {
            id: ev.content_block.id || `atc_${Date.now()}`,
            name: ev.content_block.name || "unknown",
            jsonBuf: "",
          });
        } else if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta" && ev.delta.text) {
            content += ev.delta.text;
            onToken?.(ev.delta.text);
          } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
            reasoning += ev.delta.thinking;
          } else if (ev.delta.type === "input_json_delta" && ev.delta.partial_json) {
            const tb = toolBlocks.get(ev.index ?? 0);
            if (tb) tb.jsonBuf += ev.delta.partial_json;
          }
        }
      } catch {
        // ignore
      }
    }

    const toolCalls: LLMToolCall[] = Array.from(toolBlocks.values()).map((tb) => ({
      id: tb.id,
      name: tb.name,
      arguments: safeJsonParse(tb.jsonBuf || "{}"),
    }));

    return {
      content,
      reasoning,
      toolCalls,
      promptTokens,
      completionTokens,
      model,
      providerId: provider.id,
      durationMs: Date.now() - started,
    };
  }

  const data = (await resp.json()) as {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  let content = "";
  let reasoning = "";
  const toolCalls: LLMToolCall[] = [];

  for (const block of data.content || []) {
    if (block.type === "text" && block.text) content += block.text;
    else if (block.type === "thinking" && block.thinking) reasoning += block.thinking;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `atc_${Date.now()}`,
        name: block.name || "unknown",
        arguments: block.input || {},
      });
    }
  }
  if (content && onToken) onToken(content);

  return {
    content,
    reasoning,
    toolCalls,
    promptTokens: data.usage?.input_tokens || 0,
    completionTokens: data.usage?.output_tokens || 0,
    model,
    providerId: provider.id,
    durationMs: Date.now() - started,
  };
}

async function callGemini(args: {
  provider: ProviderRecord;
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  temperature: number;
  maxTokens: number;
  customHeaders: Record<string, string>;
  started: number;
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<LLMCompletionResult> {
  const { provider, apiKey, model, messages, tools, temperature, maxTokens, customHeaders, started, onToken, signal } = args;
  const base = provider.base_url.replace(/\/+$/, "");
  const useStream = Boolean(onToken);
  const endpoint = useStream
    ? `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
    : `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: unknown[] }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls || []) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
    } else if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name || "tool", response: { result: m.content } } }],
      });
    }
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }
  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...customHeaders },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error (${resp.status}) [${provider.name}]: ${errText.slice(0, 500)}`);
  }

  let content = "";
  let reasoning = "";
  const toolCalls: LLMToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  const contentType = resp.headers.get("content-type") || "";
  if (useStream && resp.body && contentType.includes("text/event-stream")) {
    for await (const data of iterateSseData(resp.body)) {
      try {
        const chunk = JSON.parse(data) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                thought?: boolean;
                functionCall?: { name?: string; args?: Record<string, unknown> };
              }>;
            };
          }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount || promptTokens;
          completionTokens = chunk.usageMetadata.candidatesTokenCount || completionTokens;
        }
        for (const part of chunk.candidates?.[0]?.content?.parts || []) {
          if (part.thought && part.text) reasoning += part.text;
          else if (part.text) {
            content += part.text;
            onToken?.(part.text);
          } else if (part.functionCall) {
            toolCalls.push({
              id: `gtc_${Date.now()}_${toolCalls.length}`,
              name: part.functionCall.name || "unknown",
              arguments: part.functionCall.args || {},
            });
          }
        }
      } catch {
        // ignore
      }
    }
    return {
      content,
      reasoning,
      toolCalls,
      promptTokens,
      completionTokens,
      model,
      providerId: provider.id,
      durationMs: Date.now() - started,
    };
  }

  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          thought?: boolean;
          functionCall?: { name?: string; args?: Record<string, unknown> };
        }>;
      };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  for (const part of data.candidates?.[0]?.content?.parts || []) {
    if (part.thought && part.text) reasoning += part.text;
    else if (part.text) content += part.text;
    else if (part.functionCall) {
      toolCalls.push({
        id: `gtc_${Date.now()}_${toolCalls.length}`,
        name: part.functionCall.name || "unknown",
        arguments: part.functionCall.args || {},
      });
    }
  }
  if (content && onToken) onToken(content);

  return {
    content,
    reasoning,
    toolCalls,
    promptTokens: data.usageMetadata?.promptTokenCount || 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
    model,
    providerId: provider.id,
    durationMs: Date.now() - started,
  };
}

export async function testProviderConnection(provider: ProviderRecord): Promise<{
  ok: boolean;
  latencyMs: number;
  message: string;
  discoveredModels?: string[];
}> {
  const started = Date.now();
  const kind = (provider.kind || "openai").toLowerCase();
  const customHeaders = parseCustomHeaders(provider.headers_json);
  const apiKey = decryptSecret(provider.api_key || "");

  try {
    if (kind === "openai") {
      const base = provider.base_url.replace(/\/+$/, "");
      const headers: Record<string, string> = { ...customHeaders };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const resp = await fetch(`${base}/models`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { data?: Array<{ id?: string }> };
        const models = (json.data || []).map((m) => m.id).filter(Boolean).slice(0, 25) as string[];
        return {
          ok: true,
          latencyMs: Date.now() - started,
          message: `Connected! Discovered ${models.length} model(s).`,
          discoveredModels: models,
        };
      }
      const res = await callLLM({
        provider,
        model: provider.default_model,
        messages: [{ role: "user", content: "Reply with OK." }],
        maxTokens: 16,
      });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `Connected! Reply: ${res.content.slice(0, 60)}`,
      };
    }

    const res = await callLLM({
      provider,
      model: provider.default_model,
      messages: [{ role: "user", content: "Reply with OK." }],
      maxTokens: 16,
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `Connected! Reply: ${res.content.slice(0, 60)}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

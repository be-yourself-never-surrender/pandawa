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

export async function callLLM(params: {
  provider: ProviderRecord;
  model?: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<LLMCompletionResult> {
  const { provider, messages, tools = [], temperature = 0.6, maxTokens = 4096, signal } = params;
  const model = params.model || provider.default_model;
  const started = Date.now();

  const isLocal =
    provider.base_url.includes("127.0.0.1") ||
    provider.base_url.includes("localhost") ||
    provider.base_url.includes(":11434");

  if (!provider.api_key && !isLocal) {
    throw new Error(
      `Provider "${provider.name}" has no API key configured. Open Multi-AI Providers to add an API key or assign a configured provider to this agent.`
    );
  }

  const kind = (provider.kind || "openai").toLowerCase();
  const customHeaders = parseCustomHeaders(provider.headers_json);

  if (kind === "anthropic") {
    return callAnthropic({ provider, model, messages, tools, temperature, maxTokens, customHeaders, started, signal });
  }
  if (kind === "gemini") {
    return callGemini({ provider, model, messages, tools, temperature, maxTokens, customHeaders, started, signal });
  }
  return callOpenAICompat({ provider, model, messages, tools, temperature, maxTokens, customHeaders, started, signal });
}

async function callOpenAICompat(args: {
  provider: ProviderRecord;
  model: string;
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  temperature: number;
  maxTokens: number;
  customHeaders: Record<string, string>;
  started: number;
  signal?: AbortSignal;
}): Promise<LLMCompletionResult> {
  const { provider, model, messages, tools, temperature, maxTokens, customHeaders, started, signal } = args;
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
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.tool_call_id || "call_0",
        content: m.content,
      };
    }
    return { role: m.role, content: m.content };
  });

  const body: Record<string, unknown> = {
    model,
    messages: formattedMessages,
    temperature,
    max_tokens: maxTokens,
  };

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...customHeaders,
  };
  if (provider.api_key) {
    headers.Authorization = `Bearer ${provider.api_key}`;
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(120_000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI-compat API error (${resp.status}) [${provider.name}]: ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const msg = data.choices?.[0]?.message;
  const toolCalls: LLMToolCall[] = (msg?.tool_calls || []).map((tc, idx) => ({
    id: tc.id || `tc_${Date.now()}_${idx}`,
    name: tc.function?.name || "unknown",
    arguments: safeJsonParse(tc.function?.arguments || "{}"),
  }));

  return {
    content: msg?.content || "",
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
  model: string;
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  temperature: number;
  maxTokens: number;
  customHeaders: Record<string, string>;
  started: number;
  signal?: AbortSignal;
}): Promise<LLMCompletionResult> {
  const { provider, model, messages, tools, temperature, maxTokens, customHeaders, started, signal } = args;
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
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id || "tool_0",
            content: m.content,
          },
        ],
      });
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: anthropicMessages,
  };
  if (systemParts.length > 0) {
    body.system = systemParts.join("\n\n");
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
      "x-api-key": provider.api_key,
      "anthropic-version": "2023-06-01",
      ...customHeaders,
    },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(120_000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Anthropic API error (${resp.status}) [${provider.name}]: ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text) as {
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
  model: string;
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  temperature: number;
  maxTokens: number;
  customHeaders: Record<string, string>;
  started: number;
  signal?: AbortSignal;
}): Promise<LLMCompletionResult> {
  const { provider, model, messages, tools, temperature, maxTokens, customHeaders, started, signal } = args;
  const base = provider.base_url.replace(/\/+$/, "");
  const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.api_key)}`;

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
        parts: [
          {
            functionResponse: {
              name: m.name || "tool",
              response: { result: m.content },
            },
          },
        ],
      });
    }
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
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
    headers: {
      "Content-Type": "application/json",
      ...customHeaders,
    },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(120_000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Gemini API error (${resp.status}) [${provider.name}]: ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text) as {
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

  let content = "";
  let reasoning = "";
  const toolCalls: LLMToolCall[] = [];

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

  try {
    if (kind === "openai") {
      const base = provider.base_url.replace(/\/+$/, "");
      const headers: Record<string, string> = { ...customHeaders };
      if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
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
      // Fallback: try minimal chat completion
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

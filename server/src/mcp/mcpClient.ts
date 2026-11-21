import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { getDb } from "../db/database.js";
import type { LLMToolDefinition } from "../providers/llmClient.js";

export interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  url_or_cmd: string;
  headers_json: string;
  enabled: number;
}

export interface DiscoveredMcpTool {
  serverId: string;
  serverName: string;
  rawName: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const toolCache = new Map<string, { fetchedAt: number; tools: DiscoveredMcpTool[] }>();

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "mcp";
}

function parseHeaders(json: string): Record<string, string> {
  try {
    const obj = JSON.parse(json || "{}");
    return obj && typeof obj === "object" ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function parseCommandLine(cmdLine: string): { cmd: string; args: string[] } {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return { cmd: parts[0] || "", args: parts.slice(1) };
}

// Persistent STDIO MCP client session manager
interface StdioSession {
  proc: ChildProcessWithoutNullStreams;
  nextId: number;
  initialized: boolean;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}

const stdioSessions = new Map<string, StdioSession>();

function getOrStartStdioSession(server: McpServerRow): StdioSession {
  const existing = stdioSessions.get(server.id);
  if (existing && !existing.proc.killed && existing.proc.exitCode === null) {
    return existing;
  }

  const { cmd, args } = parseCommandLine(server.url_or_cmd.trim());
  if (!cmd) throw new Error(`Invalid STDIO command for MCP server "${server.name}".`);

  const extraEnv = parseHeaders(server.headers_json);
  const proc = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });

  const session: StdioSession = {
    proc,
    nextId: 1,
    initialized: false,
    pending: new Map(),
  };

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    try {
      const msg = JSON.parse(trimmed) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (typeof msg.id === "number" && session.pending.has(msg.id)) {
        const p = session.pending.get(msg.id)!;
        clearTimeout(p.timer);
        session.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } catch {
      // ignore non-JSON stdout noise
    }
  });

  proc.on("exit", () => {
    for (const [, p] of session.pending.entries()) {
      clearTimeout(p.timer);
      p.reject(new Error(`STDIO MCP server "${server.name}" exited unexpectedly.`));
    }
    session.pending.clear();
    stdioSessions.delete(server.id);
  });

  stdioSessions.set(server.id, session);
  return session;
}

async function stdioRpc(
  server: McpServerRow,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const session = getOrStartStdioSession(server);
  if (!session.initialized && method !== "initialize") {
    await stdioRpc(server, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pandawa", version: "4.0.0" },
    });
    session.initialized = true;
    session.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }

  const id = session.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`STDIO MCP timeout (${server.name} -> ${method})`));
    }, 25_000);
    session.pending.set(id, { resolve, reject, timer });
    session.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function mcpJsonRpc(
  server: McpServerRow,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (server.transport === "stdio") {
    return stdioRpc(server, method, params);
  }
  const url = server.url_or_cmd.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid MCP URL for ${server.name}: ${url}`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...parseHeaders(server.headers_json),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`MCP HTTP ${resp.status} from ${server.name}: ${text.slice(0, 300)}`);
  }

  let payloadText = text.trim();
  if (payloadText.startsWith("event:") || payloadText.includes("\ndata:")) {
    const dataLines = payloadText
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    payloadText = dataLines[dataLines.length - 1] || "{}";
  }

  const parsed = JSON.parse(payloadText) as {
    result?: unknown;
    error?: { code?: number; message?: string };
  };
  if (parsed.error) {
    throw new Error(`MCP RPC error (${server.name}): ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

export async function discoverMcpTools(server: McpServerRow, force = false): Promise<DiscoveredMcpTool[]> {
  const cached = toolCache.get(server.id);
  if (!force && cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached.tools;
  }

  if (server.transport !== "stdio") {
    try {
      await mcpJsonRpc(server, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pandawa", version: "4.0.0" },
      });
    } catch {
      // stateless endpoints may accept tools/list directly
    }
  }

  const res = (await mcpJsonRpc(server, "tools/list", {})) as {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
  };

  const prefix = slugify(server.name);
  const tools: DiscoveredMcpTool[] = (res?.tools || []).map((t) => ({
    serverId: server.id,
    serverName: server.name,
    rawName: t.name,
    qualifiedName: `mcp__${prefix}__${slugify(t.name)}`,
    description: `[MCP: ${server.name}] ${t.description || t.name}`,
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  }));

  toolCache.set(server.id, { fetchedAt: Date.now(), tools });
  return tools;
}

export async function getAllLiveMcpTools(): Promise<{
  definitions: LLMToolDefinition[];
  lookup: Map<string, DiscoveredMcpTool>;
}> {
  const db = getDb();
  const servers = db.prepare("SELECT * FROM mcp_servers WHERE enabled = 1").all() as unknown as McpServerRow[];
  const definitions: LLMToolDefinition[] = [];
  const lookup = new Map<string, DiscoveredMcpTool>();

  await Promise.all(
    servers.map(async (srv) => {
      try {
        const discovered = await discoverMcpTools(srv, false);
        for (const t of discovered) {
          lookup.set(t.qualifiedName, t);
          definitions.push({
            name: t.qualifiedName,
            description: t.description,
            parameters: t.inputSchema,
          });
        }
      } catch {
        // Offline MCP server shouldn't block agent execution
      }
    })
  );

  return { definitions, lookup };
}

export async function invokeMcpTool(
  tool: DiscoveredMcpTool,
  args: Record<string, unknown>
): Promise<string> {
  const db = getDb();
  const server = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(tool.serverId) as unknown as
    | McpServerRow
    | undefined;
  if (!server) return `MCP server ${tool.serverName} not found.`;

  const res = (await mcpJsonRpc(server, "tools/call", {
    name: tool.rawName,
    arguments: args,
  })) as { content?: Array<{ type?: string; text?: string }> };

  if (Array.isArray(res?.content)) {
    return res.content
      .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n")
      .slice(0, 16_000);
  }
  return JSON.stringify(res).slice(0, 16_000);
}

export function shutdownAllStdioMcp(): void {
  for (const [, session] of stdioSessions.entries()) {
    try {
      session.proc.kill();
    } catch {
      // ignore
    }
  }
  stdioSessions.clear();
}

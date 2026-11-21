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

async function mcpJsonRpc(
  server: McpServerRow,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (server.transport === "stdio") {
    throw new Error(`STDIO MCP transport (${server.name}) requires an HTTP/SSE bridge endpoint in Pandawa v2.`);
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

  // Handle Streamable HTTP SSE or plain JSON-RPC
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

  // Try initialize (optional on stateless servers, ignore failure)
  try {
    await mcpJsonRpc(server, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pandawa", version: "2.0.0" },
    });
  } catch {
    // Some MCP endpoints accept tools/list directly
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
      if (srv.transport === "stdio") return;
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
  const server = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(tool.serverId) as
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
      .slice(0, 12_000);
  }
  return JSON.stringify(res).slice(0, 12_000);
}

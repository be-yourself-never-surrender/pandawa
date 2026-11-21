import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { WORKSPACE_DIR, generateId } from "../config.js";
import { getDb } from "../db/database.js";
import {
  readBrainFile,
  writeBrainFile,
  searchBrainFiles,
  normalizeRelPath,
} from "../brains/brainFs.js";
import type { LLMToolDefinition } from "../providers/llmClient.js";
import type { CompiledAgentRuntime } from "../engine/contextCompiler.js";
import { toolRequiresApproval, requestApproval } from "../engine/approvalManager.js";
import { invokeMcpTool, type DiscoveredMcpTool } from "../mcp/mcpClient.js";

const execAsync = promisify(exec);

export interface ToolExecutionContext {
  runtime: CompiledAgentRuntime;
  teamId?: string;
  sessionId?: string;
  consultDepth?: number;
  consultPeer?: (peerId: string, question: string) => Promise<string>;
  mcpLookup?: Map<string, DiscoveredMcpTool>;
  onEvent?: (event: Record<string, unknown>) => void;
}

interface PandawaTool {
  pack: string;
  definition: LLMToolDefinition;
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<string>;
}

function resolveWorkspacePath(rel: string): string {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.includes("..")) throw new Error("Path traversal not allowed inside workspace_read/write.");
  const full = path.resolve(WORKSPACE_DIR, cleaned);
  const root = path.resolve(WORKSPACE_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Path escapes workspace.");
  }
  return full;
}

const TOOLS: PandawaTool[] = [
  // === BRAIN & SELF-LEARNING PACK ===
  {
    pack: "brain",
    definition: {
      name: "brain_search",
      description: "Full-text search across Pandawa Brain files (soul.md, rules, skills, team docs) and episodic memories.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search across Brain files and memories" },
        },
        required: ["query"],
      },
    },
    execute: async (args) => {
      const q = String(args.query || "").trim();
      if (!q) return "Query is empty.";
      const files = searchBrainFiles(q, 8);
      const db = getDb();
      let mems: Array<{ category: string; content: string }> = [];
      try {
        const safe = q.replace(/["'*^():-]/g, " ").trim().split(/\s+/).filter(Boolean).map((t) => `"${t}"*`).join(" OR ");
        if (safe) {
          mems = db
            .prepare("SELECT category, content FROM memories_fts WHERE memories_fts MATCH ? LIMIT 6")
            .all(safe) as Array<{ category: string; content: string }>;
        }
      } catch {
        // ignore
      }
      return JSON.stringify({ matchingFiles: files, matchingMemories: mems }, null, 2);
    },
  },
  {
    pack: "brain",
    definition: {
      name: "brain_read",
      description: "Read the full contents of a Brain file by relative path (e.g., main-brain/soul.md or teams/pandawa-core/memory.md).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside Brains directory" },
        },
        required: ["path"],
      },
    },
    execute: async (args) => {
      const file = readBrainFile(String(args.path || ""));
      return file.content;
    },
  },
  {
    pack: "brain",
    definition: {
      name: "brain_write",
      description: "Create or update a file inside a writable Brain folder connected to this agent.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside Brains directory" },
          content: { type: "string", description: "Full Markdown or text content to write" },
        },
        required: ["path", "content"],
      },
    },
    execute: async (args, ctx) => {
      const p = normalizeRelPath(String(args.path || ""));
      const content = String(args.content || "");
      const allowed =
        ctx.runtime.writablePrefixes.length === 0 ||
        ctx.runtime.writablePrefixes.some((pref) => p === pref || p.startsWith(`${pref}/`));
      if (!allowed) {
        return `Permission denied: "${p}" is outside this agent's writable Brain mounts (${ctx.runtime.writablePrefixes.join(", ")}).`;
      }
      const res = writeBrainFile(p, content);
      ctx.onEvent?.({ type: "brain_updated", path: p, agent: ctx.runtime.agent.name });
      return `Saved ${res.path} (${res.size} bytes).`;
    },
  },
  {
    pack: "brain",
    definition: {
      name: "remember_fact",
      description: "Store a durable episodic memory in Main Brain or Team Brain so the team remembers it in future sessions.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["team", "main"] },
          category: { type: "string" },
          content: { type: "string" },
          importance: { type: "number" },
        },
        required: ["content"],
      },
    },
    execute: async (args, ctx) => {
      const db = getDb();
      const scope = String(args.scope || "team");
      const targetBrain =
        scope === "main"
          ? ctx.runtime.mainBrains[0]?.id || "brain_main"
          : ctx.runtime.teamBrains[0]?.id || ctx.runtime.mainBrains[0]?.id || "brain_main";
      const id = generateId("mem");
      const category = String(args.category || "lesson");
      const content = String(args.content || "").trim();
      const importance = Math.min(10, Math.max(1, Number(args.importance || 6)));
      db.prepare(
        "INSERT INTO memories (id, brain_id, agent_id, category, content, importance) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, targetBrain, ctx.runtime.agent.id, category, content, importance);
      db.prepare(
        "INSERT INTO memories_fts (memory_id, brain_id, category, content) VALUES (?, ?, ?, ?)"
      ).run(id, targetBrain, category, content);
      ctx.onEvent?.({ type: "memory_saved", id, brainId: targetBrain, content, agent: ctx.runtime.agent.name });
      return `Stored memory ${id} in ${targetBrain}.`;
    },
  },
  {
    pack: "brain",
    definition: {
      name: "learn_skill",
      description: "Distill a repeatable workflow or procedure into a reusable SKILL.md inside the Team or Main Brain.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          instructions: { type: "string" },
          scope: { type: "string", enum: ["team", "main"] },
        },
        required: ["slug", "title", "description", "instructions"],
      },
    },
    execute: async (args, ctx) => {
      const slug = String(args.slug || "new-skill").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
      const scope = String(args.scope || "team");
      const baseFolder =
        scope === "main"
          ? ctx.runtime.mainBrains[0]?.folder_path || "main-brain"
          : ctx.runtime.teamBrains[0]?.folder_path || "main-brain";
      const relPath = `${baseFolder}/skills/${slug}/SKILL.md`;
      const md = `---\nname: ${args.title}\ndescription: ${args.description}\nauthor: ${ctx.runtime.agent.name}\n---\n\n# ${args.title}\n\n${args.instructions}\n`;
      writeBrainFile(relPath, md);
      ctx.onEvent?.({ type: "skill_learned", path: relPath, title: args.title, agent: ctx.runtime.agent.name });
      return `Skill saved to ${relPath}.`;
    },
  },

  // === AGENTIC TEAM BLACKBOARD PACK ===
  {
    pack: "team",
    definition: {
      name: "blackboard_post",
      description: "Post a structured proposal, finding, critique, decision, or artifact onto the shared Team Blackboard.",
      parameters: {
        type: "object",
        properties: {
          entry_type: { type: "string", enum: ["proposal", "finding", "critique", "decision", "artifact", "question"] },
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["entry_type", "title", "content"],
      },
    },
    execute: async (args, ctx) => {
      const db = getDb();
      const id = generateId("bb");
      const teamId = ctx.teamId || "team_pandawa";
      const entryType = String(args.entry_type || "finding");
      const title = String(args.title || "Note");
      const content = String(args.content || "");
      db.prepare(
        `INSERT INTO blackboard_entries (id, team_id, session_id, author_agent_id, author_name, entry_type, title, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, teamId, ctx.sessionId || "", ctx.runtime.agent.id, ctx.runtime.agent.name, entryType, title, content);
      ctx.onEvent?.({
        type: "blackboard_post",
        entry: { id, teamId, authorName: ctx.runtime.agent.name, entryType, title, content },
      });
      return `Posted [${entryType}] "${title}" to Team Blackboard (${id}).`;
    },
  },
  {
    pack: "team",
    definition: {
      name: "blackboard_read",
      description: "Read the latest entries on the shared Team Blackboard from teammates.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
    },
    execute: async (args, ctx) => {
      const db = getDb();
      const teamId = ctx.teamId || "team_pandawa";
      const limit = Math.min(30, Math.max(1, Number(args.limit || 10)));
      const rows = db
        .prepare(
          `SELECT id, author_name, entry_type, title, content, created_at
           FROM blackboard_entries WHERE team_id = ? ORDER BY created_at DESC LIMIT ?`
        )
        .all(teamId, limit);
      return JSON.stringify(rows, null, 2);
    },
  },
  {
    pack: "team",
    definition: {
      name: "consult_teammate",
      description:
        "Directly consult a connected Pandawa peer teammate mid-task to get their specialist advice, review, code check, or research in real time.",
      parameters: {
        type: "object",
        properties: {
          teammate_name: {
            type: "string",
            description: "Name of the connected teammate to consult (e.g., Arjuna, Sadewa, Nakula, Bima, Yudhistira)",
          },
          question: {
            type: "string",
            description: "Focused question or snippet for your teammate to weigh in on",
          },
        },
        required: ["teammate_name", "question"],
      },
    },
    execute: async (args, ctx) => {
      if ((ctx.consultDepth ?? 0) >= 2) {
        return "Max peer consultation depth reached; synthesize with the information already gathered.";
      }
      if (!ctx.consultPeer) {
        return "Peer consultation callback is unavailable in this execution context.";
      }
      const targetName = String(args.teammate_name || "").trim().toLowerCase();
      const question = String(args.question || "").trim();
      if (!targetName || !question) return "Both teammate_name and question are required.";

      const peer = ctx.runtime.peers.find(
        (p) => p.name.toLowerCase() === targetName || p.name.toLowerCase().includes(targetName)
      );
      if (!peer) {
        const names = ctx.runtime.peers.map((p) => p.name).join(", ");
        return `Teammate "${args.teammate_name}" is not connected to your Team Brain. Connected peers: ${names || "none"}.`;
      }

      ctx.onEvent?.({
        type: "peer_consult",
        fromAgent: ctx.runtime.agent.name,
        toAgent: peer.name,
        question: question.slice(0, 200),
      });

      const answer = await ctx.consultPeer(peer.id, question);

      // Log consultation summary to Team Blackboard for full team visibility
      try {
        const db = getDb();
        db.prepare(
          `INSERT INTO blackboard_entries (id, team_id, session_id, author_agent_id, author_name, entry_type, title, content)
           VALUES (?, ?, ?, ?, ?, 'finding', ?, ?)`
        ).run(
          generateId("bb"),
          ctx.teamId || "team_pandawa",
          ctx.sessionId || "",
          peer.id,
          `${ctx.runtime.agent.name} ↔ ${peer.name}`,
          `Peer Consult: ${question.slice(0, 60)}`,
          answer.slice(0, 1200)
        );
      } catch {
        // ignore blackboard log errors
      }

      return `[Response from teammate ${peer.name} (${peer.title})]:\n${answer}`;
    },
  },

  // === WORKSPACE FILE PACK ===
  {
    pack: "workspace",
    definition: {
      name: "workspace_list",
      description: "List files and directories inside the Pandawa agent workspace.",
      parameters: {
        type: "object",
        properties: { subdir: { type: "string" } },
      },
    },
    execute: async (args) => {
      const full = resolveWorkspacePath(String(args.subdir || ""));
      if (!fs.existsSync(full)) return "Directory does not exist.";
      const entries = fs.readdirSync(full, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      }));
      return JSON.stringify(entries, null, 2);
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "workspace_read",
      description: "Read a file inside the Pandawa agent workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    execute: async (args) => {
      const full = resolveWorkspacePath(String(args.path || ""));
      if (!fs.existsSync(full)) return "File not found.";
      return fs.readFileSync(full, "utf8").slice(0, 24_000);
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "workspace_write",
      description: "Write or update a file inside the Pandawa agent workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    execute: async (args) => {
      const full = resolveWorkspacePath(String(args.path || ""));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(args.content || ""), "utf8");
      return `Wrote workspace file ${args.path}.`;
    },
  },

  // === SHELL PACK (Full freedom — governed ONLY by optional User Approval Gate, no hardcoded guardrails) ===
  {
    pack: "shell",
    definition: {
      name: "shell_exec",
      description: "Execute any shell command inside the workspace (or custom cwd). Governed by user's Approval setting.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          cwd: { type: "string", description: "Optional working directory (defaults to workspace)" },
        },
        required: ["command"],
      },
    },
    execute: async (args) => {
      const command = String(args.command || "").trim();
      if (!command) return "Empty command.";
      const cwd = args.cwd ? String(args.cwd) : WORKSPACE_DIR;
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return `STDOUT:\n${stdout.slice(0, 12_000)}\n${stderr ? `STDERR:\n${stderr.slice(0, 4000)}` : ""}`.trim();
      } catch (err: unknown) {
        const e = err as { message?: string; stdout?: string; stderr?: string };
        return `Command exited with error: ${e.message || String(err)}\nSTDOUT: ${(e.stdout || "").slice(0, 4000)}\nSTDERR: ${(e.stderr || "").slice(0, 4000)}`;
      }
    },
  },

  // === WEB & HTTP PACK ===
  {
    pack: "web",
    definition: {
      name: "web_fetch",
      description: "Fetch an HTTP/HTTPS URL and return its readable text or JSON response (up to 16KB).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
          body: { type: "string", description: "Optional JSON body for POST/PUT" },
        },
        required: ["url"],
      },
    },
    execute: async (args) => {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return "Invalid URL: must start with http:// or https://";
      const method = String(args.method || "GET");
      const resp = await fetch(url, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: {
          "User-Agent": "Pandawa-Agentic-Team/2.0",
          ...(args.body ? { "Content-Type": "application/json" } : {}),
        },
        body: args.body ? String(args.body) : undefined,
      });
      const raw = await resp.text();
      const cleaned = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return `HTTP ${resp.status}\n${cleaned.slice(0, 16_000)}`;
    },
  },
];

export function getToolsForPacks(packs: string[], extraMcpTools: LLMToolDefinition[] = []): LLMToolDefinition[] {
  const set = new Set(packs);
  const builtin = TOOLS.filter((t) => set.has(t.pack)).map((t) => t.definition);
  return [...builtin, ...extraMcpTools];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<string> {
  // User-controlled Approval Gate (no hidden guardrails — user chooses Auto or Approve)
  if (toolRequiresApproval(name)) {
    const decision = await requestApproval({
      agentId: ctx.runtime.agent.id,
      agentName: ctx.runtime.agent.name,
      toolName: name,
      args,
      onEvent: ctx.onEvent,
    });
    if (!decision.approved) {
      return `Action rejected by user${decision.reason ? `: ${decision.reason}` : "."}`;
    }
  }

  // Live MCP tool dispatch
  if (ctx.mcpLookup && ctx.mcpLookup.has(name)) {
    try {
      return await invokeMcpTool(ctx.mcpLookup.get(name)!, args);
    } catch (err) {
      return `MCP tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const tool = TOOLS.find((t) => t.definition.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    return `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function listAllToolPacks(): Array<{ pack: string; tools: Array<{ name: string; description: string }> }> {
  const byPack = new Map<string, Array<{ name: string; description: string }>>();
  for (const t of TOOLS) {
    if (!byPack.has(t.pack)) byPack.set(t.pack, []);
    byPack.get(t.pack)!.push({ name: t.definition.name, description: t.definition.description });
  }
  return Array.from(byPack.entries()).map(([pack, tools]) => ({ pack, tools }));
}

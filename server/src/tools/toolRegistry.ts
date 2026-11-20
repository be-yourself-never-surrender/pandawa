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

const execAsync = promisify(exec);

export interface ToolExecutionContext {
  runtime: CompiledAgentRuntime;
  teamId?: string;
  sessionId?: string;
  onEvent?: (event: Record<string, unknown>) => void;
}

interface PandawaTool {
  pack: string;
  definition: LLMToolDefinition;
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<string>;
}

function resolveWorkspacePath(rel: string): string {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.includes("..")) throw new Error("Path traversal blocked.");
  const full = path.resolve(WORKSPACE_DIR, cleaned);
  const root = path.resolve(WORKSPACE_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Path escapes workspace.");
  }
  return full;
}

const BLOCKED_SHELL_PATTERNS = [
  /rm\s+-rf\s+\/(\s|$)/i,
  /mkfs\./i,
  /dd\s+if=/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\};:/,
  /shutdown|reboot|poweroff/i,
];

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
      const p = String(args.path || "");
      const file = readBrainFile(p);
      return file.content;
    },
  },
  {
    pack: "brain",
    definition: {
      name: "brain_write",
      description: "Create or update a file inside a writable Brain folder connected to this agent (e.g., teams/pandawa-core/memory.md).",
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
          scope: { type: "string", enum: ["team", "main"], description: "Which brain layer to store the memory in" },
          category: { type: "string", description: "Category (fact, decision, preference, lesson)" },
          content: { type: "string", description: "Concise memory entry" },
          importance: { type: "number", description: "Importance 1-10 (default 6)" },
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
      description: "Self-improvement loop: distill a repeatable workflow or procedure into a reusable SKILL.md inside the Team or Main Brain.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Short kebab-case skill folder name (e.g., api-security-audit)" },
          title: { type: "string", description: "Human-readable skill title" },
          description: { type: "string", description: "When to use this skill" },
          instructions: { type: "string", description: "Detailed Markdown instructions & steps" },
          scope: { type: "string", enum: ["team", "main"], description: "Store in Team Brain or Main Brain" },
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
      description: "Post a structured proposal, finding, critique, decision, or artifact onto the shared Team Blackboard for peer agents.",
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
        properties: {
          limit: { type: "number", description: "Max entries to fetch (default 10)" },
        },
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

  // === WORKSPACE FILE PACK ===
  {
    pack: "workspace",
    definition: {
      name: "workspace_list",
      description: "List files and directories inside the Pandawa agent workspace.",
      parameters: {
        type: "object",
        properties: {
          subdir: { type: "string", description: "Optional relative subdirectory" },
        },
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
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    execute: async (args) => {
      const full = resolveWorkspacePath(String(args.path || ""));
      if (!fs.existsSync(full)) return "File not found.";
      return fs.readFileSync(full, "utf8").slice(0, 20_000);
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "workspace_write",
      description: "Write or update a file inside the Pandawa agent workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
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

  // === SHELL PACK ===
  {
    pack: "shell",
    definition: {
      name: "shell_exec",
      description: "Execute a shell command inside the Pandawa workspace directory (timeout 20s).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
    execute: async (args) => {
      const command = String(args.command || "").trim();
      if (!command) return "Empty command.";
      for (const pat of BLOCKED_SHELL_PATTERNS) {
        if (pat.test(command)) {
          return "Blocked dangerous command by Pandawa safety policy.";
        }
      }
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: WORKSPACE_DIR,
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
        });
        return `STDOUT:\n${stdout.slice(0, 8000)}\n${stderr ? `STDERR:\n${stderr.slice(0, 4000)}` : ""}`.trim();
      } catch (err: unknown) {
        const e = err as { message?: string; stdout?: string; stderr?: string };
        return `Command failed: ${e.message || String(err)}\nSTDOUT: ${(e.stdout || "").slice(0, 2000)}\nSTDERR: ${(e.stderr || "").slice(0, 2000)}`;
      }
    },
  },

  // === WEB & HTTP PACK ===
  {
    pack: "web",
    definition: {
      name: "web_fetch",
      description: "Fetch an HTTP/HTTPS URL and return its readable text or JSON response (up to 12KB).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full http:// or https:// URL" },
          method: { type: "string", enum: ["GET", "POST"], description: "HTTP method (default GET)" },
        },
        required: ["url"],
      },
    },
    execute: async (args) => {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return "Invalid URL: must start with http:// or https://";
      const resp = await fetch(url, {
        method: String(args.method || "GET"),
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "Pandawa-Agentic-Team/1.0" },
      });
      const raw = await resp.text();
      const cleaned = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return `HTTP ${resp.status}\n${cleaned.slice(0, 12_000)}`;
    },
  },
];

export function getToolsForPacks(packs: string[]): LLMToolDefinition[] {
  const set = new Set(packs);
  return TOOLS.filter((t) => set.has(t.pack)).map((t) => t.definition);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<string> {
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

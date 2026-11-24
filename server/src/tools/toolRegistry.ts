import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  generateId,
  resolveTeamWorkspaceDir,
  resolveTeamCheckpointsDir,
  resolveScopedCwd,
  sanitizeWorkspaceSegment,
} from "../config.js";
import { getDb } from "../db/database.js";
import {
  readBrainFile,
  writeBrainFile,
  listBrainTree,
  searchBrainFiles,
  normalizeRelPath,
} from "../brains/brainFs.js";
import type { LLMImageAttachment, LLMToolDefinition } from "../providers/llmClient.js";
import type { CompiledAgentRuntime } from "../engine/contextCompiler.js";
import { toolRequiresApproval, requestApproval } from "../engine/approvalManager.js";
import { invokeMcpTool, type DiscoveredMcpTool } from "../mcp/mcpClient.js";
import {
  startManagedProcess,
  listManagedProcesses,
  getManagedProcessLogs,
  killManagedProcess,
} from "./processManager.js";
import {
  listTerminals,
  openTerminal,
  execInTerminal,
  sendKeysToTerminal,
  readTerminal,
  closeTerminal,
} from "./terminalManager.js";
import { runPythonWorker } from "./pythonWorker.js";
import { assertSafeOutboundUrl } from "./netGuard.js";
import { execSandboxedCommand } from "./sandboxRunner.js";
import { semanticBrainSearch } from "../brains/semanticMemory.js";
import { getHeartbeatConfig, updateHeartbeatConfig } from "../engine/heartbeatDaemon.js";
import { dispatchChannelFile, dispatchChannelNotification } from "../channels/channelManager.js";

const execAsync = promisify(exec);

// Enforced cross-session workspace & brain file lock (prevents concurrent lost updates)
const FILE_LOCK_TTL_MS = 90_000;
const workspaceFileLocks = new Map<string, { sessionId: string; owner: string; updatedAt: number }>();

function normalizeLockPath(relPath: string): string {
  const cleaned = relPath.replace(/\\/g, "/");
  const norm = path.posix.normalize(cleaned).replace(/^(\.\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return norm || ".";
}

function makeScreenshotRelPath(prefix: string): string {
  return `screenshots/${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.png`;
}

export function markTeamMessageRead(id: string, currentReadByJson: string, readerName: string): string {
  let readers: string[] = [];
  try {
    const parsed = JSON.parse(currentReadByJson || "[]");
    if (Array.isArray(parsed)) readers = parsed.map(String);
  } catch {
    readers = [];
  }
  const cleanReader = readerName.trim();
  if (!cleanReader || readers.some((r) => r.toLowerCase() === cleanReader.toLowerCase())) {
    return JSON.stringify(readers);
  }
  readers.push(cleanReader);
  const nextJson = JSON.stringify(readers);
  try {
    getDb().prepare("UPDATE team_messages SET read_by_json = ? WHERE id = ?").run(nextJson, id);
  } catch {
    // ignore
  }
  return nextJson;
}

export function clearSessionFileLocks(sessionId: string): void {
  if (!sessionId) return;
  for (const [key, val] of workspaceFileLocks.entries()) {
    if (val.sessionId === sessionId) workspaceFileLocks.delete(key);
  }
}

export function releaseAgentFileLocks(sessionId: string | undefined, agentName: string): void {
  const sid = sessionId || "__nosession__";
  for (const [key, val] of workspaceFileLocks.entries()) {
    if (val.sessionId === sid && val.owner === agentName) {
      workspaceFileLocks.delete(key);
    }
  }
}

export function acquireFileLock(
  sessionId: string | undefined,
  relPath: string,
  agentName: string,
  scope: "workspace" | "brain" = "workspace",
  teamId?: string
): { acquired: boolean; holder?: string } {
  const sid = sessionId || "__nosession__";
  const key =
    scope === "workspace"
      ? `workspace::${teamId ? sanitizeWorkspaceSegment(teamId) : "__global__"}::${normalizeLockPath(relPath)}`
      : `brain::${normalizeLockPath(relPath)}`;
  const now = Date.now();
  const existing = workspaceFileLocks.get(key);
  if (existing && now - existing.updatedAt < FILE_LOCK_TTL_MS && (existing.sessionId !== sid || existing.owner !== agentName)) {
    const holder =
      existing.sessionId === sid ? existing.owner : `${existing.owner} (session ${existing.sessionId})`;
    return { acquired: false, holder };
  }
  workspaceFileLocks.set(key, { sessionId: sid, owner: agentName, updatedAt: now });
  return { acquired: true };
}

function atomicWriteFileSync(fullPath: string, content: string): void {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const tmpPath = `${fullPath}.pdw_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, fullPath);
}

export interface ToolExecutionContext {
  runtime: CompiledAgentRuntime;
  teamId?: string;
  sessionId?: string;
  channelId?: string;
  chatId?: string;
  consultDepth?: number;
  consultPeer?: (peerId: string, question: string) => Promise<string>;
  onImageCaptured?: (img: LLMImageAttachment) => void;
  mcpLookup?: Map<string, DiscoveredMcpTool>;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
}

function resolveWorkspaceTeamId(ctx: ToolExecutionContext): string | undefined {
  if (ctx.teamId && ctx.teamId.trim()) return ctx.teamId.trim();
  const tbId = ctx.runtime.teamBrains[0]?.id;
  if (tbId) {
    const db = getDb();
    const linked = db
      .prepare("SELECT id FROM teams WHERE team_brain_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(tbId) as { id?: string } | undefined;
    if (linked?.id) return linked.id;
  }
  return undefined;
}

function resolveToolTeamId(ctx: ToolExecutionContext): string | null {
  if (ctx.teamId && ctx.teamId.trim()) return ctx.teamId.trim();
  const db = getDb();
  const tbId = ctx.runtime.teamBrains[0]?.id;
  if (tbId) {
    const linked = db
      .prepare("SELECT id FROM teams WHERE team_brain_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(tbId) as { id?: string } | undefined;
    if (linked?.id) return linked.id;
  }
  const firstEnabled = db
    .prepare("SELECT id FROM teams WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1")
    .get() as { id?: string } | undefined;
  if (firstEnabled?.id) return firstEnabled.id;
  const anyTeam = db.prepare("SELECT id FROM teams ORDER BY created_at ASC LIMIT 1").get() as { id?: string } | undefined;
  return anyTeam?.id || null;
}

function resolveToolBrain(
  scope: "main" | "team",
  ctx: ToolExecutionContext
): { id: string; folderPath: string } | null {
  const db = getDb();
  if (scope === "main") {
    if (ctx.runtime.mainBrains[0]) {
      return { id: ctx.runtime.mainBrains[0].id, folderPath: ctx.runtime.mainBrains[0].folder_path };
    }
    const row = db
      .prepare("SELECT id, folder_path FROM brains WHERE layer = 'main' ORDER BY created_at ASC LIMIT 1")
      .get() as { id?: string; folder_path?: string } | undefined;
    if (row?.id && row.folder_path) return { id: row.id, folderPath: row.folder_path };
  } else {
    if (ctx.runtime.teamBrains[0]) {
      return { id: ctx.runtime.teamBrains[0].id, folderPath: ctx.runtime.teamBrains[0].folder_path };
    }
    const tid = resolveToolTeamId(ctx);
    if (tid) {
      const row = db
        .prepare(
          "SELECT b.id, b.folder_path FROM teams t JOIN brains b ON t.team_brain_id = b.id WHERE t.id = ? LIMIT 1"
        )
        .get(tid) as { id?: string; folder_path?: string } | undefined;
      if (row?.id && row.folder_path) return { id: row.id, folderPath: row.folder_path };
    }
    if (ctx.runtime.mainBrains[0]) {
      return { id: ctx.runtime.mainBrains[0].id, folderPath: ctx.runtime.mainBrains[0].folder_path };
    }
  }
  const anyBrain = db
    .prepare("SELECT id, folder_path FROM brains ORDER BY created_at ASC LIMIT 1")
    .get() as { id?: string; folder_path?: string } | undefined;
  if (anyBrain?.id && anyBrain.folder_path) return { id: anyBrain.id, folderPath: anyBrain.folder_path };
  return null;
}

interface PandawaTool {
  pack: string;
  definition: LLMToolDefinition;
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<string>;
}

function resolveWorkspacePath(rel: string, teamId?: string | null): string {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.includes("..")) throw new Error("Path traversal not allowed inside workspace tools.");
  const root = path.resolve(resolveTeamWorkspaceDir(teamId));
  const full = path.resolve(root, cleaned);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Path escapes workspace.");
  }
  return full;
}

function copyDirRecursive(src: string, dst: string): number {
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) count += copyDirRecursive(s, d);
    else {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

const TOOLS: PandawaTool[] = [
  // =============================================
  // PACK 1: BRAIN, MEMORY & CLOSED LEARNING LOOP
  // =============================================
  {
    pack: "brain",
    definition: {
      name: "brain_search",
      description: "Full-text search across Pandawa Brain files (soul.md, rules, skills, team docs) and episodic memories.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Keywords to search across Brain files and memories" } },
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
      name: "brain_list",
      description: "List the directory structure of all Pandawa Brain folders and files.",
      parameters: {
        type: "object",
        properties: { subdir: { type: "string", description: "Optional subfolder (e.g. main-brain or teams)" } },
      },
    },
    execute: async (args) => {
      return JSON.stringify(listBrainTree(String(args.subdir || "")), null, 2).slice(0, 12_000);
    },
  },
  {
    pack: "brain",
    definition: {
      name: "brain_read",
      description: "Read the full contents of a Brain file by relative path (e.g. main-brain/soul.md).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    execute: async (args) => readBrainFile(String(args.path || "")).content,
  },
  {
    pack: "brain",
    definition: {
      name: "brain_write",
      description: "Create or update a file inside a writable Brain folder connected to this agent.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
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
        return `Permission denied: "${p}" is outside writable Brain mounts (${ctx.runtime.writablePrefixes.join(", ")}).`;
      }
      const lock = acquireFileLock(ctx.sessionId, p, ctx.runtime.agent.name, "brain");
      if (!lock.acquired) {
        return `LOCK_CONFLICT: Brain file "${p}" is currently actively locked by "${lock.holder}". Wait or coordinate via team_message before overwriting.`;
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
      description: "Store a durable episodic memory in Main Brain or Team Brain so the team remembers it across sessions.",
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
      const scope = args.scope === "main" ? "main" : "team";
      const target = resolveToolBrain(scope, ctx);
      if (!target) {
        return "Error: No Brain exists in database to store episodic memory.";
      }
      const targetBrain = target.id;
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
      description: "Self-improvement loop: save or refine a repeatable workflow into a reusable SKILL.md inside Team or Main Brain.",
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
      const scope = args.scope === "main" ? "main" : "team";
      const target = resolveToolBrain(scope, ctx);
      if (!target) {
        return "Error: No Brain exists in database to save skill.";
      }
      const relPath = `${target.folderPath}/skills/${slug}/SKILL.md`;
      const md = `---\nname: ${args.title}\ndescription: ${args.description}\nauthor: ${ctx.runtime.agent.name}\n---\n\n# ${args.title}\n\n${args.instructions}\n`;
      writeBrainFile(relPath, md);
      ctx.onEvent?.({ type: "skill_learned", path: relPath, title: args.title, agent: ctx.runtime.agent.name });
      return `Skill saved to ${relPath}.`;
    },
  },
  {
    pack: "brain",
    definition: {
      name: "session_search",
      description: "Search across ALL past Pandawa conversations and team mission transcripts via SQLite FTS5 for cross-session recall.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search across past chat sessions" },
          limit: { type: "number", description: "Max matching excerpts (default 8)" },
        },
        required: ["query"],
      },
    },
    execute: async (args) => {
      const q = String(args.query || "").trim();
      if (!q) return "Empty query.";
      const limit = Math.min(20, Math.max(1, Number(args.limit || 8)));
      const db = getDb();
      const safe = q.replace(/["'*^():-]/g, " ").trim().split(/\s+/).filter(Boolean).map((t) => `"${t}"*`).join(" OR ");
      if (!safe) return "No valid search tokens.";
      try {
        const rows = db
          .prepare(
            `SELECT session_id, agent_name, snippet(messages_fts, 3, '[[', ']]', '...', 28) as excerpt
             FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?`
          )
          .all(safe, limit);
        return JSON.stringify({ query: q, matches: rows }, null, 2);
      } catch {
        // Fallback LIKE scan on messages
        const rows = db
          .prepare(
            `SELECT session_id, agent_name, substr(content, 1, 240) as excerpt
             FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?`
          )
          .all(`%${q}%`, limit);
        return JSON.stringify({ query: q, matches: rows }, null, 2);
      }
    },
  },
  {
    pack: "brain",
    definition: {
      name: "brain_semantic_search",
      description:
        "Hybrid semantic vector + TF-IDF + [[wikilink]] conceptual search across ALL Brain files, SKILL.md playbooks, episodic memories, and past sessions (finds related concepts even when exact keywords differ).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language question or concept to search semantically" },
          scope: {
            type: "string",
            enum: ["all", "brain_file", "memory", "session"],
            description: "Restrict search scope (default all)",
          },
          limit: { type: "number", description: "Max ranked matches (default 8)" },
        },
        required: ["query"],
      },
    },
    execute: async (args) => {
      const q = String(args.query || "").trim();
      if (!q) return "Query cannot be empty.";
      const scope = String(args.scope || "all") as "all" | "brain_file" | "memory" | "session";
      const limit = Math.min(20, Math.max(1, Number(args.limit || 8)));
      const res = await semanticBrainSearch(q, { scope, limit });
      return JSON.stringify(res, null, 2);
    },
  },

  // =============================================
  // PACK 2: AGENTIC TEAM (BLACKBOARD, PEER CONSULT & TASKS)
  // =============================================
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
      const teamId = resolveToolTeamId(ctx);
      if (!teamId) return "Error: No team exists in database for Team Blackboard.";
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
      const teamId = resolveToolTeamId(ctx);
      if (!teamId) return JSON.stringify([]);
      const limit = Math.min(30, Math.max(1, Number(args.limit || 10)));
      const rows = ctx.sessionId
        ? db
            .prepare(
              `SELECT id, author_name, entry_type, title, content, created_at
               FROM blackboard_entries
               WHERE team_id = ? AND (session_id = ? OR session_id = '')
               ORDER BY created_at DESC LIMIT ?`
            )
            .all(teamId, ctx.sessionId, limit)
        : db
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
      description: "Directly consult a connected Pandawa peer teammate mid-task for specialist advice, code review, or research.",
      parameters: {
        type: "object",
        properties: {
          teammate_name: { type: "string" },
          question: { type: "string" },
        },
        required: ["teammate_name", "question"],
      },
    },
    execute: async (args, ctx) => {
      if ((ctx.consultDepth ?? 0) >= 2) {
        return "Max peer consultation depth reached; synthesize with the information already gathered.";
      }
      if (!ctx.consultPeer) return "Peer consultation callback is unavailable.";
      const targetName = String(args.teammate_name || "").trim().toLowerCase();
      const question = String(args.question || "").trim();
      if (!targetName || !question) return "Both teammate_name and question are required.";

      const peer =
        ctx.runtime.peers.find((p) => p.name.toLowerCase() === targetName) ||
        ctx.runtime.peers.find((p) => p.name.toLowerCase().includes(targetName)) ||
        ctx.runtime.peers.find((p) => p.title.toLowerCase().includes(targetName));
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
      const consultTeamId = resolveToolTeamId(ctx);
      if (consultTeamId) {
        try {
          const db = getDb();
          db.prepare(
            `INSERT INTO blackboard_entries (id, team_id, session_id, author_agent_id, author_name, entry_type, title, content)
             VALUES (?, ?, ?, ?, ?, 'finding', ?, ?)`
          ).run(
            generateId("bb"),
            consultTeamId,
            ctx.sessionId || "",
            peer.id,
            `${ctx.runtime.agent.name} ↔ ${peer.name}`,
            `Peer Consult: ${question.slice(0, 60)}`,
            answer.slice(0, 1200)
          );

          const participantsJson = JSON.stringify([ctx.runtime.agent.name, peer.name]);
          const qId = generateId("tmsg");
          const qText = question.slice(0, 1000);
          db.prepare(
            `INSERT INTO team_messages (id, team_id, session_id, from_agent, to_agent, kind, content, read_by_json)
             VALUES (?, ?, ?, ?, ?, 'question', ?, ?)`
          ).run(qId, consultTeamId, ctx.sessionId || "", ctx.runtime.agent.name, peer.name, qText, participantsJson);
          ctx.onEvent?.({
            type: "team_message",
            id: qId,
            teamId: consultTeamId,
            fromAgent: ctx.runtime.agent.name,
            toAgent: peer.name,
            kind: "question",
            content: qText,
          });

          const aId = generateId("tmsg");
          const aText = answer.slice(0, 1200);
          db.prepare(
            `INSERT INTO team_messages (id, team_id, session_id, from_agent, to_agent, kind, content, read_by_json)
             VALUES (?, ?, ?, ?, ?, 'result', ?, ?)`
          ).run(aId, consultTeamId, ctx.sessionId || "", peer.name, ctx.runtime.agent.name, aText, participantsJson);
          ctx.onEvent?.({
            type: "team_message",
            id: aId,
            teamId: consultTeamId,
            fromAgent: peer.name,
            toAgent: ctx.runtime.agent.name,
            kind: "result",
            content: aText,
          });
        } catch {
          // ignore
        }
      }
      return `[Response from teammate ${peer.name} (${peer.title})]:\n${answer}`;
    },
  },
  {
    pack: "team",
    definition: {
      name: "team_todo_manage",
      description: "Manage the shared Team Task Board (add, update, complete, or list tasks coordinated across teammates).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "update", "delete"] },
          task_id: { type: "string" },
          title: { type: "string" },
          owner_agent: { type: "string" },
          status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
          notes: { type: "string" },
        },
        required: ["action"],
      },
    },
    execute: async (args, ctx) => {
      const db = getDb();
      const teamId = resolveToolTeamId(ctx);
      if (!teamId) return "Error: No team exists in database for Team Task Board.";
      const action = String(args.action || "list");

      if (action === "list") {
        const rows = ctx.sessionId
          ? db
              .prepare(
                `SELECT * FROM team_tasks
                 WHERE team_id = ? AND (session_id = ? OR session_id = '')
                 ORDER BY updated_at DESC LIMIT 30`
              )
              .all(teamId, ctx.sessionId)
          : db.prepare("SELECT * FROM team_tasks WHERE team_id = ? ORDER BY updated_at DESC LIMIT 30").all(teamId);
        return JSON.stringify(rows, null, 2);
      }
      if (action === "add") {
        const id = generateId("tsk");
        const title = String(args.title || "Untitled Task");
        const owner = String(args.owner_agent || ctx.runtime.agent.name);
        const status = String(args.status || "todo");
        const notes = String(args.notes || "");
        db.prepare(
          `INSERT INTO team_tasks (id, team_id, session_id, title, owner_agent, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, teamId, ctx.sessionId || "", title, owner, status, notes);
        ctx.onEvent?.({ type: "team_task_updated", teamId, action: "add", id, title });
        return `Added task ${id}: "${title}" (owner: ${owner}, status: ${status}).`;
      }
      if (action === "update" && args.task_id) {
        const cur = db
          .prepare("SELECT * FROM team_tasks WHERE id = ? AND team_id = ?")
          .get(String(args.task_id), teamId) as Record<string, unknown> | undefined;
        if (!cur) return `Task ${args.task_id} not found.`;
        db.prepare(
          `UPDATE team_tasks SET title=?, owner_agent=?, status=?, notes=?, updated_at=datetime('now') WHERE id=? AND team_id=?`
        ).run(
          args.title !== undefined ? String(args.title) : String(cur.title),
          args.owner_agent !== undefined ? String(args.owner_agent) : String(cur.owner_agent),
          args.status !== undefined ? String(args.status) : String(cur.status),
          args.notes !== undefined ? String(args.notes) : String(cur.notes),
          String(args.task_id),
          teamId
        );
        ctx.onEvent?.({ type: "team_task_updated", teamId, action: "update", id: String(args.task_id) });
        return `Updated task ${args.task_id}.`;
      }
      if (action === "delete" && args.task_id) {
        db.prepare("DELETE FROM team_tasks WHERE id = ? AND team_id = ?").run(String(args.task_id), teamId);
        return `Deleted task ${args.task_id}.`;
      }
      return "Invalid team_todo_manage parameters.";
    },
  },
  {
    pack: "team",
    definition: {
      name: "team_message",
      description:
        "Send a live direct message to a specific Pandawa teammate (or 'all' for broadcast) while working in parallel—e.g. sharing an API port, terminal name, file path, or blocker.",
      parameters: {
        type: "object",
        properties: {
          to_agent: { type: "string", description: "Target teammate name (or 'all' to broadcast)" },
          message: { type: "string", description: "Concise message for your teammate(s)" },
          kind: { type: "string", enum: ["update", "handoff", "question", "alert", "result"] },
        },
        required: ["to_agent", "message"],
      },
    },
    execute: async (args, ctx) => {
      const db = getDb();
      const id = generateId("tmsg");
      const teamId = resolveToolTeamId(ctx);
      if (!teamId) return "Error: No team exists in database for team messages.";
      const toAgent = String(args.to_agent || "all").trim();
      const kind = String(args.kind || "update");
      const content = String(args.message || "").trim();
      if (!content) return "Message content cannot be empty.";
      db.prepare(
        `INSERT INTO team_messages (id, team_id, session_id, from_agent, to_agent, kind, content)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, teamId, ctx.sessionId || "", ctx.runtime.agent.name, toAgent, kind, content);
      ctx.onEvent?.({
        type: "team_message",
        id,
        teamId,
        fromAgent: ctx.runtime.agent.name,
        toAgent,
        kind,
        content,
      });
      return `Sent [${kind}] message to ${toAgent} (${id}).`;
    },
  },
  {
    pack: "team",
    definition: {
      name: "team_inbox",
      description: "Check live messages sent by teammates during this mission (ports, terminal sessions, handoffs, blockers).",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max recent messages (default 15)" },
        },
      },
    },
    execute: async (args, ctx) => {
      const db = getDb();
      const teamId = resolveToolTeamId(ctx);
      if (!teamId) return JSON.stringify({ agent: ctx.runtime.agent.name, messages: [] });
      const limit = Math.min(40, Math.max(1, Number(args.limit || 15)));
      const rows = (
        ctx.sessionId
          ? db
              .prepare(
                `SELECT id, from_agent, to_agent, kind, content, read_by_json, created_at
                 FROM team_messages
                 WHERE team_id = ? AND (session_id = ? OR session_id = '')
                 ORDER BY created_at DESC LIMIT ?`
              )
              .all(teamId, ctx.sessionId, limit)
          : db
              .prepare(
                `SELECT id, from_agent, to_agent, kind, content, read_by_json, created_at
                 FROM team_messages WHERE team_id = ? ORDER BY created_at DESC LIMIT ?`
              )
              .all(teamId, limit)
      ) as Array<{
        id: string;
        from_agent: string;
        to_agent: string;
        kind: string;
        content: string;
        read_by_json: string;
        created_at: string;
      }>;

      const myName = ctx.runtime.agent.name.toLowerCase();
      for (const r of rows) {
        if (r.from_agent.toLowerCase() !== myName) {
          r.read_by_json = markTeamMessageRead(r.id, r.read_by_json, ctx.runtime.agent.name);
        }
      }
      return JSON.stringify({ agent: ctx.runtime.agent.name, messages: rows.reverse() }, null, 2);
    },
  },

  // =============================================
  // PACK 3: WORKSPACE ENGINEERING, PATCH, GREP & CHECKPOINTS
  // =============================================
  {
    pack: "workspace",
    definition: {
      name: "workspace_list",
      description: "List files and directories inside the Pandawa workspace.",
      parameters: { type: "object", properties: { subdir: { type: "string" } } },
    },
    execute: async (args, ctx) => {
      const full = resolveWorkspacePath(String(args.subdir || ""), resolveWorkspaceTeamId(ctx));
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
      description: "Read a file inside the Pandawa workspace (optional line range).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "number" },
          end_line: { type: "number" },
        },
        required: ["path"],
      },
    },
    execute: async (args, ctx) => {
      const full = resolveWorkspacePath(String(args.path || ""), resolveWorkspaceTeamId(ctx));
      if (!fs.existsSync(full)) return "File not found.";
      const raw = fs.readFileSync(full, "utf8");
      if (args.start_line || args.end_line) {
        const lines = raw.split(/\r?\n/);
        const s = Math.max(1, Number(args.start_line || 1));
        const e = Math.min(lines.length, Number(args.end_line || lines.length));
        return lines
          .slice(s - 1, e)
          .map((l, idx) => `${s + idx}: ${l}`)
          .join("\n")
          .slice(0, 24_000);
      }
      return raw.slice(0, 24_000);
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "workspace_write",
      description: "Create or overwrite a file inside the Pandawa workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    execute: async (args, ctx) => {
      const rel = String(args.path || "");
      const wsTeamId = resolveWorkspaceTeamId(ctx);
      const full = resolveWorkspacePath(rel, wsTeamId);
      const lock = acquireFileLock(ctx.sessionId, rel, ctx.runtime.agent.name, "workspace", wsTeamId);
      if (!lock.acquired) {
        return `LOCK_CONFLICT: File "${rel}" is currently actively locked by teammate "${lock.holder}". Do NOT overwrite their work—coordinate via team_message or wait for them to finish, then workspace_read before patching.`;
      }
      atomicWriteFileSync(full, String(args.content || ""));
      return `Wrote workspace file ${args.path} atomically (lock held by ${ctx.runtime.agent.name}).`;
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "workspace_patch",
      description: "Surgical search-and-replace edit on an existing file inside the workspace without rewriting the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          target: { type: "string", description: "Exact string block to find" },
          replacement: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
        },
        required: ["path", "target", "replacement"],
      },
    },
    execute: async (args, ctx) => {
      const rel = String(args.path || "");
      const wsTeamId = resolveWorkspaceTeamId(ctx);
      const full = resolveWorkspacePath(rel, wsTeamId);
      if (!fs.existsSync(full)) return `File not found: ${args.path}`;
      const lock = acquireFileLock(ctx.sessionId, rel, ctx.runtime.agent.name, "workspace", wsTeamId);
      if (!lock.acquired) {
        return `LOCK_CONFLICT: File "${rel}" is currently actively locked by teammate "${lock.holder}". Coordinate via team_message and retry after their turn completes.`;
      }
      const orig = fs.readFileSync(full, "utf8");
      const target = String(args.target || "");
      const replacement = String(args.replacement ?? "");
      if (!target || !orig.includes(target)) {
        return `Target text not found in ${args.path}. Read the file first to verify exact whitespace.`;
      }
      const next = args.replace_all ? orig.split(target).join(replacement) : orig.replace(target, replacement);
      atomicWriteFileSync(full, next);
      return `Patched ${args.path} atomically (lock held by ${ctx.runtime.agent.name}).`;
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "workspace_grep",
      description: "Recursively search files in the Pandawa workspace by keyword or regular expression.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex pattern to search" },
          subdir: { type: "string", description: "Optional subfolder inside workspace" },
        },
        required: ["pattern"],
      },
    },
    execute: async (args, ctx) => {
      const wsTeamId = resolveWorkspaceTeamId(ctx);
      const wsRoot = resolveTeamWorkspaceDir(wsTeamId);
      const base = resolveWorkspacePath(String(args.subdir || ""), wsTeamId);
      if (!fs.existsSync(base)) return "Directory does not exist.";
      const regex = new RegExp(String(args.pattern || ""), "i");
      const hits: Array<{ file: string; line: number; text: string }> = [];

      function walk(dir: string) {
        if (hits.length >= 60) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (hits.length >= 60) return;
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            try {
              const stat = fs.statSync(full);
              if (stat.size > 512_000) continue;
              const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
              lines.forEach((l, i) => {
                if (hits.length < 60 && regex.test(l)) {
                  hits.push({
                    file: path.relative(wsRoot, full).replace(/\\/g, "/"),
                    line: i + 1,
                    text: l.trim().slice(0, 180),
                  });
                }
              });
            } catch {
              // ignore binary
            }
          }
        }
      }
      walk(base);
      return JSON.stringify({ pattern: args.pattern, count: hits.length, hits }, null, 2);
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "checkpoint_create",
      description: "Snapshot the current Pandawa workspace into a named checkpoint so changes can be rolled back anytime.",
      parameters: {
        type: "object",
        properties: { label: { type: "string", description: "Short checkpoint label" } },
      },
    },
    execute: async (args, ctx) => {
      const wsTeamId = resolveWorkspaceTeamId(ctx);
      const wsRoot = resolveTeamWorkspaceDir(wsTeamId);
      const cpDir = resolveTeamCheckpointsDir(wsTeamId);
      const id = `cp_${Date.now()}_${String(args.label || "snap").toLowerCase().replace(/[^a-z0-9-_]/g, "-")}`;
      const dst = path.join(cpDir, id);
      const files = copyDirRecursive(wsRoot, dst);
      return `Created workspace checkpoint "${id}" (${files} files snapshotted).`;
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "checkpoint_rollback",
      description: "List available checkpoints or roll the workspace back to a previous checkpoint ID.",
      parameters: {
        type: "object",
        properties: {
          checkpoint_id: { type: "string", description: "Checkpoint ID to restore (omit to list checkpoints)" },
        },
      },
    },
    execute: async (args, ctx) => {
      const wsTeamId = resolveWorkspaceTeamId(ctx);
      const wsRoot = resolveTeamWorkspaceDir(wsTeamId);
      const cpDir = resolveTeamCheckpointsDir(wsTeamId);
      fs.mkdirSync(cpDir, { recursive: true });
      const cid = String(args.checkpoint_id || "").trim();
      if (!cid) {
        const list = fs.readdirSync(cpDir).sort().reverse();
        return JSON.stringify({ checkpoints: list }, null, 2);
      }
      if (cid.includes("..") || cid.includes("/") || cid.includes("\\")) return "Invalid checkpoint ID.";
      const src = path.join(cpDir, cid);
      if (!fs.existsSync(src)) return `Checkpoint not found: ${cid}`;
      const restored = copyDirRecursive(src, wsRoot);
      return `Restored workspace from checkpoint "${cid}" (${restored} files).`;
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "doc_read",
      description:
        "Extract clean readable text from PDF, DOCX, XLSX/Excel, CSV, or text files inside the workspace using Pandawa's Python Document Worker.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path inside workspace (e.g. report.pdf, sheet.xlsx)" },
          max_chars: { type: "number", description: "Max characters to extract (default 24000)" },
        },
        required: ["path"],
      },
    },
    execute: async (args, ctx) => {
      const full = resolveWorkspacePath(String(args.path || ""), resolveWorkspaceTeamId(ctx));
      const res = await runPythonWorker("doc_read", {
        path: full,
        maxChars: Number(args.max_chars || 24000),
      });
      return JSON.stringify(res, null, 2);
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "vision_inspect",
      description:
        "Load an image file (PNG, JPG, WEBP) from the workspace directly into your Multimodal Vision context so you can visually inspect screenshots, charts, or UI errors.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to PNG/JPG/WEBP image inside workspace" },
        },
        required: ["path"],
      },
    },
    execute: async (args, ctx) => {
      const rel = String(args.path || "");
      const full = resolveWorkspacePath(rel, resolveWorkspaceTeamId(ctx));
      if (!fs.existsSync(full)) return `Image file not found: ${rel}`;
      const stat = fs.statSync(full);
      if (stat.size > 6 * 1024 * 1024) return `Image too large (${Math.round(stat.size / 1024)} KB, max 6 MB).`;
      const ext = path.extname(full).toLowerCase();
      const mimeType =
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
      const base64 = fs.readFileSync(full).toString("base64");
      ctx.onImageCaptured?.({ mimeType, base64, name: rel });
      return `Attached visual image "${rel}" (${mimeType}, ${Math.round(stat.size / 1024)} KB) into your next reasoning step.`;
    },
  },
  {
    pack: "workspace",
    definition: {
      name: "channel_send_file",
      description:
        "Send a real file or image (report, script, screenshot, PDF, archive) from this team's workspace back to the active Telegram, WhatsApp, or Discord channel conversation.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path inside the team workspace" },
          caption: { type: "string", description: "Optional short caption for the attachment" },
          channel_name_or_id: {
            type: "string",
            description: "Optional channel ID or partial name (defaults to originating chat channel)",
          },
        },
        required: ["path"],
      },
    },
    execute: async (args, ctx) => {
      const rel = String(args.path || "");
      const fullPath = resolveWorkspacePath(rel, resolveWorkspaceTeamId(ctx));
      if (!fs.existsSync(fullPath)) return `File not found in workspace: ${rel}`;

      const db = getDb();
      let targetChannelId = ctx.channelId || "";
      const requested = String(args.channel_name_or_id || "").trim().toLowerCase();
      if (requested) {
        const rows = db.prepare("SELECT id, name FROM channels WHERE enabled = 1").all() as Array<{
          id: string;
          name: string;
        }>;
        const found = rows.find((c) => c.id.toLowerCase() === requested || c.name.toLowerCase().includes(requested));
        if (!found) return `Channel "${args.channel_name_or_id}" not found or disabled.`;
        targetChannelId = found.id;
      } else if (!targetChannelId) {
        const first = db
          .prepare(
            "SELECT id FROM channels WHERE enabled = 1 AND type IN ('telegram','whatsapp_qr','whatsapp_cloud','discord') ORDER BY created_at ASC LIMIT 1"
          )
          .get() as { id?: string } | undefined;
        targetChannelId = first?.id || "";
      }
      if (!targetChannelId) return "No enabled media-capable channel configured.";

      const chatOverride = !requested || requested === ctx.channelId ? ctx.chatId : undefined;
      const res = await dispatchChannelFile(
        targetChannelId,
        fullPath,
        args.caption ? String(args.caption) : undefined,
        chatOverride
      );
      return JSON.stringify({ path: rel, channelId: targetChannelId, ...res }, null, 2);
    },
  },

  // =============================================
  // PACK 4: SHELL, CODE EXECUTION & BACKGROUND PROCESSES
  // =============================================
  {
    pack: "shell",
    definition: {
      name: "shell_exec",
      description: "Execute any shell command (full freedom — governed solely by user's Approval setting).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
      },
    },
    execute: async (args, ctx) => {
      const command = String(args.command || "").trim();
      if (!command) return "Empty command.";
      const wsTeamId = resolveWorkspaceTeamId(ctx);
      const cwd = resolveScopedCwd(args.cwd ? String(args.cwd) : undefined, wsTeamId);
      try {
        const { stdout, stderr } = await execSandboxedCommand({
          command,
          cwd,
          teamId: wsTeamId,
          timeoutMs: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return `STDOUT:\n${stdout.slice(0, 14_000)}\n${stderr ? `STDERR:\n${stderr.slice(0, 4000)}` : ""}`.trim();
      } catch (err: unknown) {
        const e = err as { message?: string; stdout?: string; stderr?: string };
        return `Exit error: ${e.message || String(err)}\nSTDOUT: ${(e.stdout || "").slice(0, 4000)}\nSTDERR: ${(e.stderr || "").slice(0, 4000)}`;
      }
    },
  },
  {
    pack: "shell",
    definition: {
      name: "code_execute",
      description: "Run a Python, Node.js, or Bash script directly in a temporary file inside the workspace and return stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string", enum: ["python", "node", "bash"] },
          code: { type: "string", description: "Source code to execute" },
        },
        required: ["language", "code"],
      },
    },
    execute: async (args, ctx) => {
      const lang = String(args.language || "python");
      const code = String(args.code || "");
      const ext = lang === "node" ? ".mjs" : lang === "bash" ? ".sh" : ".py";
      const wsTeamId = resolveWorkspaceTeamId(ctx);
      const wsDir = resolveTeamWorkspaceDir(wsTeamId);
      const tmpFile = path.join(wsDir, `.pandawa_exec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
      fs.writeFileSync(tmpFile, code, "utf8");
      const cmd =
        lang === "node"
          ? `node "${tmpFile}"`
          : lang === "bash"
          ? `bash "${tmpFile}"`
          : `python3 "${tmpFile}" || python "${tmpFile}"`;
      try {
        const { stdout, stderr } = await execSandboxedCommand({
          command: cmd,
          cwd: wsDir,
          teamId: wsTeamId,
          timeoutMs: 45_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return `STDOUT:\n${stdout.slice(0, 14_000)}\n${stderr ? `STDERR:\n${stderr.slice(0, 4000)}` : ""}`.trim();
      } catch (err: unknown) {
        const e = err as { message?: string; stdout?: string; stderr?: string };
        return `Execution failed: ${e.message || String(err)}\nSTDOUT: ${(e.stdout || "").slice(0, 4000)}\nSTDERR: ${(e.stderr || "").slice(0, 4000)}`;
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // ignore
        }
      }
    },
  },
  {
    pack: "shell",
    definition: {
      name: "process_start",
      description: "Start a long-running background process (dev server, scraper, watcher, tunnel) managed by Pandawa.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
      },
    },
    execute: async (args, ctx) => {
      const wsTeamId = resolveWorkspaceTeamId(ctx);
      const info = startManagedProcess({
        name: args.name ? String(args.name) : undefined,
        command: String(args.command || ""),
        cwd: args.cwd ? String(args.cwd) : undefined,
        teamId: wsTeamId,
      });
      return JSON.stringify(info, null, 2);
    },
  },
  {
    pack: "shell",
    definition: {
      name: "process_list",
      description: "List all Pandawa-managed background processes and their live status.",
      parameters: { type: "object", properties: {} },
    },
    execute: async (_args, ctx) =>
      JSON.stringify({ processes: listManagedProcesses(resolveWorkspaceTeamId(ctx)) }, null, 2),
  },
  {
    pack: "shell",
    definition: {
      name: "process_logs",
      description: "Read recent stdout/stderr log output of a Pandawa-managed background process.",
      parameters: {
        type: "object",
        properties: {
          process_id: { type: "string" },
          tail: { type: "number" },
        },
        required: ["process_id"],
      },
    },
    execute: async (args, ctx) => {
      const out = getManagedProcessLogs(
        String(args.process_id || ""),
        Number(args.tail || 80),
        resolveWorkspaceTeamId(ctx)
      );
      return out ? JSON.stringify(out, null, 2) : "Process not found.";
    },
  },
  {
    pack: "shell",
    definition: {
      name: "process_kill",
      description: "Terminate a Pandawa-managed background process by its ID.",
      parameters: {
        type: "object",
        properties: { process_id: { type: "string" } },
        required: ["process_id"],
      },
    },
    execute: async (args, ctx) => {
      const ok = killManagedProcess(String(args.process_id || ""), resolveWorkspaceTeamId(ctx));
      return ok ? `Terminated process ${args.process_id}.` : `Process not found: ${args.process_id}`;
    },
  },

  // =============================================
  // PACK 5: WEB SEARCH, FETCH & FULL HTTP CLIENT
  // =============================================
  {
    pack: "web",
    definition: {
      name: "web_search",
      description: "Search the live web for facts, docs, news, or references without needing an exact URL first.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "number" },
        },
        required: ["query"],
      },
    },
    execute: async (args, ctx) => {
      const query = String(args.query || "").trim();
      if (!query) return "Search query cannot be empty.";
      const maxResults = Math.min(10, Math.max(1, Number(args.max_results || 6)));

      const tavilyKey = process.env.TAVILY_API_KEY?.trim();
      if (tavilyKey) {
        const resp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: tavilyKey, query, max_results: maxResults }),
          signal: ctx.signal || AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
          return JSON.stringify({ engine: "tavily", query, results: (data.results || []).slice(0, maxResults) }, null, 2);
        }
      }

      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: ctx.signal || AbortSignal.timeout(15_000),
      });
      const html = await resp.text();
      const decode = (s: string) =>
        s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

      const links: Array<{ href: string; title: string }> = [];
      const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
      let m: RegExpExecArray | null;
      while ((m = linkRegex.exec(html)) !== null && links.length < maxResults) {
        let href = m[1];
        const uddg = href.match(/uddg=([^&]+)/);
        if (uddg) {
          try {
            href = decodeURIComponent(uddg[1]);
          } catch {
            // keep raw
          }
        }
        links.push({ href, title: decode(m[2]) });
      }
      const snippets: string[] = [];
      while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
        snippets.push(decode(m[1]));
      }
      const results = links.map((l, i) => ({ title: l.title, url: l.href, snippet: snippets[i] || "" }));
      return results.length
        ? JSON.stringify({ engine: "duckduckgo", query, results }, null, 2)
        : `No search results parsed for "${query}".`;
    },
  },
  {
    pack: "web",
    definition: {
      name: "web_fetch",
      description: "Fetch an HTTP/HTTPS URL and return readable text or JSON (up to 16KB).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
          body: { type: "string" },
        },
        required: ["url"],
      },
    },
    execute: async (args, ctx) => {
      const url = String(args.url || "").trim();
      await assertSafeOutboundUrl(url);
      const resp = await fetch(url, {
        method: String(args.method || "GET"),
        signal: ctx.signal || AbortSignal.timeout(20_000),
        headers: {
          "User-Agent": "Pandawa-Agentic-OS/7.0",
          ...(args.body ? { "Content-Type": "application/json" } : {}),
        },
        body: args.body ? String(args.body) : undefined,
      });
      const raw = await resp.text();
      const cleaned = raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return `HTTP ${resp.status}\n${cleaned.slice(0, 16_000)}`;
    },
  },
  {
    pack: "web",
    definition: {
      name: "http_request",
      description: "Full REST / GraphQL HTTP client supporting custom headers, authorization tokens, methods, and raw JSON/text responses.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
          headers: { type: "object", description: "Key-value HTTP request headers" },
          body: { type: "string", description: "Request body string (JSON or text)" },
        },
        required: ["url"],
      },
    },
    execute: async (args, ctx) => {
      const url = String(args.url || "").trim();
      await assertSafeOutboundUrl(url);
      const headers = (args.headers && typeof args.headers === "object" ? args.headers : {}) as Record<string, string>;
      const resp = await fetch(url, {
        method: String(args.method || "GET"),
        headers,
        body: args.body !== undefined ? String(args.body) : undefined,
        signal: ctx.signal || AbortSignal.timeout(25_000),
      });
      const text = await resp.text();
      return JSON.stringify(
        {
          status: resp.status,
          ok: resp.ok,
          contentType: resp.headers.get("content-type"),
          body: text.slice(0, 16_000),
        },
        null,
        2
      );
    },
  },

  // =============================================
  // PACK 6: REAL INTERACTIVE BROWSER (PLAYWRIGHT + VISION)
  // =============================================
  {
    pack: "browser",
    definition: {
      name: "browser_open",
      description:
        "Open a live webpage in real headless Chromium (Playwright), execute JavaScript/SPA rendering, inspect visible text, interactive selectors, console errors, and optionally capture a screenshot into your Vision context.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          wait_ms: { type: "number", description: "Wait time after load for JS rendering (default 1200ms)" },
          screenshot: { type: "boolean", description: "Capture PNG screenshot and attach to Vision LLM (default false)" },
        },
        required: ["url"],
      },
    },
    execute: async (args, ctx) => {
      const url = String(args.url || "").trim();
      await assertSafeOutboundUrl(url);
      const wantShot = Boolean(args.screenshot);
      const shotRel = wantShot ? makeScreenshotRelPath("open") : "";
      const shotFull = wantShot ? resolveWorkspacePath(shotRel, resolveWorkspaceTeamId(ctx)) : "";
      const res = await runPythonWorker<Record<string, unknown>>("browser_run", {
        url,
        waitMs: Number(args.wait_ms || 1200),
        screenshotPath: shotFull,
      });
      if (res.ok && wantShot && shotFull && fs.existsSync(shotFull)) {
        const base64 = fs.readFileSync(shotFull).toString("base64");
        ctx.onImageCaptured?.({ mimeType: "image/png", base64, name: shotRel });
        res.screenshotWorkspacePath = shotRel;
      }
      return JSON.stringify(res, null, 2);
    },
  },
  {
    pack: "browser",
    definition: {
      name: "browser_interact",
      description:
        "Run interactive actions in a real headless Chromium browser (click buttons, fill inputs, press keys, evaluate JS, take screenshot for Vision verification).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          actions: {
            type: "array",
            description: "List of actions: {type: 'click'|'fill'|'press'|'wait'|'eval', selector?: string, value?: string}",
            items: { type: "object" },
          },
          screenshot: { type: "boolean", description: "Capture screenshot after actions and feed to Vision (default true)" },
        },
        required: ["url", "actions"],
      },
    },
    execute: async (args, ctx) => {
      const url = String(args.url || "").trim();
      await assertSafeOutboundUrl(url);
      const actions = Array.isArray(args.actions) ? args.actions : [];
      const wantShot = args.screenshot !== false;
      const shotRel = wantShot ? makeScreenshotRelPath("act") : "";
      const shotFull = wantShot ? resolveWorkspacePath(shotRel, resolveWorkspaceTeamId(ctx)) : "";
      const res = await runPythonWorker<Record<string, unknown>>("browser_run", {
        url,
        actions,
        screenshotPath: shotFull,
      });
      if (res.ok && wantShot && shotFull && fs.existsSync(shotFull)) {
        const base64 = fs.readFileSync(shotFull).toString("base64");
        ctx.onImageCaptured?.({ mimeType: "image/png", base64, name: shotRel });
        res.screenshotWorkspacePath = shotRel;
      }
      return JSON.stringify(res, null, 2);
    },
  },
  {
    pack: "browser",
    definition: {
      name: "browser_extract",
      description: "Fast lightweight HTML metadata & text extraction without launching Chromium (great for static docs/APIs).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    execute: async (args, ctx) => {
      const url = String(args.url || "").trim();
      await assertSafeOutboundUrl(url);
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 PandawaBrowser/7.0" },
        signal: ctx.signal || AbortSignal.timeout(20_000),
      });
      const html = await resp.text();
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
      const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] || "").trim();
      const headings: string[] = [];
      const hRe = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
      let hm: RegExpExecArray | null;
      while ((hm = hRe.exec(html)) !== null && headings.length < 20) {
        const t = hm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (t) headings.push(t);
      }
      const links: Array<{ text: string; href: string }> = [];
      const aRe = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let am: RegExpExecArray | null;
      while ((am = aRe.exec(html)) !== null && links.length < 25) {
        const text = am[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (text) links.push({ text: text.slice(0, 80), href: am[1] });
      }
      const bodyText = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10_000);
      return JSON.stringify({ url, status: resp.status, title, description: desc, headings, links, text: bodyText }, null, 2);
    },
  },
  {
    pack: "browser",
    definition: {
      name: "browser_screenshot",
      description:
        "Capture a real headless Chromium screenshot of a URL into the workspace AND automatically attach it to your Vision LLM so you can inspect the page visually.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          output_path: { type: "string", description: "Relative PNG path inside workspace (default screenshots/shot_*.png)" },
          full_page: { type: "boolean", description: "Capture full scrollable page (default false)" },
        },
        required: ["url"],
      },
    },
    execute: async (args, ctx) => {
      const url = String(args.url || "").trim();
      await assertSafeOutboundUrl(url);
      const outRel = String(args.output_path || makeScreenshotRelPath("shot"));
      const outFull = resolveWorkspacePath(outRel, resolveWorkspaceTeamId(ctx));
      fs.mkdirSync(path.dirname(outFull), { recursive: true });

      // Prefer Playwright worker first
      try {
        const pwRes = await runPythonWorker<{ ok?: boolean; title?: string; consoleErrors?: string[]; error?: string }>(
          "browser_run",
          { url, screenshotPath: outFull, fullPage: Boolean(args.full_page), waitMs: 1200 }
        );
        if (pwRes.ok && fs.existsSync(outFull)) {
          const base64 = fs.readFileSync(outFull).toString("base64");
          ctx.onImageCaptured?.({ mimeType: "image/png", base64, name: outRel });
          return JSON.stringify(
            {
              ok: true,
              engine: "playwright",
              path: outRel,
              title: pwRes.title || "",
              consoleErrors: pwRes.consoleErrors || [],
              visionAttached: true,
            },
            null,
            2
          );
        }
      } catch {
        // fall through to host chromium binary fallback
      }

      const cmd = `(which chromium || which chromium-browser || which google-chrome) && $(which chromium || which chromium-browser || which google-chrome) --headless --no-sandbox --disable-gpu --window-size=1440,900 --screenshot="${outFull}" "${url}"`;
      try {
        await execAsync(cmd, { timeout: 30_000 });
        if (fs.existsSync(outFull)) {
          const base64 = fs.readFileSync(outFull).toString("base64");
          ctx.onImageCaptured?.({ mimeType: "image/png", base64, name: outRel });
        }
        return `Saved screenshot to workspace: ${outRel} (vision attached).`;
      } catch (err) {
        return `Headless browser capture failed: ${err instanceof Error ? err.message : String(err)}.`;
      }
    },
  },

  // =============================================
  // PACK 7: SELF-AUTOMATION (CRON & CHANNEL DISPATCH)
  // =============================================
  {
    pack: "automation",
    definition: {
      name: "cron_create",
      description: "Schedule a recurring autonomous mission for the active AI team using a 5-field cron expression.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          schedule: { type: "string", description: "5-field cron (e.g. '0 9 * * *' for daily 9 AM)" },
          prompt: { type: "string", description: "Mission instructions to execute on schedule" },
        },
        required: ["name", "schedule", "prompt"],
      },
    },
    execute: async (args, ctx) => {
      const db = getDb();
      const teamId = resolveToolTeamId(ctx);
      if (!teamId) {
        return "Error: No active team configured to attach cron job.";
      }
      const id = generateId("cron");
      db.prepare(
        `INSERT INTO cron_jobs (id, name, schedule, target_type, target_id, prompt, enabled)
         VALUES (?, ?, ?, 'team', ?, ?, 1)`
      ).run(id, String(args.name), String(args.schedule), teamId, String(args.prompt));
      return `Scheduled cron job ${id} ("${args.name}" @ ${args.schedule} -> ${teamId}).`;
    },
  },
  {
    pack: "automation",
    definition: {
      name: "cron_list",
      description: "List all active scheduled Cron missions configured in Pandawa.",
      parameters: { type: "object", properties: {} },
    },
    execute: async () => {
      const db = getDb();
      return JSON.stringify(db.prepare("SELECT id, name, schedule, prompt, enabled, last_status FROM cron_jobs").all(), null, 2);
    },
  },
  {
    pack: "automation",
    definition: {
      name: "channel_notify",
      description: "Send a proactive alert, briefing, or report to a configured Telegram, Discord, or Webhook channel.",
      parameters: {
        type: "object",
        properties: {
          channel_name_or_id: { type: "string", description: "Channel ID or partial name (omit to send to first enabled channel)" },
          title: { type: "string" },
          message: { type: "string" },
        },
        required: ["title", "message"],
      },
    },
    execute: async (args) => {
      const db = getDb();
      const channels = db.prepare("SELECT id, name FROM channels WHERE enabled = 1").all() as Array<{ id: string; name: string }>;
      if (channels.length === 0) return "No enabled channels configured yet.";
      const q = String(args.channel_name_or_id || "").trim().toLowerCase();
      const target = q
        ? channels.find((c) => c.id.toLowerCase() === q || c.name.toLowerCase().includes(q))
        : channels[0];
      if (!target) return `Channel "${args.channel_name_or_id}" not found.`;
      const res = await dispatchChannelNotification(target.id, String(args.title), String(args.message));
      return JSON.stringify({ channel: target.name, ...res });
    },
  },
  {
    pack: "automation",
    definition: {
      name: "heartbeat_configure",
      description:
        "Inspect or update Pandawa's 24/7 Proactive Autonomous Heartbeat Daemon (enable/disable, change interval minutes, or update the HEARTBEAT.md watch checklist).",
      parameters: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          interval_minutes: { type: "number", description: "Minutes between autonomous pulses (5 to 1440)" },
          checklist_markdown: { type: "string", description: "Optional full Markdown update for HEARTBEAT.md" },
        },
      },
    },
    execute: async (args) => {
      const hasChange =
        args.enabled !== undefined || args.interval_minutes !== undefined || args.checklist_markdown !== undefined;
      const cfg = hasChange
        ? updateHeartbeatConfig({
            enabled: args.enabled !== undefined ? Boolean(args.enabled) : undefined,
            intervalMinutes: args.interval_minutes !== undefined ? Number(args.interval_minutes) : undefined,
            checklistMarkdown: args.checklist_markdown !== undefined ? String(args.checklist_markdown) : undefined,
          })
        : getHeartbeatConfig();
      return JSON.stringify(cfg, null, 2);
    },
  },

  // =============================================
  // PACK 8: PERSISTENT SHARED TERMINAL (PYTHON PTY / TMUX)
  // =============================================
  {
    pack: "terminal",
    definition: {
      name: "term_open",
      description:
        "Open or attach to a persistent, stateful shared terminal session (backed by tmux/PTY). Directory changes, env vars, virtualenvs, and running servers stay alive across turns and can be inspected by teammates and the user.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short session name (e.g. 'backend', 'qa', 'build')" },
          cwd: { type: "string", description: "Optional starting directory (relative to workspace or absolute)" },
          env: { type: "object", description: "Optional initial environment variables" },
        },
        required: ["name"],
      },
    },
    execute: async (args, ctx) => {
      const teamId = resolveWorkspaceTeamId(ctx) || ctx.teamId;
      const res = await openTerminal({
        name: String(args.name || "main"),
        cwd: args.cwd ? String(args.cwd) : undefined,
        env: (args.env && typeof args.env === "object" ? args.env : undefined) as Record<string, string> | undefined,
        ownerAgent: ctx.runtime.agent.name,
        teamId,
        sessionId: ctx.sessionId,
      });
      return JSON.stringify(res, null, 2);
    },
  },
  {
    pack: "terminal",
    definition: {
      name: "term_exec",
      description:
        "Run a command inside a persistent shared terminal session (auto-opens if missing). Preserves cwd/env/venv across calls and captures stdout/stderr + exit code cleanly.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Terminal session name (e.g. 'main', 'backend', 'qa')" },
          command: { type: "string", description: "Shell command to execute" },
          timeout_sec: { type: "number", description: "Max wait seconds before returning live partial output (default 45)" },
          cwd: { type: "string", description: "Starting cwd if session is newly opened" },
        },
        required: ["session", "command"],
      },
    },
    execute: async (args, ctx) => {
      const teamId = resolveWorkspaceTeamId(ctx) || ctx.teamId;
      const res = await execInTerminal({
        name: String(args.session || "main"),
        command: String(args.command || ""),
        timeoutSec: args.timeout_sec ? Number(args.timeout_sec) : 45,
        cwd: args.cwd ? String(args.cwd) : undefined,
        actor: ctx.runtime.agent.name,
        teamId,
        sessionId: ctx.sessionId,
      });
      return JSON.stringify(res, null, 2);
    },
  },
  {
    pack: "terminal",
    definition: {
      name: "term_send",
      description:
        "Send interactive input or control keys (e.g. 'C-c' to stop a server, 'C-d', 'y', 'Enter') to a living shared terminal session.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Terminal session name" },
          text: { type: "string", description: "Text to type into the terminal" },
          key: { type: "string", description: "Special key: C-c, C-d, C-z, Enter, Escape, Tab, Up, Down" },
          enter: { type: "boolean", description: "Press Enter after text (default true)" },
        },
        required: ["session"],
      },
    },
    execute: async (args, ctx) => {
      const teamId = resolveWorkspaceTeamId(ctx) || ctx.teamId;
      const res = await sendKeysToTerminal({
        name: String(args.session || "main"),
        text: args.text !== undefined ? String(args.text) : undefined,
        key: args.key !== undefined ? String(args.key) : undefined,
        enter: args.enter !== undefined ? Boolean(args.enter) : true,
        actor: ctx.runtime.agent.name,
        teamId,
        sessionId: ctx.sessionId,
      });
      return JSON.stringify(res, null, 2);
    },
  },
  {
    pack: "terminal",
    definition: {
      name: "term_read",
      description:
        "Read the live screen & scrollback of ANY shared terminal session (including terminals opened by your teammates, e.g. to check server logs or test output).",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Terminal session name" },
          lines: { type: "number", description: "Scrollback lines to capture (default 150)" },
        },
        required: ["session"],
      },
    },
    execute: async (args, ctx) => {
      const teamId = resolveWorkspaceTeamId(ctx) || ctx.teamId;
      const res = await readTerminal(String(args.session || "main"), Number(args.lines || 150), {
        teamId,
        sessionId: ctx.sessionId,
      });
      return JSON.stringify(res, null, 2);
    },
  },
  {
    pack: "terminal",
    definition: {
      name: "term_list",
      description: "List all active persistent shared terminal sessions, their owners, cwds, and tmux attach commands.",
      parameters: { type: "object", properties: {} },
    },
    execute: async (_args, ctx) =>
      JSON.stringify(
        await listTerminals({ teamId: resolveWorkspaceTeamId(ctx) || ctx.teamId, sessionId: ctx.sessionId }),
        null,
        2
      ),
  },
  {
    pack: "terminal",
    definition: {
      name: "term_close",
      description: "Close and terminate a persistent shared terminal session cleanly.",
      parameters: {
        type: "object",
        properties: { session: { type: "string", description: "Terminal session name to close" } },
        required: ["session"],
      },
    },
    execute: async (args, ctx) =>
      JSON.stringify(
        await closeTerminal(String(args.session || ""), {
          teamId: resolveWorkspaceTeamId(ctx) || ctx.teamId,
          sessionId: ctx.sessionId,
        }),
        null,
        2
      ),
  },
];

export function getToolsForPacks(packs: string[], extraMcpTools: LLMToolDefinition[] = []): LLMToolDefinition[] {
  const set = new Set(packs);
  // Agents with 'shell' access automatically gain persistent shared terminal ('terminal') tools too!
  if (set.has("shell")) set.add("terminal");
  const builtin = TOOLS.filter((t) => set.has(t.pack)).map((t) => t.definition);
  return [...builtin, ...extraMcpTools];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<string> {
  if (toolRequiresApproval(name, ctx.sessionId)) {
    const decision = await requestApproval({
      agentId: ctx.runtime.agent.id,
      agentName: ctx.runtime.agent.name,
      toolName: name,
      args,
      sessionId: ctx.sessionId,
      channelId: ctx.channelId,
      chatId: ctx.chatId,
      signal: ctx.signal,
      onEvent: ctx.onEvent,
    });
    if (!decision.approved) {
      return `Action rejected by user${decision.reason ? `: ${decision.reason}` : "."}`;
    }
  }

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

import { getDb } from "../db/database.js";
import { collectContextFromPath } from "../brains/brainFs.js";
import type { ProviderRecord } from "../providers/llmClient.js";

export interface AgentRecord {
  id: string;
  slug: string;
  name: string;
  title: string;
  role_description: string;
  avatar: string;
  color: string;
  provider_id: string | null;
  model: string;
  purpose: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string;
  tool_packs_json: string;
  enabled: number;
}

export interface BrainRecord {
  id: string;
  slug: string;
  name: string;
  layer: "main" | "team" | "personal";
  description: string;
  folder_path: string;
  color: string;
  sync_policy: string;
}

interface CanvasNodeRow {
  id: string;
  type: string;
  ref_id: string;
  label: string;
  data_json: string;
}

interface CanvasEdgeRow {
  id: string;
  source: string;
  target: string;
  relation: string;
  permission: string;
  label: string;
}

export interface CompiledAgentRuntime {
  agent: AgentRecord;
  provider: ProviderRecord | null;
  model: string;
  mainBrains: Array<BrainRecord & { permission: string }>;
  teamBrains: Array<BrainRecord & { permission: string }>;
  mountedKnowledge: Array<{ path: string; permission: string; files: Array<{ path: string; content: string }> }>;
  writablePrefixes: string[];
  toolPacks: string[];
  peers: Array<{ id: string; name: string; title: string; purpose: string; model: string }>;
  systemPrompt: string;
  summary: {
    totalFiles: number;
    totalChars: number;
    brainNames: string[];
    mountedPaths: string[];
  };
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function compileAgentRuntime(agentId: string, teamId?: string, sessionId?: string): CompiledAgentRuntime {
  const db = getDb();
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRecord | undefined;
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const nodes = db.prepare("SELECT id, type, ref_id, label, data_json FROM canvas_nodes").all() as unknown as CanvasNodeRow[];
  const edges = db.prepare("SELECT id, source, target, relation, permission, label FROM canvas_edges").all() as unknown as CanvasEdgeRow[];
  const allBrains = db.prepare("SELECT * FROM brains").all() as unknown as BrainRecord[];
  const allProviders = db.prepare("SELECT * FROM providers").all() as unknown as ProviderRecord[];
  const allAgents = db.prepare("SELECT * FROM agents WHERE enabled = 1").all() as unknown as AgentRecord[];

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const brainById = new Map(allBrains.map((b) => [b.id, b]));
  const providerById = new Map(allProviders.map((p) => [p.id, p]));

  // Find canvas node(s) representing this agent
  const agentNodeIds = new Set(
    nodes
      .filter((n) => n.type === "agent" && (n.ref_id === agent.id || parseJson<{ agentId?: string }>(n.data_json, {}).agentId === agent.id))
      .map((n) => n.id)
  );

  // Helper: get adjacent nodes connected to any node in a set
  function getNeighbors(nodeIds: Set<string>): Array<{ node: CanvasNodeRow; edge: CanvasEdgeRow }> {
    const out: Array<{ node: CanvasNodeRow; edge: CanvasEdgeRow }> = [];
    for (const e of edges) {
      if (nodeIds.has(e.target) && nodeById.has(e.source)) {
        out.push({ node: nodeById.get(e.source)!, edge: e });
      } else if (nodeIds.has(e.source) && nodeById.has(e.target)) {
        out.push({ node: nodeById.get(e.target)!, edge: e });
      }
    }
    return out;
  }

  const mainBrainsMap = new Map<string, BrainRecord & { permission: string }>();
  const teamBrainsMap = new Map<string, BrainRecord & { permission: string }>();
  const knowledgeMounts = new Map<string, string>(); // path -> permission
  const toolPacksSet = new Set<string>(parseJson<string[]>(agent.tool_packs_json, ["brain", "team"]));
  const peerAgentIds = new Set<string>();

  let canvasProviderId: string | null = null;
  let canvasModelOverride = "";

  // 1. Direct neighbors of Agent on Canvas
  const directNeighbors = getNeighbors(agentNodeIds);
  const connectedBrainNodeIds = new Set<string>();

  for (const { node, edge } of directNeighbors) {
    const data = parseJson<Record<string, unknown>>(node.data_json, {});
    if (node.type === "main_brain") {
      const b = brainById.get(node.ref_id);
      if (b) {
        mainBrainsMap.set(b.id, { ...b, permission: edge.permission || b.sync_policy });
        connectedBrainNodeIds.add(node.id);
      }
    } else if (node.type === "team_brain") {
      const b = brainById.get(node.ref_id);
      if (b) {
        teamBrainsMap.set(b.id, { ...b, permission: edge.permission || b.sync_policy });
        connectedBrainNodeIds.add(node.id);
      }
    } else if (node.type === "provider") {
      canvasProviderId = (data.providerId as string) || node.ref_id || null;
      if (typeof data.model === "string" && data.model.trim()) {
        canvasModelOverride = data.model.trim();
      }
    } else if (node.type === "knowledge") {
      const p = (data.path as string) || node.ref_id;
      if (p) knowledgeMounts.set(p, edge.permission || "read_write");
    } else if (node.type === "toolpack") {
      const packs = Array.isArray(data.packs) ? (data.packs as string[]) : [];
      for (const pk of packs) toolPacksSet.add(pk);
    } else if (node.type === "agent") {
      const peerId = (data.agentId as string) || node.ref_id;
      if (peerId && peerId !== agent.id) peerAgentIds.add(peerId);
    }
  }

  // If running under a specific teamId, guarantee that team's brain is mounted
  if (teamId) {
    const teamRow = db.prepare("SELECT team_brain_id FROM teams WHERE id = ?").get(teamId) as
      | { team_brain_id?: string }
      | undefined;
    if (teamRow?.team_brain_id && brainById.has(teamRow.team_brain_id)) {
      const tb = brainById.get(teamRow.team_brain_id)!;
      if (!teamBrainsMap.has(tb.id)) {
        teamBrainsMap.set(tb.id, { ...tb, permission: tb.sync_policy || "read_write" });
      }
      for (const n of nodes) {
        if (n.type === "team_brain" && n.ref_id === tb.id) connectedBrainNodeIds.add(n.id);
      }
    }
  }

  // 2. Traverse Brain -> Brain links (e.g., Main Brain -> Team Brain) AND Brain -> Knowledge / Sibling Agents
  const brainNeighbors = getNeighbors(connectedBrainNodeIds);
  for (const { node, edge } of brainNeighbors) {
    const data = parseJson<Record<string, unknown>>(node.data_json, {});
    if (node.type === "main_brain") {
      const b = brainById.get(node.ref_id);
      if (b && !mainBrainsMap.has(b.id)) {
        mainBrainsMap.set(b.id, { ...b, permission: edge.permission || b.sync_policy });
        connectedBrainNodeIds.add(node.id);
      }
    } else if (node.type === "knowledge") {
      const p = (data.path as string) || node.ref_id;
      if (p && !knowledgeMounts.has(p)) {
        knowledgeMounts.set(p, edge.permission || "read");
      }
    } else if (node.type === "agent") {
      const peerId = (data.agentId as string) || node.ref_id;
      if (peerId && peerId !== agent.id) peerAgentIds.add(peerId);
    }
  }

  // Also grab knowledge directly wired to newly discovered Main Brains
  const mainBrainNodeIds = new Set(
    nodes.filter((n) => n.type === "main_brain" && mainBrainsMap.has(n.ref_id)).map((n) => n.id)
  );
  for (const { node, edge } of getNeighbors(mainBrainNodeIds)) {
    if (node.type === "knowledge") {
      const data = parseJson<Record<string, unknown>>(node.data_json, {});
      const p = (data.path as string) || node.ref_id;
      if (p && !knowledgeMounts.has(p)) {
        knowledgeMounts.set(p, edge.permission || "read");
      }
    }
  }

  // Resolve Provider & Model
  const chosenProviderId = agent.provider_id || canvasProviderId;
  let provider: ProviderRecord | null = chosenProviderId ? providerById.get(chosenProviderId) || null : null;
  if (!provider && canvasProviderId) {
    provider = providerById.get(canvasProviderId) || null;
  }
  const model = agent.model || canvasModelOverride || provider?.default_model || "";

  // Always auto-check personal folder `agents/<slug>` if it exists and wasn't explicitly mounted
  const defaultPersonalFolder = `agents/${agent.slug}`;
  if (!knowledgeMounts.has(defaultPersonalFolder)) {
    const check = collectContextFromPath(defaultPersonalFolder, 100);
    if (check.files.length > 0) {
      knowledgeMounts.set(defaultPersonalFolder, "read_write");
    }
  }

  // Collect all Brain & Knowledge files
  const mainBrains = Array.from(mainBrainsMap.values());
  const teamBrains = Array.from(teamBrainsMap.values());
  const writablePrefixes: string[] = [];

  const promptSections: string[] = [];
  let totalFiles = 0;

  // Identity header
  promptSections.push(
    `# PANDAWA AGENT IDENTITY\n` +
      `- Name: **${agent.name}** (${agent.title || agent.purpose})\n` +
      `- Purpose: ${agent.purpose}\n` +
      `- Role: ${agent.role_description}\n` +
      (agent.system_prompt ? `\n${agent.system_prompt}\n` : "")
  );

  // Layer 1: Main Brain
  if (mainBrains.length > 0) {
    const mbBlocks: string[] = [];
    for (const mb of mainBrains) {
      if (mb.permission === "read_write" || mb.permission === "sync") {
        writablePrefixes.push(mb.folder_path);
      }
      const collected = collectContextFromPath(mb.folder_path, 12000);
      totalFiles += collected.files.length;
      const body = collected.files.map((f) => `### File: ${f.path}\n${f.content}`).join("\n\n");
      mbBlocks.push(`## Main Brain: ${mb.name} (${mb.folder_path}, access: ${mb.permission})\n${body}`);
    }
    promptSections.push(`# LAYER 1 — MAIN BRAIN (GLOBAL KNOWLEDGE & DHARMA)\n${mbBlocks.join("\n\n")}`);
  }

  // Layer 2: Team / Group Brain
  if (teamBrains.length > 0) {
    const tbBlocks: string[] = [];
    for (const tb of teamBrains) {
      if (tb.permission === "read_write" || tb.permission === "sync") {
        writablePrefixes.push(tb.folder_path);
      }
      const collected = collectContextFromPath(tb.folder_path, 12000);
      totalFiles += collected.files.length;
      const body = collected.files.map((f) => `### File: ${f.path}\n${f.content}`).join("\n\n");
      tbBlocks.push(`## Team Brain: ${tb.name} (${tb.folder_path}, access: ${tb.permission})\n${body}`);
    }
    promptSections.push(`# LAYER 2 — TEAM / GROUP BRAIN (SHARED TEAM CONTEXT)\n${tbBlocks.join("\n\n")}`);
  }

  // Layer 3: Directly Wired Knowledge Files & Folders (avoid duplicating already-loaded brain folder files)
  const loadedBrainFolders = new Set([...mainBrains.map((b) => b.folder_path), ...teamBrains.map((b) => b.folder_path)]);
  const mountedKnowledge: Array<{ path: string; permission: string; files: Array<{ path: string; content: string }> }> = [];
  const knowledgeBlocks: string[] = [];

  for (const [kPath, perm] of knowledgeMounts.entries()) {
    if (perm === "read_write" || perm === "sync") {
      writablePrefixes.push(kPath);
    }
    const alreadyCovered = Array.from(loadedBrainFolders).some(
      (bf) => kPath === bf || kPath.startsWith(`${bf}/`)
    );
    const collected = collectContextFromPath(kPath, 8000);
    mountedKnowledge.push({ path: kPath, permission: perm, files: collected.files });
    if (!alreadyCovered && collected.files.length > 0) {
      totalFiles += collected.files.length;
      const body = collected.files.map((f) => `### Mounted: ${f.path} (${perm})\n${f.content}`).join("\n\n");
      knowledgeBlocks.push(body);
    }
  }
  if (knowledgeBlocks.length > 0) {
    promptSections.push(`# LAYER 3 — CONNECTED PERSONAL & CUSTOM KNOWLEDGE\n${knowledgeBlocks.join("\n\n")}`);
  }

  // Layer 4: Episodic Memories from Connected Brains
  const connectedBrainIds = [...mainBrains.map((b) => b.id), ...teamBrains.map((b) => b.id)];
  if (connectedBrainIds.length > 0) {
    const placeholders = connectedBrainIds.map(() => "?").join(",");
    const mems = db
      .prepare(
        `SELECT category, content, importance, created_at FROM memories
         WHERE brain_id IN (${placeholders})
         ORDER BY importance DESC, created_at DESC LIMIT 15`
      )
      .all(...connectedBrainIds) as Array<{ category: string; content: string; importance: number; created_at: string }>;
    if (mems.length > 0) {
      promptSections.push(
        `# PERSISTENT EPISODIC MEMORIES\n` +
          mems.map((m) => `- [${m.category} | p${m.importance}] ${m.content}`).join("\n")
      );
    }
  }

  // Layer 5: Peer Teammates & Live Team Blackboard
  const peers = allAgents
    .filter((a) => peerAgentIds.has(a.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title,
      purpose: a.purpose,
      model: a.model,
    }));

  if (peers.length > 0) {
    promptSections.push(
      `# CONNECTED TEAMMATES (AGENTIC TEAM — PEER COLLABORATION)\n` +
        `You collaborate horizontally as peers (NOT sub-agents). Teammates sharing your Team Brain:\n` +
        peers.map((p) => `- **${p.name}** (${p.title} | purpose: ${p.purpose} | model: ${p.model || "default"})`).join("\n")
    );
  }

  if (teamId) {
    const bbRows = db
      .prepare(
        `SELECT author_name, entry_type, title, content, created_at FROM blackboard_entries
         WHERE team_id = ? ${sessionId ? "AND (session_id = ? OR session_id = '')" : ""}
         ORDER BY created_at DESC LIMIT 12`
      )
      .all(...(sessionId ? [teamId, sessionId] : [teamId])) as Array<{
      author_name: string;
      entry_type: string;
      title: string;
      content: string;
    }>;
    if (bbRows.length > 0) {
      promptSections.push(
        `# LIVE TEAM BLACKBOARD\n` +
          bbRows
            .reverse()
            .map((r) => `- **[${r.entry_type.toUpperCase()}] ${r.title}** (by ${r.author_name}): ${r.content}`)
            .join("\n")
      );
    }
  }

  const systemPrompt = promptSections.join("\n\n---\n\n");

  return {
    agent,
    provider,
    model,
    mainBrains,
    teamBrains,
    mountedKnowledge,
    writablePrefixes: Array.from(new Set(writablePrefixes)),
    toolPacks: Array.from(toolPacksSet),
    peers,
    systemPrompt,
    summary: {
      totalFiles,
      totalChars: systemPrompt.length,
      brainNames: [...mainBrains.map((b) => b.name), ...teamBrains.map((b) => b.name)],
      mountedPaths: Array.from(knowledgeMounts.keys()),
    },
  };
}

export function getTeamMembers(teamId: string): AgentRecord[] {
  const db = getDb();
  const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as
    | { id: string; team_brain_id?: string }
    | undefined;
  if (!team) return [];

  const nodes = db.prepare("SELECT id, type, ref_id, data_json FROM canvas_nodes").all() as unknown as CanvasNodeRow[];
  const edges = db.prepare("SELECT source, target FROM canvas_edges").all() as Array<{ source: string; target: string }>;

  const teamBrainNodeIds = new Set(
    nodes
      .filter((n) => n.type === "team_brain" && (n.ref_id === team.team_brain_id || parseJson<{ teamId?: string }>(n.data_json, {}).teamId === teamId))
      .map((n) => n.id)
  );

  const memberAgentIds = new Set<string>();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const e of edges) {
    let candidate: CanvasNodeRow | undefined;
    if (teamBrainNodeIds.has(e.source)) candidate = nodeById.get(e.target);
    else if (teamBrainNodeIds.has(e.target)) candidate = nodeById.get(e.source);
    if (candidate && candidate.type === "agent") {
      const data = parseJson<{ agentId?: string }>(candidate.data_json, {});
      const aid = data.agentId || candidate.ref_id;
      if (aid) memberAgentIds.add(aid);
    }
  }

  const allAgents = db.prepare("SELECT * FROM agents WHERE enabled = 1 ORDER BY created_at ASC").all() as unknown as AgentRecord[];
  const wired = allAgents.filter((a) => memberAgentIds.has(a.id));
  return wired.length > 0 ? wired : allAgents;
}

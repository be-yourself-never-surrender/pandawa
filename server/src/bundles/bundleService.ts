import { generateId } from "../config.js";
import { getDb, logAudit } from "../db/database.js";
import { collectAllFilesFromPath, createBrainFolder, writeBrainFile } from "../brains/brainFs.js";
import { getTeamMembers } from "../engine/contextCompiler.js";

export interface PandawaBundle {
  format: "pandawa-bundle/v1";
  exportedAt: string;
  bundleName: string;
  description: string;
  author: string;
  warnings?: string[];
  team: {
    slug: string;
    name: string;
    description: string;
    collaborationMode: string;
    maxRounds: number;
    leadAgentSlug?: string;
    reviewerAgentSlug?: string;
    senderAgentSlug?: string;
  };
  brains: Array<{
    key: string;
    slug: string;
    name: string;
    layer: "main" | "team" | "personal";
    description: string;
    folderPath: string;
    color: string;
    syncPolicy: string;
  }>;
  agents: Array<{
    key: string;
    slug: string;
    name: string;
    title: string;
    roleDescription: string;
    avatar: string;
    color: string;
    model: string;
    purpose: string;
    temperature: number;
    maxTokens: number;
    maxIterations?: number;
    systemPrompt: string;
    toolPacks: string[];
  }>;
  files: Array<{
    path: string;
    content: string;
  }>;
  topology: {
    nodes: Array<{
      key: string;
      type: string;
      refKey: string;
      label: string;
      position: { x: number; y: number };
      data: Record<string, unknown>;
    }>;
    edges: Array<{
      sourceKey: string;
      targetKey: string;
      relation: string;
      permission: string;
      label: string;
      animated: boolean;
    }>;
  };
}

export function exportTeamBundle(params: {
  teamId?: string;
  includeMainBrain?: boolean;
  author?: string;
}): PandawaBundle {
  const db = getDb();
  const team = (
    params.teamId
      ? db.prepare("SELECT * FROM teams WHERE id = ?").get(params.teamId)
      : db.prepare("SELECT * FROM teams ORDER BY created_at ASC LIMIT 1").get()
  ) as
    | {
        id: string;
        slug: string;
        name: string;
        description: string;
        team_brain_id: string | null;
        collaboration_mode: string;
        max_rounds: number;
        lead_agent_id?: string;
        reviewer_agent_id?: string;
        sender_agent_id?: string;
      }
    | undefined;

  if (!team) {
    throw new Error("No team found to export.");
  }

  const members = getTeamMembers(team.id);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const brainsToExport: Array<{
    id: string;
    slug: string;
    name: string;
    layer: "main" | "team" | "personal";
    description: string;
    folder_path: string;
    color: string;
    sync_policy: string;
  }> = [];

  if (params.includeMainBrain !== false) {
    const mains = db.prepare("SELECT * FROM brains WHERE layer = 'main'").all() as unknown as typeof brainsToExport;
    brainsToExport.push(...mains);
  }
  if (team.team_brain_id) {
    const tb = db.prepare("SELECT * FROM brains WHERE id = ?").get(team.team_brain_id) as unknown as
      | (typeof brainsToExport)[number]
      | undefined;
    if (tb) brainsToExport.push(tb);
  }

  // Losslessly collect ALL readable files belonging to exported brains & member personal folders
  const filesMap = new Map<string, string>();
  const warnings: string[] = [];
  for (const b of brainsToExport) {
    const col = collectAllFilesFromPath(b.folder_path);
    for (const f of col.files) filesMap.set(f.path, f.content);
    warnings.push(...col.warnings);
  }
  for (const ag of members) {
    const col = collectAllFilesFromPath(`agents/${ag.slug}`);
    for (const f of col.files) filesMap.set(f.path, f.content);
    warnings.push(...col.warnings);
  }

  // Collect strictly scoped topology subgraph reachable from this team (NEVER exporting raw API keys or unrelated teams!)
  const allNodes = db.prepare("SELECT * FROM canvas_nodes").all() as Array<{
    id: string;
    type: string;
    ref_id: string;
    label: string;
    position_x: number;
    position_y: number;
    data_json: string;
  }>;
  const allEdges = db.prepare("SELECT * FROM canvas_edges").all() as Array<{
    id: string;
    source: string;
    target: string;
    relation: string;
    permission: string;
    label: string;
    animated: number;
  }>;

  const brainIdSet = new Set(brainsToExport.map((b) => b.id));
  const agentIdSet = new Set(members.map((m) => m.id));
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));

  const coreNodeIds = new Set<string>();
  for (const n of allNodes) {
    const data = JSON.parse(n.data_json || "{}") as Record<string, unknown>;
    const isCore =
      (n.type === "main_brain" && brainIdSet.has(n.ref_id)) ||
      (n.type === "team_brain" && (brainIdSet.has(n.ref_id) || data.teamId === team.id)) ||
      (n.type === "agent" && agentIdSet.has(String(data.agentId || n.ref_id)));
    if (isCore) coreNodeIds.add(n.id);
  }

  // Include knowledge/toolpack nodes directly connected to coreNodes of THIS team only
  const includedNodeIds = new Set<string>(coreNodeIds);
  for (const e of allEdges) {
    let attachId: string | null = null;
    if (coreNodeIds.has(e.source)) attachId = e.target;
    else if (coreNodeIds.has(e.target)) attachId = e.source;
    if (!attachId) continue;
    const neighbor = nodeById.get(attachId);
    if (neighbor && (neighbor.type === "knowledge" || neighbor.type === "toolpack")) {
      includedNodeIds.add(neighbor.id);
    }
  }

  const exportedNodes: PandawaBundle["topology"]["nodes"] = [];
  for (const n of allNodes) {
    if (!includedNodeIds.has(n.id)) continue;
    const data = JSON.parse(n.data_json || "{}") as Record<string, unknown>;
    if (n.type === "knowledge") {
      const kPath = String(data.path || n.ref_id);
      if (kPath) {
        const col = collectAllFilesFromPath(kPath);
        for (const f of col.files) filesMap.set(f.path, f.content);
        warnings.push(...col.warnings);
      }
    }
    exportedNodes.push({
      key: n.id,
      type: n.type,
      refKey: n.ref_id,
      label: n.label,
      position: { x: n.position_x, y: n.position_y },
      data,
    });
  }

  const exportedEdges: PandawaBundle["topology"]["edges"] = allEdges
    .filter((e) => includedNodeIds.has(e.source) && includedNodeIds.has(e.target))
    .map((e) => ({
      sourceKey: e.source,
      targetKey: e.target,
      relation: e.relation,
      permission: e.permission,
      label: e.label,
      animated: Boolean(e.animated),
    }));

  return {
    format: "pandawa-bundle/v1",
    exportedAt: new Date().toISOString(),
    bundleName: `${team.name} — Brain Kit`,
    description: team.description,
    author: params.author || "Pandawa Studio",
    ...(warnings.length > 0 ? { warnings } : {}),
    team: {
      slug: team.slug,
      name: team.name,
      description: team.description,
      collaborationMode: team.collaboration_mode,
      maxRounds: team.max_rounds,
      ...(team.lead_agent_id && memberById.has(team.lead_agent_id)
        ? { leadAgentSlug: memberById.get(team.lead_agent_id)!.slug }
        : {}),
      ...(team.reviewer_agent_id && memberById.has(team.reviewer_agent_id)
        ? { reviewerAgentSlug: memberById.get(team.reviewer_agent_id)!.slug }
        : {}),
      ...(team.sender_agent_id && memberById.has(team.sender_agent_id)
        ? { senderAgentSlug: memberById.get(team.sender_agent_id)!.slug }
        : {}),
    },
    brains: brainsToExport.map((b) => ({
      key: b.id,
      slug: b.slug,
      name: b.name,
      layer: b.layer,
      description: b.description,
      folderPath: b.folder_path,
      color: b.color,
      syncPolicy: b.sync_policy,
    })),
    agents: members.map((m) => ({
      key: m.id,
      slug: m.slug,
      name: m.name,
      title: m.title,
      roleDescription: m.role_description,
      avatar: m.avatar,
      color: m.color,
      model: m.model,
      purpose: m.purpose,
      temperature: m.temperature,
      maxTokens: m.max_tokens,
      maxIterations: m.max_iterations || 35,
      systemPrompt: m.system_prompt,
      toolPacks: JSON.parse(m.tool_packs_json || '["brain","team"]'),
    })),
    files: Array.from(filesMap.entries()).map(([p, content]) => ({ path: p, content })),
    topology: {
      nodes: exportedNodes,
      edges: exportedEdges,
    },
  };
}

export function importTeamBundle(bundle: PandawaBundle): {
  teamId: string;
  teamName: string;
  importedBrains: number;
  importedAgents: number;
  importedFiles: number;
} {
  if (!bundle || bundle.format !== "pandawa-bundle/v1") {
    throw new Error("Invalid bundle format. Expected 'pandawa-bundle/v1'.");
  }

  const db = getDb();
  const suffix = Math.random().toString(36).slice(2, 6);
  const prefixFolder = `imported/${(bundle.team?.slug || "kit").replace(/[^a-z0-9-_]/gi, "-")}-${suffix}`;

  const oldToNewBrainId = new Map<string, string>();
  const oldToNewAgentId = new Map<string, string>();
  const oldToNewPath = new Map<string, string>();
  const oldToNewNodeId = new Map<string, string>();

  // 1. Write all bundled files under isolated imported folder so nothing existing is overwritten
  let importedFiles = 0;
  for (const f of bundle.files || []) {
    const cleanOrig = f.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const targetPath = `${prefixFolder}/${cleanOrig}`;
    writeBrainFile(targetPath, f.content);
    oldToNewPath.set(cleanOrig, targetPath);
    importedFiles++;
  }

  // 2. Create Brains
  let teamBrainNewId: string | null = null;
  for (const b of bundle.brains || []) {
    const newId = generateId("brain");
    const newFolder = `${prefixFolder}/${b.folderPath.replace(/^\/+/, "")}`;
    createBrainFolder(newFolder);
    const newSlug = `${b.slug}-${suffix}`;
    db.prepare(
      `INSERT INTO brains (id, slug, name, layer, description, folder_path, color, sync_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId, newSlug, `${b.name} (${suffix})`, b.layer, b.description, newFolder, b.color || "#8b5cf6", b.syncPolicy || "read_write");
    oldToNewBrainId.set(b.key, newId);
    oldToNewPath.set(b.folderPath, newFolder);
    if (b.layer === "team" && !teamBrainNewId) teamBrainNewId = newId;
  }

  // 3. Create Agents first so role IDs (lead/reviewer/sender) resolve cleanly on Team
  const newSlugToAgentId = new Map<string, string>();
  const oldSlugToNewSlug = new Map<string, string>();
  for (const a of bundle.agents || []) {
    const newId = generateId("agent");
    const newSlug = `${a.slug}-${suffix}`;
    const maxIter = Math.min(100, Math.max(1, Number(a.maxIterations || 35)));
    db.prepare(
      `INSERT INTO agents (id, slug, name, title, role_description, avatar, color, model, purpose, temperature, max_tokens, max_iterations, system_prompt, tool_packs_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      newId,
      newSlug,
      a.name,
      a.title,
      a.roleDescription || "",
      a.avatar || "A",
      a.color || "#06b6d4",
      a.model || "",
      a.purpose || "general",
      a.temperature ?? 0.5,
      a.maxTokens ?? 4096,
      maxIter,
      a.systemPrompt || "",
      JSON.stringify(a.toolPacks || ["brain", "team"])
    );
    oldToNewAgentId.set(a.key, newId);
    newSlugToAgentId.set(a.slug, newId);
    oldSlugToNewSlug.set(a.slug, newSlug);
  }

  // Mirror exported personal agent files (`agents/<oldSlug>/...`) into `agents/<newSlug>/...` so agent personal mounts work immediately
  for (const f of bundle.files || []) {
    const cleanOrig = f.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const m = cleanOrig.match(/^agents\/([^/]+)\/(.+)$/);
    if (m && oldSlugToNewSlug.has(m[1])) {
      writeBrainFile(`agents/${oldSlugToNewSlug.get(m[1])}/${m[2]}`, f.content);
    }
  }

  // 4. Create Team with restored explicit role bindings
  const newTeamId = generateId("team");
  const teamName = `${bundle.team?.name || bundle.bundleName || "Imported Team"} (${suffix})`;
  const leadAgentId = bundle.team?.leadAgentSlug ? newSlugToAgentId.get(bundle.team.leadAgentSlug) || "" : "";
  const reviewerAgentId = bundle.team?.reviewerAgentSlug
    ? newSlugToAgentId.get(bundle.team.reviewerAgentSlug) || ""
    : "";
  const senderAgentId = bundle.team?.senderAgentSlug ? newSlugToAgentId.get(bundle.team.senderAgentSlug) || "" : "";

  db.prepare(
    `INSERT INTO teams (id, slug, name, description, team_brain_id, collaboration_mode, max_rounds, lead_agent_id, reviewer_agent_id, sender_agent_id, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    newTeamId,
    `${(bundle.team?.slug || "imported").replace(/[^a-z0-9-]/gi, "-")}-${suffix}`,
    teamName,
    bundle.team?.description || bundle.description || "",
    teamBrainNewId,
    bundle.team?.collaborationMode || "deliberate",
    bundle.team?.maxRounds || 2,
    leadAgentId,
    reviewerAgentId,
    senderAgentId
  );

  // 5. Place Nodes & Edges onto Canvas offset to the right so they never overlap existing graph
  const maxXRow = db.prepare("SELECT COALESCE(MAX(position_x), 0) as mx FROM canvas_nodes").get() as { mx: number };
  const offsetX = Math.max(0, maxXRow.mx + 340);

  for (const n of bundle.topology?.nodes || []) {
    const newNodeId = `node_imp_${suffix}_${Math.random().toString(36).slice(2, 6)}`;
    oldToNewNodeId.set(n.key, newNodeId);

    const data = { ...(n.data || {}) };
    let newRef = n.refKey;

    if (n.type === "main_brain" || n.type === "team_brain") {
      newRef = oldToNewBrainId.get(n.refKey) || newRef;
      if (typeof data.folderPath === "string") {
        data.folderPath = oldToNewPath.get(data.folderPath) || `${prefixFolder}/${data.folderPath}`;
      }
      if (n.type === "team_brain") data.teamId = newTeamId;
    } else if (n.type === "agent") {
      const mapped = oldToNewAgentId.get(String(data.agentId || n.refKey));
      if (mapped) {
        newRef = mapped;
        data.agentId = mapped;
      }
    } else if (n.type === "knowledge") {
      const orig = String(data.path || n.refKey);
      const mappedPath = oldToNewPath.get(orig) || `${prefixFolder}/${orig}`;
      newRef = mappedPath;
      data.path = mappedPath;
    }

    db.prepare(
      `INSERT INTO canvas_nodes (id, type, ref_id, label, position_x, position_y, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newNodeId,
      n.type,
      newRef,
      n.label,
      (n.position?.x || 0) + offsetX,
      n.position?.y || 100,
      JSON.stringify(data)
    );
  }

  for (const e of bundle.topology?.edges || []) {
    const s = oldToNewNodeId.get(e.sourceKey);
    const t = oldToNewNodeId.get(e.targetKey);
    if (!s || !t) continue;
    db.prepare(
      `INSERT INTO canvas_edges (id, source, target, relation, permission, label, animated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("edge"),
      s,
      t,
      e.relation || "brain_link",
      e.permission || "read_write",
      e.label || "",
      e.animated ? 1 : 0
    );
  }

  logAudit("admin", "bundle.import", newTeamId, `${teamName} (${importedFiles} files)`);
  return {
    teamId: newTeamId,
    teamName,
    importedBrains: bundle.brains?.length || 0,
    importedAgents: bundle.agents?.length || 0,
    importedFiles,
  };
}

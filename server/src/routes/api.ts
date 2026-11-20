import os from "node:os";
import { Router, type Request, type Response } from "express";
import { generateId } from "../config.js";
import { getDb, logAudit } from "../db/database.js";
import {
  verifyPassword,
  changePassword,
  issueToken,
  requireAuth,
  isUsingDefaultPassword,
} from "../auth/authService.js";
import {
  listBrainTree,
  readBrainFile,
  writeBrainFile,
  createBrainFolder,
  renameBrainEntry,
  deleteBrainEntry,
  searchBrainFiles,
  listSkills,
} from "../brains/brainFs.js";
import { testProviderConnection, type ProviderRecord, type LLMMessage } from "../providers/llmClient.js";
import { compileAgentRuntime, getTeamMembers } from "../engine/contextCompiler.js";
import { runAgentTurn } from "../engine/agentRunner.js";
import { runTeamMission } from "../engine/teamEngine.js";
import { listAllToolPacks } from "../tools/toolRegistry.js";
import { executeCronJob } from "../scheduler/cronEngine.js";
import { dispatchChannelNotification } from "../channels/channelManager.js";

function maskProvider(p: ProviderRecord) {
  const key = p.api_key || "";
  const masked =
    key.length > 8
      ? `${key.slice(0, 4)}••••${key.slice(-4)}`
      : key.length > 0
      ? "••••••"
      : "";
  let models: string[] = [];
  let headers: Record<string, string> = {};
  try {
    models = JSON.parse(p.models_json || "[]");
  } catch {
    models = [];
  }
  try {
    headers = JSON.parse(p.headers_json || "{}");
  } catch {
    headers = {};
  }
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.base_url,
    hasApiKey: key.trim().length > 0,
    apiKeyMasked: masked,
    defaultModel: p.default_model,
    models,
    headers,
    enabled: Boolean(p.enabled),
  };
}

export function createApiRouter(broadcast: (ev: Record<string, unknown>) => void): Router {
  const router = Router();

  // ========================
  // AUTH (Public Login)
  // ========================
  router.post("/auth/login", (req: Request, res: Response) => {
    const password = String(req.body?.password || "");
    if (!verifyPassword(password)) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }
    const token = issueToken("admin");
    logAudit("admin", "auth.login", "session", "Logged in to Pandawa");
    res.json({
      token,
      usingDefaultPassword: isUsingDefaultPassword(),
    });
  });

  // Public inbound webhook endpoint (validated by channel secret)
  router.post("/webhooks/:channelId", async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1").get(String(req.params.channelId)) as
        | { id: string; name: string; config_json: string; target_type: string; target_id: string }
        | undefined;
      if (!ch) {
        res.status(404).json({ error: "Channel not found or disabled" });
        return;
      }
      const cfg = JSON.parse(ch.config_json || "{}") as { secret?: string };
      if (cfg.secret && req.headers["x-pandawa-secret"] !== cfg.secret) {
        res.status(403).json({ error: "Invalid webhook secret" });
        return;
      }
      const prompt = String(req.body?.prompt || req.body?.message || JSON.stringify(req.body || {}));
      const sessionId = generateId("ses");
      db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
        sessionId,
        `[Webhook] ${ch.name}`,
        ch.target_type === "agent" ? "agent" : "team",
        ch.target_id || "team_pandawa"
      );
      if (ch.target_type === "agent") {
        const result = await runAgentTurn({ agentId: ch.target_id, sessionId, prompt, onEvent: broadcast });
        res.json({ ok: true, sessionId, reply: result.content });
      } else {
        const result = await runTeamMission({
          teamId: ch.target_id || "team_pandawa",
          sessionId,
          userPrompt: prompt,
          onEvent: broadcast,
        });
        res.json({ ok: true, sessionId, reply: result.synthesis.content });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // All routes below require valid auth token
  router.use(requireAuth);

  router.get("/auth/me", (_req: Request, res: Response) => {
    res.json({
      authenticated: true,
      role: "admin",
      usingDefaultPassword: isUsingDefaultPassword(),
    });
  });

  router.post("/auth/change-password", (req: Request, res: Response) => {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const result = changePassword(currentPassword, newPassword);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const token = issueToken("admin");
    res.json({ ok: true, token, usingDefaultPassword: false });
  });

  // ========================
  // VISUAL CANVAS TOPOLOGY (n8n-style Brain & Team Graph)
  // ========================
  router.get("/topology", (_req: Request, res: Response) => {
    const db = getDb();
    const nodes = db.prepare("SELECT * FROM canvas_nodes").all() as Array<{
      id: string;
      type: string;
      ref_id: string;
      label: string;
      position_x: number;
      position_y: number;
      data_json: string;
    }>;
    const edges = db.prepare("SELECT * FROM canvas_edges").all() as Array<{
      id: string;
      source: string;
      target: string;
      source_handle: string;
      target_handle: string;
      relation: string;
      permission: string;
      label: string;
      animated: number;
      data_json: string;
    }>;
    res.json({
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        refId: n.ref_id,
        label: n.label,
        position: { x: n.position_x, y: n.position_y },
        data: JSON.parse(n.data_json || "{}"),
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.source_handle || undefined,
        targetHandle: e.target_handle || undefined,
        relation: e.relation,
        permission: e.permission,
        label: e.label,
        animated: Boolean(e.animated),
        data: JSON.parse(e.data_json || "{}"),
      })),
    });
  });

  router.put("/topology", (req: Request, res: Response) => {
    const db = getDb();
    const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
    const edges = Array.isArray(req.body?.edges) ? req.body.edges : [];

    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM canvas_nodes; DELETE FROM canvas_edges;");
      const insNode = db.prepare(
        `INSERT INTO canvas_nodes (id, type, ref_id, label, position_x, position_y, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const n of nodes) {
        insNode.run(
          String(n.id || generateId("node")),
          String(n.type || "knowledge"),
          String(n.refId || n.ref_id || ""),
          String(n.label || "Node"),
          Number(n.position?.x ?? n.position_x ?? 100),
          Number(n.position?.y ?? n.position_y ?? 100),
          JSON.stringify(n.data || {})
        );
      }

      const insEdge = db.prepare(
        `INSERT INTO canvas_edges (id, source, target, source_handle, target_handle, relation, permission, label, animated, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const e of edges) {
        insEdge.run(
          String(e.id || generateId("edge")),
          String(e.source),
          String(e.target),
          String(e.sourceHandle || ""),
          String(e.targetHandle || ""),
          String(e.relation || "brain_link"),
          String(e.permission || "read_write"),
          String(e.label || ""),
          e.animated === false ? 0 : 1,
          JSON.stringify(e.data || {})
        );
      }
      db.exec("COMMIT");
      logAudit("admin", "topology.save", "canvas", `${nodes.length} nodes, ${edges.length} edges`);
      broadcast({ type: "topology_updated" });
      res.json({ ok: true, nodesCount: nodes.length, edgesCount: edges.length });
    } catch (err) {
      db.exec("ROLLBACK");
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ========================
  // BRAINS (Main / Team / Personal)
  // ========================
  router.get("/brains", (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM brains ORDER BY layer ASC, created_at ASC").all();
    res.json({ brains: rows });
  });

  router.post("/brains", (req: Request, res: Response) => {
    try {
      const db = getDb();
      const name = String(req.body?.name || "New Brain").trim();
      const layer = ["main", "team", "personal"].includes(req.body?.layer) ? req.body.layer : "team";
      const slug = (
        String(req.body?.slug || name)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-|-$/g, "") || generateId("br")
      );
      const folderPath = String(
        req.body?.folderPath ||
          (layer === "main" ? `main-brains/${slug}` : layer === "team" ? `teams/${slug}` : `agents/${slug}`)
      );
      const id = generateId("brain");
      const color = String(req.body?.color || (layer === "main" ? "#f59e0b" : layer === "team" ? "#8b5cf6" : "#06b6d4"));
      const description = String(req.body?.description || "");
      const syncPolicy = String(req.body?.syncPolicy || "read_write");

      createBrainFolder(folderPath);
      writeBrainFile(
        `${folderPath}/soul.md`,
        `# ${name} — Soul & Directive\n\n${description || "Define the core identity, goals, and rules for this brain here."}\n`
      );
      writeBrainFile(`${folderPath}/memory.md`, `# ${name} — Persistent Memory\n\n`);

      db.prepare(
        `INSERT INTO brains (id, slug, name, layer, description, folder_path, color, sync_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, slug, name, layer, description, folderPath, color, syncPolicy);

      logAudit("admin", "brain.create", id, `${name} (${layer})`);
      res.json({ id, slug, name, layer, description, folder_path: folderPath, color, sync_policy: syncPolicy });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/brains/:id", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM brains WHERE id = ?").run(String(req.params.id));
    db.prepare("DELETE FROM canvas_nodes WHERE ref_id = ?").run(String(req.params.id));
    logAudit("admin", "brain.delete", String(req.params.id));
    res.json({ ok: true });
  });

  // ========================
  // BRAIN FILE & FOLDER EXPLORER (soul.md, custom folders, FTS5 search)
  // ========================
  router.get("/files/tree", (req: Request, res: Response) => {
    try {
      const sub = typeof req.query.path === "string" ? req.query.path : "";
      res.json({ tree: listBrainTree(sub) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/files/read", (req: Request, res: Response) => {
    try {
      const rel = String(req.query.path || "");
      res.json(readBrainFile(rel));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/files/write", (req: Request, res: Response) => {
    try {
      const rel = String(req.body?.path || "");
      const content = String(req.body?.content ?? "");
      const out = writeBrainFile(rel, content);
      logAudit("admin", "brain_file.write", out.path, `${out.size} bytes`);
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/files/folder", (req: Request, res: Response) => {
    try {
      const rel = String(req.body?.path || "");
      const withStarter = Boolean(req.body?.withStarterFiles);
      const out = createBrainFolder(rel);
      if (withStarter) {
        writeBrainFile(`${out.path}/soul.md`, `# ${out.path} — Soul\n\nDefine identity, tone, and principles here.\n`);
        writeBrainFile(`${out.path}/rules.md`, `# Rules\n\n- Add behavioral rules and constraints.\n`);
        writeBrainFile(`${out.path}/memory.md`, `# Memory\n\n`);
      }
      logAudit("admin", "brain_folder.create", out.path);
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/files/rename", (req: Request, res: Response) => {
    try {
      const from = String(req.body?.from || "");
      const to = String(req.body?.to || "");
      const out = renameBrainEntry(from, to);
      logAudit("admin", "brain_file.rename", from, `-> ${to}`);
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/files/entry", (req: Request, res: Response) => {
    try {
      const rel = String(req.query.path || req.body?.path || "");
      const out = deleteBrainEntry(rel);
      logAudit("admin", "brain_file.delete", out.deleted);
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/files/search", (req: Request, res: Response) => {
    const q = String(req.query.q || "");
    res.json({ results: searchBrainFiles(q, 20) });
  });

  // ========================
  // MULTI-AI PROVIDERS (Official APIs + Custom Base URLs)
  // ========================
  router.get("/providers", (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM providers ORDER BY created_at ASC").all() as unknown as ProviderRecord[];
    res.json({ providers: rows.map(maskProvider) });
  });

  router.post("/providers", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("prov");
    const name = String(req.body?.name || "Custom AI Provider").trim();
    const kind = ["openai", "anthropic", "gemini"].includes(req.body?.kind) ? req.body.kind : "openai";
    const baseUrl = String(req.body?.baseUrl || "https://api.openai.com/v1").trim();
    const apiKey = String(req.body?.apiKey || "").trim();
    const defaultModel = String(req.body?.defaultModel || "").trim();
    const models = Array.isArray(req.body?.models)
      ? req.body.models
      : defaultModel
      ? [defaultModel]
      : [];
    const headers = req.body?.headers && typeof req.body.headers === "object" ? req.body.headers : {};
    const enabled = req.body?.enabled === false ? 0 : 1;

    db.prepare(
      `INSERT INTO providers (id, name, kind, base_url, api_key, default_model, models_json, headers_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, kind, baseUrl, apiKey, defaultModel, JSON.stringify(models), JSON.stringify(headers), enabled);

    const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as unknown as ProviderRecord;
    logAudit("admin", "provider.create", id, `${name} (${kind})`);
    res.json({ provider: maskProvider(row) });
  });

  router.patch("/providers/:id", (req: Request, res: Response) => {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM providers WHERE id = ?").get(String(req.params.id)) as unknown as ProviderRecord | undefined;
    if (!existing) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const kind = req.body?.kind !== undefined ? String(req.body.kind) : existing.kind;
    const baseUrl = req.body?.baseUrl !== undefined ? String(req.body.baseUrl).trim() : existing.base_url;
    // Only overwrite API key if explicitly provided and non-empty (or explicit clearApiKey=true)
    const apiKey =
      req.body?.clearApiKey === true
        ? ""
        : typeof req.body?.apiKey === "string" && req.body.apiKey.trim().length > 0
        ? req.body.apiKey.trim()
        : existing.api_key;
    const defaultModel =
      req.body?.defaultModel !== undefined ? String(req.body.defaultModel).trim() : existing.default_model;
    const modelsJson = Array.isArray(req.body?.models) ? JSON.stringify(req.body.models) : existing.models_json;
    const headersJson =
      req.body?.headers && typeof req.body.headers === "object"
        ? JSON.stringify(req.body.headers)
        : existing.headers_json;
    const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;

    db.prepare(
      `UPDATE providers
       SET name = ?, kind = ?, base_url = ?, api_key = ?, default_model = ?, models_json = ?, headers_json = ?, enabled = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(name, kind, baseUrl, apiKey, defaultModel, modelsJson, headersJson, enabled, String(req.params.id));

    const updated = db.prepare("SELECT * FROM providers WHERE id = ?").get(String(req.params.id)) as unknown as ProviderRecord;
    logAudit("admin", "provider.update", String(req.params.id), name);
    res.json({ provider: maskProvider(updated) });
  });

  router.delete("/providers/:id", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM providers WHERE id = ?").run(String(req.params.id));
    logAudit("admin", "provider.delete", String(req.params.id));
    res.json({ ok: true });
  });

  router.post("/providers/:id/test", async (req: Request, res: Response) => {
    const db = getDb();
    const provider = db.prepare("SELECT * FROM providers WHERE id = ?").get(String(req.params.id)) as unknown as ProviderRecord | undefined;
    if (!provider) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const result = await testProviderConnection(provider);
    res.json(result);
  });

  // ========================
  // AGENTS
  // ========================
  router.get("/agents", (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM agents ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
    res.json({
      agents: rows.map((r) => ({
        ...r,
        toolPacks: JSON.parse(String(r.tool_packs_json || "[]")),
        enabled: Boolean(r.enabled),
      })),
    });
  });

  router.post("/agents", (req: Request, res: Response) => {
    try {
      const db = getDb();
      const id = generateId("agent");
      const name = String(req.body?.name || "New Agent").trim();
      const slug =
        String(req.body?.slug || name)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-|-$/g, "") +
        "-" +
        Math.random().toString(36).slice(2, 5);
      const title = String(req.body?.title || "Team Specialist");
      const roleDesc = String(req.body?.role_description || req.body?.roleDescription || "");
      const avatar = String(req.body?.avatar || "⚡");
      const color = String(req.body?.color || "#06b6d4");
      const providerId = req.body?.provider_id || req.body?.providerId || null;
      const model = String(req.body?.model || "");
      const purpose = String(req.body?.purpose || "general");
      const temperature = Number(req.body?.temperature ?? 0.6);
      const maxTokens = Number(req.body?.max_tokens ?? req.body?.maxTokens ?? 4096);
      const systemPrompt = String(req.body?.system_prompt || req.body?.systemPrompt || "");
      const toolPacks = Array.isArray(req.body?.toolPacks) ? req.body.toolPacks : ["brain", "team", "workspace"];

      db.prepare(
        `INSERT INTO agents (id, slug, name, title, role_description, avatar, color, provider_id, model, purpose, temperature, max_tokens, system_prompt, tool_packs_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        id,
        slug,
        name,
        title,
        roleDesc,
        avatar,
        color,
        providerId,
        model,
        purpose,
        temperature,
        maxTokens,
        systemPrompt,
        JSON.stringify(toolPacks)
      );

      // Create starter personal folder with soul.md
      createBrainFolder(`agents/${slug}`);
      writeBrainFile(
        `agents/${slug}/soul.md`,
        `# ${name} — ${title}\n\n${roleDesc || systemPrompt || "Define this agent's soul, personality, and specialized workflows."}\n`
      );

      logAudit("admin", "agent.create", id, name);
      res.json({ id, slug, name, title, avatar, color, provider_id: providerId, model, purpose, toolPacks });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch("/agents/:id", (req: Request, res: Response) => {
    const db = getDb();
    const cur = db.prepare("SELECT * FROM agents WHERE id = ?").get(String(req.params.id)) as Record<string, unknown> | undefined;
    if (!cur) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const name = req.body?.name !== undefined ? String(req.body.name) : String(cur.name);
    const title = req.body?.title !== undefined ? String(req.body.title) : String(cur.title);
    const roleDesc =
      req.body?.role_description !== undefined
        ? String(req.body.role_description)
        : req.body?.roleDescription !== undefined
        ? String(req.body.roleDescription)
        : String(cur.role_description);
    const avatar = req.body?.avatar !== undefined ? String(req.body.avatar) : String(cur.avatar);
    const color = req.body?.color !== undefined ? String(req.body.color) : String(cur.color);
    const providerId =
      req.body?.provider_id !== undefined
        ? req.body.provider_id
        : req.body?.providerId !== undefined
        ? req.body.providerId
        : cur.provider_id;
    const model = req.body?.model !== undefined ? String(req.body.model) : String(cur.model);
    const purpose = req.body?.purpose !== undefined ? String(req.body.purpose) : String(cur.purpose);
    const temperature = req.body?.temperature !== undefined ? Number(req.body.temperature) : Number(cur.temperature);
    const maxTokens =
      req.body?.max_tokens !== undefined
        ? Number(req.body.max_tokens)
        : req.body?.maxTokens !== undefined
        ? Number(req.body.maxTokens)
        : Number(cur.max_tokens);
    const systemPrompt =
      req.body?.system_prompt !== undefined
        ? String(req.body.system_prompt)
        : req.body?.systemPrompt !== undefined
        ? String(req.body.systemPrompt)
        : String(cur.system_prompt);
    const toolPacksJson = Array.isArray(req.body?.toolPacks)
      ? JSON.stringify(req.body.toolPacks)
      : String(cur.tool_packs_json);
    const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : Number(cur.enabled);

    db.prepare(
      `UPDATE agents
       SET name=?, title=?, role_description=?, avatar=?, color=?, provider_id=?, model=?, purpose=?, temperature=?, max_tokens=?, system_prompt=?, tool_packs_json=?, enabled=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(
      name,
      title,
      roleDesc,
      avatar,
      color,
      providerId,
      model,
      purpose,
      temperature,
      maxTokens,
      systemPrompt,
      toolPacksJson,
      enabled,
      String(req.params.id)
    );
    logAudit("admin", "agent.update", String(req.params.id), name);
    res.json({ ok: true });
  });

  router.delete("/agents/:id", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM agents WHERE id = ?").run(String(req.params.id));
    db.prepare("DELETE FROM canvas_nodes WHERE ref_id = ?").run(String(req.params.id));
    logAudit("admin", "agent.delete", String(req.params.id));
    res.json({ ok: true });
  });

  router.get("/agents/:id/compiled", (req: Request, res: Response) => {
    try {
      const teamId = typeof req.query.teamId === "string" ? req.query.teamId : undefined;
      const compiled = compileAgentRuntime(String(req.params.id), teamId);
      res.json({
        agentId: compiled.agent.id,
        agentName: compiled.agent.name,
        provider: compiled.provider ? maskProvider(compiled.provider) : null,
        model: compiled.model,
        mainBrains: compiled.mainBrains,
        teamBrains: compiled.teamBrains,
        mountedKnowledge: compiled.mountedKnowledge.map((k) => ({
          path: k.path,
          permission: k.permission,
          fileCount: k.files.length,
          files: k.files.map((f) => f.path),
        })),
        toolPacks: compiled.toolPacks,
        peers: compiled.peers,
        summary: compiled.summary,
        systemPrompt: compiled.systemPrompt,
      });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ========================
  // TEAMS & TEAM BLACKBOARD
  // ========================
  router.get("/teams", (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM teams ORDER BY created_at ASC").all() as Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      team_brain_id: string | null;
      collaboration_mode: string;
      max_rounds: number;
      enabled: number;
    }>;
    res.json({
      teams: rows.map((t) => ({
        ...t,
        enabled: Boolean(t.enabled),
        members: getTeamMembers(t.id).map((m) => ({
          id: m.id,
          name: m.name,
          avatar: m.avatar,
          title: m.title,
          purpose: m.purpose,
          model: m.model,
          color: m.color,
        })),
      })),
    });
  });

  router.post("/teams", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("team");
    const name = String(req.body?.name || "New Team").trim();
    const slug =
      String(req.body?.slug || name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-|-$/g, "") +
      "-" +
      Math.random().toString(36).slice(2, 5);
    const description = String(req.body?.description || "");
    const mode = String(req.body?.collaboration_mode || req.body?.collaborationMode || "deliberate");
    const maxRounds = Number(req.body?.max_rounds || req.body?.maxRounds || 2);

    // Auto-create a dedicated Team Brain for this new team
    const brainId = generateId("brain");
    const folderPath = `teams/${slug}`;
    createBrainFolder(folderPath);
    writeBrainFile(`${folderPath}/team.md`, `# ${name} — Team Brain Charter\n\n${description}\n`);
    writeBrainFile(`${folderPath}/memory.md`, `# ${name} — Shared Team Memory\n\n`);

    db.prepare(
      `INSERT INTO brains (id, slug, name, layer, description, folder_path, color, sync_policy)
       VALUES (?, ?, ?, 'team', ?, ?, '#8b5cf6', 'read_write')`
    ).run(brainId, `${slug}-brain`, `Team Brain: ${name}`, description, folderPath);

    db.prepare(
      `INSERT INTO teams (id, slug, name, description, team_brain_id, collaboration_mode, max_rounds, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(id, slug, name, description, brainId, mode, maxRounds);

    logAudit("admin", "team.create", id, name);
    res.json({ id, slug, name, description, team_brain_id: brainId, collaboration_mode: mode, max_rounds: maxRounds });
  });

  router.patch("/teams/:id", (req: Request, res: Response) => {
    const db = getDb();
    const cur = db.prepare("SELECT * FROM teams WHERE id = ?").get(String(req.params.id)) as Record<string, unknown> | undefined;
    if (!cur) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    const name = req.body?.name !== undefined ? String(req.body.name) : String(cur.name);
    const description = req.body?.description !== undefined ? String(req.body.description) : String(cur.description);
    const mode =
      req.body?.collaboration_mode !== undefined
        ? String(req.body.collaboration_mode)
        : req.body?.collaborationMode !== undefined
        ? String(req.body.collaborationMode)
        : String(cur.collaboration_mode);
    const maxRounds =
      req.body?.max_rounds !== undefined
        ? Number(req.body.max_rounds)
        : req.body?.maxRounds !== undefined
        ? Number(req.body.maxRounds)
        : Number(cur.max_rounds);

    db.prepare(
      "UPDATE teams SET name=?, description=?, collaboration_mode=?, max_rounds=?, updated_at=datetime('now') WHERE id=?"
    ).run(name, description, mode, maxRounds, String(req.params.id));
    res.json({ ok: true });
  });

  router.get("/teams/:id/blackboard", (req: Request, res: Response) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM blackboard_entries WHERE team_id = ? ORDER BY created_at DESC LIMIT 40")
      .all(String(req.params.id));
    res.json({ entries: rows });
  });

  router.post("/teams/:id/blackboard", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("bb");
    db.prepare(
      `INSERT INTO blackboard_entries (id, team_id, session_id, author_agent_id, author_name, entry_type, title, content)
       VALUES (?, ?, ?, 'human', 'Admin', ?, ?, ?)`
    ).run(
      id,
      String(req.params.id),
      String(req.body?.sessionId || ""),
      String(req.body?.entryType || "decision"),
      String(req.body?.title || "Directive"),
      String(req.body?.content || "")
    );
    res.json({ id });
  });

  router.delete("/teams/:id/blackboard/:entryId", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM blackboard_entries WHERE id = ? AND team_id = ?").run(String(req.params.entryId), String(req.params.id));
    res.json({ ok: true });
  });

  // ========================
  // SESSIONS & MISSION CHAT
  // ========================
  router.get("/sessions", (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50").all();
    res.json({ sessions: rows });
  });

  router.post("/sessions", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("ses");
    const targetType = req.body?.targetType === "agent" ? "agent" : "team";
    const targetId = String(req.body?.targetId || "team_pandawa");
    const title = String(req.body?.title || "New Mission").trim();
    db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
      id,
      title,
      targetType,
      targetId
    );
    res.json({ id, title, target_type: targetType, target_id: targetId });
  });

  router.get("/sessions/:id/messages", (req: Request, res: Response) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(String(req.params.id)) as Array<Record<string, unknown>>;
    res.json({
      messages: rows.map((r) => ({
        ...r,
        toolCalls: JSON.parse(String(r.tool_calls_json || "[]")),
        meta: JSON.parse(String(r.meta_json || "{}")),
      })),
    });
  });

  router.delete("/sessions/:id", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM sessions WHERE id = ?").run(String(req.params.id));
    res.json({ ok: true });
  });

  router.post("/chat/send", async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const prompt = String(req.body?.prompt || "").trim();
      if (!prompt) {
        res.status(400).json({ error: "Prompt is required" });
        return;
      }
      const targetType = req.body?.targetType === "agent" ? "agent" : "team";
      const targetId = String(req.body?.targetId || (targetType === "team" ? "team_pandawa" : "agent_yudhistira"));
      let sessionId = String(req.body?.sessionId || "");

      if (!sessionId) {
        sessionId = generateId("ses");
        const title = prompt.slice(0, 64);
        db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
          sessionId,
          title,
          targetType,
          targetId
        );
      }

      // Load prior history for session
      const priorRows = db
        .prepare("SELECT role, agent_name, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 24")
        .all(sessionId) as Array<{ role: string; agent_name: string; content: string }>;

      const history: LLMMessage[] = priorRows
        .filter((r) => r.role === "user" || r.role === "assistant")
        .map((r) => ({
          role: r.role === "user" ? "user" : "assistant",
          content: r.content,
        }));

      // Save user message
      const userMsgId = generateId("msg");
      db.prepare(
        `INSERT INTO messages (id, session_id, role, agent_name, content) VALUES (?, ?, 'user', 'You', ?)`
      ).run(userMsgId, sessionId, prompt);

      if (targetType === "agent") {
        const result = await runAgentTurn({
          agentId: targetId,
          sessionId,
          prompt,
          history,
          onEvent: (ev) => broadcast({ ...ev, sessionId }),
        });

        const msgId = generateId("msg");
        db.prepare(
          `INSERT INTO messages (id, session_id, role, agent_id, agent_name, model_used, content, reasoning, tool_calls_json, meta_json)
           VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          msgId,
          sessionId,
          result.agentId,
          result.agentName,
          result.model,
          result.content,
          result.reasoning,
          JSON.stringify(result.toolTrace),
          JSON.stringify({
            avatar: result.avatar,
            providerName: result.providerName,
            durationMs: result.durationMs,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            dryRun: result.dryRun,
          })
        );
        db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);

        res.json({ ok: true, sessionId, mode: "agent", result });
        return;
      }

      // Team Mission (Musyawarah & Eksekusi)
      const activeAgentIds = Array.isArray(req.body?.activeAgentIds) ? (req.body.activeAgentIds as string[]) : undefined;
      const teamResult = await runTeamMission({
        teamId: targetId,
        sessionId,
        userPrompt: prompt,
        history,
        activeAgentIds,
        onEvent: (ev) => broadcast({ ...ev, sessionId }),
      });

      res.json({ ok: true, sessionId, mode: "team", result: teamResult });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ========================
  // SKILLS & MEMORIES
  // ========================
  router.get("/skills", (_req: Request, res: Response) => {
    res.json({ skills: listSkills() });
  });

  router.post("/skills", (req: Request, res: Response) => {
    try {
      const slug = String(req.body?.slug || "custom-skill").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
      const title = String(req.body?.title || slug);
      const description = String(req.body?.description || "");
      const instructions = String(req.body?.instructions || "");
      const brainFolder = String(req.body?.brainFolder || "main-brain");
      const relPath = `${brainFolder}/skills/${slug}/SKILL.md`;
      const md = `---\nname: ${title}\ndescription: ${description}\n---\n\n# ${title}\n\n${instructions}\n`;
      writeBrainFile(relPath, md);
      logAudit("admin", "skill.create", relPath);
      res.json({ ok: true, path: relPath });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/memories", (req: Request, res: Response) => {
    const db = getDb();
    const brainId = typeof req.query.brainId === "string" ? req.query.brainId : "";
    const rows = brainId
      ? db.prepare("SELECT * FROM memories WHERE brain_id = ? ORDER BY created_at DESC LIMIT 80").all(brainId)
      : db.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT 80").all();
    res.json({ memories: rows });
  });

  router.post("/memories", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("mem");
    const brainId = String(req.body?.brainId || "brain_main");
    const category = String(req.body?.category || "fact");
    const content = String(req.body?.content || "").trim();
    const importance = Math.min(10, Math.max(1, Number(req.body?.importance || 6)));
    if (!content) {
      res.status(400).json({ error: "Content is required" });
      return;
    }
    db.prepare(
      "INSERT INTO memories (id, brain_id, agent_id, category, content, importance) VALUES (?, ?, 'admin', ?, ?, ?)"
    ).run(id, brainId, category, content, importance);
    db.prepare("INSERT INTO memories_fts (memory_id, brain_id, category, content) VALUES (?, ?, ?, ?)").run(
      id,
      brainId,
      category,
      content
    );
    res.json({ id });
  });

  router.delete("/memories/:id", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM memories WHERE id = ?").run(String(req.params.id));
    db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(String(req.params.id));
    res.json({ ok: true });
  });

  // ========================
  // CRON SCHEDULER, CHANNELS, MCP, TOOLS
  // ========================
  router.get("/cron", (_req: Request, res: Response) => {
    const db = getDb();
    res.json({ jobs: db.prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC").all() });
  });

  router.post("/cron", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("cron");
    db.prepare(
      `INSERT INTO cron_jobs (id, name, schedule, target_type, target_id, prompt, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      String(req.body?.name || "Scheduled Mission"),
      String(req.body?.schedule || "0 9 * * *"),
      String(req.body?.targetType || "team"),
      String(req.body?.targetId || "team_pandawa"),
      String(req.body?.prompt || "")
    );
    res.json({ id });
  });

  router.patch("/cron/:id", (req: Request, res: Response) => {
    const db = getDb();
    const enabled = req.body?.enabled ? 1 : 0;
    db.prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?").run(enabled, String(req.params.id));
    res.json({ ok: true });
  });

  router.delete("/cron/:id", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(String(req.params.id));
    res.json({ ok: true });
  });

  router.post("/cron/:id/run", async (req: Request, res: Response) => {
    try {
      const out = await executeCronJob(String(req.params.id), broadcast);
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/channels", (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM channels ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    res.json({
      channels: rows.map((r) => ({
        ...r,
        config: JSON.parse(String(r.config_json || "{}")),
        enabled: Boolean(r.enabled),
      })),
    });
  });

  router.post("/channels", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("ch");
    db.prepare(
      `INSERT INTO channels (id, name, type, config_json, target_type, target_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      String(req.body?.name || "New Channel"),
      String(req.body?.type || "webhook"),
      JSON.stringify(req.body?.config || {}),
      String(req.body?.targetType || "team"),
      String(req.body?.targetId || "team_pandawa")
    );
    res.json({ id });
  });

  router.post("/channels/:id/test", async (req: Request, res: Response) => {
    const out = await dispatchChannelNotification(
      String(req.params.id),
      "Pandawa Channel Test",
      "Connection verified from Pandawa Agentic Team Platform."
    );
    res.json(out);
  });

  router.delete("/channels/:id", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM channels WHERE id = ?").run(String(req.params.id));
    res.json({ ok: true });
  });

  router.get("/mcp", (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM mcp_servers ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    res.json({
      servers: rows.map((r) => ({
        ...r,
        headers: JSON.parse(String(r.headers_json || "{}")),
        enabled: Boolean(r.enabled),
      })),
    });
  });

  router.post("/mcp", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("mcp");
    db.prepare(
      `INSERT INTO mcp_servers (id, name, transport, url_or_cmd, headers_json, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      String(req.body?.name || "MCP Server"),
      String(req.body?.transport || "http"),
      String(req.body?.urlOrCmd || ""),
      JSON.stringify(req.body?.headers || {})
    );
    res.json({ id });
  });

  router.delete("/mcp/:id", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(String(req.params.id));
    res.json({ ok: true });
  });

  router.get("/tools", (_req: Request, res: Response) => {
    res.json({ packs: listAllToolPacks() });
  });

  // ========================
  // SYSTEM HEALTH, USAGE & AUDIT
  // ========================
  router.get("/system/status", (_req: Request, res: Response) => {
    const db = getDb();
    const counts = {
      brains: (db.prepare("SELECT COUNT(*) as c FROM brains").get() as { c: number }).c,
      agents: (db.prepare("SELECT COUNT(*) as c FROM agents").get() as { c: number }).c,
      teams: (db.prepare("SELECT COUNT(*) as c FROM teams").get() as { c: number }).c,
      providers: (db.prepare("SELECT COUNT(*) as c FROM providers").get() as { c: number }).c,
      configuredProviders: (
        db.prepare("SELECT COUNT(*) as c FROM providers WHERE enabled=1 AND length(trim(api_key)) > 0 AND api_key != 'ollama'").get() as {
          c: number;
        }
      ).c,
      sessions: (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c,
      memories: (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c,
      skills: listSkills().length,
      cronJobs: (db.prepare("SELECT COUNT(*) as c FROM cron_jobs").get() as { c: number }).c,
    };

    const usage = db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens), 0) as promptTokens,
                COALESCE(SUM(completion_tokens), 0) as completionTokens,
                COUNT(*) as calls
         FROM usage_logs`
      )
      .get();

    res.json({
      version: "1.0.0",
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.release()}`,
      hostname: os.hostname(),
      memory: {
        totalMb: Math.round(os.totalmem() / 1024 / 1024),
        freeMb: Math.round(os.freemem() / 1024 / 1024),
        processRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      usingDefaultPassword: isUsingDefaultPassword(),
      counts,
      usage,
    });
  });

  router.get("/system/audit", (_req: Request, res: Response) => {
    const db = getDb();
    const logs = db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 80").all();
    res.json({ logs });
  });

  router.get("/system/usage", (_req: Request, res: Response) => {
    const db = getDb();
    const logs = db.prepare("SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT 80").all();
    res.json({ logs });
  });

  return router;
}

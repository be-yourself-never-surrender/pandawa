import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Router, type Request, type Response } from "express";
import { PANDAWA_VERSION, generateId } from "../config.js";
import { getDb, getSetting, setSetting, logAudit } from "../db/database.js";
import {
  verifyPassword,
  changePassword,
  issueToken,
  issueWsTicket,
  requireAuth,
  isUsingDefaultPassword,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
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
  getBrainLinkGraph,
  resolveBrainPath,
  reindexAllBrainFiles,
} from "../brains/brainFs.js";
import {
  previewSkillInstall,
  installSkillsFromSource,
  uninstallSkill,
  type UploadedSkillFileInput,
} from "../skills/skillInstaller.js";
import {
  testProviderConnection,
  type ProviderRecord,
  type LLMMessage,
  type LLMImageAttachment,
} from "../providers/llmClient.js";
import { compileAgentRuntime, getTeamMembers } from "../engine/contextCompiler.js";
import { runAgentTurn } from "../engine/agentRunner.js";
import { runTeamMission } from "../engine/teamEngine.js";
import { listAllToolPacks } from "../tools/toolRegistry.js";
import { executeCronJob } from "../scheduler/cronEngine.js";
import {
  dispatchChannelNotification,
  decryptChannelConfig,
  syncTelegramPollers,
  getTelegramPollerStatuses,
} from "../channels/channelManager.js";
import { encryptSecret, decryptSecret } from "../auth/cryptoVault.js";
import {
  getApprovalMode,
  setApprovalMode,
  listPendingApprovals,
  resolveApproval,
  type ApprovalMode,
} from "../engine/approvalManager.js";
import { discoverMcpTools, type McpServerRow } from "../mcp/mcpClient.js";
import { exportTeamBundle, importTeamBundle, type PandawaBundle } from "../bundles/bundleService.js";
import {
  registerMissionController,
  clearMissionController,
  abortMission,
} from "../engine/missionController.js";
import {
  listBackgroundJobs,
  cancelBackgroundJob,
  enqueueBackgroundMission,
} from "../engine/backgroundRunner.js";
import {
  listManagedProcesses,
  getManagedProcessLogs,
  killManagedProcess,
} from "../tools/processManager.js";
import {
  listTerminals,
  openTerminal,
  execInTerminal,
  sendKeysToTerminal,
  readTerminal,
  closeTerminal,
} from "../tools/terminalManager.js";
import { getPythonWorkerStatus, runPythonWorker } from "../tools/pythonWorker.js";
import {
  getSemanticBrainStatus,
  reindexSemanticBrain,
  semanticBrainSearch,
} from "../brains/semanticMemory.js";
import {
  getHeartbeatConfig,
  updateHeartbeatConfig,
  listHeartbeatLogs,
  runHeartbeatPulse,
} from "../engine/heartbeatDaemon.js";

function maskProvider(p: ProviderRecord) {
  const key = decryptSecret(p.api_key || "");
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
    encryptedAtRest: (p.api_key || "").startsWith("enc:v1:"),
    defaultModel: p.default_model,
    models,
    headers,
    enabled: Boolean(p.enabled),
  };
}

const CHANNEL_SECRET_KEYS = new Set(["botToken", "webhookUrl", "secret"]);
const webhookHits = new Map<string, { count: number; windowStart: number }>();

function maskSecretValue(val: string): string {
  const plain = decryptSecret(val || "");
  if (!plain) return "";
  if (plain.length > 8) return `${plain.slice(0, 4)}••••${plain.slice(-4)}`;
  return "••••••";
}

function safeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function createApiRouter(broadcast: (ev: Record<string, unknown>) => void): Router {
  const router = Router();

  // ========================
  // AUTH (Public Login with Per-IP Rate Limit + Lockout)
  // ========================
  router.post("/auth/login", (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const rl = checkLoginRateLimit(ip);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      res.status(429).json({
        error: `Too many failed login attempts. Try again in ${rl.retryAfterSec}s.`,
        retryAfterSec: rl.retryAfterSec,
      });
      return;
    }

    const password = String(req.body?.password || "");
    if (!verifyPassword(password)) {
      const fail = recordLoginFailure(ip);
      if (fail.locked) {
        res.setHeader("Retry-After", String(fail.retryAfterSec));
      }
      logAudit("anon", "auth.login_failed", ip, `Login rejected (locked=${fail.locked})`);
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    clearLoginFailures(ip);
    const token = issueToken("admin");
    logAudit("admin", "auth.login", "session", "Logged in to Pandawa");
    res.json({
      token,
      usingDefaultPassword: isUsingDefaultPassword(),
    });
  });

  // Public inbound webhook endpoint (MANDATORY secret validated via constant-time compare + rate limit)
  router.post("/webhooks/:channelId", async (req: Request, res: Response) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const now = Date.now();
      const wh = webhookHits.get(ip);
      if (wh && now - wh.windowStart < 60_000) {
        if (wh.count >= 30) {
          res.status(429).json({ error: "Webhook rate limit exceeded (30/min)" });
          return;
        }
        wh.count += 1;
      } else {
        webhookHits.set(ip, { count: 1, windowStart: now });
      }

      const db = getDb();
      const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND enabled = 1").get(String(req.params.channelId)) as
        | { id: string; name: string; config_json: string; target_type: string; target_id: string }
        | undefined;
      if (!ch) {
        res.status(404).json({ error: "Channel not found or disabled" });
        return;
      }
      const cfg = decryptChannelConfig(ch.config_json);
      const expectedSecret = (cfg.secret || "").trim();
      const providedSecret = String(req.headers["x-pandawa-secret"] || "");
      if (!expectedSecret) {
        res.status(403).json({ error: "Webhook channel has no secret configured; refusing unauthenticated trigger." });
        return;
      }
      if (!providedSecret || !safeEqualStrings(providedSecret, expectedSecret)) {
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

  // All routes below require valid Authorization: Bearer <token> header
  router.use(requireAuth);

  // Single-use short-lived WebSocket ticket (30s) so JWT never appears in WebSocket URLs
  router.post("/auth/ws-ticket", (_req: Request, res: Response) => {
    res.json(issueWsTicket("admin"));
  });

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

  router.post("/files/upload", async (req: Request, res: Response) => {
    try {
      const folder = String(req.body?.folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const files = Array.isArray(req.body?.files)
        ? (req.body.files as Array<{ name: string; content?: string; base64?: string }>)
        : [];
      if (files.length === 0) {
        res.status(400).json({ error: "No files provided" });
        return;
      }

      const saved: string[] = [];
      let convertedDocs = 0;
      let skipped = 0;
      const richExts = new Set([".pdf", ".docx", ".xlsx", ".xlsm"]);

      for (const f of files) {
        const cleanName = String(f.name || "untitled.md").replace(/\\/g, "/").replace(/^\/+/, "");
        if (!cleanName || cleanName.includes("..")) {
          skipped++;
          continue;
        }
        const ext = path.extname(cleanName).toLowerCase();

        // 1. ZIP Archive Import (safe extraction preserving subfolders + auto-converting PDF/DOCX/XLSX!)
        if (ext === ".zip" && f.base64) {
          const buf = Buffer.from(String(f.base64).replace(/^data:[^;]+;base64,/, ""), "base64");
          const tmpZip = path.join(os.tmpdir(), `pandawa_import_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.zip`);
          fs.writeFileSync(tmpZip, buf);
          try {
            const targetDir = resolveBrainPath(folder);
            const zRes = await runPythonWorker<{
              ok?: boolean;
              count?: number;
              convertedDocs?: number;
              skipped?: number;
              paths?: string[];
              error?: string;
            }>(
              "import_zip",
              { zipPath: tmpZip, targetDir, relPrefix: folder },
              120_000
            );
            if (!zRes.ok) {
              throw new Error(zRes.error || "ZIP import failed");
            }
            for (const p of zRes.paths || []) saved.push(p);
            convertedDocs += Number(zRes.convertedDocs || 0);
            skipped += Number(zRes.skipped || 0);
          } finally {
            try {
              fs.unlinkSync(tmpZip);
            } catch {
              // ignore
            }
          }
          continue;
        }

        // 2. Standalone Rich Document Import (PDF / DOCX / XLSX -> clean Markdown)
        if (richExts.has(ext) && f.base64) {
          const buf = Buffer.from(String(f.base64).replace(/^data:[^;]+;base64,/, ""), "base64");
          const tmpDoc = path.join(os.tmpdir(), `pandawa_doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
          fs.writeFileSync(tmpDoc, buf);
          try {
            const parsed = await runPythonWorker<{ ok?: boolean; format?: string; text?: string; error?: string }>(
              "doc_read",
              { path: tmpDoc, maxChars: 80_000 },
              60_000
            );
            if (!parsed.ok) {
              skipped++;
              continue;
            }
            const mdName = cleanName.slice(0, -ext.length) + ".md";
            const relPath = folder ? `${folder}/${mdName}` : mdName;
            const mdBody = `# ${path.basename(cleanName)}\n\n> Converted automatically from \`${cleanName}\` (${parsed.format || ext})\n\n${parsed.text || ""}\n`;
            writeBrainFile(relPath, mdBody);
            saved.push(relPath);
            convertedDocs++;
          } finally {
            try {
              fs.unlinkSync(tmpDoc);
            } catch {
              // ignore
            }
          }
          continue;
        }

        // 3. Regular Text / Markdown / Code File (supports full folder relative paths e.g. my-vault/sub/note.md)
        const relPath = folder ? `${folder}/${cleanName}` : cleanName;
        writeBrainFile(relPath, String(f.content ?? ""));
        saved.push(relPath);
      }

      reindexAllBrainFiles();
      reindexSemanticBrain().catch(() => {});
      logAudit(
        "admin",
        "brain_file.upload",
        folder || "root",
        `${saved.length} file(s) imported (${convertedDocs} rich docs converted, ${skipped} skipped)`
      );
      res.json({ ok: true, count: saved.length, convertedDocs, skipped, paths: saved.slice(0, 200) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
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
    const apiKeyRaw = String(req.body?.apiKey || "").trim();
    const apiKey = apiKeyRaw ? encryptSecret(apiKeyRaw) : "";
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
        ? encryptSecret(req.body.apiKey.trim())
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
    const maxIterations = Math.min(
      100,
      Math.max(
        1,
        req.body?.max_iterations !== undefined
          ? Number(req.body.max_iterations)
          : req.body?.maxIterations !== undefined
          ? Number(req.body.maxIterations)
          : Number(cur.max_iterations || 35)
      )
    );
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
       SET name=?, title=?, role_description=?, avatar=?, color=?, provider_id=?, model=?, purpose=?, temperature=?, max_tokens=?, max_iterations=?, system_prompt=?, tool_packs_json=?, enabled=?, updated_at=datetime('now')
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
      maxIterations,
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

  router.delete("/teams/:id", (req: Request, res: Response) => {
    const db = getDb();
    const teamId = String(req.params.id);
    const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as
      | { id: string; team_brain_id?: string | null }
      | undefined;
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }

    // Collect Team Brain node + its direct squad agent nodes to remove cleanly from canvas
    const tbNodeIds = new Set<string>();
    const allNodes = db.prepare("SELECT id, type, ref_id, data_json FROM canvas_nodes").all() as Array<{
      id: string;
      type: string;
      ref_id: string;
      data_json: string;
    }>;
    const allEdges = db.prepare("SELECT id, source, target FROM canvas_edges").all() as Array<{
      id: string;
      source: string;
      target: string;
    }>;

    for (const n of allNodes) {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(n.data_json || "{}");
      } catch {
        // ignore
      }
      if (n.type === "team_brain" && (n.ref_id === team.team_brain_id || data.teamId === teamId)) {
        tbNodeIds.add(n.id);
      }
    }

    const nodeIdsToRemove = new Set<string>(tbNodeIds);
    const agentIdsToRemove = new Set<string>();
    const nodeById = new Map(allNodes.map((n) => [n.id, n]));

    if (req.query.cascade !== "false") {
      for (const e of allEdges) {
        let other: (typeof allNodes)[number] | undefined;
        if (tbNodeIds.has(e.source)) other = nodeById.get(e.target);
        else if (tbNodeIds.has(e.target)) other = nodeById.get(e.source);
        if (other && other.type === "agent") {
          nodeIdsToRemove.add(other.id);
          if (other.ref_id) agentIdsToRemove.add(other.ref_id);
        }
      }
    }

    for (const nid of nodeIdsToRemove) {
      db.prepare("DELETE FROM canvas_edges WHERE source = ? OR target = ?").run(nid, nid);
      db.prepare("DELETE FROM canvas_nodes WHERE id = ?").run(nid);
    }
    for (const aid of agentIdsToRemove) {
      db.prepare("DELETE FROM agents WHERE id = ?").run(aid);
    }
    if (team.team_brain_id) {
      db.prepare("DELETE FROM brains WHERE id = ?").run(team.team_brain_id);
    }
    db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);

    logAudit("admin", "team.delete", teamId, `Removed team + ${nodeIdsToRemove.size} canvas nodes`);
    broadcast({ type: "topology_updated" });
    res.json({ ok: true, removedNodes: nodeIdsToRemove.size });
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
  // SHARED TEAM TASK BOARD & MANAGED BACKGROUND PROCESSES
  // ========================
  router.get("/teams/:id/tasks", (req: Request, res: Response) => {
    const db = getDb();
    const tasks = db
      .prepare("SELECT * FROM team_tasks WHERE team_id = ? ORDER BY updated_at DESC LIMIT 50")
      .all(String(req.params.id));
    res.json({ tasks });
  });

  router.post("/teams/:id/tasks", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("tsk");
    db.prepare(
      `INSERT INTO team_tasks (id, team_id, session_id, title, owner_agent, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      String(req.params.id),
      String(req.body?.sessionId || ""),
      String(req.body?.title || "New Task"),
      String(req.body?.ownerAgent || "Team"),
      String(req.body?.status || "todo"),
      String(req.body?.notes || "")
    );
    broadcast({ type: "team_task_updated", teamId: String(req.params.id), id });
    res.json({ id });
  });

  router.patch("/teams/:id/tasks/:taskId", (req: Request, res: Response) => {
    const db = getDb();
    const cur = db
      .prepare("SELECT * FROM team_tasks WHERE id = ? AND team_id = ?")
      .get(String(req.params.taskId), String(req.params.id)) as Record<string, unknown> | undefined;
    if (!cur) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    db.prepare(
      `UPDATE team_tasks SET title=?, owner_agent=?, status=?, notes=?, updated_at=datetime('now') WHERE id=?`
    ).run(
      req.body?.title !== undefined ? String(req.body.title) : String(cur.title),
      req.body?.ownerAgent !== undefined ? String(req.body.ownerAgent) : String(cur.owner_agent),
      req.body?.status !== undefined ? String(req.body.status) : String(cur.status),
      req.body?.notes !== undefined ? String(req.body.notes) : String(cur.notes),
      String(req.params.taskId)
    );
    broadcast({ type: "team_task_updated", teamId: String(req.params.id), id: String(req.params.taskId) });
    res.json({ ok: true });
  });

  router.delete("/teams/:id/tasks/:taskId", (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM team_tasks WHERE id = ? AND team_id = ?").run(
      String(req.params.taskId),
      String(req.params.id)
    );
    res.json({ ok: true });
  });

  router.get("/processes", (_req: Request, res: Response) => {
    res.json({ processes: listManagedProcesses() });
  });

  router.get("/processes/:id/logs", (req: Request, res: Response) => {
    const tail = Number(req.query.tail || 100);
    const out = getManagedProcessLogs(String(req.params.id), tail);
    if (!out) {
      res.status(404).json({ error: "Process not found" });
      return;
    }
    res.json(out);
  });

  router.post("/processes/:id/kill", (req: Request, res: Response) => {
    const ok = killManagedProcess(String(req.params.id));
    res.json({ ok });
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

  router.post("/chat/abort", (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || "*");
    const stopped = abortMission(sessionId);
    broadcast({ type: "mission_aborted", sessionId });
    res.json({ ok: true, stopped, sessionId });
  });

  router.post("/chat/send", async (req: Request, res: Response) => {
    let activeSessionId = "";
    let controller: AbortController | undefined;
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

      activeSessionId = sessionId;
      controller = registerMissionController(sessionId);

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

      // Expand inline @brain/file.md references cleanly (like Hermes @ context injection)
      let enrichedPrompt = prompt;
      const atMatches = Array.from(prompt.matchAll(/@([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/g));
      if (atMatches.length > 0) {
        const inlineDocs: string[] = [];
        const seen = new Set<string>();
        for (const m of atMatches) {
          const rel = m[1];
          if (seen.has(rel)) continue;
          seen.add(rel);
          try {
            const f = readBrainFile(rel);
            inlineDocs.push(`### Referenced File: @${rel}\n\`\`\`\n${f.content.slice(0, 6000)}\n\`\`\``);
          } catch {
            // ignore non-existent @mentions
          }
        }
        if (inlineDocs.length > 0) {
          enrichedPrompt = `${prompt}\n\n---\n${inlineDocs.join("\n\n")}`;
        }
      }

      // Parse optional Multimodal Vision image attachments
      const rawImages = Array.isArray(req.body?.images) ? req.body.images : [];
      const images: LLMImageAttachment[] = rawImages
        .filter((img: unknown) => img && typeof img === "object" && typeof (img as Record<string, unknown>).base64 === "string")
        .slice(0, 4)
        .map((img: Record<string, unknown>) => ({
          mimeType: String(img.mimeType || "image/png"),
          base64: String(img.base64).replace(/^data:[^;]+;base64,/, ""),
          name: img.name ? String(img.name) : undefined,
        }));

      const modeOverride = typeof req.body?.modeOverride === "string" ? req.body.modeOverride : undefined;
      const runInBackground = Boolean(req.body?.background);
      const notifyChannelId = typeof req.body?.notifyChannelId === "string" ? req.body.notifyChannelId : "";
      const activeAgentIds = Array.isArray(req.body?.activeAgentIds) ? (req.body.activeAgentIds as string[]) : undefined;

      // Save user message & index in messages_fts for session_search recall
      const userMsgId = generateId("msg");
      const userContentLabel =
        images.length > 0 ? `${prompt}\n\n[Attached ${images.length} image(s): ${images.map((i) => i.name || "image").join(", ")}]` : prompt;
      db.prepare(
        `INSERT INTO messages (id, session_id, role, agent_name, content) VALUES (?, ?, 'user', 'You', ?)`
      ).run(userMsgId, sessionId, userContentLabel);
      try {
        db.prepare(`INSERT INTO messages_fts (message_id, session_id, agent_name, content) VALUES (?, ?, 'You', ?)`).run(
          userMsgId,
          sessionId,
          prompt
        );
      } catch {
        // ignore FTS error
      }

      // Decoupled Always-On Background Daemon execution (survives browser close!)
      if (runInBackground) {
        clearMissionController(sessionId, controller);
        const queued = enqueueBackgroundMission({
          sessionId,
          targetType: targetType === "agent" ? "agent" : "team",
          targetId,
          prompt,
          enrichedPrompt,
          images,
          history,
          activeAgentIds,
          modeOverride,
          notifyChannelId,
          broadcast,
        });
        res.json({ ok: true, background: true, ...queued });
        return;
      }

      if (targetType === "agent") {
        const result = await runAgentTurn({
          agentId: targetId,
          sessionId,
          prompt: enrichedPrompt,
          images,
          history,
          signal: controller.signal,
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
            stepsUsed: result.stepsUsed,
            durationMs: result.durationMs,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          })
        );
        try {
          db.prepare(`INSERT INTO messages_fts (message_id, session_id, agent_name, content) VALUES (?, ?, ?, ?)`).run(
            msgId,
            sessionId,
            result.agentName,
            result.content
          );
        } catch {
          // ignore
        }
        db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);

        res.json({ ok: true, sessionId, mode: "agent", result });
        return;
      }

      // Team Mission (Execute & Verify / Musyawarah)
      const teamResult = await runTeamMission({
        teamId: targetId,
        sessionId,
        userPrompt: enrichedPrompt,
        images,
        history,
        activeAgentIds,
        modeOverride,
        signal: controller.signal,
        onEvent: (ev) => broadcast({ ...ev, sessionId }),
      });

      res.json({ ok: true, sessionId, mode: "team", result: teamResult });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAborted = /aborted|stopped by user/i.test(msg);
      const statusCode = (err as { statusCode?: number })?.statusCode || (isAborted ? 499 : 500);
      res.status(statusCode).json({ error: msg, aborted: isAborted });
    } finally {
      if (activeSessionId) clearMissionController(activeSessionId, controller);
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

  // Skill Installer: Preview & Security Scan (GitHub repo/folder, raw SKILL.md URL, .zip URL, or uploaded files)
  router.post("/skills/preview", async (req: Request, res: Response) => {
    try {
      const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
      const files = Array.isArray(req.body?.files) ? (req.body.files as UploadedSkillFileInput[]) : undefined;
      const brainFolder = typeof req.body?.brainFolder === "string" ? req.body.brainFolder.trim() : "main-brain";
      if (!source && (!files || files.length === 0)) {
        res.status(400).json({ error: "Provide a skill source (GitHub repo/URL) or upload skill files/.zip." });
        return;
      }
      const result = await previewSkillInstall({
        source: source || undefined,
        files,
        brainFolder,
        allowLocalPath: false, // Strictly disallow server-local paths over HTTP
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Skill Installer: Commit selected skills into target Brain vault + provenance metadata + FTS5/semantic reindex
  router.post("/skills/install", async (req: Request, res: Response) => {
    try {
      const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
      const files = Array.isArray(req.body?.files) ? (req.body.files as UploadedSkillFileInput[]) : undefined;
      const brainFolder = typeof req.body?.brainFolder === "string" ? req.body.brainFolder.trim() : "main-brain";
      const selectedSlugs = Array.isArray(req.body?.selectedSlugs)
        ? (req.body.selectedSlugs as unknown[]).map((s) => String(s))
        : undefined;
      const overwrite = Boolean(req.body?.overwrite);
      if (!source && (!files || files.length === 0)) {
        res.status(400).json({ error: "Provide a skill source (GitHub repo/URL) or upload skill files/.zip." });
        return;
      }
      const result = await installSkillsFromSource({
        source: source || undefined,
        files,
        brainFolder,
        selectedSlugs,
        overwrite,
        allowLocalPath: false,
      });
      logAudit(
        "admin",
        "skill.install",
        result.source,
        `installed=${result.installed.map((s) => s.slug).join(",") || "none"} brain=${result.brainFolder}`
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Uninstall a single skill directory/file (guarded to only allow paths under */skills/<slug>)
  router.delete("/skills", (req: Request, res: Response) => {
    try {
      const target = String(req.query.dirPath || req.query.path || req.body?.dirPath || req.body?.path || "").trim();
      if (!target) {
        res.status(400).json({ error: "Skill dirPath or path is required." });
        return;
      }
      const out = uninstallSkill(target);
      logAudit("admin", "skill.uninstall", out.deleted);
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/memories", (req: Request, res: Response) => {
    const db = getDb();
    const brainId = typeof req.query.brainId === "string" ? req.query.brainId : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      const safe = q
        .replace(/["'*^():-]/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t}"*`)
        .join(" OR ");
      if (safe) {
        try {
          const matched = db
            .prepare(
              `SELECT m.* FROM memories m
               JOIN memories_fts f ON f.memory_id = m.id
               WHERE memories_fts MATCH ?
               ORDER BY m.importance DESC, m.created_at DESC LIMIT 80`
            )
            .all(safe);
          res.json({ memories: matched });
          return;
        } catch {
          // fallback to normal listing
        }
      }
    }
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
    const pollers = getTelegramPollerStatuses();
    res.json({
      channels: rows.map((r) => {
        const rawCfg = JSON.parse(String(r.config_json || "{}")) as Record<string, string>;
        const maskedCfg: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawCfg)) {
          maskedCfg[k] = CHANNEL_SECRET_KEYS.has(k) ? maskSecretValue(v) : v;
        }
        return {
          id: r.id,
          name: r.name,
          type: r.type,
          target_type: r.target_type,
          target_id: r.target_id,
          created_at: r.created_at,
          config: maskedCfg,
          enabled: Boolean(r.enabled),
          poller: pollers.find((p) => p.channelId === String(r.id)) || null,
        };
      }),
    });
  });

  router.post("/channels", (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("ch");
    const type = String(req.body?.type || "webhook");
    const incomingCfg = (req.body?.config && typeof req.body.config === "object"
      ? req.body.config
      : {}) as Record<string, unknown>;
    const encryptedCfg: Record<string, string> = {};
    let generatedWebhookSecret = "";

    for (const [k, v] of Object.entries(incomingCfg)) {
      const sv = String(v ?? "").trim();
      encryptedCfg[k] = CHANNEL_SECRET_KEYS.has(k) && sv ? encryptSecret(sv) : sv;
    }

    // Ensure every webhook channel ALWAYS has a strong secret (auto-generated if omitted)
    if (type === "webhook" && !encryptedCfg.secret) {
      generatedWebhookSecret = crypto.randomBytes(24).toString("hex");
      encryptedCfg.secret = encryptSecret(generatedWebhookSecret);
    }

    db.prepare(
      `INSERT INTO channels (id, name, type, config_json, target_type, target_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      String(req.body?.name || "New Channel"),
      type,
      JSON.stringify(encryptedCfg),
      String(req.body?.targetType || "team"),
      String(req.body?.targetId || "team_pandawa")
    );
    syncTelegramPollers(broadcast);
    res.json({ id, ...(generatedWebhookSecret ? { webhookSecret: generatedWebhookSecret } : {}) });
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
    syncTelegramPollers(broadcast);
    res.json({ ok: true });
  });

  const handleListMcp = (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM mcp_servers ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    res.json({
      servers: rows.map((r) => {
        const rawHdrs = JSON.parse(String(r.headers_json || "{}")) as Record<string, string>;
        const maskedHdrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawHdrs)) {
          maskedHdrs[k] = maskSecretValue(v);
        }
        return {
          id: r.id,
          name: r.name,
          transport: r.transport,
          url_or_cmd: r.url_or_cmd,
          created_at: r.created_at,
          headers: maskedHdrs,
          enabled: Boolean(r.enabled),
        };
      }),
    });
  };

  const handleCreateMcp = (req: Request, res: Response) => {
    const db = getDb();
    const id = generateId("mcp");
    const rawHdrs = (req.body?.headers && typeof req.body.headers === "object"
      ? req.body.headers
      : {}) as Record<string, unknown>;
    const encHdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHdrs)) {
      const sv = String(v ?? "").trim();
      encHdrs[k] = sv ? encryptSecret(sv) : "";
    }
    db.prepare(
      `INSERT INTO mcp_servers (id, name, transport, url_or_cmd, headers_json, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(
      id,
      String(req.body?.name || "MCP Server"),
      String(req.body?.transport || "http"),
      String(req.body?.urlOrCmd || ""),
      JSON.stringify(encHdrs)
    );
    res.json({ id });
  };

  const handleDiscoverMcp = async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const srv = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(String(req.params.id)) as unknown as
        | McpServerRow
        | undefined;
      if (!srv) {
        res.status(404).json({ error: "MCP server not found" });
        return;
      }
      const tools = await discoverMcpTools(srv, true);
      res.json({ ok: true, count: tools.length, tools });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleDeleteMcp = (req: Request, res: Response) => {
    const db = getDb();
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(String(req.params.id));
    res.json({ ok: true });
  };

  router.get("/connectors", handleListMcp);
  router.post("/connectors", handleCreateMcp);
  router.post("/connectors/:id/discover", handleDiscoverMcp);
  router.delete("/connectors/:id", handleDeleteMcp);

  router.get("/mcp", handleListMcp);
  router.post("/mcp", handleCreateMcp);
  router.post("/mcp/:id/discover", handleDiscoverMcp);
  router.delete("/mcp/:id", handleDeleteMcp);

  // ========================
  // USER-CONTROLLED APPROVAL GATE (No Hidden Guardrails)
  // ========================
  router.get("/approvals", (_req: Request, res: Response) => {
    res.json({
      mode: getApprovalMode(),
      pending: listPendingApprovals(),
    });
  });

  router.put("/approvals/mode", (req: Request, res: Response) => {
    const mode = String(req.body?.mode || "approve_shell") as ApprovalMode;
    if (!["auto", "approve_shell", "approve_sensitive", "approve_all"].includes(mode)) {
      res.status(400).json({ error: "Invalid approval mode" });
      return;
    }
    setApprovalMode(mode);
    broadcast({ type: "approval_mode_changed", mode });
    res.json({ ok: true, mode });
  });

  router.post("/approvals/:id/resolve", (req: Request, res: Response) => {
    const approved = Boolean(req.body?.approved);
    const switchToAuto = Boolean(req.body?.switchToAuto);
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const ok = resolveApproval(String(req.params.id), approved, { switchToAuto, reason, broadcast });
    if (!ok) {
      res.status(404).json({ error: "Pending approval not found or already resolved" });
      return;
    }
    res.json({ ok: true, mode: getApprovalMode() });
  });

  // ========================
  // 1-CLICK TEAM & BRAIN KIT TEMPLATES
  // ========================
  router.post("/templates/apply", (req: Request, res: Response) => {
    try {
      const db = getDb();
      const tpl = String(req.body?.template || "software-squad");
      const templates: Record<
        string,
        {
          teamName: string;
          desc: string;
          agents: Array<{ name: string; title: string; avatar: string; purpose: string; soul: string; packs: string[] }>;
        }
      > = {
        "software-squad": {
          teamName: "Software Engineering Squad",
          desc: "Full-stack product engineering team: Architect, Builder, and QA/DevOps.",
          agents: [
            {
              name: "Kresna Architect",
              title: "System Architect",
              avatar: "🏛️",
              purpose: "strategy",
              packs: ["brain", "team", "workspace"],
              soul: "# Kresna Architect\nDesign clean, modular architectures, API contracts, and database schemas.",
            },
            {
              name: "Gatutkaca Builder",
              title: "Full-Stack Engineer",
              avatar: "🚀",
              purpose: "coding",
              packs: ["brain", "team", "workspace", "shell"],
              soul: "# Gatutkaca Builder\nShip production TypeScript/Python code fast with clean error handling.",
            },
            {
              name: "Antasena QA",
              title: "Testing & DevOps",
              avatar: "🧪",
              purpose: "review",
              packs: ["brain", "team", "workspace", "shell"],
              soul: "# Antasena QA\nWrite automated tests, check edge cases, and validate deployments.",
            },
          ],
        },
        "growth-squad": {
          teamName: "Growth & Content Squad",
          desc: "Marketing strategist, viral copywriter, and market researcher.",
          agents: [
            {
              name: "Srikandi Strategist",
              title: "Growth Lead",
              avatar: "🎯",
              purpose: "strategy",
              packs: ["brain", "team", "web"],
              soul: "# Srikandi Strategist\nDesign positioning, pricing, go-to-market campaigns, and funnels.",
            },
            {
              name: "Abimanyu Copy",
              title: "Creative Copywriter",
              avatar: "✍️",
              purpose: "creative",
              packs: ["brain", "team"],
              soul: "# Abimanyu Copy\nCraft sharp landing pages, hooks, threads, and persuasive product copy.",
            },
            {
              name: "Drupadi Insights",
              title: "Market Analyst",
              avatar: "📊",
              purpose: "research",
              packs: ["brain", "team", "web"],
              soul: "# Drupadi Insights\nResearch competitors, customer pain points, and market trends.",
            },
          ],
        },
        "research-squad": {
          teamName: "Deep Research & Alpha Squad",
          desc: "Investigative researcher, quantitative synthesizer, and devil's advocate.",
          agents: [
            {
              name: "Bisma Lead",
              title: "Principal Investigator",
              avatar: "🔭",
              purpose: "strategy",
              packs: ["brain", "team", "web"],
              soul: "# Bisma Lead\nFrame high-leverage research questions and synthesize executive reports.",
            },
            {
              name: "Wibisana Scout",
              title: "Source Gatherer",
              avatar: "🌐",
              purpose: "research",
              packs: ["brain", "team", "web"],
              soul: "# Wibisana Scout\nFetch primary sources, APIs, and documentation with strict citations.",
            },
            {
              name: "Karna Skeptic",
              title: "Red-Team Analyst",
              avatar: "⚖️",
              purpose: "review",
              packs: ["brain", "team"],
              soul: "# Karna Skeptic\nStress-test hypotheses, expose blind spots, and challenge consensus.",
            },
          ],
        },
      };

      const spec = templates[tpl] || templates["software-squad"];
      const suffix = Math.random().toString(36).slice(2, 6);
      const teamId = generateId("team");
      const brainId = generateId("brain");
      const folderPath = `teams/${tpl}-${suffix}`;
      createBrainFolder(folderPath);
      writeBrainFile(`${folderPath}/team.md`, `# ${spec.teamName}\n\n${spec.desc}\n`);
      writeBrainFile(`${folderPath}/memory.md`, `# ${spec.teamName} — Shared Memory\n\n`);

      db.prepare(
        `INSERT INTO brains (id, slug, name, layer, description, folder_path, color, sync_policy)
         VALUES (?, ?, ?, 'team', ?, ?, '#8b5cf6', 'read_write')`
      ).run(brainId, `${tpl}-brain-${suffix}`, `Team Brain: ${spec.teamName}`, spec.desc, folderPath);

      db.prepare(
        `INSERT INTO teams (id, slug, name, description, team_brain_id, collaboration_mode, max_rounds, enabled)
         VALUES (?, ?, ?, ?, ?, 'deliberate', 2, 1)`
      ).run(teamId, `${tpl}-${suffix}`, spec.teamName, spec.desc, brainId);

      // Dynamically place new Team Kit cleanly to the right of all existing nodes (never stacks!)
      const maxXRow = db.prepare("SELECT COALESCE(MAX(position_x), 0) as mx FROM canvas_nodes").get() as { mx: number };
      const baseX = maxXRow.mx > 0 ? Math.round(maxXRow.mx + 380) : 0;
      const agentGap = 280;
      const squadCenterX = baseX + Math.round(((spec.agents.length - 1) * agentGap) / 2);

      const tbNodeId = `node_tb_${suffix}`;
      db.prepare(
        `INSERT INTO canvas_nodes (id, type, ref_id, label, position_x, position_y, data_json)
         VALUES (?, 'team_brain', ?, ?, ?, ?, ?)`
      ).run(
        tbNodeId,
        brainId,
        `Team Brain: ${spec.teamName}`,
        squadCenterX,
        220,
        JSON.stringify({ folderPath, teamId, color: "#8b5cf6", subtitle: spec.desc })
      );

      // Wire from Main Brain if exists
      const mainNode = db.prepare("SELECT id FROM canvas_nodes WHERE type = 'main_brain' LIMIT 1").get() as
        | { id?: string }
        | undefined;
      if (mainNode?.id) {
        db.prepare(
          `INSERT INTO canvas_edges (id, source, target, source_handle, target_handle, relation, permission, label, animated)
           VALUES (?, ?, ?, 'bottom', 'top', 'brain_link', 'sync', 'inherits + sync', 1)`
        ).run(generateId("edge"), mainNode.id, tbNodeId);
      }

      const createdAgNodeIds: string[] = [];
      spec.agents.forEach((ag, idx) => {
        const agId = generateId("agent");
        const agSlug = `${ag.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}`;
        db.prepare(
          `INSERT INTO agents (id, slug, name, title, role_description, avatar, color, purpose, temperature, max_tokens, system_prompt, tool_packs_json, enabled)
           VALUES (?, ?, ?, ?, ?, ?, '#06b6d4', ?, 0.5, 4096, ?, ?, 1)`
        ).run(agId, agSlug, ag.name, ag.title, ag.title, ag.avatar, ag.purpose, ag.soul, JSON.stringify(ag.packs));

        createBrainFolder(`agents/${agSlug}`);
        writeBrainFile(`agents/${agSlug}/soul.md`, `${ag.soul}\n`);

        const agNodeId = `node_ag_${suffix}_${idx}`;
        createdAgNodeIds.push(agNodeId);
        db.prepare(
          `INSERT INTO canvas_nodes (id, type, ref_id, label, position_x, position_y, data_json)
           VALUES (?, 'agent', ?, ?, ?, ?, ?)`
        ).run(
          agNodeId,
          agId,
          ag.name,
          baseX + idx * agentGap,
          440,
          JSON.stringify({ agentId: agId, avatar: ag.avatar, role: ag.title, purpose: ag.purpose, color: "#06b6d4" })
        );
        db.prepare(
          `INSERT INTO canvas_edges (id, source, target, source_handle, target_handle, relation, permission, label, animated)
           VALUES (?, ?, ?, 'bottom', 'top', 'brain_link', 'read_write', 'team brain', 1)`
        ).run(generateId("edge"), tbNodeId, agNodeId);
      });

      // Add horizontal peer collaboration edges between squad teammates
      for (let i = 0; i < createdAgNodeIds.length - 1; i++) {
        db.prepare(
          `INSERT INTO canvas_edges (id, source, target, source_handle, target_handle, relation, permission, label, animated)
           VALUES (?, ?, ?, 'right', 'left', 'peer_collab', 'sync', 'peer', 0)`
        ).run(generateId("edge"), createdAgNodeIds[i], createdAgNodeIds[i + 1]);
      }

      logAudit("admin", "template.apply", teamId, spec.teamName);
      broadcast({ type: "topology_updated" });
      res.json({ ok: true, teamId, teamName: spec.teamName });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ========================
  // COMMERCIAL BRAIN & TEAM BUNDLES (Export / Import .pandawa.json)
  // ========================
  router.get("/bundles/export", (req: Request, res: Response) => {
    try {
      const teamId = typeof req.query.teamId === "string" ? req.query.teamId : undefined;
      const includeMainBrain = req.query.includeMainBrain !== "false";
      const bundle = exportTeamBundle({ teamId, includeMainBrain });
      res.json(bundle);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/bundles/import", (req: Request, res: Response) => {
    try {
      const bundle = req.body as PandawaBundle;
      const out = importTeamBundle(bundle);
      broadcast({ type: "topology_updated" });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 1-Click Team-Clustered Smart Auto-Layout (zero overlap even with many Team Kits!)
  router.post("/topology/auto-layout", (_req: Request, res: Response) => {
    const db = getDb();
    const nodes = db.prepare("SELECT id, type, ref_id, data_json FROM canvas_nodes").all() as Array<{
      id: string;
      type: string;
      ref_id: string;
      data_json: string;
    }>;
    const edges = db.prepare("SELECT id, source, target, relation FROM canvas_edges").all() as Array<{
      id: string;
      source: string;
      target: string;
      relation: string;
    }>;

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const upd = db.prepare("UPDATE canvas_nodes SET position_x = ?, position_y = ? WHERE id = ?");

    const mainBrains = nodes.filter((n) => n.type === "main_brain");
    const teamBrains = nodes.filter((n) => n.type === "team_brain");
    const topKnowledge = nodes.filter((n) => n.type === "knowledge" && String(n.ref_id).startsWith("main-brain/"));

    const placed = new Set<string>();
    const AGENT_GAP = 280;
    const TEAM_ALLEY = 180;

    function connectedOfType(nodeId: string, targetType: string): typeof nodes {
      const out: typeof nodes = [];
      for (const e of edges) {
        let otherId = "";
        if (e.source === nodeId) otherId = e.target;
        else if (e.target === nodeId) otherId = e.source;
        if (!otherId) continue;
        const other = nodeById.get(otherId);
        if (other && other.type === targetType && !out.some((x) => x.id === other.id)) {
          out.push(other);
        }
      }
      return out;
    }

    let cursorX = 0;

    // Place each Team Brain cleanly centered above its OWN agents, models & tools
    for (const tb of teamBrains) {
      const squadAgents = connectedOfType(tb.id, "agent").filter((a) => !placed.has(a.id));
      const cols = Math.max(1, squadAgents.length);
      const clusterStartX = cursorX;
      const clusterWidth = (cols - 1) * AGENT_GAP;
      const centerX = clusterStartX + Math.round(clusterWidth / 2);

      upd.run(centerX, 220, tb.id);
      placed.add(tb.id);

      squadAgents.forEach((ag, idx) => {
        const ax = clusterStartX + idx * AGENT_GAP;
        upd.run(ax, 440, ag.id);
        placed.add(ag.id);

        // Place connected AI model directly below its Agent
        const provs = connectedOfType(ag.id, "provider").filter((p) => !placed.has(p.id));
        provs.forEach((p, pidx) => {
          upd.run(ax + pidx * 40, 670, p.id);
          placed.add(p.id);
        });

        // Place connected personal knowledge / toolpacks cleanly in Row 5 below Agent
        const extras = [
          ...connectedOfType(ag.id, "knowledge"),
          ...connectedOfType(ag.id, "toolpack"),
        ].filter((k) => !placed.has(k.id) && !String(k.ref_id).startsWith("main-brain/"));
        extras.forEach((k, kidx) => {
          upd.run(ax + kidx * 250, 870, k.id);
          placed.add(k.id);
        });
      });

      cursorX = clusterStartX + clusterWidth + AGENT_GAP + TEAM_ALLEY;
    }

    // Place any unattached remaining agents/providers/tools neatly to the right
    const remainingAgents = nodes.filter((n) => n.type === "agent" && !placed.has(n.id));
    remainingAgents.forEach((ag, idx) => {
      upd.run(cursorX + idx * AGENT_GAP, 440, ag.id);
      placed.add(ag.id);
    });
    if (remainingAgents.length > 0) cursorX += remainingAgents.length * AGENT_GAP + TEAM_ALLEY;

    const remainingProviders = nodes.filter((n) => n.type === "provider" && !placed.has(n.id));
    remainingProviders.forEach((p, idx) => {
      upd.run(idx * AGENT_GAP, 670, p.id);
      placed.add(p.id);
    });

    const remainingBottom = nodes.filter(
      (n) => !placed.has(n.id) && n.type !== "main_brain" && !topKnowledge.some((t) => t.id === n.id)
    );
    remainingBottom.forEach((b, idx) => {
      upd.run(idx * AGENT_GAP, 870, b.id);
      placed.add(b.id);
    });

    // Center Main Brain + its flanking soul.md / rules.md across the total canvas span
    const totalSpan = Math.max(cursorX - TEAM_ALLEY - AGENT_GAP, 900);
    const topCombined = [...topKnowledge.slice(0, 1), ...mainBrains, ...topKnowledge.slice(1)];
    const topGap = 360;
    const topW = Math.max(0, (topCombined.length - 1) * topGap);
    const topStart = Math.max(0, Math.round((totalSpan - topW) / 2));
    topCombined.forEach((n, idx) => {
      upd.run(topStart + idx * topGap, 20, n.id);
      placed.add(n.id);
    });

    broadcast({ type: "topology_updated" });
    res.json({ ok: true });
  });

  router.get("/tools", (_req: Request, res: Response) => {
    res.json({ packs: listAllToolPacks() });
  });

  // ========================
  // LIVING BRAIN WIKILINK GRAPH (Beyond Obsidian)
  // ========================
  router.get("/files/graph", (_req: Request, res: Response) => {
    res.json(getBrainLinkGraph());
  });

  // ========================
  // LIVE TEAM INTER-AGENT MESSAGES
  // ========================
  router.get("/teams/:id/messages", (req: Request, res: Response) => {
    const db = getDb();
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const rows = sessionId
      ? db
          .prepare(
            `SELECT * FROM team_messages WHERE team_id = ? AND (session_id = ? OR session_id = '') ORDER BY created_at DESC LIMIT 60`
          )
          .all(String(req.params.id), sessionId)
      : db
          .prepare(`SELECT * FROM team_messages WHERE team_id = ? ORDER BY created_at DESC LIMIT 60`)
          .all(String(req.params.id));
    res.json({ messages: rows.reverse() });
  });

  // ========================
  // PERSISTENT SHARED TERMINALS (Python PTY / tmux)
  // ========================
  router.get("/terminals", async (_req: Request, res: Response) => {
    res.json(await listTerminals());
  });

  router.post("/terminals", async (req: Request, res: Response) => {
    try {
      const out = await openTerminal({
        name: String(req.body?.name || "main"),
        cwd: req.body?.cwd ? String(req.body.cwd) : undefined,
        ownerAgent: String(req.body?.ownerAgent || "user"),
      });
      res.json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/terminals/:name/output", async (req: Request, res: Response) => {
    try {
      const lines = Number(req.query.lines || 250);
      res.json(await readTerminal(String(req.params.name), lines));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/terminals/:name/exec", async (req: Request, res: Response) => {
    try {
      const out = await execInTerminal({
        name: String(req.params.name),
        command: String(req.body?.command || ""),
        timeoutSec: req.body?.timeoutSec ? Number(req.body.timeoutSec) : 35,
        actor: "user",
      });
      res.json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/terminals/:name/send", async (req: Request, res: Response) => {
    try {
      const out = await sendKeysToTerminal({
        name: String(req.params.name),
        text: req.body?.text !== undefined ? String(req.body.text) : undefined,
        key: req.body?.key !== undefined ? String(req.body.key) : undefined,
        enter: req.body?.enter !== undefined ? Boolean(req.body.enter) : true,
        actor: "user",
      });
      res.json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/terminals/:name", async (req: Request, res: Response) => {
    try {
      res.json(await closeTerminal(String(req.params.name)));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ========================
  // ALWAYS-ON BACKGROUND MISSION JOBS (Beyond OpenClaw)
  // ========================
  router.get("/jobs", (_req: Request, res: Response) => {
    res.json({ jobs: listBackgroundJobs(50) });
  });

  router.post("/jobs/:id/cancel", (req: Request, res: Response) => {
    const ok = cancelBackgroundJob(String(req.params.id), broadcast);
    res.json({ ok });
  });

  // ========================
  // HYBRID SEMANTIC VECTOR BRAIN SEARCH (Beyond Obsidian)
  // ========================
  router.get("/brain/semantic/status", async (_req: Request, res: Response) => {
    res.json(await getSemanticBrainStatus());
  });

  router.get("/brain/semantic/search", async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const scope = typeof req.query.scope === "string" ? (req.query.scope as "all" | "brain_file" | "memory" | "session") : "all";
      const limit = Number(req.query.limit || 12);
      res.json(await semanticBrainSearch(q, { scope, limit }));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/brain/semantic/reindex", async (_req: Request, res: Response) => {
    try {
      const out = await reindexSemanticBrain();
      logAudit("admin", "semantic.reindex", "brain", JSON.stringify(out).slice(0, 180));
      res.json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ========================
  // PROACTIVE AUTONOMOUS HEARTBEAT DAEMON (Beyond OpenClaw)
  // ========================
  router.get("/heartbeat", (_req: Request, res: Response) => {
    res.json({
      config: getHeartbeatConfig(),
      logs: listHeartbeatLogs(30),
    });
  });

  router.put("/heartbeat", (req: Request, res: Response) => {
    const config = updateHeartbeatConfig({
      enabled: req.body?.enabled !== undefined ? Boolean(req.body.enabled) : undefined,
      intervalMinutes: req.body?.intervalMinutes !== undefined ? Number(req.body.intervalMinutes) : undefined,
      teamId: req.body?.teamId !== undefined ? String(req.body.teamId) : undefined,
      notifyChannelId: req.body?.notifyChannelId !== undefined ? String(req.body.notifyChannelId) : undefined,
      checklistMarkdown: typeof req.body?.checklistMarkdown === "string" ? req.body.checklistMarkdown : undefined,
    });
    res.json({ ok: true, config });
  });

  router.post("/heartbeat/pulse", async (_req: Request, res: Response) => {
    try {
      const out = await runHeartbeatPulse("manual");
      res.json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ========================
  // RUNTIME POLICIES (Token Budget Cap & Optional Private-IP SSRF Policy)
  // ========================
  router.get("/system/policies", (_req: Request, res: Response) => {
    const rawBudget = getSetting("max_tokens_per_mission");
    res.json({
      maxTokensPerMission: rawBudget !== null ? Number(rawBudget) : 250_000,
      ssrfBlockPrivate: getSetting("ssrf_block_private") === "1",
    });
  });

  router.put("/system/policies", (req: Request, res: Response) => {
    if (req.body?.maxTokensPerMission !== undefined) {
      const v = Math.max(0, Math.round(Number(req.body.maxTokensPerMission) || 0));
      setSetting("max_tokens_per_mission", String(v));
    }
    if (req.body?.ssrfBlockPrivate !== undefined) {
      setSetting("ssrf_block_private", req.body.ssrfBlockPrivate ? "1" : "0");
    }
    const rawBudget = getSetting("max_tokens_per_mission");
    logAudit("admin", "system.policies_update", "policies", `budget=${rawBudget}, ssrfPrivate=${getSetting("ssrf_block_private")}`);
    res.json({
      ok: true,
      maxTokensPerMission: rawBudget !== null ? Number(rawBudget) : 250_000,
      ssrfBlockPrivate: getSetting("ssrf_block_private") === "1",
    });
  });

  // ========================
  // HYBRID PYTHON / TMUX / PLAYWRIGHT / SEMANTIC / HEARTBEAT STATUS
  // ========================
  router.get("/system/runtime", async (_req: Request, res: Response) => {
    const [pyStatus, termStatus, semStatus] = await Promise.all([
      getPythonWorkerStatus(),
      listTerminals(),
      getSemanticBrainStatus(),
    ]);
    res.json({
      version: PANDAWA_VERSION,
      nodeVersion: process.version,
      pythonWorker: pyStatus,
      tmuxAvailable: termStatus.tmux,
      activeTerminals: termStatus.sessions.length,
      runningJobs: listBackgroundJobs(50).filter((j) => j.status === "running" || j.status === "queued").length,
      semanticMemory: semStatus,
      heartbeat: getHeartbeatConfig(),
    });
  });

  // ========================
  // SYSTEM HEALTH, USAGE & AUDIT
  // ========================
  router.get("/system/status", (_req: Request, res: Response) => {
    const db = getDb();
    const allProvs = db.prepare("SELECT * FROM providers").all() as unknown as ProviderRecord[];
    const readyProviders = allProvs.filter((p) => {
      if (!p.enabled) return false;
      const k = decryptSecret(p.api_key || "").trim();
      return k.length > 0 && k.toLowerCase() !== "ollama";
    }).length;

    const counts = {
      brains: (db.prepare("SELECT COUNT(*) as c FROM brains").get() as { c: number }).c,
      agents: (db.prepare("SELECT COUNT(*) as c FROM agents").get() as { c: number }).c,
      teams: (db.prepare("SELECT COUNT(*) as c FROM teams").get() as { c: number }).c,
      providers: allProvs.length,
      configuredProviders: readyProviders,
      sessions: (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c,
      memories: (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c,
      skills: listSkills().length,
      cronJobs: (db.prepare("SELECT COUNT(*) as c FROM cron_jobs").get() as { c: number }).c,
      runningJobs: (
        db.prepare("SELECT COUNT(*) as c FROM background_jobs WHERE status IN ('queued','running')").get() as { c: number }
      ).c,
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
      version: PANDAWA_VERSION,
      approvalMode: getApprovalMode(),
      pendingApprovals: listPendingApprovals().length,
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

  router.get("/system/analytics", (_req: Request, res: Response) => {
    const db = getDb();
    const byAgent = db
      .prepare(
        `SELECT u.agent_id as agentId,
                COALESCE(a.name, u.agent_id) as agentName,
                COALESCE(a.avatar, '⚡') as avatar,
                COUNT(*) as calls,
                COALESCE(SUM(u.prompt_tokens), 0) as promptTokens,
                COALESCE(SUM(u.completion_tokens), 0) as completionTokens,
                ROUND(COALESCE(AVG(u.duration_ms), 0)) as avgDurationMs
         FROM usage_logs u
         LEFT JOIN agents a ON a.id = u.agent_id
         GROUP BY u.agent_id
         ORDER BY (promptTokens + completionTokens) DESC`
      )
      .all();

    const byModel = db
      .prepare(
        `SELECT u.model as model,
                COALESCE(p.name, u.provider_id) as providerName,
                COUNT(*) as calls,
                COALESCE(SUM(u.prompt_tokens), 0) as promptTokens,
                COALESCE(SUM(u.completion_tokens), 0) as completionTokens,
                ROUND(COALESCE(AVG(u.duration_ms), 0)) as avgDurationMs
         FROM usage_logs u
         LEFT JOIN providers p ON p.id = u.provider_id
         GROUP BY u.model, u.provider_id
         ORDER BY (promptTokens + completionTokens) DESC`
      )
      .all();

    res.json({ byAgent, byModel });
  });

  return router;
}

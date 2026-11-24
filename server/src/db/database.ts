import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, ensureDirectories } from "../config.js";

let _db: DatabaseSync | null = null;

function tightenDbPermissions(): void {
  if (process.platform === "win32") return;
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
    } catch {
      // ignore chmod errors on restricted filesystems
    }
  }
}

export function getDb(): DatabaseSync {
  if (_db) return _db;
  ensureDirectories();
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  tightenDbPermissions();
  _db = db;
  return db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      default_model TEXT NOT NULL DEFAULT '',
      models_json TEXT NOT NULL DEFAULT '[]',
      headers_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS brains (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      layer TEXT NOT NULL CHECK(layer IN ('main', 'team', 'personal')),
      description TEXT NOT NULL DEFAULT '',
      folder_path TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#f59e0b',
      sync_policy TEXT NOT NULL DEFAULT 'read_write',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      role_description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '⚡',
      color TEXT NOT NULL DEFAULT '#06b6d4',
      provider_id TEXT,
      model TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT 'general',
      temperature REAL NOT NULL DEFAULT 0.6,
      max_tokens INTEGER NOT NULL DEFAULT 4096,
      max_iterations INTEGER NOT NULL DEFAULT 35,
      system_prompt TEXT NOT NULL DEFAULT '',
      tool_packs_json TEXT NOT NULL DEFAULT '["brain","team","workspace"]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      team_brain_id TEXT,
      collaboration_mode TEXT NOT NULL DEFAULT 'deliberate',
      max_rounds INTEGER NOT NULL DEFAULT 2,
      lead_agent_id TEXT NOT NULL DEFAULT '',
      reviewer_agent_id TEXT NOT NULL DEFAULT '',
      sender_agent_id TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS canvas_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      ref_id TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL,
      position_x REAL NOT NULL DEFAULT 0,
      position_y REAL NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS canvas_edges (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      source_handle TEXT NOT NULL DEFAULT '',
      target_handle TEXT NOT NULL DEFAULT '',
      relation TEXT NOT NULL DEFAULT 'brain_link',
      permission TEXT NOT NULL DEFAULT 'read_write',
      label TEXT NOT NULL DEFAULT '',
      animated INTEGER NOT NULL DEFAULT 1,
      data_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('team', 'agent')),
      target_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT '',
      model_used TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      reasoning TEXT NOT NULL DEFAULT '',
      tool_calls_json TEXT NOT NULL DEFAULT '[]',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blackboard_entries (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      author_agent_id TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      entry_type TEXT NOT NULL DEFAULT 'finding',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      brain_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      memory_id UNINDEXED,
      brain_id UNINDEXED,
      category,
      content
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS brain_files_fts USING fts5(
      rel_path,
      title,
      content
    );

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'team',
      target_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT NOT NULL DEFAULT '',
      last_status TEXT NOT NULL DEFAULT 'idle',
      last_output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      target_type TEXT NOT NULL DEFAULT 'team',
      target_id TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'http',
      url_or_cmd TEXT NOT NULL,
      headers_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT 'admin',
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_tasks (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      owner_agent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'done', 'blocked')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      session_id UNINDEXED,
      agent_name,
      content
    );

    CREATE TABLE IF NOT EXISTS team_messages (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL DEFAULT 'all',
      kind TEXT NOT NULL DEFAULT 'update',
      content TEXT NOT NULL,
      read_by_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'team',
      target_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress_text TEXT NOT NULL DEFAULT '',
      result_preview TEXT NOT NULL DEFAULT '',
      error_text TEXT NOT NULL DEFAULT '',
      notify_channel_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS heartbeat_logs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'ok',
      summary TEXT NOT NULL DEFAULT '',
      alerted INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Safe idempotent column migrations for upgraded databases
  try {
    const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "max_iterations")) {
      db.exec("ALTER TABLE agents ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 35;");
    }
  } catch {
    // ignore migration error if already present
  }

  for (const col of ["lead_agent_id", "reviewer_agent_id", "sender_agent_id"] as const) {
    try {
      const teamCols = db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
      if (!teamCols.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE teams ADD COLUMN ${col} TEXT NOT NULL DEFAULT '';`);
      }
    } catch {
      // ignore migration error if already present
    }
  }
}

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

export function logAudit(actor: string, action: string, target = "", detail = ""): void {
  const db = getDb();
  const id = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO audit_logs (id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`
  ).run(id, actor, action, target, detail);
}

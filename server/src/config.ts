import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export const PANDAWA_VERSION = "7.0.0";

export const ROOT_DIR = process.env.PANDAWA_ROOT || process.cwd();
export const DATA_DIR = process.env.PANDAWA_DATA_DIR || path.join(ROOT_DIR, "data");
export const BRAINS_DIR = path.join(DATA_DIR, "brains");
export const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");
export const WORKSPACES_ROOT_DIR = path.join(DATA_DIR, "workspaces");
export const CHECKPOINTS_ROOT_DIR = path.join(DATA_DIR, "checkpoints");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const DB_PATH = path.join(DATA_DIR, "pandawa.db");
export const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");
export const PYTHON_WORKER_DIR = path.join(ROOT_DIR, "runtime", "python_worker");

export const PORT = Number(process.env.PANDAWA_PORT || 7777);
// Secure default: bind loopback unless explicitly overridden (Docker / systemd VPS sets PANDAWA_HOST=0.0.0.0)
export const HOST = process.env.PANDAWA_HOST || "127.0.0.1";
// If unset on fresh install, authService generates a strong unique random initial password
export const DEFAULT_PASSWORD = process.env.PANDAWA_DEFAULT_PASSWORD || "";

function isWithinOrEqual(childPath: string, parentPath: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const c = norm(path.resolve(childPath));
  const p = norm(path.resolve(parentPath));
  return c === p || c.startsWith(p + path.sep);
}

export function sanitizeWorkspaceSegment(id: string): string {
  const cleaned = String(id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (cleaned) return cleaned;
  return "t_" + crypto.createHash("sha256").update(String(id || "")).digest("hex").slice(0, 12);
}

export function resolveTeamWorkspaceDir(teamId?: string | null): string {
  const trimmed = String(teamId || "").trim();
  if (!trimmed) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    return WORKSPACE_DIR;
  }
  const seg = sanitizeWorkspaceSegment(trimmed);
  const root = path.resolve(WORKSPACES_ROOT_DIR);
  const dir = path.resolve(root, seg);
  if (dir === root || !isWithinOrEqual(dir, root)) {
    throw new Error("Invalid team workspace path.");
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveTeamCheckpointsDir(teamId?: string | null): string {
  const trimmed = String(teamId || "").trim();
  const root = path.resolve(CHECKPOINTS_ROOT_DIR);
  if (!trimmed) {
    fs.mkdirSync(root, { recursive: true });
    return root;
  }
  const seg = sanitizeWorkspaceSegment(trimmed);
  const dir = path.resolve(root, seg);
  if (dir === root || !isWithinOrEqual(dir, root)) {
    throw new Error("Invalid team checkpoint path.");
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveScopedCwd(requestedCwd: string | undefined, teamId?: string | null): string {
  const baseDir = path.resolve(resolveTeamWorkspaceDir(teamId));
  const reqTrim = String(requestedCwd || "").trim();
  if (!reqTrim) return baseDir;

  if (path.isAbsolute(reqTrim)) {
    const resolved = path.resolve(reqTrim);
    const wsRoot = path.resolve(WORKSPACES_ROOT_DIR);
    if (isWithinOrEqual(resolved, wsRoot) && !isWithinOrEqual(resolved, baseDir)) {
      throw new Error("Access denied: cannot set cwd into another team's workspace.");
    }
    return resolved;
  }

  const resolved = path.resolve(baseDir, reqTrim);
  if (!isWithinOrEqual(resolved, baseDir)) {
    throw new Error("Path traversal not allowed: cwd escapes team workspace.");
  }
  return resolved;
}

export function ensureDirectories(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BRAINS_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACES_ROOT_DIR, { recursive: true });
  fs.mkdirSync(CHECKPOINTS_ROOT_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

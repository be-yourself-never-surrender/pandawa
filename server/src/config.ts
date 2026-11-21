import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export const ROOT_DIR = process.env.PANDAWA_ROOT || process.cwd();
export const DATA_DIR = process.env.PANDAWA_DATA_DIR || path.join(ROOT_DIR, "data");
export const BRAINS_DIR = path.join(DATA_DIR, "brains");
export const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const DB_PATH = path.join(DATA_DIR, "pandawa.db");
export const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");
export const PYTHON_WORKER_DIR = path.join(ROOT_DIR, "runtime", "python_worker");

export const PORT = Number(process.env.PANDAWA_PORT || 7777);
export const HOST = process.env.PANDAWA_HOST || "0.0.0.0";
export const DEFAULT_PASSWORD = process.env.PANDAWA_DEFAULT_PASSWORD || "11111111";

export function ensureDirectories(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BRAINS_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

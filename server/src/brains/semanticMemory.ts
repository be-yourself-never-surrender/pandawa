import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BRAINS_DIR, DATA_DIR, DB_PATH, PYTHON_WORKER_DIR, WORKSPACE_DIR } from "../config.js";
import { getDb } from "../db/database.js";
import { decryptSecret } from "../auth/cryptoVault.js";
import type { ProviderRecord } from "../providers/llmClient.js";

const SEMANTIC_DB_PATH = path.join(DATA_DIR, "semantic_index.sqlite");

function getPythonBin(): string {
  const venvUnix = path.join(PYTHON_WORKER_DIR, ".venv", "bin", "python3");
  if (fs.existsSync(venvUnix)) return venvUnix;
  const venvWin = path.join(PYTHON_WORKER_DIR, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvWin)) return venvWin;
  return process.platform === "win32" ? "python" : "python3";
}

function resolveOptionalEmbedConfig(): Record<string, string> | null {
  try {
    const db = getDb();
    const providers = db
      .prepare("SELECT * FROM providers WHERE enabled = 1 ORDER BY updated_at DESC")
      .all() as unknown as ProviderRecord[];

    for (const p of providers) {
      const key = decryptSecret(p.api_key || "").trim();
      const isLocal = p.base_url.includes("127.0.0.1") || p.base_url.includes("localhost") || p.base_url.includes(":11434");
      if ((!key && !isLocal) || key.toLowerCase() === "ollama") continue;
      if (p.kind === "openai") {
        const model = p.default_model?.includes("embed") ? p.default_model : "text-embedding-3-small";
        return { kind: "openai", baseUrl: p.base_url, apiKey: key, model };
      }
      if (p.kind === "gemini") {
        const model = p.default_model?.includes("embed") ? p.default_model : "text-embedding-004";
        return { kind: "gemini", baseUrl: p.base_url, apiKey: key, model };
      }
    }
  } catch {
    // fallback to offline local semantic TF-IDF
  }
  return null;
}

async function runSemanticWorker<T = Record<string, unknown>>(
  action: "index" | "search" | "status",
  payload: Record<string, unknown>,
  timeoutMs = 45_000
): Promise<T> {
  const script = path.join(PYTHON_WORKER_DIR, "semantic_memory.py");
  if (!fs.existsSync(script)) {
    throw new Error(`Semantic memory worker missing at ${script}`);
  }
  const py = getPythonBin();

  return new Promise<T>((resolve, reject) => {
    const child = spawn(py, [script, action], {
      cwd: WORKSPACE_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`Semantic worker timed out (${action})`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.trim() || "{}") as T);
      } catch {
        reject(new Error(`Semantic worker error (${code}): ${stderr || stdout || "empty"}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function reindexSemanticBrain(): Promise<Record<string, unknown>> {
  return runSemanticWorker("index", {
    brainsDir: BRAINS_DIR,
    pandawaDb: DB_PATH,
    indexDb: SEMANTIC_DB_PATH,
    embedConfig: resolveOptionalEmbedConfig(),
  });
}

export async function semanticBrainSearch(
  query: string,
  options?: { scope?: "all" | "brain_file" | "memory" | "session"; limit?: number; pathPrefixes?: string[] }
): Promise<Record<string, unknown>> {
  return runSemanticWorker("search", {
    query,
    scope: options?.scope || "all",
    limit: options?.limit || 10,
    ...(options?.pathPrefixes && options.pathPrefixes.length > 0 ? { pathPrefixes: options.pathPrefixes } : {}),
    brainsDir: BRAINS_DIR,
    pandawaDb: DB_PATH,
    indexDb: SEMANTIC_DB_PATH,
    embedConfig: resolveOptionalEmbedConfig(),
  });
}

export async function getSemanticBrainStatus(): Promise<Record<string, unknown>> {
  try {
    return await runSemanticWorker("status", { indexDb: SEMANTIC_DB_PATH }, 10_000);
  } catch (err) {
    return { ok: false, indexed: false, totalChunks: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

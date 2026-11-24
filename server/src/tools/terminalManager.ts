import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DATA_DIR, PYTHON_WORKER_DIR, resolveScopedCwd, resolveTeamWorkspaceDir } from "../config.js";

export interface TerminalScopeOptions {
  scope?: string;
  sessionId?: string;
  teamId?: string;
}

export interface TerminalSessionInfo {
  name: string;
  tmuxName: string;
  cwd: string;
  currentCommand: string;
  attached: boolean;
  pid: number | null;
  attachCommand: string;
  ownerAgent: string;
  lastCommand: string;
  lastActivityAt: string;
  displayName?: string;
  teamId?: string;
  sessionId?: string;
  scope?: string;
}

interface SessionMeta {
  ownerAgent: string;
  lastCommand: string;
  lastActivityAt: string;
  displayName?: string;
  teamId?: string;
  sessionId?: string;
  scope?: string;
}

const sessionMetaMap = new Map<string, SessionMeta>();
let loadedMetaPath = "";
let _broadcast: ((ev: Record<string, unknown>) => void) | undefined;

export function setTerminalBroadcast(fn: (ev: Record<string, unknown>) => void): void {
  _broadcast = fn;
}

function getMetaFilePath(): string {
  return path.join(DATA_DIR, "terminal_meta.json");
}

function ensureMetaLoaded(): void {
  const filePath = getMetaFilePath();
  if (loadedMetaPath === filePath) return;
  sessionMetaMap.clear();
  loadedMetaPath = filePath;
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, SessionMeta>;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === "object") {
          sessionMetaMap.set(k, v);
        }
      }
    }
  } catch {
    // ignore corrupt meta file
  }
}

function saveMetaToDisk(): void {
  const filePath = getMetaFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const obj: Record<string, SessionMeta> = {};
    for (const [k, v] of sessionMetaMap.entries()) {
      obj[k] = v;
    }
    const tmp = `${filePath}.tmp_${process.pid}_${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  } catch {
    // non-fatal persistence error
  }
}

function getPythonBin(): string {
  const venvUnix = path.join(PYTHON_WORKER_DIR, ".venv", "bin", "python3");
  if (fs.existsSync(venvUnix)) return venvUnix;
  const venvWin = path.join(PYTHON_WORKER_DIR, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvWin)) return venvWin;
  return process.platform === "win32" ? "python" : "python3";
}

function getPtyScriptPath(): string {
  return path.join(PYTHON_WORKER_DIR, "pty_manager.py");
}

export function sanitizeTerminalName(name: string): string {
  const slug = String(name || "main")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (slug || "main").slice(0, 64);
}

export function resolveTerminalScope(opts?: TerminalScopeOptions): string | undefined {
  if (opts?.scope?.trim()) return opts.scope.trim();
  const tid = opts?.teamId?.trim() || "";
  const sid = opts?.sessionId?.trim() || "";
  if (tid && sid) return `${tid}:${sid}`;
  return sid || tid || undefined;
}

function scopeTag(scope: string): string {
  return "s" + crypto.createHash("sha256").update(scope).digest("hex").slice(0, 8);
}

export function scopedTerminalName(name: string, scope?: string): string {
  let clean = sanitizeTerminalName(name);
  if (clean.startsWith("pdw_")) {
    clean = clean.slice(4) || "main";
  }
  const sc = (scope || "").trim();
  if (!sc) return clean;
  const tag = scopeTag(sc);
  if (clean.startsWith(`${tag}__`)) return clean;
  return `${tag}__${clean}`.slice(0, 64);
}

async function callPtyWorker<T = Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 310_000,
  teamId?: string
): Promise<T> {
  const script = getPtyScriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(`Python PTY worker script missing at ${script}`);
  }
  const py = getPythonBin();
  const spawnCwd = resolveTeamWorkspaceDir(teamId);

  return new Promise<T>((resolve, reject) => {
    const child = spawn(py, [script, action], {
      cwd: spawnCwd,
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
      reject(new Error(`Terminal worker timed out (${action})`));
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
        const parsed = JSON.parse(stdout.trim() || "{}") as T;
        resolve(parsed);
      } catch {
        reject(new Error(`Terminal worker failed (exit ${code}): ${stderr || stdout || "empty output"}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function listTerminals(
  opts?: TerminalScopeOptions
): Promise<{ ok: boolean; tmux: boolean; sessions: TerminalSessionInfo[]; error?: string }> {
  ensureMetaLoaded();
  const scope = resolveTerminalScope(opts);
  const tagPrefix = scope ? `${scopeTag(scope)}__` : "";

  try {
    const res = await callPtyWorker<{
      ok: boolean;
      tmux?: boolean;
      sessions?: Array<{
        name: string;
        tmuxName: string;
        cwd: string;
        currentCommand: string;
        attached: boolean;
        pid: number | null;
        attachCommand: string;
      }>;
      error?: string;
    }>("list", {}, 10_000);

    const rawSessions = res.sessions || [];
    if (res.ok && res.tmux) {
      const liveNames = new Set(rawSessions.map((s) => s.name));
      let pruned = false;
      for (const key of Array.from(sessionMetaMap.keys())) {
        if (!liveNames.has(key)) {
          sessionMetaMap.delete(key);
          pruned = true;
        }
      }
      if (pruned) saveMetaToDisk();
    }

    const filtered = tagPrefix ? rawSessions.filter((s) => s.name.startsWith(tagPrefix)) : rawSessions;

    const sessions: TerminalSessionInfo[] = filtered.map((s) => {
      const meta = sessionMetaMap.get(s.name);
      return {
        ...s,
        ownerAgent: meta?.ownerAgent || "shared",
        lastCommand: meta?.lastCommand || s.currentCommand || "",
        lastActivityAt: meta?.lastActivityAt || new Date().toISOString(),
        ...(meta?.displayName ? { displayName: meta.displayName } : {}),
        ...(meta?.teamId ? { teamId: meta.teamId } : {}),
        ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
        ...(meta?.scope ? { scope: meta.scope } : {}),
      };
    });

    return { ok: Boolean(res.ok), tmux: Boolean(res.tmux), sessions, error: res.error };
  } catch (err) {
    return {
      ok: false,
      tmux: false,
      sessions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function openTerminal(params: {
  name: string;
  cwd?: string;
  env?: Record<string, string>;
  ownerAgent?: string;
  teamId?: string;
  sessionId?: string;
  scope?: string;
}): Promise<Record<string, unknown>> {
  ensureMetaLoaded();
  const scope = resolveTerminalScope(params);
  const cleanName = scopedTerminalName(params.name, scope);
  const displayName = sanitizeTerminalName(params.name);
  const cwd = resolveScopedCwd(params.cwd, params.teamId);
  fs.mkdirSync(cwd, { recursive: true });
  const res = await callPtyWorker<Record<string, unknown>>(
    "open",
    {
      name: cleanName,
      ...(scope ? { scope } : {}),
      cwd,
      env: params.env || {},
    },
    310_000,
    params.teamId
  );
  if (res.ok) {
    const resolvedName = String(res.name || cleanName);
    const existing = sessionMetaMap.get(resolvedName);
    sessionMetaMap.set(resolvedName, {
      ownerAgent: params.ownerAgent || existing?.ownerAgent || "user",
      lastCommand: existing?.lastCommand || "bash",
      lastActivityAt: new Date().toISOString(),
      displayName: existing?.displayName || displayName,
      ...(params.teamId || existing?.teamId ? { teamId: params.teamId || existing?.teamId } : {}),
      ...(params.sessionId || existing?.sessionId ? { sessionId: params.sessionId || existing?.sessionId } : {}),
      ...(scope || existing?.scope ? { scope: scope || existing?.scope } : {}),
    });
    saveMetaToDisk();
    _broadcast?.({
      type: "terminal_updated",
      action: "open",
      name: resolvedName,
      ownerAgent: params.ownerAgent || "user",
    });
  }
  return res;
}

export async function execInTerminal(params: {
  name: string;
  command: string;
  cwd?: string;
  timeoutSec?: number;
  actor?: string;
  teamId?: string;
  sessionId?: string;
  scope?: string;
}): Promise<Record<string, unknown>> {
  ensureMetaLoaded();
  const scope = resolveTerminalScope(params);
  const cleanName = scopedTerminalName(params.name, scope);
  const displayName = sanitizeTerminalName(params.name);
  const timeoutSec = Math.max(2, Math.min(300, Number(params.timeoutSec || 45)));
  const cwd = resolveScopedCwd(params.cwd, params.teamId);
  fs.mkdirSync(cwd, { recursive: true });

  const existing = sessionMetaMap.get(cleanName);
  sessionMetaMap.set(cleanName, {
    ownerAgent: existing?.ownerAgent || params.actor || "shared",
    lastCommand: params.command.slice(0, 120),
    lastActivityAt: new Date().toISOString(),
    displayName: existing?.displayName || displayName,
    ...(params.teamId || existing?.teamId ? { teamId: params.teamId || existing?.teamId } : {}),
    ...(params.sessionId || existing?.sessionId ? { sessionId: params.sessionId || existing?.sessionId } : {}),
    ...(scope || existing?.scope ? { scope: scope || existing?.scope } : {}),
  });
  saveMetaToDisk();

  _broadcast?.({
    type: "terminal_exec",
    name: cleanName,
    actor: params.actor || "user",
    command: params.command,
  });

  const res = await callPtyWorker<Record<string, unknown>>(
    "exec",
    {
      name: cleanName,
      ...(scope ? { scope } : {}),
      command: params.command,
      cwd,
      timeoutSec,
    },
    (timeoutSec + 15) * 1000,
    params.teamId
  );

  const resolvedName = String(res.name || cleanName);
  sessionMetaMap.set(resolvedName, {
    ownerAgent: existing?.ownerAgent || params.actor || "shared",
    lastCommand: params.command.slice(0, 120),
    lastActivityAt: new Date().toISOString(),
    displayName: existing?.displayName || displayName,
    ...(params.teamId || existing?.teamId ? { teamId: params.teamId || existing?.teamId } : {}),
    ...(params.sessionId || existing?.sessionId ? { sessionId: params.sessionId || existing?.sessionId } : {}),
    ...(scope || existing?.scope ? { scope: scope || existing?.scope } : {}),
  });
  saveMetaToDisk();

  _broadcast?.({
    type: "terminal_output",
    name: resolvedName,
    actor: params.actor || "user",
    command: params.command,
    exitCode: res.exitCode ?? null,
    timedOut: Boolean(res.timedOut),
    preview: String(res.output || "").slice(-800),
  });

  return res;
}

export async function sendKeysToTerminal(params: {
  name: string;
  text?: string;
  key?: string;
  enter?: boolean;
  actor?: string;
  teamId?: string;
  sessionId?: string;
  scope?: string;
}): Promise<Record<string, unknown>> {
  ensureMetaLoaded();
  const scope = resolveTerminalScope(params);
  const cleanName = scopedTerminalName(params.name, scope);
  const displayName = sanitizeTerminalName(params.name);
  const res = await callPtyWorker<Record<string, unknown>>("send", {
    name: cleanName,
    ...(scope ? { scope } : {}),
    text: params.text,
    key: params.key,
    enter: params.enter ?? true,
  });

  const resolvedName = String(res.name || cleanName);
  const existing = sessionMetaMap.get(resolvedName);
  sessionMetaMap.set(resolvedName, {
    ownerAgent: existing?.ownerAgent || params.actor || "shared",
    lastCommand: (params.key || params.text || "").slice(0, 120),
    lastActivityAt: new Date().toISOString(),
    displayName: existing?.displayName || displayName,
    ...(params.teamId || existing?.teamId ? { teamId: params.teamId || existing?.teamId } : {}),
    ...(params.sessionId || existing?.sessionId ? { sessionId: params.sessionId || existing?.sessionId } : {}),
    ...(scope || existing?.scope ? { scope: scope || existing?.scope } : {}),
  });
  saveMetaToDisk();

  _broadcast?.({
    type: "terminal_output",
    name: resolvedName,
    actor: params.actor || "user",
    command: params.key || params.text || "",
    preview: String(res.output || "").slice(-800),
  });
  return res;
}

export async function readTerminal(
  name: string,
  lines = 200,
  opts?: TerminalScopeOptions
): Promise<Record<string, unknown>> {
  const scope = resolveTerminalScope(opts);
  const cleanName = scopedTerminalName(name, scope);
  return callPtyWorker<Record<string, unknown>>(
    "read",
    { name: cleanName, ...(scope ? { scope } : {}), lines },
    15_000
  );
}

export async function closeTerminal(
  name: string,
  opts?: TerminalScopeOptions
): Promise<Record<string, unknown>> {
  ensureMetaLoaded();
  const scope = resolveTerminalScope(opts);
  const cleanName = scopedTerminalName(name, scope);
  const res = await callPtyWorker<Record<string, unknown>>(
    "close",
    { name: cleanName, ...(scope ? { scope } : {}) },
    10_000
  );
  if (res.ok) {
    const resolvedName = String(res.name || cleanName);
    sessionMetaMap.delete(resolvedName);
    sessionMetaMap.delete(cleanName);
    saveMetaToDisk();
    _broadcast?.({ type: "terminal_updated", action: "close", name: resolvedName });
  }
  return res;
}

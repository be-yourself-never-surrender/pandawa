import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PYTHON_WORKER_DIR, WORKSPACE_DIR } from "../config.js";

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
}

interface SessionMeta {
  ownerAgent: string;
  lastCommand: string;
  lastActivityAt: string;
}

const sessionMetaMap = new Map<string, SessionMeta>();
let _broadcast: ((ev: Record<string, unknown>) => void) | undefined;

export function setTerminalBroadcast(fn: (ev: Record<string, unknown>) => void): void {
  _broadcast = fn;
}

function getPythonBin(): string {
  const venvPy = path.join(PYTHON_WORKER_DIR, ".venv", "bin", "python3");
  if (fs.existsSync(venvPy)) return venvPy;
  return process.platform === "win32" ? "python" : "python3";
}

function getPtyScriptPath(): string {
  return path.join(PYTHON_WORKER_DIR, "pty_manager.py");
}

function sanitizeTerminalName(name: string): string {
  const slug = String(name || "main")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (slug || "main").slice(0, 36);
}

async function callPtyWorker<T = Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 310_000
): Promise<T> {
  const script = getPtyScriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(`Python PTY worker script missing at ${script}`);
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

export async function listTerminals(): Promise<{ ok: boolean; tmux: boolean; sessions: TerminalSessionInfo[]; error?: string }> {
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

    const sessions: TerminalSessionInfo[] = (res.sessions || []).map((s) => {
      const meta = sessionMetaMap.get(s.name);
      return {
        ...s,
        ownerAgent: meta?.ownerAgent || "shared",
        lastCommand: meta?.lastCommand || s.currentCommand || "",
        lastActivityAt: meta?.lastActivityAt || new Date().toISOString(),
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
}): Promise<Record<string, unknown>> {
  const cleanName = sanitizeTerminalName(params.name);
  const cwd = params.cwd ? path.resolve(WORKSPACE_DIR, params.cwd) : WORKSPACE_DIR;
  const res = await callPtyWorker<Record<string, unknown>>("open", {
    name: cleanName,
    cwd,
    env: params.env || {},
  });
  if (res.ok) {
    sessionMetaMap.set(cleanName, {
      ownerAgent: params.ownerAgent || sessionMetaMap.get(cleanName)?.ownerAgent || "user",
      lastCommand: sessionMetaMap.get(cleanName)?.lastCommand || "bash",
      lastActivityAt: new Date().toISOString(),
    });
    _broadcast?.({
      type: "terminal_updated",
      action: "open",
      name: cleanName,
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
}): Promise<Record<string, unknown>> {
  const cleanName = sanitizeTerminalName(params.name);
  const timeoutSec = Math.max(2, Math.min(300, Number(params.timeoutSec || 45)));
  const cwd = params.cwd ? path.resolve(WORKSPACE_DIR, params.cwd) : WORKSPACE_DIR;

  const existing = sessionMetaMap.get(cleanName);
  sessionMetaMap.set(cleanName, {
    ownerAgent: existing?.ownerAgent || params.actor || "shared",
    lastCommand: params.command.slice(0, 120),
    lastActivityAt: new Date().toISOString(),
  });

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
      command: params.command,
      cwd,
      timeoutSec,
    },
    (timeoutSec + 15) * 1000
  );

  sessionMetaMap.set(cleanName, {
    ownerAgent: existing?.ownerAgent || params.actor || "shared",
    lastCommand: params.command.slice(0, 120),
    lastActivityAt: new Date().toISOString(),
  });

  _broadcast?.({
    type: "terminal_output",
    name: cleanName,
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
}): Promise<Record<string, unknown>> {
  const cleanName = sanitizeTerminalName(params.name);
  const res = await callPtyWorker<Record<string, unknown>>("send", {
    name: cleanName,
    text: params.text,
    key: params.key,
    enter: params.enter ?? true,
  });

  const existing = sessionMetaMap.get(cleanName);
  sessionMetaMap.set(cleanName, {
    ownerAgent: existing?.ownerAgent || params.actor || "shared",
    lastCommand: (params.key || params.text || "").slice(0, 120),
    lastActivityAt: new Date().toISOString(),
  });

  _broadcast?.({
    type: "terminal_output",
    name: cleanName,
    actor: params.actor || "user",
    command: params.key || params.text || "",
    preview: String(res.output || "").slice(-800),
  });
  return res;
}

export async function readTerminal(name: string, lines = 200): Promise<Record<string, unknown>> {
  const cleanName = sanitizeTerminalName(name);
  return callPtyWorker<Record<string, unknown>>("read", { name: cleanName, lines }, 15_000);
}

export async function closeTerminal(name: string): Promise<Record<string, unknown>> {
  const cleanName = sanitizeTerminalName(name);
  const res = await callPtyWorker<Record<string, unknown>>("close", { name: cleanName }, 10_000);
  if (res.ok) {
    sessionMetaMap.delete(cleanName);
    _broadcast?.({ type: "terminal_updated", action: "close", name: cleanName });
  }
  return res;
}

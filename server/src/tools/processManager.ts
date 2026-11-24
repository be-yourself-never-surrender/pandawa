import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { generateId, resolveScopedCwd } from "../config.js";

export interface ManagedProcessInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  teamId?: string;
  pid: number | undefined;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  logLines: number;
}

interface InternalProcess {
  info: ManagedProcessInfo;
  proc: ChildProcess;
  logs: string[];
}

const processes = new Map<string, InternalProcess>();
const MAX_LOG_LINES = 400;

function appendLog(entry: InternalProcess, prefix: string, chunk: Buffer): void {
  const lines = chunk.toString("utf8").split(/\r?\n/);
  for (const l of lines) {
    if (!l) continue;
    entry.logs.push(`${prefix}${l}`);
    if (entry.logs.length > MAX_LOG_LINES) {
      entry.logs.shift();
    }
  }
  entry.info.logLines = entry.logs.length;
}

export function startManagedProcess(params: {
  name?: string;
  command: string;
  cwd?: string;
  teamId?: string;
}): ManagedProcessInfo {
  const id = generateId("proc");
  const cwd = resolveScopedCwd(params.cwd, params.teamId);
  fs.mkdirSync(cwd, { recursive: true });
  const proc = spawn(params.command, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const info: ManagedProcessInfo = {
    id,
    name: params.name || params.command.slice(0, 36),
    command: params.command,
    cwd,
    ...(params.teamId ? { teamId: params.teamId } : {}),
    pid: proc.pid,
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: "",
    logLines: 0,
  };

  const entry: InternalProcess = { info, proc, logs: [] };
  processes.set(id, entry);

  proc.stdout?.on("data", (buf: Buffer) => appendLog(entry, "", buf));
  proc.stderr?.on("data", (buf: Buffer) => appendLog(entry, "[stderr] ", buf));
  proc.on("exit", (code) => {
    entry.info.status = "exited";
    entry.info.exitCode = code;
    entry.info.endedAt = new Date().toISOString();
  });

  return info;
}

export function listManagedProcesses(teamId?: string): ManagedProcessInfo[] {
  return Array.from(processes.values())
    .filter((p) => !teamId || p.info.teamId === teamId)
    .map((p) => ({ ...p.info }));
}

export function getManagedProcessLogs(
  id: string,
  tail = 80,
  teamId?: string
): { info: ManagedProcessInfo; logs: string[] } | null {
  const entry = processes.get(id);
  if (!entry) return null;
  if (teamId && entry.info.teamId && entry.info.teamId !== teamId) return null;
  return {
    info: { ...entry.info },
    logs: entry.logs.slice(-Math.min(MAX_LOG_LINES, Math.max(1, tail))),
  };
}

export function killManagedProcess(id: string, teamId?: string): boolean {
  const entry = processes.get(id);
  if (!entry) return false;
  if (teamId && entry.info.teamId && entry.info.teamId !== teamId) return false;
  try {
    entry.proc.kill("SIGTERM");
    setTimeout(() => {
      if (entry.info.status === "running") {
        try {
          entry.proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 2000);
  } catch {
    // ignore
  }
  entry.info.status = "exited";
  entry.info.endedAt = new Date().toISOString();
  return true;
}

export function killAllManagedProcesses(): void {
  for (const id of processes.keys()) {
    killManagedProcess(id);
  }
}

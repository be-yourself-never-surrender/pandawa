import fs from "node:fs";
import path from "node:path";
import { exec, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { BRAINS_DIR, DATA_DIR, resolveTeamWorkspaceDir } from "../config.js";
import { getSetting, setSetting } from "../db/database.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type SandboxMode = "auto" | "bwrap" | "off";

export interface SandboxStatusSnapshot {
  mode: SandboxMode;
  platform: string;
  bwrapAvailable: boolean;
  effectiveEngine: "bwrap" | "scoped_cwd";
  reason: string;
}

let cachedBwrapOk: boolean | null = null;

export function resetSandboxProbeCache(): void {
  cachedBwrapOk = null;
}

export function getSandboxMode(): SandboxMode {
  try {
    const raw = (getSetting("sandbox_mode") || "auto").trim().toLowerCase();
    if (raw === "bwrap" || raw === "off" || raw === "auto") return raw;
  } catch {
    // db may not be initialized in isolated unit tests
  }
  return "auto";
}

export function setSandboxMode(mode: SandboxMode): SandboxMode {
  setSetting("sandbox_mode", mode);
  return mode;
}

export function isBwrapAvailable(): boolean {
  if (process.platform !== "linux") return false;
  if (cachedBwrapOk !== null) return cachedBwrapOk;
  try {
    execFileSync(
      "bwrap",
      ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--", "/bin/sh", "-c", "true"],
      { timeout: 3000, stdio: "ignore" }
    );
    cachedBwrapOk = true;
  } catch {
    cachedBwrapOk = false;
  }
  return cachedBwrapOk;
}

export function getSandboxStatus(): SandboxStatusSnapshot {
  const mode = getSandboxMode();
  const bwrapAvailable = isBwrapAvailable();
  if (mode === "off") {
    return {
      mode,
      platform: process.platform,
      bwrapAvailable,
      effectiveEngine: "scoped_cwd",
      reason: "OS sandbox disabled by policy (running app-level scoped_cwd).",
    };
  }
  if (bwrapAvailable) {
    return {
      mode,
      platform: process.platform,
      bwrapAvailable: true,
      effectiveEngine: "bwrap",
      reason: "bubblewrap namespace isolation active (.vault.key/DB/peer-teams hidden; Brains read-only; own workspace RW).",
    };
  }
  return {
    mode,
    platform: process.platform,
    bwrapAvailable: false,
    effectiveEngine: "scoped_cwd",
    reason:
      process.platform === "linux"
        ? "bubblewrap binary/userns unavailable; using app-level scoped_cwd isolation."
        : "Windows/non-Linux host; using app-level scoped_cwd isolation (install bubblewrap on Linux VPS for OS sandbox).",
  };
}

function isWithinOrEqual(target: string, root: string): boolean {
  const t = path.resolve(target);
  const r = path.resolve(root);
  return t === r || t.startsWith(r + path.sep);
}

export function buildBwrapArgs(command: string, cwd: string, teamId?: string | null): string[] {
  const dataDir = path.resolve(DATA_DIR);
  const brainsDir = path.resolve(BRAINS_DIR);
  const wsDir = path.resolve(resolveTeamWorkspaceDir(teamId));
  const resolvedCwd = path.resolve(cwd);

  fs.mkdirSync(wsDir, { recursive: true });

  const args: string[] = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];

  // Hide DATA_DIR (.vault.key, pandawa.db, whatsapp_sessions, other team workspaces)
  if (!isWithinOrEqual(dataDir, "/tmp")) {
    fs.mkdirSync(dataDir, { recursive: true });
    args.push("--tmpfs", dataDir);
  }

  // Expose Shared Brains strictly READ-ONLY inside sandbox
  if (fs.existsSync(brainsDir)) {
    args.push("--ro-bind", brainsDir, brainsDir);
  }

  // Expose ONLY this team's workspace (or global fallback when teamless) as READ-WRITE
  args.push("--bind", wsDir, wsDir);

  // Preserve explicit external cwd outside DATA_DIR and /tmp when requested
  if (!isWithinOrEqual(resolvedCwd, dataDir) && !isWithinOrEqual(resolvedCwd, "/tmp") && fs.existsSync(resolvedCwd)) {
    args.push("--bind", resolvedCwd, resolvedCwd);
  }

  const sandboxCwd = fs.existsSync(resolvedCwd) ? resolvedCwd : wsDir;
  args.push("--chdir", sandboxCwd, "--unshare-pid", "--die-with-parent", "--", "/bin/sh", "-c", command);
  return args;
}

export async function execSandboxedCommand(params: {
  command: string;
  cwd: string;
  teamId?: string | null;
  timeoutMs?: number;
  maxBuffer?: number;
}): Promise<{ stdout: string; stderr: string; sandboxed: boolean }> {
  const status = getSandboxStatus();
  const timeout = params.timeoutMs ?? 60_000;
  const maxBuffer = params.maxBuffer ?? 4 * 1024 * 1024;

  if (status.mode === "bwrap" && !status.bwrapAvailable) {
    throw new Error(
      "Strict OS sandbox (bwrap) is enabled, but bubblewrap is unavailable on this host. Install bubblewrap or switch Sandbox Mode to auto/off in Settings."
    );
  }

  if (status.effectiveEngine === "bwrap") {
    const bwrapArgs = buildBwrapArgs(params.command, params.cwd, params.teamId);
    const { stdout, stderr } = await execFileAsync("bwrap", bwrapArgs, {
      cwd: path.resolve(params.cwd),
      timeout,
      maxBuffer,
    });
    return { stdout: String(stdout || ""), stderr: String(stderr || ""), sandboxed: true };
  }

  const { stdout, stderr } = await execAsync(params.command, {
    cwd: params.cwd,
    timeout,
    maxBuffer,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || ""), sandboxed: false };
}

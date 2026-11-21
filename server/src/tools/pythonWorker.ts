import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PYTHON_WORKER_DIR, WORKSPACE_DIR } from "../config.js";

function getPythonBin(): string {
  const venvUnix = path.join(PYTHON_WORKER_DIR, ".venv", "bin", "python3");
  if (fs.existsSync(venvUnix)) return venvUnix;
  const venvWin = path.join(PYTHON_WORKER_DIR, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvWin)) return venvWin;
  return process.platform === "win32" ? "python" : "python3";
}

export async function runPythonWorker<T = Record<string, unknown>>(
  action: "status" | "doc_read" | "browser_run" | "import_zip",
  payload: Record<string, unknown> = {},
  timeoutMs = 90_000
): Promise<T> {
  const script = path.join(PYTHON_WORKER_DIR, "doc_and_browser.py");
  if (!fs.existsSync(script)) {
    throw new Error(`Python worker script not found at ${script}`);
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
      reject(new Error(`Python worker timed out (${action})`));
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
        reject(new Error(`Python worker error (exit ${code}): ${stderr || stdout || "empty output"}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function getPythonWorkerStatus(): Promise<Record<string, unknown>> {
  try {
    return await runPythonWorker("status", {}, 10_000);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      capabilities: {},
    };
  }
}

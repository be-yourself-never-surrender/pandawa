import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Terminal,
  Plus,
  RefreshCw,
  Trash2,
  Play,
  Square,
  Copy,
  Check,
  Cpu,
  Clock,
  Send,
  Sparkles,
} from "lucide-react";
import { apiFetch } from "../../api/client";

interface TerminalSession {
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

interface BackgroundJob {
  id: string;
  session_id: string;
  target_type: string;
  target_id: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "aborted";
  progress_text: string;
  result_preview: string;
  error_text: string;
  created_at: string;
}

interface TerminalPageProps {
  liveEvents: Array<Record<string, unknown>>;
  onOpenSession?: (sessionId: string) => void;
}

export const TerminalPage: React.FC<TerminalPageProps> = ({ liveEvents }) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [tmuxReady, setTmuxReady] = useState<boolean>(true);
  const [activeName, setActiveName] = useState<string>("");
  const [output, setOutput] = useState<string>("");
  const [cwd, setCwd] = useState<string>("");
  const [cmdInput, setCmdInput] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const [autoFollow, setAutoFollow] = useState<boolean>(true);
  const [newName, setNewName] = useState<string>("");
  const [copiedAttach, setCopiedAttach] = useState<string>("");
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [runtimeInfo, setRuntimeInfo] = useState<{
    pythonWorker?: { ok?: boolean; python?: string; capabilities?: Record<string, boolean> };
    tmuxAvailable?: boolean;
  } | null>(null);

  const preRef = useRef<HTMLPreElement | null>(null);

  const loadAll = useCallback(async () => {
    const [tRes, jRes, rRes] = await Promise.all([
      apiFetch<{ ok: boolean; tmux: boolean; sessions: TerminalSession[] }>("/api/terminals"),
      apiFetch<{ jobs: BackgroundJob[] }>("/api/jobs"),
      apiFetch<{
        pythonWorker?: { ok?: boolean; python?: string; capabilities?: Record<string, boolean> };
        tmuxAvailable?: boolean;
      }>("/api/system/runtime"),
    ]);
    setTmuxReady(Boolean(tRes.tmux));
    setSessions(tRes.sessions || []);
    setJobs(jRes.jobs || []);
    setRuntimeInfo(rRes);
    setActiveName((prev) => {
      if (prev && (tRes.sessions || []).some((s) => s.name === prev)) return prev;
      return tRes.sessions?.[0]?.name || "";
    });
  }, []);

  const loadOutput = useCallback(async (name: string) => {
    if (!name) {
      setOutput("");
      return;
    }
    try {
      const res = await apiFetch<{ ok: boolean; output?: string; cwd?: string }>(
        `/api/terminals/${encodeURIComponent(name)}/output?lines=300`
      );
      if (res.ok) {
        setOutput(res.output || "");
        if (res.cwd) setCwd(res.cwd);
      }
    } catch {
      // ignore transient error
    }
  }, []);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll]);

  useEffect(() => {
    if (!activeName) return;
    loadOutput(activeName);
    if (!autoFollow) return;
    const timer = window.setInterval(() => {
      loadOutput(activeName);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeName, autoFollow, loadOutput]);

  // React immediately when any agent executes in a shared terminal or updates a background job
  useEffect(() => {
    const latest = liveEvents[liveEvents.length - 1];
    if (!latest) return;
    const t = String(latest.type || "");
    if (t === "terminal_output" || t === "terminal_updated" || t === "terminal_exec") {
      loadAll().catch(() => {});
      if (activeName) loadOutput(activeName);
    } else if (t === "background_job_updated") {
      apiFetch<{ jobs: BackgroundJob[] }>("/api/jobs")
        .then((r) => setJobs(r.jobs || []))
        .catch(() => {});
    }
  }, [liveEvents, activeName, loadAll, loadOutput]);

  useEffect(() => {
    if (autoFollow && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [output, autoFollow]);

  async function handleOpenTerminal(e: React.FormEvent) {
    e.preventDefault();
    const target = newName.trim() || `shell-${sessions.length + 1}`;
    await apiFetch("/api/terminals", {
      method: "POST",
      body: JSON.stringify({ name: target, ownerAgent: "user" }),
    });
    setNewName("");
    await loadAll();
    const slug = target.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    setActiveName(slug || "main");
    await loadOutput(slug || "main");
  }

  async function handleExec(e: React.FormEvent) {
    e.preventDefault();
    if (!cmdInput.trim() || running) return;
    const target = activeName || "main";
    const cmd = cmdInput.trim();
    setCmdInput("");
    setRunning(true);
    try {
      await apiFetch(`/api/terminals/${encodeURIComponent(target)}/exec`, {
        method: "POST",
        body: JSON.stringify({ command: cmd, timeoutSec: 30 }),
      });
      await loadAll();
      await loadOutput(target);
    } finally {
      setRunning(false);
    }
  }

  async function sendSpecialKey(key: string) {
    if (!activeName) return;
    await apiFetch(`/api/terminals/${encodeURIComponent(activeName)}/send`, {
      method: "POST",
      body: JSON.stringify({ key }),
    });
    await loadOutput(activeName);
  }

  async function handleClose(name: string) {
    if (!window.confirm(`Close shared terminal "${name}"?`)) return;
    await apiFetch(`/api/terminals/${encodeURIComponent(name)}`, { method: "DELETE" });
    await loadAll();
  }

  const activeSession = sessions.find((s) => s.name === activeName);
  const pyCaps = runtimeInfo?.pythonWorker?.capabilities || {};

  return (
    <div className="flex h-screen bg-[#080a0f] overflow-hidden">
      {/* Left Sidebar: Living Shared Terminals & Background Jobs */}
      <aside className="w-72 shrink-0 bg-[#0d111b] border-r border-slate-800/80 flex flex-col">
        <div className="p-3.5 border-b border-slate-800/80 space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-emerald-400" /> Shared Terminals
            </h2>
            <button
              onClick={() => loadAll()}
              title="Refresh terminals & jobs"
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <form onSubmit={handleOpenTerminal} className="flex gap-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New terminal (e.g. backend)"
              className="flex-1 min-w-0 bg-[#080a0f] border border-slate-700 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none"
            />
            <button
              type="submit"
              className="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1 cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Open
            </button>
          </form>

          {/* Hybrid Runtime Status Pills */}
          <div className="flex flex-wrap gap-1 text-[10px]">
            <span
              className={`px-2 py-0.5 rounded-full border ${
                tmuxReady
                  ? "bg-emerald-500/15 border-emerald-500/35 text-emerald-300"
                  : "bg-rose-500/15 border-rose-500/35 text-rose-300"
              }`}
            >
              tmux {tmuxReady ? "✓" : "off"}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/35 text-cyan-300">
              Py {runtimeInfo?.pythonWorker?.python || "3.x"}
            </span>
            <span
              className={`px-2 py-0.5 rounded-full border ${
                pyCaps.playwright
                  ? "bg-violet-500/15 border-violet-500/35 text-violet-300"
                  : "bg-slate-800 border-slate-700 text-slate-400"
              }`}
            >
              Playwright {runtimeInfo === null ? "…" : pyCaps.playwright ? "✓" : "—"}
            </span>
          </div>
        </div>

        {/* Active Shared Terminals List */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
          {sessions.map((s) => (
            <div
              key={s.name}
              onClick={() => setActiveName(s.name)}
              className={`p-2.5 rounded-xl border transition cursor-pointer space-y-1 ${
                activeName === s.name
                  ? "bg-emerald-500/12 border-emerald-500/45"
                  : "bg-[#090c14] border-slate-800 hover:border-slate-700"
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-xs font-bold font-mono text-white truncate flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  {s.name}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300">
                    {s.ownerAgent}
                  </span>
                  <button
                    aria-label={`Close ${s.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClose(s.name);
                    }}
                    className="p-1 rounded text-slate-500 hover:text-rose-400 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="text-[10px] font-mono text-slate-400 truncate">{s.cwd}</div>
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span className="truncate">cmd: {s.currentCommand}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard?.writeText(s.attachCommand).catch(() => {});
                    setCopiedAttach(s.name);
                    setTimeout(() => setCopiedAttach(""), 1800);
                  }}
                  title={`Copy: ${s.attachCommand}`}
                  className="text-amber-300 hover:text-amber-200 flex items-center gap-0.5 cursor-pointer shrink-0"
                >
                  {copiedAttach === s.name ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  tmux
                </button>
              </div>
            </div>
          ))}

          {sessions.length === 0 && (
            <div className="p-4 rounded-xl bg-[#090c14] border border-slate-800/80 text-center space-y-2 text-xs text-slate-400">
              <Terminal className="w-6 h-6 text-slate-600 mx-auto" />
              <p>No active shared terminals yet.</p>
              <p className="text-[11px] text-slate-500">
                Open one above or let Pandawa agents spawn terminals via <code>term_open</code> &amp; <code>term_exec</code>.
              </p>
            </div>
          )}

          {/* Background Autonomous Daemon Jobs */}
          <div className="pt-3 border-t border-slate-800/80 space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5 px-1">
              <Clock className="w-3 h-3 text-amber-400" /> Background Daemon Jobs ({jobs.length})
            </div>
            {jobs.slice(0, 8).map((j) => (
              <div key={j.id} className="p-2.5 rounded-xl bg-[#090c14] border border-slate-800 space-y-1 text-[11px]">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono text-[10px] text-slate-400 truncate">{j.id}</span>
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded uppercase font-bold ${
                      j.status === "running"
                        ? "bg-amber-500/20 text-amber-300 animate-pulse"
                        : j.status === "completed"
                        ? "bg-emerald-500/20 text-emerald-300"
                        : j.status === "failed"
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {j.status}
                  </span>
                </div>
                <div className="text-slate-200 line-clamp-2">{j.prompt}</div>
                <div className="text-[10px] text-slate-500 truncate">{j.progress_text}</div>
                {(j.status === "running" || j.status === "queued") && (
                  <button
                    onClick={async () => {
                      await apiFetch(`/api/jobs/${j.id}/cancel`, { method: "POST" });
                      await loadAll();
                    }}
                    className="mt-1 px-2 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px] font-semibold cursor-pointer"
                  >
                    Abort Job
                  </button>
                )}
              </div>
            ))}
            {jobs.length === 0 && (
              <div className="text-[11px] text-slate-500 px-1">
                Toggle <strong>Background</strong> in Mission Room to launch 24/7 autonomous daemon missions.
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Live Terminal Screen */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="min-h-14 px-4 py-2.5 bg-[#0d111b] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-bold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-400 shrink-0" />
              {activeSession ? `Terminal: ${activeSession.name}` : "Pandawa Living Terminal"}
              {activeSession && (
                <code className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-amber-300">
                  {activeSession.attachCommand}
                </code>
              )}
            </div>
            <div className="text-[11px] text-slate-400 truncate mt-0.5">
              {cwd
                ? `cwd: ${cwd} · Shared live between You and all Pandawa Agents`
                : "Stateful tmux/PTY sessions where AI agents & humans work side by side"}
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            <button
              onClick={() => setAutoFollow((a) => !a)}
              className={`px-2.5 py-1.5 rounded-lg border font-medium cursor-pointer ${
                autoFollow
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                  : "bg-slate-800 border-slate-700 text-slate-400"
              }`}
            >
              {autoFollow ? "● Live Follow" : "Paused"}
            </button>
            <button
              onClick={() => sendSpecialKey("C-c")}
              disabled={!activeName}
              className="px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-300 font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <Square className="w-3 h-3" /> Ctrl+C
            </button>
            <button
              onClick={() => sendSpecialKey("C-l")}
              disabled={!activeName}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer disabled:opacity-40"
            >
              Clear
            </button>
            <button
              onClick={() => activeName && loadOutput(activeName)}
              disabled={!activeName}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Pull
            </button>
          </div>
        </header>

        {/* Terminal Viewport */}
        <div className="flex-1 min-h-0 bg-[#05070c] p-4 flex flex-col">
          {!activeName ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/35 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-emerald-400" />
              </div>
              <h3 className="text-base font-bold text-white">Living Multi-Agent Terminal OS</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Every terminal opened here (or by Arjuna, Bima &amp; Sadewa) runs inside a persistent{" "}
                <code>tmux</code> session. <code>cd</code>, virtualenvs, servers, and interactive CLIs stay alive—and
                teammates can inspect each other&apos;s live output!
              </p>
              <button
                onClick={async () => {
                  await apiFetch("/api/terminals", {
                    method: "POST",
                    body: JSON.stringify({ name: "main", ownerAgent: "user" }),
                  });
                  await loadAll();
                  setActiveName("main");
                  await loadOutput("main");
                }}
                className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" /> Start Main Shared Terminal
              </button>
            </div>
          ) : (
            <pre
              ref={preRef}
              className="flex-1 overflow-auto font-mono text-xs leading-relaxed text-emerald-300/95 whitespace-pre-wrap break-words bg-[#030509] border border-slate-800/90 rounded-xl p-4 shadow-inner"
            >
              {output || "$ (terminal ready — type a command below or let a Pandawa agent execute here)"}
            </pre>
          )}
        </div>

        {/* Interactive Command Input */}
        <form
          onSubmit={handleExec}
          className="p-3.5 bg-[#0d111b] border-t border-slate-800/80 flex items-center gap-2"
        >
          <span className="font-mono text-xs font-bold text-emerald-400 shrink-0">
            {activeName || "main"} $
          </span>
          <input
            value={cmdInput}
            onChange={(e) => setCmdInput(e.target.value)}
            placeholder="Run any command in this shared persistent terminal (e.g. ls -la, python3 --version, git status)..."
            className="flex-1 bg-[#05070c] border border-slate-700 focus:border-emerald-500 rounded-xl px-3.5 py-2 font-mono text-xs text-white outline-none"
          />
          <button
            type="submit"
            disabled={!cmdInput.trim() || running}
            className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Send className="w-3.5 h-3.5" /> {running ? "Running..." : "Run"}
          </button>
        </form>
      </div>
    </div>
  );
};

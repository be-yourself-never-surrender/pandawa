import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
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
  Wifi,
  WifiOff,
} from "lucide-react";
import { apiFetch, requestWsTicket } from "../../api/client";
import { advanceEventCursor } from "../../utils/routingHelpers";

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

function base64ToUint8(b64: string): Uint8Array {
  const bin = window.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export const TerminalPage: React.FC<TerminalPageProps> = ({ liveEvents }) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [tmuxReady, setTmuxReady] = useState<boolean>(true);
  const [activeName, setActiveName] = useState<string>("");
  const [ptyConnected, setPtyConnected] = useState<boolean>(false);
  const [reconnectSeq, setReconnectSeq] = useState<number>(0);
  const [cmdInput, setCmdInput] = useState<string>("");
  const [newName, setNewName] = useState<string>("");
  const [copiedAttach, setCopiedAttach] = useState<string>("");
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [runtimeInfo, setRuntimeInfo] = useState<{
    pythonWorker?: { ok?: boolean; python?: string; capabilities?: Record<string, boolean> };
    tmuxAvailable?: boolean;
    semanticMemory?: { totalChunks?: number; mode?: string };
  } | null>(null);

  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);

  const loadAll = useCallback(async () => {
    const [tRes, jRes, rRes] = await Promise.all([
      apiFetch<{ ok: boolean; tmux: boolean; sessions: TerminalSession[] }>("/api/terminals"),
      apiFetch<{ jobs: BackgroundJob[] }>("/api/jobs"),
      apiFetch<{
        pythonWorker?: { ok?: boolean; python?: string; capabilities?: Record<string, boolean> };
        tmuxAvailable?: boolean;
        semanticMemory?: { totalChunks?: number; mode?: string };
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

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll]);

  // React immediately when any agent creates/closes a terminal or updates a background job
  useEffect(() => {
    const { nextSeq, freshEvents } = advanceEventCursor(liveEvents, lastSeqRef.current);
    lastSeqRef.current = nextSeq;
    let reloadAllFlag = false;
    let reloadJobsFlag = false;
    for (const ev of freshEvents) {
      const t = String(ev.type || "");
      if (t === "terminal_updated" || t === "terminal_exec") reloadAllFlag = true;
      else if (t === "background_job_updated") reloadJobsFlag = true;
    }
    if (reloadAllFlag) {
      loadAll().catch(() => {});
    } else if (reloadJobsFlag) {
      apiFetch<{ jobs: BackgroundJob[] }>("/api/jobs")
        .then((r) => setJobs(r.jobs || []))
        .catch(() => {});
    }
  }, [liveEvents, loadAll]);

  // Mount real-time 60fps xterm.js <-> WebSocket PTY <-> tmux stream whenever activeName changes
  useEffect(() => {
    const container = termContainerRef.current;
    if (!activeName || !container) {
      setPtyConnected(false);
      return;
    }

    container.innerHTML = "";
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 5000,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#e5a00d",
        selectionBackground: "rgba(229, 160, 13, 0.28)",
        black: "#18181b",
        red: "#f43f5e",
        green: "#34d399",
        yellow: "#f5b027",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#f4f4f5",
        brightBlack: "#52525b",
        brightRed: "#fb7185",
        brightGreen: "#6ee7b7",
        brightYellow: "#fcd34d",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    try {
      fitAddon.fit();
    } catch {
      // ignore initial fit race
    }
    term.focus();
    xtermRef.current = term;

    let disposed = false;
    let ws: WebSocket | null = null;
    let dataDisp: { dispose: () => void } | null = null;

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const cols = term.cols || 120;
    const rows = term.rows || 32;

    requestWsTicket()
      .then((ticket) => {
        if (disposed) return;
        const wsUrl = `${proto}://${window.location.host}/ws/terminal?ticket=${encodeURIComponent(ticket)}&name=${encodeURIComponent(activeName)}&cols=${cols}&rows=${rows}`;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (disposed) return;
          setPtyConnected(true);
          try {
            fitAddon.fit();
            ws?.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          } catch {
            // ignore
          }
        };

        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as { type?: string; b64?: string; message?: string };
            if (msg.type === "data" && msg.b64) {
              term.write(base64ToUint8(msg.b64));
            } else if (msg.type === "error" && msg.message) {
              term.writeln(`\r\n\x1b[31m[PTY Error] ${msg.message}\x1b[0m`);
            } else if (msg.type === "exit") {
              setPtyConnected(false);
            }
          } catch {
            // ignore malformed packet
          }
        };

        ws.onclose = () => setPtyConnected(false);
        ws.onerror = () => setPtyConnected(false);

        dataDisp = term.onData((data) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data }));
          }
        });
      })
      .catch((err) => {
        if (!disposed) {
          term.writeln(`\r\n\x1b[31m[PTY Auth Error] ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        }
      });

    let resizeRaf = 0;
    const resizeObs = new ResizeObserver(() => {
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
      resizeRaf = window.requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        } catch {
          // ignore
        }
      });
    });
    resizeObs.observe(container);

    return () => {
      disposed = true;
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
      resizeObs.disconnect();
      dataDisp?.dispose();
      ws?.close();
      wsRef.current = null;
      term.dispose();
      xtermRef.current = null;
      setPtyConnected(false);
    };
  }, [activeName, reconnectSeq]);

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
  }

  function sendRawInput(data: string) {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data }));
      xtermRef.current?.focus();
    }
  }

  async function handleQuickCommand(e: React.FormEvent) {
    e.preventDefault();
    if (!cmdInput.trim()) return;
    const cmd = cmdInput.trim();
    setCmdInput("");
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: `${cmd}\r` }));
      xtermRef.current?.focus();
    } else if (activeName) {
      await apiFetch(`/api/terminals/${encodeURIComponent(activeName)}/exec`, {
        method: "POST",
        body: JSON.stringify({ command: cmd, timeoutSec: 30 }),
      });
    }
  }

  async function handleClose(name: string) {
    if (!window.confirm(`Close shared terminal "${name}"?`)) return;
    await apiFetch(`/api/terminals/${encodeURIComponent(name)}`, { method: "DELETE" });
    await loadAll();
  }

  const activeSession = sessions.find((s) => s.name === activeName);
  const pyCaps = runtimeInfo?.pythonWorker?.capabilities || {};

  return (
    <div className="flex h-screen bg-[#09090b] overflow-hidden">
      {/* Left Sidebar: Living Shared Terminals & Background Jobs */}
      <aside className="w-72 shrink-0 bg-[#0c0c0e] border-r border-white/[0.07] flex flex-col">
        <div className="p-3.5 border-b border-white/[0.07] space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-emerald-400" /> Shared PTY Terminals
            </h2>
            <button
              onClick={() => loadAll()}
              title="Refresh terminals & jobs"
              className="p-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] text-zinc-300 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <form onSubmit={handleOpenTerminal} className="flex gap-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New terminal (e.g. backend)"
              className="flex-1 min-w-0 bg-[#09090b] border border-white/[0.10] focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none"
            />
            <button
              type="submit"
              className="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold text-xs flex items-center gap-1 cursor-pointer shrink-0"
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
              Py {runtimeInfo?.pythonWorker?.python || "…"}
            </span>
            <span
              className={`px-2 py-0.5 rounded-full border ${
                pyCaps.playwright
                  ? "bg-violet-500/15 border-violet-500/35 text-violet-300"
                  : "bg-[#18181b] border-white/[0.10] text-zinc-400"
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
                  : "bg-[#0c0c0e] border-white/[0.08] hover:border-white/[0.10]"
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-xs font-bold font-mono text-white truncate flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  {s.name}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#18181b] text-cyan-300">
                    {s.ownerAgent}
                  </span>
                  <button
                    aria-label={`Close ${s.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClose(s.name);
                    }}
                    className="p-1 rounded text-zinc-500 hover:text-rose-400 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="text-[10px] font-mono text-zinc-400 truncate">{s.cwd}</div>
              <div className="flex items-center justify-between text-[10px] text-zinc-500">
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
            <div className="p-4 rounded-xl bg-[#0c0c0e] border border-white/[0.07] text-center space-y-2 text-xs text-zinc-400">
              <Terminal className="w-6 h-6 text-zinc-600 mx-auto" />
              <p>No active shared terminals yet.</p>
              <p className="text-[11px] text-zinc-500">
                Open one above or let Pandawa agents spawn terminals via <code>term_open</code> &amp; <code>term_exec</code>.
              </p>
            </div>
          )}

          {/* Background Autonomous Daemon Jobs */}
          <div className="pt-3 border-t border-white/[0.07] space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5 px-1">
              <Clock className="w-3 h-3 text-amber-400" /> Background Daemon Jobs ({jobs.length})
            </div>
            {jobs.slice(0, 8).map((j) => (
              <div key={j.id} className="p-2.5 rounded-xl bg-[#0c0c0e] border border-white/[0.08] space-y-1 text-[11px]">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono text-[10px] text-zinc-400 truncate">{j.id}</span>
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded uppercase font-bold ${
                      j.status === "running"
                        ? "bg-amber-500/20 text-amber-300 animate-pulse"
                        : j.status === "completed"
                        ? "bg-emerald-500/20 text-emerald-300"
                        : j.status === "failed"
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-[#18181b] text-zinc-400"
                    }`}
                  >
                    {j.status}
                  </span>
                </div>
                <div className="text-zinc-200 line-clamp-2">{j.prompt}</div>
                <div className="text-[10px] text-zinc-500 truncate">{j.progress_text}</div>
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
              <div className="text-[11px] text-zinc-500 px-1">
                Toggle <strong>BG</strong> in Mission Room to launch 24/7 autonomous daemon missions.
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Real-Time xterm.js PTY Screen */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="min-h-14 px-4 py-2.5 bg-[#0c0c0e] border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-bold text-white flex items-center gap-2 flex-wrap">
              <Cpu className="w-4 h-4 text-emerald-400 shrink-0" />
              {activeSession ? `PTY: ${activeSession.name}` : "Pandawa Live Interactive PTY Terminal"}
              {activeName && (
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold inline-flex items-center gap-1 ${
                    ptyConnected
                      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                      : "bg-[#18181b] border-white/[0.10] text-zinc-400"
                  }`}
                >
                  {ptyConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                  {ptyConnected ? "xterm.js PTY Live" : "Disconnected"}
                </span>
              )}
              {activeSession && (
                <code className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#18181b] text-amber-300">
                  {activeSession.attachCommand}
                </code>
              )}
            </div>
            <div className="text-[11px] text-zinc-400 truncate mt-0.5">
              Real-time ANSI interactive terminal — click inside to type directly (vim, htop, python, node) alongside Pandawa agents
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            <button
              onClick={() => sendRawInput("\x03")}
              disabled={!ptyConnected}
              className="px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-300 font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <Square className="w-3 h-3" /> Ctrl+C
            </button>
            <button
              onClick={() => sendRawInput("\x0c")}
              disabled={!ptyConnected}
              className="px-2.5 py-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] text-zinc-300 cursor-pointer disabled:opacity-40"
            >
              Clear
            </button>
            <button
              onClick={() => setReconnectSeq((s) => s + 1)}
              disabled={!activeName}
              className="px-2.5 py-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] text-zinc-200 flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Reconnect
            </button>
          </div>
        </header>

        {/* Full Interactive xterm.js Canvas */}
        <div className="flex-1 min-h-0 bg-[#09090b] p-3 flex flex-col">
          {!activeName ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-3">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/15 border border-emerald-500/35 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-emerald-400" />
              </div>
              <h3 className="text-base font-bold text-white">Real-Time Interactive Multi-Agent PTY</h3>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Powered by <strong>xterm.js + WebSocket PTY + tmux</strong>. Full ANSI colors, interactive shells,
                live servers, and instant keystrokes—shared seamlessly between you and Arjuna, Bima &amp; Sadewa!
              </p>
              <button
                onClick={async () => {
                  await apiFetch("/api/terminals", {
                    method: "POST",
                    body: JSON.stringify({ name: "main", ownerAgent: "user" }),
                  });
                  await loadAll();
                  setActiveName("main");
                }}
                className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" /> Launch Interactive Main PTY
              </button>
            </div>
          ) : (
            <div
              ref={termContainerRef}
              onClick={() => xtermRef.current?.focus()}
              className="flex-1 min-h-0 w-full rounded-xl overflow-hidden border border-white/[0.08] bg-[#09090b] p-2 shadow-inner"
            />
          )}
        </div>

        {/* Quick Send Bar (in addition to typing directly inside xterm.js!) */}
        <form
          onSubmit={handleQuickCommand}
          className="px-3.5 py-2.5 bg-[#0c0c0e] border-t border-white/[0.07] flex items-center gap-2"
        >
          <span className="font-mono text-xs font-bold text-emerald-400 shrink-0">
            {activeName || "main"} $
          </span>
          <input
            value={cmdInput}
            onChange={(e) => setCmdInput(e.target.value)}
            placeholder="Type directly in the terminal above, OR paste a command here and press Enter..."
            className="flex-1 bg-[#09090b] border border-white/[0.10] focus:border-emerald-500 rounded-xl px-3.5 py-2 font-mono text-xs text-white outline-none"
          />
          <button
            type="submit"
            disabled={!cmdInput.trim() || !activeName}
            className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-[#18181b] disabled:text-zinc-500 text-zinc-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Send className="w-3.5 h-3.5" /> Send
          </button>
        </form>
      </div>
    </div>
  );
};

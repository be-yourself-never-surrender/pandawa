import React, { useCallback, useEffect, useState } from "react";
import { Clock, Play, Trash2, Radio, Plug, Plus, Activity, FileText } from "lucide-react";
import { apiFetch } from "../../api/client";
import type { TeamItem } from "../../types";

interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  teamId: string;
  notifyChannelId: string;
  checklistPath: string;
  lastPulseAt: string;
  lastStatus: string;
}

interface HeartbeatLogItem {
  id: string;
  status: "ok" | "alert" | "error";
  summary: string;
  alerted: number;
  duration_ms: number;
  created_at: string;
}

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  target_type: string;
  target_id: string;
  prompt: string;
  enabled: number;
  last_run_at: string;
  last_status: string;
  last_output: string;
}

interface ChannelItem {
  id: string;
  name: string;
  type: string;
  config: Record<string, string>;
  target_type: string;
  target_id: string;
  enabled: boolean;
  poller?: { active: boolean; lastPollAt: string; lastError: string } | null;
}

interface McpItem {
  id: string;
  name: string;
  transport: string;
  url_or_cmd: string;
  enabled: boolean;
}

interface DiscoveredToolItem {
  qualifiedName: string;
  rawName: string;
  description: string;
}

interface AutomationPageProps {
  onOpenFile?: (path: string) => void;
  onOpenChannels?: () => void;
}

export const AutomationPage: React.FC<AutomationPageProps> = ({ onOpenFile, onOpenChannels }) => {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [mcps, setMcps] = useState<McpItem[]>([]);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [hbConfig, setHbConfig] = useState<HeartbeatConfig | null>(null);
  const [hbLogs, setHbLogs] = useState<HeartbeatLogItem[]>([]);
  const [pulsing, setPulsing] = useState(false);

  // Cron form
  const [cronName, setCronName] = useState("");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [cronPrompt, setCronPrompt] = useState("");

  // MCP form
  const [mcpName, setMcpName] = useState("");
  const [mcpTransport, setMcpTransport] = useState("http");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpDiscovered, setMcpDiscovered] = useState<
    Record<string, { loading?: boolean; tools?: DiscoveredToolItem[]; error?: string }>
  >({});

  const load = useCallback(async () => {
    const [jRes, cRes, mRes, tRes, hRes] = await Promise.all([
      apiFetch<{ jobs: CronJob[] }>("/api/cron"),
      apiFetch<{ channels: ChannelItem[] }>("/api/channels"),
      apiFetch<{ servers: McpItem[] }>("/api/connectors"),
      apiFetch<{ teams: TeamItem[] }>("/api/teams"),
      apiFetch<{ config: HeartbeatConfig; logs: HeartbeatLogItem[] }>("/api/heartbeat").catch(() => null),
    ]);
    setJobs(jRes.jobs);
    setChannels(cRes.channels);
    setMcps(mRes.servers);
    setTeams(tRes.teams);
    if (hRes) {
      setHbConfig(hRes.config);
      setHbLogs(hRes.logs || []);
    }
  }, []);

  async function saveHeartbeat(patch: Partial<HeartbeatConfig>) {
    const res = await apiFetch<{ config: HeartbeatConfig }>("/api/heartbeat", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    setHbConfig(res.config);
  }

  async function triggerHeartbeatNow() {
    setPulsing(true);
    try {
      await apiFetch("/api/heartbeat/pulse", { method: "POST" });
      await load();
    } finally {
      setPulsing(false);
    }
  }

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  async function addCron(e: React.FormEvent) {
    e.preventDefault();
    if (!cronName.trim() || !cronPrompt.trim()) return;
    await apiFetch("/api/cron", {
      method: "POST",
      body: JSON.stringify({
        name: cronName.trim(),
        schedule: cronExpr.trim(),
        targetType: "team",
        targetId: teams[0]?.id || "team_pandawa",
        prompt: cronPrompt.trim(),
      }),
    });
    setCronName("");
    setCronPrompt("");
    await load();
  }

  async function addMcp(e: React.FormEvent) {
    e.preventDefault();
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    await apiFetch("/api/connectors", {
      method: "POST",
      body: JSON.stringify({ name: mcpName.trim(), transport: mcpTransport, urlOrCmd: mcpUrl.trim() }),
    });
    setMcpName("");
    setMcpUrl("");
    await load();
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#09090b] p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Clock className="w-5 h-5 text-cyan-400" /> Automation, Channels & MCP
        </h1>
        <p className="text-xs text-zinc-400 mt-1">
          Schedule recurring Team Pandawa missions, bridge Telegram / Discord / Webhooks, and register external MCP servers.
        </p>
      </div>

      {/* PROACTIVE AUTONOMOUS HEARTBEAT DAEMON (Beyond OpenClaw) */}
      <section className="rounded-xl bg-[#111113] border border-emerald-500/35 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-emerald-300 flex items-center gap-2">
              <Activity className="w-4 h-4" /> Proactive Autonomous Heartbeat Daemon
              {hbConfig && (
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${
                    hbConfig.enabled
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                      : "bg-[#18181b] text-zinc-400"
                  }`}
                >
                  {hbConfig.enabled ? `Active · Every ${hbConfig.intervalMinutes}m` : "Paused"}
                </span>
              )}
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Periodically wakes Team Pandawa to inspect living terminals, background jobs, open tasks &amp;{" "}
              <code className="text-amber-300">main-brain/HEARTBEAT.md</code> — silently logs <code>HEARTBEAT_OK</code>{" "}
              and alerts Telegram/Discord only when real action is needed.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {onOpenFile && (
              <button
                onClick={() => onOpenFile(hbConfig?.checklistPath || "main-brain/HEARTBEAT.md")}
                className="px-3 py-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] border border-white/[0.10] text-amber-300 font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5" /> Edit HEARTBEAT.md
              </button>
            )}
            <button
              onClick={triggerHeartbeatNow}
              disabled={pulsing}
              className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" /> {pulsing ? "Pulsing..." : "Pulse Now"}
            </button>
          </div>
        </div>

        {hbConfig && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs bg-[#0c0c0e] border border-white/[0.08] rounded-xl p-3.5">
            <button
              type="button"
              onClick={() => saveHeartbeat({ enabled: !hbConfig.enabled })}
              className={`px-3 py-1.5 rounded-lg border font-semibold flex items-center gap-2 cursor-pointer transition ${
                hbConfig.enabled
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                  : "bg-[#18181b] border-white/[0.10] text-zinc-300 hover:bg-[#222227]"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  hbConfig.enabled ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : "bg-slate-500"
                }`}
              />
              24/7 Autonomous Daemon: {hbConfig.enabled ? "ON" : "OFF"}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-zinc-400 whitespace-nowrap">Interval:</span>
              <select
                value={hbConfig.intervalMinutes}
                onChange={(e) => saveHeartbeat({ intervalMinutes: Number(e.target.value) })}
                className="bg-[#09090b] border border-white/[0.10] rounded-lg px-2.5 py-1.5 text-white"
              >
                <option value={5}>Every 5 min</option>
                <option value={15}>Every 15 min</option>
                <option value={30}>Every 30 min</option>
                <option value={60}>Every 1 hour</option>
                <option value={240}>Every 4 hours</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-zinc-400 whitespace-nowrap">Alert Channel:</span>
              <select
                value={hbConfig.notifyChannelId}
                onChange={(e) => saveHeartbeat({ notifyChannelId: e.target.value })}
                className="bg-[#09090b] border border-white/[0.10] rounded-lg px-2.5 py-1.5 text-white max-w-[180px]"
              >
                <option value="">Auto (First Enabled)</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.type})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {hbLogs.length > 0 && (
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {hbLogs.slice(0, 6).map((l) => (
              <div
                key={l.id}
                className="px-3 py-2 rounded-lg bg-[#0c0c0e] border border-white/[0.07] flex items-start justify-between gap-2 text-[11px]"
              >
                <div className="flex items-start gap-2 min-w-0">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase shrink-0 ${
                      l.status === "ok"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : l.status === "alert"
                        ? "bg-amber-500/20 text-amber-300"
                        : "bg-rose-500/20 text-rose-300"
                    }`}
                  >
                    {l.status}
                  </span>
                  <span className="text-zinc-300 line-clamp-2">{l.summary}</span>
                </div>
                <span className="text-[10px] text-zinc-500 shrink-0 font-mono">{l.duration_ms}ms</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* CRON SCHEDULER */}
      <section className="rounded-xl bg-[#111113] border border-white/[0.08] p-5 space-y-4">
        <h2 className="text-sm font-bold text-amber-300 flex items-center gap-2">
          <Clock className="w-4 h-4" /> Cron Scheduler
        </h2>
        <form onSubmit={addCron} className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 text-xs">
          <input
            value={cronName}
            onChange={(e) => setCronName(e.target.value)}
            placeholder="Job Name (e.g. Daily Briefing)"
            className="lg:col-span-3 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
          />
          <input
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="0 9 * * *"
            className="lg:col-span-2 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 font-mono text-white"
          />
          <input
            value={cronPrompt}
            onChange={(e) => setCronPrompt(e.target.value)}
            placeholder="Mission prompt for Team Pandawa..."
            className="lg:col-span-5 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
          />
          <button
            type="submit"
            disabled={!cronName.trim() || !cronPrompt.trim()}
            className="lg:col-span-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-[#18181b] disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </form>

        <div className="space-y-2">
          {jobs.map((j) => (
            <div key={j.id} className="p-3.5 rounded-xl bg-[#0c0c0e] border border-white/[0.08] flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="space-y-0.5 min-w-0">
                <div className="font-semibold text-white flex items-center gap-2">
                  {j.name}
                  <code className="text-[11px] px-1.5 py-0.5 rounded bg-[#18181b] text-cyan-300">{j.schedule}</code>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#18181b] text-zinc-400 uppercase">{j.last_status}</span>
                </div>
                <div className="text-zinc-400 truncate">{j.prompt}</div>
                {j.last_output && (
                  <div className="text-[11px] text-zinc-500 line-clamp-2 mt-1">Last output: {j.last_output}</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    await apiFetch(`/api/cron/${j.id}/run`, { method: "POST" });
                    await load();
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 flex items-center gap-1 cursor-pointer"
                >
                  <Play className="w-3 h-3" /> Run Now
                </button>
                <button
                  onClick={async () => {
                    await apiFetch(`/api/cron/${j.id}`, { method: "DELETE" });
                    await load();
                  }}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {jobs.length === 0 && <div className="text-xs text-zinc-500">No cron jobs configured yet.</div>}
        </div>
      </section>

      {/* MCP SERVERS & CHANNELS SHORTCUT */}
      <div className="space-y-4">
        {onOpenChannels && (
          <div className="rounded-xl bg-[#111113] border border-white/[0.08] px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-zinc-400 flex items-center gap-2">
              <Radio className="w-3.5 h-3.5 text-amber-400" />
              Messaging channels (Telegram, WhatsApp QR &amp; Cloud API, Discord, Slack, Webhooks) are managed in the dedicated <strong>Channels</strong> tab ({channels.length} configured).
            </span>
            <button
              type="button"
              onClick={onOpenChannels}
              className="h-7 px-3 rounded-md bg-zinc-100 hover:bg-white text-zinc-950 font-semibold text-[11px] cursor-pointer"
            >
              Open Channels
            </button>
          </div>
        )}

        {/* MCP Servers */}
        <section className="rounded-xl bg-[#111113] border border-white/[0.08] p-5 space-y-4">
          <h2 className="text-sm font-bold text-pink-300 flex items-center gap-2">
            <Plug className="w-4 h-4" /> MCP Server Registry
          </h2>
          <form onSubmit={addMcp} className="space-y-2.5 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <input
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                placeholder="MCP Server Name"
                className="bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
              />
              <select
                value={mcpTransport}
                onChange={(e) => setMcpTransport(e.target.value)}
                className="bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
              >
                <option value="http">HTTP / Streamable</option>
                <option value="sse">SSE Endpoint</option>
                <option value="stdio">Local STDIO Command</option>
              </select>
            </div>
            <input
              value={mcpUrl}
              onChange={(e) => setMcpUrl(e.target.value)}
              placeholder="https://mcp.example.com/sse or npx -y ..."
              className="w-full bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 font-mono text-white"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-pink-500 hover:bg-pink-400 text-zinc-950 font-semibold cursor-pointer"
            >
              Register MCP Server
            </button>
          </form>

          <div className="space-y-2">
            {mcps.map((m) => {
              const disc = mcpDiscovered[m.id];
              return (
                <div key={m.id} className="p-3 rounded-xl bg-[#0c0c0e] border border-white/[0.08] space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-white">
                        {m.name} <span className="text-[10px] text-pink-400 uppercase ml-1">({m.transport})</span>
                      </div>
                      <div className="text-[11px] font-mono text-zinc-500 truncate">{m.url_or_cmd}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={async () => {
                          setMcpDiscovered((p) => ({ ...p, [m.id]: { loading: true } }));
                          try {
                            const r = await apiFetch<{ ok: boolean; tools: DiscoveredToolItem[] }>(
                              `/api/connectors/${m.id}/discover`,
                              { method: "POST" }
                            );
                            setMcpDiscovered((p) => ({ ...p, [m.id]: { tools: r.tools } }));
                          } catch (err) {
                            setMcpDiscovered((p) => ({
                              ...p,
                              [m.id]: { error: err instanceof Error ? err.message : "Failed" },
                            }));
                          }
                        }}
                        className="px-2.5 py-1 rounded bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/35 text-pink-300 cursor-pointer"
                      >
                        {disc?.loading ? "Scanning..." : "Discover Tools"}
                      </button>
                      <button
                        onClick={async () => {
                          await apiFetch(`/api/connectors/${m.id}`, { method: "DELETE" });
                          await load();
                        }}
                        className="text-zinc-500 hover:text-rose-400 p-1 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {disc?.error && <div className="text-[11px] text-rose-400">{disc.error}</div>}
                  {disc?.tools && (
                    <div className="pt-1 border-t border-white/[0.07] space-y-1">
                      <div className="text-[10px] text-emerald-400 font-semibold">
                        Live Tools Ready for Agents ({disc.tools.length}):
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {disc.tools.map((t) => (
                          <span
                            key={t.qualifiedName}
                            title={t.description}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#18181b] text-cyan-300"
                          >
                            {t.rawName}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {mcps.length === 0 && (
              <div className="p-3.5 rounded-xl bg-[#0c0c0e] border border-white/[0.06] text-xs text-zinc-500 text-center">
                No MCP servers registered yet. Add any HTTP/SSE MCP endpoint above and click Discover Tools.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

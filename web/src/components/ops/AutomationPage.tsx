import React, { useCallback, useEffect, useState } from "react";
import { Clock, Play, Trash2, Radio, Plug, Plus, Send } from "lucide-react";
import { apiFetch } from "../../api/client";
import type { TeamItem } from "../../types";

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

export const AutomationPage: React.FC = () => {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [mcps, setMcps] = useState<McpItem[]>([]);
  const [teams, setTeams] = useState<TeamItem[]>([]);

  // Cron form
  const [cronName, setCronName] = useState("");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [cronPrompt, setCronPrompt] = useState("");

  // Channel form
  const [chName, setChName] = useState("");
  const [chType, setChType] = useState("webhook");
  const [chEndpoint, setChEndpoint] = useState("");
  const [chSecret, setChSecret] = useState("");
  const [chChatId, setChChatId] = useState("");

  // MCP form
  const [mcpName, setMcpName] = useState("");
  const [mcpTransport, setMcpTransport] = useState("http");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpDiscovered, setMcpDiscovered] = useState<
    Record<string, { loading?: boolean; tools?: DiscoveredToolItem[]; error?: string }>
  >({});

  const load = useCallback(async () => {
    const [jRes, cRes, mRes, tRes] = await Promise.all([
      apiFetch<{ jobs: CronJob[] }>("/api/cron"),
      apiFetch<{ channels: ChannelItem[] }>("/api/channels"),
      apiFetch<{ servers: McpItem[] }>("/api/mcp"),
      apiFetch<{ teams: TeamItem[] }>("/api/teams"),
    ]);
    setJobs(jRes.jobs);
    setChannels(cRes.channels);
    setMcps(mRes.servers);
    setTeams(tRes.teams);
  }, []);

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

  async function addChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!chName.trim()) return;
    const config: Record<string, string> = {};
    if (chType === "discord") config.webhookUrl = chEndpoint;
    else if (chType === "telegram") {
      config.botToken = chEndpoint;
      config.chatId = chChatId;
    } else {
      config.outboundUrl = chEndpoint;
      config.secret = chSecret;
    }
    await apiFetch("/api/channels", {
      method: "POST",
      body: JSON.stringify({
        name: chName.trim(),
        type: chType,
        config,
        targetType: "team",
        targetId: teams[0]?.id || "team_pandawa",
      }),
    });
    setChName("");
    setChEndpoint("");
    setChSecret("");
    setChChatId("");
    await load();
  }

  async function addMcp(e: React.FormEvent) {
    e.preventDefault();
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    await apiFetch("/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: mcpName.trim(), transport: mcpTransport, urlOrCmd: mcpUrl.trim() }),
    });
    setMcpName("");
    setMcpUrl("");
    await load();
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#080a0f] p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Clock className="w-5 h-5 text-cyan-400" /> Automation, Channels & MCP
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Schedule recurring Team Pandawa missions, bridge Telegram / Discord / Webhooks, and register external MCP servers.
        </p>
      </div>

      {/* CRON SCHEDULER */}
      <section className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 space-y-4">
        <h2 className="text-sm font-bold text-amber-300 flex items-center gap-2">
          <Clock className="w-4 h-4" /> Cron Scheduler
        </h2>
        <form onSubmit={addCron} className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 text-xs">
          <input
            value={cronName}
            onChange={(e) => setCronName(e.target.value)}
            placeholder="Job Name (e.g. Daily Briefing)"
            className="lg:col-span-3 bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
          />
          <input
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="0 9 * * *"
            className="lg:col-span-2 bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
          />
          <input
            value={cronPrompt}
            onChange={(e) => setCronPrompt(e.target.value)}
            placeholder="Mission prompt for Team Pandawa..."
            className="lg:col-span-5 bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
          />
          <button
            type="submit"
            disabled={!cronName.trim() || !cronPrompt.trim()}
            className="lg:col-span-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </form>

        <div className="space-y-2">
          {jobs.map((j) => (
            <div key={j.id} className="p-3.5 rounded-xl bg-[#090c14] border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="space-y-0.5 min-w-0">
                <div className="font-semibold text-white flex items-center gap-2">
                  {j.name}
                  <code className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300">{j.schedule}</code>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase">{j.last_status}</span>
                </div>
                <div className="text-slate-400 truncate">{j.prompt}</div>
                {j.last_output && (
                  <div className="text-[11px] text-slate-500 line-clamp-2 mt-1">Last output: {j.last_output}</div>
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
                  className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {jobs.length === 0 && <div className="text-xs text-slate-500">No cron jobs configured yet.</div>}
        </div>
      </section>

      {/* CHANNELS & MCP GRID */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Channels */}
        <section className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 space-y-4">
          <h2 className="text-sm font-bold text-sky-300 flex items-center gap-2">
            <Radio className="w-4 h-4" /> Channels & Webhooks
          </h2>
          <form onSubmit={addChannel} className="space-y-2.5 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <input
                value={chName}
                onChange={(e) => setChName(e.target.value)}
                placeholder="Channel Name"
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              />
              <select
                value={chType}
                onChange={(e) => setChType(e.target.value)}
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              >
                <option value="webhook">Webhook (Inbound / Outbound)</option>
                <option value="discord">Discord Webhook</option>
                <option value="telegram">Telegram Bot</option>
              </select>
            </div>
            <input
              value={chEndpoint}
              onChange={(e) => setChEndpoint(e.target.value)}
              placeholder={
                chType === "telegram"
                  ? "Telegram Bot Token"
                  : chType === "discord"
                  ? "Discord Webhook URL"
                  : "Outbound Callback URL (optional)"
              }
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
            />
            {chType === "telegram" ? (
              <input
                value={chChatId}
                onChange={(e) => setChChatId(e.target.value)}
                placeholder="Telegram Chat ID"
                className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            ) : chType === "webhook" ? (
              <input
                value={chSecret}
                onChange={(e) => setChSecret(e.target.value)}
                placeholder="Webhook Secret Header (X-Pandawa-Secret)"
                className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            ) : null}
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold cursor-pointer"
            >
              Add Channel
            </button>
          </form>

          <div className="space-y-2">
            {channels.map((c) => (
              <div key={c.id} className="p-3 rounded-xl bg-[#090c14] border border-slate-800 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    {c.name} <span className="text-[10px] uppercase text-sky-400">({c.type})</span>
                    {c.type === "telegram" && c.poller?.active && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        2-Way Bot Live
                      </span>
                    )}
                    {c.type === "telegram" && c.poller?.lastError && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300">
                        {c.poller.lastError}
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={async () => {
                        const r = await apiFetch<{ ok: boolean; detail: string }>(`/api/channels/${c.id}/test`, {
                          method: "POST",
                        });
                        window.alert(`${r.ok ? "OK" : "Failed"}: ${r.detail}`);
                      }}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 cursor-pointer"
                    >
                      <Send className="w-3 h-3" /> Test
                    </button>
                    <button
                      onClick={async () => {
                        await apiFetch(`/api/channels/${c.id}`, { method: "DELETE" });
                        await load();
                      }}
                      className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="text-[10px] font-mono text-slate-500 break-all">
                  Inbound POST: {window.location.origin}/api/webhooks/{c.id}
                </div>
              </div>
            ))}
            {channels.length === 0 && (
              <div className="p-3.5 rounded-xl bg-[#090c14] border border-slate-800/70 text-xs text-slate-500 text-center">
                No channels configured yet. Add a Telegram Bot, Discord Webhook, or HTTP Webhook above.
              </div>
            )}
          </div>
        </section>

        {/* MCP Servers */}
        <section className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 space-y-4">
          <h2 className="text-sm font-bold text-pink-300 flex items-center gap-2">
            <Plug className="w-4 h-4" /> MCP Server Registry
          </h2>
          <form onSubmit={addMcp} className="space-y-2.5 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <input
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                placeholder="MCP Server Name"
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              />
              <select
                value={mcpTransport}
                onChange={(e) => setMcpTransport(e.target.value)}
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
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
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-pink-500 hover:bg-pink-400 text-slate-950 font-semibold cursor-pointer"
            >
              Register MCP Server
            </button>
          </form>

          <div className="space-y-2">
            {mcps.map((m) => {
              const disc = mcpDiscovered[m.id];
              return (
                <div key={m.id} className="p-3 rounded-xl bg-[#090c14] border border-slate-800 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-white">
                        {m.name} <span className="text-[10px] text-pink-400 uppercase ml-1">({m.transport})</span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 truncate">{m.url_or_cmd}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={async () => {
                          setMcpDiscovered((p) => ({ ...p, [m.id]: { loading: true } }));
                          try {
                            const r = await apiFetch<{ ok: boolean; tools: DiscoveredToolItem[] }>(
                              `/api/mcp/${m.id}/discover`,
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
                          await apiFetch(`/api/mcp/${m.id}`, { method: "DELETE" });
                          await load();
                        }}
                        className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {disc?.error && <div className="text-[11px] text-rose-400">{disc.error}</div>}
                  {disc?.tools && (
                    <div className="pt-1 border-t border-slate-800/80 space-y-1">
                      <div className="text-[10px] text-emerald-400 font-semibold">
                        Live Tools Ready for Agents ({disc.tools.length}):
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {disc.tools.map((t) => (
                          <span
                            key={t.qualifiedName}
                            title={t.description}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300"
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
              <div className="p-3.5 rounded-xl bg-[#090c14] border border-slate-800/70 text-xs text-slate-500 text-center">
                No MCP servers registered yet. Add any HTTP/SSE MCP endpoint above and click Discover Tools.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

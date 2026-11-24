import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCheck,
  ClipboardList,
  Coins,
  Eye,
  FolderOpen,
  Layers,
  MessageSquare,
  Radio,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { apiFetch } from "../../api/client";
import type { BlackboardEntry, MessageItem, TeamItem } from "../../types";

interface MonitorFeedItem {
  id: string;
  title: string;
  target_type: string;
  target_id: string;
  targetName: string;
  status: string;
  created_at: string;
  updated_at: string;
  messageCount: number;
  teamMessageCount: number;
  blackboardCount: number;
  promptTokens: number;
  completionTokens: number;
  lastMessage?: string | null;
  lastRole?: string | null;
  lastAgentName?: string | null;
}

interface TeamMessageRow {
  id: string;
  team_id: string;
  session_id: string;
  from_agent: string;
  to_agent: string;
  kind?: string;
  content: string;
  readBy?: string[];
  created_at: string;
}

interface MonitorTaskRow {
  id: string;
  team_id: string;
  session_id: string;
  title: string;
  owner_agent: string;
  status: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

interface SessionDetailResponse {
  session: {
    id: string;
    title: string;
    target_type: string;
    target_id: string;
    status: string;
    created_at: string;
    updated_at: string;
  };
  team: {
    id: string;
    name: string;
    slug: string;
    collaboration_mode: string;
  } | null;
  messages: MessageItem[];
  teamMessages: TeamMessageRow[];
  blackboard: BlackboardEntry[];
  tasks: MonitorTaskRow[];
  usage: {
    calls?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  };
}

interface LiveEventEntry extends Record<string, unknown> {
  type?: string;
  _seq?: number;
}

interface Props {
  liveEvents: LiveEventEntry[];
  onOpenWorkspace: (teamId: string) => void;
}

type TimelineItem = {
  id: string;
  ts: number;
  tsIso: string;
  category: "user" | "agent" | "team_chat" | "tool" | "system";
  sender: string;
  recipient?: string | null;
  badge?: string;
  content: string;
  readBy?: string[];
};

function parseTsMs(raw?: string | null): number {
  if (!raw) return 0;
  const iso = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function formatTime(raw?: string | null): string {
  if (!raw) return "";
  const iso = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function kindBadgeStyle(kind?: string): string {
  switch (kind) {
    case "question":
      return "bg-sky-500/15 text-sky-300 border-sky-500/30";
    case "handoff":
      return "bg-violet-500/15 text-violet-300 border-violet-500/30";
    case "alert":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "review":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    default:
      return "bg-zinc-800 text-zinc-300 border-white/[0.08]";
  }
}

export function LiveMonitorPage({ liveEvents, onOpenWorkspace }: Props) {
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [feed, setFeed] = useState<MonitorFeedItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showExternalPrompts, setShowExternalPrompts] = useState(true);
  const [error, setError] = useState("");

  const loadFeed = useCallback(async (tid: string) => {
    setLoadingFeed(true);
    setError("");
    try {
      const qs = tid !== "all" ? `?teamId=${encodeURIComponent(tid)}` : "";
      const [feedRes, teamsRes] = await Promise.all([
        apiFetch<{ feed: MonitorFeedItem[] }>(`/api/monitor/feed${qs}`),
        apiFetch<{ teams: TeamItem[] }>("/api/teams"),
      ]);
      const items = feedRes.feed || [];
      setFeed(items);
      setTeams(teamsRes.teams || []);
      setSelectedSessionId((cur) => {
        if (cur && items.some((f) => f.id === cur)) return cur;
        return items[0]?.id || "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFeed(false);
    }
  }, []);

  const loadSessionDetail = useCallback(async (sid: string, quiet = false) => {
    if (!sid) {
      setDetail(null);
      return;
    }
    if (!quiet) setLoadingDetail(true);
    try {
      const res = await apiFetch<SessionDetailResponse>(`/api/monitor/session/${encodeURIComponent(sid)}`);
      setDetail(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!quiet) setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadFeed(teamFilter);
  }, [teamFilter, loadFeed]);

  useEffect(() => {
    if (selectedSessionId) {
      void loadSessionDetail(selectedSessionId);
    } else {
      setDetail(null);
    }
  }, [selectedSessionId, loadSessionDetail]);

  const liveActivity = useMemo(() => {
    const activeAgents = new Map<string, string>();
    let latestPhase = "";
    for (const ev of liveEvents.slice(-40)) {
      const t = String(ev.type || "");
      const aid = String(ev.agentId || "");
      const aname = String(ev.agentName || aid || "");
      if (t === "agent_start" && aname) {
        activeAgents.set(aid || aname, aname);
      } else if (t === "agent_done" && (aid || aname)) {
        activeAgents.delete(aid || aname);
      } else if (t === "team_phase") {
        latestPhase = String(ev.phase || ev.summary || "");
      } else if (t === "team_done") {
        activeAgents.clear();
        latestPhase = "";
      }
    }
    return { activeNames: Array.from(activeAgents.values()), latestPhase };
  }, [liveEvents]);

  useEffect(() => {
    const last = liveEvents[liveEvents.length - 1];
    if (!last) return;
    const t = String(last.type || "");
    if (
      t === "team_message" ||
      t === "peer_consult" ||
      t === "blackboard_post" ||
      t === "team_task_updated" ||
      t === "agent_done" ||
      t === "team_done" ||
      t === "team_phase"
    ) {
      const qs = teamFilter !== "all" ? `?teamId=${encodeURIComponent(teamFilter)}` : "";
      apiFetch<{ feed: MonitorFeedItem[] }>(`/api/monitor/feed${qs}`)
        .then((res) => setFeed(res.feed || []))
        .catch(() => {});
      if (selectedSessionId) {
        void loadSessionDetail(selectedSessionId, true);
      }
    }
  }, [liveEvents, selectedSessionId, teamFilter, loadSessionDetail]);

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!detail) return [];
    const items: TimelineItem[] = [];

    for (const m of detail.messages || []) {
      const ts = parseTsMs(m.created_at);
      if (m.role === "user") {
        if (!showExternalPrompts) continue;
        const ch = typeof m.meta?.channel === "string" && m.meta.channel ? `${m.meta.channel.toUpperCase()} Request` : "Mission Input";
        items.push({
          id: `msg-${m.id}`,
          ts,
          tsIso: m.created_at,
          category: "user",
          sender: ch,
          content: m.content,
        });
      } else if (m.role === "tool") {
        if (!showTools) continue;
        items.push({
          id: `msg-${m.id}`,
          ts,
          tsIso: m.created_at,
          category: "tool",
          sender: m.agent_name || "Tool Runtime",
          badge: typeof m.meta?.tool === "string" ? m.meta.tool : "tool",
          content: m.content,
        });
      } else {
        items.push({
          id: `msg-${m.id}`,
          ts,
          tsIso: m.created_at,
          category: m.role === "system" ? "system" : "agent",
          sender: m.agent_name || (m.role === "system" ? "System" : "Team Lead"),
          content: m.content,
        });

        if (showTools && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
          m.toolCalls.forEach((tc, idx) => {
            items.push({
              id: `tc-${m.id}-${idx}`,
              ts: ts + 1 + idx,
              tsIso: m.created_at,
              category: "tool",
              sender: m.agent_name || "Agent",
              badge: tc.name || "tool",
              content: typeof tc.result === "string" ? tc.result : JSON.stringify(tc.args || {}),
            });
          });
        }
      }
    }

    for (const tm of detail.teamMessages || []) {
      const ts = parseTsMs(tm.created_at);
      items.push({
        id: `tmsg-${tm.id}`,
        ts,
        tsIso: tm.created_at,
        category: "team_chat",
        sender: tm.from_agent || "Agent",
        recipient: tm.to_agent || "All Teammates",
        badge: tm.kind || "update",
        content: tm.content,
        readBy: tm.readBy || [],
      });
    }

    items.sort((a, b) => a.ts - b.ts);
    return items;
  }, [detail, showTools, showExternalPrompts]);

  const activeFeedItem = feed.find((f) => f.id === selectedSessionId) || null;
  const activeTeamId =
    detail?.team?.id || (activeFeedItem?.target_type === "team" ? activeFeedItem.target_id : null);
  const totalTokens =
    detail?.usage.totalTokens ?? ((detail?.usage.promptTokens || 0) + (detail?.usage.completionTokens || 0));

  return (
    <div className="h-full flex flex-col bg-[#09090b] text-zinc-100 overflow-hidden">
      {/* Header */}
      <header className="px-6 py-4 border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-zinc-100">
              Live Mission Monitor
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
              <Eye className="w-3 h-3" /> Read-Only Spectator
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            Pantauan grup chat real-time antar agent, handoff, shared tasks, dan blackboard tanpa campur tangan prompt.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="h-8 px-2.5 rounded-md bg-[#111113] border border-white/[0.08] text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
          >
            <option value="all">All Teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          {activeTeamId && (
            <button
              type="button"
              onClick={() => onOpenWorkspace(activeTeamId)}
              className="h-8 px-3 rounded-md bg-[#111113] hover:bg-[#18181b] border border-white/[0.08] text-xs text-zinc-200 inline-flex items-center gap-1.5 transition cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5 text-zinc-400" /> Open Workspace
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              void loadFeed(teamFilter);
              if (selectedSessionId) void loadSessionDetail(selectedSessionId);
            }}
            className="h-8 px-2.5 rounded-md bg-[#111113] hover:bg-[#18181b] border border-white/[0.08] text-xs text-zinc-300 inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingFeed ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300 shrink-0">
          {error}
        </div>
      )}

      {/* Main 3-Column Spectator Layout */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-white/[0.07]">
        {/* Left: Mission Sessions Feed */}
        <aside className="lg:col-span-3 flex flex-col min-h-0 bg-[#0b0b0e]">
          <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
              Mission Threads ({feed.length})
            </span>
            {liveActivity.activeNames.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> live
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.05]">
            {feed.length === 0 && !loadingFeed ? (
              <div className="p-6 text-center text-xs text-zinc-500">
                Belum ada sesi misi yang berjalan. Kirim misi dari Telegram/WhatsApp untuk memantau team di sini.
              </div>
            ) : (
              feed.map((item) => {
                const selected = item.id === selectedSessionId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedSessionId(item.id)}
                    className={`w-full text-left px-4 py-3 transition cursor-pointer ${
                      selected ? "bg-[#15151a] border-l-2 border-emerald-400" : "hover:bg-white/[0.02]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-zinc-100 truncate">
                        {item.targetName || "Default Team"}
                      </span>
                      <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                        {formatTime(item.updated_at)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[10px] font-mono text-zinc-400">
                      <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-white/[0.06] uppercase">
                        {item.target_type || "team"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare className="w-2.5 h-2.5" /> {item.teamMessageCount} peer
                      </span>
                      {item.blackboardCount > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Layers className="w-2.5 h-2.5" /> {item.blackboardCount}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[11px] text-zinc-400 line-clamp-2">{item.lastMessage || item.title}</p>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Center: Group Chat Spectator Stream */}
        <section className="lg:col-span-6 flex flex-col min-h-0">
          {/* Stream Filter & Typing Banner */}
          <div className="px-4 py-2.5 border-b border-white/[0.06] bg-[#0e0e11] flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 text-xs">
              <Radio className="w-3.5 h-3.5 text-emerald-400" />
              <span className="font-medium text-zinc-200">
                {detail?.team?.name || activeFeedItem?.targetName || "Team Group Stream"}
              </span>
              {liveActivity.latestPhase && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                  {liveActivity.latestPhase}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 text-[11px]">
              <label className="inline-flex items-center gap-1.5 text-zinc-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showExternalPrompts}
                  onChange={(e) => setShowExternalPrompts(e.target.checked)}
                  className="accent-emerald-400"
                />
                User Trigger
              </label>
              <label className="inline-flex items-center gap-1.5 text-zinc-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showTools}
                  onChange={(e) => setShowTools(e.target.checked)}
                  className="accent-emerald-400"
                />
                Tools
              </label>
            </div>
          </div>

          {/* Live Typing Indicator Bar */}
          {liveActivity.activeNames.length > 0 && (
            <div className="px-4 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-[11px] font-mono text-emerald-300 flex items-center gap-2 shrink-0">
              <Activity className="w-3.5 h-3.5 animate-pulse" />
              <span>Sedang bekerja: {liveActivity.activeNames.join(", ")}...</span>
            </div>
          )}

          {/* Read-only Chat Feed */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {loadingDetail && !detail ? (
              <div className="text-xs text-zinc-500 py-8 text-center">Loading mission transcript...</div>
            ) : timeline.length === 0 ? (
              <div className="text-xs text-zinc-500 py-8 text-center">
                Pilih thread misi di kiri untuk memantau percakapan antar agent secara real-time.
              </div>
            ) : (
              timeline.map((item) => {
                if (item.category === "team_chat") {
                  return (
                    <div
                      key={item.id}
                      className="rounded-xl bg-[#121218] border border-indigo-500/20 px-4 py-3 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Bot className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                          <span className="text-xs font-semibold text-zinc-100 truncate">{item.sender}</span>
                          <span className="text-[11px] text-zinc-500">→</span>
                          <span className="text-xs text-indigo-300 truncate">{item.recipient}</span>
                          {item.badge && (
                            <span
                              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${kindBadgeStyle(item.badge)}`}
                            >
                              {item.badge}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                          {formatTime(item.tsIso)}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">{item.content}</p>
                      {item.readBy && item.readBy.length > 0 && (
                        <div className="flex items-center gap-1 text-[10px] font-mono text-emerald-400/90 pt-0.5">
                          <CheckCheck className="w-3 h-3" /> Read by {item.readBy.join(", ")}
                        </div>
                      )}
                    </div>
                  );
                }

                if (item.category === "tool") {
                  return (
                    <div
                      key={item.id}
                      className="rounded-lg bg-[#0d0d10] border border-white/[0.06] px-3 py-2 text-[11px] font-mono"
                    >
                      <div className="flex items-center justify-between gap-2 text-zinc-400">
                        <span className="inline-flex items-center gap-1.5">
                          <Wrench className="w-3 h-3 text-amber-400" />
                          <strong className="text-zinc-200">{item.sender}</strong> ran{" "}
                          <span className="text-amber-300">{item.badge}</span>
                        </span>
                        <span className="text-zinc-600">{formatTime(item.tsIso)}</span>
                      </div>
                      <pre className="mt-1 text-[11px] text-zinc-400 whitespace-pre-wrap break-all max-h-36 overflow-y-auto">
                        {item.content.slice(0, 1200)}
                      </pre>
                    </div>
                  );
                }

                if (item.category === "user") {
                  return (
                    <div
                      key={item.id}
                      className="rounded-xl bg-zinc-900/80 border border-white/[0.09] px-4 py-2.5"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-cyan-300">
                          {item.sender}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-500">{formatTime(item.tsIso)}</span>
                      </div>
                      <p className="text-xs text-zinc-200 whitespace-pre-wrap">{item.content}</p>
                    </div>
                  );
                }

                return (
                  <div
                    key={item.id}
                    className="rounded-xl bg-[#111114] border border-white/[0.08] px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-semibold text-emerald-300">{item.sender}</span>
                      <span className="text-[10px] font-mono text-zinc-500">{formatTime(item.tsIso)}</span>
                    </div>
                    <p className="text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">{item.content}</p>
                  </div>
                );
              })
            )}
          </div>

          {/* Read-only Footer Notice (NO Input Box by Design) */}
          <div className="px-4 py-2 border-t border-white/[0.07] bg-[#0c0c0f] text-[11px] text-zinc-500 flex items-center justify-between shrink-0">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              Mode Pantau (Read-Only): Misi tetap masuk lewat Telegram, WhatsApp QR/Cloud, atau Discord.
            </span>
            <span className="font-mono text-[10px] text-zinc-600">{timeline.length} events</span>
          </div>
        </section>

        {/* Right: Tasks, Blackboard & Cost Telemetry */}
        <aside className="lg:col-span-3 flex flex-col min-h-0 bg-[#0b0b0e] overflow-y-auto divide-y divide-white/[0.06]">
          {/* Token & Cost Card */}
          <div className="p-4 space-y-2">
            <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
              <Coins className="w-3.5 h-3.5 text-amber-400" /> Session Telemetry
            </div>
            {detail ? (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-[#111113] border border-white/[0.07] p-2.5">
                  <div className="text-[10px] text-zinc-500">Total Tokens</div>
                  <div className="mt-0.5 font-mono font-semibold text-zinc-100 tabular-nums">
                    {totalTokens.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-lg bg-[#111113] border border-white/[0.07] p-2.5">
                  <div className="text-[10px] text-zinc-500">Est. Cost</div>
                  <div className="mt-0.5 font-mono font-semibold text-emerald-300 tabular-nums">
                    ${Number(detail.usage.estimatedCostUsd || 0).toFixed(4)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-zinc-600">No session selected</div>
            )}
          </div>

          {/* Shared Tasks */}
          <div className="p-4 space-y-2.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
              <ClipboardList className="w-3.5 h-3.5 text-zinc-400" /> Shared Tasks ({detail?.tasks?.length || 0})
            </div>
            {(detail?.tasks || []).length === 0 ? (
              <div className="text-xs text-zinc-600">Tidak ada task board tercatat di sesi ini.</div>
            ) : (
              <div className="space-y-2">
                {(detail?.tasks || []).map((t) => (
                  <div
                    key={t.id}
                    className="rounded-lg bg-[#111113] border border-white/[0.07] p-2.5 space-y-1 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-zinc-200 truncate">{t.title}</span>
                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400">
                        {t.status}
                      </span>
                    </div>
                    {t.owner_agent && <div className="text-[11px] text-zinc-500">Owner: {t.owner_agent}</div>}
                    {t.notes && (
                      <div className="text-[10px] font-mono text-zinc-400 whitespace-pre-wrap break-words max-h-20 overflow-y-auto">
                        {t.notes}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Blackboard */}
          <div className="p-4 space-y-2.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-zinc-400" /> Blackboard ({detail?.blackboard?.length || 0})
            </div>
            {(detail?.blackboard || []).length === 0 ? (
              <div className="text-xs text-zinc-600">Blackboard sesi kosong.</div>
            ) : (
              <div className="space-y-2">
                {(detail?.blackboard || []).map((b) => (
                  <div
                    key={b.id}
                    className="rounded-lg bg-[#111113] border border-white/[0.07] p-2.5 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                      <span className="text-amber-300 truncate">{b.title || b.entry_type}</span>
                      <span className="text-zinc-500 truncate">{b.author_name}</span>
                    </div>
                    <p className="text-[11px] text-zinc-300 whitespace-pre-wrap break-words max-h-28 overflow-y-auto">
                      {b.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

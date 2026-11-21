import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Send,
  Plus,
  Users,
  User,
  Sparkles,
  Trash2,
  ClipboardList,
  Wrench,
  ChevronDown,
  ChevronRight,
  Loader2,
  History,
  Square,
} from "lucide-react";
import { apiFetch } from "../../api/client";
import type { AgentItem, BlackboardEntry, MessageItem, SessionItem, TeamItem } from "../../types";
import { MarkdownView } from "../MarkdownView";

export interface LiveStreamBuffer {
  agentId: string;
  agentName: string;
  avatar: string;
  model: string;
  text: string;
}

interface MissionRoomProps {
  liveEvents: Array<Record<string, unknown>>;
  streamingBuffers: Record<string, LiveStreamBuffer>;
  onClearStreams: () => void;
}

export const MissionRoom: React.FC<MissionRoomProps> = ({ liveEvents, streamingBuffers, onClearStreams }) => {
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [blackboard, setBlackboard] = useState<BlackboardEntry[]>([]);

  const [targetType, setTargetType] = useState<"team" | "agent">("team");
  const [targetId, setTargetId] = useState<string>("team_pandawa");
  const [selectedPeers, setSelectedPeers] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(() => window.innerWidth >= 1280);
  const [showBlackboard, setShowBlackboard] = useState(() => window.innerWidth >= 1360);
  const [expandedPeers, setExpandedPeers] = useState<Set<string>>(new Set());

  // Add blackboard directive form
  const [bbTitle, setBbTitle] = useState("");
  const [bbContent, setBbContent] = useState("");

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadMeta = useCallback(async () => {
    const [tRes, aRes, sRes] = await Promise.all([
      apiFetch<{ teams: TeamItem[] }>("/api/teams"),
      apiFetch<{ agents: AgentItem[] }>("/api/agents"),
      apiFetch<{ sessions: SessionItem[] }>("/api/sessions"),
    ]);
    setTeams(tRes.teams);
    setAgents(aRes.agents);
    setSessions(sRes.sessions);

    if (tRes.teams.length > 0 && selectedPeers.size === 0) {
      setSelectedPeers(new Set(tRes.teams[0].members.map((m) => m.id)));
    }
  }, [selectedPeers.size]);

  const loadMessages = useCallback(async (sid: string) => {
    if (!sid) {
      setMessages([]);
      return;
    }
    const res = await apiFetch<{ messages: MessageItem[] }>(`/api/sessions/${sid}/messages`);
    setMessages(res.messages);
  }, []);

  const loadBlackboard = useCallback(async (tid: string) => {
    if (!tid) return;
    const res = await apiFetch<{ entries: BlackboardEntry[] }>(`/api/teams/${tid}/blackboard`);
    setBlackboard(res.entries);
  }, []);

  useEffect(() => {
    loadMeta().catch(() => {});
  }, [loadMeta]);

  useEffect(() => {
    loadMessages(activeSessionId).catch(() => {});
  }, [activeSessionId, loadMessages]);

  useEffect(() => {
    if (targetType === "team" && targetId) {
      loadBlackboard(targetId).catch(() => {});
    }
  }, [targetType, targetId, loadBlackboard]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const activeTeam = teams.find((t) => t.id === targetId) || teams[0];

  async function updateTeamMode(mode: TeamItem["collaboration_mode"]) {
    if (!activeTeam) return;
    await apiFetch(`/api/teams/${activeTeam.id}`, {
      method: "PATCH",
      body: JSON.stringify({ collaboration_mode: mode }),
    });
    await loadMeta();
  }

  async function sendMission(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || sending) return;
    const text = prompt.trim();
    setPrompt("");
    setSending(true);
    onClearStreams();

    // Optimistic user bubble
    setMessages((prev) => [
      ...prev,
      {
        id: `tmp_${Date.now()}`,
        session_id: activeSessionId,
        role: "user",
        agent_id: "",
        agent_name: "You",
        model_used: "",
        content: text,
        reasoning: "",
        toolCalls: [],
        meta: {},
        created_at: new Date().toISOString(),
      },
    ]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await apiFetch<{ sessionId: string }>("/api/chat/send", {
        method: "POST",
        signal: ac.signal,
        body: JSON.stringify({
          sessionId: activeSessionId || undefined,
          targetType,
          targetId,
          prompt: text,
          activeAgentIds: targetType === "team" ? Array.from(selectedPeers) : undefined,
        }),
      });
      setActiveSessionId(res.sessionId);
      await Promise.all([
        loadMessages(res.sessionId),
        loadMeta(),
        targetType === "team" ? loadBlackboard(targetId) : Promise.resolve(),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stopped = ac.signal.aborted || /abort|stopped/i.test(msg);
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          session_id: activeSessionId,
          role: "system",
          agent_id: "",
          agent_name: stopped ? "Stopped" : "System",
          model_used: "",
          content: stopped ? "⏹ Mission stopped by user." : `Error: ${msg}`,
          reasoning: "",
          toolCalls: [],
          meta: {},
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      abortRef.current = null;
      setSending(false);
      onClearStreams();
    }
  }

  async function stopMission() {
    abortRef.current?.abort();
    try {
      await apiFetch("/api/chat/abort", {
        method: "POST",
        body: JSON.stringify({ sessionId: activeSessionId || "*" }),
      });
    } catch {
      // ignore
    }
  }

  async function addBlackboardEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!bbTitle.trim() || !bbContent.trim() || !activeTeam) return;
    await apiFetch(`/api/teams/${activeTeam.id}/blackboard`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: activeSessionId,
        entryType: "decision",
        title: bbTitle.trim(),
        content: bbContent.trim(),
      }),
    });
    setBbTitle("");
    setBbContent("");
    await loadBlackboard(activeTeam.id);
  }

  async function deleteBlackboardEntry(entryId: string) {
    if (!activeTeam) return;
    await apiFetch(`/api/teams/${activeTeam.id}/blackboard/${entryId}`, { method: "DELETE" });
    await loadBlackboard(activeTeam.id);
  }

  const recentLiveStatus = liveEvents.slice(-4);

  return (
    <div className="flex h-screen bg-[#080a0f]">
      {/* Left Sessions List (Collapsible for clean narrow-screen UX) */}
      {showHistory && (
      <div className="w-60 shrink-0 bg-[#0d111b] border-r border-slate-800/80 flex flex-col">
        <div className="p-3 border-b border-slate-800/80">
          <button
            onClick={() => {
              setActiveSessionId("");
              setMessages([]);
            }}
            className="w-full py-2 px-3 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> New Team Mission
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 px-2 py-1">
            Mission History ({sessions.length})
          </div>
          {sessions.length === 0 && (
            <div className="p-3 rounded-xl bg-[#090c14] border border-slate-800/70 text-[11px] text-slate-500 text-center">
              No missions yet. Send a mission to start your first team session.
            </div>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => {
                setActiveSessionId(s.id);
                setTargetType(s.target_type);
                setTargetId(s.target_id);
              }}
              className={`group flex items-center justify-between px-2.5 py-2 rounded-lg text-xs cursor-pointer transition ${
                activeSessionId === s.id
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
              }`}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{s.title}</div>
                <div className="text-[10px] text-slate-500 uppercase">{s.target_type}</div>
              </div>
              <button
                aria-label="Delete session"
                onClick={async (e) => {
                  e.stopPropagation();
                  await apiFetch(`/api/sessions/${s.id}`, { method: "DELETE" });
                  if (activeSessionId === s.id) {
                    setActiveSessionId("");
                    setMessages([]);
                  }
                  loadMeta();
                }}
                className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-rose-400"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
      )}

      {/* Center Mission Chat */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mission Target Bar */}
        <header className="px-4 py-3 bg-[#0d111b] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowHistory((s) => !s)}
              title="Toggle Mission History"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 border cursor-pointer ${
                showHistory
                  ? "bg-slate-800 border-slate-700 text-white"
                  : "bg-[#080a0f] border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
            >
              <History className="w-3.5 h-3.5" /> History
            </button>
            <div className="flex rounded-lg bg-[#080a0f] border border-slate-800 p-0.5 text-xs">
              <button
                onClick={() => {
                  setTargetType("team");
                  setTargetId(teams[0]?.id || "team_pandawa");
                }}
                className={`px-2.5 py-1 rounded-md flex items-center gap-1 cursor-pointer ${
                  targetType === "team" ? "bg-violet-500/25 text-violet-200 font-semibold" : "text-slate-400"
                }`}
              >
                <Users className="w-3.5 h-3.5" /> Agentic Team
              </button>
              <button
                onClick={() => {
                  setTargetType("agent");
                  setTargetId(agents[0]?.id || "agent_yudhistira");
                }}
                className={`px-2.5 py-1 rounded-md flex items-center gap-1 cursor-pointer ${
                  targetType === "agent" ? "bg-cyan-500/25 text-cyan-200 font-semibold" : "text-slate-400"
                }`}
              >
                <User className="w-3.5 h-3.5" /> Single Agent
              </button>
            </div>

            {targetType === "team" ? (
              <>
                <select
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className="bg-[#080a0f] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
                >
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {activeTeam && (
                  <select
                    value={activeTeam.collaboration_mode}
                    onChange={(e) => updateTeamMode(e.target.value as TeamItem["collaboration_mode"])}
                    className="bg-[#080a0f] border border-violet-500/40 rounded-lg px-2.5 py-1.5 text-xs text-violet-200"
                  >
                    <option value="deliberate">Mode: Musyawarah (Peer Deliberation + Review)</option>
                    <option value="parallel">Mode: Parallel Co-Execution</option>
                    <option value="sequential">Mode: Sequential Relay Chain</option>
                    <option value="consensus">Mode: Rapid Council</option>
                  </select>
                )}
              </>
            ) : (
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.avatar} {a.name} — {a.model || a.purpose}
                  </option>
                ))}
              </select>
            )}
          </div>

          {targetType === "team" && (
            <button
              onClick={() => setShowBlackboard((s) => !s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border cursor-pointer ${
                showBlackboard
                  ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                  : "bg-slate-800 border-slate-700 text-slate-300"
              }`}
            >
              <ClipboardList className="w-3.5 h-3.5" />
              Blackboard ({blackboard.length})
            </button>
          )}
        </header>

        {/* Active Peer Roster Pills (clean wrap, no horizontal cutoffs) */}
        {targetType === "team" && activeTeam && (
          <div className="px-4 py-2 bg-[#0a0d15] border-b border-slate-800/60 flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className="text-slate-500 shrink-0 font-medium">Active Peers:</span>
            {activeTeam.members.map((m) => {
              const on = selectedPeers.has(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => {
                    setSelectedPeers((prev) => {
                      const next = new Set(prev);
                      if (next.has(m.id) && next.size > 1) next.delete(m.id);
                      else next.add(m.id);
                      return next;
                    });
                  }}
                  className={`px-2.5 py-1 rounded-full border flex items-center gap-1.5 shrink-0 transition cursor-pointer ${
                    on
                      ? "bg-slate-800/90 border-cyan-500/45 text-slate-100"
                      : "bg-transparent border-slate-800 text-slate-500 opacity-60"
                  }`}
                >
                  <span>{m.avatar}</span>
                  <span className="font-medium">{m.name}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{m.model || m.purpose}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Messages Stream */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.length === 0 && (
            <div className="max-w-xl mx-auto mt-12 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mx-auto">
                <Sparkles className="w-6 h-6 text-amber-400" />
              </div>
              <h3 className="text-base font-bold text-white">Pandawa Mission Room</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Every teammate reads the wired <strong>Main Brain</strong>, <strong>Team Brain</strong>, and their own{" "}
                <code className="text-amber-300">soul.md</code> folder, using their assigned AI provider & model,
                deliberating transparently on the shared Team Blackboard before delivering unified consensus.
              </p>
            </div>
          )}

          {messages.map((m) => {
            if (m.role === "user") {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-2xl bg-amber-500/15 border border-amber-500/35 text-slate-100 rounded-2xl rounded-tr-sm px-4 py-3 text-sm whitespace-pre-wrap">
                    {m.content}
                  </div>
                </div>
              );
            }

            const isPeerNote = m.role === "agent";
            const isExpanded = !isPeerNote || expandedPeers.has(m.id);
            const avatar = String(m.meta?.avatar || (isPeerNote ? "⚡" : "👑"));

            return (
              <div
                key={m.id}
                className={`max-w-3xl rounded-2xl border ${
                  isPeerNote
                    ? "bg-[#0e1320]/90 border-slate-800/90"
                    : "bg-gradient-to-br from-[#121829] to-[#0f1422] border-violet-500/40 shadow-lg"
                }`}
              >
                <div
                  onClick={() => {
                    if (!isPeerNote) return;
                    setExpandedPeers((prev) => {
                      const next = new Set(prev);
                      if (next.has(m.id)) next.delete(m.id);
                      else next.add(m.id);
                      return next;
                    });
                  }}
                  className={`px-4 py-2.5 flex items-center justify-between gap-2 border-b border-slate-800/70 ${
                    isPeerNote ? "cursor-pointer hover:bg-slate-800/30" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isPeerNote &&
                      (isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                      ))}
                    <span>{avatar}</span>
                    <span className="text-xs font-bold text-white truncate">{m.agent_name}</span>
                    {m.model_used && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-emerald-300">
                        {m.model_used}
                      </span>
                    )}
                    {isPeerNote && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 uppercase">
                        Peer Deliberation
                      </span>
                    )}
                  </div>
                  {typeof m.meta?.durationMs === "number" && (m.meta.durationMs as number) > 0 && (
                    <span className="text-[10px] text-slate-500 font-mono">
                      {((m.meta.durationMs as number) / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>

                {isExpanded && (
                  <div className="p-4 space-y-3">
                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <div className="space-y-1">
                        {m.toolCalls.map((tc, idx) => (
                          <div
                            key={idx}
                            className="text-[11px] bg-[#080a0f] border border-slate-800 rounded-lg px-2.5 py-1.5 font-mono text-slate-400"
                          >
                            <span className="text-pink-400 inline-flex items-center gap-1">
                              <Wrench className="w-3 h-3" /> {tc.name}
                            </span>
                            <span className="text-slate-500 ml-2">{JSON.stringify(tc.args).slice(0, 120)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <MarkdownView content={m.content} />
                  </div>
                )}
              </div>
            );
          })}

          {sending && (
            <div className="space-y-3 max-w-3xl">
              <div className="rounded-2xl bg-[#101625] border border-amber-500/35 p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Pandawa Team is streaming & collaborating live...
                </div>
                {recentLiveStatus.map((ev, i) => (
                  <div key={i} className="text-[11px] font-mono text-slate-400 truncate">
                    › {String(ev.type)}: {String(ev.detail || ev.agentName || ev.toolName || ev.phase || "")}
                  </div>
                ))}
              </div>

              {Object.values(streamingBuffers).map((buf) => (
                <div
                  key={buf.agentId}
                  className="rounded-2xl bg-[#0e1422] border border-emerald-500/40 p-4 space-y-2 shadow-lg"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span>{buf.avatar || "⚡"}</span>
                    <span className="font-bold text-white">{buf.agentName}</span>
                    {buf.model && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-emerald-300">
                        {buf.model}
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 animate-pulse">
                      STREAMING
                    </span>
                  </div>
                  <MarkdownView content={buf.text} />
                </div>
              ))}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input Composer */}
        <form onSubmit={sendMission} className="p-4 bg-[#0d111b] border-t border-slate-800/80">
          <div className="flex gap-2">
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMission(e);
                }
              }}
              placeholder={
                targetType === "team"
                  ? "Give Team Pandawa a mission... (Enter to send, Shift+Enter for newline)"
                  : "Message this agent directly..."
              }
              className="flex-1 bg-[#080a0f] border border-slate-700 focus:border-amber-500 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none resize-none"
            />
            {sending ? (
              <button
                type="button"
                onClick={stopMission}
                className="px-5 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-semibold text-sm flex items-center gap-1.5 cursor-pointer shrink-0 shadow-lg shadow-rose-500/20"
              >
                <Square className="w-3.5 h-3.5 fill-current" /> Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!prompt.trim()}
                className="px-5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-400 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm flex items-center gap-1.5 cursor-pointer shrink-0"
              >
                <Send className="w-4 h-4" /> Send
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Right Team Blackboard Panel */}
      {targetType === "team" && showBlackboard && (
        <aside className="w-80 shrink-0 bg-[#0d111b] border-l border-slate-800/80 flex flex-col">
          <div className="px-4 py-3.5 border-b border-slate-800/80">
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
              <ClipboardList className="w-4 h-4" /> Team Blackboard
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Shared peer proposals, critiques & team decisions
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {blackboard.map((b) => (
              <div key={b.id} className="p-3 rounded-xl bg-[#090c14] border border-slate-800 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-bold uppercase">
                    {b.entry_type}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-500">{b.author_name}</span>
                    <button
                      onClick={() => deleteBlackboardEntry(b.id)}
                      className="text-slate-600 hover:text-rose-400 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="text-xs font-semibold text-slate-200">{b.title}</div>
                <div className="text-[11px] text-slate-400 whitespace-pre-wrap line-clamp-5">{b.content}</div>
              </div>
            ))}
            {blackboard.length === 0 && (
              <div className="text-xs text-slate-500 p-2">
                No entries yet. Start a mission or pin a team directive below.
              </div>
            )}
          </div>

          <form onSubmit={addBlackboardEntry} className="p-3 border-t border-slate-800/80 space-y-2">
            <input
              value={bbTitle}
              onChange={(e) => setBbTitle(e.target.value)}
              placeholder="Pin team directive / note title..."
              className="w-full bg-[#080a0f] border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-amber-500"
            />
            <textarea
              rows={2}
              value={bbContent}
              onChange={(e) => setBbContent(e.target.value)}
              placeholder="Shared note visible to all peers..."
              className="w-full bg-[#080a0f] border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none resize-none"
            />
            <button
              type="submit"
              className="w-full py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium cursor-pointer"
            >
              Post to Blackboard
            </button>
          </form>
        </aside>
      )}
    </div>
  );
};

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
  CheckSquare,
  Terminal,
  RefreshCw,
  Shield,
  Zap,
  ImagePlus,
  X,
  MessageCircle,
  Clock,
} from "lucide-react";
import { apiFetch } from "../../api/client";
import type { AgentItem, BlackboardEntry, BrainTreeNode, MessageItem, SessionItem, TeamItem } from "../../types";
import { MarkdownView } from "../MarkdownView";

const SLASH_SUGGESTIONS = [
  { cmd: "/mode execute", desc: "Execute & Verify (Plan -> Build in PTY -> Test -> Fix Loop)" },
  { cmd: "/mode deliberate", desc: "Musyawarah peer deliberation + cross-review" },
  { cmd: "/mode parallel", desc: "Parallel co-execution across all active peers" },
  { cmd: "/mode sequential", desc: "Sequential relay chain between peers" },
  { cmd: "/mode consensus", desc: "Rapid council synthesis" },
  { cmd: "/new", desc: "Start a fresh mission session" },
  { cmd: "/auto", desc: "Switch Approval Gate -> Auto (Full Freedom)" },
  { cmd: "/approve", desc: "Switch Approval Gate -> Approve Shell Only" },
  { cmd: "/tasks", desc: "Open Shared Team Task Board" },
  { cmd: "/processes", desc: "Open Managed Background Processes" },
];

const QUICK_STARTERS = [
  "Design a clean REST API + security checklist for our next SaaS product.",
  "Use web_search to compare top AI agent runtimes in 2026 and write a sharp memo.",
  "Review @main-brain/soul.md and propose 3 upgrades to our team charter.",
];

function collectFilePaths(nodes: BrainTreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    if (n.children) out.push(...collectFilePaths(n.children));
  }
  return out;
}

interface TeamTaskItem {
  id: string;
  title: string;
  owner_agent: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  notes: string;
}

interface ManagedProcItem {
  id: string;
  name: string;
  command: string;
  pid?: number;
  status: "running" | "exited";
  exitCode: number | null;
  logLines: number;
}

export interface LiveStreamBuffer {
  agentId: string;
  agentName: string;
  avatar: string;
  model: string;
  text: string;
}

interface TeamChatMsg {
  id: string;
  from_agent: string;
  to_agent: string;
  kind: string;
  content: string;
  created_at: string;
}

interface AttachedImage {
  name: string;
  mimeType: string;
  base64: string;
  previewUrl: string;
}

interface MissionRoomProps {
  liveEvents: Array<Record<string, unknown>>;
  streamingBuffers: Record<string, LiveStreamBuffer>;
  onClearStreams: () => void;
  approvalMode: string;
  onChangeApprovalMode: (mode: string) => void;
  initialTeamId?: string | null;
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
  onOpenTerminal?: () => void;
}

export const MissionRoom: React.FC<MissionRoomProps> = ({
  liveEvents,
  streamingBuffers,
  onClearStreams,
  approvalMode,
  onChangeApprovalMode,
  initialTeamId,
  initialPrompt,
  onConsumeInitialPrompt,
  onOpenTerminal,
}) => {
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [blackboard, setBlackboard] = useState<BlackboardEntry[]>([]);

  const [targetType, setTargetType] = useState<"team" | "agent">("team");
  const [targetId, setTargetId] = useState<string>(initialTeamId || "team_pandawa");
  const [selectedPeers, setSelectedPeers] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [brainFiles, setBrainFiles] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(() => window.innerWidth >= 1280);
  const [showBlackboard, setShowBlackboard] = useState(() => window.innerWidth >= 1360);
  const [rightTab, setRightTab] = useState<"blackboard" | "teamchat" | "tasks" | "processes">("blackboard");
  const [expandedPeers, setExpandedPeers] = useState<Set<string>>(new Set());
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [backgroundMode, setBackgroundMode] = useState<boolean>(false);
  const [teamChat, setTeamChat] = useState<TeamChatMsg[]>([]);

  // Team tasks & managed background processes
  const [tasks, setTasks] = useState<TeamTaskItem[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [processes, setProcesses] = useState<ManagedProcItem[]>([]);
  const [procLogs, setProcLogs] = useState<{ id: string; logs: string[] } | null>(null);

  // Add blackboard directive form
  const [bbTitle, setBbTitle] = useState("");
  const [bbContent, setBbContent] = useState("");

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadMeta = useCallback(async () => {
    const [tRes, aRes, sRes, fRes] = await Promise.all([
      apiFetch<{ teams: TeamItem[] }>("/api/teams"),
      apiFetch<{ agents: AgentItem[] }>("/api/agents"),
      apiFetch<{ sessions: SessionItem[] }>("/api/sessions"),
      apiFetch<{ tree: BrainTreeNode[] }>("/api/files/tree"),
    ]);
    setTeams(tRes.teams);
    setAgents(aRes.agents);
    setSessions(sRes.sessions);
    setBrainFiles(collectFilePaths(fRes.tree));

    const matchTeam = tRes.teams.find((t) => t.id === targetId) || tRes.teams[0];
    if (matchTeam && selectedPeers.size === 0) {
      setSelectedPeers(new Set(matchTeam.members.map((m) => m.id)));
    }
  }, [selectedPeers.size, targetId]);

  useEffect(() => {
    if (initialTeamId) {
      setTargetType("team");
      setTargetId(initialTeamId);
    }
  }, [initialTeamId]);

  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt);
      onConsumeInitialPrompt?.();
    }
  }, [initialPrompt, onConsumeInitialPrompt]);

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
    const [bbRes, tRes, pRes, mRes] = await Promise.all([
      apiFetch<{ entries: BlackboardEntry[] }>(`/api/teams/${tid}/blackboard`),
      apiFetch<{ tasks: TeamTaskItem[] }>(`/api/teams/${tid}/tasks`),
      apiFetch<{ processes: ManagedProcItem[] }>("/api/processes"),
      apiFetch<{ messages: TeamChatMsg[] }>(`/api/teams/${tid}/messages`).catch(() => ({ messages: [] })),
    ]);
    setBlackboard(bbRes.entries);
    setTasks(tRes.tasks);
    setProcesses(pRes.processes);
    setTeamChat(mRes.messages || []);
  }, []);

  // Auto-refresh inter-agent chat & completed background jobs from realtime WebSocket events
  useEffect(() => {
    const latest = liveEvents[liveEvents.length - 1];
    if (!latest) return;
    const t = String(latest.type || "");
    if ((t === "team_message" || t === "blackboard_post" || t === "team_task_updated") && targetType === "team") {
      loadBlackboard(targetId).catch(() => {});
    } else if (t === "background_job_updated" && latest.status === "completed") {
      if (typeof latest.sessionId === "string" && latest.sessionId === activeSessionId) {
        loadMessages(activeSessionId).catch(() => {});
        if (targetType === "team") loadBlackboard(targetId).catch(() => {});
      }
      loadMeta().catch(() => {});
    }
  }, [liveEvents, targetType, targetId, activeSessionId, loadBlackboard, loadMessages, loadMeta]);

  async function addImageFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, 4);
    for (const file of list) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
      setAttachedImages((prev) => [
        ...prev.slice(0, 3),
        { name: file.name || "pasted.png", mimeType: file.type || "image/png", base64, previewUrl: dataUrl },
      ]);
    }
  }

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

    // Built-in Mission Room Slash Commands (like Hermes CLI shortcuts)
    if (text.startsWith("/")) {
      setPrompt("");
      const [slash, arg] = text.split(/\s+/);
      if (slash === "/new") {
        setActiveSessionId("");
        setMessages([]);
        return;
      }
      if (slash === "/mode" && arg && ["execute", "deliberate", "parallel", "sequential", "consensus"].includes(arg)) {
        await updateTeamMode(arg as TeamItem["collaboration_mode"]);
        return;
      }
      if (slash === "/auto") {
        await apiFetch("/api/approvals/mode", { method: "PUT", body: JSON.stringify({ mode: "auto" }) });
        setMessages((prev) => [
          ...prev,
          {
            id: `sys_${Date.now()}`,
            session_id: activeSessionId,
            role: "system",
            agent_id: "",
            agent_name: "Pandawa",
            model_used: "",
            content: "Approval mode switched to **Auto (Full Freedom)**.",
            reasoning: "",
            toolCalls: [],
            meta: {},
            created_at: new Date().toISOString(),
          },
        ]);
        return;
      }
      if (slash === "/approve") {
        await apiFetch("/api/approvals/mode", { method: "PUT", body: JSON.stringify({ mode: "approve_shell" }) });
        setMessages((prev) => [
          ...prev,
          {
            id: `sys_${Date.now()}`,
            session_id: activeSessionId,
            role: "system",
            agent_id: "",
            agent_name: "Pandawa",
            model_used: "",
            content: "Approval mode switched to **Approve Shell Only**.",
            reasoning: "",
            toolCalls: [],
            meta: {},
            created_at: new Date().toISOString(),
          },
        ]);
        return;
      }
      if (slash === "/tasks") {
        setShowBlackboard(true);
        setRightTab("tasks");
        return;
      }
      if (slash === "/processes") {
        setShowBlackboard(true);
        setRightTab("processes");
        if (activeTeam) await loadBlackboard(activeTeam.id);
        return;
      }
    }

    const imagesPayload = attachedImages.map((img) => ({
      name: img.name,
      mimeType: img.mimeType,
      base64: img.base64,
    }));
    setAttachedImages([]);
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
        content:
          imagesPayload.length > 0
            ? `${text}\n\n[Attached ${imagesPayload.length} image(s): ${imagesPayload.map((i) => i.name).join(", ")}]`
            : text,
        reasoning: "",
        toolCalls: [],
        meta: {},
        created_at: new Date().toISOString(),
      },
    ]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await apiFetch<{ sessionId: string; background?: boolean; jobId?: string }>("/api/chat/send", {
        method: "POST",
        signal: ac.signal,
        body: JSON.stringify({
          sessionId: activeSessionId || undefined,
          targetType,
          targetId,
          prompt: text,
          images: imagesPayload.length > 0 ? imagesPayload : undefined,
          background: backgroundMode || undefined,
          activeAgentIds: targetType === "team" ? Array.from(selectedPeers) : undefined,
        }),
      });
      setActiveSessionId(res.sessionId);
      if (res.background) {
        setMessages((prev) => [
          ...prev,
          {
            id: `bg_${Date.now()}`,
            session_id: res.sessionId,
            role: "system",
            agent_id: "",
            agent_name: "Background Daemon",
            model_used: "",
            content: `🚀 Mission queued in **Pandawa Background Daemon** (\`${res.jobId}\`). You can close this tab or switch to **Live Terminal** — results will stream live and save automatically.`,
            reasoning: "",
            toolCalls: [],
            meta: {},
            created_at: new Date().toISOString(),
          },
        ]);
        await loadMeta();
      } else {
        await Promise.all([
          loadMessages(res.sessionId),
          loadMeta(),
          targetType === "team" ? loadBlackboard(targetId) : Promise.resolve(),
        ]);
      }
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
    <div className="flex h-screen bg-[#09090b]">
      {/* Left Sessions List (Collapsible for clean narrow-screen UX) */}
      {showHistory && (
      <div className="w-60 shrink-0 bg-[#0c0c0e] border-r border-white/[0.07] flex flex-col">
        <div className="p-3 border-b border-white/[0.07]">
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
          <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 px-2 py-1">
            Mission History ({sessions.length})
          </div>
          {sessions.length === 0 && (
            <div className="p-3 rounded-xl bg-[#0c0c0e] border border-white/[0.06] text-[11px] text-zinc-500 text-center">
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
                  ? "bg-[#18181b] text-white"
                  : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
              }`}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{s.title}</div>
                <div className="text-[10px] text-zinc-500 uppercase">{s.target_type}</div>
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
                className="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-rose-400"
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
        <header className="px-4 py-3 bg-[#0c0c0e] border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowHistory((s) => !s)}
              title="Toggle Mission History"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 border cursor-pointer ${
                showHistory
                  ? "bg-[#18181b] border-white/[0.10] text-white"
                  : "bg-[#09090b] border-white/[0.08] text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <History className="w-3.5 h-3.5" /> History
            </button>
            <div className="flex rounded-lg bg-[#09090b] border border-white/[0.08] p-0.5 text-xs">
              <button
                onClick={() => {
                  setTargetType("team");
                  setTargetId(teams[0]?.id || "team_pandawa");
                }}
                className={`px-2.5 py-1 rounded-md flex items-center gap-1 cursor-pointer ${
                  targetType === "team" ? "bg-violet-500/25 text-violet-200 font-semibold" : "text-zinc-400"
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
                  targetType === "agent" ? "bg-cyan-500/25 text-cyan-200 font-semibold" : "text-zinc-400"
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
                  className="bg-[#09090b] border border-white/[0.10] rounded-lg px-2.5 py-1.5 text-xs text-white"
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
                    className="bg-[#09090b] border border-violet-500/40 rounded-lg px-2.5 py-1.5 text-xs text-violet-200"
                  >
                    <option value="execute">Mode: Execute &amp; Verify (Plan → PTY Build → Test)</option>
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
                className="bg-[#09090b] border border-white/[0.10] rounded-lg px-2.5 py-1.5 text-xs text-white"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.avatar} {a.name} — {a.model || a.purpose}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2">
            {onOpenTerminal && (
              <button
                onClick={onOpenTerminal}
                title="Open Live Shared Agent Terminal"
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 border bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/35 text-emerald-300 cursor-pointer"
              >
                <Terminal className="w-3.5 h-3.5" /> Terminal
              </button>
            )}
            <button
              onClick={() => onChangeApprovalMode(approvalMode === "auto" ? "approve_shell" : "auto")}
              title="Toggle Approval Gate mode"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 border cursor-pointer transition ${
                approvalMode === "auto"
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                  : "bg-[#18181b] border-white/[0.10] text-amber-300"
              }`}
            >
              {approvalMode === "auto" ? <Zap className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5" />}
              {approvalMode === "auto" ? "Full Freedom" : "Approve Shell"}
            </button>

            {targetType === "team" && (
              <button
                onClick={() => setShowBlackboard((s) => !s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border cursor-pointer ${
                  showBlackboard
                    ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                    : "bg-[#18181b] border-white/[0.10] text-zinc-300"
                }`}
              >
                <ClipboardList className="w-3.5 h-3.5" />
                Ops ({blackboard.length + tasks.length})
              </button>
            )}
          </div>
        </header>

        {/* Active Peer Roster Pills (clean wrap, no horizontal cutoffs) */}
        {targetType === "team" && activeTeam && (
          <div className="px-4 py-2 bg-[#0c0c0e] border-b border-white/[0.08]/60 flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className="text-zinc-500 shrink-0 font-medium">Active Peers:</span>
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
                      ? "bg-[#18181b] border-cyan-500/45 text-zinc-100"
                      : "bg-transparent border-white/[0.08] text-zinc-500 opacity-60"
                  }`}
                >
                  <span>{m.avatar}</span>
                  <span className="font-medium">{m.name}</span>
                  <span className="text-[10px] text-zinc-400 font-mono">{m.model || m.purpose}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Messages Stream */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.length === 0 && (
            <div className="max-w-xl mx-auto mt-10 text-center space-y-4">
              <div className="w-12 h-12 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mx-auto">
                <Sparkles className="w-6 h-6 text-amber-400" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-base font-bold text-white">Pandawa Mission Room</h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Every teammate reads the wired <strong>Main Brain</strong>, <strong>Team Brain</strong>, and their own{" "}
                  <code className="text-amber-300">soul.md</code>, deliberates on the shared Team Blackboard, and delivers unified consensus.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2 text-left pt-2">
                {QUICK_STARTERS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setPrompt(q)}
                    className="px-3.5 py-2.5 rounded-xl bg-[#111113] hover:bg-[#18181b] border border-white/[0.08] hover:border-amber-500/40 text-xs text-zinc-300 transition cursor-pointer"
                  >
                    ✨ {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => {
            if (m.role === "user") {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-2xl bg-[#18181b] border border-white/[0.09] text-zinc-100 rounded-xl rounded-tr-sm px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap">
                    {m.content}
                  </div>
                </div>
              );
            }

            const isPeerNote = m.role === "agent";
            const isExpanded = !isPeerNote || expandedPeers.has(m.id);
            const avatar = String(m.meta?.avatar || (isPeerNote ? "·" : "P"));

            return (
              <div
                key={m.id}
                className={`max-w-3xl rounded-xl border ${
                  isPeerNote
                    ? "bg-[#111113] border-white/[0.07]"
                    : "bg-[#111113] border-white/[0.11] border-l-2 border-l-amber-400/80"
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
                  className={`px-4 py-2.5 flex items-center justify-between gap-2 border-b border-white/[0.06] ${
                    isPeerNote ? "cursor-pointer hover:bg-white/[0.03]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isPeerNote &&
                      (isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
                      ))}
                    <span>{avatar}</span>
                    <span className="text-xs font-bold text-white truncate">{m.agent_name}</span>
                    {m.model_used && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#18181b] text-emerald-300">
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
                    <span className="text-[10px] text-zinc-500 font-mono">
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
                            className="text-[11px] bg-[#09090b] border border-white/[0.08] rounded-lg px-2.5 py-1.5 font-mono text-zinc-400"
                          >
                            <span className="text-pink-400 inline-flex items-center gap-1">
                              <Wrench className="w-3 h-3" /> {tc.name}
                            </span>
                            <span className="text-zinc-500 ml-2">{JSON.stringify(tc.args).slice(0, 120)}</span>
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
              <div className="rounded-xl bg-[#111113] border border-amber-500/35 p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Pandawa Team is streaming & collaborating live...
                </div>
                {recentLiveStatus.map((ev, i) => (
                  <div key={i} className="text-[11px] font-mono text-zinc-400 truncate">
                    › {String(ev.type)}: {String(ev.detail || ev.agentName || ev.toolName || ev.phase || "")}
                  </div>
                ))}
              </div>

              {Object.values(streamingBuffers).map((buf) => (
                <div
                  key={buf.agentId}
                  className="rounded-xl bg-[#111113] border border-emerald-500/40 p-4 space-y-2 shadow-lg"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span>{buf.avatar || "⚡"}</span>
                    <span className="font-bold text-white">{buf.agentName}</span>
                    {buf.model && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#18181b] text-emerald-300">
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

        {/* Input Composer with Live / Slash & @ File Autocomplete */}
        <form onSubmit={sendMission} className="p-4 bg-[#0c0c0e] border-t border-white/[0.07] relative">
          {prompt.startsWith("/") && !prompt.includes("\n") && (
            <div className="absolute bottom-full left-4 right-4 mb-2 rounded-xl bg-[#111113] border border-amber-500/40 shadow-2xl p-1.5 max-h-52 overflow-y-auto z-30">
              <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400">
                Slash Commands
              </div>
              {SLASH_SUGGESTIONS.filter((s) => s.cmd.startsWith(prompt.toLowerCase())).map((s) => (
                <button
                  key={s.cmd}
                  type="button"
                  onClick={() => setPrompt(s.cmd)}
                  className="w-full px-2.5 py-1.5 rounded-lg hover:bg-[#18181b] text-left flex items-center justify-between gap-2 text-xs cursor-pointer"
                >
                  <code className="text-amber-300 font-semibold">{s.cmd}</code>
                  <span className="text-zinc-400 truncate">{s.desc}</span>
                </button>
              ))}
            </div>
          )}

          {/(^|\s)@[a-zA-Z0-9_./-]*$/.test(prompt) && (
            <div className="absolute bottom-full left-4 right-4 mb-2 rounded-xl bg-[#111113] border border-cyan-500/40 shadow-2xl p-1.5 max-h-52 overflow-y-auto z-30">
              <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                Inline Brain File Reference (@file)
              </div>
              {brainFiles
                .filter((fp) => {
                  const m = prompt.match(/@([a-zA-Z0-9_./-]*)$/);
                  const q = (m?.[1] || "").toLowerCase();
                  return !q || fp.toLowerCase().includes(q);
                })
                .slice(0, 10)
                .map((fp) => (
                  <button
                    key={fp}
                    type="button"
                    onClick={() => setPrompt((prev) => prev.replace(/@[a-zA-Z0-9_./-]*$/, `@${fp} `))}
                    className="w-full px-2.5 py-1.5 rounded-lg hover:bg-[#18181b] text-left font-mono text-xs text-cyan-300 truncate cursor-pointer"
                  >
                    @{fp}
                  </button>
                ))}
            </div>
          )}

          {/* Attached Multimodal Vision Images */}
          {attachedImages.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachedImages.map((img, idx) => (
                <div
                  key={`${img.name}_${idx}`}
                  className="relative group flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#09090b] border border-cyan-500/40 text-[11px] text-cyan-200"
                >
                  <img src={img.previewUrl} alt={img.name} className="w-7 h-7 rounded object-cover" />
                  <span className="max-w-[120px] truncate">{img.name}</span>
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() => setAttachedImages((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-zinc-400 hover:text-rose-400 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 items-stretch">
            <div className="flex flex-col gap-1.5 shrink-0">
              <label
                title="Attach screenshot or image for Multimodal Vision (or paste Ctrl+V)"
                className="flex-1 px-2.5 rounded-xl bg-[#18181b] hover:bg-[#222227] border border-white/[0.10] text-cyan-300 flex items-center justify-center cursor-pointer"
              >
                <ImagePlus className="w-4 h-4" />
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    addImageFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => setBackgroundMode((b) => !b)}
                title="Toggle 24/7 Background Daemon mode (continues running even if you close this tab)"
                className={`px-2 py-1 rounded-lg border text-[10px] font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                  backgroundMode
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-[#09090b] border-white/[0.08] text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Clock className="w-3 h-3" /> {backgroundMode ? "BG" : "Live"}
              </button>
            </div>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(e) => {
                const items = Array.from(e.clipboardData.items || []);
                const imgs = items
                  .filter((it) => it.type.startsWith("image/"))
                  .map((it) => it.getAsFile())
                  .filter(Boolean) as File[];
                if (imgs.length > 0) addImageFiles(imgs);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMission(e);
                }
              }}
              placeholder={
                targetType === "team"
                  ? "Give Team Pandawa a mission... (@file.md, paste image, or /mode execute)"
                  : "Message this agent directly... (@file.md or paste image)"
              }
              className="flex-1 bg-[#09090b] border border-white/[0.10] focus:border-amber-500 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-zinc-500 outline-none resize-none"
            />
            {sending ? (
              <button
                type="button"
                onClick={stopMission}
                className="px-4 rounded-lg bg-rose-500/90 hover:bg-rose-500 text-white font-medium text-xs flex items-center gap-1.5 cursor-pointer shrink-0 transition"
              >
                <Square className="w-3.5 h-3.5 fill-current" /> Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!prompt.trim()}
                className="px-4 rounded-lg bg-zinc-100 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer shrink-0 transition"
              >
                <Send className="w-3.5 h-3.5" /> Send
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Right Team Ops Panel: Blackboard | Tasks | Processes */}
      {targetType === "team" && showBlackboard && (
        <aside className="w-80 shrink-0 bg-[#0c0c0e] border-l border-white/[0.07] flex flex-col">
          <div className="px-2.5 py-2 border-b border-white/[0.07] grid grid-cols-4 gap-1 text-[10px]">
            <button
              onClick={() => setRightTab("blackboard")}
              className={`py-1.5 rounded-lg font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                rightTab === "blackboard" ? "bg-amber-500/20 text-amber-300" : "text-zinc-400 hover:bg-white/[0.06]"
              }`}
            >
              <ClipboardList className="w-3 h-3" /> Board
            </button>
            <button
              onClick={() => setRightTab("teamchat")}
              className={`py-1.5 rounded-lg font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                rightTab === "teamchat" ? "bg-violet-500/20 text-violet-300" : "text-zinc-400 hover:bg-white/[0.06]"
              }`}
            >
              <MessageCircle className="w-3 h-3" /> Chat ({teamChat.length})
            </button>
            <button
              onClick={() => setRightTab("tasks")}
              className={`py-1.5 rounded-lg font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                rightTab === "tasks" ? "bg-cyan-500/20 text-cyan-300" : "text-zinc-400 hover:bg-white/[0.06]"
              }`}
            >
              <CheckSquare className="w-3 h-3" /> Tasks
            </button>
            <button
              onClick={() => {
                setRightTab("processes");
                if (activeTeam) loadBlackboard(activeTeam.id);
              }}
              className={`py-1.5 rounded-lg font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                rightTab === "processes" ? "bg-emerald-500/20 text-emerald-300" : "text-zinc-400 hover:bg-white/[0.06]"
              }`}
            >
              <Terminal className="w-3 h-3" /> Proc
            </button>
          </div>

          {rightTab === "teamchat" && (
            <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
              <div className="text-[11px] text-zinc-400">
                Live Inter-Agent Channel (agents talk mid-execution via <code>team_message</code>)
              </div>
              {teamChat.map((m) => (
                <div key={m.id} className="p-2.5 rounded-xl bg-[#0c0c0e] border border-violet-500/25 space-y-1">
                  <div className="flex items-center justify-between gap-1 text-[10px]">
                    <span className="font-bold text-violet-300">
                      {m.from_agent} → {m.to_agent}
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-[#18181b] text-zinc-400 uppercase">{m.kind}</span>
                  </div>
                  <div className="text-[11px] text-zinc-200 whitespace-pre-wrap">{m.content}</div>
                </div>
              ))}
              {teamChat.length === 0 && (
                <div className="text-zinc-500 p-2">
                  No inter-agent messages yet. In <strong>Execute &amp; Verify</strong> or <strong>Musyawarah</strong>{" "}
                  mode, teammates message each other live here (ports, terminal names, handoffs).
                </div>
              )}
            </div>
          )}

          {rightTab === "blackboard" && (
            <>
              <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
                {blackboard.map((b) => (
                  <div key={b.id} className="p-3 rounded-xl bg-[#0c0c0e] border border-white/[0.08] space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-bold uppercase">
                        {b.entry_type}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-zinc-500">{b.author_name}</span>
                        <button
                          aria-label="Delete blackboard entry"
                          onClick={() => deleteBlackboardEntry(b.id)}
                          className="text-zinc-600 hover:text-rose-400 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <div className="text-xs font-semibold text-zinc-200">{b.title}</div>
                    <div className="text-[11px] text-zinc-400 whitespace-pre-wrap line-clamp-5">{b.content}</div>
                  </div>
                ))}
                {blackboard.length === 0 && (
                  <div className="text-xs text-zinc-500 p-2">
                    No entries yet. Start a mission or pin a team directive below.
                  </div>
                )}
              </div>

              <form onSubmit={addBlackboardEntry} className="p-3 border-t border-white/[0.07] space-y-2">
                <input
                  value={bbTitle}
                  onChange={(e) => setBbTitle(e.target.value)}
                  placeholder="Pin team directive / note title..."
                  className="w-full bg-[#09090b] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-amber-500"
                />
                <textarea
                  rows={2}
                  value={bbContent}
                  onChange={(e) => setBbContent(e.target.value)}
                  placeholder="Shared note visible to all peers..."
                  className="w-full bg-[#09090b] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white outline-none resize-none"
                />
                <button
                  type="submit"
                  className="w-full py-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] text-zinc-200 text-xs font-medium cursor-pointer"
                >
                  Post to Blackboard
                </button>
              </form>
            </>
          )}

          {rightTab === "tasks" && (
            <>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {tasks.map((t) => (
                  <div key={t.id} className="p-2.5 rounded-xl bg-[#0c0c0e] border border-white/[0.08] flex items-start justify-between gap-2 text-xs">
                    <button
                      onClick={async () => {
                        if (!activeTeam) return;
                        const nextStatus = t.status === "done" ? "todo" : "done";
                        await apiFetch(`/api/teams/${activeTeam.id}/tasks/${t.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ status: nextStatus }),
                        });
                        await loadBlackboard(activeTeam.id);
                      }}
                      className="text-left flex-1 min-w-0 cursor-pointer"
                    >
                      <div className={`font-medium ${t.status === "done" ? "line-through text-zinc-500" : "text-zinc-200"}`}>
                        {t.status === "done" ? "☑" : "☐"} {t.title}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        Owner: {t.owner_agent} · <span className="uppercase text-cyan-400">{t.status}</span>
                      </div>
                    </button>
                    <button
                      aria-label="Delete task"
                      onClick={async () => {
                        if (!activeTeam) return;
                        await apiFetch(`/api/teams/${activeTeam.id}/tasks/${t.id}`, { method: "DELETE" });
                        await loadBlackboard(activeTeam.id);
                      }}
                      className="text-zinc-600 hover:text-rose-400 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {tasks.length === 0 && (
                  <div className="text-xs text-zinc-500 p-2">
                    Shared Team Task Board is empty. Add tasks below or let agents manage them via <code>team_todo_manage</code>.
                  </div>
                )}
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newTaskTitle.trim() || !activeTeam) return;
                  await apiFetch(`/api/teams/${activeTeam.id}/tasks`, {
                    method: "POST",
                    body: JSON.stringify({ title: newTaskTitle.trim(), ownerAgent: "Team", status: "todo" }),
                  });
                  setNewTaskTitle("");
                  await loadBlackboard(activeTeam.id);
                }}
                className="p-3 border-t border-white/[0.07] flex gap-1.5"
              >
                <input
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="Add shared team task..."
                  className="flex-1 bg-[#09090b] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-cyan-500"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-xs font-semibold cursor-pointer"
                >
                  Add
                </button>
              </form>
            </>
          )}

          {rightTab === "processes" && (
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-400">Managed Background Processes</span>
                <button
                  onClick={() => activeTeam && loadBlackboard(activeTeam.id)}
                  className="p-1 rounded bg-[#18181b] hover:bg-[#222227] text-zinc-300 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
              {processes.map((p) => (
                <div key={p.id} className="p-2.5 rounded-xl bg-[#0c0c0e] border border-white/[0.08] space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-white truncate">{p.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold ${
                        p.status === "running" ? "bg-emerald-500/20 text-emerald-300" : "bg-[#18181b] text-zinc-400"
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono text-zinc-500 truncate">{p.command}</div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={async () => {
                        const r = await apiFetch<{ logs: string[] }>(`/api/processes/${p.id}/logs?tail=50`);
                        setProcLogs({ id: p.id, logs: r.logs });
                      }}
                      className="px-2 py-1 rounded bg-[#18181b] hover:bg-[#222227] text-zinc-200 text-[10px] cursor-pointer"
                    >
                      Logs ({p.logLines})
                    </button>
                    {p.status === "running" && (
                      <button
                        onClick={async () => {
                          await apiFetch(`/api/processes/${p.id}/kill`, { method: "POST" });
                          if (activeTeam) await loadBlackboard(activeTeam.id);
                        }}
                        className="px-2 py-1 rounded bg-rose-500/20 text-rose-300 text-[10px] cursor-pointer"
                      >
                        Kill
                      </button>
                    )}
                  </div>
                  {procLogs?.id === p.id && (
                    <pre className="p-2 rounded bg-[#09090b] text-[10px] font-mono text-emerald-300 max-h-36 overflow-auto whitespace-pre-wrap">
                      {procLogs.logs.join("\n") || "(no output yet)"}
                    </pre>
                  )}
                </div>
              ))}
              {processes.length === 0 && (
                <div className="text-zinc-500 p-2">
                  No background processes running. Agents can spawn servers/workers with <code>process_start</code>.
                </div>
              )}
            </div>
          )}
        </aside>
      )}
    </div>
  );
};

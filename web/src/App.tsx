import React, { Suspense, lazy, useEffect, useState } from "react";
import { apiFetch, createRealtimeSocket, getStoredToken, setStoredToken } from "./api/client";
import type { NavTab } from "./types";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar } from "./components/Sidebar";
import { OverviewPage } from "./components/OverviewPage";
import { MissionRoom, type LiveStreamBuffer } from "./components/chat/MissionRoom";
import { BrainExplorer } from "./components/brains/BrainExplorer";
import { ProvidersPage } from "./components/providers/ProvidersPage";
import { SkillsPage } from "./components/ops/SkillsPage";
import { AutomationPage } from "./components/ops/AutomationPage";
import { SettingsPage } from "./components/ops/SettingsPage";
import { ApprovalOverlay, type PendingApprovalItem } from "./components/ApprovalOverlay";
import { CommandPalette } from "./components/CommandPalette";

// Code-split heavy views (XYFlow Canvas & xterm.js PTY) for fast initial paint
const BrainCanvas = lazy(() =>
  import("./components/canvas/BrainCanvas").then((m) => ({ default: m.BrainCanvas }))
);
const TerminalPage = lazy(() =>
  import("./components/ops/TerminalPage").then((m) => ({ default: m.TerminalPage }))
);

const LazyFallback: React.FC<{ label: string }> = ({ label }) => (
  <div className="h-screen bg-[#09090b] flex items-center justify-center text-xs font-mono text-zinc-500">
    Loading {label}...
  </div>
);

export const App: React.FC = () => {
  const [authed, setAuthed] = useState<boolean>(false);
  const [checkingAuth, setCheckingAuth] = useState<boolean>(true);
  const [usingDefaultPassword, setUsingDefaultPassword] = useState<boolean>(false);
  const [tab, setTab] = useState<NavTab>("overview");
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [focusTeamId, setFocusTeamId] = useState<string | null>(null);
  const [chatInitialTeamId, setChatInitialTeamId] = useState<string | null>(null);
  const [chatStarterPrompt, setChatStarterPrompt] = useState<string | null>(null);
  const [approvalMode, setApprovalMode] = useState<string>("approve_shell");

  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [liveEvents, setLiveEvents] = useState<Array<Record<string, unknown>>>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalItem[]>([]);
  const [activeAgentIds, setActiveAgentIds] = useState<Set<string>>(new Set());
  const [streamingBuffers, setStreamingBuffers] = useState<Record<string, LiveStreamBuffer>>({});

  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener("pandawa:unauthorized", onUnauthorized);
    return () => window.removeEventListener("pandawa:unauthorized", onUnauthorized);
  }, []);

  // Global Cmd+K / Ctrl+K shortcut for Command Palette
  useEffect(() => {
    if (!authed) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authed]);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setCheckingAuth(false);
      return;
    }
    apiFetch<{ authenticated: boolean; usingDefaultPassword: boolean }>("/api/auth/me")
      .then((res) => {
        setAuthed(res.authenticated);
        setUsingDefaultPassword(res.usingDefaultPassword);
      })
      .catch(() => {
        setStoredToken(null);
        setAuthed(false);
      })
      .finally(() => setCheckingAuth(false));
  }, []);

  async function handleChangeApprovalMode(nextMode: string) {
    setApprovalMode(nextMode);
    try {
      await apiFetch("/api/approvals/mode", {
        method: "PUT",
        body: JSON.stringify({ mode: nextMode }),
      });
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!authed) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;
    let attempt = 0;

    function syncApprovals() {
      apiFetch<{ mode?: string; pending: PendingApprovalItem[] }>("/api/approvals")
        .then((r) => {
          if (disposed) return;
          setPendingApprovals(r.pending || []);
          if (r.mode) setApprovalMode(r.mode);
        })
        .catch(() => {});
    }

    async function connectWs() {
      if (disposed) return;
      try {
        ws = await createRealtimeSocket((ev) => {
          const evType = String(ev.type || "");
          if (evType !== "agent_token") {
            setLiveEvents((prev) => [...prev.slice(-30), ev]);
          }

          if (evType === "agent_start" && typeof ev.agentId === "string") {
            const aid = ev.agentId;
            setActiveAgentIds((prev) => new Set([...prev, aid]));
          } else if (evType === "agent_done" && typeof ev.agentId === "string") {
            const aid = ev.agentId;
            setActiveAgentIds((prev) => {
              const next = new Set(prev);
              next.delete(aid);
              return next;
            });
          } else if (evType === "mission_aborted") {
            setActiveAgentIds(new Set());
            setStreamingBuffers({});
          } else if (evType === "agent_token" && typeof ev.agentId === "string") {
            const aid = ev.agentId;
            const delta = String(ev.delta || "");
            setStreamingBuffers((prev) => {
              const existing = prev[aid] || {
                agentId: aid,
                agentName: String(ev.agentName || aid),
                avatar: String(ev.avatar || "P"),
                model: String(ev.model || ""),
                text: "",
              };
              return {
                ...prev,
                [aid]: { ...existing, text: existing.text + delta },
              };
            });
          } else if (evType === "approval_required" && ev.approval) {
            const item = ev.approval as PendingApprovalItem;
            setPendingApprovals((prev) => (prev.some((x) => x.id === item.id) ? prev : [...prev, item]));
          } else if (evType === "approval_resolved" && typeof ev.id === "string") {
            setPendingApprovals((prev) => prev.filter((x) => x.id !== ev.id));
            if (typeof ev.mode === "string") setApprovalMode(ev.mode);
          } else if (evType === "approval_mode_changed" && typeof ev.mode === "string") {
            setApprovalMode(ev.mode);
          }
        });
      } catch {
        if (!disposed) {
          const delay = Math.min(8000, 1000 * Math.pow(2, attempt++));
          retryTimer = window.setTimeout(connectWs, delay);
        }
        return;
      }

      if (!ws || disposed) {
        ws?.close();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        setWsConnected(true);
        syncApprovals();
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (!disposed) {
          const delay = Math.min(8000, 1000 * Math.pow(2, attempt++));
          retryTimer = window.setTimeout(connectWs, delay);
        }
      };
      ws.onerror = () => ws?.close();
    }

    syncApprovals();
    connectWs();

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [authed]);

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center text-xs font-mono text-zinc-500">
        Initializing Pandawa OS...
      </div>
    );
  }

  if (!authed) {
    return (
      <LoginScreen
        onSuccess={(isDef) => {
          setUsingDefaultPassword(isDef);
          setAuthed(true);
        }}
      />
    );
  }

  function handleOpenBrainFile(filePath: string) {
    setOpenFilePath(filePath);
    setTab("brains");
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#09090b] text-zinc-100">
      <Sidebar
        active={tab}
        onSelect={setTab}
        usingDefaultPassword={usingDefaultPassword}
        wsConnected={wsConnected}
        approvalMode={approvalMode}
        onOpenPalette={() => setPaletteOpen(true)}
        onLogout={() => {
          setStoredToken(null);
          setAuthed(false);
        }}
      />
      <main className="flex-1 min-w-0 h-screen overflow-hidden bg-[#09090b]">
        {tab === "overview" && (
          <OverviewPage
            approvalMode={approvalMode}
            onChangeApprovalMode={handleChangeApprovalMode}
            onNavigate={setTab}
            onStartMission={(teamId, starterPrompt) => {
              setChatInitialTeamId(teamId);
              if (starterPrompt) setChatStarterPrompt(starterPrompt);
              setTab("chat");
            }}
            onFocusTeamOnCanvas={(teamId) => {
              setFocusTeamId(teamId);
              setTab("canvas");
            }}
          />
        )}
        {tab === "canvas" && (
          <Suspense fallback={<LazyFallback label="Brain Canvas" />}>
            <BrainCanvas
              onOpenBrainFile={handleOpenBrainFile}
              activeAgentIds={activeAgentIds}
              initialFocusTeamId={focusTeamId}
            />
          </Suspense>
        )}
        {tab === "chat" && (
          <MissionRoom
            liveEvents={liveEvents}
            streamingBuffers={streamingBuffers}
            onClearStreams={() => setStreamingBuffers({})}
            approvalMode={approvalMode}
            onChangeApprovalMode={handleChangeApprovalMode}
            initialTeamId={chatInitialTeamId}
            initialPrompt={chatStarterPrompt}
            onConsumeInitialPrompt={() => setChatStarterPrompt(null)}
            onOpenTerminal={() => setTab("terminal")}
          />
        )}
        {tab === "terminal" && (
          <Suspense fallback={<LazyFallback label="Live Terminal" />}>
            <TerminalPage liveEvents={liveEvents} />
          </Suspense>
        )}
        {tab === "brains" && (
          <BrainExplorer
            initialFilePath={openFilePath}
            onPinnedToCanvas={() => setTab("canvas")}
          />
        )}
        {tab === "providers" && <ProvidersPage />}
        {tab === "skills" && <SkillsPage onOpenFile={handleOpenBrainFile} />}
        {tab === "automation" && <AutomationPage onOpenFile={handleOpenBrainFile} />}
        {tab === "settings" && <SettingsPage onPasswordChanged={() => setUsingDefaultPassword(false)} />}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={setTab}
        approvalMode={approvalMode}
        onChangeApprovalMode={handleChangeApprovalMode}
      />

      <ApprovalOverlay
        approvals={pendingApprovals}
        onResolved={(id) => setPendingApprovals((prev) => prev.filter((x) => x.id !== id))}
      />
    </div>
  );
};

export default App;

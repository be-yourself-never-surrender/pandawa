import React, { useEffect, useState } from "react";
import { apiFetch, createRealtimeSocket, getStoredToken, setStoredToken } from "./api/client";
import type { NavTab } from "./types";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar } from "./components/Sidebar";
import { BrainCanvas } from "./components/canvas/BrainCanvas";
import { MissionRoom } from "./components/chat/MissionRoom";
import { BrainExplorer } from "./components/brains/BrainExplorer";
import { ProvidersPage } from "./components/providers/ProvidersPage";
import { SkillsPage } from "./components/ops/SkillsPage";
import { AutomationPage } from "./components/ops/AutomationPage";
import { SettingsPage } from "./components/ops/SettingsPage";

export const App: React.FC = () => {
  const [authed, setAuthed] = useState<boolean>(false);
  const [checkingAuth, setCheckingAuth] = useState<boolean>(true);
  const [usingDefaultPassword, setUsingDefaultPassword] = useState<boolean>(false);
  const [tab, setTab] = useState<NavTab>("canvas");
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [liveEvents, setLiveEvents] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthed(false);
    };
    window.addEventListener("pandawa:unauthorized", onUnauthorized);
    return () => window.removeEventListener("pandawa:unauthorized", onUnauthorized);
  }, []);

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

  useEffect(() => {
    if (!authed) return;
    const ws = createRealtimeSocket((ev) => {
      setLiveEvents((prev) => [...prev.slice(-30), ev]);
    });
    if (!ws) return;
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    return () => ws.close();
  }, [authed]);

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[#080a0f] flex items-center justify-center text-sm text-slate-400">
        Loading Pandawa Studio...
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
    <div className="flex h-screen w-screen overflow-hidden bg-[#080a0f]">
      <Sidebar
        active={tab}
        onSelect={setTab}
        usingDefaultPassword={usingDefaultPassword}
        wsConnected={wsConnected}
        onLogout={() => {
          setStoredToken(null);
          setAuthed(false);
        }}
      />
      <main className="flex-1 min-w-0 h-screen overflow-hidden">
        {tab === "canvas" && <BrainCanvas onOpenBrainFile={handleOpenBrainFile} />}
        {tab === "chat" && <MissionRoom liveEvents={liveEvents} />}
        {tab === "brains" && (
          <BrainExplorer
            initialFilePath={openFilePath}
            onPinnedToCanvas={() => setTab("canvas")}
          />
        )}
        {tab === "providers" && <ProvidersPage />}
        {tab === "skills" && <SkillsPage onOpenFile={handleOpenBrainFile} />}
        {tab === "automation" && <AutomationPage />}
        {tab === "settings" && <SettingsPage onPasswordChanged={() => setUsingDefaultPassword(false)} />}
      </main>
    </div>
  );
};

export default App;

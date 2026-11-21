import React from "react";
import {
  Network,
  MessageSquare,
  FolderTree,
  Cpu,
  BookOpen,
  Clock,
  Settings,
  LogOut,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import type { NavTab } from "../types";

interface SidebarProps {
  active: NavTab;
  onSelect: (tab: NavTab) => void;
  usingDefaultPassword: boolean;
  wsConnected: boolean;
  onLogout: () => void;
}

const ITEMS: Array<{ id: NavTab; label: string; desc: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "canvas", label: "Brain Canvas", desc: "n8n-style Topology", icon: Network },
  { id: "chat", label: "Mission Room", desc: "Agentic Team Chat", icon: MessageSquare },
  { id: "brains", label: "Brain Files", desc: "soul.md & Folders", icon: FolderTree },
  { id: "providers", label: "Multi-AI Hub", desc: "APIs & Custom URLs", icon: Cpu },
  { id: "skills", label: "Skills & Memory", desc: "Self-Learning Loop", icon: BookOpen },
  { id: "automation", label: "Cron & Channels", desc: "Schedules, Bots, MCP", icon: Clock },
  { id: "settings", label: "Settings & VPS", desc: "Security & System", icon: Settings },
];

export const Sidebar: React.FC<SidebarProps> = ({
  active,
  onSelect,
  usingDefaultPassword,
  wsConnected,
  onLogout,
}) => {
  return (
    <aside className="w-60 shrink-0 bg-[#0c0f18] border-r border-slate-800/80 flex flex-col h-screen select-none">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-slate-800/80 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 via-amber-500 to-orange-600 flex items-center justify-center shadow-md shadow-amber-500/20">
          <Sparkles className="w-5 h-5 text-slate-950" />
        </div>
        <div className="min-w-0">
          <div className="font-bold text-base tracking-tight text-white leading-tight">PANDAWA</div>
          <div className="text-[11px] text-amber-400/85 font-medium truncate">
            Agentic Team Studio
          </div>
        </div>
      </div>

      {/* Default password warning */}
      {usingDefaultPassword && (
        <button
          onClick={() => onSelect("settings")}
          className="mx-3 mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-left hover:bg-amber-500/15 transition cursor-pointer"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Default Password Active
          </div>
          <div className="text-[10px] text-amber-200/75 mt-0.5">
            Click to change password in Settings
          </div>
        </button>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-1">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition cursor-pointer ${
                isActive
                  ? "bg-amber-500/15 text-amber-300 border border-amber-500/30 shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent"
              }`}
            >
              <Icon className={`w-4 h-4 shrink-0 ${isActive ? "text-amber-400" : "text-slate-400"}`} />
              <div className="min-w-0">
                <div className="text-xs font-semibold leading-tight truncate">{item.label}</div>
                <div className="text-[10px] text-slate-500 truncate mt-0.5">{item.desc}</div>
              </div>
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-slate-800/80 space-y-2">
        <div className="flex items-center justify-between px-2 py-1 text-[11px] text-slate-400">
          <span className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : "bg-amber-400 animate-pulse"
              }`}
            />
            {wsConnected ? "Realtime Live" : "Connecting..."}
          </span>
          <span className="text-slate-600 font-mono">v2.5</span>
        </div>
        <button
          onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 border border-slate-800 hover:border-rose-500/30 transition cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign Out
        </button>
      </div>
    </aside>
  );
};

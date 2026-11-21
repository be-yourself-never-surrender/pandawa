import React from "react";
import {
  LayoutDashboard,
  Network,
  MessageSquare,
  Terminal,
  FolderTree,
  Cpu,
  BookOpen,
  Clock,
  Settings,
  LogOut,
  AlertTriangle,
  Shield,
  Zap,
  Search,
} from "lucide-react";
import type { NavTab } from "../types";
import { PandawaMark } from "./PandawaMark";

interface SidebarProps {
  active: NavTab;
  onSelect: (tab: NavTab) => void;
  usingDefaultPassword: boolean;
  wsConnected: boolean;
  approvalMode: string;
  onOpenPalette: () => void;
  onLogout: () => void;
}

const SECTIONS: Array<{
  title: string;
  items: Array<{ id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }>;
}> = [
  {
    title: "Workspace",
    items: [
      { id: "overview", label: "Command Center", icon: LayoutDashboard },
      { id: "chat", label: "Mission Room", icon: MessageSquare },
      { id: "canvas", label: "Brain Canvas", icon: Network },
      { id: "terminal", label: "Live Terminal", icon: Terminal },
    ],
  },
  {
    title: "Knowledge",
    items: [
      { id: "brains", label: "Brain Files", icon: FolderTree },
      { id: "providers", label: "AI Providers", icon: Cpu },
      { id: "skills", label: "Skills & Memory", icon: BookOpen },
    ],
  },
  {
    title: "System",
    items: [
      { id: "automation", label: "Automation & MCP", icon: Clock },
      { id: "settings", label: "Settings", icon: Settings },
    ],
  },
];

export const Sidebar: React.FC<SidebarProps> = ({
  active,
  onSelect,
  usingDefaultPassword,
  wsConnected,
  approvalMode,
  onOpenPalette,
  onLogout,
}) => {
  return (
    <aside className="w-[224px] shrink-0 bg-[#0c0c0e] border-r border-white/[0.07] flex flex-col h-screen select-none">
      {/* Brand Row */}
      <div className="h-13 px-3.5 border-b border-white/[0.06] flex items-center justify-between">
        <button
          onClick={() => onSelect("overview")}
          className="flex items-center gap-2.5 text-left group cursor-pointer"
        >
          <div className="w-7 h-7 rounded-md bg-[#16161a] border border-white/[0.09] flex items-center justify-center text-amber-400 group-hover:border-amber-400/40 transition">
            <PandawaMark className="w-4 h-4" />
          </div>
          <span className="text-[14px] font-semibold tracking-[-0.02em] text-zinc-100">
            Pandawa
          </span>
        </button>
        <span className="text-[10px] font-mono text-zinc-500 px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06]">
          v7.0
        </span>
      </div>

      {/* Quick Command Trigger */}
      <div className="px-2.5 pt-2.5">
        <button
          type="button"
          onClick={onOpenPalette}
          className="w-full h-8 px-2.5 rounded-lg bg-[#111113] hover:bg-[#16161a] border border-white/[0.07] flex items-center justify-between text-xs text-zinc-500 hover:text-zinc-300 transition cursor-pointer"
        >
          <span className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5" />
            <span>Quick jump...</span>
          </span>
          <kbd className="text-[10px] font-mono text-zinc-500">⌘K</kbd>
        </button>
      </div>

      {/* Legacy Password Alert */}
      {usingDefaultPassword && (
        <button
          onClick={() => onSelect("settings")}
          className="mx-2.5 mt-2.5 px-2.5 py-2 rounded-lg bg-amber-500/[0.08] border border-amber-400/25 text-left hover:bg-amber-500/[0.12] transition cursor-pointer"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            Change default password
          </div>
          <div className="text-[10px] text-zinc-400 mt-0.5">
            Update from 11111111 in Settings
          </div>
        </button>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-5">
        {SECTIONS.map((sec) => (
          <div key={sec.title} className="space-y-0.5">
            <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-600">
              {sec.title}
            </div>
            {sec.items.map((item) => {
              const Icon = item.icon;
              const isActive = active === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  className={`relative w-full h-8 flex items-center gap-2.5 px-2.5 rounded-md text-left text-[13px] transition cursor-pointer ${
                    isActive
                      ? "bg-white/[0.07] text-zinc-100 font-medium"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.035] font-normal"
                  }`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-amber-400" />
                  )}
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-amber-400" : "text-zinc-500"}`} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Compact Instrument Footer */}
      <div className="p-2.5 border-t border-white/[0.06] space-y-2">
        <button
          onClick={() => onSelect("settings")}
          title="Configure Approval Gate"
          className="w-full h-8 px-2.5 rounded-md bg-[#111113] hover:bg-[#17171a] border border-white/[0.07] text-[11px] font-medium flex items-center justify-between text-zinc-300 cursor-pointer transition"
        >
          <span className="flex items-center gap-1.5 truncate">
            {approvalMode === "auto" ? (
              <Zap className="w-3 h-3 text-emerald-400 shrink-0" />
            ) : (
              <Shield className="w-3 h-3 text-amber-400 shrink-0" />
            )}
            <span className="truncate">
              {approvalMode === "auto" ? "Full Freedom" : `Gate: ${approvalMode.replace("approve_", "")}`}
            </span>
          </span>
          <span className="text-[10px] font-mono text-zinc-500">Edit</span>
        </button>

        <div className="flex items-center justify-between px-1.5 pt-0.5">
          <span className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                wsConnected ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
              }`}
            />
            {wsConnected ? "Realtime Live" : "Reconnecting"}
          </span>
          <button
            onClick={onLogout}
            title="Sign Out"
            aria-label="Sign Out"
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] transition cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
};

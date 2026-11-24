import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  LayoutDashboard,
  Eye,
  Network,
  Radio,
  Terminal,
  FolderTree,
  Cpu,
  BookOpen,
  Clock,
  Settings,
  Shield,
  Zap,
  CornerDownLeft,
} from "lucide-react";
import type { NavTab } from "../types";

interface CommandItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: NavTab) => void;
  approvalMode: string;
  onChangeApprovalMode: (mode: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onNavigate,
  approvalMode,
  onChangeApprovalMode,
}) => {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items = useMemo<CommandItem[]>(() => {
    const go = (tab: NavTab) => () => {
      onNavigate(tab);
      onClose();
    };
    const setMode = (m: string) => () => {
      onChangeApprovalMode(m);
      onClose();
    };
    return [
      { id: "nav-overview", group: "Navigate", label: "Command Center", hint: "Control Plane", icon: LayoutDashboard, action: go("overview") },
      { id: "nav-monitor", group: "Navigate", label: "Live Monitor", hint: "Read-Only Spectator Group Chat", icon: Eye, action: go("monitor") },
      { id: "nav-workspaces", group: "Navigate", label: "Workspaces", hint: "Team Files & Checkpoints", icon: FolderTree, action: go("workspaces") },
      { id: "nav-canvas", group: "Navigate", label: "Brain Canvas", hint: "Visual Wiring", icon: Network, action: go("canvas") },
      { id: "nav-channels", group: "Navigate", label: "Channels", hint: "Telegram · WhatsApp · Discord", icon: Radio, action: go("channels") },
      { id: "nav-terminal", group: "Navigate", label: "Live Terminal", hint: "xterm PTY & Jobs", icon: Terminal, action: go("terminal") },
      { id: "nav-brains", group: "Navigate", label: "Brain Files", hint: "Vault & Upload", icon: FolderTree, action: go("brains") },
      { id: "nav-providers", group: "Navigate", label: "AI Providers", hint: "API Keys", icon: Cpu, action: go("providers") },
      { id: "nav-skills", group: "Navigate", label: "Skills & Memory", hint: "Skill Installer", icon: BookOpen, action: go("skills") },
      { id: "nav-automation", group: "Navigate", label: "Automation & MCP", hint: "Cron, Heartbeat, MCP", icon: Clock, action: go("automation") },
      { id: "nav-settings", group: "Navigate", label: "Settings & Security", hint: "Policies, Kits", icon: Settings, action: go("settings") },
      {
        id: "act-auto",
        group: "Approval Gate",
        label: "Switch to Auto (Full Freedom)",
        hint: approvalMode === "auto" ? "Active" : "No prompts",
        icon: Zap,
        action: setMode("auto"),
      },
      {
        id: "act-shell",
        group: "Approval Gate",
        label: "Switch to Approve Shell",
        hint: approvalMode === "approve_shell" ? "Active" : "Recommended",
        icon: Shield,
        action: setMode("approve_shell"),
      },
      {
        id: "act-sensitive",
        group: "Approval Gate",
        label: "Switch to Approve Sensitive",
        hint: approvalMode === "approve_sensitive" ? "Active" : "Shell, writes, HTTP, browser",
        icon: Shield,
        action: setMode("approve_sensitive"),
      },
    ];
  }, [approvalMode, onChangeApprovalMode, onClose, onNavigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.group.toLowerCase().includes(q) ||
        (it.hint || "").toLowerCase().includes(q)
    );
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    setIdx(0);
  }, [query]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === "Enter" && filtered[idx]) {
      e.preventDefault();
      filtered[idx].action();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px] flex items-start justify-center pt-[14vh] px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        onKeyDown={onKeyDown}
        className="w-full max-w-lg rounded-xl bg-[#111113] border border-white/[0.11] shadow-[0_24px_80px_rgba(0,0,0,0.75)] overflow-hidden"
      >
        <div className="flex items-center gap-2.5 px-3.5 h-12 border-b border-white/[0.07]">
          <Search className="w-4 h-4 text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to canvas, channels, agents, or security policy..."
            className="flex-1 bg-transparent text-[13px] text-zinc-100 placeholder-zinc-500 outline-none"
          />
          <kbd className="text-[10px] font-mono text-zinc-500 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-zinc-500">No matching commands</div>
          ) : (
            filtered.map((item, i) => {
              const Icon = item.icon;
              const active = i === idx;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setIdx(i)}
                  onClick={item.action}
                  className={`w-full px-3.5 py-2 flex items-center justify-between gap-3 text-left transition cursor-pointer ${
                    active ? "bg-white/[0.07] text-zinc-50" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon className={`w-4 h-4 shrink-0 ${active ? "text-amber-400" : "text-zinc-500"}`} />
                    <span className="text-[13px] font-medium truncate">{item.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {item.hint && <span className="text-[11px] font-mono text-zinc-500">{item.hint}</span>}
                    {active && <CornerDownLeft className="w-3.5 h-3.5 text-zinc-400" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="px-3.5 py-2 border-t border-white/[0.06] bg-[#0c0c0e] flex items-center justify-between text-[11px] text-zinc-500">
          <span>Pandawa Control Plane</span>
          <span className="font-mono">↑↓ navigate · ↵ select</span>
        </div>
      </div>
    </div>
  );
};

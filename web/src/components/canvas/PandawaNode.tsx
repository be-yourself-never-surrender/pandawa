import React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Brain, Users, Cpu, FileText, Folder, Wrench, Radio } from "lucide-react";

export interface PandawaNodeData extends Record<string, unknown> {
  nodeType: string;
  label: string;
  refId: string;
  subtitle?: string;
  avatar?: string;
  role?: string;
  model?: string;
  purpose?: string;
  folderPath?: string;
  path?: string;
  isFolder?: boolean;
  color?: string;
  packs?: string[];
  isActive?: boolean;
}

const STYLE_MAP: Record<
  string,
  { badge: string; border: string; glow: string; headerBg: string; accent: string }
> = {
  main_brain: {
    badge: "MAIN BRAIN",
    border: "border-amber-500/60",
    glow: "shadow-[0_0_24px_rgba(245,158,11,0.18)]",
    headerBg: "bg-amber-500/15",
    accent: "text-amber-300",
  },
  team_brain: {
    badge: "TEAM BRAIN",
    border: "border-violet-500/60",
    glow: "shadow-[0_0_24px_rgba(139,92,246,0.2)]",
    headerBg: "bg-violet-500/15",
    accent: "text-violet-300",
  },
  agent: {
    badge: "PANDAWA AGENT",
    border: "border-cyan-500/60",
    glow: "shadow-[0_0_22px_rgba(6,182,212,0.16)]",
    headerBg: "bg-cyan-500/12",
    accent: "text-cyan-300",
  },
  provider: {
    badge: "AI MODEL",
    border: "border-emerald-500/60",
    glow: "shadow-[0_0_20px_rgba(16,185,129,0.15)]",
    headerBg: "bg-emerald-500/12",
    accent: "text-emerald-300",
  },
  knowledge: {
    badge: "FILE / FOLDER",
    border: "border-yellow-500/50",
    glow: "shadow-[0_0_16px_rgba(234,179,8,0.12)]",
    headerBg: "bg-yellow-500/12",
    accent: "text-yellow-300",
  },
  toolpack: {
    badge: "TOOL PACK",
    border: "border-pink-500/50",
    glow: "shadow-[0_0_16px_rgba(236,72,153,0.12)]",
    headerBg: "bg-pink-500/12",
    accent: "text-pink-300",
  },
  channel: {
    badge: "CHANNEL",
    border: "border-sky-500/50",
    glow: "shadow-[0_0_16px_rgba(14,165,233,0.12)]",
    headerBg: "bg-sky-500/12",
    accent: "text-sky-300",
  },
};

export const PandawaNode: React.FC<NodeProps> = ({ data, selected }) => {
  const d = data as PandawaNodeData;
  const theme = STYLE_MAP[d.nodeType] || STYLE_MAP.knowledge;

  function renderIcon() {
    switch (d.nodeType) {
      case "main_brain":
        return <Brain className="w-4 h-4 text-amber-400" />;
      case "team_brain":
        return <Users className="w-4 h-4 text-violet-400" />;
      case "agent":
        return <span className="text-base leading-none">{d.avatar || "⚡"}</span>;
      case "provider":
        return <Cpu className="w-4 h-4 text-emerald-400" />;
      case "knowledge":
        return d.isFolder ? (
          <Folder className="w-4 h-4 text-yellow-400" />
        ) : (
          <FileText className="w-4 h-4 text-yellow-400" />
        );
      case "toolpack":
        return <Wrench className="w-4 h-4 text-pink-400" />;
      default:
        return <Radio className="w-4 h-4 text-sky-400" />;
    }
  }

  return (
    <div
      className={`w-[220px] rounded-xl bg-[#111623]/95 backdrop-blur-md border transition-all ${
        theme.border
      } ${theme.glow} ${selected ? "ring-2 ring-white/80 scale-[1.02]" : ""} ${
        d.isActive ? "ring-2 ring-emerald-400 shadow-[0_0_32px_rgba(16,185,129,0.55)] animate-pulse" : ""
      }`}
    >
      {/* Top Target Handle */}
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!w-3 !h-3 !bg-slate-200 !border-2 !border-[#0c0f18]"
      />
      {/* Left Handle for Peer & Knowledge Wiring */}
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!w-2.5 !h-2.5 !bg-amber-400 !border-2 !border-[#0c0f18]"
      />

      {/* Header */}
      <div className={`px-3 py-1.5 rounded-t-xl flex items-center justify-between gap-2 ${theme.headerBg} border-b border-slate-800/80`}>
        <div className="flex items-center gap-1.5 min-w-0">
          {renderIcon()}
          <span className={`text-[10px] font-bold tracking-wider uppercase truncate ${theme.accent}`}>
            {theme.badge}
          </span>
        </div>
        {d.isActive ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/25 text-emerald-300 border border-emerald-400/50 font-bold uppercase">
            LIVE
          </span>
        ) : d.purpose ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-900/70 text-slate-300 font-medium uppercase">
            {d.purpose}
          </span>
        ) : null}
      </div>

      {/* Body */}
      <div className="px-3 py-2.5">
        <div className="text-xs font-semibold text-white truncate">{d.label}</div>
        {(d.role || d.subtitle || d.folderPath || d.path || d.model) && (
          <div className="text-[11px] text-slate-400 truncate mt-0.5 font-mono">
            {d.role || d.model || d.folderPath || d.path || d.subtitle}
          </div>
        )}
        {Array.isArray(d.packs) && d.packs.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {d.packs.map((p) => (
              <span
                key={p}
                className="text-[9px] px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-300 border border-pink-500/25"
              >
                {p}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Right Handle for Peer Wiring */}
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!w-2.5 !h-2.5 !bg-cyan-400 !border-2 !border-[#0c0f18]"
      />
      {/* Bottom Source Handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!w-3 !h-3 !bg-slate-200 !border-2 !border-[#0c0f18]"
      />
    </div>
  );
};

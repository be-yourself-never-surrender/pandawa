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

const STYLE_MAP: Record<string, { badge: string; bar: string; iconColor: string }> = {
  main_brain: {
    badge: "MAIN BRAIN",
    bar: "bg-amber-400",
    iconColor: "text-amber-400",
  },
  team_brain: {
    badge: "TEAM BRAIN",
    bar: "bg-zinc-400",
    iconColor: "text-zinc-300",
  },
  agent: {
    badge: "AGENT",
    bar: "bg-zinc-100",
    iconColor: "text-zinc-100",
  },
  provider: {
    badge: "MODEL",
    bar: "bg-emerald-400/80",
    iconColor: "text-emerald-400",
  },
  knowledge: {
    badge: "KNOWLEDGE",
    bar: "bg-amber-300/70",
    iconColor: "text-amber-300/90",
  },
  toolpack: {
    badge: "TOOLPACK",
    bar: "bg-zinc-500",
    iconColor: "text-zinc-400",
  },
  channel: {
    badge: "CHANNEL",
    bar: "bg-zinc-500",
    iconColor: "text-zinc-400",
  },
};

export const PandawaNode: React.FC<NodeProps> = ({ data, selected }) => {
  const d = data as PandawaNodeData;
  const theme = STYLE_MAP[d.nodeType] || STYLE_MAP.knowledge;

  function renderIcon() {
    switch (d.nodeType) {
      case "main_brain":
        return <Brain className={`w-3.5 h-3.5 ${theme.iconColor}`} />;
      case "team_brain":
        return <Users className={`w-3.5 h-3.5 ${theme.iconColor}`} />;
      case "agent":
        return <span className="text-xs leading-none">{d.avatar || "P"}</span>;
      case "provider":
        return <Cpu className={`w-3.5 h-3.5 ${theme.iconColor}`} />;
      case "knowledge":
        return d.isFolder ? (
          <Folder className={`w-3.5 h-3.5 ${theme.iconColor}`} />
        ) : (
          <FileText className={`w-3.5 h-3.5 ${theme.iconColor}`} />
        );
      case "toolpack":
        return <Wrench className={`w-3.5 h-3.5 ${theme.iconColor}`} />;
      default:
        return <Radio className={`w-3.5 h-3.5 ${theme.iconColor}`} />;
    }
  }

  return (
    <div
      className={`w-[224px] rounded-lg bg-[#111113] border overflow-hidden transition-all shadow-[0_8px_24px_rgba(0,0,0,0.45)] ${
        d.isActive
          ? "border-emerald-400/70 ring-1 ring-emerald-400/40"
          : selected
          ? "border-zinc-300/60 ring-1 ring-white/25"
          : "border-white/[0.10] hover:border-white/[0.18]"
      }`}
    >
      {/* Crisp 2px Architectural Accent Bar */}
      <div className={`h-[2px] w-full ${d.isActive ? "bg-emerald-400" : theme.bar}`} />

      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!w-2.5 !h-2.5 !bg-zinc-300 !border-2 !border-[#09090b]"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!w-2 !h-2 !bg-amber-400 !border-2 !border-[#09090b]"
      />

      {/* Header */}
      <div className="px-3 py-1.5 flex items-center justify-between gap-2 border-b border-white/[0.06] bg-[#141417]">
        <div className="flex items-center gap-1.5 min-w-0">
          {renderIcon()}
          <span className="text-[10px] font-mono font-medium tracking-[0.06em] uppercase text-zinc-400 truncate">
            {theme.badge}
          </span>
        </div>
        {d.isActive ? (
          <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            live
          </span>
        ) : d.purpose ? (
          <span className="text-[9px] font-mono uppercase text-zinc-500">{d.purpose}</span>
        ) : null}
      </div>

      {/* Body */}
      <div className="px-3 py-2.5">
        <div className="text-[12.5px] font-medium text-zinc-100 truncate">{d.label}</div>
        {(d.role || d.subtitle || d.folderPath || d.path || d.model) && (
          <div className="text-[11px] text-zinc-500 truncate mt-0.5 font-mono">
            {d.role || d.model || d.folderPath || d.path || d.subtitle}
          </div>
        )}
        {Array.isArray(d.packs) && d.packs.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {d.packs.map((p) => (
              <span
                key={p}
                className="text-[9.5px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] text-zinc-400 border border-white/[0.07]"
              >
                {p}
              </span>
            ))}
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!w-2 !h-2 !bg-zinc-400 !border-2 !border-[#09090b]"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!w-2.5 !h-2.5 !bg-zinc-300 !border-2 !border-[#09090b]"
      />
    </div>
  );
};

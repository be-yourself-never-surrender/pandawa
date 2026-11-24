import React, { useState } from "react";
import { Package, X, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";

export interface PreviewBundleData {
  format: string;
  exportedAt?: string;
  bundleName?: string;
  description?: string;
  author?: string;
  warnings?: string[];
  team?: {
    name: string;
    description?: string;
    collaborationMode?: string;
    leadAgentSlug?: string;
    reviewerAgentSlug?: string;
    senderAgentSlug?: string;
  };
  brains?: Array<{ name: string; layer: string; folderPath: string }>;
  agents?: Array<{ name: string; title: string; avatar?: string; purpose?: string; model?: string }>;
  files?: Array<{ path: string; content: string }>;
  topology?: { nodes?: unknown[]; edges?: unknown[] };
}

interface BundlePreviewModalProps {
  bundle: PreviewBundleData | null;
  installing: boolean;
  onCancel: () => void;
  onConfirmInstall: () => void;
}

export const BundlePreviewModal: React.FC<BundlePreviewModalProps> = ({
  bundle,
  installing,
  onCancel,
  onConfirmInstall,
}) => {
  const [openFile, setOpenFile] = useState<string | null>(null);

  if (!bundle) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[86vh] rounded-xl bg-[#111113] border border-white/[0.11] shadow-[0_24px_80px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.07] flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#18181b] border border-white/[0.09] flex items-center justify-center shrink-0">
              <Package className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">
                {bundle.bundleName || bundle.team?.name || "Unnamed Brain Kit"}
              </h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                {bundle.description || bundle.team?.description || "Portable Pandawa Brain & Team template"}
              </p>
              <div className="text-[11px] text-zinc-500 mt-1.5 flex flex-wrap gap-3 font-mono">
                <span>format:{bundle.format}</span>
                {bundle.author && <span>by {bundle.author}</span>}
                <span className="text-emerald-400">zero-secrets</span>
              </div>
            </div>
          </div>
          <button
            aria-label="Close bundle preview"
            onClick={onCancel}
            className="p-1.5 rounded-md hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-200 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {Array.isArray(bundle.warnings) && bundle.warnings.length > 0 && (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 space-y-1">
              <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300">
                Bundle Warnings ({bundle.warnings.length})
              </div>
              {bundle.warnings.map((w, idx) => (
                <div key={idx} className="text-[11px]">
                  • {w}
                </div>
              ))}
            </div>
          )}

          {bundle.team && (bundle.team.leadAgentSlug || bundle.team.reviewerAgentSlug || bundle.team.senderAgentSlug) && (
            <div className="p-2.5 rounded-lg bg-[#09090b] border border-white/[0.07] text-[11px] font-mono text-zinc-300 flex flex-wrap gap-3">
              {bundle.team.leadAgentSlug && <span>Lead: <strong className="text-amber-300">{bundle.team.leadAgentSlug}</strong></span>}
              {bundle.team.reviewerAgentSlug && <span>QA: <strong className="text-cyan-300">{bundle.team.reviewerAgentSlug}</strong></span>}
              {bundle.team.senderAgentSlug && <span>Reply: <strong className="text-emerald-300">{bundle.team.senderAgentSlug}</strong></span>}
            </div>
          )}
          <div className="grid grid-cols-3 rounded-lg bg-[#09090b] border border-white/[0.07] divide-x divide-white/[0.06]">
            <div className="p-3">
              <div className="text-[11px] text-zinc-500">Brains</div>
              <div className="text-lg font-semibold text-zinc-100 mt-0.5 tabular-nums">
                {bundle.brains?.length || 0}
              </div>
            </div>
            <div className="p-3">
              <div className="text-[11px] text-zinc-500">Agents</div>
              <div className="text-lg font-semibold text-zinc-100 mt-0.5 tabular-nums">
                {bundle.agents?.length || 0}
              </div>
            </div>
            <div className="p-3">
              <div className="text-[11px] text-zinc-500">Files</div>
              <div className="text-lg font-semibold text-zinc-100 mt-0.5 tabular-nums">
                {bundle.files?.length || 0}
              </div>
            </div>
          </div>

          {(bundle.brains?.length || 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-zinc-500">
                Brains
              </div>
              <div className="flex flex-wrap gap-1.5">
                {bundle.brains!.map((b, i) => (
                  <span
                    key={i}
                    className="px-2.5 py-1 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-300 font-mono text-[11px]"
                  >
                    [{b.layer}] {b.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(bundle.agents?.length || 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-zinc-500">
                Specialists
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {bundle.agents!.map((a, i) => (
                  <div
                    key={i}
                    className="p-2.5 rounded-lg bg-[#09090b] border border-white/[0.07] flex items-center gap-2.5"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-zinc-200 truncate">{a.name}</div>
                      <div className="text-[11px] text-zinc-500 truncate font-mono">
                        {a.title} {a.model ? `· ${a.model}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(bundle.files?.length || 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-zinc-500">
                Bundled Files
              </div>
              <div className="rounded-lg border border-white/[0.07] divide-y divide-white/[0.06] overflow-hidden bg-[#09090b]">
                {bundle.files!.map((f) => {
                  const isOpen = openFile === f.path;
                  return (
                    <div key={f.path}>
                      <button
                        type="button"
                        onClick={() => setOpenFile(isOpen ? null : f.path)}
                        className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-white/[0.03] cursor-pointer"
                      >
                        <span className="font-mono text-zinc-300 flex items-center gap-1.5 truncate">
                          {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />}
                          {f.path}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-600 shrink-0 ml-2">
                          {f.content.length} chars
                        </span>
                      </button>
                      {isOpen && (
                        <pre className="px-3 pb-3 pt-2 text-[11px] font-mono text-zinc-400 whitespace-pre-wrap max-h-48 overflow-auto border-t border-white/[0.06]">
                          {f.content}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/[0.07] bg-[#0c0c0e] flex items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-500">
            Installs into an isolated folder and wires cleanly on Canvas.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3.5 rounded-md bg-[#18181b] hover:bg-[#222227] border border-white/[0.08] text-zinc-300 text-xs font-medium cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={installing}
              onClick={onConfirmInstall}
              className="h-8 px-4 rounded-md bg-zinc-100 hover:bg-white disabled:opacity-50 text-zinc-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {installing ? "Installing..." : "Install Kit"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

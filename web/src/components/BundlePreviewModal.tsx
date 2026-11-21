import React, { useState } from "react";
import { Package, Brain, Users, FileText, X, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";

export interface PreviewBundleData {
  format: string;
  exportedAt?: string;
  bundleName?: string;
  description?: string;
  author?: string;
  team?: { name: string; description?: string; collaborationMode?: string };
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
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[86vh] rounded-2xl bg-[#0e1320] border border-amber-500/40 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
              <Package className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">
                Preview Brain Kit: {bundle.bundleName || bundle.team?.name || "Unnamed Kit"}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {bundle.description || bundle.team?.description || "Portable Pandawa Brain & Team template"}
              </p>
              <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-3">
                <span>Format: <code className="text-amber-300">{bundle.format}</code></span>
                {bundle.author && <span>Author: <strong className="text-slate-300">{bundle.author}</strong></span>}
                <span>Safe Import: <strong className="text-emerald-400">Zero API Keys</strong></span>
              </div>
            </div>
          </div>
          <button
            aria-label="Close bundle preview"
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Summary counts */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-xl bg-[#090c14] border border-slate-800">
              <div className="text-slate-400 flex items-center gap-1.5">
                <Brain className="w-3.5 h-3.5 text-violet-400" /> Brains
              </div>
              <div className="text-lg font-bold text-white mt-0.5">{bundle.brains?.length || 0}</div>
            </div>
            <div className="p-3 rounded-xl bg-[#090c14] border border-slate-800">
              <div className="text-slate-400 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-cyan-400" /> Agents
              </div>
              <div className="text-lg font-bold text-white mt-0.5">{bundle.agents?.length || 0}</div>
            </div>
            <div className="p-3 rounded-xl bg-[#090c14] border border-slate-800">
              <div className="text-slate-400 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-amber-400" /> Brain Files
              </div>
              <div className="text-lg font-bold text-white mt-0.5">{bundle.files?.length || 0}</div>
            </div>
          </div>

          {/* Brains */}
          {(bundle.brains?.length || 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-violet-300">
                Included Brains
              </div>
              <div className="flex flex-wrap gap-2">
                {bundle.brains!.map((b, i) => (
                  <span
                    key={i}
                    className="px-2.5 py-1 rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-200"
                  >
                    [{b.layer.toUpperCase()}] {b.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Agents */}
          {(bundle.agents?.length || 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-cyan-300">
                Included Team Specialists
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {bundle.agents!.map((a, i) => (
                  <div key={i} className="p-2.5 rounded-xl bg-[#090c14] border border-slate-800 flex items-center gap-2.5">
                    <span className="text-base">{a.avatar || "⚡"}</span>
                    <div className="min-w-0">
                      <div className="font-semibold text-white truncate">{a.name}</div>
                      <div className="text-[11px] text-slate-400 truncate">
                        {a.title} {a.model ? `· ${a.model}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Expandable Brain Files Preview */}
          {(bundle.files?.length || 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                Inspect Bundled Files (click to preview)
              </div>
              <div className="space-y-1">
                {bundle.files!.map((f) => {
                  const isOpen = openFile === f.path;
                  return (
                    <div key={f.path} className="rounded-xl bg-[#090c14] border border-slate-800 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setOpenFile(isOpen ? null : f.path)}
                        className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-slate-800/40 cursor-pointer"
                      >
                        <span className="font-mono text-amber-300 flex items-center gap-1.5 truncate">
                          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          {f.path}
                        </span>
                        <span className="text-[10px] text-slate-500 shrink-0 ml-2">
                          {f.content.length} chars
                        </span>
                      </button>
                      {isOpen && (
                        <pre className="px-3 pb-3 pt-1 text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-48 overflow-auto border-t border-slate-800/70">
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
        <div className="px-5 py-3.5 border-t border-slate-800 bg-[#0b0f1a] flex items-center justify-between gap-2">
          <span className="text-[11px] text-slate-500">
            Installs into an isolated folder &amp; adds cleanly to your Brain Canvas.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={installing}
              onClick={onConfirmInstall}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 disabled:opacity-50 text-slate-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {installing ? "Installing..." : "Install Brain Kit"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

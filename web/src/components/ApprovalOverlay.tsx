import React, { useState } from "react";
import { ShieldAlert, Check, X, Zap, Terminal } from "lucide-react";
import { apiFetch } from "../api/client";

export interface PendingApprovalItem {
  id: string;
  agentId: string;
  agentName: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

interface ApprovalOverlayProps {
  approvals: PendingApprovalItem[];
  onResolved: (id: string) => void;
}

export const ApprovalOverlay: React.FC<ApprovalOverlayProps> = ({ approvals, onResolved }) => {
  const [busyId, setBusyId] = useState<string | null>(null);

  if (approvals.length === 0) return null;

  async function decide(id: string, approved: boolean, switchToAuto = false) {
    setBusyId(id);
    try {
      await apiFetch(`/api/approvals/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ approved, switchToAuto }),
      });
      onResolved(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 w-full max-w-md space-y-3">
      {approvals.map((item) => (
        <div
          key={item.id}
          className="rounded-2xl bg-[#101524]/95 backdrop-blur-xl border border-amber-500/60 shadow-[0_0_40px_rgba(245,158,11,0.22)] p-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <div className="text-xs font-bold text-amber-300 uppercase tracking-wider">
                  Approval Required
                </div>
                <div className="text-xs text-slate-300">
                  <strong>{item.agentName}</strong> wants to run{" "}
                  <code className="text-cyan-300">{item.toolName}</code>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-[#070a10] border border-slate-800 p-3 font-mono text-[11px] text-slate-200 max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {item.toolName === "shell_exec" && typeof item.args.command === "string" ? (
              <div className="flex items-start gap-2">
                <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span>{item.args.command}</span>
              </div>
            ) : (
              JSON.stringify(item.args, null, 2)
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              disabled={busyId === item.id}
              onClick={() => decide(item.id, true, false)}
              className="flex-1 py-2 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" /> Approve
            </button>
            <button
              disabled={busyId === item.id}
              onClick={() => decide(item.id, true, true)}
              title="Approve and switch Approval Mode to Auto (Full Freedom)"
              className="py-2 px-3 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 font-semibold text-xs flex items-center gap-1 cursor-pointer"
            >
              <Zap className="w-3.5 h-3.5" /> Auto All
            </button>
            <button
              disabled={busyId === item.id}
              onClick={() => decide(item.id, false, false)}
              className="py-2 px-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-300 font-semibold text-xs flex items-center gap-1 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" /> Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

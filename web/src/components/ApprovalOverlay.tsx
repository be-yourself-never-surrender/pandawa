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
    <div className="fixed bottom-5 right-5 z-50 w-full max-w-md space-y-2.5">
      {approvals.map((item) => (
        <div
          key={item.id}
          className="rounded-xl bg-[#111113] border border-amber-400/40 shadow-[0_20px_60px_rgba(0,0,0,0.75)] p-4 space-y-3"
        >
          <div className="flex items-start gap-2.5">
            <div className="w-7 h-7 rounded-md bg-amber-500/10 border border-amber-400/25 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-mono uppercase tracking-[0.06em] text-amber-300">
                Approval Required
              </div>
              <div className="text-xs text-zinc-300 mt-0.5">
                <strong className="text-zinc-100">{item.agentName}</strong> requested{" "}
                <code className="text-amber-300 bg-white/[0.04] px-1 py-0.5 rounded">{item.toolName}</code>
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-[#09090b] border border-white/[0.07] p-3 font-mono text-[11px] text-zinc-300 max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {item.toolName === "shell_exec" && typeof item.args.command === "string" ? (
              <div className="flex items-start gap-2">
                <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span>{item.args.command}</span>
              </div>
            ) : (
              JSON.stringify(item.args, null, 2)
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              disabled={busyId === item.id}
              onClick={() => decide(item.id, true, false)}
              className="flex-1 h-8 px-3 rounded-md bg-zinc-100 hover:bg-white disabled:opacity-40 text-zinc-950 font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition"
            >
              <Check className="w-3.5 h-3.5" /> Approve
            </button>
            <button
              disabled={busyId === item.id}
              onClick={() => decide(item.id, true, true)}
              title="Approve and switch Approval Mode to Auto (Full Freedom)"
              className="h-8 px-3 rounded-md bg-[#18181b] hover:bg-[#222227] border border-white/[0.09] text-amber-300 font-medium text-xs flex items-center gap-1 cursor-pointer transition"
            >
              <Zap className="w-3 h-3" /> Auto All
            </button>
            <button
              disabled={busyId === item.id}
              onClick={() => decide(item.id, false, false)}
              className="h-8 px-3 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-300 font-medium text-xs flex items-center gap-1 cursor-pointer transition"
            >
              <X className="w-3.5 h-3.5" /> Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

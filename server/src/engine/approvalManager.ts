import { generateId } from "../config.js";
import { getSetting, setSetting, logAudit } from "../db/database.js";

export type ApprovalMode = "auto" | "approve_shell" | "approve_sensitive" | "approve_all";

export interface PendingApproval {
  id: string;
  agentId: string;
  agentName: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

interface InternalApproval {
  record: PendingApproval;
  resolve: (decision: { approved: boolean; reason?: string }) => void;
  timer: NodeJS.Timeout;
}

const SETTING_KEY = "approval_mode";
const SENSITIVE_TOOLS = new Set(["shell_exec", "workspace_write", "brain_write"]);

const pendingMap = new Map<string, InternalApproval>();

export function getApprovalMode(): ApprovalMode {
  const val = getSetting(SETTING_KEY);
  if (val === "auto" || val === "approve_shell" || val === "approve_sensitive" || val === "approve_all") {
    return val;
  }
  return "approve_shell"; // Safe default: approve shell commands, full freedom otherwise (switchable to 'auto' in 1 click)
}

export function setApprovalMode(mode: ApprovalMode): void {
  setSetting(SETTING_KEY, mode);
  logAudit("admin", "approval.mode_change", "system", `Approval mode -> ${mode}`);
}

export function toolRequiresApproval(toolName: string): boolean {
  const mode = getApprovalMode();
  if (mode === "auto") return false;
  if (mode === "approve_all") return true;
  if (mode === "approve_shell") return toolName === "shell_exec";
  if (mode === "approve_sensitive") {
    return SENSITIVE_TOOLS.has(toolName) || toolName.startsWith("mcp__");
  }
  return false;
}

export function listPendingApprovals(): PendingApproval[] {
  return Array.from(pendingMap.values()).map((x) => x.record);
}

export function requestApproval(params: {
  agentId: string;
  agentName: string;
  toolName: string;
  args: Record<string, unknown>;
  onEvent?: (ev: Record<string, unknown>) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ approved: boolean; reason?: string }> {
  if (params.signal?.aborted) {
    return Promise.resolve({ approved: false, reason: "Mission aborted by user." });
  }
  const id = generateId("apr");
  const record: PendingApproval = {
    id,
    agentId: params.agentId,
    agentName: params.agentName,
    toolName: params.toolName,
    args: params.args,
    createdAt: new Date().toISOString(),
  };

  return new Promise((resolve) => {
    const onAbort = () => {
      if (!pendingMap.has(id)) return;
      clearTimeout(timer);
      pendingMap.delete(id);
      params.onEvent?.({ type: "approval_resolved", id, approved: false, reason: "Mission aborted" });
      resolve({ approved: false, reason: "Mission aborted by user." });
    };

    const timer = setTimeout(() => {
      params.signal?.removeEventListener("abort", onAbort);
      pendingMap.delete(id);
      params.onEvent?.({ type: "approval_resolved", id, approved: false, reason: "Timed out waiting for approval" });
      resolve({ approved: false, reason: "Approval request timed out (180s)." });
    }, params.timeoutMs ?? 180_000);

    params.signal?.addEventListener("abort", onAbort, { once: true });
    pendingMap.set(id, {
      record,
      resolve: (decision) => {
        params.signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      timer,
    });
    params.onEvent?.({ type: "approval_required", approval: record });
  });
}

export function resolveApproval(
  id: string,
  approved: boolean,
  options?: { switchToAuto?: boolean; reason?: string; broadcast?: (ev: Record<string, unknown>) => void }
): boolean {
  const entry = pendingMap.get(id);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pendingMap.delete(id);

  if (approved && options?.switchToAuto) {
    setApprovalMode("auto");
    // Also auto-approve any other queued approvals since user switched to Auto
    for (const [otherId, other] of pendingMap.entries()) {
      clearTimeout(other.timer);
      pendingMap.delete(otherId);
      other.resolve({ approved: true });
      options?.broadcast?.({ type: "approval_resolved", id: otherId, approved: true });
    }
  }

  logAudit(
    "admin",
    approved ? "approval.approve" : "approval.reject",
    entry.record.toolName,
    `${entry.record.agentName}: ${JSON.stringify(entry.record.args).slice(0, 200)}`
  );

  entry.resolve({ approved, reason: options?.reason });
  options?.broadcast?.({
    type: "approval_resolved",
    id,
    approved,
    mode: getApprovalMode(),
  });
  return true;
}

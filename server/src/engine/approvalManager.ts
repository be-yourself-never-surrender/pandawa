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
  sessionId?: string;
  channelId?: string;
  chatId?: string;
}

interface InternalApproval {
  record: PendingApproval;
  resolve: (decision: { approved: boolean; reason?: string }) => void;
  timer: NodeJS.Timeout;
}

const SETTING_KEY = "approval_mode";
const SHELL_TOOLS = new Set(["shell_exec", "term_exec", "term_send", "code_execute", "process_start"]);
const SENSITIVE_TOOLS = new Set([
  "shell_exec",
  "term_exec",
  "term_send",
  "code_execute",
  "process_start",
  "workspace_write",
  "workspace_patch",
  "brain_write",
  "http_request",
  "web_fetch",
  "browser_open",
  "browser_interact",
  "channel_notify",
]);

const pendingMap = new Map<string, InternalApproval>();
const sessionApprovalModes = new Map<string, ApprovalMode>();
const sessionRoutes = new Map<string, { channelId?: string; chatId?: string }>();
let _onApprovalRequestedHook: ((record: PendingApproval) => void) | undefined;

export function setApprovalRequestedHook(fn: (record: PendingApproval) => void): void {
  _onApprovalRequestedHook = fn;
}

export function registerSessionApprovalRoute(
  sessionId: string,
  route: { channelId?: string; chatId?: string }
): void {
  if (!sessionId) return;
  sessionRoutes.set(sessionId, { channelId: route.channelId, chatId: route.chatId });
}

export function clearSessionApprovalState(sessionId: string): void {
  if (!sessionId) return;
  sessionRoutes.delete(sessionId);
  sessionApprovalModes.delete(sessionId);
  for (const [id, entry] of pendingMap.entries()) {
    if (entry.record.sessionId === sessionId) {
      clearTimeout(entry.timer);
      pendingMap.delete(id);
      entry.resolve({ approved: false, reason: "Session ended." });
    }
  }
}

export function getApprovalMode(sessionId?: string): ApprovalMode {
  if (sessionId && sessionApprovalModes.has(sessionId)) {
    return sessionApprovalModes.get(sessionId)!;
  }
  const val = getSetting(SETTING_KEY);
  if (val === "auto" || val === "approve_shell" || val === "approve_sensitive" || val === "approve_all") {
    return val;
  }
  return "approve_shell"; // Safe default: approve shell commands, full freedom otherwise (switchable to 'auto' in 1 click)
}

export function setApprovalMode(mode: ApprovalMode, sessionId?: string): void {
  if (sessionId && sessionId !== "*") {
    sessionApprovalModes.set(sessionId, mode);
    logAudit("admin", "approval.mode_change", `session:${sessionId}`, `Approval mode -> ${mode}`);
    return;
  }
  setSetting(SETTING_KEY, mode);
  logAudit("admin", "approval.mode_change", "system", `Approval mode -> ${mode}`);
}

export function toolRequiresApproval(toolName: string, sessionId?: string): boolean {
  const mode = getApprovalMode(sessionId);
  if (mode === "auto") return false;
  if (mode === "approve_all") return true;
  if (mode === "approve_shell") return SHELL_TOOLS.has(toolName);
  if (mode === "approve_sensitive") {
    return SENSITIVE_TOOLS.has(toolName) || toolName.startsWith("mcp__");
  }
  return false;
}

export function listPendingApprovals(filter?: {
  sessionId?: string;
  channelId?: string;
  chatId?: string;
}): PendingApproval[] {
  const all = Array.from(pendingMap.values()).map((x) => x.record);
  if (!filter) return all;
  return all.filter((r) => {
    if (filter.sessionId !== undefined && r.sessionId !== filter.sessionId) return false;
    if (filter.channelId !== undefined && r.channelId !== filter.channelId) return false;
    if (filter.chatId !== undefined && r.chatId !== filter.chatId) return false;
    return true;
  });
}

export function requestApproval(params: {
  agentId: string;
  agentName: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
  channelId?: string;
  chatId?: string;
  onEvent?: (ev: Record<string, unknown>) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ approved: boolean; reason?: string }> {
  if (params.signal?.aborted) {
    return Promise.resolve({ approved: false, reason: "Mission aborted by user." });
  }
  const id = generateId("apr");
  const route = params.sessionId ? sessionRoutes.get(params.sessionId) : undefined;
  const record: PendingApproval = {
    id,
    agentId: params.agentId,
    agentName: params.agentName,
    toolName: params.toolName,
    args: params.args,
    createdAt: new Date().toISOString(),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...((params.channelId ?? route?.channelId) ? { channelId: params.channelId ?? route?.channelId } : {}),
    ...((params.chatId ?? route?.chatId) ? { chatId: params.chatId ?? route?.chatId } : {}),
  };

  return new Promise((resolve) => {
    const onAbort = () => {
      if (!pendingMap.has(id)) return;
      clearTimeout(timer);
      pendingMap.delete(id);
      params.onEvent?.({
        type: "approval_resolved",
        id,
        approved: false,
        reason: "Mission aborted",
        sessionId: record.sessionId,
      });
      resolve({ approved: false, reason: "Mission aborted by user." });
    };

    const timer = setTimeout(() => {
      params.signal?.removeEventListener("abort", onAbort);
      pendingMap.delete(id);
      params.onEvent?.({
        type: "approval_resolved",
        id,
        approved: false,
        reason: "Timed out waiting for approval",
        sessionId: record.sessionId,
      });
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
    try {
      _onApprovalRequestedHook?.(record);
    } catch {
      // ignore hook error
    }
  });
}

export function resolveApproval(
  id: string,
  approved: boolean,
  options?: {
    switchToAuto?: boolean;
    scopeGlobalAuto?: boolean;
    reason?: string;
    broadcast?: (ev: Record<string, unknown>) => void;
  }
): boolean {
  const entry = pendingMap.get(id);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pendingMap.delete(id);

  const originSessionId = entry.record.sessionId;

  if (approved && options?.switchToAuto) {
    if (options.scopeGlobalAuto === true) {
      setApprovalMode("auto");
      for (const [otherId, other] of pendingMap.entries()) {
        clearTimeout(other.timer);
        pendingMap.delete(otherId);
        other.resolve({ approved: true });
        options?.broadcast?.({
          type: "approval_resolved",
          id: otherId,
          approved: true,
          sessionId: other.record.sessionId,
          channelId: other.record.channelId,
          chatId: other.record.chatId,
        });
      }
    } else if (originSessionId) {
      // Scope /auto strictly to the originating session so concurrent sessions remain gated
      setApprovalMode("auto", originSessionId);
      for (const [otherId, other] of pendingMap.entries()) {
        if (other.record.sessionId === originSessionId) {
          clearTimeout(other.timer);
          pendingMap.delete(otherId);
          other.resolve({ approved: true });
          options?.broadcast?.({
            type: "approval_resolved",
            id: otherId,
            approved: true,
            sessionId: other.record.sessionId,
            channelId: other.record.channelId,
            chatId: other.record.chatId,
          });
        }
      }
    } else {
      // Legacy untagged approval: update global mode, but only auto-approve other untagged approvals
      setApprovalMode("auto");
      for (const [otherId, other] of pendingMap.entries()) {
        if (!other.record.sessionId) {
          clearTimeout(other.timer);
          pendingMap.delete(otherId);
          other.resolve({ approved: true });
          options?.broadcast?.({
            type: "approval_resolved",
            id: otherId,
            approved: true,
            channelId: other.record.channelId,
            chatId: other.record.chatId,
          });
        }
      }
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
    mode: getApprovalMode(originSessionId),
    sessionId: originSessionId,
    channelId: entry.record.channelId,
    chatId: entry.record.chatId,
  });
  return true;
}

export function approveLatest(options?: {
  sessionId?: string;
  channelId?: string;
  chatId?: string;
  switchToAuto?: boolean;
  scopeGlobalAuto?: boolean;
  reason?: string;
  broadcast?: (ev: Record<string, unknown>) => void;
}): { ok: boolean; id?: string; record?: PendingApproval } {
  const matches = listPendingApprovals({
    sessionId: options?.sessionId,
    channelId: options?.channelId,
    chatId: options?.chatId,
  });
  const target = matches[matches.length - 1];
  if (!target) return { ok: false };
  const ok = resolveApproval(target.id, true, options);
  return ok ? { ok: true, id: target.id, record: target } : { ok: false };
}

export function rejectLatest(options?: {
  sessionId?: string;
  channelId?: string;
  chatId?: string;
  reason?: string;
  broadcast?: (ev: Record<string, unknown>) => void;
}): { ok: boolean; id?: string; record?: PendingApproval } {
  const matches = listPendingApprovals({
    sessionId: options?.sessionId,
    channelId: options?.channelId,
    chatId: options?.chatId,
  });
  const target = matches[matches.length - 1];
  if (!target) return { ok: false };
  const ok = resolveApproval(target.id, false, options);
  return ok ? { ok: true, id: target.id, record: target } : { ok: false };
}

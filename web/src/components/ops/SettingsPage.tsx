import React, { useCallback, useEffect, useState } from "react";
import { Shield, Server, Activity, KeyRound, CheckCircle2 } from "lucide-react";
import { apiFetch, setStoredToken } from "../../api/client";

interface SystemStatus {
  version: string;
  uptimeSeconds: number;
  nodeVersion: string;
  platform: string;
  hostname: string;
  memory: { totalMb: number; freeMb: number; processRssMb: number };
  usingDefaultPassword: boolean;
  counts: {
    brains: number;
    agents: number;
    teams: number;
    providers: number;
    configuredProviders: number;
    sessions: number;
    memories: number;
    skills: number;
    cronJobs: number;
  };
  usage: { promptTokens: number; completionTokens: number; calls: number };
}

interface AuditItem {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  created_at: string;
}

export const SettingsPage: React.FC<{ onPasswordChanged: () => void }> = ({ onPasswordChanged }) => {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [audits, setAudits] = useState<AuditItem[]>([]);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [st, au] = await Promise.all([
      apiFetch<SystemStatus>("/api/system/status"),
      apiFetch<{ logs: AuditItem[] }>("/api/system/audit"),
    ]);
    setStatus(st);
    setAudits(au.logs);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (newPassword !== confirmPassword) {
      setPwMsg({ ok: false, text: "New password and confirmation do not match." });
      return;
    }
    try {
      const res = await apiFetch<{ ok: boolean; token: string }>("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.token) setStoredToken(res.token);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwMsg({ ok: true, text: "Password updated successfully!" });
      onPasswordChanged();
      await load();
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof Error ? err.message : "Failed to change password" });
    }
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#080a0f] p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Shield className="w-5 h-5 text-amber-400" /> Security, System & Audit
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Change your access password, monitor VPS resources, inspect token usage, and review system audit logs.
        </p>
      </div>

      {/* System Metrics */}
      {status && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800">
            <div className="text-[11px] text-slate-400 uppercase">Agents / Teams</div>
            <div className="text-2xl font-bold text-white mt-1">
              {status.counts.agents} <span className="text-sm text-slate-500">/ {status.counts.teams}</span>
            </div>
            <div className="text-[11px] text-amber-400 mt-1">{status.counts.brains} Active Brains</div>
          </div>
          <div className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800">
            <div className="text-[11px] text-slate-400 uppercase">Configured AI APIs</div>
            <div className="text-2xl font-bold text-emerald-400 mt-1">
              {status.counts.configuredProviders}{" "}
              <span className="text-sm text-slate-500">/ {status.counts.providers}</span>
            </div>
            <div className="text-[11px] text-slate-500 mt-1">{status.usage.calls} LLM calls logged</div>
          </div>
          <div className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800">
            <div className="text-[11px] text-slate-400 uppercase">Token Usage</div>
            <div className="text-2xl font-bold text-cyan-300 mt-1">
              {(status.usage.promptTokens + status.usage.completionTokens).toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              In: {status.usage.promptTokens.toLocaleString()} · Out: {status.usage.completionTokens.toLocaleString()}
            </div>
          </div>
          <div className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800">
            <div className="text-[11px] text-slate-400 uppercase">VPS Memory</div>
            <div className="text-2xl font-bold text-violet-300 mt-1">{status.memory.processRssMb} MB</div>
            <div className="text-[11px] text-slate-500 mt-1">
              Host Free: {status.memory.freeMb} / {status.memory.totalMb} MB
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Change Password */}
        <form
          onSubmit={handleChangePassword}
          className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 space-y-4 text-xs"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-amber-400" /> Change Admin Password
            </h2>
            {status?.usingDefaultPassword && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-semibold">
                Default (11111111)
              </span>
            )}
          </div>

          <div>
            <label className="text-slate-400 block mb-1">Current Password</label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Default is 11111111"
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-slate-400 block mb-1">New Password</label>
              <input
                type="password"
                required
                minLength={4}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 4 characters"
                className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              />
            </div>
            <div>
              <label className="text-slate-400 block mb-1">Confirm New Password</label>
              <input
                type="password"
                required
                minLength={4}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              />
            </div>
          </div>

          {pwMsg && (
            <div
              className={`px-3 py-2 rounded-lg border flex items-center gap-1.5 ${
                pwMsg.ok
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-rose-500/10 border-rose-500/30 text-rose-300"
              }`}
            >
              {pwMsg.ok && <CheckCircle2 className="w-3.5 h-3.5" />}
              {pwMsg.text}
            </div>
          )}

          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold cursor-pointer"
          >
            Update Password
          </button>

          {status && (
            <div className="pt-4 border-t border-slate-800 space-y-1 text-[11px] text-slate-500 font-mono">
              <div className="flex items-center gap-1.5 text-slate-400">
                <Server className="w-3.5 h-3.5" /> Host: {status.hostname} ({status.platform})
              </div>
              <div>
                Node {status.nodeVersion} · Pandawa v{status.version} · Uptime {status.uptimeSeconds}s
              </div>
            </div>
          )}
        </form>

        {/* Audit Log */}
        <div className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 flex flex-col max-h-[420px]">
          <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4 text-cyan-400" /> Recent Audit Log
          </h2>
          <div className="flex-1 overflow-y-auto space-y-1.5 text-xs">
            {audits.map((a) => (
              <div key={a.id} className="p-2.5 rounded-lg bg-[#090c14] border border-slate-800/80 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-amber-300">{a.action}</span>
                  {a.target && <span className="text-slate-400 ml-2">{a.target}</span>}
                  {a.detail && <div className="text-[11px] text-slate-500 truncate">{a.detail}</div>}
                </div>
                <span className="text-[10px] text-slate-600 font-mono shrink-0">{a.created_at}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

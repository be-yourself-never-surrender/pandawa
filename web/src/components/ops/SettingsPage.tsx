import React, { useCallback, useEffect, useState } from "react";
import { Shield, Server, Activity, KeyRound, CheckCircle2, Package, Download, Upload, Globe, Copy } from "lucide-react";
import { apiFetch, setStoredToken } from "../../api/client";
import type { TeamItem } from "../../types";

interface SystemStatus {
  version: string;
  approvalMode?: string;
  pendingApprovals?: number;
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
  const [approvalMode, setApprovalMode] = useState<string>("approve_shell");
  const [approvalNotice, setApprovalNotice] = useState<string>("");
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [exportTeamId, setExportTeamId] = useState<string>("");
  const [bundleNotice, setBundleNotice] = useState<string>("");
  const [customDomain, setCustomDomain] = useState<string>("pandawa.yourdomain.com");
  const [copiedCaddy, setCopiedCaddy] = useState<boolean>(false);

  const load = useCallback(async () => {
    const [st, au, tm] = await Promise.all([
      apiFetch<SystemStatus>("/api/system/status"),
      apiFetch<{ logs: AuditItem[] }>("/api/system/audit"),
      apiFetch<{ teams: TeamItem[] }>("/api/teams"),
    ]);
    setStatus(st);
    if (st.approvalMode) setApprovalMode(st.approvalMode);
    setAudits(au.logs);
    setTeams(tm.teams);
    if (tm.teams.length > 0 && !exportTeamId) setExportTeamId(tm.teams[0].id);
  }, [exportTeamId]);

  async function handleExportBundle() {
    const q = exportTeamId ? `?teamId=${encodeURIComponent(exportTeamId)}&includeMainBrain=true` : "?includeMainBrain=true";
    const bundle = await apiFetch<{ bundleName?: string }>(`/api/bundles/export${q}`);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(bundle.bundleName || "pandawa-brain-kit").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pandawa.json`;
    a.click();
    URL.revokeObjectURL(url);
    setBundleNotice("Exported sellable .pandawa.json kit (all API keys stripped)!");
    setTimeout(() => setBundleNotice(""), 3200);
  }

  async function handleImportBundle(file: File | null) {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const res = await apiFetch<{ teamName: string; importedFiles: number; importedAgents: number }>("/api/bundles/import", {
        method: "POST",
        body: JSON.stringify(json),
      });
      setBundleNotice(`Imported "${res.teamName}" (${res.importedAgents} agents, ${res.importedFiles} files)!`);
      setTimeout(() => setBundleNotice(""), 4000);
      await load();
    } catch (err) {
      setBundleNotice(`Import error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const caddySnippet = `cat << 'EOF' > /etc/caddy/sites.d/pandawa.caddy\n${customDomain.trim() || "pandawa.yourdomain.com"} {\n    reverse_proxy 127.0.0.1:7777\n}\nEOF\ncaddy reload --address unix//var/lib/caddy/admin.sock`;

  async function updateApprovalMode(next: string) {
    setApprovalMode(next);
    await apiFetch("/api/approvals/mode", {
      method: "PUT",
      body: JSON.stringify({ mode: next }),
    });
    setApprovalNotice(`Approval mode saved: ${next}`);
    setTimeout(() => setApprovalNotice(""), 2500);
    await load();
  }

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

      {/* Approval Gate Mode (Full Freedom, User-Controlled Approval Only) */}
      <div className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 space-y-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" /> Action Approval Control (Zero Hidden Guardrails)
            </h2>
            <p className="text-slate-400 mt-0.5">
              Pandawa imposes no content or command censorship. Choose when you want a live popup approval before tools execute.
            </p>
          </div>
          {approvalNotice && (
            <span className="text-emerald-400 flex items-center gap-1 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" /> {approvalNotice}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5">
          {[
            { id: "auto", title: "Auto (Full Freedom)", desc: "Run all tools & shell immediately with zero popups" },
            { id: "approve_shell", title: "Approve Shell Only", desc: "Ask approval before shell_exec; all other tools auto" },
            { id: "approve_sensitive", title: "Approve Sensitive", desc: "Ask approval for shell, file writes & MCP calls" },
            { id: "approve_all", title: "Approve All Tools", desc: "Ask approval before every single tool execution" },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => updateApprovalMode(opt.id)}
              className={`p-3 rounded-xl border text-left transition cursor-pointer ${
                approvalMode === opt.id
                  ? "bg-amber-500/15 border-amber-500/60 text-white"
                  : "bg-[#080a0f] border-slate-800 text-slate-400 hover:border-slate-700"
              }`}
            >
              <div className="font-semibold text-xs">{opt.title}</div>
              <div className="text-[11px] text-slate-400 mt-1">{opt.desc}</div>
            </button>
          ))}
        </div>
        <div className="text-[11px] text-emerald-400/90 flex items-center gap-1.5 pt-1">
          <CheckCircle2 className="w-3.5 h-3.5" /> Provider API keys are encrypted at rest with AES-256-GCM vault protection.
        </div>
      </div>

      {/* Commercial Brain Kit Export/Import + Auto-HTTPS Domain Setup */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 space-y-3 text-xs">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Package className="w-4 h-4 text-amber-400" /> Commercial Brain Kit Export &amp; Import
          </h2>
          <p className="text-slate-400">
            Package any Team + Main/Team Brains + <code className="text-amber-300">soul.md</code>/skills + Canvas wiring into a portable{" "}
            <code className="text-cyan-300">.pandawa.json</code> template ready to sell or share. API keys are never included.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={exportTeamId}
              onChange={(e) => setExportTeamId(e.target.value)}
              className="flex-1 min-w-[180px] bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.members.length} agents)
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleExportBundle}
              className="px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" /> Export Kit
            </button>
            <label className="px-3.5 py-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 font-semibold flex items-center gap-1.5 cursor-pointer">
              <Upload className="w-3.5 h-3.5" /> Import Kit
              <input
                type="file"
                accept=".json,.pandawa.json"
                className="hidden"
                onChange={(e) => {
                  handleImportBundle(e.target.files?.[0] || null);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {bundleNotice && <div className="text-emerald-400 font-medium">{bundleNotice}</div>}
        </div>

        <div className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 space-y-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Globe className="w-4 h-4 text-cyan-400" /> Custom Domain &amp; Auto-HTTPS (Caddy)
            </h2>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(caddySnippet).catch(() => {});
                setCopiedCaddy(true);
                setTimeout(() => setCopiedCaddy(false), 2000);
              }}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 cursor-pointer"
            >
              <Copy className="w-3 h-3" /> {copiedCaddy ? "Copied!" : "Copy Command"}
            </button>
          </div>
          <p className="text-slate-400">
            Point your domain A-record to this VPS IP, enter the domain below, and run the generated Caddy command for automatic Let&apos;s Encrypt HTTPS + WebSocket support:
          </p>
          <input
            value={customDomain}
            onChange={(e) => setCustomDomain(e.target.value)}
            placeholder="pandawa.yourdomain.com"
            className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
          />
          <pre className="p-3 rounded-xl bg-[#070a10] border border-slate-800 font-mono text-[11px] text-emerald-300 overflow-x-auto whitespace-pre-wrap">
            {caddySnippet}
          </pre>
        </div>
      </div>

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

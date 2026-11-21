import React, { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  ArrowUpRight,
  Network,
  MessageSquare,
  Shield,
  Zap,
  Trash2,
  Plus,
  Terminal,
  ChevronRight,
} from "lucide-react";
import { apiFetch } from "../api/client";
import type { NavTab, ProviderItem, TeamItem } from "../types";

interface OverviewPageProps {
  approvalMode: string;
  onChangeApprovalMode: (mode: string) => void;
  onNavigate: (tab: NavTab) => void;
  onStartMission: (teamId: string, starterPrompt?: string) => void;
  onFocusTeamOnCanvas: (teamId: string) => void;
}

interface SystemSummary {
  version: string;
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

const STARTER_MISSIONS = [
  {
    title: "Architecture & Security Review",
    prompt:
      "Design a scalable SaaS backend architecture for a multi-tenant AI platform. Have Arjuna draft the core API schema, Bima outline VPS deployment, and Sadewa audit security risks before Yudhistira summarizes our final plan.",
    tag: "Engineering",
  },
  {
    title: "Live Web Research Briefing",
    prompt:
      "Use web_search to research the top open-source AI agent frameworks in 2026, compare strengths and gaps, and produce a concise executive positioning memo for Pandawa.",
    tag: "Research",
  },
  {
    title: "Audit & Upgrade Main Brain",
    prompt:
      "Read @main-brain/soul.md and @main-brain/rules.md, then propose concrete improvements to make our Pandawa team faster, sharper, and more autonomous.",
    tag: "Brain Ops",
  },
  {
    title: "Author Reusable Deployment Skill",
    prompt:
      "Collaborate to design a production deployment verification checklist and save it as a reusable SKILL.md inside our Team Brain using learn_skill.",
    tag: "Skill",
  },
];

const APPROVAL_OPTIONS = [
  { id: "auto", label: "Auto" },
  { id: "approve_shell", label: "Shell" },
  { id: "approve_sensitive", label: "Sensitive" },
  { id: "approve_all", label: "All" },
];

export const OverviewPage: React.FC<OverviewPageProps> = ({
  approvalMode,
  onChangeApprovalMode,
  onNavigate,
  onStartMission,
  onFocusTeamOnCanvas,
}) => {
  const [status, setStatus] = useState<SystemSummary | null>(null);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [toolCount, setToolCount] = useState<number>(46);
  const [spawning, setSpawning] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [runtime, setRuntime] = useState<{
    tmuxAvailable?: boolean;
    activeTerminals?: number;
    runningJobs?: number;
    pythonWorker?: { ok?: boolean; python?: string; capabilities?: Record<string, boolean> };
    semanticMemory?: { totalChunks?: number; mode?: string };
    heartbeat?: { enabled?: boolean; intervalMinutes?: number; lastStatus?: string };
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const [st, tm, pv, tl, rt] = await Promise.all([
        apiFetch<SystemSummary>("/api/system/status"),
        apiFetch<{ teams: TeamItem[] }>("/api/teams"),
        apiFetch<{ providers: ProviderItem[] }>("/api/providers"),
        apiFetch<{ packs: Array<{ tools: unknown[] }> }>("/api/tools"),
        apiFetch<{
          tmuxAvailable?: boolean;
          activeTerminals?: number;
          runningJobs?: number;
          pythonWorker?: { ok?: boolean; python?: string; capabilities?: Record<string, boolean> };
          semanticMemory?: { totalChunks?: number; mode?: string };
          heartbeat?: { enabled?: boolean; intervalMinutes?: number; lastStatus?: string };
        }>("/api/system/runtime").catch(() => null),
      ]);
      setStatus(st);
      setTeams(tm.teams);
      setProviders(pv.providers);
      setToolCount(tl.packs.reduce((acc, p) => acc + p.tools.length, 0));
      if (rt) setRuntime(rt);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const hasCloudProvider = providers.some(
    (p) => p.hasApiKey && !p.baseUrl.includes("127.0.0.1") && !p.baseUrl.includes("localhost")
  );
  const hasRunMission = (status?.counts.sessions || 0) > 0;
  const completedSteps = (hasCloudProvider ? 1 : 0) + 1 + (hasRunMission ? 1 : 0);

  async function spawnKit(tpl: string) {
    setSpawning(tpl);
    try {
      await apiFetch("/api/templates/apply", {
        method: "POST",
        body: JSON.stringify({ template: tpl }),
      });
      await load();
    } finally {
      setSpawning("");
    }
  }

  async function deleteTeam(team: TeamItem) {
    if (!window.confirm(`Delete "${team.name}" along with its Team Brain and squad agents?`)) return;
    await apiFetch(`/api/teams/${team.id}?cascade=true`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#09090b]">
      {/* Slim Top Command Bar */}
      <header className="sticky top-0 z-20 bg-[#09090b]/90 backdrop-blur-md border-b border-white/[0.06] px-6 h-13 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-[14px] font-semibold tracking-[-0.015em] text-zinc-100 truncate">
            Command Center
          </h1>
          <span className="text-[11px] font-mono text-zinc-500 hidden sm:inline">
            Pandawa OS v{status?.version || "7.0.0"}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onNavigate("terminal")}
            className="h-8 px-3 rounded-md bg-[#111113] hover:bg-[#18181b] border border-white/[0.08] text-zinc-300 text-xs font-medium inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <Terminal className="w-3.5 h-3.5 text-zinc-400" /> Terminal
          </button>
          <button
            onClick={() => onNavigate("canvas")}
            className="h-8 px-3 rounded-md bg-[#111113] hover:bg-[#18181b] border border-white/[0.08] text-zinc-300 text-xs font-medium inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <Network className="w-3.5 h-3.5 text-zinc-400" /> Canvas
          </button>
          <button
            onClick={() => onStartMission(teams[0]?.id || "team_pandawa")}
            className="h-8 px-3.5 rounded-md bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <MessageSquare className="w-3.5 h-3.5" /> New Mission
          </button>
        </div>
      </header>

      <div className="max-w-[1240px] mx-auto px-6 py-6 space-y-6">
        {/* Quiet Live Runtime Telemetry Strip */}
        {runtime && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-zinc-400 font-mono">
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${runtime.tmuxAvailable ? "bg-emerald-400" : "bg-zinc-600"}`} />
              PTY {runtime.tmuxAvailable ? `${runtime.activeTerminals || 0} live` : "off"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${runtime.pythonWorker?.ok ? "bg-emerald-400" : "bg-zinc-600"}`} />
              Python {runtime.pythonWorker?.python || "3.x"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  runtime.pythonWorker?.capabilities?.playwright ? "bg-emerald-400" : "bg-zinc-600"
                }`}
              />
              Playwright {runtime.pythonWorker?.capabilities?.playwright ? "ready" : "standby"}
            </span>
            <span className="text-zinc-500">
              Semantic {runtime.semanticMemory?.totalChunks || 0} chunks
            </span>
            <span className="text-zinc-500">
              Heartbeat {runtime.heartbeat?.enabled ? `${runtime.heartbeat.intervalMinutes}m` : "standby"}
            </span>
          </div>
        )}

        {/* Unified 4-Cell Metric Bar (Hairline Divided, Zero Bubbly Boxes) */}
        {loading && !status ? (
          <div className="grid grid-cols-2 md:grid-cols-4 rounded-xl bg-[#111113] border border-white/[0.07] divide-y md:divide-y-0 md:divide-x divide-white/[0.06]">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="p-4 animate-pulse space-y-2">
                <div className="h-3 w-20 rounded bg-zinc-800" />
                <div className="h-6 w-24 rounded bg-zinc-800/70" />
              </div>
            ))}
          </div>
        ) : (
          status && (
            <div className="grid grid-cols-2 md:grid-cols-4 rounded-xl bg-[#111113] border border-white/[0.08] divide-y md:divide-y-0 md:divide-x divide-white/[0.06]">
              <div className="px-5 py-4">
                <div className="text-[11px] font-medium text-zinc-500">Teams &amp; Agents</div>
                <div className="mt-1.5 flex items-baseline gap-2 tabular-nums">
                  <span className="text-2xl font-semibold tracking-[-0.03em] text-zinc-100">
                    {status.counts.teams}
                  </span>
                  <span className="text-xs text-zinc-500">
                    teams · {status.counts.agents} agents
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onNavigate("providers")}
                className="px-5 py-4 text-left hover:bg-white/[0.02] transition cursor-pointer"
              >
                <div className="text-[11px] font-medium text-zinc-500 flex items-center justify-between">
                  <span>Configured Providers</span>
                  <ArrowUpRight className="w-3 h-3 text-zinc-600" />
                </div>
                <div className="mt-1.5 flex items-baseline gap-2 tabular-nums">
                  <span
                    className={`text-2xl font-semibold tracking-[-0.03em] ${
                      status.counts.configuredProviders > 0 ? "text-zinc-100" : "text-amber-400"
                    }`}
                  >
                    {status.counts.configuredProviders}
                  </span>
                  <span className="text-xs text-zinc-500">/ {status.counts.providers} available</span>
                </div>
              </button>

              <div className="px-5 py-4">
                <div className="text-[11px] font-medium text-zinc-500">Tool Arsenal</div>
                <div className="mt-1.5 flex items-baseline gap-2 tabular-nums">
                  <span className="text-2xl font-semibold tracking-[-0.03em] text-zinc-100">
                    {toolCount}
                  </span>
                  <span className="text-xs text-zinc-500">built-in + MCP</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onNavigate("skills")}
                className="px-5 py-4 text-left hover:bg-white/[0.02] transition cursor-pointer"
              >
                <div className="text-[11px] font-medium text-zinc-500 flex items-center justify-between">
                  <span>Brains &amp; Skills</span>
                  <ArrowUpRight className="w-3 h-3 text-zinc-600" />
                </div>
                <div className="mt-1.5 flex items-baseline gap-2 tabular-nums">
                  <span className="text-2xl font-semibold tracking-[-0.03em] text-zinc-100">
                    {status.counts.brains}
                  </span>
                  <span className="text-xs text-zinc-500">
                    brains · {status.counts.skills} skills
                  </span>
                </div>
              </button>
            </div>
          )
        )}

        {/* Asymmetric Operational Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Primary Column (8 cols): Teams + Starter Missions */}
          <div className="lg:col-span-8 space-y-6">
            {/* Teams Section */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-zinc-200">
                  Agentic Teams
                </h2>
                <div className="flex flex-wrap items-center gap-1.5">
                  {[
                    { id: "software-squad", label: "Software" },
                    { id: "growth-squad", label: "Growth" },
                    { id: "research-squad", label: "Research" },
                  ].map((kit) => (
                    <button
                      key={kit.id}
                      disabled={Boolean(spawning)}
                      onClick={() => spawnKit(kit.id)}
                      className="h-7 px-2.5 rounded-md bg-[#111113] hover:bg-[#1a1a1e] border border-white/[0.08] text-[11px] text-zinc-300 font-medium inline-flex items-center gap-1 transition cursor-pointer disabled:opacity-40"
                    >
                      <Plus className="w-3 h-3 text-zinc-500" />
                      {spawning === kit.id ? "Creating..." : kit.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl bg-[#111113] border border-white/[0.08] divide-y divide-white/[0.06] overflow-hidden">
                {loading && teams.length === 0 && (
                  <div className="p-5 animate-pulse space-y-2.5">
                    <div className="h-4 w-40 rounded bg-zinc-800" />
                    <div className="h-3 w-72 rounded bg-zinc-800/70" />
                  </div>
                )}

                {teams.map((t) => (
                  <div
                    key={t.id}
                    className="p-4 hover:bg-white/[0.015] transition space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-[13px] font-semibold text-zinc-100 truncate">{t.name}</h3>
                          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.07] text-zinc-400">
                            {t.collaboration_mode}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{t.description}</p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => onFocusTeamOnCanvas(t.id)}
                          className="h-7 px-2.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.07] text-zinc-300 text-[11px] font-medium inline-flex items-center gap-1.5 transition cursor-pointer"
                        >
                          <Network className="w-3 h-3 text-zinc-400" /> Canvas
                        </button>
                        <button
                          onClick={() => onStartMission(t.id)}
                          className="h-7 px-2.5 rounded-md bg-zinc-100 hover:bg-white text-zinc-950 text-[11px] font-semibold inline-flex items-center gap-1.5 transition cursor-pointer"
                        >
                          <MessageSquare className="w-3 h-3" /> Launch
                        </button>
                        {t.id !== "team_pandawa" && (
                          <button
                            aria-label={`Delete team ${t.name}`}
                            onClick={() => deleteTeam(t)}
                            className="h-7 w-7 rounded-md text-zinc-600 hover:text-rose-400 hover:bg-rose-500/10 inline-flex items-center justify-center transition cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {t.members.map((m) => (
                        <span
                          key={m.id}
                          className="text-[11px] px-2 py-0.5 rounded-md bg-[#09090b] border border-white/[0.06] text-zinc-300 inline-flex items-center gap-1.5"
                        >
                          <span className="font-medium text-zinc-200">{m.name}</span>
                          <span className="text-[10px] text-zinc-500 font-mono">{m.model || m.purpose}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Starter Missions — Crisp Linear List Rows */}
            <section className="space-y-3">
              <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-zinc-200">
                Quick-Launch Missions
              </h2>
              <div className="rounded-xl bg-[#111113] border border-white/[0.08] divide-y divide-white/[0.06] overflow-hidden">
                {STARTER_MISSIONS.map((m) => (
                  <button
                    key={m.title}
                    onClick={() => onStartMission(teams[0]?.id || "team_pandawa", m.prompt)}
                    className="w-full px-4 py-3 hover:bg-white/[0.025] text-left flex items-center justify-between gap-4 group transition cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-zinc-200 group-hover:text-white transition">
                          {m.title}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-500 px-1.5 py-0.5 rounded bg-white/[0.04]">
                          {m.tag}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{m.prompt}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-zinc-300 group-hover:translate-x-0.5 transition shrink-0" />
                  </button>
                ))}
              </div>
            </section>
          </div>

          {/* Right Rail (4 cols): Onboarding Checklist + Approval Policy */}
          <div className="lg:col-span-4 space-y-5">
            {/* Compact Setup Checklist */}
            <section className="rounded-xl bg-[#111113] border border-white/[0.08] overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
                <h2 className="text-xs font-semibold text-zinc-200">Workspace Setup</h2>
                <span className="text-[11px] font-mono text-zinc-500 tabular-nums">{completedSteps}/3</span>
              </div>
              <div className="divide-y divide-white/[0.06]">
                <button
                  onClick={() => onNavigate("providers")}
                  className="w-full px-4 py-3 text-left hover:bg-white/[0.02] flex items-start gap-3 transition cursor-pointer"
                >
                  {hasCloudProvider ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <Circle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-zinc-200">Connect an AI provider</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      Add an API key in AI Providers to run live teams.
                    </div>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-zinc-600 shrink-0 mt-0.5" />
                </button>

                <button
                  onClick={() => onNavigate("brains")}
                  className="w-full px-4 py-3 text-left hover:bg-white/[0.02] flex items-start gap-3 transition cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-zinc-200">Customize Brain Vault</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      Edit <code className="text-zinc-400">soul.md</code>, import folders, or install skills.
                    </div>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-zinc-600 shrink-0 mt-0.5" />
                </button>

                <button
                  onClick={() => onStartMission(teams[0]?.id || "team_pandawa")}
                  className="w-full px-4 py-3 text-left hover:bg-white/[0.02] flex items-start gap-3 transition cursor-pointer"
                >
                  {hasRunMission ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <Circle className="w-4 h-4 text-zinc-600 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-zinc-200">Run your first mission</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      Execute multi-agent tasks with programmatic checks.
                    </div>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-zinc-600 shrink-0 mt-0.5" />
                </button>
              </div>
            </section>

            {/* Approval Gate Segmented Control */}
            <section className="rounded-xl bg-[#111113] border border-white/[0.08] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  {approvalMode === "auto" ? (
                    <Zap className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Shield className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  Approval Gate
                </div>
                <span className="text-[10px] font-mono text-zinc-500">Zero hidden censorship</span>
              </div>

              <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-[#09090b] border border-white/[0.06]">
                {APPROVAL_OPTIONS.map((opt) => {
                  const active = approvalMode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => onChangeApprovalMode(opt.id)}
                      className={`h-7 rounded-md text-[11px] font-medium transition cursor-pointer ${
                        active
                          ? "bg-white/[0.10] text-zinc-100"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <p className="text-[11px] text-zinc-500 leading-relaxed">
                {approvalMode === "auto" && "Full autonomy: agents execute shell, workspace, and browser tools without pausing."}
                {approvalMode === "approve_shell" && "Recommended: asks your confirmation before running terminal or shell commands."}
                {approvalMode === "approve_sensitive" && "Gates shell, file writes, outbound HTTP, Playwright browser, and MCP tools."}
                {approvalMode === "approve_all" && "Strict step-by-step confirmation before every tool invocation."}
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};

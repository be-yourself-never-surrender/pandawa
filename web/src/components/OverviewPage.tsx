import React, { useCallback, useEffect, useState } from "react";
import {
  Sparkles,
  CheckCircle2,
  Circle,
  ArrowRight,
  Network,
  MessageSquare,
  Cpu,
  FolderTree,
  Users,
  Wrench,
  Shield,
  Zap,
  Rocket,
  Trash2,
  Plus,
  Terminal,
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
    title: "Audit & Upgrade Our Main Brain",
    prompt:
      "Read @main-brain/soul.md and @main-brain/rules.md, then propose concrete improvements to make our Pandawa team faster, sharper, and more autonomous.",
    tag: "Brain Ops",
  },
  {
    title: "Create a Reusable Team Skill",
    prompt:
      "Collaborate to design a production deployment verification checklist and save it as a reusable SKILL.md inside our Team Brain using learn_skill.",
    tag: "Self-Learning",
  },
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
    <div className="h-screen overflow-y-auto bg-[#080a0f] p-6 space-y-6">
      {/* Hero Welcome Banner */}
      <div className="rounded-2xl bg-gradient-to-br from-[#121829] via-[#0e1320] to-[#131020] border border-amber-500/30 p-6 flex flex-wrap items-center justify-between gap-4 relative overflow-hidden">
        <div className="pointer-events-none absolute -top-20 -right-20 w-72 h-72 rounded-full bg-amber-500/10 blur-3xl" />
        <div className="space-y-1.5 relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/35 text-[11px] font-semibold text-amber-300">
            <Sparkles className="w-3 h-3" /> Pandawa Living OS v{status?.version || "7.0.0"}
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Command Center — Living Agentic OS &amp; Brain HQ
          </h1>
          <p className="text-xs text-slate-400 leading-relaxed">
            Hybrid <strong>TypeScript + Python</strong> Agentic OS: visual <strong>[[wikilink]] Layered Brains</strong>,
            multi-model teams with <strong>35–100 step Execute &amp; Verify loops</strong>, persistent shared{" "}
            <strong>tmux terminals</strong>, Playwright vision, and <strong>{toolCount}+ power tools</strong> with zero hidden guardrails.
          </p>
          {runtime && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[10px]">
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                xterm PTY: {runtime.tmuxAvailable ? `${runtime.activeTerminals || 0} live` : "off"}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-300">
                Python: {runtime.pythonWorker?.python || "3.x"}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/30 text-violet-300">
                Playwright: {runtime.pythonWorker?.capabilities?.playwright ? "Ready" : "Standby"}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-fuchsia-500/15 border border-fuchsia-500/30 text-fuchsia-300">
                Semantic Index: {runtime.semanticMemory?.totalChunks || 0} chunks
              </span>
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300">
                Heartbeat: {runtime.heartbeat?.enabled ? `Every ${runtime.heartbeat.intervalMinutes}m` : "Ready"}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 relative z-10">
          <button
            onClick={() => onNavigate("terminal")}
            className="px-3.5 py-2.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
          >
            <Terminal className="w-4 h-4" /> Live Terminal
          </button>
          <button
            onClick={() => onNavigate("canvas")}
            className="px-3.5 py-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 border border-slate-700 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
          >
            <Network className="w-4 h-4 text-amber-400" /> Brain Canvas
          </button>
          <button
            onClick={() => onStartMission(teams[0]?.id || "team_pandawa")}
            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-amber-500/20 cursor-pointer"
          >
            <MessageSquare className="w-4 h-4" /> Launch Mission
          </button>
        </div>
      </div>

      {/* Interactive 3-Step Quick Start Guide */}
      <div className="rounded-2xl bg-[#0e1320] border border-slate-800 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Rocket className="w-4 h-4 text-amber-400" /> Quick-Start Checklist ({completedSteps}/3 Ready)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Follow these 3 simple steps to run your first live Multi-AI Agentic Team mission.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400">Approval Gate:</span>
            <button
              onClick={() => onChangeApprovalMode(approvalMode === "auto" ? "approve_shell" : "auto")}
              className={`px-3 py-1.5 rounded-lg border font-semibold flex items-center gap-1.5 cursor-pointer transition ${
                approvalMode === "auto"
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                  : "bg-amber-500/15 border-amber-500/40 text-amber-300"
              }`}
            >
              {approvalMode === "auto" ? <Zap className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5" />}
              {approvalMode === "auto" ? "Auto (Full Freedom)" : `Gate: ${approvalMode.replace("_", " ")}`}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <button
            onClick={() => onNavigate("providers")}
            className={`p-4 rounded-xl border text-left transition cursor-pointer flex flex-col justify-between gap-3 ${
              hasCloudProvider
                ? "bg-emerald-500/5 border-emerald-500/30 hover:border-emerald-400/60"
                : "bg-amber-500/10 border-amber-500/50 hover:bg-amber-500/15"
            }`}
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-white flex items-center gap-1.5 min-w-0">
                  {hasCloudProvider ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <Circle className="w-4 h-4 text-amber-400 shrink-0" />
                  )}
                  <span className="truncate">1. Connect AI Provider(s)</span>
                </span>
                <Cpu className="w-4 h-4 text-emerald-400 shrink-0" />
              </div>
              <p className="text-slate-400 leading-relaxed">
                Paste 1 or more API keys (OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, or Custom Base URL) right inside Multi-AI Hub.
              </p>
            </div>
            <span className="text-amber-300 font-semibold flex items-center gap-1">
              {hasCloudProvider ? "Manage Providers" : "Add API Key Now"} <ArrowRight className="w-3.5 h-3.5" />
            </span>
          </button>

          <button
            onClick={() => onNavigate("brains")}
            className="p-4 rounded-xl bg-[#090c14] border border-slate-800 hover:border-violet-500/50 text-left transition cursor-pointer flex flex-col justify-between gap-3"
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-white flex items-center gap-1.5 min-w-0">
                  <CheckCircle2 className="w-4 h-4 text-violet-400 shrink-0" />
                  <span className="truncate">2. Shape Brains &amp; soul.md</span>
                </span>
                <FolderTree className="w-4 h-4 text-violet-400 shrink-0" />
              </div>
              <p className="text-slate-400 leading-relaxed">
                Edit <code>main-brain/soul.md</code>, upload SOP docs, or drag wires on Brain Canvas to control what each AI model knows.
              </p>
            </div>
            <span className="text-violet-300 font-semibold flex items-center gap-1">
              Open Brain Files <ArrowRight className="w-3.5 h-3.5" />
            </span>
          </button>

          <button
            onClick={() => onStartMission(teams[0]?.id || "team_pandawa")}
            className="p-4 rounded-xl bg-[#090c14] border border-slate-800 hover:border-cyan-500/50 text-left transition cursor-pointer flex flex-col justify-between gap-3"
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-white flex items-center gap-1.5 min-w-0">
                  {hasRunMission ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <Circle className="w-4 h-4 text-cyan-400 shrink-0" />
                  )}
                  <span className="truncate">3. Run a Team Mission</span>
                </span>
                <MessageSquare className="w-4 h-4 text-cyan-400 shrink-0" />
              </div>
              <p className="text-slate-400 leading-relaxed">
                Watch peer specialists deliberate in parallel, consult each other live, execute tools, and converge on unified consensus.
              </p>
            </div>
            <span className="text-cyan-300 font-semibold flex items-center gap-1">
              Open Mission Room <ArrowRight className="w-3.5 h-3.5" />
            </span>
          </button>
        </div>
      </div>

      {/* KPI Metrics Row */}
      {loading && !status ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800 animate-pulse space-y-2">
              <div className="h-3 w-24 rounded bg-slate-800" />
              <div className="h-7 w-32 rounded bg-slate-800/80" />
            </div>
          ))}
        </div>
      ) : status && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800">
            <div className="text-[11px] uppercase text-slate-400 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-cyan-400" /> Teams &amp; Agents
            </div>
            <div className="text-2xl font-bold text-white mt-1">
              {status.counts.teams} <span className="text-sm font-normal text-slate-500">teams · {status.counts.agents} agents</span>
            </div>
          </div>
          <div className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800">
            <div className="text-[11px] uppercase text-slate-400 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-emerald-400" /> Ready AI Providers
            </div>
            <div className="text-2xl font-bold text-emerald-400 mt-1">
              {status.counts.configuredProviders} <span className="text-sm font-normal text-slate-500">/ {status.counts.providers} configured</span>
            </div>
          </div>
          <div className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800">
            <div className="text-[11px] uppercase text-slate-400 flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-pink-400" /> Power Tool Arsenal
            </div>
            <div className="text-2xl font-bold text-white mt-1">
              {toolCount} <span className="text-sm font-normal text-slate-500">built-in + live MCP</span>
            </div>
          </div>
          <div className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800">
            <div className="text-[11px] uppercase text-slate-400 flex items-center gap-1.5">
              <FolderTree className="w-3.5 h-3.5 text-amber-400" /> Brains &amp; Skills
            </div>
            <div className="text-2xl font-bold text-amber-300 mt-1">
              {status.counts.brains} <span className="text-sm font-normal text-slate-500">brains · {status.counts.skills} skills</span>
            </div>
          </div>
        </div>
      )}

      {/* Your Agentic Teams + Spawn Squad Kits */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-white">Your Agentic Teams</h2>
            <p className="text-xs text-slate-400">
              Click any squad to jump straight into chat or isolate its brain topology on the Canvas.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {[
              { id: "software-squad", label: "Software Squad" },
              { id: "growth-squad", label: "Growth Squad" },
              { id: "research-squad", label: "Research Squad" },
            ].map((kit) => (
              <button
                key={kit.id}
                disabled={Boolean(spawning)}
                onClick={() => spawnKit(kit.id)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-300 font-medium flex items-center gap-1 cursor-pointer disabled:opacity-50"
              >
                <Plus className="w-3 h-3" /> {spawning === kit.id ? "Spawning..." : kit.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {loading && teams.length === 0 && (
            <div className="p-5 rounded-2xl bg-[#0e1320] border border-slate-800 animate-pulse space-y-3">
              <div className="h-4 w-40 rounded bg-slate-800" />
              <div className="h-3 w-64 rounded bg-slate-800/70" />
              <div className="flex gap-2 pt-2">
                <div className="h-8 flex-1 rounded-xl bg-slate-800/80" />
                <div className="h-8 flex-1 rounded-xl bg-slate-800/80" />
              </div>
            </div>
          )}
          {teams.map((t) => (
            <div
              key={t.id}
              className="p-5 rounded-2xl bg-[#0e1320] border border-slate-800 hover:border-violet-500/40 transition flex flex-col justify-between gap-4"
            >
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      {t.name}
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 uppercase font-semibold">
                        {t.collaboration_mode}
                      </span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">{t.description}</p>
                  </div>
                  {t.id !== "team_pandawa" && (
                    <button
                      aria-label={`Delete team ${t.name}`}
                      onClick={() => deleteTeam(t)}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {t.members.map((m) => (
                    <span
                      key={m.id}
                      className="text-[11px] px-2 py-1 rounded-lg bg-[#090c14] border border-slate-800 text-slate-200 flex items-center gap-1.5"
                    >
                      <span>{m.avatar}</span>
                      <span className="font-medium">{m.name}</span>
                      <span className="text-[10px] text-slate-500 font-mono">{m.model || m.purpose}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                <button
                  onClick={() => onStartMission(t.id)}
                  className="flex-1 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <MessageSquare className="w-3.5 h-3.5" /> Start Mission
                </button>
                <button
                  onClick={() => onFocusTeamOnCanvas(t.id)}
                  className="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Network className="w-3.5 h-3.5 text-cyan-400" /> View on Canvas
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 1-Click Starter Missions */}
      <div className="space-y-3">
        <h2 className="text-sm font-bold text-white">1-Click Starter Missions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {STARTER_MISSIONS.map((m) => (
            <button
              key={m.title}
              onClick={() => onStartMission(teams[0]?.id || "team_pandawa", m.prompt)}
              className="p-4 rounded-xl bg-[#0e1320] hover:bg-[#131a2c] border border-slate-800 hover:border-amber-500/40 text-left transition cursor-pointer space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-white">{m.title}</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-semibold">
                  {m.tag}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">{m.prompt}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

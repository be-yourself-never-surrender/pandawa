import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Radio,
  Plus,
  Send,
  Trash2,
  QrCode,
  RefreshCw,
  Power,
  Network,
  Copy,
  Check,
  Activity,
  ShieldCheck,
  LogOut,
  AlertTriangle,
  Edit3,
  X,
} from "lucide-react";
import { apiFetch } from "../../api/client";
import type { AgentItem, TeamItem } from "../../types";
import {
  advanceEventCursor,
  formatTeamPipelineSummary,
  getChannelRouteStatus,
  pickDefaultChannelTarget,
} from "../../utils/routingHelpers";

export interface WhatsAppRuntimeState {
  channelId: string;
  status: "disconnected" | "connecting" | "qr" | "connected" | "logged_out" | "error";
  qrDataUrl: string;
  phoneNumber: string;
  lastError: string;
  lastMessageAt: string;
}

export interface ChannelRecord {
  id: string;
  name: string;
  type: "telegram" | "whatsapp_qr" | "whatsapp_cloud" | "discord" | "slack" | "webhook";
  config: Record<string, string>;
  target_type: "team" | "agent";
  target_id: string;
  enabled: boolean;
  poller?: { active: boolean; lastPollAt: string; lastError: string } | null;
  whatsapp?: WhatsAppRuntimeState | null;
}

interface ActivityItem {
  id: string;
  title: string;
  target_type: string;
  target_id: string;
  target_name?: string;
  team_name?: string;
  responding_agent_name?: string;
  attribution?: {
    teamName?: string;
    leadAgentName?: string;
    reviewerAgentName?: string;
    senderAgentName?: string;
    senderModel?: string;
  };
  message_count: number;
  last_message: string | null;
  updated_at: string;
}

interface ChannelsPageProps {
  liveEvents: Array<Record<string, unknown>>;
  onOpenCanvas: () => void;
}

const CHANNEL_TYPES: Array<{
  id: ChannelRecord["type"];
  label: string;
  badge: string;
  desc: string;
}> = [
  { id: "whatsapp_qr", label: "WhatsApp QR", badge: "2-Way · Free", desc: "Link any WhatsApp phone via QR code (Baileys)." },
  { id: "whatsapp_cloud", label: "WhatsApp Cloud API", badge: "2-Way · Meta", desc: "Official Meta Business Cloud API webhook." },
  { id: "telegram", label: "Telegram Bot", badge: "2-Way · Bot API", desc: "Long-polling Telegram bot with /approve & /status." },
  { id: "discord", label: "Discord", badge: "Webhook", desc: "Send alerts, Heartbeat & Cron briefings to Discord." },
  { id: "slack", label: "Slack", badge: "Webhook", desc: "Dispatch structured alerts to any Slack channel." },
  { id: "webhook", label: "Custom Webhook", badge: "API · Secret", desc: "Inbound & outbound HTTP webhook with 48-hex secret." },
];

const TYPE_LABELS: Record<string, string> = {
  whatsapp_qr: "WhatsApp QR",
  whatsapp_cloud: "WhatsApp Cloud",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  webhook: "Webhook",
};

export const ChannelsPage: React.FC<ChannelsPageProps> = ({ liveEvents, onOpenCanvas }) => {
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Add channel form
  const [chType, setChType] = useState<ChannelRecord["type"]>("whatsapp_qr");
  const [chName, setChName] = useState("");
  const [targetValue, setTargetValue] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [allowedNumbers, setAllowedNumbers] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [outboundUrl, setOutboundUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  // Edit channel modal
  const [editingChannel, setEditingChannel] = useState<ChannelRecord | null>(null);
  const [editName, setEditName] = useState("");
  const [editConfig, setEditConfig] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);

  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState("");
  const [busyId, setBusyId] = useState("");
  const lastSeqRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const [cRes, tRes, aRes, actRes] = await Promise.all([
        apiFetch<{ channels: ChannelRecord[] }>("/api/channels"),
        apiFetch<{ teams: TeamItem[] }>("/api/teams"),
        apiFetch<{ agents: AgentItem[] }>("/api/agents"),
        apiFetch<{ activity: ActivityItem[] }>("/api/channels/activity").catch(() => ({ activity: [] })),
      ]);
      const nextTeams = tRes.teams || [];
      const nextAgents = aRes.agents || [];
      setChannels(cRes.channels || []);
      setTeams(nextTeams);
      setAgents(nextAgents);
      setActivity(actRes.activity || []);
      setTargetValue((prev) => {
        if (prev) {
          const idx = prev.indexOf(":");
          const pt = prev.slice(0, idx);
          const pid = prev.slice(idx + 1);
          if (pt === "team" && nextTeams.some((t) => t.id === pid)) return prev;
          if (pt === "agent" && nextAgents.some((a) => a.id === pid)) return prev;
        }
        return pickDefaultChannelTarget(nextTeams, nextAgents);
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  // Apply real-time WhatsApp QR & status updates pushed over WebSocket without dropping burst events
  useEffect(() => {
    const { nextSeq, freshEvents } = advanceEventCursor(liveEvents, lastSeqRef.current);
    lastSeqRef.current = nextSeq;
    let shouldReload = false;
    for (const ev of freshEvents) {
      if (ev.type === "whatsapp_status") {
        const chId = String(ev.channelId || "");
        if (!chId) continue;
        const waPatch: WhatsAppRuntimeState = {
          channelId: chId,
          status: String(ev.status || "disconnected") as WhatsAppRuntimeState["status"],
          qrDataUrl: String(ev.qrDataUrl || ""),
          phoneNumber: String(ev.phoneNumber || ""),
          lastError: String(ev.lastError || ""),
          lastMessageAt: String(ev.lastMessageAt || ""),
        };
        setChannels((prev) => prev.map((c) => (c.id === chId ? { ...c, whatsapp: waPatch } : c)));
      } else if (ev.type === "topology_updated" || ev.type === "team_done") {
        shouldReload = true;
      }
    }
    if (shouldReload) {
      load().catch(() => {});
    }
  }, [liveEvents, load]);

  function copyText(key: string, text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(key);
    setTimeout(() => setCopiedId(""), 1600);
  }

  async function createChannel(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    setCreating(true);
    try {
      const sep = targetValue.indexOf(":");
      const tType = sep !== -1 ? targetValue.slice(0, sep) : "team";
      const tId = sep !== -1 ? targetValue.slice(sep + 1) : targetValue;
      if (!tId) {
        setNotice({ ok: false, text: "Select a target Team or Agent before creating the channel." });
        return;
      }
      const config: Record<string, string> = {};
      if (chType === "telegram") {
        config.botToken = botToken.trim();
        if (chatId.trim()) config.chatId = chatId.trim();
      } else if (chType === "whatsapp_qr") {
        if (allowedNumbers.trim()) config.allowedNumbers = allowedNumbers.trim();
      } else if (chType === "whatsapp_cloud") {
        config.phoneNumberId = phoneNumberId.trim();
        config.accessToken = accessToken.trim();
        if (verifyToken.trim()) config.verifyToken = verifyToken.trim();
        if (appSecret.trim()) config.appSecret = appSecret.trim();
        if (allowedNumbers.trim()) config.allowedNumbers = allowedNumbers.trim();
      } else if (chType === "discord" || chType === "slack") {
        config.webhookUrl = webhookUrl.trim();
      } else if (chType === "webhook") {
        if (outboundUrl.trim()) config.outboundUrl = outboundUrl.trim();
        if (webhookSecret.trim()) config.secret = webhookSecret.trim();
      }

      const defaultName =
        chType === "whatsapp_qr"
          ? "WhatsApp Personal"
          : chType === "whatsapp_cloud"
          ? "WhatsApp Business Cloud"
          : chType === "telegram"
          ? "Telegram Bot"
          : chType === "discord"
          ? "Discord Alerts"
          : chType === "slack"
          ? "Slack Workspace"
          : "Custom Webhook";

      const res = await apiFetch<{ id: string; webhookSecret?: string; verifyToken?: string }>("/api/channels", {
        method: "POST",
        body: JSON.stringify({
          name: chName.trim() || defaultName,
          type: chType,
          targetType: tType === "agent" ? "agent" : "team",
          targetId: tId,
          config,
        }),
      });

      const extras: string[] = [];
      if (res.webhookSecret) extras.push(`Generated X-Pandawa-Secret: ${res.webhookSecret} (save it now!)`);
      if (res.verifyToken) extras.push(`Generated Meta Verify Token: ${res.verifyToken} (save it now!)`);
      if (chType === "whatsapp_qr") extras.push("Generating live QR code — scan from WhatsApp -> Linked Devices.");

      setNotice({
        ok: true,
        text: `Channel created (${res.id}). ${extras.join(" · ")}`.trim(),
      });

      setChName("");
      setBotToken("");
      setChatId("");
      setAllowedNumbers("");
      setPhoneNumberId("");
      setAccessToken("");
      setVerifyToken("");
      setAppSecret("");
      setWebhookUrl("");
      setOutboundUrl("");
      setWebhookSecret("");
      await load();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setCreating(false);
    }
  }

  async function updateRoute(ch: ChannelRecord, nextTarget: string) {
    const sep = nextTarget.indexOf(":");
    const tType = sep !== -1 ? nextTarget.slice(0, sep) : "team";
    const tId = sep !== -1 ? nextTarget.slice(sep + 1) : nextTarget;
    if (!tId) return;
    setNotice(null);
    try {
      await apiFetch(`/api/channels/${ch.id}`, {
        method: "PATCH",
        body: JSON.stringify({ targetType: tType, targetId: tId }),
      });
      await load();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      await load().catch(() => {});
    }
  }

  function openEditChannel(ch: ChannelRecord) {
    setEditingChannel(ch);
    setEditName(ch.name);
    setEditConfig({ ...(ch.config || {}) });
  }

  async function saveEditChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!editingChannel) return;
    setSavingEdit(true);
    setNotice(null);
    try {
      await apiFetch(`/api/channels/${editingChannel.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim() || editingChannel.name,
          config: editConfig,
        }),
      });
      setEditingChannel(null);
      setNotice({ ok: true, text: `Updated channel "${editName.trim() || editingChannel.name}".` });
      await load();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingEdit(false);
    }
  }

  async function toggleEnabled(ch: ChannelRecord) {
    setNotice(null);
    try {
      await apiFetch(`/api/channels/${ch.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !ch.enabled }),
      });
      await load();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function connectWhatsAppQr(chId: string) {
    setBusyId(chId);
    setNotice(null);
    try {
      await apiFetch(`/api/channels/${chId}/whatsapp/connect`, { method: "POST" });
      await load();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId("");
    }
  }

  async function logoutWhatsAppQr(chId: string) {
    if (!window.confirm("Unlink this WhatsApp device and wipe its local session credentials?")) return;
    setBusyId(chId);
    try {
      await apiFetch(`/api/channels/${chId}/whatsapp/logout`, { method: "POST" });
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function testChannel(chId: string) {
    setBusyId(chId);
    setNotice(null);
    try {
      const r = await apiFetch<{ ok: boolean; detail: string }>(`/api/channels/${chId}/test`, { method: "POST" });
      setNotice({ ok: r.ok, text: `${r.ok ? "Test delivered" : "Test failed"}: ${r.detail}` });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId("");
    }
  }

  async function deleteChannel(ch: ChannelRecord) {
    if (!window.confirm(`Delete channel "${ch.name}"?`)) return;
    setNotice(null);
    try {
      await apiFetch(`/api/channels/${ch.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:7777";
  const selectedTypeMeta = CHANNEL_TYPES.find((t) => t.id === chType)!;
  const selectedCreateTarget = (() => {
    if (!targetValue) return null;
    const sep = targetValue.indexOf(":");
    const tt = sep !== -1 ? targetValue.slice(0, sep) : "team";
    const tid = sep !== -1 ? targetValue.slice(sep + 1) : targetValue;
    return getChannelRouteStatus({ target_type: tt, target_id: tid }, teams, agents);
  })();

  return (
    <div className="h-screen overflow-y-auto bg-[#09090b]">
      {/* Top Bar */}
      <header className="sticky top-0 z-20 bg-[#09090b]/90 backdrop-blur-md border-b border-white/[0.06] px-6 h-13 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-[14px] font-semibold tracking-[-0.015em] text-zinc-100 truncate">
            Channels &amp; Messaging Gateways
          </h1>
          <span className="text-[11px] font-mono text-zinc-500 hidden sm:inline">
            Telegram · WhatsApp QR · WhatsApp Cloud · Discord · Slack · Webhook
          </span>
        </div>
        <button
          onClick={onOpenCanvas}
          className="h-8 px-3 rounded-md bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold inline-flex items-center gap-1.5 transition cursor-pointer shrink-0"
        >
          <Network className="w-3.5 h-3.5" /> Wire on Canvas
        </button>
      </header>

      <div className="max-w-[1240px] mx-auto px-6 py-6 space-y-6">
        {notice && (
          <div
            className={`px-4 py-2.5 rounded-lg border text-xs font-mono break-all ${
              notice.ok
                ? "bg-emerald-500/[0.08] border-emerald-500/30 text-emerald-300"
                : "bg-rose-500/[0.08] border-rose-500/30 text-rose-300"
            }`}
          >
            {notice.text}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 7 cols: Connect New Channel + Active Channels */}
          <div className="lg:col-span-7 space-y-6">
            {/* Connect New Channel Form */}
            <section className="rounded-xl bg-[#111113] border border-white/[0.08] p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                  <Radio className="w-3.5 h-3.5 text-amber-400" /> Connect Messaging Channel
                </h2>
                <span className="text-[10px] font-mono text-zinc-500 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-emerald-400" /> AES-256-GCM Encrypted
                </span>
              </div>

              {/* Channel Type Picker */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {CHANNEL_TYPES.map((ct) => {
                  const active = chType === ct.id;
                  return (
                    <button
                      key={ct.id}
                      type="button"
                      onClick={() => setChType(ct.id)}
                      className={`p-2.5 rounded-lg border text-left transition cursor-pointer ${
                        active
                          ? "bg-white/[0.08] border-amber-400/50 text-zinc-100"
                          : "bg-[#09090b] border-white/[0.07] text-zinc-400 hover:text-zinc-200 hover:border-white/[0.14]"
                      }`}
                    >
                      <div className="text-xs font-medium truncate">{ct.label}</div>
                      <div className="text-[10px] font-mono text-zinc-500 mt-0.5 truncate">{ct.badge}</div>
                    </button>
                  );
                })}
              </div>

              <p className="text-[11px] text-zinc-500">{selectedTypeMeta.desc}</p>

              <form onSubmit={createChannel} className="space-y-3 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] text-zinc-400 block mb-1">Channel Name</label>
                    <input
                      value={chName}
                      onChange={(e) => setChName(e.target.value)}
                      placeholder={
                        chType === "whatsapp_qr"
                          ? "My WhatsApp"
                          : chType === "whatsapp_cloud"
                          ? "WA Business Cloud"
                          : chType === "telegram"
                          ? "Pandawa Ops Bot"
                          : "Channel Name"
                      }
                      className="w-full h-9 bg-[#09090b] border border-white/[0.09] focus:border-amber-400/70 rounded-lg px-3 text-zinc-100 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-400 block mb-1">Route Messages To</label>
                    <select
                      value={targetValue}
                      onChange={(e) => setTargetValue(e.target.value)}
                      className="w-full h-9 bg-[#09090b] border border-white/[0.09] focus:border-amber-400/70 rounded-lg px-2.5 text-zinc-100 outline-none"
                    >
                      <optgroup label="Agentic Teams">
                        {teams.map((t) => (
                          <option key={t.id} value={`team:${t.id}`}>
                            Team: {t.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Direct Specialist Agents">
                        {agents.map((a) => (
                          <option key={a.id} value={`agent:${a.id}`}>
                            Agent: {a.name} ({a.title})
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </div>
                </div>

                {selectedCreateTarget && (
                  <div className="px-3 py-2 rounded-lg bg-[#09090b] border border-white/[0.07] text-[11px] font-mono text-zinc-400">
                    Pipeline: <span className="text-zinc-200">{selectedCreateTarget.pipelineSummary}</span>
                  </div>
                )}

                {/* Type-specific credentials */}
                {chType === "whatsapp_qr" && (
                  <div>
                    <label className="text-[11px] text-zinc-400 block mb-1">
                      Allowed Phone Numbers (optional whitelist, comma-separated, e.g. 6281234567890)
                    </label>
                    <input
                      value={allowedNumbers}
                      onChange={(e) => setAllowedNumbers(e.target.value)}
                      placeholder="6281234567890, 62851..."
                      className="w-full h-9 bg-[#09090b] border border-white/[0.09] focus:border-amber-400/70 rounded-lg px-3 font-mono text-zinc-100 outline-none"
                    />
                    <p className="text-[10.5px] text-zinc-500 mt-1">
                      After clicking Add, a live QR code will appear below. Scan with WhatsApp → Linked Devices. Tip: In &ldquo;Message Yourself&rdquo;, prefix commands with <code className="text-zinc-300">!</code> or <code className="text-zinc-300">/status</code>.
                    </p>
                  </div>
                )}

                {chType === "whatsapp_cloud" && (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[11px] text-zinc-400 block mb-1">Meta Phone Number ID *</label>
                        <input
                          required
                          value={phoneNumberId}
                          onChange={(e) => setPhoneNumberId(e.target.value)}
                          placeholder="e.g. 109876543210987"
                          className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-400 block mb-1">Permanent Access Token *</label>
                        <input
                          required
                          type="password"
                          value={accessToken}
                          onChange={(e) => setAccessToken(e.target.value)}
                          placeholder="EAAG..."
                          className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[11px] text-zinc-400 block mb-1">Webhook Verify Token (auto if blank)</label>
                        <input
                          value={verifyToken}
                          onChange={(e) => setVerifyToken(e.target.value)}
                          placeholder="Auto-generated strong token"
                          className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-400 block mb-1">Meta App Secret (HMAC verify)</label>
                        <input
                          type="password"
                          value={appSecret}
                          onChange={(e) => setAppSecret(e.target.value)}
                          placeholder="Optional X-Hub-Signature-256 secret"
                          className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Allowed Phone Numbers (optional)</label>
                      <input
                        value={allowedNumbers}
                        onChange={(e) => setAllowedNumbers(e.target.value)}
                        placeholder="6281234567890"
                        className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                      />
                    </div>
                  </div>
                )}

                {chType === "telegram" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Bot Token (@BotFather) *</label>
                      <input
                        required
                        type="password"
                        value={botToken}
                        onChange={(e) => setBotToken(e.target.value)}
                        placeholder="123456:ABC-DEF..."
                        className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Allowed Chat ID (optional whitelist)</label>
                      <input
                        value={chatId}
                        onChange={(e) => setChatId(e.target.value)}
                        placeholder="e.g. 987654321 or -100..."
                        className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                      />
                    </div>
                  </div>
                )}

                {(chType === "discord" || chType === "slack") && (
                  <div>
                    <label className="text-[11px] text-zinc-400 block mb-1">
                      {chType === "discord" ? "Discord Webhook URL *" : "Slack Incoming Webhook URL *"}
                    </label>
                    <input
                      required
                      type="password"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder={
                        chType === "discord"
                          ? "https://discord.com/api/webhooks/..."
                          : "https://hooks.slack.com/services/..."
                      }
                      className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                    />
                  </div>
                )}

                {chType === "webhook" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Secret Header (auto-generated if blank)</label>
                      <input
                        value={webhookSecret}
                        onChange={(e) => setWebhookSecret(e.target.value)}
                        placeholder="Auto-generated 48-hex secret"
                        className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-zinc-400 block mb-1">Outbound Callback URL (optional)</label>
                      <input
                        value={outboundUrl}
                        onChange={(e) => setOutboundUrl(e.target.value)}
                        placeholder="https://your-service/callback"
                        className="w-full h-9 bg-[#09090b] border border-white/[0.09] rounded-lg px-3 font-mono text-zinc-100 outline-none"
                      />
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={creating}
                  className="h-9 px-4 rounded-lg bg-zinc-100 hover:bg-white disabled:opacity-40 text-zinc-950 font-semibold inline-flex items-center gap-1.5 transition cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {creating ? "Creating..." : `Add ${selectedTypeMeta.label}`}
                </button>
              </form>
            </section>

            {/* Connected Channels List */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-zinc-200">
                  Configured Channels ({channels.length})
                </h2>
                <button
                  type="button"
                  onClick={() => load()}
                  className="text-[11px] text-zinc-500 hover:text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>

              {loading && channels.length === 0 ? (
                <div className="p-5 rounded-xl bg-[#111113] border border-white/[0.08] animate-pulse space-y-2">
                  <div className="h-4 w-44 rounded bg-zinc-800" />
                  <div className="h-3 w-72 rounded bg-zinc-800/70" />
                </div>
              ) : channels.length === 0 ? (
                <div className="p-8 rounded-xl bg-[#111113] border border-white/[0.08] text-center space-y-1">
                  <div className="text-xs font-medium text-zinc-300">No messaging channels connected yet</div>
                  <div className="text-[11px] text-zinc-500">
                    Connect WhatsApp (QR or Meta Cloud API), Telegram, Discord, Slack, or a Webhook above to interact with your Pandawa teams.
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {channels.map((c) => {
                    const wa = c.whatsapp;
                    const isLive =
                      (c.type === "telegram" && Boolean(c.poller?.active) && !c.poller?.lastError) ||
                      (c.type === "whatsapp_qr" && wa?.status === "connected") ||
                      ((c.type === "whatsapp_cloud" || c.type === "discord" || c.type === "slack" || c.type === "webhook") &&
                        c.enabled);
                    const waCallback = `${origin}/api/webhooks/whatsapp/${c.id}`;
                    const genericCallback = `${origin}/api/webhooks/${c.id}`;
                    const routeStatus = getChannelRouteStatus(c, teams, agents);

                    return (
                      <div
                        key={c.id}
                        className={`rounded-xl bg-[#111113] border p-4 space-y-3 text-xs ${
                          routeStatus.orphaned ? "border-rose-500/40" : "border-white/[0.08]"
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="space-y-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  !c.enabled
                                    ? "bg-zinc-600"
                                    : routeStatus.orphaned
                                    ? "bg-rose-400"
                                    : c.type === "whatsapp_qr" && wa?.status === "qr"
                                    ? "bg-amber-400 animate-pulse"
                                    : isLive
                                    ? "bg-emerald-400"
                                    : "bg-zinc-500"
                                }`}
                              />
                              <span className="text-[13px] font-semibold text-zinc-100">{c.name}</span>
                              <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.07] text-zinc-400">
                                {TYPE_LABELS[c.type] || c.type}
                              </span>
                              {routeStatus.orphaned && (
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/35 text-rose-300 inline-flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" /> Orphaned Route
                                </span>
                              )}
                              {!routeStatus.orphaned && !routeStatus.valid && (
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300 inline-flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" /> Empty Team
                                </span>
                              )}
                              {c.type === "whatsapp_qr" && wa?.status === "connected" && wa.phoneNumber && (
                                <span className="text-[10px] font-mono text-emerald-400">+{wa.phoneNumber}</span>
                              )}
                              {c.type === "whatsapp_qr" && wa?.status === "qr" && (
                                <span className="text-[10px] font-mono text-amber-300">Scan QR to link</span>
                              )}
                              {c.type === "telegram" && c.poller?.active && (
                                <span className="text-[10px] font-mono text-emerald-400">2-way polling</span>
                              )}
                            </div>

                            {(c.poller?.lastError || wa?.lastError) && (
                              <div className="text-[11px] font-mono text-rose-300">
                                {c.poller?.lastError || wa?.lastError}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => toggleEnabled(c)}
                              title={c.enabled ? "Pause channel" : "Enable channel"}
                              className={`h-7 px-2 rounded-md border text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer transition ${
                                c.enabled
                                  ? "bg-[#18181b] border-white/[0.08] text-zinc-300 hover:text-white"
                                  : "bg-[#09090b] border-white/[0.06] text-zinc-500"
                              }`}
                            >
                              <Power className="w-3 h-3" /> {c.enabled ? "On" : "Off"}
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditChannel(c)}
                              title="Edit channel settings & credentials"
                              className="h-7 px-2 rounded-md bg-[#18181b] hover:bg-[#222227] border border-white/[0.08] text-zinc-300 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Edit3 className="w-3 h-3" /> Edit
                            </button>
                            <button
                              type="button"
                              disabled={busyId === c.id}
                              onClick={() => testChannel(c.id)}
                              className="h-7 px-2.5 rounded-md bg-[#18181b] hover:bg-[#222227] border border-white/[0.08] text-zinc-200 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Send className="w-3 h-3" /> Test
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete ${c.name}`}
                              onClick={() => deleteChannel(c)}
                              className="h-7 w-7 rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 inline-flex items-center justify-center cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Live Routing Bar (synced with Brain Canvas!) */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-white/[0.06]">
                          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                            <span className="text-[11px] text-zinc-500 shrink-0">Routes to:</span>
                            <select
                              value={routeStatus.orphaned ? "" : `${c.target_type}:${c.target_id}`}
                              onChange={(e) => updateRoute(c, e.target.value)}
                              className="flex-1 h-7 bg-[#09090b] border border-white/[0.09] rounded-md px-2 text-[11px] text-zinc-200 outline-none"
                            >
                              {routeStatus.orphaned && (
                                <option value="">
                                  {routeStatus.label} (Select valid target)
                                </option>
                              )}
                              <optgroup label="Teams">
                                {teams.map((t) => (
                                  <option key={t.id} value={`team:${t.id}`}>
                                    Team · {t.name}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="Agents">
                                {agents.map((a) => (
                                  <option key={a.id} value={`agent:${a.id}`}>
                                    Agent · {a.name}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                          </div>

                          {c.type === "whatsapp_qr" && (
                            <div className="flex items-center gap-1.5">
                              {wa?.status !== "connected" ? (
                                <button
                                  type="button"
                                  disabled={busyId === c.id}
                                  onClick={() => connectWhatsAppQr(c.id)}
                                  className="h-7 px-2.5 rounded-md bg-zinc-100 hover:bg-white text-zinc-950 font-semibold text-[11px] inline-flex items-center gap-1 cursor-pointer"
                                >
                                  <QrCode className="w-3 h-3" />
                                  {wa?.status === "connecting" ? "Connecting..." : "Connect / Scan QR"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={busyId === c.id}
                                  onClick={() => logoutWhatsAppQr(c.id)}
                                  className="h-7 px-2.5 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-300 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                                >
                                  <LogOut className="w-3 h-3" /> Unlink Phone
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        <div
                          className={`text-[10.5px] font-mono px-2.5 py-1.5 rounded-md bg-[#09090b] border ${
                            routeStatus.orphaned
                              ? "border-rose-500/30 text-rose-300"
                              : !routeStatus.valid
                              ? "border-amber-500/30 text-amber-300"
                              : "border-white/[0.06] text-zinc-400"
                          }`}
                        >
                          {routeStatus.pipelineSummary}
                        </div>

                        {/* Live Scannable WhatsApp QR Panel */}
                        {c.type === "whatsapp_qr" && wa?.status === "qr" && wa.qrDataUrl && (
                          <div className="p-4 rounded-lg bg-[#09090b] border border-amber-400/30 flex flex-col sm:flex-row items-center gap-4">
                            <img
                              src={wa.qrDataUrl}
                              alt="WhatsApp Link QR Code"
                              className="w-44 h-44 rounded-lg bg-white p-1.5 shrink-0"
                            />
                            <div className="space-y-1.5 text-xs">
                              <div className="font-semibold text-zinc-100">Scan with WhatsApp on your phone</div>
                              <ol className="text-[11px] text-zinc-400 space-y-1 list-decimal list-inside">
                                <li>Open WhatsApp → Menu / Settings → Linked Devices</li>
                                <li>Tap <strong>Link a Device</strong> and scan this QR code</li>
                                <li>Once connected, messages route directly to your selected Pandawa Team</li>
                              </ol>
                            </div>
                          </div>
                        )}

                        {/* Copyable Callback URLs for Meta WA Cloud & Custom Webhooks */}
                        {c.type === "whatsapp_cloud" && (
                          <div className="p-2.5 rounded-lg bg-[#09090b] border border-white/[0.06] flex items-center justify-between gap-2 text-[11px] font-mono">
                            <span className="text-zinc-400 truncate">
                              Meta Callback: <span className="text-zinc-200">{waCallback}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => copyText(`wa_${c.id}`, waCallback)}
                              className="text-zinc-400 hover:text-white inline-flex items-center gap-1 shrink-0 cursor-pointer"
                            >
                              {copiedId === `wa_${c.id}` ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                              Copy
                            </button>
                          </div>
                        )}

                        {c.type === "webhook" && (
                          <div className="p-2.5 rounded-lg bg-[#09090b] border border-white/[0.06] flex items-center justify-between gap-2 text-[11px] font-mono">
                            <span className="text-zinc-400 truncate">
                              POST <span className="text-zinc-200">{genericCallback}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => copyText(`wh_${c.id}`, genericCallback)}
                              className="text-zinc-400 hover:text-white inline-flex items-center gap-1 shrink-0 cursor-pointer"
                            >
                              {copiedId === `wh_${c.id}` ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                              Copy
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          {/* Right 5 cols: Read-Only Live Channel Activity Log + Commands Reference */}
          <div className="lg:col-span-5 space-y-5">
            <section className="rounded-xl bg-[#111113] border border-white/[0.08] p-4 space-y-2.5">
              <div className="text-xs font-semibold text-zinc-200">Mobile Chat Commands (Telegram &amp; WhatsApp)</div>
              <div className="space-y-1.5 text-[11px] font-mono text-zinc-400">
                <div className="flex justify-between gap-2">
                  <code className="text-zinc-200">/status</code>
                  <span className="text-zinc-500">Show active route, gate &amp; terminals</span>
                </div>
                <div className="flex justify-between gap-2">
                  <code className="text-zinc-200">/approve [id]</code>
                  <span className="text-zinc-500">Approve pending shell/tool action</span>
                </div>
                <div className="flex justify-between gap-2">
                  <code className="text-zinc-200">/auto [id]</code>
                  <span className="text-zinc-500">Approve &amp; switch to Full Freedom</span>
                </div>
                <div className="flex justify-between gap-2">
                  <code className="text-zinc-200">/reject [id]</code>
                  <span className="text-zinc-500">Deny pending tool call</span>
                </div>
                <div className="flex justify-between gap-2">
                  <code className="text-zinc-200">/term</code>
                  <span className="text-zinc-500">List live shared agent terminals</span>
                </div>
                <div className="flex justify-between gap-2">
                  <code className="text-zinc-200">/new</code>
                  <span className="text-zinc-500">Reset conversation context thread</span>
                </div>
              </div>
            </section>

            <section className="rounded-xl bg-[#111113] border border-white/[0.08] overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
                <h2 className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-zinc-400" /> Recent Channel Activity
                </h2>
                <span className="text-[10px] font-mono text-zinc-500">Read-only</span>
              </div>
              <div className="divide-y divide-white/[0.06] max-h-[460px] overflow-y-auto">
                {activity.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-zinc-500">
                    No channel missions recorded yet. Send a message from Telegram, WhatsApp, or CLI (<code className="text-zinc-400">pandawa live</code>).
                  </div>
                ) : (
                  activity.map((a) => (
                    <div key={a.id} className="px-4 py-3 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-zinc-200 truncate">{a.title}</span>
                        <span className="text-[10px] font-mono text-zinc-500 shrink-0 tabular-nums">
                          {a.message_count} msg
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-zinc-500">
                        {a.target_name ? `${a.target_name} (${a.target_type})` : `${a.target_type}:${a.target_id}`}
                        {a.responding_agent_name ? ` · Reply: ${a.responding_agent_name}` : ""}
                        {a.attribution?.senderModel ? ` [${a.attribution.senderModel}]` : ""}
                        {" · "}
                        {a.updated_at}
                      </div>
                      {a.last_message && (
                        <p className="text-[11px] text-zinc-400 line-clamp-2">{a.last_message}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>

      {editingChannel && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={saveEditChannel}
            className="w-full max-w-md rounded-xl bg-[#111113] border border-white/[0.10] p-5 space-y-3.5 text-xs shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2.5">
              <h3 className="text-sm font-semibold text-zinc-100">
                Edit Channel — {editingChannel.name}
              </h3>
              <button
                type="button"
                aria-label="Close channel editor"
                onClick={() => setEditingChannel(null)}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="text-zinc-400 block mb-1">Channel Name</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 text-white"
              />
            </div>

            {editingChannel.type === "telegram" && (
              <>
                <div>
                  <label className="text-zinc-400 block mb-1">Bot Token (leave unchanged or masked to keep)</label>
                  <input
                    type="password"
                    value={editConfig.botToken || ""}
                    onChange={(e) => setEditConfig((p) => ({ ...p, botToken: e.target.value }))}
                    className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">Allowed Chat ID (optional whitelist)</label>
                  <input
                    value={editConfig.chatId || ""}
                    onChange={(e) => setEditConfig((p) => ({ ...p, chatId: e.target.value }))}
                    className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 font-mono text-white"
                  />
                </div>
              </>
            )}

            {(editingChannel.type === "whatsapp_qr" || editingChannel.type === "whatsapp_cloud") && (
              <div>
                <label className="text-zinc-400 block mb-1">Allowed Phone Numbers (optional whitelist)</label>
                <input
                  value={editConfig.allowedNumbers || ""}
                  onChange={(e) => setEditConfig((p) => ({ ...p, allowedNumbers: e.target.value }))}
                  className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 font-mono text-white"
                />
              </div>
            )}

            {editingChannel.type === "whatsapp_cloud" && (
              <>
                <div>
                  <label className="text-zinc-400 block mb-1">Meta Phone Number ID</label>
                  <input
                    value={editConfig.phoneNumberId || ""}
                    onChange={(e) => setEditConfig((p) => ({ ...p, phoneNumberId: e.target.value }))}
                    className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">Permanent Access Token (masked if unchanged)</label>
                  <input
                    type="password"
                    value={editConfig.accessToken || ""}
                    onChange={(e) => setEditConfig((p) => ({ ...p, accessToken: e.target.value }))}
                    className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 font-mono text-white"
                  />
                </div>
              </>
            )}

            {(editingChannel.type === "discord" || editingChannel.type === "slack") && (
              <div>
                <label className="text-zinc-400 block mb-1">Webhook URL (masked if unchanged)</label>
                <input
                  type="password"
                  value={editConfig.webhookUrl || ""}
                  onChange={(e) => setEditConfig((p) => ({ ...p, webhookUrl: e.target.value }))}
                  className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 font-mono text-white"
                />
              </div>
            )}

            {editingChannel.type === "webhook" && (
              <>
                <div>
                  <label className="text-zinc-400 block mb-1">Outbound Callback URL</label>
                  <input
                    value={editConfig.outboundUrl || ""}
                    onChange={(e) => setEditConfig((p) => ({ ...p, outboundUrl: e.target.value }))}
                    className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">Webhook Secret (masked if unchanged)</label>
                  <input
                    type="password"
                    value={editConfig.secret || ""}
                    onChange={(e) => setEditConfig((p) => ({ ...p, secret: e.target.value }))}
                    className="w-full h-9 bg-[#09090b] border border-white/[0.10] rounded-lg px-3 font-mono text-white"
                  />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingChannel(null)}
                className="px-3.5 py-2 rounded-lg bg-[#18181b] text-zinc-300 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingEdit}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold cursor-pointer disabled:opacity-50"
              >
                {savingEdit ? "Saving..." : "Save Channel"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

import React, { useCallback, useEffect, useState } from "react";
import { Cpu, Plus, CheckCircle2, XCircle, Trash2, Zap, KeyRound, Globe, Save } from "lucide-react";
import { apiFetch } from "../../api/client";
import type { AgentItem, ProviderItem } from "../../types";

export const ProvidersPage: React.FC = () => {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [editing, setEditing] = useState<ProviderItem | null>(null);
  const [newApiKey, setNewApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [testState, setTestState] = useState<Record<string, { ok: boolean; msg: string; loading?: boolean }>>({});

  // Add new custom provider modal
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState("");
  const [formKind, setFormKind] = useState<"openai" | "anthropic" | "gemini">("openai");
  const [formBaseUrl, setFormBaseUrl] = useState("https://api.openai.com/v1");
  const [formApiKey, setFormApiKey] = useState("");
  const [formModel, setFormModel] = useState("gpt-4.1");

  const load = useCallback(async () => {
    const [pRes, aRes] = await Promise.all([
      apiFetch<{ providers: ProviderItem[] }>("/api/providers"),
      apiFetch<{ agents: AgentItem[] }>("/api/agents"),
    ]);
    setProviders(pRes.providers);
    setAgents(aRes.agents);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  function openEdit(p: ProviderItem) {
    setEditing({ ...p });
    setNewApiKey("");
    setModelsText(p.models.join(", "));
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const models = modelsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await apiFetch(`/api/providers/${editing.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: editing.name,
        kind: editing.kind,
        baseUrl: editing.baseUrl,
        defaultModel: editing.defaultModel,
        models,
        enabled: editing.enabled,
        ...(newApiKey.trim() ? { apiKey: newApiKey.trim() } : {}),
      }),
    });
    setEditing(null);
    await load();
  }

  async function createProvider(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim() || !formBaseUrl.trim()) return;
    await apiFetch("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: formName.trim(),
        kind: formKind,
        baseUrl: formBaseUrl.trim(),
        apiKey: formApiKey.trim(),
        defaultModel: formModel.trim(),
        models: formModel.trim() ? [formModel.trim()] : [],
      }),
    });
    setShowAdd(false);
    setFormName("");
    setFormApiKey("");
    await load();
  }

  async function testProvider(id: string) {
    setTestState((prev) => ({ ...prev, [id]: { ok: true, msg: "Testing...", loading: true } }));
    try {
      const res = await apiFetch<{ ok: boolean; latencyMs: number; message: string }>(
        `/api/providers/${id}/test`,
        { method: "POST" }
      );
      setTestState((prev) => ({
        ...prev,
        [id]: { ok: res.ok, msg: `${res.message} (${res.latencyMs}ms)` },
      }));
    } catch (err) {
      setTestState((prev) => ({
        ...prev,
        [id]: { ok: false, msg: err instanceof Error ? err.message : "Test failed" },
      }));
    }
  }

  async function updateAgentModel(agentId: string, providerId: string, model: string) {
    await apiFetch(`/api/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify({ provider_id: providerId || null, model }),
    });
    await load();
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#080a0f] p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Cpu className="w-5 h-5 text-emerald-400" /> Multi-AI Provider Hub
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Connect Official APIs (OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Ollama) or ANY Custom Base URL — then bind different models to each Pandawa Agent by purpose.
          </p>
        </div>
        <button
          onClick={() => setShowAdd((s) => !s)}
          className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-4 h-4" /> Add Custom AI Provider
        </button>
      </div>

      {/* Add Provider Form */}
      {showAdd && (
        <form
          onSubmit={createProvider}
          className="p-5 rounded-2xl bg-[#101522] border border-amber-500/40 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs"
        >
          <div>
            <label className="text-slate-400 block mb-1">Provider Name</label>
            <input
              required
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Groq Fast / Custom vLLM / LiteLLM"
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="text-slate-400 block mb-1">API Protocol</label>
            <select
              value={formKind}
              onChange={(e) => setFormKind(e.target.value as "openai" | "anthropic" | "gemini")}
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
            >
              <option value="openai">OpenAI-Compatible (Chat Completions / Custom Base URL)</option>
              <option value="anthropic">Anthropic Messages API</option>
              <option value="gemini">Google Gemini Native API</option>
            </select>
          </div>
          <div>
            <label className="text-slate-400 block mb-1">Base URL</label>
            <input
              required
              value={formBaseUrl}
              onChange={(e) => setFormBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
            />
          </div>
          <div>
            <label className="text-slate-400 block mb-1">API Key</label>
            <input
              type="password"
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              placeholder="sk-... (optional for local Ollama)"
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
            />
          </div>
          <div>
            <label className="text-slate-400 block mb-1">Default Model ID</label>
            <input
              required
              value={formModel}
              onChange={(e) => setFormModel(e.target.value)}
              placeholder="e.g. llama-3.3-70b-versatile"
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
            />
          </div>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold cursor-pointer"
            >
              Create Provider
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Providers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {providers.map((p) => {
          const ts = testState[p.id];
          return (
            <div
              key={p.id}
              className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800/90 flex flex-col justify-between space-y-3"
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold text-white flex items-center gap-2">
                      {p.name}
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 uppercase font-mono">
                        {p.kind}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 mt-0.5 flex items-center gap-1 truncate">
                      <Globe className="w-3 h-3 shrink-0" /> {p.baseUrl}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                      p.hasApiKey
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {p.hasApiKey ? "Key Ready" : "No Key"}
                  </span>
                </div>

                <div className="text-xs text-slate-300 flex items-center justify-between bg-[#080a0f] rounded-lg px-2.5 py-1.5 border border-slate-800/80">
                  <span className="text-slate-500">Default:</span>
                  <code className="text-amber-300 truncate ml-2">{p.defaultModel || "—"}</code>
                </div>

                {p.hasApiKey && (
                  <div className="text-[11px] text-slate-500 font-mono flex items-center gap-1">
                    <KeyRound className="w-3 h-3" /> {p.apiKeyMasked}
                  </div>
                )}

                {ts && (
                  <div
                    className={`text-[11px] px-2.5 py-1.5 rounded-lg border flex items-start gap-1.5 ${
                      ts.loading
                        ? "bg-slate-800/60 border-slate-700 text-slate-300"
                        : ts.ok
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                        : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                    }`}
                  >
                    {ts.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    )}
                    <span className="break-all">{ts.msg}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                <button
                  onClick={() => openEdit(p)}
                  className="flex-1 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium cursor-pointer"
                >
                  Configure Key & URL
                </button>
                <button
                  onClick={() => testProvider(p.id)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 text-xs font-medium flex items-center gap-1 cursor-pointer"
                >
                  <Zap className="w-3 h-3" /> Test
                </button>
                <button
                  onClick={async () => {
                    if (!window.confirm(`Delete provider "${p.name}"?`)) return;
                    await apiFetch(`/api/providers/${p.id}`, { method: "DELETE" });
                    await load();
                  }}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Agent Multi-Model Purpose Routing Matrix */}
      <div className="rounded-2xl bg-[#0e1320] border border-slate-800/90 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800">
          <h2 className="text-sm font-bold text-white">Per-Agent Multi-AI Routing Matrix</h2>
          <p className="text-xs text-slate-400">
            Assign any Official or Custom AI provider & specific model to each teammate based on their purpose.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[#0a0d15] text-slate-400 uppercase text-[10px]">
              <tr>
                <th className="text-left px-4 py-2.5">Agent</th>
                <th className="text-left px-4 py-2.5">Purpose</th>
                <th className="text-left px-4 py-2.5">AI Provider</th>
                <th className="text-left px-4 py-2.5">Model ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {agents.map((a) => (
                <tr key={a.id} className="hover:bg-slate-800/25">
                  <td className="px-4 py-2.5 font-semibold text-white">
                    {a.avatar} {a.name}
                    <span className="block text-[10px] font-normal text-slate-500">{a.title}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 uppercase text-[10px] font-semibold">
                      {a.purpose}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <select
                      value={a.provider_id || ""}
                      onChange={(e) => {
                        const prov = providers.find((p) => p.id === e.target.value);
                        updateAgentModel(a.id, e.target.value, prov?.defaultModel || a.model);
                      }}
                      className="bg-[#080a0f] border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
                    >
                      <option value="">(Canvas Wired)</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} {p.hasApiKey ? "✓" : "(no key)"}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      defaultValue={a.model}
                      onBlur={(e) => {
                        if (e.target.value !== a.model) {
                          updateAgentModel(a.id, a.provider_id || "", e.target.value);
                        }
                      }}
                      className="w-64 bg-[#080a0f] border border-slate-700 rounded-lg px-2.5 py-1.5 font-mono text-slate-100"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Provider Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={saveEdit}
            className="w-full max-w-lg rounded-2xl bg-[#101522] border border-slate-700 p-6 space-y-4 text-xs shadow-2xl"
          >
            <h3 className="text-sm font-bold text-white">Configure Provider — {editing.name}</h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-400 block mb-1">Display Name</label>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Protocol</label>
                <select
                  value={editing.kind}
                  onChange={(e) => setEditing({ ...editing, kind: e.target.value as ProviderItem["kind"] })}
                  className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
                >
                  <option value="openai">OpenAI-Compatible</option>
                  <option value="anthropic">Anthropic Messages</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </div>
            </div>

            <div>
              <label className="text-slate-400 block mb-1">Base URL (Official or Custom Endpoint)</label>
              <input
                value={editing.baseUrl}
                onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>

            <div>
              <label className="text-slate-400 block mb-1">
                API Key {editing.hasApiKey ? `(currently set: ${editing.apiKeyMasked} — leave blank to keep)` : ""}
              </label>
              <input
                type="password"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder="Paste new API key..."
                className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>

            <div>
              <label className="text-slate-400 block mb-1">Default Model</label>
              <input
                value={editing.defaultModel}
                onChange={(e) => setEditing({ ...editing, defaultModel: e.target.value })}
                className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>

            <div>
              <label className="text-slate-400 block mb-1">Available Models (comma-separated)</label>
              <input
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" /> Save Provider
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

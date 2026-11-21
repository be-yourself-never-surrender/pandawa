import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import {
  Save,
  Brain,
  Users,
  Cpu,
  FolderPlus,
  Wrench,
  UserPlus,
  Trash2,
  Eye,
  ExternalLink,
  CheckCircle2,
  X,
  RefreshCw,
  Download,
  Upload,
  LayoutGrid,
  Copy,
} from "lucide-react";
import { apiFetch } from "../../api/client";
import type { AgentItem, BrainItem, BrainTreeNode, ProviderItem, TeamItem, TopologyEdge, TopologyNode } from "../../types";
import { PandawaNode, type PandawaNodeData } from "./PandawaNode";
import { BundlePreviewModal, type PreviewBundleData } from "../BundlePreviewModal";

interface BrainCanvasProps {
  onOpenBrainFile: (filePath: string) => void;
  activeAgentIds: Set<string>;
  initialFocusTeamId?: string | null;
}

const RELATION_COLORS: Record<string, string> = {
  brain_link: "#8b5cf6",
  model_binding: "#10b981",
  knowledge_mount: "#f59e0b",
  peer_collab: "#06b6d4",
  tool_grant: "#ec4899",
  channel_route: "#38bdf8",
};

function flattenTree(nodes: BrainTreeNode[]): Array<{ path: string; isFolder: boolean }> {
  const out: Array<{ path: string; isFolder: boolean }> = [];
  for (const n of nodes) {
    out.push({ path: n.path, isFolder: n.type === "folder" });
    if (n.children) out.push(...flattenTree(n.children));
  }
  return out;
}

function inferRelation(srcType: string, dstType: string): { relation: string; label: string } {
  if (srcType === "provider" || dstType === "provider") return { relation: "model_binding", label: "AI model" };
  if (srcType === "knowledge" || dstType === "knowledge") return { relation: "knowledge_mount", label: "mount" };
  if (srcType === "toolpack" || dstType === "toolpack") return { relation: "tool_grant", label: "tools" };
  if (srcType === "agent" && dstType === "agent") return { relation: "peer_collab", label: "peer" };
  return { relation: "brain_link", label: "brain sync" };
}

export const BrainCanvas: React.FC<BrainCanvasProps> = ({ onOpenBrainFile, activeAgentIds, initialFocusTeamId }) => {
  const nodeTypes = useMemo(() => ({ pandawa: PandawaNode }), []);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PandawaNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [spawningTpl, setSpawningTpl] = useState(false);
  const [previewBundle, setPreviewBundle] = useState<PreviewBundleData | null>(null);
  const [installingBundle, setInstallingBundle] = useState(false);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [focusTeamId, setFocusTeamId] = useState<string>(initialFocusTeamId || "all");
  const [showTip, setShowTip] = useState(true);

  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [brains, setBrains] = useState<BrainItem[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [fileChoices, setFileChoices] = useState<Array<{ path: string; isFolder: boolean }>>([]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");
  const [dirty, setDirty] = useState(false);

  // Compiled Brain preview modal
  const [compiledPreview, setCompiledPreview] = useState<{
    agentName: string;
    model: string;
    summary: { totalFiles: number; totalChars: number; brainNames: string[]; mountedPaths: string[] };
    systemPrompt: string;
  } | null>(null);

  const loadAll = useCallback(async () => {
    const [topoRes, agentsRes, brainsRes, provRes, treeRes, teamsRes] = await Promise.all([
      apiFetch<{ nodes: TopologyNode[]; edges: TopologyEdge[] }>("/api/topology"),
      apiFetch<{ agents: AgentItem[] }>("/api/agents"),
      apiFetch<{ brains: BrainItem[] }>("/api/brains"),
      apiFetch<{ providers: ProviderItem[] }>("/api/providers"),
      apiFetch<{ tree: BrainTreeNode[] }>("/api/files/tree"),
      apiFetch<{ teams: TeamItem[] }>("/api/teams"),
    ]);

    setAgents(agentsRes.agents);
    setBrains(brainsRes.brains);
    setProviders(provRes.providers);
    setFileChoices(flattenTree(treeRes.tree));
    setTeams(teamsRes.teams);

    const rfNodes: Array<Node<PandawaNodeData>> = topoRes.nodes.map((n) => ({
      id: n.id,
      type: "pandawa",
      position: n.position,
      data: {
        ...n.data,
        nodeType: n.type,
        label: n.label,
        refId: n.refId,
      },
    }));

    const rfEdges: Edge[] = topoRes.edges.map((e) => {
      const color = RELATION_COLORS[e.relation] || "#64748b";
      return {
        id: e.id,
        type: "smoothstep",
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || undefined,
        targetHandle: e.targetHandle || undefined,
        label: e.label || e.relation,
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
        animated: e.animated,
        zIndex: 15,
        data: { relation: e.relation, permission: e.permission },
        style: {
          stroke: color,
          strokeWidth: 2,
          strokeDasharray: e.relation === "peer_collab" ? "6 4" : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      };
    });

    setNodes(rfNodes);
    setEdges(rfEdges);
    setDirty(false);
  }, [setNodes, setEdges]);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll]);

  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        const aid = String(n.data.agentId || n.data.refId || "");
        const nextActive = n.data.nodeType === "agent" && activeAgentIds.has(aid);
        if (Boolean(n.data.isActive) === nextActive) return n;
        return { ...n, data: { ...n.data, isActive: nextActive } };
      })
    );
  }, [activeAgentIds, setNodes]);

  async function applyTemplate(template: string) {
    if (!template) return;
    setSpawningTpl(true);
    try {
      await apiFetch("/api/templates/apply", {
        method: "POST",
        body: JSON.stringify({ template }),
      });
      await loadAll();
      setSavedNotice("Team Kit spawned & wired!");
      setTimeout(() => setSavedNotice(""), 2500);
    } finally {
      setSpawningTpl(false);
    }
  }

  async function runAutoLayout() {
    await apiFetch("/api/topology/auto-layout", { method: "POST" });
    await loadAll();
    setSavedNotice("Auto-layout applied!");
    setTimeout(() => setSavedNotice(""), 2200);
  }

  async function exportBundle() {
    const bundle = await apiFetch<Record<string, unknown>>("/api/bundles/export?includeMainBrain=true");
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pandawa-brain-kit-${Date.now()}.pandawa.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSavedNotice("Exported .pandawa.json Brain Kit!");
    setTimeout(() => setSavedNotice(""), 2500);
  }

  async function importBundleFile(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text) as PreviewBundleData;
      if (!json || json.format !== "pandawa-bundle/v1") {
        window.alert("Invalid bundle file. Expected format: pandawa-bundle/v1");
        return;
      }
      setPreviewBundle(json);
    } catch (err) {
      window.alert(`Could not read bundle file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function confirmInstallBundle() {
    if (!previewBundle) return;
    setInstallingBundle(true);
    try {
      const res = await apiFetch<{ teamName: string; importedFiles: number }>("/api/bundles/import", {
        method: "POST",
        body: JSON.stringify(previewBundle),
      });
      setPreviewBundle(null);
      await loadAll();
      setSavedNotice(`Installed "${res.teamName}" (${res.importedFiles} files)!`);
      setTimeout(() => setSavedNotice(""), 3200);
    } catch (err) {
      window.alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstallingBundle(false);
    }
  }

  async function deleteTeamSquad(teamId: string) {
    if (!window.confirm("Delete this entire Team, its Team Brain, and its squad agents from Pandawa?")) return;
    await apiFetch(`/api/teams/${teamId}?cascade=true`, { method: "DELETE" });
    setSelectedNodeId(null);
    await loadAll();
    setSavedNotice("Removed team squad cleanly!");
    setTimeout(() => setSavedNotice(""), 2500);
  }

  const onConnect = useCallback(
    (connection: Connection) => {
      const srcNode = nodes.find((n) => n.id === connection.source);
      const dstNode = nodes.find((n) => n.id === connection.target);
      const { relation, label } = inferRelation(
        srcNode?.data.nodeType || "knowledge",
        dstNode?.data.nodeType || "agent"
      );
      const color = RELATION_COLORS[relation] || "#8b5cf6";
      const newEdge: Edge = {
        ...connection,
        id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: "smoothstep",
        label,
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
        animated: relation !== "peer_collab",
        zIndex: 15,
        data: { relation, permission: "read_write" },
        style: {
          stroke: color,
          strokeWidth: 2,
          strokeDasharray: relation === "peer_collab" ? "6 4" : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      };
      setEdges((eds) => addEdge(newEdge, eds));
      setDirty(true);
    },
    [nodes, setEdges]
  );

  async function saveTopology() {
    setSaving(true);
    try {
      const payloadNodes: TopologyNode[] = nodes.map((n) => ({
        id: n.id,
        type: n.data.nodeType as TopologyNode["type"],
        refId: n.data.refId || "",
        label: n.data.label || "Node",
        position: n.position,
        data: n.data,
      }));
      const payloadEdges: TopologyEdge[] = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || "",
        targetHandle: e.targetHandle || "",
        relation: String((e.data as Record<string, unknown>)?.relation || "brain_link"),
        permission: String((e.data as Record<string, unknown>)?.permission || "read_write"),
        label: String(e.label || ""),
        animated: Boolean(e.animated),
        data: (e.data as Record<string, unknown>) || {},
      }));

      await apiFetch("/api/topology", {
        method: "PUT",
        body: JSON.stringify({ nodes: payloadNodes, edges: payloadEdges }),
      });
      setDirty(false);
      setSavedNotice("Topology saved & live!");
      setTimeout(() => setSavedNotice(""), 2500);
    } finally {
      setSaving(false);
    }
  }

  async function addQuickNode(kind: TopologyNode["type"]) {
    const id = `node_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    const pos = { x: 240 + Math.round(Math.random() * 280), y: 200 + Math.round(Math.random() * 220) };

    if (kind === "agent") {
      const name = window.prompt("New Agent Name (e.g. Karna, Srikandi, DevOps Bot):", "Srikandi");
      if (!name) return;
      const created = await apiFetch<{ id: string; slug: string; name: string; title: string }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name, title: "Specialist Agent", avatar: "✨", purpose: "general" }),
      });
      setNodes((prev) => [
        ...prev,
        {
          id,
          type: "pandawa",
          position: pos,
          data: {
            nodeType: "agent",
            label: created.name,
            refId: created.id,
            agentId: created.id,
            avatar: "✨",
            role: created.title,
          },
        },
      ]);
      await loadAgentsOnly();
      setSelectedNodeId(id);
      setDirty(true);
      return;
    }

    if (kind === "main_brain" || kind === "team_brain") {
      const name = window.prompt(
        kind === "main_brain" ? "New Main Brain Name:" : "New Team Brain Name:",
        kind === "main_brain" ? "Enterprise Main Brain" : "Growth Team Brain"
      );
      if (!name) return;
      const created = await apiFetch<BrainItem>("/api/brains", {
        method: "POST",
        body: JSON.stringify({ name, layer: kind === "main_brain" ? "main" : "team" }),
      });
      setNodes((prev) => [
        ...prev,
        {
          id,
          type: "pandawa",
          position: pos,
          data: {
            nodeType: kind,
            label: created.name,
            refId: created.id,
            folderPath: created.folder_path,
            subtitle: created.folder_path,
          },
        },
      ]);
      setBrains((prev) => [...prev, created]);
      setSelectedNodeId(id);
      setDirty(true);
      return;
    }

    if (kind === "provider") {
      const first = providers[0];
      setNodes((prev) => [
        ...prev,
        {
          id,
          type: "pandawa",
          position: pos,
          data: {
            nodeType: "provider",
            label: first ? `${first.name} · ${first.defaultModel}` : "AI Model Node",
            refId: first?.id || "",
            providerId: first?.id || "",
            model: first?.defaultModel || "",
            purpose: "general",
          },
        },
      ]);
      setSelectedNodeId(id);
      setDirty(true);
      return;
    }

    if (kind === "knowledge") {
      const firstFile = fileChoices[0] || { path: "main-brain/soul.md", isFolder: false };
      setNodes((prev) => [
        ...prev,
        {
          id,
          type: "pandawa",
          position: pos,
          data: {
            nodeType: "knowledge",
            label: firstFile.path,
            refId: firstFile.path,
            path: firstFile.path,
            isFolder: firstFile.isFolder,
          },
        },
      ]);
      setSelectedNodeId(id);
      setDirty(true);
      return;
    }

    if (kind === "toolpack") {
      setNodes((prev) => [
        ...prev,
        {
          id,
          type: "pandawa",
          position: pos,
          data: {
            nodeType: "toolpack",
            label: "Workspace & Web Tools",
            refId: "custom_tools",
            packs: ["workspace", "web", "brain"],
          },
        },
      ]);
      setSelectedNodeId(id);
      setDirty(true);
    }
  }

  async function loadAgentsOnly() {
    const r = await apiFetch<{ agents: AgentItem[] }>("/api/agents");
    setAgents(r.agents);
  }

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) || null;
  const selectedAgent =
    selectedNode?.data.nodeType === "agent"
      ? agents.find((a) => a.id === selectedNode.data.refId || a.id === selectedNode.data.agentId)
      : null;

  function updateNodeData(nodeId: string, patch: Partial<PandawaNodeData>) {
    setNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n))
    );
    setDirty(true);
  }

  function updateEdgeData(edgeId: string, patch: { label?: string; relation?: string; permission?: string; animated?: boolean }) {
    setEdges((prev) =>
      prev.map((e) => {
        if (e.id !== edgeId) return e;
        const nextRel = patch.relation ?? String((e.data as Record<string, unknown>)?.relation || "brain_link");
        const nextPerm = patch.permission ?? String((e.data as Record<string, unknown>)?.permission || "read_write");
        const color = RELATION_COLORS[nextRel] || "#8b5cf6";
        return {
          ...e,
          label: patch.label ?? e.label,
          animated: patch.animated ?? e.animated,
          data: { ...(e.data || {}), relation: nextRel, permission: nextPerm },
          style: {
            stroke: color,
            strokeWidth: 2,
            strokeDasharray: nextRel === "peer_collab" ? "6 4" : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      })
    );
    setDirty(true);
  }

  async function saveSelectedAgent(patch: Partial<AgentItem>) {
    if (!selectedAgent) return;
    await apiFetch(`/api/agents/${selectedAgent.id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await loadAgentsOnly();
    if (selectedNode) {
      updateNodeData(selectedNode.id, {
        label: patch.name ?? selectedAgent.name,
        role: patch.title ?? selectedAgent.title,
        avatar: patch.avatar ?? selectedAgent.avatar,
        purpose: patch.purpose ?? selectedAgent.purpose,
      });
    }
  }

  async function inspectCompiledBrain(agentId: string) {
    if (dirty) await saveTopology();
    const res = await apiFetch<{
      agentName: string;
      model: string;
      summary: { totalFiles: number; totalChars: number; brainNames: string[]; mountedPaths: string[] };
      systemPrompt: string;
    }>(`/api/agents/${agentId}/compiled?teamId=team_pandawa`);
    setCompiledPreview(res);
  }

  function deleteSelected() {
    if (selectedNodeId) {
      setNodes((prev) => prev.filter((n) => n.id !== selectedNodeId));
      setEdges((prev) => prev.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
      setSelectedNodeId(null);
      setDirty(true);
    } else if (selectedEdgeId) {
      setEdges((prev) => prev.filter((e) => e.id !== selectedEdgeId));
      setSelectedEdgeId(null);
      setDirty(true);
    }
  }

  useEffect(() => {
    if (initialFocusTeamId) setFocusTeamId(initialFocusTeamId);
  }, [initialFocusTeamId]);

  // Compute filtered nodes/edges when focusing on a specific Team
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (focusTeamId === "all") return { visibleNodes: nodes, visibleEdges: edges };
    const team = teams.find((t) => t.id === focusTeamId);
    if (!team) return { visibleNodes: nodes, visibleEdges: edges };

    const keepIds = new Set<string>();
    const mainNodes = nodes.filter((n) => n.data.nodeType === "main_brain");
    for (const m of mainNodes) keepIds.add(m.id);

    const tbNodes = nodes.filter(
      (n) => n.data.nodeType === "team_brain" && (n.data.refId === team.team_brain_id || n.data.teamId === team.id)
    );
    for (const tb of tbNodes) keepIds.add(tb.id);

    // Include 2 hops from team brain (agents -> models, personal folders, toolpacks) + main brain knowledge mounts
    const frontier = new Set<string>([...tbNodes.map((n) => n.id)]);
    for (let hop = 0; hop < 2; hop++) {
      const next = new Set<string>();
      for (const e of edges) {
        if (frontier.has(e.source) && !keepIds.has(e.target)) {
          const targetNode = nodes.find((n) => n.id === e.target);
          if (targetNode && targetNode.data.nodeType !== "team_brain") {
            keepIds.add(e.target);
            next.add(e.target);
          }
        } else if (frontier.has(e.target) && !keepIds.has(e.source)) {
          const srcNode = nodes.find((n) => n.id === e.source);
          if (srcNode && srcNode.data.nodeType !== "team_brain") {
            keepIds.add(e.source);
            next.add(e.source);
          }
        }
      }
      frontier.clear();
      for (const x of next) frontier.add(x);
    }
    // Include knowledge nodes directly attached to Main Brain
    for (const e of edges) {
      if (mainNodes.some((m) => m.id === e.target)) {
        const s = nodes.find((n) => n.id === e.source);
        if (s?.data.nodeType === "knowledge") keepIds.add(s.id);
      }
      if (mainNodes.some((m) => m.id === e.source)) {
        const t = nodes.find((n) => n.id === e.target);
        if (t?.data.nodeType === "knowledge") keepIds.add(t.id);
      }
    }

    return {
      visibleNodes: nodes.filter((n) => keepIds.has(n.id)),
      visibleEdges: edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target)),
    };
  }, [focusTeamId, nodes, edges, teams]);

  return (
    <div className="flex flex-col h-screen bg-[#09090b]">
      {/* Top Action Palette (n8n style, wraps cleanly on narrow screens) */}
      <header className="min-h-14 px-4 py-2 bg-[#0c0c0e] border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-bold text-zinc-300 uppercase tracking-wider mr-1 hidden 2xl:inline">
            Add Node:
          </span>
          <button
            onClick={() => addQuickNode("main_brain")}
            className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Brain className="w-3.5 h-3.5" /> Main Brain
          </button>
          <button
            onClick={() => addQuickNode("team_brain")}
            className="px-2.5 py-1.5 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/35 text-violet-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Users className="w-3.5 h-3.5" /> Team Brain
          </button>
          <button
            onClick={() => addQuickNode("agent")}
            className="px-2.5 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/35 text-cyan-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <UserPlus className="w-3.5 h-3.5" /> Agent
          </button>
          <button
            onClick={() => addQuickNode("provider")}
            className="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Cpu className="w-3.5 h-3.5" /> AI Model
          </button>
          <button
            onClick={() => addQuickNode("knowledge")}
            className="px-2.5 py-1.5 rounded-lg bg-yellow-500/15 hover:bg-yellow-500/25 border border-yellow-500/35 text-yellow-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <FolderPlus className="w-3.5 h-3.5" /> File / Folder
          </button>
          <button
            onClick={() => addQuickNode("toolpack")}
            className="px-2.5 py-1.5 rounded-lg bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/35 text-pink-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Wrench className="w-3.5 h-3.5" /> Toolpack
          </button>
          <select
            disabled={spawningTpl}
            value=""
            onChange={(e) => {
              if (e.target.value) applyTemplate(e.target.value);
            }}
            className="px-2.5 py-1.5 rounded-lg bg-[#18181b] border border-white/[0.10] text-amber-300 text-xs font-medium cursor-pointer shrink-0"
          >
            <option value="">{spawningTpl ? "Spawning..." : "+ 1-Click Team Kit"}</option>
            <option value="software-squad">🚀 Software Engineering Squad</option>
            <option value="growth-squad">🎯 Growth & Content Squad</option>
            <option value="research-squad">🔭 Deep Research & Alpha Squad</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          {savedNotice && (
            <span className="text-xs text-emerald-400 flex items-center gap-1 mr-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {savedNotice}
            </span>
          )}
          <button
            onClick={runAutoLayout}
            title="Auto-arrange canvas cleanly"
            className="px-2.5 py-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] text-zinc-300 text-xs flex items-center gap-1 cursor-pointer"
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Arrange
          </button>
          <button
            onClick={exportBundle}
            title="Export commercial Brain & Team Kit (.pandawa.json — API keys stripped)"
            className="px-2.5 py-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] text-amber-300 text-xs flex items-center gap-1 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> Export Kit
          </button>
          <label
            title="Import .pandawa.json Brain & Team Kit"
            className="px-2.5 py-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] text-cyan-300 text-xs flex items-center gap-1 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" /> Import Kit
            <input
              type="file"
              accept=".json,.pandawa.json"
              className="hidden"
              onChange={(e) => {
                importBundleFile(e.target.files?.[0] || null);
                e.target.value = "";
              }}
            />
          </label>
          <button
            onClick={() => loadAll()}
            title="Reload topology"
            aria-label="Reload topology"
            className="p-2 rounded-lg bg-[#18181b] hover:bg-[#222227] text-zinc-300 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={saveTopology}
            disabled={saving}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              dirty
                ? "bg-amber-500 hover:bg-amber-400 text-zinc-950 shadow-lg shadow-amber-500/25"
                : "bg-[#18181b] hover:bg-[#222227] text-zinc-200 border border-white/[0.10]"
            }`}
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? "Saving..." : dirty ? "Save Changes*" : "Saved"}
          </button>
        </div>
      </header>

      {/* Team Focus Filter Strip (cleanly isolates any team when multiple squads exist) */}
      {teams.length > 1 && (
        <div className="px-4 py-1.5 bg-[#0c0c0e] border-b border-white/[0.06] flex items-center gap-1.5 overflow-x-auto text-[11px] shrink-0">
          <span className="text-zinc-500 font-semibold mr-1 shrink-0">Focus View:</span>
          <button
            onClick={() => setFocusTeamId("all")}
            className={`px-2.5 py-1 rounded-full border shrink-0 cursor-pointer transition ${
              focusTeamId === "all"
                ? "bg-amber-500/20 border-amber-500/50 text-amber-200 font-semibold"
                : "bg-[#16161a] border-white/[0.08] text-zinc-400 hover:text-zinc-200"
            }`}
          >
            All Teams ({teams.length})
          </button>
          {teams.map((t) => (
            <button
              key={t.id}
              onClick={() => setFocusTeamId(t.id)}
              className={`px-2.5 py-1 rounded-full border shrink-0 cursor-pointer transition ${
                focusTeamId === t.id
                  ? "bg-violet-500/20 border-violet-500/50 text-violet-200 font-semibold"
                  : "bg-[#16161a] border-white/[0.08] text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {/* Main Workspace: Canvas + Inspector */}
      <div className="flex-1 flex min-h-0 relative">
        <div className="flex-1 h-full relative">
          {showTip && (
            <div className="absolute top-3 left-3 z-20 max-w-md px-3 py-2 rounded-xl bg-[#0c0c0e]/92 backdrop-blur-md border border-white/[0.11] text-[11px] text-zinc-300 flex items-center justify-between gap-3 shadow-lg">
              <span>
                <strong className="text-amber-300">Tip:</strong> Drag from any dot handle to wire{" "}
                <strong>Brains</strong>, <strong>AI Models</strong>, or <code className="text-amber-200">soul.md</code>{" "}
                files. Click any node to edit.
              </span>
              <button
                aria-label="Dismiss tip"
                onClick={() => setShowTip(false)}
                className="text-zinc-500 hover:text-white shrink-0 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <ReactFlow
            nodes={visibleNodes}
            edges={visibleEdges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if (changes.some((c) => c.type === "position" || c.type === "remove")) setDirty(true);
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              if (changes.some((c) => c.type === "remove")) setDirty(true);
            }}
            onConnect={onConnect}
            onNodeClick={(_e, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_e, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.16 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#27272a" />
            <Controls />
            <MiniMap
              nodeColor={(n) => {
                const t = (n.data as PandawaNodeData)?.nodeType;
                if (t === "main_brain") return "#f59e0b";
                if (t === "team_brain") return "#8b5cf6";
                if (t === "agent") return "#06b6d4";
                if (t === "provider") return "#10b981";
                return "#eab308";
              }}
              maskColor="rgba(8, 10, 15, 0.75)"
            />
          </ReactFlow>

          {/* Bottom Legend */}
          <div
            className={`pointer-events-none absolute bottom-3 left-16 flex-wrap gap-2 bg-[#0c0c0e]/90 border border-white/[0.07] rounded-xl px-3 py-1.5 text-[11px] text-zinc-400 ${
              selectedNode || selectedEdge ? "hidden xl:flex" : "hidden sm:flex"
            }`}
          >
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-violet-500 inline-block" /> Brain Link</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-emerald-500 inline-block" /> AI Model</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-amber-500 inline-block" /> Knowledge Mount</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-cyan-400 inline-block" /> Peer Team</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-pink-500 inline-block" /> Toolpack</span>
          </div>
        </div>

        {/* Right Inspector Drawer */}
        {(selectedNode || selectedEdge) && (
          <aside className="w-80 shrink-0 bg-[#0c0c0e] border-l border-white/[0.08] flex flex-col h-full overflow-y-auto p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div className="text-xs font-bold uppercase tracking-wider text-amber-400">
                {selectedNode
                  ? `Inspect · ${String(selectedNode.data.nodeType || "node").replace(/_/g, " ")}`
                  : "Inspect Connection"}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={deleteSelected}
                  title="Remove from canvas"
                  aria-label="Remove from canvas"
                  className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-500/15 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button
                  aria-label="Close inspector"
                  onClick={() => {
                    setSelectedNodeId(null);
                    setSelectedEdgeId(null);
                  }}
                  className="p-1.5 rounded-lg text-zinc-400 hover:bg-[#18181b] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* NODE INSPECTOR */}
            {selectedNode && (
              <div className="space-y-3 text-xs">
                <div>
                  <label className="text-zinc-400 block mb-1">Display Label</label>
                  <input
                    value={selectedNode.data.label || ""}
                    onChange={(e) => updateNodeData(selectedNode.id, { label: e.target.value })}
                    className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2.5 py-2 text-zinc-100 outline-none focus:border-amber-500"
                  />
                </div>

                {/* AGENT CONFIG */}
                {selectedNode.data.nodeType === "agent" && selectedAgent && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-zinc-400 block mb-1">Avatar</label>
                        <input
                          value={selectedAgent.avatar}
                          onChange={(e) => saveSelectedAgent({ avatar: e.target.value })}
                          className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2.5 py-1.5 text-zinc-100"
                        />
                      </div>
                      <div>
                        <label className="text-zinc-400 block mb-1">Purpose</label>
                        <select
                          value={selectedAgent.purpose}
                          onChange={(e) => saveSelectedAgent({ purpose: e.target.value })}
                          className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2 py-1.5 text-zinc-100"
                        >
                          <option value="strategy">Strategy</option>
                          <option value="coding">Coding</option>
                          <option value="execution">Execution</option>
                          <option value="research">Research</option>
                          <option value="review">Review / QA</option>
                          <option value="creative">Creative</option>
                          <option value="general">General</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="text-zinc-400 block mb-1">Role / Title</label>
                      <input
                        value={selectedAgent.title}
                        onChange={(e) => saveSelectedAgent({ title: e.target.value })}
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2.5 py-1.5 text-zinc-100"
                      />
                    </div>

                    <div>
                      <label className="text-zinc-400 block mb-1">Assigned AI Provider</label>
                      <select
                        value={selectedAgent.provider_id || ""}
                        onChange={(e) => {
                          const prov = providers.find((p) => p.id === e.target.value);
                          saveSelectedAgent({
                            provider_id: e.target.value || null,
                            model: prov?.defaultModel || selectedAgent.model,
                          });
                        }}
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2 py-1.5 text-zinc-100"
                      >
                        <option value="">(Use wired Provider Node)</option>
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} {p.hasApiKey ? "✓" : "(no key)"}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-zinc-400 block mb-1">Model ID</label>
                      <input
                        list={`models_${selectedAgent.id}`}
                        value={selectedAgent.model}
                        onChange={(e) => saveSelectedAgent({ model: e.target.value })}
                        placeholder="e.g. gpt-4.1, claude-sonnet-4-20250514"
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                      />
                      <datalist id={`models_${selectedAgent.id}`}>
                        {(providers.find((p) => p.id === selectedAgent.provider_id)?.models || []).map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </div>

                    <div>
                      <label className="text-zinc-400 block mb-1">
                        Max Autonomous Steps ({selectedAgent.max_iterations || 35} steps/turn)
                      </label>
                      <input
                        type="range"
                        min={5}
                        max={100}
                        step={5}
                        value={selectedAgent.max_iterations || 35}
                        onChange={(e) => saveSelectedAgent({ max_iterations: Number(e.target.value) })}
                        className="w-full accent-amber-400"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-500">
                        <span>5 (quick)</span>
                        <span>35 (deep build)</span>
                        <span>100 (autonomous)</span>
                      </div>
                    </div>

                    <div>
                      <label className="text-zinc-400 block mb-1.5">Enabled Tool Packs (44+ Built-In Tools)</label>
                      <div className="grid grid-cols-2 gap-1.5 bg-[#0c0c0e] border border-white/[0.08] rounded-xl p-2.5">
                        {[
                          { id: "brain", label: "Brain & FTS5" },
                          { id: "team", label: "Team & Chat" },
                          { id: "workspace", label: "Files & Docs" },
                          { id: "terminal", label: "Shared PTY" },
                          { id: "shell", label: "Shell & Code" },
                          { id: "web", label: "Web Search" },
                          { id: "browser", label: "Playwright" },
                          { id: "automation", label: "Cron & Bots" },
                        ].map((pk) => {
                          const checked = selectedAgent.toolPacks.includes(pk.id);
                          return (
                            <label key={pk.id} className="flex items-center gap-1.5 text-[11px] text-zinc-200 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  const next = checked
                                    ? selectedAgent.toolPacks.filter((x) => x !== pk.id)
                                    : [...selectedAgent.toolPacks, pk.id];
                                  saveSelectedAgent({ toolPacks: next });
                                }}
                                className="accent-cyan-400"
                              />
                              <span className="truncate">{pk.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="text-zinc-400 block mb-1">System Prompt Override</label>
                      <textarea
                        rows={4}
                        value={selectedAgent.system_prompt}
                        onChange={(e) => saveSelectedAgent({ system_prompt: e.target.value })}
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2.5 py-2 text-zinc-100 outline-none focus:border-amber-500"
                      />
                    </div>

                    <div className="pt-2 flex flex-col gap-2">
                      <button
                        onClick={() => inspectCompiledBrain(selectedAgent.id)}
                        className="w-full py-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/35 text-cyan-300 font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" /> Inspect Compiled Brain
                      </button>
                      <button
                        onClick={() => onOpenBrainFile(`agents/${selectedAgent.slug}/soul.md`)}
                        className="w-full py-2 rounded-lg bg-[#18181b] hover:bg-[#222227] text-zinc-200 font-medium flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> Edit Agent soul.md
                      </button>
                    </div>
                  </>
                )}

                {/* PROVIDER NODE CONFIG */}
                {selectedNode.data.nodeType === "provider" && (
                  <>
                    <div>
                      <label className="text-zinc-400 block mb-1">AI Provider</label>
                      <select
                        value={String(selectedNode.data.providerId || selectedNode.data.refId || "")}
                        onChange={(e) => {
                          const p = providers.find((x) => x.id === e.target.value);
                          if (p) {
                            updateNodeData(selectedNode.id, {
                              providerId: p.id,
                              refId: p.id,
                              model: p.defaultModel,
                              label: `${p.name} · ${p.defaultModel}`,
                            });
                          }
                        }}
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2 py-2 text-zinc-100"
                      >
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.kind})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-zinc-400 block mb-1">Model Name</label>
                      <input
                        value={String(selectedNode.data.model || "")}
                        onChange={(e) => updateNodeData(selectedNode.id, { model: e.target.value })}
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2.5 py-2 font-mono text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="text-zinc-400 block mb-1">Purpose Tag</label>
                      <input
                        value={String(selectedNode.data.purpose || "")}
                        onChange={(e) => updateNodeData(selectedNode.id, { purpose: e.target.value })}
                        placeholder="Strategy, Coding, Research..."
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2.5 py-2 text-zinc-100"
                      />
                    </div>
                  </>
                )}

                {/* KNOWLEDGE FILE/FOLDER NODE CONFIG */}
                {selectedNode.data.nodeType === "knowledge" && (
                  <>
                    <div>
                      <label className="text-zinc-400 block mb-1">Mounted File or Folder</label>
                      <select
                        value={String(selectedNode.data.path || selectedNode.data.refId || "")}
                        onChange={(e) => {
                          const chosen = fileChoices.find((f) => f.path === e.target.value);
                          updateNodeData(selectedNode.id, {
                            path: e.target.value,
                            refId: e.target.value,
                            label: e.target.value,
                            isFolder: chosen?.isFolder ?? false,
                          });
                        }}
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2 py-2 font-mono text-zinc-100"
                      >
                        {fileChoices.map((f) => (
                          <option key={f.path} value={f.path}>
                            {f.isFolder ? "📁 " : "📄 "}
                            {f.path}
                          </option>
                        ))}
                      </select>
                    </div>
                    {!selectedNode.data.isFolder && selectedNode.data.path && (
                      <button
                        onClick={() => onOpenBrainFile(String(selectedNode.data.path))}
                        className="w-full py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> Open in Brain Editor
                      </button>
                    )}
                  </>
                )}

                {/* MAIN / TEAM BRAIN NODE CONFIG */}
                {(selectedNode.data.nodeType === "main_brain" || selectedNode.data.nodeType === "team_brain") && (
                  <>
                    <div>
                      <label className="text-zinc-400 block mb-1">Linked Brain</label>
                      <select
                        value={selectedNode.data.refId || ""}
                        onChange={(e) => {
                          const b = brains.find((x) => x.id === e.target.value);
                          if (b) {
                            updateNodeData(selectedNode.id, {
                              refId: b.id,
                              label: b.name,
                              folderPath: b.folder_path,
                            });
                          }
                        }}
                        className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2 py-2 text-zinc-100"
                      >
                        {brains.map((b) => (
                          <option key={b.id} value={b.id}>
                            [{b.layer.toUpperCase()}] {b.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="p-2.5 rounded-lg bg-[#0c0c0e] border border-white/[0.08] text-[11px] text-zinc-400">
                      Folder: <code className="text-amber-300">{String(selectedNode.data.folderPath || "")}</code>
                    </div>
                    <button
                      onClick={() =>
                        onOpenBrainFile(`${String(selectedNode.data.folderPath || "main-brain")}/soul.md`)
                      }
                      className="w-full py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <ExternalLink className="w-3.5 h-3.5" /> Manage Brain Folder
                    </button>
                    {selectedNode.data.nodeType === "team_brain" &&
                      typeof selectedNode.data.teamId === "string" &&
                      selectedNode.data.teamId !== "team_pandawa" && (
                        <button
                          onClick={() => deleteTeamSquad(String(selectedNode.data.teamId))}
                          className="w-full py-2 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-300 font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Delete Entire Squad
                        </button>
                      )}
                  </>
                )}

                {/* TOOLPACK CONFIG */}
                {selectedNode.data.nodeType === "toolpack" && (
                  <div>
                    <label className="text-zinc-400 block mb-2">Included Tool Packs</label>
                    <div className="space-y-1.5">
                      {["brain", "team", "workspace", "terminal", "shell", "web", "browser", "automation"].map((pk) => {
                        const current = Array.isArray(selectedNode.data.packs)
                          ? (selectedNode.data.packs as string[])
                          : [];
                        const checked = current.includes(pk);
                        return (
                          <label key={pk} className="flex items-center gap-2 text-zinc-200 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const next = checked
                                  ? current.filter((x) => x !== pk)
                                  : [...current, pk];
                                updateNodeData(selectedNode.id, { packs: next });
                              }}
                              className="accent-pink-500"
                            />
                            <span className="capitalize">{pk}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* EDGE INSPECTOR */}
            {selectedEdge && (
              <div className="space-y-3 text-xs">
                <div>
                  <label className="text-zinc-400 block mb-1">Connection Label</label>
                  <input
                    value={String(selectedEdge.label || "")}
                    onChange={(e) => updateEdgeData(selectedEdge.id, { label: e.target.value })}
                    className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2.5 py-2 text-zinc-100"
                  />
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">Connection Type</label>
                  <select
                    value={String((selectedEdge.data as Record<string, unknown>)?.relation || "brain_link")}
                    onChange={(e) => updateEdgeData(selectedEdge.id, { relation: e.target.value })}
                    className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2 py-2 text-zinc-100"
                  >
                    <option value="brain_link">Brain Link (Main ↔ Team ↔ Agent)</option>
                    <option value="model_binding">AI Model Binding</option>
                    <option value="knowledge_mount">Knowledge File / Folder Mount</option>
                    <option value="peer_collab">Peer Team Collaboration</option>
                    <option value="tool_grant">Toolpack Grant</option>
                  </select>
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">Brain Permission</label>
                  <select
                    value={String((selectedEdge.data as Record<string, unknown>)?.permission || "read_write")}
                    onChange={(e) => updateEdgeData(selectedEdge.id, { permission: e.target.value })}
                    className="w-full bg-[#0c0c0e] border border-white/[0.10] rounded-lg px-2 py-2 text-zinc-100"
                  >
                    <option value="read">Read Only</option>
                    <option value="read_write">Read & Write</option>
                    <option value="sync">Full Sync (Inherit + Update)</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-zinc-300 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedEdge.animated)}
                    onChange={(e) => updateEdgeData(selectedEdge.id, { animated: e.target.checked })}
                    className="accent-amber-500"
                  />
                  Animated data flow
                </label>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Compiled Brain Inspector Modal */}
      {compiledPreview && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#111113] border border-white/[0.10] rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
            <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Compiled Live Brain — {compiledPreview.agentName}
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Model: <code className="text-emerald-300">{compiledPreview.model || "unset"}</code> ·{" "}
                  {compiledPreview.summary.totalFiles} files · {compiledPreview.summary.totalChars.toLocaleString()} chars
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(compiledPreview.systemPrompt).catch(() => {});
                    setSavedNotice("Compiled Brain prompt copied!");
                    setTimeout(() => setSavedNotice(""), 2000);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-[#18181b] hover:bg-[#222227] text-zinc-200 text-xs flex items-center gap-1 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy Prompt
                </button>
                <button
                  aria-label="Close compiled brain preview"
                  onClick={() => setCompiledPreview(null)}
                  className="p-1.5 rounded-lg hover:bg-[#18181b] text-zinc-400 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="p-4 border-b border-white/[0.07] flex flex-wrap gap-2 text-[11px]">
              {compiledPreview.summary.brainNames.map((b) => (
                <span key={b} className="px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                  Brain: {b}
                </span>
              ))}
              {compiledPreview.summary.mountedPaths.map((p) => (
                <span key={p} className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  Mount: {p}
                </span>
              ))}
            </div>
            <pre className="flex-1 overflow-auto p-5 text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed">
              {compiledPreview.systemPrompt}
            </pre>
          </div>
        </div>
      )}
      <BundlePreviewModal
        bundle={previewBundle}
        installing={installingBundle}
        onCancel={() => setPreviewBundle(null)}
        onConfirmInstall={confirmInstallBundle}
      />
    </div>
  );
};

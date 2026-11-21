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
import type { AgentItem, BrainItem, BrainTreeNode, ProviderItem, TopologyEdge, TopologyNode } from "../../types";
import { PandawaNode, type PandawaNodeData } from "./PandawaNode";

interface BrainCanvasProps {
  onOpenBrainFile: (filePath: string) => void;
  activeAgentIds: Set<string>;
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

export const BrainCanvas: React.FC<BrainCanvasProps> = ({ onOpenBrainFile, activeAgentIds }) => {
  const nodeTypes = useMemo(() => ({ pandawa: PandawaNode }), []);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PandawaNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [spawningTpl, setSpawningTpl] = useState(false);

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
    const [topoRes, agentsRes, brainsRes, provRes, treeRes] = await Promise.all([
      apiFetch<{ nodes: TopologyNode[]; edges: TopologyEdge[] }>("/api/topology"),
      apiFetch<{ agents: AgentItem[] }>("/api/agents"),
      apiFetch<{ brains: BrainItem[] }>("/api/brains"),
      apiFetch<{ providers: ProviderItem[] }>("/api/providers"),
      apiFetch<{ tree: BrainTreeNode[] }>("/api/files/tree"),
    ]);

    setAgents(agentsRes.agents);
    setBrains(brainsRes.brains);
    setProviders(provRes.providers);
    setFileChoices(flattenTree(treeRes.tree));

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
      const json = JSON.parse(text);
      const res = await apiFetch<{ teamName: string; importedFiles: number }>("/api/bundles/import", {
        method: "POST",
        body: JSON.stringify(json),
      });
      await loadAll();
      setSavedNotice(`Imported "${res.teamName}" (${res.importedFiles} files)!`);
      setTimeout(() => setSavedNotice(""), 3200);
    } catch (err) {
      window.alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  return (
    <div className="flex flex-col h-screen bg-[#080a0f]">
      {/* Top Action Palette (n8n style, wraps cleanly on narrow screens) */}
      <header className="min-h-14 px-4 py-2 bg-[#0d111b] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-bold text-slate-300 uppercase tracking-wider mr-1 hidden 2xl:inline">
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
            className="px-2.5 py-1.5 rounded-lg bg-slate-800/90 border border-slate-700 text-amber-300 text-xs font-medium cursor-pointer shrink-0"
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
            className="px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1 cursor-pointer"
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Arrange
          </button>
          <button
            onClick={exportBundle}
            title="Export commercial Brain & Team Kit (.pandawa.json — API keys stripped)"
            className="px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-amber-300 text-xs flex items-center gap-1 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> Export Kit
          </button>
          <label
            title="Import .pandawa.json Brain & Team Kit"
            className="px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-cyan-300 text-xs flex items-center gap-1 cursor-pointer"
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
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={saveTopology}
            disabled={saving}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              dirty
                ? "bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-lg shadow-amber-500/25"
                : "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            }`}
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? "Saving..." : dirty ? "Save Changes*" : "Saved"}
          </button>
        </div>
      </header>

      {/* Main Workspace: Canvas + Inspector */}
      <div className="flex-1 flex min-h-0 relative">
        <div className="flex-1 h-full">
          <ReactFlow
            nodes={nodes}
            edges={edges}
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
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1e293b" />
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
          <div className="pointer-events-none absolute bottom-3 left-16 flex flex-wrap gap-2 bg-[#0d111b]/90 border border-slate-800/80 rounded-xl px-3 py-1.5 text-[11px] text-slate-400">
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-violet-500 inline-block" /> Brain Link</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-emerald-500 inline-block" /> AI Model</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-amber-500 inline-block" /> Knowledge Mount</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-cyan-400 inline-block" /> Peer Team</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-0.5 bg-pink-500 inline-block" /> Toolpack</span>
          </div>
        </div>

        {/* Right Inspector Drawer */}
        {(selectedNode || selectedEdge) && (
          <aside className="w-80 shrink-0 bg-[#0d111b] border-l border-slate-800/90 flex flex-col h-full overflow-y-auto p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
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
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* NODE INSPECTOR */}
            {selectedNode && (
              <div className="space-y-3 text-xs">
                <div>
                  <label className="text-slate-400 block mb-1">Display Label</label>
                  <input
                    value={selectedNode.data.label || ""}
                    onChange={(e) => updateNodeData(selectedNode.id, { label: e.target.value })}
                    className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2.5 py-2 text-slate-100 outline-none focus:border-amber-500"
                  />
                </div>

                {/* AGENT CONFIG */}
                {selectedNode.data.nodeType === "agent" && selectedAgent && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-slate-400 block mb-1">Avatar</label>
                        <input
                          value={selectedAgent.avatar}
                          onChange={(e) => saveSelectedAgent({ avatar: e.target.value })}
                          className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
                        />
                      </div>
                      <div>
                        <label className="text-slate-400 block mb-1">Purpose</label>
                        <select
                          value={selectedAgent.purpose}
                          onChange={(e) => saveSelectedAgent({ purpose: e.target.value })}
                          className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2 py-1.5 text-slate-100"
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
                      <label className="text-slate-400 block mb-1">Role / Title</label>
                      <input
                        value={selectedAgent.title}
                        onChange={(e) => saveSelectedAgent({ title: e.target.value })}
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="text-slate-400 block mb-1">Assigned AI Provider</label>
                      <select
                        value={selectedAgent.provider_id || ""}
                        onChange={(e) => {
                          const prov = providers.find((p) => p.id === e.target.value);
                          saveSelectedAgent({
                            provider_id: e.target.value || null,
                            model: prov?.defaultModel || selectedAgent.model,
                          });
                        }}
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2 py-1.5 text-slate-100"
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
                      <label className="text-slate-400 block mb-1">Model ID</label>
                      <input
                        value={selectedAgent.model}
                        onChange={(e) => saveSelectedAgent({ model: e.target.value })}
                        placeholder="e.g. gpt-4.1, claude-sonnet-4-20250514"
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2.5 py-1.5 font-mono text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="text-slate-400 block mb-1">System Prompt Override</label>
                      <textarea
                        rows={4}
                        value={selectedAgent.system_prompt}
                        onChange={(e) => saveSelectedAgent({ system_prompt: e.target.value })}
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2.5 py-2 text-slate-100 outline-none focus:border-amber-500"
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
                        className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium flex items-center justify-center gap-1.5 cursor-pointer"
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
                      <label className="text-slate-400 block mb-1">AI Provider</label>
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
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2 py-2 text-slate-100"
                      >
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.kind})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-slate-400 block mb-1">Model Name</label>
                      <input
                        value={String(selectedNode.data.model || "")}
                        onChange={(e) => updateNodeData(selectedNode.id, { model: e.target.value })}
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2.5 py-2 font-mono text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="text-slate-400 block mb-1">Purpose Tag</label>
                      <input
                        value={String(selectedNode.data.purpose || "")}
                        onChange={(e) => updateNodeData(selectedNode.id, { purpose: e.target.value })}
                        placeholder="Strategy, Coding, Research..."
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2.5 py-2 text-slate-100"
                      />
                    </div>
                  </>
                )}

                {/* KNOWLEDGE FILE/FOLDER NODE CONFIG */}
                {selectedNode.data.nodeType === "knowledge" && (
                  <>
                    <div>
                      <label className="text-slate-400 block mb-1">Mounted File or Folder</label>
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
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2 py-2 font-mono text-slate-100"
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
                      <label className="text-slate-400 block mb-1">Linked Brain</label>
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
                        className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2 py-2 text-slate-100"
                      >
                        {brains.map((b) => (
                          <option key={b.id} value={b.id}>
                            [{b.layer.toUpperCase()}] {b.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="p-2.5 rounded-lg bg-[#090c14] border border-slate-800 text-[11px] text-slate-400">
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
                  </>
                )}

                {/* TOOLPACK CONFIG */}
                {selectedNode.data.nodeType === "toolpack" && (
                  <div>
                    <label className="text-slate-400 block mb-2">Included Tool Packs</label>
                    <div className="space-y-1.5">
                      {["brain", "team", "workspace", "shell", "web"].map((pk) => {
                        const current = Array.isArray(selectedNode.data.packs)
                          ? (selectedNode.data.packs as string[])
                          : [];
                        const checked = current.includes(pk);
                        return (
                          <label key={pk} className="flex items-center gap-2 text-slate-200 cursor-pointer">
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
                  <label className="text-slate-400 block mb-1">Connection Label</label>
                  <input
                    value={String(selectedEdge.label || "")}
                    onChange={(e) => updateEdgeData(selectedEdge.id, { label: e.target.value })}
                    className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2.5 py-2 text-slate-100"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Connection Type</label>
                  <select
                    value={String((selectedEdge.data as Record<string, unknown>)?.relation || "brain_link")}
                    onChange={(e) => updateEdgeData(selectedEdge.id, { relation: e.target.value })}
                    className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2 py-2 text-slate-100"
                  >
                    <option value="brain_link">Brain Link (Main ↔ Team ↔ Agent)</option>
                    <option value="model_binding">AI Model Binding</option>
                    <option value="knowledge_mount">Knowledge File / Folder Mount</option>
                    <option value="peer_collab">Peer Team Collaboration</option>
                    <option value="tool_grant">Toolpack Grant</option>
                  </select>
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Brain Permission</label>
                  <select
                    value={String((selectedEdge.data as Record<string, unknown>)?.permission || "read_write")}
                    onChange={(e) => updateEdgeData(selectedEdge.id, { permission: e.target.value })}
                    className="w-full bg-[#090c14] border border-slate-700 rounded-lg px-2 py-2 text-slate-100"
                  >
                    <option value="read">Read Only</option>
                    <option value="read_write">Read & Write</option>
                    <option value="sync">Full Sync (Inherit + Update)</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer pt-1">
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
          <div className="bg-[#0e1320] border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Compiled Live Brain — {compiledPreview.agentName}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
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
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy Prompt
                </button>
                <button
                  aria-label="Close compiled brain preview"
                  onClick={() => setCompiledPreview(null)}
                  className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="p-4 border-b border-slate-800/80 flex flex-wrap gap-2 text-[11px]">
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
            <pre className="flex-1 overflow-auto p-5 text-xs font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
              {compiledPreview.systemPrompt}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

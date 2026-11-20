import React, { useCallback, useEffect, useState } from "react";
import {
  Folder,
  FolderOpen,
  FileText,
  FilePlus,
  FolderPlus,
  Save,
  Trash2,
  Search,
  Pin,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Edit3,
} from "lucide-react";
import { apiFetch } from "../../api/client";
import type { BrainTreeNode, TopologyEdge, TopologyNode } from "../../types";

interface BrainExplorerProps {
  initialFilePath?: string | null;
  onPinnedToCanvas: () => void;
}

export const BrainExplorer: React.FC<BrainExplorerProps> = ({ initialFilePath, onPinnedToCanvas }) => {
  const [tree, setTree] = useState<BrainTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(["main-brain", "teams", "teams/pandawa-core", "agents"])
  );
  const [activeFile, setActiveFile] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ rel_path: string; title: string; snippet: string }>>([]);

  const loadTree = useCallback(async () => {
    const res = await apiFetch<{ tree: BrainTreeNode[] }>("/api/files/tree");
    setTree(res.tree);
  }, []);

  const openFile = useCallback(async (relPath: string) => {
    try {
      const res = await apiFetch<{ path: string; content: string }>(
        `/api/files/read?path=${encodeURIComponent(relPath)}`
      );
      setActiveFile(res.path);
      setContent(res.content);
      setDirty(false);
    } catch {
      // Fallback: if file does not exist, open main-brain/soul.md
      try {
        const fb = await apiFetch<{ path: string; content: string }>(
          `/api/files/read?path=${encodeURIComponent("main-brain/soul.md")}`
        );
        setActiveFile(fb.path);
        setContent(fb.content);
        setDirty(false);
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    loadTree().catch(() => {});
  }, [loadTree]);

  useEffect(() => {
    if (initialFilePath) {
      openFile(initialFilePath);
    } else if (!activeFile) {
      openFile("main-brain/soul.md");
    }
  }, [initialFilePath, activeFile, openFile]);

  async function saveCurrentFile() {
    if (!activeFile) return;
    setSaving(true);
    try {
      await apiFetch("/api/files/write", {
        method: "POST",
        body: JSON.stringify({ path: activeFile, content }),
      });
      setDirty(false);
      setNotice("Saved & indexed in FTS5");
      setTimeout(() => setNotice(""), 2200);
      await loadTree();
    } finally {
      setSaving(false);
    }
  }

  async function createNewFile(prefix = "") {
    const suggested = prefix ? `${prefix}/soul.md` : "custom-brain/soul.md";
    const rel = window.prompt("Enter file path (e.g. agents/karna/soul.md or custom/rules.md):", suggested);
    if (!rel) return;
    await apiFetch("/api/files/write", {
      method: "POST",
      body: JSON.stringify({ path: rel, content: `# ${rel}\n\n` }),
    });
    await loadTree();
    await openFile(rel);
  }

  async function createNewFolder(withStarter: boolean) {
    const rel = window.prompt(
      withStarter
        ? "Create complete Brain Folder (auto-includes soul.md, rules.md, memory.md):"
        : "Create empty folder path:",
      "custom-team"
    );
    if (!rel) return;
    await apiFetch("/api/files/folder", {
      method: "POST",
      body: JSON.stringify({ path: rel, withStarterFiles: withStarter }),
    });
    setExpanded((prev) => new Set([...prev, rel]));
    await loadTree();
    if (withStarter) {
      await openFile(`${rel}/soul.md`);
    }
  }

  async function handleRename(oldPath: string) {
    const next = window.prompt("Rename / Move path to:", oldPath);
    if (!next || next === oldPath) return;
    await apiFetch("/api/files/rename", {
      method: "POST",
      body: JSON.stringify({ from: oldPath, to: next }),
    });
    if (activeFile === oldPath) setActiveFile(next);
    await loadTree();
  }

  async function handleDelete(relPath: string) {
    if (!window.confirm(`Delete "${relPath}" permanently?`)) return;
    await apiFetch(`/api/files/entry?path=${encodeURIComponent(relPath)}`, { method: "DELETE" });
    if (activeFile === relPath) {
      setActiveFile("");
      setContent("");
    }
    await loadTree();
  }

  async function pinToCanvas(relPath: string, isFolder: boolean) {
    const topo = await apiFetch<{ nodes: TopologyNode[]; edges: TopologyEdge[] }>("/api/topology");
    const newNode: TopologyNode = {
      id: `node_know_${Date.now()}`,
      type: "knowledge",
      refId: relPath,
      label: relPath,
      position: { x: 160 + Math.round(Math.random() * 240), y: 260 + Math.round(Math.random() * 180) },
      data: { path: relPath, isFolder, color: "#f59e0b" },
    };
    await apiFetch("/api/topology", {
      method: "PUT",
      body: JSON.stringify({ nodes: [...topo.nodes, newNode], edges: topo.edges }),
    });
    setNotice(`Pinned "${relPath}" to Brain Canvas!`);
    setTimeout(() => setNotice(""), 2500);
    onPinnedToCanvas();
  }

  async function runSearch(q: string) {
    setSearchQuery(q);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    const res = await apiFetch<{ results: Array<{ rel_path: string; title: string; snippet: string }> }>(
      `/api/files/search?q=${encodeURIComponent(q)}`
    );
    setSearchResults(res.results);
  }

  function renderTree(nodes: BrainTreeNode[], depth = 0) {
    return nodes.map((node) => {
      const isOpen = expanded.has(node.path);
      const isSelected = activeFile === node.path;
      return (
        <div key={node.path}>
          <div
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            className={`group flex items-center justify-between pr-2 py-1.5 rounded-lg text-xs cursor-pointer transition ${
              isSelected
                ? "bg-amber-500/15 text-amber-300 font-medium"
                : "text-slate-300 hover:bg-slate-800/60"
            }`}
            onClick={() => {
              if (node.type === "folder") {
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                });
              } else {
                openFile(node.path);
              }
            }}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {node.type === "folder" ? (
                <>
                  {isOpen ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  )}
                  {isOpen ? (
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0" />
                  <FileText className="w-3.5 h-3.5 text-cyan-400/90 shrink-0" />
                </>
              )}
              <span className="truncate">{node.name}</span>
            </div>

            <div
              className="hidden group-hover:flex items-center gap-0.5 shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {node.type === "folder" && (
                <button
                  title="New file in folder"
                  onClick={() => createNewFile(node.path)}
                  className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                >
                  <FilePlus className="w-3 h-3" />
                </button>
              )}
              <button
                title="Pin to Brain Canvas"
                onClick={() => pinToCanvas(node.path, node.type === "folder")}
                className="p-1 rounded hover:bg-amber-500/20 text-amber-400"
              >
                <Pin className="w-3 h-3" />
              </button>
              <button
                title="Rename"
                onClick={() => handleRename(node.path)}
                className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
              >
                <Edit3 className="w-3 h-3" />
              </button>
              <button
                title="Delete"
                onClick={() => handleDelete(node.path)}
                className="p-1 rounded hover:bg-rose-500/20 text-rose-400"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
          {node.type === "folder" && isOpen && node.children && renderTree(node.children, depth + 1)}
        </div>
      );
    });
  }

  return (
    <div className="flex h-screen bg-[#080a0f]">
      {/* Left Explorer Pane */}
      <div className="w-80 shrink-0 bg-[#0d111b] border-r border-slate-800/80 flex flex-col">
        <div className="p-3.5 border-b border-slate-800/80 space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Brain Files & Folders
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => createNewFile("")}
                title="New File (e.g. soul.md)"
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
              >
                <FilePlus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => createNewFolder(true)}
                title="New Complete Brain Folder (soul.md + rules.md + memory.md)"
                className="px-2 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" /> + Brain Kit
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={searchQuery}
              onChange={(e) => runSearch(e.target.value)}
              placeholder="FTS5 search across all Brain files..."
              className="w-full bg-[#080a0f] border border-slate-800 focus:border-amber-500 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-slate-200 outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {searchQuery.trim() ? (
            <div className="space-y-1.5 p-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 px-1">
                Search Results ({searchResults.length})
              </div>
              {searchResults.map((r) => (
                <button
                  key={r.rel_path}
                  onClick={() => openFile(r.rel_path)}
                  className="w-full text-left p-2 rounded-lg bg-[#090c14] hover:bg-slate-800/80 border border-slate-800 cursor-pointer"
                >
                  <div className="text-xs font-mono text-amber-300 truncate">{r.rel_path}</div>
                  <div className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">{r.snippet}</div>
                </button>
              ))}
              {searchResults.length === 0 && (
                <div className="text-xs text-slate-500 p-2">No matches found.</div>
              )}
            </div>
          ) : (
            renderTree(tree)
          )}
        </div>
      </div>

      {/* Right Code / Markdown Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 px-4 bg-[#0d111b] border-b border-slate-800/80 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-mono text-amber-300 truncate">
              {activeFile || "Select or create a Brain file"}
              {dirty && <span className="text-rose-400 ml-1.5">● unsaved</span>}
            </div>
            <div className="text-[11px] text-slate-500">
              Changes immediately update live Agent context & SQLite FTS5 search
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {notice && (
              <span className="text-xs text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> {notice}
              </span>
            )}
            {activeFile && (
              <button
                onClick={() => pinToCanvas(activeFile, false)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <Pin className="w-3.5 h-3.5 text-amber-400" /> Pin to Canvas
              </button>
            )}
            <button
              onClick={saveCurrentFile}
              disabled={!activeFile || saving}
              className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" /> {saving ? "Saving..." : "Save (Ctrl+S)"}
            </button>
          </div>
        </div>

        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              saveCurrentFile();
            }
          }}
          spellCheck={false}
          placeholder="Write soul.md, rules.md, team charter, SOPs, or custom markdown instructions..."
          className="flex-1 w-full bg-[#080a0f] text-slate-100 font-mono text-sm p-6 outline-none resize-none leading-relaxed"
        />
      </div>
    </div>
  );
};

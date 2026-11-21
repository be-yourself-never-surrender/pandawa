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
  Upload,
  FolderUp,
  Eye,
  Code,
  PanelLeft,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { apiFetch } from "../../api/client";
import type { BrainTreeNode, TopologyEdge, TopologyNode } from "../../types";
import { MarkdownView } from "../MarkdownView";

interface BrainExplorerProps {
  initialFilePath?: string | null;
  onPinnedToCanvas: () => void;
}

export const BrainExplorer: React.FC<BrainExplorerProps> = ({ initialFilePath, onPinnedToCanvas }) => {
  const [tree, setTree] = useState<BrainTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(["main-brain", "teams", "teams/pandawa-core", "agents"])
  );
  const [showTree, setShowTree] = useState(true);
  const [viewMode, setViewMode] = useState<"edit" | "split" | "preview">("edit");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadFolder, setUploadFolder] = useState("main-brain");
  const [activeFile, setActiveFile] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"fts" | "semantic">("semantic");
  const [searchResults, setSearchResults] = useState<Array<{ rel_path: string; title: string; snippet: string }>>([]);
  const [semanticResults, setSemanticResults] = useState<
    Array<{ sourceType: string; path: string; title: string; score: number; excerpt: string }>
  >([]);
  const [semanticInfo, setSemanticInfo] = useState<{ totalChunks: number; mode: string } | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [linkGraph, setLinkGraph] = useState<
    Record<string, { outgoing: string[]; backlinks: string[] }>
  >({});

  const loadTree = useCallback(async () => {
    const [res, gRes, sRes] = await Promise.all([
      apiFetch<{ tree: BrainTreeNode[] }>("/api/files/tree"),
      apiFetch<{ files: Array<{ path: string; outgoing: string[]; backlinks: string[] }> }>("/api/files/graph").catch(
        () => ({ files: [] })
      ),
      apiFetch<{ totalChunks?: number; mode?: string }>("/api/brain/semantic/status").catch(() => null),
    ]);
    setTree(res.tree);
    const map: Record<string, { outgoing: string[]; backlinks: string[] }> = {};
    for (const f of gRes.files || []) {
      map[f.path] = { outgoing: f.outgoing || [], backlinks: f.backlinks || [] };
    }
    setLinkGraph(map);
    if (sRes) {
      setSemanticInfo({ totalChunks: sRes.totalChunks || 0, mode: sRes.mode || "local-semantic" });
    }
  }, []);

  const openFile = useCallback(async (relPath: string) => {
    try {
      const res = await apiFetch<{ path: string; content: string }>(
        `/api/files/read?path=${encodeURIComponent(relPath)}`
      );
      setActiveFile(res.path);
      setContent(res.content);
      setDirty(false);
      const dir = res.path.includes("/") ? res.path.split("/").slice(0, -1).join("/") : "";
      if (dir) setUploadFolder(dir);
    } catch {
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

  async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || "");
        resolve(res.replace(/^data:[^;]+;base64,/, ""));
      };
      reader.onerror = () => reject(new Error(`Failed reading ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function importEntries(
    entries: Array<{ file: File; relPath: string }>,
    targetDir = uploadFolder
  ) {
    if (entries.length === 0) return;
    setImporting(true);
    setNotice(`Importing ${entries.length} item(s)...`);
    try {
      const binaryExts = [".zip", ".pdf", ".docx", ".xlsx", ".xlsm"];
      const skipSegs = new Set([".git", "node_modules", "__macosx", ".obsidian", ".ds_store"]);
      const payload: Array<{ name: string; content?: string; base64?: string }> = [];

      for (const { file, relPath } of entries) {
        const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
        const parts = norm.split("/").filter(Boolean);
        if (parts.length === 0 || parts.some((p) => skipSegs.has(p.toLowerCase()) || p.startsWith("._"))) {
          continue;
        }
        const low = norm.toLowerCase();
        if (binaryExts.some((ext) => low.endsWith(ext))) {
          const base64 = await fileToBase64(file);
          payload.push({ name: norm, base64 });
        } else {
          // Skip giant binary blobs (> 3 MB non-text)
          if (file.size > 3 * 1024 * 1024) continue;
          const text = await file.text();
          if (text.includes("\u0000")) continue;
          payload.push({ name: norm, content: text });
        }
      }

      if (payload.length === 0) {
        setNotice("No supported text, ZIP, PDF, DOCX, or XLSX files found.");
        setTimeout(() => setNotice(""), 3000);
        return;
      }

      const res = await apiFetch<{
        count: number;
        convertedDocs?: number;
        skipped?: number;
        paths: string[];
      }>("/api/files/upload", {
        method: "POST",
        body: JSON.stringify({ folder: targetDir, files: payload }),
      });

      await loadTree();
      if (targetDir) setExpanded((prev) => new Set([...prev, targetDir]));
      if (res.paths?.[0]) {
        const firstDir = res.paths[0].split("/").slice(0, -1).join("/");
        if (firstDir) setExpanded((prev) => new Set([...prev, firstDir]));
        await openFile(res.paths[0]);
      }
      const docNote = res.convertedDocs ? ` (${res.convertedDocs} PDF/Office converted)` : "";
      setNotice(`Imported ${res.count} file(s)${docNote} & indexed!`);
      setTimeout(() => setNotice(""), 3800);
    } catch (err) {
      setNotice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setNotice(""), 4200);
    } finally {
      setImporting(false);
    }
  }

  async function uploadFileList(fileList: FileList | null, targetDir = uploadFolder) {
    if (!fileList || fileList.length === 0) return;
    const entries = Array.from(fileList).map((file) => ({
      file,
      relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
    await importEntries(entries, targetDir);
  }

  async function collectDroppedEntries(dataTransfer: DataTransfer): Promise<Array<{ file: File; relPath: string }>> {
    const out: Array<{ file: File; relPath: string }> = [];
    const items = Array.from(dataTransfer.items || []);

    type FsEntry = {
      isFile: boolean;
      isDirectory: boolean;
      name: string;
      fullPath: string;
      file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
      createReader?: () => { readEntries: (cb: (entries: FsEntry[]) => void, err?: (e: unknown) => void) => void };
    };

    async function walkEntry(entry: FsEntry, prefix = ""): Promise<void> {
      if (entry.isFile && entry.file) {
        const file = await new Promise<File | null>((resolve) => {
          entry.file!((f) => resolve(f), () => resolve(null));
        });
        if (file) out.push({ file, relPath: prefix ? `${prefix}/${entry.name}` : entry.name });
      } else if (entry.isDirectory && entry.createReader) {
        const reader = entry.createReader();
        const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const readBatch = (): Promise<FsEntry[]> =>
          new Promise((resolve) => reader.readEntries((batch) => resolve(batch), () => resolve([])));
        while (true) {
          const batch = await readBatch();
          if (!batch.length) break;
          for (const child of batch) {
            await walkEntry(child, dirPath);
          }
        }
      }
    }

    let usedEntries = false;
    for (const item of items) {
      const getEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry;
      if (getEntry) {
        const entry = getEntry.call(item);
        if (entry) {
          usedEntries = true;
          await walkEntry(entry, "");
        }
      }
    }

    if (!usedEntries && dataTransfer.files.length > 0) {
      for (const file of Array.from(dataTransfer.files)) {
        out.push({
          file,
          relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        });
      }
    }
    return out;
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

  async function runSearch(q: string, modeOverride?: "fts" | "semantic") {
    setSearchQuery(q);
    const activeMode = modeOverride || searchMode;
    if (!q.trim()) {
      setSearchResults([]);
      setSemanticResults([]);
      return;
    }
    if (activeMode === "semantic") {
      const res = await apiFetch<{
        results?: Array<{ sourceType: string; path: string; title: string; score: number; excerpt: string }>;
      }>(`/api/brain/semantic/search?q=${encodeURIComponent(q)}&limit=12`);
      setSemanticResults(res.results || []);
    } else {
      const res = await apiFetch<{ results: Array<{ rel_path: string; title: string; snippet: string }> }>(
        `/api/files/search?q=${encodeURIComponent(q)}`
      );
      setSearchResults(res.results);
    }
  }

  async function triggerReindex() {
    setReindexing(true);
    try {
      const res = await apiFetch<{ totalChunks?: number; documents?: number }>("/api/brain/semantic/reindex", {
        method: "POST",
      });
      await loadTree();
      setNotice(`Semantic indexed ${res.totalChunks || 0} chunks`);
      setTimeout(() => setNotice(""), 2500);
    } finally {
      setReindexing(false);
    }
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
                setUploadFolder(node.path);
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
                  aria-label="New file in folder"
                  onClick={() => createNewFile(node.path)}
                  className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                >
                  <FilePlus className="w-3 h-3" />
                </button>
              )}
              <button
                title="Pin to Brain Canvas"
                aria-label="Pin to Brain Canvas"
                onClick={() => pinToCanvas(node.path, node.type === "folder")}
                className="p-1 rounded hover:bg-amber-500/20 text-amber-400"
              >
                <Pin className="w-3 h-3" />
              </button>
              <button
                title="Rename"
                aria-label="Rename"
                onClick={() => handleRename(node.path)}
                className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
              >
                <Edit3 className="w-3 h-3" />
              </button>
              <button
                title="Delete"
                aria-label="Delete"
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
    <div
      className="flex h-screen bg-[#080a0f] relative"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setIsDragging(false);
        const entries = await collectDroppedEntries(e.dataTransfer);
        await importEntries(entries, uploadFolder);
      }}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-40 bg-amber-500/10 border-2 border-dashed border-amber-400 flex items-center justify-center backdrop-blur-xs">
          <div className="px-6 py-4 rounded-2xl bg-[#0d111b] border border-amber-500/50 text-amber-300 font-semibold text-sm shadow-2xl text-center space-y-1">
            <div>
              Drop <strong>Files, Entire Folders, .ZIP, or PDF/DOCX/XLSX</strong> into{" "}
              <code className="text-white">{uploadFolder || "root"}</code>
            </div>
            <div className="text-[11px] text-slate-400 font-normal">
              Subfolder hierarchy &amp; Obsidian vaults are preserved automatically
            </div>
          </div>
        </div>
      )}

      {/* Left Explorer Pane (Collapsible) */}
      {showTree && (
        <div className="w-64 lg:w-72 shrink-0 bg-[#0d111b] border-r border-slate-800/80 flex flex-col">
          <div className="p-3 border-b border-slate-800/80 space-y-2.5">
            <div className="flex items-center justify-between gap-1">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200 truncate">
                Brain Files
              </h2>
              <div className="flex items-center gap-1 shrink-0">
                <label
                  title={`Import Files, .ZIP, PDF, DOCX, XLSX into ${uploadFolder || "root"}`}
                  className={`p-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/35 text-cyan-300 cursor-pointer ${
                    importing ? "opacity-50 pointer-events-none" : ""
                  }`}
                >
                  <Upload className="w-3.5 h-3.5" />
                  <input
                    type="file"
                    multiple
                    accept=".md,.txt,.json,.yaml,.yml,.csv,.zip,.pdf,.docx,.xlsx,.xlsm,.ts,.tsx,.js,.py,.sql,.sh,.xml,.html,.css"
                    className="hidden"
                    onChange={(e) => {
                      uploadFileList(e.target.files, uploadFolder);
                      e.target.value = "";
                    }}
                  />
                </label>
                <label
                  title={`Import Entire Folder / Obsidian Vault into ${uploadFolder || "root"}`}
                  className={`p-1.5 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/35 text-violet-300 cursor-pointer ${
                    importing ? "opacity-50 pointer-events-none" : ""
                  }`}
                >
                  <FolderUp className="w-3.5 h-3.5" />
                  <input
                    type="file"
                    multiple
                    {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                    className="hidden"
                    onChange={(e) => {
                      uploadFileList(e.target.files, uploadFolder);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  onClick={() => createNewFile(uploadFolder)}
                  title="New File (e.g. soul.md)"
                  aria-label="New File"
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
                >
                  <FilePlus className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => createNewFolder(true)}
                  title="New Complete Brain Folder (soul.md + rules.md + memory.md)"
                  className="px-2 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                >
                  <FolderPlus className="w-3.5 h-3.5" /> Kit
                </button>
              </div>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={searchQuery}
                onChange={(e) => runSearch(e.target.value)}
                placeholder={searchMode === "semantic" ? "Semantic vector search..." : "FTS5 exact keyword search..."}
                className="w-full bg-[#080a0f] border border-slate-800 focus:border-amber-500 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-slate-200 outline-none"
              />
            </div>

            <div className="flex items-center justify-between gap-1 text-[10px]">
              <div className="flex rounded-lg bg-[#080a0f] border border-slate-800 p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setSearchMode("semantic");
                    if (searchQuery.trim()) runSearch(searchQuery, "semantic");
                  }}
                  className={`px-2 py-0.5 rounded flex items-center gap-1 cursor-pointer ${
                    searchMode === "semantic" ? "bg-violet-500/25 text-violet-300 font-semibold" : "text-slate-400"
                  }`}
                >
                  <Sparkles className="w-2.5 h-2.5" /> Semantic
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSearchMode("fts");
                    if (searchQuery.trim()) runSearch(searchQuery, "fts");
                  }}
                  className={`px-2 py-0.5 rounded cursor-pointer ${
                    searchMode === "fts" ? "bg-amber-500/20 text-amber-300 font-semibold" : "text-slate-400"
                  }`}
                >
                  FTS5
                </button>
              </div>
              <button
                type="button"
                disabled={reindexing}
                onClick={triggerReindex}
                title={`Reindex semantic vector memory (${semanticInfo?.mode || "hybrid"})`}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-2.5 h-2.5 ${reindexing ? "animate-spin" : ""}`} />
                {semanticInfo ? `${semanticInfo.totalChunks}v` : "Index"}
              </button>
            </div>

            <div className="text-[10px] text-slate-500 truncate">
              Import target: <code className="text-amber-300/90">{uploadFolder || "root"}</code> (Files · Folder · .ZIP · PDF)
            </div>
            <div className="grid grid-cols-3 gap-1 text-[9px] text-center">
              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">main-brain</span>
              <span className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/20">teams/</span>
              <span className="px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">agents/</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {searchQuery.trim() ? (
              <div className="space-y-1.5 p-1">
                {searchMode === "semantic" ? (
                  <>
                    <div className="text-[10px] uppercase tracking-wider text-violet-400 px-1">
                      Semantic Matches ({semanticResults.length})
                    </div>
                    {semanticResults.map((r) => (
                      <button
                        key={`${r.sourceType}_${r.path}`}
                        onClick={() => {
                          if (r.sourceType === "brain_file") openFile(r.path);
                        }}
                        className="w-full text-left p-2 rounded-lg bg-[#090c14] hover:bg-slate-800/80 border border-violet-500/25 cursor-pointer space-y-0.5"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[10px] font-mono text-violet-300 truncate">{r.path}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200 shrink-0">
                            {r.sourceType === "brain_file" ? `${r.score}` : r.sourceType}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 line-clamp-2">{r.excerpt}</div>
                      </button>
                    ))}
                    {semanticResults.length === 0 && (
                      <div className="text-xs text-slate-500 p-2">No semantic matches found.</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 px-1">
                      FTS5 Results ({searchResults.length})
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
                  </>
                )}
              </div>
            ) : (
              renderTree(tree)
            )}
          </div>
        </div>
      )}

      {/* Right Code / Markdown Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="min-h-14 px-4 py-2.5 bg-[#0d111b] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <button
              onClick={() => setShowTree((s) => !s)}
              title="Toggle file tree"
              aria-label="Toggle file tree"
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer shrink-0"
            >
              <PanelLeft className="w-3.5 h-3.5" />
            </button>
            <div className="min-w-0">
              <div className="text-xs font-mono font-semibold text-amber-300 truncate">
                {activeFile || "Select or create a Brain file"}
                {dirty && <span className="text-rose-400 ml-1.5">● unsaved</span>}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                Live synced to Agent Brain runtime &amp; SQLite FTS5
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            {notice && (
              <span className="text-xs text-emerald-400 flex items-center gap-1 mr-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> {notice}
              </span>
            )}
            <div className="flex rounded-lg bg-[#080a0f] border border-slate-800 p-0.5 text-xs">
              {(["edit", "split", "preview"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`px-2 py-1 rounded-md capitalize flex items-center gap-1 cursor-pointer ${
                    viewMode === m ? "bg-slate-800 text-cyan-300 font-semibold" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {m === "edit" && <Code className="w-3 h-3" />}
                  {m === "preview" && <Eye className="w-3 h-3" />}
                  {m}
                </button>
              ))}
            </div>
            {activeFile && (
              <button
                onClick={() => pinToCanvas(activeFile, false)}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1 cursor-pointer"
              >
                <Pin className="w-3.5 h-3.5 text-amber-400" /> Pin
              </button>
            )}
            <button
              onClick={saveCurrentFile}
              disabled={!activeFile || saving}
              className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" /> {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {/* Living Brain [[wikilink]] & Backlinks Bar (Beyond Obsidian) */}
        {activeFile && (
          <div className="px-4 py-1.5 bg-[#0a0d15] border-b border-slate-800/70 flex flex-wrap items-center gap-2 text-[11px]">
            {(() => {
              const baseName = activeFile.split("/").pop()?.toLowerCase() || "";
              const isCore = ["soul.md", "identity.md", "rules.md", "team.md", "memory.md"].includes(baseName);
              const links = linkGraph[activeFile] || { outgoing: [], backlinks: [] };
              return (
                <>
                  <span
                    className={`px-2 py-0.5 rounded-full font-semibold ${
                      isCore
                        ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                        : "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
                    }`}
                  >
                    {isCore ? "Core Auto-Loaded + 1-Hop [[Links]]" : "Progressive On-Demand Index"}
                  </span>
                  {links.outgoing.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-slate-500">Links →</span>
                      {links.outgoing.map((target) => (
                        <button
                          key={target}
                          onClick={() => openFile(target)}
                          className="px-2 py-0.5 rounded bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/30 text-violet-300 font-mono text-[10px] cursor-pointer"
                        >
                          [[{target.split("/").pop()?.replace(/\.md$/i, "")}]]
                        </button>
                      ))}
                    </div>
                  )}
                  {links.backlinks.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-slate-500">Backlinks ←</span>
                      {links.backlinks.map((src) => (
                        <button
                          key={src}
                          onClick={() => openFile(src)}
                          className="px-2 py-0.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 font-mono text-[10px] cursor-pointer"
                        >
                          {src}
                        </button>
                      ))}
                    </div>
                  )}
                  {links.outgoing.length === 0 && links.backlinks.length === 0 && (
                    <span className="text-slate-500">
                      Tip: Reference other notes with <code className="text-amber-300">[[rules]]</code> or{" "}
                      <code className="text-amber-300">[[note-name]]</code> — Pandawa follows them automatically at runtime.
                    </span>
                  )}
                </>
              );
            })()}
          </div>
        )}

        <div className="flex-1 flex min-h-0 overflow-hidden">
          {(viewMode === "edit" || viewMode === "split") && (
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
              placeholder="Write soul.md, rules.md, team charter, SOPs, or drag & drop files..."
              className={`${
                viewMode === "split" ? "w-1/2 border-r border-slate-800" : "w-full"
              } h-full bg-[#080a0f] text-slate-100 font-mono text-sm p-6 outline-none resize-none leading-relaxed`}
            />
          )}
          {(viewMode === "preview" || viewMode === "split") && (
            <div className={`${viewMode === "split" ? "w-1/2" : "w-full"} h-full overflow-y-auto p-6 bg-[#080a0f]`}>
              <div className="max-w-3xl">
                <MarkdownView content={content || "*Empty file*"} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

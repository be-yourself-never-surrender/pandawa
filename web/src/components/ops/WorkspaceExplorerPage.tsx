import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Camera,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  Folder,
  FolderOpen,
  History,
  Image as ImageIcon,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { apiFetch, getStoredToken } from "../../api/client";
import type { TeamItem } from "../../types";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  updatedAt?: string;
  children?: TreeNode[];
}

interface WorkspacePreview {
  path: string;
  kind: "text" | "image" | "binary";
  size: number;
  mimeType: string;
  content?: string;
  dataUrl?: string;
}

interface CheckpointItem {
  id: string;
  createdAt: string;
}

interface Props {
  initialTeamId?: string | null;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function WorkspaceExplorerPage({ initialTeamId }: Props) {
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [teamId, setTeamId] = useState<string>(initialTeamId || "");
  const [workspaceDir, setWorkspaceDir] = useState<string>("");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [filterText, setFilterText] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointItem[]>([]);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [confirmRollbackId, setConfirmRollbackId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<{ teams: TeamItem[] }>("/api/teams")
      .then((res) => {
        const list = res.teams || [];
        setTeams(list);
        setTeamId((cur) => {
          if (initialTeamId && list.some((t) => t.id === initialTeamId)) return initialTeamId;
          if (cur && list.some((t) => t.id === cur)) return cur;
          return list[0]?.id || "";
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [initialTeamId]);

  const loadTreeAndCheckpoints = useCallback(async (tid: string) => {
    if (!tid) return;
    setLoadingTree(true);
    setError("");
    try {
      const [treeRes, cpRes] = await Promise.all([
        apiFetch<{ workspaceDir: string; tree: TreeNode[] }>(`/api/workspaces/${encodeURIComponent(tid)}/tree`),
        apiFetch<{ checkpoints: CheckpointItem[] }>(`/api/workspaces/${encodeURIComponent(tid)}/checkpoints`),
      ]);
      setWorkspaceDir(treeRes.workspaceDir || "");
      setTree(treeRes.tree || []);
      setCheckpoints(cpRes.checkpoints || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTree(false);
    }
  }, []);

  useEffect(() => {
    if (teamId) {
      setSelectedPath("");
      setPreview(null);
      setConfirmRollbackId(null);
      void loadTreeAndCheckpoints(teamId);
    }
  }, [teamId, loadTreeAndCheckpoints]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!teamId || !filePath) return;
      setSelectedPath(filePath);
      setLoadingFile(true);
      setError("");
      try {
        const res = await apiFetch<WorkspacePreview>(
          `/api/workspaces/${encodeURIComponent(teamId)}/file?path=${encodeURIComponent(filePath)}`
        );
        setPreview(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingFile(false);
      }
    },
    [teamId]
  );

  async function handleDownload(filePath: string) {
    if (!teamId || !filePath) return;
    setError("");
    try {
      const token = getStoredToken();
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(teamId)}/download?path=${encodeURIComponent(filePath)}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filePath.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createSnapshot() {
    if (!teamId) return;
    setBusyAction(true);
    setError("");
    setNotice("");
    try {
      const res = await apiFetch<{ id: string; files: number }>(
        `/api/workspaces/${encodeURIComponent(teamId)}/checkpoints`,
        {
          method: "POST",
          body: JSON.stringify({ label: snapshotLabel.trim() || undefined }),
        }
      );
      setSnapshotLabel("");
      setNotice(`Snapshot "${res.id}" dibuat (${res.files} files).`);
      await loadTreeAndCheckpoints(teamId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  }

  async function rollbackSnapshot(cid: string) {
    if (!teamId) return;
    setBusyAction(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/api/workspaces/${encodeURIComponent(teamId)}/checkpoints/${encodeURIComponent(cid)}/rollback`, {
        method: "POST",
      });
      setConfirmRollbackId(null);
      setNotice(`Workspace direstore ke checkpoint ${cid}.`);
      await loadTreeAndCheckpoints(teamId);
      if (selectedPath) void openFile(selectedPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  }

  const filteredTree = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return tree;
    const filterNodes = (nodes: TreeNode[]): TreeNode[] => {
      const out: TreeNode[] = [];
      for (const n of nodes) {
        if (n.type === "folder") {
          const kids = filterNodes(n.children || []);
          if (kids.length > 0 || n.name.toLowerCase().includes(q)) {
            out.push({ ...n, children: kids });
          }
        } else if (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) {
          out.push(n);
        }
      }
      return out;
    };
    return filterNodes(tree);
  }, [tree, filterText]);

  function toggleDir(dirPath: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }

  function renderTree(nodes: TreeNode[], depth = 0) {
    return nodes.map((node) => {
      if (node.type === "folder") {
        const isOpen = filterText.trim().length > 0 || expandedDirs.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => toggleDir(node.path)}
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              className="w-full pr-3 py-1.5 flex items-center gap-1.5 text-left text-xs text-zinc-300 hover:bg-white/[0.03] transition cursor-pointer"
            >
              {isOpen ? (
                <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              )}
              <Folder className="w-3.5 h-3.5 text-amber-400/90 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            {isOpen && node.children && <div>{renderTree(node.children, depth + 1)}</div>}
          </div>
        );
      }

      const active = node.path === selectedPath;
      return (
        <button
          key={node.path}
          type="button"
          onClick={() => void openFile(node.path)}
          style={{ paddingLeft: `${26 + depth * 14}px` }}
          className={`w-full pr-3 py-1.5 flex items-center justify-between gap-2 text-left text-xs transition cursor-pointer ${
            active ? "bg-emerald-500/10 text-emerald-300" : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200"
          }`}
        >
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <FileCode2 className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
            <span className="truncate">{node.name}</span>
          </span>
          <span className="text-[10px] font-mono text-zinc-600 shrink-0">{formatBytes(node.size)}</span>
        </button>
      );
    });
  }

  return (
    <div className="h-full flex flex-col bg-[#09090b] text-zinc-100 overflow-hidden">
      <header className="px-6 py-4 border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-zinc-100">
              Team Workspaces
            </h1>
            {workspaceDir && (
              <span className="hidden sm:inline-block px-2 py-0.5 rounded bg-zinc-900 border border-white/[0.07] text-[10px] font-mono text-zinc-400 truncate max-w-md">
                {workspaceDir}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            Ruang kerja terisolasi per team: telusuri artefak, preview file &amp; gambar, download, atau snapshot &amp; rollback.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="h-8 px-2.5 rounded-md bg-[#111113] border border-white/[0.08] text-xs text-zinc-100 focus:outline-none focus:border-zinc-500"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void loadTreeAndCheckpoints(teamId)}
            className="h-8 px-2.5 rounded-md bg-[#111113] hover:bg-[#18181b] border border-white/[0.08] text-xs text-zinc-300 inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingTree ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </header>

      {(error || notice) && (
        <div className="px-6 pt-3 space-y-2 shrink-0">
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-xs text-red-300">
              {error}
            </div>
          )}
          {notice && (
            <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
              {notice}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-white/[0.07]">
        {/* Left: Directory Tree */}
        <aside className="lg:col-span-3 flex flex-col min-h-0 bg-[#0b0b0e]">
          <div className="p-3 border-b border-white/[0.06]">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-2" />
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filter files..."
                className="w-full h-7.5 pl-8 pr-2.5 rounded-md bg-[#111113] border border-white/[0.08] text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {filteredTree.length === 0 && !loadingTree ? (
              <div className="p-6 text-center text-xs text-zinc-500">
                Workspace masih kosong. File buatan team akan muncul di sini.
              </div>
            ) : (
              renderTree(filteredTree)
            )}
          </div>
        </aside>

        {/* Center: File / Image Preview */}
        <section className="lg:col-span-6 flex flex-col min-h-0">
          <div className="px-4 py-2.5 border-b border-white/[0.06] bg-[#0e0e11] flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0 text-xs font-mono">
              <FolderOpen className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              <span className="truncate text-zinc-200">{selectedPath || "No file selected"}</span>
              {preview && (
                <span className="text-[10px] text-zinc-500 shrink-0">
                  ({formatBytes(preview.size)})
                </span>
              )}
            </div>

            {preview && (
              <div className="flex items-center gap-1.5 shrink-0">
                {preview.kind === "text" && preview.content !== undefined && (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(preview.content || "");
                      setNotice(`Copied ${preview.path}`);
                    }}
                    className="h-7 px-2.5 rounded bg-[#15151a] hover:bg-[#1e1e26] border border-white/[0.08] text-[11px] text-zinc-300 inline-flex items-center gap-1 transition cursor-pointer"
                  >
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleDownload(preview.path)}
                  className="h-7 px-2.5 rounded bg-zinc-100 hover:bg-white text-zinc-950 text-[11px] font-medium inline-flex items-center gap-1 transition cursor-pointer"
                >
                  <Download className="w-3 h-3" /> Download
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto p-4">
            {loadingFile ? (
              <div className="text-xs text-zinc-500 py-8 text-center">Reading file...</div>
            ) : !preview ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-xs text-zinc-500 gap-2">
                <FileCode2 className="w-8 h-8 text-zinc-700" />
                <p>Pilih file dari tree di sebelah kiri untuk preview isi atau download.</p>
              </div>
            ) : preview.kind === "image" && preview.dataUrl ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <div className="text-[11px] font-mono text-zinc-400 inline-flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5" /> {preview.mimeType}
                </div>
                <img
                  src={preview.dataUrl}
                  alt={preview.path}
                  className="max-w-full max-h-[65vh] rounded-lg border border-white/[0.1] bg-[#111113]"
                />
              </div>
            ) : preview.kind === "text" ? (
              <pre className="text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words leading-relaxed bg-[#111113] border border-white/[0.07] rounded-xl p-4">
                {preview.content || ""}
              </pre>
            ) : (
              <div className="rounded-xl bg-[#111113] border border-white/[0.07] p-6 text-center space-y-2 text-xs">
                <div className="text-zinc-300 font-medium">Binary File ({preview.mimeType})</div>
                <div className="text-zinc-500">Ukuran {formatBytes(preview.size)} — klik Download untuk mengunduh file.</div>
              </div>
            )}
          </div>
        </section>

        {/* Right: Snapshot Checkpoints & Rollback */}
        <aside className="lg:col-span-3 flex flex-col min-h-0 bg-[#0b0b0e]">
          <div className="p-4 border-b border-white/[0.06] space-y-2.5 shrink-0">
            <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
              <History className="w-3.5 h-3.5 text-zinc-400" /> Workspace Checkpoints
            </div>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={snapshotLabel}
                onChange={(e) => setSnapshotLabel(e.target.value)}
                placeholder="Label snapshot..."
                className="flex-1 min-w-0 h-8 px-2.5 rounded-md bg-[#111113] border border-white/[0.08] text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <button
                type="button"
                disabled={busyAction || !teamId}
                onClick={() => void createSnapshot()}
                className="h-8 px-2.5 rounded-md bg-zinc-100 hover:bg-white disabled:opacity-50 text-zinc-950 text-xs font-medium inline-flex items-center gap-1 transition cursor-pointer shrink-0"
              >
                <Camera className="w-3.5 h-3.5" /> Save
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
            {checkpoints.length === 0 ? (
              <div className="text-xs text-zinc-600">
                Belum ada checkpoint. Simpan snapshot sebelum tim menjalankan eksperimen berisiko.
              </div>
            ) : (
              checkpoints.map((cp) => (
                <div
                  key={cp.id}
                  className="rounded-lg bg-[#111113] border border-white/[0.07] p-3 text-xs space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium font-mono text-zinc-200 truncate">{cp.id}</div>
                      <div className="text-[10px] font-mono text-zinc-500">
                        {new Date(cp.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  {confirmRollbackId === cp.id ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busyAction}
                        onClick={() => void rollbackSnapshot(cp.id)}
                        className="flex-1 h-7 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-[11px] font-medium transition cursor-pointer"
                      >
                        Confirm Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRollbackId(null)}
                        className="h-7 px-2 rounded bg-zinc-900 border border-white/[0.07] text-[11px] text-zinc-400 transition cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={() => setConfirmRollbackId(cp.id)}
                      className="w-full h-7 rounded bg-[#16161b] hover:bg-[#1e1e25] border border-white/[0.07] text-[11px] text-zinc-300 inline-flex items-center justify-center gap-1.5 transition cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" /> Restore Snapshot
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Plus,
  Brain,
  Trash2,
  ExternalLink,
  Search,
  Download,
  Upload,
  FolderUp,
  FileArchive,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Github,
  FileCode2,
} from "lucide-react";
import { apiFetch } from "../../api/client";
import type { BrainItem } from "../../types";

interface SkillEntry {
  slug: string;
  path: string;
  dirPath: string;
  name: string;
  brainFolder: string;
  description: string;
  content: string;
  fileCount: number;
  source?: string;
  installedAt?: string;
  riskLevel?: "clean" | "review" | "caution";
}

interface SkillFinding {
  severity: "high" | "medium" | "info";
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

interface SkillPreviewItem {
  slug: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  sourceSubpath: string;
  fileCount: number;
  totalBytes: number;
  files: string[];
  markdownPreview: string;
  riskLevel: "clean" | "review" | "caution";
  findings: SkillFinding[];
  alreadyInstalled: boolean;
  targetDir: string;
}

interface UploadedSkillPayload {
  name: string;
  content?: string;
  base64?: string;
}

interface MemoryEntry {
  id: string;
  brain_id: string;
  agent_id: string;
  category: string;
  content: string;
  importance: number;
  created_at: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export const SkillsPage: React.FC<{ onOpenFile: (path: string) => void }> = ({ onOpenFile }) => {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [brains, setBrains] = useState<BrainItem[]>([]);

  // Installer tabs: url | upload | manual
  const [tab, setTab] = useState<"url" | "upload" | "manual">("url");
  const [targetBrainFolder, setTargetBrainFolder] = useState("main-brain");

  // GitHub / URL installer state
  const [sourceInput, setSourceInput] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<UploadedSkillPayload[]>([]);
  const [uploadSummary, setUploadSummary] = useState("");
  const [scanning, setScanning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [previewSource, setPreviewSource] = useState("");
  const [previewSkills, setPreviewSkills] = useState<SkillPreviewItem[]>([]);
  const [selectedSlugs, setSelectedSlugs] = useState<Record<string, boolean>>({});
  const [expandedSlug, setExpandedSlug] = useState<string>("");
  const [installerNotice, setInstallerNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Manual create state
  const [skillTitle, setSkillTitle] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillBody, setSkillBody] = useState("");

  // Memory state
  const [memContent, setMemContent] = useState("");
  const [memBrainId, setMemBrainId] = useState("brain_main");
  const [memCategory, setMemCategory] = useState("lesson");
  const [memSearch, setMemSearch] = useState("");

  const load = useCallback(async (q = "") => {
    const [sRes, mRes, bRes] = await Promise.all([
      apiFetch<{ skills: SkillEntry[] }>("/api/skills"),
      apiFetch<{ memories: MemoryEntry[] }>(q.trim() ? `/api/memories?q=${encodeURIComponent(q.trim())}` : "/api/memories"),
      apiFetch<{ brains: BrainItem[] }>("/api/brains"),
    ]);
    setSkills(sRes.skills);
    setMemories(mRes.memories);
    setBrains(bRes.brains);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  function resetPreview() {
    setPreviewSkills([]);
    setPreviewSource("");
    setSelectedSlugs({});
    setExpandedSlug("");
  }

  async function runPreview(opts: { source?: string; files?: UploadedSkillPayload[] }) {
    setInstallerNotice(null);
    setScanning(true);
    resetPreview();
    try {
      const res = await apiFetch<{
        ok: boolean;
        source: string;
        brainFolder: string;
        skills: SkillPreviewItem[];
      }>("/api/skills/preview", {
        method: "POST",
        body: JSON.stringify({
          source: opts.source,
          files: opts.files,
          brainFolder: targetBrainFolder,
        }),
      });
      setPreviewSource(res.source);
      setPreviewSkills(res.skills);
      const sel: Record<string, boolean> = {};
      for (const s of res.skills) sel[s.slug] = true;
      setSelectedSlugs(sel);
      if (res.skills.length === 1) setExpandedSlug(res.skills[0].slug);
    } catch (err) {
      setInstallerNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setScanning(false);
    }
  }

  async function handleUrlPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceInput.trim()) return;
    setUploadedFiles([]);
    setUploadSummary("");
    await runPreview({ source: sourceInput.trim() });
  }

  async function handleFileSelection(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setInstallerNotice(null);
    const staged: UploadedSkillPayload[] = [];
    for (const file of Array.from(fileList)) {
      const relName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (relName.toLowerCase().endsWith(".zip")) {
        const dataUrl = await readAsDataUrl(file);
        staged.push({ name: relName, base64: dataUrl });
      } else {
        const text = await file.text();
        staged.push({ name: relName, content: text });
      }
    }
    setUploadedFiles(staged);
    setUploadSummary(`${staged.length} file(s) selected`);
    setSourceInput("");
    await runPreview({ files: staged });
  }

  async function handleInstallSelected() {
    const picked = previewSkills.filter((s) => selectedSlugs[s.slug]).map((s) => s.slug);
    if (picked.length === 0) return;
    setInstalling(true);
    setInstallerNotice(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        source: string;
        brainFolder: string;
        installed: Array<{ slug: string; name: string; path: string; fileCount: number }>;
        skipped: Array<{ slug: string; reason: string }>;
      }>("/api/skills/install", {
        method: "POST",
        body: JSON.stringify({
          source: uploadedFiles.length === 0 ? sourceInput.trim() : undefined,
          files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
          brainFolder: targetBrainFolder,
          selectedSlugs: picked,
          overwrite,
        }),
      });
      const installedCount = res.installed.length;
      const skippedCount = res.skipped.length;
      const msgParts: string[] = [];
      if (installedCount > 0) {
        msgParts.push(`Installed ${installedCount} skill(s): ${res.installed.map((s) => s.slug).join(", ")}`);
      }
      if (skippedCount > 0) {
        msgParts.push(`Skipped ${skippedCount}: ${res.skipped.map((s) => `${s.slug} (${s.reason})`).join("; ")}`);
      }
      setInstallerNotice({
        ok: installedCount > 0,
        text: msgParts.join(" · ") || "No skills installed.",
      });
      if (installedCount > 0) {
        resetPreview();
        setSourceInput("");
        setUploadedFiles([]);
        setUploadSummary("");
        await load(memSearch);
      }
    } catch (err) {
      setInstallerNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setInstalling(false);
    }
  }

  async function handleUninstallSkill(skill: SkillEntry) {
    if (!window.confirm(`Uninstall skill "${skill.name}" (${skill.dirPath})?`)) return;
    try {
      await apiFetch(`/api/skills?dirPath=${encodeURIComponent(skill.dirPath)}`, { method: "DELETE" });
      setInstallerNotice({ ok: true, text: `Uninstalled "${skill.name}" (${skill.dirPath}).` });
      await load(memSearch);
    } catch (err) {
      setInstallerNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function addSkill(e: React.FormEvent) {
    e.preventDefault();
    if (!skillTitle.trim()) return;
    const slug = skillTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await apiFetch("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        slug,
        title: skillTitle.trim(),
        description: skillDesc.trim(),
        instructions: skillBody.trim(),
        brainFolder: targetBrainFolder,
      }),
    });
    setSkillTitle("");
    setSkillDesc("");
    setSkillBody("");
    setInstallerNotice({ ok: true, text: `Created skill "${slug}" in ${targetBrainFolder}/skills/${slug}/SKILL.md.` });
    await load(memSearch);
  }

  async function addMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!memContent.trim()) return;
    await apiFetch("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        brainId: memBrainId,
        category: memCategory,
        content: memContent.trim(),
        importance: 7,
      }),
    });
    setMemContent("");
    await load(memSearch);
  }

  const selectedCount = previewSkills.filter((s) => selectedSlugs[s.slug]).length;

  function renderRiskBadge(level?: "clean" | "review" | "caution") {
    if (level === "caution") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/35">
          <ShieldAlert className="w-3 h-3" /> CAUTION
        </span>
      );
    }
    if (level === "review") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/35">
          <AlertTriangle className="w-3 h-3" /> REVIEW
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/35">
        <ShieldCheck className="w-3 h-3" /> CLEAN
      </span>
    );
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#09090b] p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-amber-400" /> Skill Installer, Playbooks &amp; Episodic Memory
        </h1>
        <p className="text-xs text-zinc-400 mt-1">
          Install <code className="text-amber-300">SKILL.md</code> packages directly from <strong>GitHub repos</strong>,{" "}
          <strong>raw URLs</strong>, <strong>.zip packs</strong>, or <strong>local folders</strong> with automatic security scanning before install — or let agents self-learn via <code className="text-amber-300">learn_skill</code>.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Skills & Skill Installer Column */}
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-[#111113] border border-white/[0.08] space-y-3.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
                <Download className="w-4 h-4" /> Pandawa Skill Installer
              </div>
              <select
                aria-label="Target Brain for Skill Installation"
                value={targetBrainFolder}
                onChange={(e) => setTargetBrainFolder(e.target.value)}
                className="bg-[#09090b] border border-white/[0.10] rounded-lg px-2.5 py-1 text-[11px] text-zinc-200"
              >
                {brains.map((b) => (
                  <option key={b.id} value={b.folder_path}>
                    Target: {b.name} ({b.folder_path})
                  </option>
                ))}
              </select>
            </div>

            {/* Mode switcher */}
            <div className="flex items-center gap-1 bg-[#09090b] p-1 rounded-lg border border-white/[0.07]">
              <button
                type="button"
                onClick={() => {
                  setTab("url");
                  setInstallerNotice(null);
                }}
                className={`flex-1 h-7 px-2.5 rounded-md font-medium flex items-center justify-center gap-1.5 cursor-pointer transition ${
                  tab === "url" ? "bg-white/[0.10] text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
                }`}
              >
                <Github className="w-3.5 h-3.5" /> GitHub / URL
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab("upload");
                  setInstallerNotice(null);
                }}
                className={`flex-1 h-7 px-2.5 rounded-md font-medium flex items-center justify-center gap-1.5 cursor-pointer transition ${
                  tab === "upload" ? "bg-white/[0.10] text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
                }`}
              >
                <Upload className="w-3.5 h-3.5" /> Upload Folder / .zip
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab("manual");
                  setInstallerNotice(null);
                }}
                className={`flex-1 h-7 px-2.5 rounded-md font-medium flex items-center justify-center gap-1.5 cursor-pointer transition ${
                  tab === "manual" ? "bg-white/[0.10] text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
                }`}
              >
                <Plus className="w-3.5 h-3.5" /> Create Manual
              </button>
            </div>

            {/* Tab 1: GitHub / Raw URL / ZIP URL */}
            {tab === "url" && (
              <form onSubmit={handleUrlPreview} className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <input
                    value={sourceInput}
                    onChange={(e) => setSourceInput(e.target.value)}
                    placeholder="owner/repo, GitHub folder URL, raw SKILL.md URL, or .zip URL..."
                    className="flex-1 h-9 bg-[#09090b] border border-white/[0.09] focus:border-amber-400/70 rounded-lg px-3 text-zinc-100 font-mono text-[11px] outline-none"
                  />
                  <button
                    type="submit"
                    disabled={scanning || !sourceInput.trim()}
                    className="h-9 px-3.5 rounded-lg bg-zinc-100 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-semibold inline-flex items-center gap-1.5 shrink-0 cursor-pointer transition"
                  >
                    {scanning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                    {scanning ? "Scanning..." : "Inspect & Preview"}
                  </button>
                </div>
                <div className="text-[11px] text-zinc-500 flex flex-wrap gap-x-3 gap-y-1">
                  <span>Supports:</span>
                  <code className="text-zinc-400">anthropics/skills</code>
                  <code className="text-zinc-400">https://github.com/org/repo/tree/main/skills/my-skill</code>
                  <code className="text-zinc-400">https://.../SKILL.md</code>
                  <code className="text-zinc-400">https://.../pack.zip</code>
                </div>
              </form>
            )}

            {/* Tab 2: Upload .zip / Folder / SKILL.md */}
            {tab === "upload" && (
              <div className="space-y-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".zip,.md,.txt,.py,.sh,.js,.ts,.json,.yaml,.yml"
                  className="hidden"
                  onChange={(e) => {
                    handleFileSelection(e.target.files).catch(() => {});
                    e.target.value = "";
                  }}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  className="hidden"
                  onChange={(e) => {
                    handleFileSelection(e.target.files).catch(() => {});
                    e.target.value = "";
                  }}
                />
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    disabled={scanning}
                    onClick={() => fileInputRef.current?.click()}
                    className="p-3 rounded-xl bg-[#09090b] hover:bg-[#16161a] border border-dashed border-white/[0.10] hover:border-amber-500/60 text-zinc-300 flex flex-col items-center justify-center gap-1.5 cursor-pointer transition"
                  >
                    <FileArchive className="w-5 h-5 text-amber-400" />
                    <span className="font-semibold">Select .zip or SKILL.md</span>
                    <span className="text-[10px] text-zinc-500">Single skill or multi-skill archive</span>
                  </button>
                  <button
                    type="button"
                    disabled={scanning}
                    onClick={() => folderInputRef.current?.click()}
                    className="p-3 rounded-xl bg-[#09090b] hover:bg-[#16161a] border border-dashed border-white/[0.10] hover:border-cyan-500/60 text-zinc-300 flex flex-col items-center justify-center gap-1.5 cursor-pointer transition"
                  >
                    <FolderUp className="w-5 h-5 text-cyan-400" />
                    <span className="font-semibold">Select Skill Folder</span>
                    <span className="text-[10px] text-zinc-500">Preserves scripts/ &amp; references/</span>
                  </button>
                </div>
                {uploadSummary && (
                  <div className="text-[11px] text-zinc-400 font-mono">
                    {scanning ? "Scanning uploaded skill files..." : uploadSummary}
                  </div>
                )}
              </div>
            )}

            {/* Tab 3: Create Manual SKILL.md */}
            {tab === "manual" && (
              <form onSubmit={addSkill} className="space-y-2.5">
                <input
                  value={skillTitle}
                  onChange={(e) => setSkillTitle(e.target.value)}
                  placeholder="Skill Title (e.g. Deploy Checklist)"
                  className="w-full bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
                />
                <input
                  value={skillDesc}
                  onChange={(e) => setSkillDesc(e.target.value)}
                  placeholder="Short description of when agents should apply this skill"
                  className="w-full bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
                />
                <textarea
                  rows={3}
                  value={skillBody}
                  onChange={(e) => setSkillBody(e.target.value)}
                  placeholder="Step-by-step markdown playbook..."
                  className="w-full bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 font-mono text-white"
                />
                <button
                  type="submit"
                  disabled={!skillTitle.trim()}
                  className="h-8 px-4 rounded-md bg-zinc-100 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-semibold inline-flex items-center gap-1.5 cursor-pointer transition"
                >
                  <Plus className="w-3.5 h-3.5" /> Save Skill
                </button>
              </form>
            )}

            {/* Status / Error Banner */}
            {installerNotice && (
              <div
                className={`p-2.5 rounded-lg border text-[11px] ${
                  installerNotice.ok
                    ? "bg-emerald-500/10 border-emerald-500/35 text-emerald-300"
                    : "bg-rose-500/10 border-rose-500/35 text-rose-300"
                }`}
              >
                {installerNotice.text}
              </div>
            )}

            {/* Interactive Preview & Security Audit Panel */}
            {previewSkills.length > 0 && (
              <div className="rounded-xl bg-[#09090b] border border-amber-500/35 p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-white">
                      Preview &amp; Security Check ({previewSkills.length} skill{previewSkills.length > 1 ? "s" : ""} found)
                    </div>
                    <div className="text-[10px] font-mono text-zinc-400">
                      Source: {previewSource} → {targetBrainFolder}/skills/
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => {
                        const allSelected = selectedCount === previewSkills.length;
                        const next: Record<string, boolean> = {};
                        for (const s of previewSkills) next[s.slug] = !allSelected;
                        setSelectedSlugs(next);
                      }}
                      className="text-amber-300 hover:text-amber-200 underline cursor-pointer"
                    >
                      {selectedCount === previewSkills.length ? "Deselect all" : "Select all"}
                    </button>
                    <button
                      type="button"
                      onClick={resetPreview}
                      className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>

                <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                  {previewSkills.map((sk) => {
                    const checked = Boolean(selectedSlugs[sk.slug]);
                    const isOpen = expandedSlug === sk.slug;
                    return (
                      <div
                        key={sk.slug}
                        className={`rounded-lg border p-2.5 space-y-2 transition ${
                          checked ? "bg-[#111113] border-amber-500/40" : "bg-[#0c0c0e] border-white/[0.08] opacity-70"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2 min-w-0">
                            <button
                              type="button"
                              onClick={() => setSelectedSlugs((prev) => ({ ...prev, [sk.slug]: !prev[sk.slug] }))}
                              className="mt-0.5 text-amber-400 cursor-pointer shrink-0"
                            >
                              {checked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-zinc-500" />}
                            </button>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-bold text-white">{sk.name}</span>
                                <code className="text-[10px] text-cyan-300 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                                  {sk.slug}
                                </code>
                                {renderRiskBadge(sk.riskLevel)}
                                {sk.alreadyInstalled && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#18181b] text-amber-300">
                                    Exists
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-2">{sk.description}</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setExpandedSlug(isOpen ? "" : sk.slug)}
                            className="text-zinc-400 hover:text-white p-1 shrink-0 cursor-pointer"
                            title="Inspect files & SKILL.md"
                          >
                            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        </div>

                        {sk.findings.length > 0 && (
                          <div className="rounded-md bg-[#09090b] border border-white/[0.08] p-2 space-y-1 text-[10px]">
                            {sk.findings.slice(0, isOpen ? 20 : 3).map((f, idx) => (
                              <div key={idx} className="flex items-start gap-1.5">
                                <span
                                  className={`font-bold uppercase shrink-0 ${
                                    f.severity === "high" ? "text-rose-400" : "text-amber-300"
                                  }`}
                                >
                                  [{f.severity}]
                                </span>
                                <span className="text-zinc-300">
                                  <code className="text-zinc-400">
                                    {f.file}:{f.line}
                                  </code>{" "}
                                  — {f.rule}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {isOpen && (
                          <div className="space-y-2 pt-1 border-t border-white/[0.07]">
                            <div className="flex flex-wrap gap-1">
                              {sk.files.map((fp) => (
                                <span
                                  key={fp}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#18181b] text-zinc-300 font-mono text-[10px]"
                                >
                                  <FileCode2 className="w-2.5 h-2.5 text-zinc-400" /> {fp}
                                </span>
                              ))}
                            </div>
                            <pre className="max-h-40 overflow-auto rounded-lg bg-[#09090b] border border-white/[0.08] p-2 text-[10px] font-mono text-zinc-300 whitespace-pre-wrap">
                              {sk.markdownPreview}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-white/[0.08]">
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={overwrite}
                      onChange={(e) => setOverwrite(e.target.checked)}
                      className="rounded border-white/[0.10]"
                    />
                    Overwrite existing skills with same slug
                  </label>
                  <button
                    type="button"
                    disabled={installing || selectedCount === 0}
                    onClick={handleInstallSelected}
                    className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-[#18181b] disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-bold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    {installing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    {installing ? "Installing..." : `Install Selected (${selectedCount})`}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Installed Skills Library */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-zinc-300 uppercase tracking-wider">
                Installed Skills ({skills.length})
              </span>
              <span className="text-[11px] font-mono text-zinc-500">CLI: pandawa skill install &lt;source&gt;</span>
            </div>

            {skills.map((s) => (
              <div key={s.path} className="p-4 rounded-xl bg-[#111113] border border-white/[0.08] space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-bold text-white">{s.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#18181b] text-zinc-300 font-mono">
                        {s.fileCount || 1} file{(s.fileCount || 1) > 1 ? "s" : ""}
                      </span>
                      {s.riskLevel && renderRiskBadge(s.riskLevel)}
                    </div>
                    <div className="text-[11px] font-mono text-zinc-500 flex flex-wrap items-center gap-2">
                      <span>{s.path}</span>
                      {s.source && (
                        <span className="px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                          {s.source}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => onOpenFile(s.path)}
                      className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 cursor-pointer"
                    >
                      <ExternalLink className="w-3 h-3" /> Edit
                    </button>
                    <button
                      aria-label={`Uninstall ${s.name}`}
                      onClick={() => handleUninstallSkill(s)}
                      className="text-zinc-500 hover:text-rose-400 p-1 cursor-pointer"
                      title="Uninstall skill"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-zinc-400">{s.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Memories Column */}
        <div className="space-y-4">
          <form onSubmit={addMemory} className="p-4 rounded-xl bg-[#111113] border border-white/[0.08] space-y-3 text-xs">
            <div className="font-bold text-violet-300 uppercase tracking-wider flex items-center gap-1.5">
              <Brain className="w-4 h-4" /> Store Episodic Memory (FTS5 Indexed)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={memBrainId}
                onChange={(e) => setMemBrainId(e.target.value)}
                className="bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
              >
                {brains.map((b) => (
                  <option key={b.id} value={b.id}>
                    [{b.layer.toUpperCase()}] {b.name}
                  </option>
                ))}
              </select>
              <select
                value={memCategory}
                onChange={(e) => setMemCategory(e.target.value)}
                className="bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
              >
                <option value="fact">Fact</option>
                <option value="decision">Decision</option>
                <option value="preference">Preference</option>
                <option value="lesson">Lesson Learned</option>
              </select>
            </div>
            <textarea
              rows={2}
              value={memContent}
              onChange={(e) => setMemContent(e.target.value)}
              placeholder="Write a persistent fact, decision, or preference for the team..."
              className="w-full bg-[#09090b] border border-white/[0.10] rounded-lg px-3 py-2 text-white"
            />
            <button
              type="submit"
              disabled={!memContent.trim()}
              className="h-8 px-4 rounded-md bg-zinc-100 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-semibold inline-flex items-center gap-1.5 cursor-pointer transition"
            >
              <Plus className="w-3.5 h-3.5" /> Add Memory
            </button>
          </form>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={memSearch}
              onChange={(e) => {
                setMemSearch(e.target.value);
                load(e.target.value).catch(() => {});
              }}
              placeholder="FTS5 search episodic memories..."
              className="w-full bg-[#111113] border border-white/[0.08] focus:border-violet-500 rounded-xl pl-9 pr-3 py-2 text-xs text-white outline-none"
            />
          </div>

          <div className="space-y-2">
            {memories.map((m) => (
              <div key={m.id} className="p-3.5 rounded-xl bg-[#111113] border border-white/[0.08] flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 uppercase font-bold">
                      {m.category}
                    </span>
                    <span className="text-zinc-500 font-mono">{m.brain_id}</span>
                  </div>
                  <div className="text-xs text-zinc-200">{m.content}</div>
                </div>
                <button
                  aria-label="Delete memory"
                  onClick={async () => {
                    await apiFetch(`/api/memories/${m.id}`, { method: "DELETE" });
                    await load(memSearch);
                  }}
                  className="text-zinc-600 hover:text-rose-400 p-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {memories.length === 0 && (
              <div className="p-4 rounded-xl bg-[#111113] border border-white/[0.07] text-xs text-zinc-400 text-center">
                {memSearch.trim()
                  ? "No memories match your search query."
                  : "No episodic memories stored yet. Add one above or let Pandawa agents store lessons automatically during missions."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

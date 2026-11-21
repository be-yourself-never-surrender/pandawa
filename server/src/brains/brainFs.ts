import fs from "node:fs";
import path from "node:path";
import { BRAINS_DIR, ensureDirectories } from "../config.js";
import { getDb } from "../db/database.js";

export interface BrainTreeNode {
  name: string;
  path: string; // forward-slash relative path inside BRAINS_DIR
  type: "file" | "folder";
  size?: number;
  updatedAt?: string;
  children?: BrainTreeNode[];
}

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".sh", ".sql", ".xml", ".html", ".css", ".env", ""
]);

export function normalizeRelPath(relPath: string): string {
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleaned.includes("..")) {
    throw new Error("Path traversal is not allowed.");
  }
  return cleaned;
}

export function resolveBrainPath(relPath: string): string {
  ensureDirectories();
  const norm = normalizeRelPath(relPath);
  const full = path.resolve(BRAINS_DIR, norm);
  const root = path.resolve(BRAINS_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Resolved path escapes brain directory.");
  }
  return full;
}

export function listBrainTree(subPath = ""): BrainTreeNode[] {
  const baseFull = resolveBrainPath(subPath);
  if (!fs.existsSync(baseFull)) return [];

  function walk(dirFull: string, relPrefix: string): BrainTreeNode[] {
    const entries = fs.readdirSync(dirFull, { withFileTypes: true });
    const result: BrainTreeNode[] = [];

    const layerOrder = ["main-brain", "teams", "agents"];
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      if (!relPrefix && a.isDirectory() && b.isDirectory()) {
        const ia = layerOrder.indexOf(a.name.toLowerCase());
        const ib = layerOrder.indexOf(b.name.toLowerCase());
        if (ia !== -1 || ib !== -1) {
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        }
      }
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dirFull, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const stat = fs.statSync(full);

      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: rel,
          type: "folder",
          updatedAt: stat.mtime.toISOString(),
          children: walk(full, rel),
        });
      } else {
        result.push({
          name: entry.name,
          path: rel,
          type: "file",
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
    return result;
  }

  return walk(baseFull, normalizeRelPath(subPath));
}

export function readBrainFile(relPath: string): { path: string; content: string; size: number; updatedAt: string } {
  const norm = normalizeRelPath(relPath);
  const full = resolveBrainPath(norm);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    throw new Error(`Brain file not found: ${norm}`);
  }
  const content = fs.readFileSync(full, "utf8");
  const stat = fs.statSync(full);
  return {
    path: norm,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

export function writeBrainFile(relPath: string, content: string): { path: string; size: number } {
  const norm = normalizeRelPath(relPath);
  if (!norm) throw new Error("File path cannot be empty.");
  const full = resolveBrainPath(norm);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  indexBrainFile(norm, content);
  return { path: norm, size: Buffer.byteLength(content, "utf8") };
}

export function createBrainFolder(relPath: string): { path: string } {
  const norm = normalizeRelPath(relPath);
  if (!norm) throw new Error("Folder path cannot be empty.");
  const full = resolveBrainPath(norm);
  fs.mkdirSync(full, { recursive: true });
  return { path: norm };
}

export function renameBrainEntry(oldRelPath: string, newRelPath: string): { from: string; to: string } {
  const oldNorm = normalizeRelPath(oldRelPath);
  const newNorm = normalizeRelPath(newRelPath);
  if (!oldNorm || !newNorm) throw new Error("Paths cannot be empty.");
  const oldFull = resolveBrainPath(oldNorm);
  const newFull = resolveBrainPath(newNorm);
  if (!fs.existsSync(oldFull)) throw new Error(`Path does not exist: ${oldNorm}`);
  fs.mkdirSync(path.dirname(newFull), { recursive: true });
  fs.renameSync(oldFull, newFull);
  reindexAllBrainFiles();
  return { from: oldNorm, to: newNorm };
}

export function deleteBrainEntry(relPath: string): { deleted: string } {
  const norm = normalizeRelPath(relPath);
  if (!norm) throw new Error("Cannot delete root brains directory.");
  const full = resolveBrainPath(norm);
  if (!fs.existsSync(full)) throw new Error(`Path does not exist: ${norm}`);
  fs.rmSync(full, { recursive: true, force: true });
  reindexAllBrainFiles();
  return { deleted: norm };
}

export function collectContextFromPath(relPath: string, maxChars = 16000): { files: Array<{ path: string; content: string }>; truncated: boolean } {
  const norm = normalizeRelPath(relPath);
  const full = resolveBrainPath(norm);
  if (!fs.existsSync(full)) {
    return { files: [], truncated: false };
  }

  const collected: Array<{ path: string; content: string }> = [];
  let totalChars = 0;
  let truncated = false;

  function addFile(fileFull: string, fileRel: string): void {
    if (truncated) return;
    const ext = path.extname(fileFull).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return;
    let content = fs.readFileSync(fileFull, "utf8");
    if (totalChars + content.length > maxChars) {
      const remain = Math.max(0, maxChars - totalChars);
      if (remain > 200) {
        content = content.slice(0, remain) + "\n...[truncated]";
        collected.push({ path: fileRel, content });
      }
      truncated = true;
      return;
    }
    totalChars += content.length;
    collected.push({ path: fileRel, content });
  }

  const stat = fs.statSync(full);
  if (stat.isFile()) {
    addFile(full, norm);
    return { files: collected, truncated };
  }

  // Folder: prioritize soul.md, identity.md, rules.md, memory.md, team.md first
  const priorityOrder = ["soul.md", "identity.md", "rules.md", "team.md", "memory.md", "readme.md"];
  function walkCollect(dirFull: string, relPrefix: string): void {
    if (truncated) return;
    const entries = fs.readdirSync(dirFull, { withFileTypes: true });
    entries.sort((a, b) => {
      const ia = priorityOrder.indexOf(a.name.toLowerCase());
      const ib = priorityOrder.indexOf(b.name.toLowerCase());
      if (ia !== -1 || ib !== -1) {
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      }
      if (!a.isDirectory() && b.isDirectory()) return -1;
      if (a.isDirectory() && !b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (truncated || entry.name.startsWith(".")) continue;
      const eFull = path.join(dirFull, entry.name);
      const eRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkCollect(eFull, eRel);
      } else {
        addFile(eFull, eRel);
      }
    }
  }

  walkCollect(full, norm);
  return { files: collected, truncated };
}

export function indexBrainFile(relPath: string, content: string): void {
  try {
    const db = getDb();
    db.prepare("DELETE FROM brain_files_fts WHERE rel_path = ?").run(relPath);
    const title = path.basename(relPath);
    db.prepare("INSERT INTO brain_files_fts (rel_path, title, content) VALUES (?, ?, ?)").run(
      relPath,
      title,
      content
    );
  } catch {
    // Non-fatal index error
  }
}

export function reindexAllBrainFiles(): void {
  const db = getDb();
  ensureDirectories();
  db.exec("DELETE FROM brain_files_fts;");

  function walk(dirFull: string, relPrefix: string): void {
    if (!fs.existsSync(dirFull)) return;
    for (const entry of fs.readdirSync(dirFull, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dirFull, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext)) {
          try {
            const content = fs.readFileSync(full, "utf8");
            db.prepare("INSERT INTO brain_files_fts (rel_path, title, content) VALUES (?, ?, ?)").run(
              rel,
              entry.name,
              content
            );
          } catch {
            // skip unreadable
          }
        }
      }
    }
  }

  walk(BRAINS_DIR, "");
}

export function searchBrainFiles(query: string, limit = 12): Array<{ rel_path: string; title: string; snippet: string }> {
  const db = getDb();
  const safeQuery = query
    .replace(/["'*^():-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok}"*`)
    .join(" OR ");
  if (!safeQuery) return [];
  try {
    const rows = db
      .prepare(
        `SELECT rel_path, title, snippet(brain_files_fts, 2, '[[', ']]', '...', 24) as snippet
         FROM brain_files_fts
         WHERE brain_files_fts MATCH ?
         LIMIT ?`
      )
      .all(safeQuery, limit) as Array<{ rel_path: string; title: string; snippet: string }>;
    return rows;
  } catch {
    return [];
  }
}

export interface SkillEntryInfo {
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

function parseSkillMeta(content: string, fallbackSlug: string): { name: string; description: string } {
  let name = "";
  let description = "";
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const n = fm.match(/^name:\s*(.+)$/m);
    if (n) name = n[1].trim().replace(/^["']|["']$/g, "");
    const dInline = fm.match(/^description:\s*([^|>\r\n].*)$/m);
    if (dInline) {
      description = dInline[1].trim().replace(/^["']|["']$/g, "");
    } else {
      const dBlock = fm.match(/^description:\s*[|>]-?\r?\n((?:[ \t]+.+\r?\n?)+)/m);
      if (dBlock) {
        description = dBlock[1]
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" ");
      }
    }
  }
  if (!name) {
    const h1 = content.match(/^#\s+(.+)$/m);
    name = h1 ? h1[1].trim() : fallbackSlug;
  }
  if (!description) {
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    description = body.replace(/^#.*$/gm, "").trim().slice(0, 180);
  }
  return { name, description };
}

function countNonHiddenFiles(dirFull: string): number {
  let count = 0;
  function walkCount(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walkCount(full);
      else count += 1;
    }
  }
  try {
    walkCount(dirFull);
  } catch {
    // ignore
  }
  return Math.max(1, count);
}

export function listSkills(): SkillEntryInfo[] {
  const results: SkillEntryInfo[] = [];

  function walk(dirFull: string, relPrefix: string): void {
    if (!fs.existsSync(dirFull)) return;
    const entries = fs.readdirSync(dirFull, { withFileTypes: true });

    // If this folder itself contains SKILL.md, treat the whole folder as ONE skill package
    // (don't list nested references/*.md or examples/*.md as duplicate skills)
    const skillFile = entries.find((e) => !e.isDirectory() && e.name.toLowerCase() === "skill.md");
    if (skillFile && relPrefix) {
      const full = path.join(dirFull, skillFile.name);
      const rel = `${relPrefix}/${skillFile.name}`;
      const slug = path.basename(relPrefix);
      const content = fs.readFileSync(full, "utf8");
      const { name, description } = parseSkillMeta(content, slug);
      const brainFolder = rel.includes("/skills/") ? rel.split("/skills/")[0] : rel.split("/")[0] || "main-brain";

      let source: string | undefined;
      let installedAt: string | undefined;
      let riskLevel: "clean" | "review" | "caution" | undefined;
      const metaPath = path.join(dirFull, ".pandawa-skill.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
            source?: string;
            installedAt?: string;
            riskLevel?: "clean" | "review" | "caution";
          };
          source = meta.source;
          installedAt = meta.installedAt;
          riskLevel = meta.riskLevel;
        } catch {
          // ignore malformed metadata
        }
      }

      results.push({
        slug,
        path: rel,
        dirPath: relPrefix,
        name,
        brainFolder,
        description,
        content,
        fileCount: countNonHiddenFiles(dirFull),
        source,
        installedAt,
        riskLevel,
      });
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dirFull, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (rel.includes("/skills/") && entry.name.toLowerCase().endsWith(".md")) {
        // Legacy standalone skill markdown directly under <brain>/skills/<name>.md
        const slug = entry.name.replace(/\.md$/i, "");
        const content = fs.readFileSync(full, "utf8");
        const { name, description } = parseSkillMeta(content, slug);
        const brainFolder = rel.split("/skills/")[0] || "main-brain";
        results.push({
          slug,
          path: rel,
          dirPath: rel,
          name,
          brainFolder,
          description,
          content,
          fileCount: 1,
        });
      }
    }
  }

  walk(BRAINS_DIR, "");
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// ======================================================
// LIVING BRAIN VAULT: [[wikilink]] Graph & Progressive Disclosure
// ======================================================

export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].trim();
    if (raw && !seen.has(raw.toLowerCase())) {
      seen.add(raw.toLowerCase());
      links.push(raw);
    }
  }
  return links;
}

export function listAllBrainFilesFlat(): Array<{ path: string; name: string; stem: string; size: number }> {
  ensureDirectories();
  const out: Array<{ path: string; name: string; stem: string; size: number }> = [];
  function walk(dirFull: string, relPrefix: string) {
    if (!fs.existsSync(dirFull)) return;
    for (const entry of fs.readdirSync(dirFull, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dirFull, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext)) {
          const stat = fs.statSync(full);
          const stem = entry.name.replace(/\.[^.]+$/, "");
          out.push({ path: rel, name: entry.name, stem, size: stat.size });
        }
      }
    }
  }
  walk(BRAINS_DIR, "");
  return out;
}

export function resolveWikilinkTarget(
  target: string,
  allFiles: Array<{ path: string; name: string; stem: string }>
): string | null {
  const q = target.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!q) return null;
  const qWithMd = q.endsWith(".md") ? q : `${q}.md`;

  // 1. Exact relative path match
  const exact = allFiles.find((f) => f.path.toLowerCase() === q || f.path.toLowerCase() === qWithMd);
  if (exact) return exact.path;

  // 2. Suffix path match (e.g. "skills/deploy/SKILL" or "rules")
  const suffix = allFiles.find(
    (f) => f.path.toLowerCase().endsWith(`/${q}`) || f.path.toLowerCase().endsWith(`/${qWithMd}`)
  );
  if (suffix) return suffix.path;

  // 3. Stem/basename match (Obsidian style [[architecture]] -> main-brain/architecture.md)
  const byStem = allFiles.find((f) => f.stem.toLowerCase() === q || f.name.toLowerCase() === q);
  if (byStem) return byStem.path;

  return null;
}

export function getBrainLinkGraph(): {
  files: Array<{ path: string; title: string; outgoing: string[]; backlinks: string[] }>;
  edges: Array<{ source: string; target: string; raw: string }>;
} {
  const allFiles = listAllBrainFilesFlat();
  const outgoingMap = new Map<string, string[]>();
  const backlinksMap = new Map<string, string[]>();
  const titlesMap = new Map<string, string>();
  const edges: Array<{ source: string; target: string; raw: string }> = [];

  for (const f of allFiles) {
    outgoingMap.set(f.path, []);
    backlinksMap.set(f.path, []);
  }

  for (const f of allFiles) {
    try {
      const content = fs.readFileSync(resolveBrainPath(f.path), "utf8");
      const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || f.name;
      titlesMap.set(f.path, h1);
      const rawLinks = extractWikilinks(content);
      for (const raw of rawLinks) {
        const resolved = resolveWikilinkTarget(raw, allFiles);
        if (resolved && resolved !== f.path) {
          outgoingMap.get(f.path)!.push(resolved);
          backlinksMap.get(resolved)!.push(f.path);
          edges.push({ source: f.path, target: resolved, raw });
        }
      }
    } catch {
      // skip unreadable
    }
  }

  return {
    files: allFiles.map((f) => ({
      path: f.path,
      title: titlesMap.get(f.path) || f.name,
      outgoing: Array.from(new Set(outgoingMap.get(f.path) || [])),
      backlinks: Array.from(new Set(backlinksMap.get(f.path) || [])),
    })),
    edges,
  };
}

export function collectProgressiveBrainContext(
  relPath: string,
  coreCharBudget = 16_000
): {
  coreFiles: Array<{ path: string; content: string; viaLink?: boolean }>;
  indexedFiles: Array<{ path: string; title: string; summary: string; links: string[] }>;
  totalFiles: number;
} {
  const norm = normalizeRelPath(relPath);
  const full = resolveBrainPath(norm);
  if (!fs.existsSync(full)) {
    return { coreFiles: [], indexedFiles: [], totalFiles: 0 };
  }

  const stat = fs.statSync(full);
  if (stat.isFile()) {
    const content = fs.readFileSync(full, "utf8").slice(0, coreCharBudget);
    return { coreFiles: [{ path: norm, content }], indexedFiles: [], totalFiles: 1 };
  }

  const coreNames = new Set(["soul.md", "identity.md", "rules.md", "team.md", "memory.md"]);
  const coreOrder = ["soul.md", "identity.md", "rules.md", "team.md", "memory.md"];
  const allVaultFiles = listAllBrainFilesFlat();
  const folderFiles = allVaultFiles.filter((f) => f.path === norm || f.path.startsWith(`${norm}/`));

  const coreCandidates: typeof folderFiles = [];
  const otherFiles: typeof folderFiles = [];
  for (const f of folderFiles) {
    const isTopLevel = f.path.slice(norm.length + 1).indexOf("/") === -1;
    if (isTopLevel && coreNames.has(f.name.toLowerCase())) {
      coreCandidates.push(f);
    } else {
      otherFiles.push(f);
    }
  }
  coreCandidates.sort((a, b) => coreOrder.indexOf(a.name.toLowerCase()) - coreOrder.indexOf(b.name.toLowerCase()));

  const coreFiles: Array<{ path: string; content: string; viaLink?: boolean }> = [];
  const loadedPaths = new Set<string>();
  const linkedTargets = new Set<string>();
  let usedChars = 0;

  for (const f of coreCandidates) {
    try {
      let content = fs.readFileSync(resolveBrainPath(f.path), "utf8");
      for (const raw of extractWikilinks(content)) {
        const target = resolveWikilinkTarget(raw, allVaultFiles);
        if (target) linkedTargets.add(target);
      }
      if (usedChars + content.length > coreCharBudget) {
        const remain = Math.max(0, coreCharBudget - usedChars);
        if (remain > 300) {
          content = content.slice(0, remain) + "\n...[use brain_read for full file]";
        } else {
          continue;
        }
      }
      usedChars += content.length;
      loadedPaths.add(f.path);
      coreFiles.push({ path: f.path, content });
    } catch {
      // skip
    }
  }

  // Automatically follow 1-hop [[wikilinks]] referenced from soul.md / rules.md / team.md!
  for (const targetPath of linkedTargets) {
    if (loadedPaths.has(targetPath) || usedChars >= coreCharBudget) continue;
    try {
      let content = fs.readFileSync(resolveBrainPath(targetPath), "utf8");
      const remain = Math.max(0, coreCharBudget - usedChars);
      if (remain < 300) break;
      if (content.length > Math.min(remain, 3500)) {
        content = content.slice(0, Math.min(remain, 3500)) + "\n...[use brain_read for full linked note]";
      }
      usedChars += content.length;
      loadedPaths.add(targetPath);
      coreFiles.push({ path: targetPath, content, viaLink: true });
    } catch {
      // skip
    }
  }

  // Progressive disclosure index for all remaining docs & SKILL.md files (never lost!)
  const indexedFiles: Array<{ path: string; title: string; summary: string; links: string[] }> = [];
  for (const f of otherFiles) {
    if (loadedPaths.has(f.path)) continue;
    try {
      const content = fs.readFileSync(resolveBrainPath(f.path), "utf8");
      const titleMatch = content.match(/^#\s+(.+)$/m) || content.match(/^name:\s*(.+)$/m);
      const descMatch = content.match(/^description:\s*(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : f.name;
      const summary = descMatch
        ? descMatch[1].trim()
        : content
            .replace(/^---[\s\S]*?---/m, "")
            .replace(/^#.*$/gm, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 140);
      indexedFiles.push({
        path: f.path,
        title,
        summary,
        links: extractWikilinks(content).slice(0, 6),
      });
    } catch {
      // skip
    }
  }

  return {
    coreFiles,
    indexedFiles,
    totalFiles: folderFiles.length,
  };
}

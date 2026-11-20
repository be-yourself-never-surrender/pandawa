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

    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
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

export function listSkills(): Array<{
  path: string;
  name: string;
  brainFolder: string;
  description: string;
  content: string;
}> {
  const results: Array<{
    path: string;
    name: string;
    brainFolder: string;
    description: string;
    content: string;
  }> = [];

  function walk(dirFull: string, relPrefix: string): void {
    if (!fs.existsSync(dirFull)) return;
    for (const entry of fs.readdirSync(dirFull, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dirFull, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name.toLowerCase() === "skill.md" || rel.includes("/skills/")) {
        if (!entry.name.toLowerCase().endsWith(".md")) continue;
        const content = fs.readFileSync(full, "utf8");
        const nameMatch = content.match(/^#\s+(.+)$/m) || content.match(/^name:\s*(.+)$/m);
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim() : path.basename(path.dirname(rel));
        const description = descMatch
          ? descMatch[1].trim()
          : content.replace(/^#.*$/gm, "").trim().slice(0, 140);
        const brainFolder = rel.split("/")[0] || "main-brain";
        results.push({ path: rel, name, brainFolder, description, content });
      }
    }
  }

  walk(BRAINS_DIR, "");
  return results;
}

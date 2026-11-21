import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BRAINS_DIR } from "../config.js";
import { normalizeRelPath, resolveBrainPath, reindexAllBrainFiles } from "../brains/brainFs.js";
import { assertSafeOutboundUrl } from "../tools/netGuard.js";
import { runPythonWorker } from "../tools/pythonWorker.js";
import { reindexSemanticBrain } from "../brains/semanticMemory.js";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "__macosx",
  ".obsidian",
  ".next",
  "dist",
  "build",
]);

const ALLOWED_SKILL_EXTS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".ps1",
  ".sql",
  ".xml",
  ".html",
  ".css",
  ".ini",
  ".cfg",
  ".jinja",
  ".j2",
  ".tmpl",
  "",
]);

const EXECUTABLE_EXTS = new Set([".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".ps1", ".bat", ".cmd"]);

export interface SkillSecurityFinding {
  severity: "high" | "medium" | "info";
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

export interface DiscoveredSkillPreview {
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
  findings: SkillSecurityFinding[];
  alreadyInstalled: boolean;
  targetDir: string;
}

interface InternalDiscoveredSkill extends DiscoveredSkillPreview {
  fileContents: Array<{ relPath: string; content: string }>;
}

export interface UploadedSkillFileInput {
  name: string;
  content?: string;
  base64?: string;
}

function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "imported-skill";
}

function parseFrontmatter(content: string, fallbackSlug: string): {
  name: string;
  description: string;
  version?: string;
  author?: string;
} {
  let name = "";
  let description = "";
  let version: string | undefined;
  let author: string | undefined;

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const n = fm.match(/^name:\s*(.+)$/m);
    if (n) name = n[1].trim().replace(/^["']|["']$/g, "");

    const v = fm.match(/^version:\s*(.+)$/m);
    if (v) version = v[1].trim().replace(/^["']|["']$/g, "");

    const a = fm.match(/^author:\s*(.+)$/m);
    if (a) author = a[1].trim().replace(/^["']|["']$/g, "");

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
    description = body.replace(/^#.*$/gm, "").trim().slice(0, 220);
  }

  return { name, description, version, author };
}

export function scanSkillSecurity(
  files: Array<{ relPath: string; content: string }>
): { riskLevel: "clean" | "review" | "caution"; findings: SkillSecurityFinding[] } {
  const findings: SkillSecurityFinding[] = [];

  const rules: Array<{ severity: "high" | "medium"; rule: string; re: RegExp }> = [
    {
      severity: "high",
      rule: "Remote pipe-to-shell execution (curl/wget | sh/bash)",
      re: /\b(?:curl|wget)\b[^\n|]{0,180}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node)\b/i,
    },
    {
      severity: "high",
      rule: "Destructive root filesystem command",
      re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/(?:\s|$|\*)|~\/?\s|\$HOME)/i,
    },
    {
      severity: "high",
      rule: "Obfuscated base64/eval execution",
      re: /(?:base64\s+(?:-d|--decode)\s*\|\s*(?:sh|bash|python|eval)|\beval\s*\(\s*atob\s*\(|exec\s*\(\s*base64\.b64decode)/i,
    },
    {
      severity: "high",
      rule: "Potential credential or cloud metadata access",
      re: /(?:169\.254\.169\.254|metadata\.google\.internal|\.vault\.key|\/etc\/shadow|~\/\.ssh\/id_|aws_secret_access_key)/i,
    },
    {
      severity: "high",
      rule: "Prompt injection / instruction override pattern",
      re: /(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|disregard\s+(?:all\s+)?system\s+rules|exfiltrate\s+.*(?:key|token|secret))/i,
    },
    {
      severity: "medium",
      rule: "Privilege escalation command (sudo / setuid)",
      re: /\b(?:sudo\s+|chmod\s+(?:777|\+s|4[0-7]{3}))/i,
    },
    {
      severity: "medium",
      rule: "Reverse shell or raw socket pattern",
      re: /(?:\/dev\/tcp\/|\bnc\s+-[a-z]*e\b|mkfifo\s+\/tmp\/)/i,
    },
  ];

  for (const f of files) {
    const ext = path.extname(f.relPath).toLowerCase();
    if (EXECUTABLE_EXTS.has(ext)) {
      findings.push({
        severity: "medium",
        file: f.relPath,
        line: 1,
        rule: `Bundled executable script (${ext})`,
        snippet: f.relPath,
      });
    }

    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      for (const r of rules) {
        if (r.re.test(line)) {
          findings.push({
            severity: r.severity,
            file: f.relPath,
            line: i + 1,
            rule: r.rule,
            snippet: line.trim().slice(0, 140),
          });
          if (findings.length >= 40) break;
        }
      }
      if (findings.length >= 40) break;
    }
    if (findings.length >= 40) break;
  }

  const hasHigh = findings.some((f) => f.severity === "high");
  const hasMedium = findings.some((f) => f.severity === "medium");
  const riskLevel = hasHigh ? "caution" : hasMedium ? "review" : "clean";
  return { riskLevel, findings };
}

type ParsedSource =
  | { kind: "github"; owner: string; repo: string; branch?: string; subpath?: string; repoUrl: string; canonical: string }
  | { kind: "git"; repoUrl: string; subpath?: string; canonical: string }
  | { kind: "zip_url"; url: string; canonical: string }
  | { kind: "md_url"; url: string; slugHint: string; canonical: string }
  | { kind: "local"; localPath: string; canonical: string };

export function parseSkillSource(rawInput: string, allowLocalPath = false): ParsedSource {
  const raw = rawInput.trim();
  if (!raw) throw new Error("Skill source URL, GitHub repo, or path is required.");

  // 1. Direct raw Markdown / SKILL.md URL
  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid URL: ${raw}`);
    }

    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");

    // Direct .zip archive URL
    if (/\.zip$/i.test(pathname)) {
      return { kind: "zip_url", url: parsed.toString(), canonical: parsed.toString() };
    }

    // Raw markdown URL (raw.githubusercontent.com or any .md URL not on github.com HTML viewer)
    if (/\.md$/i.test(pathname) && host !== "github.com" && host !== "www.github.com") {
      const parts = pathname.split("/").filter(Boolean);
      const base = parts[parts.length - 1] || "skill.md";
      const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
      const slugHint = base.toLowerCase() === "skill.md" && parent ? parent : base.replace(/\.md$/i, "");
      return { kind: "md_url", url: parsed.toString(), slugHint: sanitizeSlug(slugHint), canonical: parsed.toString() };
    }

    // GitHub web URL:
    // - https://github.com/owner/repo
    // - https://github.com/owner/repo/tree/<branch>/<subpath>
    // - https://github.com/owner/repo/blob/<branch>/<subpath>/SKILL.md
    if (host === "github.com" || host === "www.github.com") {
      const segs = pathname.split("/").filter(Boolean);
      if (segs.length < 2) {
        throw new Error("GitHub URL must include owner and repository (e.g. https://github.com/owner/repo).");
      }
      const owner = segs[0];
      const repo = segs[1].replace(/\.git$/i, "");
      let branch: string | undefined;
      let subpath: string | undefined;

      if ((segs[2] === "tree" || segs[2] === "blob") && segs.length >= 4) {
        branch = segs[3];
        const rest = segs.slice(4);
        if (segs[2] === "blob" && rest.length > 0 && /\.md$/i.test(rest[rest.length - 1])) {
          // Point to the containing folder if it's a SKILL.md inside a folder
          if (rest[rest.length - 1].toLowerCase() === "skill.md" && rest.length > 1) {
            subpath = rest.slice(0, -1).join("/");
          } else if (rest[rest.length - 1].toLowerCase() === "skill.md") {
            subpath = "";
          } else {
            // Standalone .md file via blob URL -> fetch raw directly
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join("/")}`;
            const slugHint = sanitizeSlug(rest[rest.length - 1].replace(/\.md$/i, ""));
            return { kind: "md_url", url: rawUrl, slugHint, canonical: `github:${owner}/${repo}/${rest.join("/")}` };
          }
        } else {
          subpath = rest.join("/");
        }
      }

      const repoUrl = `https://github.com/${owner}/${repo}.git`;
      const canonical = subpath ? `github:${owner}/${repo}/${subpath}` : `github:${owner}/${repo}`;
      return { kind: "github", owner, repo, branch, subpath, repoUrl, canonical };
    }

    // Generic Git repository URL (.git or GitLab/Bitbucket/Codeberg)
    if (
      /\.git$/i.test(pathname) ||
      host === "gitlab.com" ||
      host === "bitbucket.org" ||
      host === "codeberg.org"
    ) {
      return { kind: "git", repoUrl: parsed.toString(), canonical: parsed.toString() };
    }

    // Fallback: treat other http(s) URL as a single Markdown skill document
    return { kind: "md_url", url: parsed.toString(), slugHint: sanitizeSlug(host), canonical: parsed.toString() };
  }

  // 2. GitHub shorthand: owner/repo or owner/repo/path/to/skill
  // (Only if not a local path starting with ./, ../, /, or Windows drive C:\)
  const looksLocal = raw.startsWith(".") || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
  if (!looksLocal && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/.test(raw)) {
    const segs = raw.split("/").filter(Boolean);
    const owner = segs[0];
    const repo = segs[1].replace(/\.git$/i, "");
    const subpath = segs.slice(2).join("/") || undefined;
    if (subpath && subpath.includes("..")) {
      throw new Error("Path traversal is not allowed in skill source.");
    }
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    const canonical = subpath ? `github:${owner}/${repo}/${subpath}` : `github:${owner}/${repo}`;
    return { kind: "github", owner, repo, subpath, repoUrl, canonical };
  }

  // 3. Local filesystem path (CLI only!)
  if (allowLocalPath) {
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Local skill path not found: ${resolved}`);
    }
    return { kind: "local", localPath: resolved, canonical: `local:${path.basename(resolved)}` };
  }

  throw new Error(
    "Unsupported skill source. Provide a GitHub shorthand (owner/repo), GitHub URL, raw SKILL.md URL, or .zip URL."
  );
}

async function safeFetchBuffer(rawUrl: string, maxBytes: number): Promise<Buffer> {
  await assertSafeOutboundUrl(rawUrl);
  const res = await fetch(rawUrl, {
    redirect: "follow",
    headers: { "User-Agent": "Pandawa-Skill-Installer/7.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.url && res.url !== rawUrl) {
    // Re-validate final redirect target against SSRF!
    await assertSafeOutboundUrl(res.url);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${rawUrl}`);
  }
  const arr = new Uint8Array(await res.arrayBuffer());
  if (arr.byteLength > maxBytes) {
    throw new Error(`Downloaded payload exceeds maximum size (${Math.round(maxBytes / 1024 / 1024)} MB).`);
  }
  return Buffer.from(arr);
}

async function extractZipSafely(zipPath: string, targetDir: string): Promise<void> {
  const zRes = await runPythonWorker<{ ok?: boolean; error?: string }>(
    "import_zip",
    { zipPath, targetDir, relPrefix: "", maxFiles: 500, maxTotalBytes: 30 * 1024 * 1024 },
    90_000
  );
  if (!zRes.ok) {
    throw new Error(zRes.error || "Failed to extract skill ZIP archive.");
  }
}

async function cloneOrDownloadGit(
  parsed: Extract<ParsedSource, { kind: "github" | "git" }>,
  tmpRoot: string
): Promise<string> {
  await assertSafeOutboundUrl(parsed.repoUrl);
  const cloneDir = path.join(tmpRoot, "repo");
  const args = ["clone", "--depth", "1", "--single-branch"];
  if (parsed.kind === "github" && parsed.branch) {
    args.push("--branch", parsed.branch);
  }
  args.push(parsed.repoUrl, cloneDir);

  try {
    await execFileAsync("git", args, {
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return cloneDir;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    // Fallback for GitHub repos when git binary isn't installed
    if (parsed.kind === "github" && e.code === "ENOENT") {
      const ref = parsed.branch ? `refs/heads/${parsed.branch}` : "HEAD";
      const zipUrl = `https://github.com/${parsed.owner}/${parsed.repo}/archive/${ref}.zip`;
      const buf = await safeFetchBuffer(zipUrl, 25 * 1024 * 1024);
      const tmpZip = path.join(tmpRoot, "repo.zip");
      fs.writeFileSync(tmpZip, buf);
      const extractDir = path.join(tmpRoot, "extracted");
      await extractZipSafely(tmpZip, extractDir);
      // GitHub archive wraps everything in <repo>-<branch>/
      const topEntries = fs.readdirSync(extractDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      return topEntries.length === 1 ? path.join(extractDir, topEntries[0].name) : extractDir;
    }
    throw new Error(`Git fetch failed: ${(e.stderr || e.message || String(err)).trim().slice(0, 400)}`);
  }
}

async function fetchSourceToTempDir(
  source: string,
  allowLocalPath = false
): Promise<{ tmpRoot: string; scanRoot: string; canonicalSource: string }> {
  const parsed = parseSkillSource(source, allowLocalPath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-skill-"));

  try {
    if (parsed.kind === "github" || parsed.kind === "git") {
      const repoDir = await cloneOrDownloadGit(parsed, tmpRoot);
      let scanRoot = repoDir;
      if (parsed.subpath) {
        const cleanSub = normalizeRelPath(parsed.subpath);
        const candidate = path.resolve(repoDir, cleanSub);
        if (!candidate.startsWith(path.resolve(repoDir) + path.sep) && candidate !== path.resolve(repoDir)) {
          throw new Error("Subpath escapes cloned repository.");
        }
        if (!fs.existsSync(candidate)) {
          throw new Error(`Subpath "${cleanSub}" not found in repository.`);
        }
        scanRoot = candidate;
      }
      return { tmpRoot, scanRoot, canonicalSource: parsed.canonical };
    }

    if (parsed.kind === "zip_url") {
      const buf = await safeFetchBuffer(parsed.url, 25 * 1024 * 1024);
      const tmpZip = path.join(tmpRoot, "pack.zip");
      fs.writeFileSync(tmpZip, buf);
      const extractDir = path.join(tmpRoot, "extracted");
      await extractZipSafely(tmpZip, extractDir);
      return { tmpRoot, scanRoot: extractDir, canonicalSource: parsed.canonical };
    }

    if (parsed.kind === "md_url") {
      const buf = await safeFetchBuffer(parsed.url, 2 * 1024 * 1024);
      const skillDir = path.join(tmpRoot, "single", parsed.slugHint);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), buf.toString("utf8"), "utf8");
      return { tmpRoot, scanRoot: path.join(tmpRoot, "single"), canonicalSource: parsed.canonical };
    }

    // Local filesystem path (CLI only)
    const stat = fs.statSync(parsed.localPath);
    if (stat.isDirectory()) {
      return { tmpRoot, scanRoot: parsed.localPath, canonicalSource: parsed.canonical };
    }
    if (/\.zip$/i.test(parsed.localPath)) {
      const extractDir = path.join(tmpRoot, "extracted");
      await extractZipSafely(parsed.localPath, extractDir);
      return { tmpRoot, scanRoot: extractDir, canonicalSource: parsed.canonical };
    }
    const slug = sanitizeSlug(path.basename(parsed.localPath, path.extname(parsed.localPath)));
    const skillDir = path.join(tmpRoot, "single", slug);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.copyFileSync(parsed.localPath, path.join(skillDir, "SKILL.md"));
    return { tmpRoot, scanRoot: path.join(tmpRoot, "single"), canonicalSource: parsed.canonical };
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw err;
  }
}

async function stageUploadedFilesToTempDir(
  files: UploadedSkillFileInput[]
): Promise<{ tmpRoot: string; scanRoot: string; canonicalSource: string }> {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("No skill files uploaded.");
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-skill-up-"));
  const stageDir = path.join(tmpRoot, "staged");
  fs.mkdirSync(stageDir, { recursive: true });

  try {
    let sourceLabel = "upload";
    for (const f of files) {
      const cleanName = String(f.name || "SKILL.md").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!cleanName || cleanName.includes("..")) continue;
      const ext = path.extname(cleanName).toLowerCase();

      if (ext === ".zip" && f.base64) {
        sourceLabel = `zip:${path.basename(cleanName)}`;
        const buf = Buffer.from(String(f.base64).replace(/^data:[^;]+;base64,/, ""), "base64");
        if (buf.byteLength > 25 * 1024 * 1024) {
          throw new Error("Uploaded ZIP exceeds 25 MB limit.");
        }
        const tmpZip = path.join(tmpRoot, `in_${Math.random().toString(36).slice(2, 8)}.zip`);
        fs.writeFileSync(tmpZip, buf);
        await extractZipSafely(tmpZip, stageDir);
        continue;
      }

      if (!ALLOWED_SKILL_EXTS.has(ext)) continue;
      const outPath = path.resolve(stageDir, cleanName);
      if (!outPath.startsWith(path.resolve(stageDir) + path.sep)) continue;
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const text =
        typeof f.content === "string"
          ? f.content
          : f.base64
          ? Buffer.from(String(f.base64).replace(/^data:[^;]+;base64,/, ""), "base64").toString("utf8")
          : "";
      fs.writeFileSync(outPath, text, "utf8");
      if (sourceLabel === "upload") sourceLabel = `upload:${cleanName.split("/")[0]}`;
    }

    return { tmpRoot, scanRoot: stageDir, canonicalSource: sourceLabel };
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw err;
  }
}

function collectSkillFolderFiles(skillDir: string): Array<{ relPath: string; content: string }> {
  const collected: Array<{ relPath: string; content: string }> = [];
  let totalBytes = 0;
  const maxFiles = 80;
  const maxBytes = 3 * 1024 * 1024;

  function walk(dir: string, relPrefix: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (collected.length >= maxFiles || totalBytes >= maxBytes) return;
      if (entry.isSymbolicLink()) continue; // Never follow symlinks!
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name.toLowerCase())) continue;

      const full = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_SKILL_EXTS.has(ext)) continue;
        const stat = fs.statSync(full);
        if (stat.size > 1024 * 1024 || totalBytes + stat.size > maxBytes) continue;
        const content = fs.readFileSync(full, "utf8");
        totalBytes += stat.size;
        collected.push({ relPath: rel, content });
      }
    }
  }

  walk(skillDir, "");
  // Ensure SKILL.md comes first
  collected.sort((a, b) => {
    const aSkill = a.relPath.toLowerCase() === "skill.md" ? 0 : 1;
    const bSkill = b.relPath.toLowerCase() === "skill.md" ? 0 : 1;
    if (aSkill !== bSkill) return aSkill - bSkill;
    return a.relPath.localeCompare(b.relPath);
  });
  return collected;
}

export function discoverSkillsInDir(
  scanRoot: string,
  brainFolder: string,
  canonicalSource: string
): InternalDiscoveredSkill[] {
  const cleanBrain = normalizeRelPath(brainFolder || "main-brain") || "main-brain";
  const foundDirs: Array<{ dir: string; sourceSubpath: string }> = [];
  const rootReal = path.resolve(scanRoot);

  function walkForSkillMd(dir: string, relPrefix: string, depth: number): void {
    if (depth > 8 || foundDirs.length >= 50) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasSkillMd = entries.some((e) => !e.isDirectory() && !e.isSymbolicLink() && e.name.toLowerCase() === "skill.md");
    if (hasSkillMd) {
      foundDirs.push({ dir, sourceSubpath: relPrefix || "." });
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      // Allow hidden directories like .claude / .cursor / .agents because many repos store skills there
      if (entry.name.startsWith(".") && ![".claude", ".cursor", ".agents", ".codex", ".antigravity", ".gemini"].includes(entry.name.toLowerCase())) {
        continue;
      }
      walkForSkillMd(path.join(dir, entry.name), relPrefix ? `${relPrefix}/${entry.name}` : entry.name, depth + 1);
    }
  }

  walkForSkillMd(rootReal, "", 0);

  const results: InternalDiscoveredSkill[] = [];
  const usedSlugs = new Set<string>();

  for (const item of foundDirs) {
    const files = collectSkillFolderFiles(item.dir);
    const skillMd = files.find((f) => f.relPath.toLowerCase() === "skill.md");
    if (!skillMd) continue;

    // Normalize main file name to SKILL.md
    if (skillMd.relPath !== "SKILL.md") skillMd.relPath = "SKILL.md";

    const dirName = path.basename(item.dir);
    const fallbackSlug = sanitizeSlug(
      dirName === "repo" || dirName === "extracted" || dirName === "staged"
        ? canonicalSource.split("/").pop() || "custom-skill"
        : dirName
    );
    const meta = parseFrontmatter(skillMd.content, fallbackSlug);
    let slug = sanitizeSlug(dirName === "repo" || dirName === "extracted" || dirName === "staged" ? meta.name : dirName);
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);

    const security = scanSkillSecurity(files);
    const targetDir = `${cleanBrain}/skills/${slug}`;
    const alreadyInstalled = fs.existsSync(resolveBrainPath(`${targetDir}/SKILL.md`));
    const totalBytes = files.reduce((acc, f) => acc + Buffer.byteLength(f.content, "utf8"), 0);

    results.push({
      slug,
      name: meta.name,
      description: meta.description,
      version: meta.version,
      author: meta.author,
      sourceSubpath: item.sourceSubpath,
      fileCount: files.length,
      totalBytes,
      files: files.map((f) => f.relPath),
      markdownPreview: skillMd.content.slice(0, 2200),
      riskLevel: security.riskLevel,
      findings: security.findings,
      alreadyInstalled,
      targetDir,
      fileContents: files,
    });
  }

  // Fallback: if no SKILL.md found, look for standalone .md files (excluding root README.md unless it's the only .md)
  if (results.length === 0) {
    const mdFiles: Array<{ full: string; rel: string }> = [];
    function walkMd(dir: string, relPrefix: string, depth: number): void {
      if (depth > 3 || mdFiles.length >= 25) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        const full = path.join(dir, entry.name);
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walkMd(full, rel, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) mdFiles.push({ full, rel });
      }
    }
    walkMd(rootReal, "", 0);

    const filtered = mdFiles.length > 1 ? mdFiles.filter((m) => path.basename(m.rel).toLowerCase() !== "readme.md") : mdFiles;
    for (const mf of filtered) {
      const content = fs.readFileSync(mf.full, "utf8");
      const baseSlug = sanitizeSlug(path.basename(mf.rel, ".md"));
      const meta = parseFrontmatter(content, baseSlug);
      let slug = baseSlug;
      if (usedSlugs.has(slug)) {
        let n = 2;
        while (usedSlugs.has(`${slug}-${n}`)) n++;
        slug = `${slug}-${n}`;
      }
      usedSlugs.add(slug);

      const wrapped = /^---\r?\n/.test(content)
        ? content
        : `---\nname: ${meta.name}\ndescription: ${meta.description.replace(/\r?\n/g, " ")}\n---\n\n${content}`;
      const files = [{ relPath: "SKILL.md", content: wrapped }];
      const security = scanSkillSecurity(files);
      const targetDir = `${cleanBrain}/skills/${slug}`;
      const alreadyInstalled = fs.existsSync(resolveBrainPath(`${targetDir}/SKILL.md`));

      results.push({
        slug,
        name: meta.name,
        description: meta.description,
        version: meta.version,
        author: meta.author,
        sourceSubpath: mf.rel,
        fileCount: 1,
        totalBytes: Buffer.byteLength(wrapped, "utf8"),
        files: ["SKILL.md"],
        markdownPreview: wrapped.slice(0, 2200),
        riskLevel: security.riskLevel,
        findings: security.findings,
        alreadyInstalled,
        targetDir,
        fileContents: files,
      });
    }
  }

  return results;
}

export async function previewSkillInstall(params: {
  source?: string;
  files?: UploadedSkillFileInput[];
  brainFolder?: string;
  allowLocalPath?: boolean;
}): Promise<{ source: string; brainFolder: string; skills: DiscoveredSkillPreview[] }> {
  const brainFolder = normalizeRelPath(params.brainFolder || "main-brain") || "main-brain";
  const staged = params.files?.length
    ? await stageUploadedFilesToTempDir(params.files)
    : await fetchSourceToTempDir(String(params.source || ""), Boolean(params.allowLocalPath));

  try {
    const discovered = discoverSkillsInDir(staged.scanRoot, brainFolder, staged.canonicalSource);
    if (discovered.length === 0) {
      throw new Error("No SKILL.md or markdown playbooks found in the provided source.");
    }
    return {
      source: staged.canonicalSource,
      brainFolder,
      skills: discovered.map(({ fileContents: _omit, ...preview }) => preview),
    };
  } finally {
    fs.rmSync(staged.tmpRoot, { recursive: true, force: true });
  }
}

export async function installSkillsFromSource(params: {
  source?: string;
  files?: UploadedSkillFileInput[];
  brainFolder?: string;
  selectedSlugs?: string[];
  overwrite?: boolean;
  allowLocalPath?: boolean;
}): Promise<{
  source: string;
  brainFolder: string;
  installed: Array<{ slug: string; name: string; path: string; dirPath: string; fileCount: number; riskLevel: string }>;
  skipped: Array<{ slug: string; reason: string }>;
}> {
  const brainFolder = normalizeRelPath(params.brainFolder || "main-brain") || "main-brain";
  const staged = params.files?.length
    ? await stageUploadedFilesToTempDir(params.files)
    : await fetchSourceToTempDir(String(params.source || ""), Boolean(params.allowLocalPath));

  try {
    const discovered = discoverSkillsInDir(staged.scanRoot, brainFolder, staged.canonicalSource);
    if (discovered.length === 0) {
      throw new Error("No SKILL.md or markdown playbooks found in the provided source.");
    }

    const wanted = params.selectedSlugs?.length ? new Set(params.selectedSlugs) : null;
    const installed: Array<{
      slug: string;
      name: string;
      path: string;
      dirPath: string;
      fileCount: number;
      riskLevel: string;
    }> = [];
    const skipped: Array<{ slug: string; reason: string }> = [];

    for (const sk of discovered) {
      if (wanted && !wanted.has(sk.slug)) continue;

      const targetDirRel = `${brainFolder}/skills/${sk.slug}`;
      const targetDirFull = resolveBrainPath(targetDirRel);
      if (fs.existsSync(targetDirFull)) {
        if (!params.overwrite) {
          skipped.push({ slug: sk.slug, reason: "Already installed (enable Overwrite to replace)" });
          continue;
        }
        fs.rmSync(targetDirFull, { recursive: true, force: true });
      }

      fs.mkdirSync(targetDirFull, { recursive: true });
      for (const f of sk.fileContents) {
        const cleanRel = normalizeRelPath(f.relPath);
        const outFull = resolveBrainPath(`${targetDirRel}/${cleanRel}`);
        fs.mkdirSync(path.dirname(outFull), { recursive: true });
        fs.writeFileSync(outFull, f.content, "utf8");
      }

      // Save provenance metadata
      const meta = {
        slug: sk.slug,
        name: sk.name,
        source: staged.canonicalSource,
        sourceSubpath: sk.sourceSubpath,
        installedAt: new Date().toISOString(),
        riskLevel: sk.riskLevel,
        fileCount: sk.fileCount,
      };
      fs.writeFileSync(path.join(targetDirFull, ".pandawa-skill.json"), JSON.stringify(meta, null, 2), "utf8");

      installed.push({
        slug: sk.slug,
        name: sk.name,
        path: `${targetDirRel}/SKILL.md`,
        dirPath: targetDirRel,
        fileCount: sk.fileCount,
        riskLevel: sk.riskLevel,
      });
    }

    if (installed.length > 0) {
      reindexAllBrainFiles();
      reindexSemanticBrain().catch(() => {});
    }

    return { source: staged.canonicalSource, brainFolder, installed, skipped };
  } finally {
    fs.rmSync(staged.tmpRoot, { recursive: true, force: true });
  }
}

export function uninstallSkill(targetPathOrSlug: string): { deleted: string } {
  const raw = targetPathOrSlug.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!raw || raw.includes("..")) {
    throw new Error("Invalid skill path or slug.");
  }

  // If user passed just a slug (no slash), search across brains for skills/<slug>
  let relDir = raw;
  if (!raw.includes("/")) {
    const brainsRoot = path.resolve(BRAINS_DIR);
    let found = "";
    function searchSkillDir(dir: string, relPrefix: string, depth: number): void {
      if (found || depth > 5) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (rel.endsWith(`/skills/${raw}`)) {
            found = rel;
            return;
          }
          searchSkillDir(path.join(dir, entry.name), rel, depth + 1);
        }
      }
    }
    searchSkillDir(brainsRoot, "", 0);
    if (!found) {
      throw new Error(`Installed skill "${raw}" not found.`);
    }
    relDir = found;
  }

  // Strip trailing /SKILL.md if caller passed the file path
  if (/\/skill\.md$/i.test(relDir)) {
    relDir = relDir.replace(/\/skill\.md$/i, "");
  }

  // Strict safety guard: ONLY allow deleting a specific skill under */skills/<name>
  const norm = normalizeRelPath(relDir);
  const skillsMarkerIdx = norm.indexOf("/skills/");
  if (skillsMarkerIdx === -1) {
    throw new Error("Refused: target is not inside a brain skills/ directory.");
  }
  const afterSkills = norm.slice(skillsMarkerIdx + "/skills/".length);
  if (!afterSkills || afterSkills.includes("/")) {
    throw new Error("Refused: must target a single skill directory or file directly under skills/.");
  }

  const full = resolveBrainPath(norm);
  if (!fs.existsSync(full)) {
    throw new Error(`Skill not found: ${norm}`);
  }
  fs.rmSync(full, { recursive: true, force: true });
  reindexAllBrainFiles();
  reindexSemanticBrain().catch(() => {});
  return { deleted: norm };
}

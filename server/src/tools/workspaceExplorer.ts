import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { resolveTeamCheckpointsDir, resolveTeamWorkspaceDir } from "../config.js";
import {
  MAX_INBOUND_MEDIA_BYTES,
  guessMimeType,
  isAndroidPackageExt,
  isImageMimeOrExt,
  sanitizeMediaFilename,
} from "../channels/channelMedia.js";
import { runPythonWorker } from "./pythonWorker.js";

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  updatedAt?: string;
  children?: WorkspaceTreeNode[];
}

export function resolveExplorerRoot(teamIdParam: string): {
  scopedTeamId: string | null;
  workspaceDir: string;
  checkpointsDir: string;
} {
  const clean = String(teamIdParam || "").trim();
  const scopedTeamId = !clean || clean === "global" || clean === "__global__" ? null : clean;
  return {
    scopedTeamId,
    workspaceDir: resolveTeamWorkspaceDir(scopedTeamId),
    checkpointsDir: resolveTeamCheckpointsDir(scopedTeamId),
  };
}

export function resolveExplorerFilePath(teamIdParam: string, relPath: string): string {
  const { workspaceDir } = resolveExplorerRoot(teamIdParam);
  const cleaned = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.includes("..")) {
    throw new Error("Path traversal not allowed inside team workspace.");
  }
  const root = path.resolve(workspaceDir);
  const full = path.resolve(root, cleaned);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Path escapes team workspace.");
  }
  return full;
}

export function listWorkspaceTree(teamIdParam: string): {
  workspaceDir: string;
  tree: WorkspaceTreeNode[];
} {
  const { workspaceDir } = resolveExplorerRoot(teamIdParam);
  if (!fs.existsSync(workspaceDir)) return { workspaceDir, tree: [] };

  function walk(dir: string, relPrefix: string): WorkspaceTreeNode[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const out: WorkspaceTreeNode[] = [];
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({
          name: entry.name,
          path: rel,
          type: "folder",
          children: walk(full, rel),
        });
      } else {
        try {
          const st = fs.statSync(full);
          out.push({
            name: entry.name,
            path: rel,
            type: "file",
            size: st.size,
            updatedAt: st.mtime.toISOString(),
          });
        } catch {
          // ignore transient files
        }
      }
    }
    return out;
  }

  return { workspaceDir, tree: walk(workspaceDir, "") };
}

export function readWorkspacePreview(teamIdParam: string, relPath: string): {
  path: string;
  kind: "text" | "image" | "binary";
  size: number;
  mimeType: string;
  content?: string;
  dataUrl?: string;
} {
  const full = resolveExplorerFilePath(teamIdParam, relPath);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    throw new Error("Workspace file not found.");
  }
  const stat = fs.statSync(full);
  const mimeType = guessMimeType(full);
  if (isImageMimeOrExt(mimeType, full)) {
    if (stat.size <= 8 * 1024 * 1024) {
      const b64 = fs.readFileSync(full).toString("base64");
      return {
        path: relPath,
        kind: "image",
        size: stat.size,
        mimeType,
        dataUrl: `data:${mimeType};base64,${b64}`,
      };
    }
    return { path: relPath, kind: "binary", size: stat.size, mimeType };
  }

  const maxPreview = 200_000;
  const bytesToRead = Math.min(stat.size, maxPreview);
  const slice = Buffer.alloc(bytesToRead);
  if (bytesToRead > 0) {
    const fd = fs.openSync(full, "r");
    try {
      fs.readSync(fd, slice, 0, bytesToRead, 0);
    } finally {
      fs.closeSync(fd);
    }
  }
  if (slice.includes(0)) {
    return { path: relPath, kind: "binary", size: stat.size, mimeType };
  }
  return {
    path: relPath,
    kind: "text",
    size: stat.size,
    mimeType,
    content: slice.toString("utf8"),
  };
}

export async function readWorkspacePreviewAsync(teamIdParam: string, relPath: string): Promise<{
  path: string;
  kind: "text" | "image" | "binary";
  size: number;
  mimeType: string;
  content?: string;
  dataUrl?: string;
  isAndroidPackage?: boolean;
}> {
  const base = readWorkspacePreview(teamIdParam, relPath);
  if (base.kind === "binary" && isAndroidPackageExt(base.path)) {
    const full = resolveExplorerFilePath(teamIdParam, relPath);
    try {
      const parsed = await runPythonWorker<{ ok?: boolean; text?: string }>(
        "doc_read",
        { path: full, maxChars: 24000 },
        30_000
      );
      if (parsed.ok && parsed.text) {
        return {
          ...base,
          kind: "text",
          isAndroidPackage: true,
          content: parsed.text,
        };
      }
    } catch {
      // fall back to binary metadata preview
    }
    return { ...base, isAndroidPackage: true };
  }
  return base;
}

export interface StreamedWorkspaceUploadResult {
  path: string;
  filename: string;
  size: number;
  mimeType: string;
  sha256: string;
  isAndroidPackage: boolean;
  androidPreview?: string;
}

export async function streamWorkspaceUpload(params: {
  teamId: string;
  stream: Readable;
  filename: string;
  dir?: string;
  contentType?: string;
  maxBytes?: number;
}): Promise<StreamedWorkspaceUploadResult> {
  const maxBytes = params.maxBytes ?? MAX_INBOUND_MEDIA_BYTES;
  const maxMb = Math.round(maxBytes / (1024 * 1024));
  const cleanDirRaw = String(params.dir || "inbox")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (cleanDirRaw.includes("..")) {
    throw new Error("Path traversal not allowed in target directory.");
  }
  const cleanDir = cleanDirRaw || "inbox";
  const targetDir = resolveExplorerFilePath(params.teamId, cleanDir);
  fs.mkdirSync(targetDir, { recursive: true });

  const safeName = sanitizeMediaFilename(params.filename, params.contentType, "upload");
  const storedName = `${Date.now()}_${safeName}`;
  const finalPath = path.resolve(targetDir, storedName);
  if (!finalPath.startsWith(targetDir + path.sep)) {
    throw new Error("Invalid upload destination path.");
  }

  const tmpPath = `${finalPath}.part_${crypto.randomUUID().slice(0, 8)}`;
  const hash = crypto.createHash("sha256");
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        out.destroy();
      } catch {
        // ignore
      }
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      reject(err);
    };

    params.stream.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > maxBytes) {
        const limitErr = new Error(`Uploaded file exceeds ${maxMb} MB limit.`) as Error & { statusCode?: number };
        limitErr.statusCode = 413;
        params.stream.pause();
        fail(limitErr);
        return;
      }
      hash.update(buf);
      if (!out.write(buf)) {
        params.stream.pause();
        out.once("drain", () => {
          if (!settled) params.stream.resume();
        });
      }
    });

    params.stream.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    params.stream.on("aborted", () => fail(new Error("Upload stream aborted by client.")));
    params.stream.on("end", () => {
      if (!settled) out.end();
    });

    out.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });

  if (totalBytes <= 0) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw new Error("Uploaded file is empty (0 bytes).");
  }

  fs.renameSync(tmpPath, finalPath);
  const relPath = `${cleanDir}/${storedName}`.replace(/^\/+/, "");
  const isAndroidPkg = isAndroidPackageExt(finalPath);
  const rawMime = String(params.contentType || "").split(";")[0].trim().toLowerCase();
  const mimeType =
    !rawMime || rawMime === "application/octet-stream" || (isAndroidPkg && rawMime === "application/zip")
      ? guessMimeType(finalPath)
      : rawMime;

  let androidPreview: string | undefined;
  if (isAndroidPkg) {
    try {
      const parsed = await runPythonWorker<{ ok?: boolean; text?: string }>(
        "doc_read",
        { path: finalPath, maxChars: 8000 },
        30_000
      );
      if (parsed.ok && parsed.text) {
        androidPreview = parsed.text;
      }
    } catch {
      // non-fatal; file is still saved cleanly
    }
  }

  return {
    path: relPath,
    filename: storedName,
    size: totalBytes,
    mimeType,
    sha256: hash.digest("hex"),
    isAndroidPackage: isAndroidPkg,
    ...(androidPreview ? { androidPreview } : {}),
  };
}

function copyTreeFiltered(src: string, dst: string): number {
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) count += copyTreeFiltered(s, d);
    else {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

export function listWorkspaceCheckpoints(teamIdParam: string): Array<{
  id: string;
  createdAt: string;
}> {
  const { checkpointsDir } = resolveExplorerRoot(teamIdParam);
  fs.mkdirSync(checkpointsDir, { recursive: true });
  return fs
    .readdirSync(checkpointsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const st = fs.statSync(path.join(checkpointsDir, d.name));
      return { id: d.name, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createWorkspaceCheckpointSnapshot(teamIdParam: string, label?: string): {
  id: string;
  files: number;
} {
  const { workspaceDir, checkpointsDir } = resolveExplorerRoot(teamIdParam);
  const slug = String(label || "snap")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "snap";
  const id = `cp_${Date.now()}_${slug}`;
  const dst = path.join(checkpointsDir, id);
  const files = copyTreeFiltered(workspaceDir, dst);
  return { id, files };
}

export function rollbackWorkspaceCheckpointSnapshot(teamIdParam: string, checkpointId: string): {
  id: string;
  restoredFiles: number;
} {
  const cid = String(checkpointId || "").trim();
  if (!cid || cid.includes("..") || cid.includes("/") || cid.includes("\\")) {
    throw new Error("Invalid checkpoint ID.");
  }
  const { workspaceDir, checkpointsDir } = resolveExplorerRoot(teamIdParam);
  const src = path.join(checkpointsDir, cid);
  if (!fs.existsSync(src)) {
    throw new Error(`Checkpoint not found: ${cid}`);
  }
  const restoredFiles = copyTreeFiltered(src, workspaceDir);
  return { id: cid, restoredFiles };
}

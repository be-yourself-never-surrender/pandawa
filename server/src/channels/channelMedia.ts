import fs from "node:fs";
import path from "node:path";
import { resolveTeamWorkspaceDir } from "../config.js";
import type { LLMImageAttachment } from "../providers/llmClient.js";
import { runPythonWorker } from "../tools/pythonWorker.js";

export const MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_VISION_IMAGE_BYTES = 6 * 1024 * 1024;

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".zip": "application/zip",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".log",
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".sh",
  ".toml",
  ".ini",
]);

const RICH_DOC_EXTS = new Set([".pdf", ".docx", ".xlsx"]);

export function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] || "application/octet-stream";
}

export function isImageMimeOrExt(mimeType?: string, filePath?: string): boolean {
  const m = String(mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return true;
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif";
}

function extFromMime(mimeType?: string): string {
  const clean = String(mimeType || "").split(";")[0].trim().toLowerCase();
  for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
    if (mime === clean) return ext;
  }
  return ".bin";
}

function sanitizeFilename(rawName: string | undefined, mimeType?: string, prefix?: string): string {
  const baseRaw = path.basename(String(rawName || "").replace(/\\/g, "/")).trim();
  const cleaned = baseRaw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (cleaned && cleaned !== "." && cleaned !== "..") {
    return cleaned.slice(0, 96);
  }
  const stem = (prefix || "media").replace(/[^a-zA-Z0-9_-]/g, "") || "media";
  return `${stem}${extFromMime(mimeType)}`;
}

export interface SavedChannelMediaResult {
  relPath: string;
  fullPath: string;
  sizeBytes: number;
  mimeType: string;
  isImage: boolean;
  promptContext: string;
  visionImage?: LLMImageAttachment;
}

export async function saveInboundChannelMedia(params: {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
  teamId?: string | null;
  prefix?: string;
}): Promise<SavedChannelMediaResult> {
  if (!Buffer.isBuffer(params.buffer)) {
    throw new Error("Media payload must be a Buffer.");
  }
  if (params.buffer.byteLength > MAX_INBOUND_MEDIA_BYTES) {
    throw new Error(
      `Inbound media too large (${Math.round(params.buffer.byteLength / (1024 * 1024))} MB, max 20 MB).`
    );
  }

  const wsRoot = path.resolve(resolveTeamWorkspaceDir(params.teamId));
  const inboxDir = path.join(wsRoot, "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });

  const safeName = sanitizeFilename(params.filename, params.mimeType, params.prefix);
  const storedName = `${Date.now()}_${safeName}`;
  const fullPath = path.resolve(inboxDir, storedName);
  if (!fullPath.startsWith(inboxDir + path.sep)) {
    throw new Error("Invalid inbound media path.");
  }

  fs.writeFileSync(fullPath, params.buffer);
  const relPath = `inbox/${storedName}`;
  const mimeType = (params.mimeType || "").split(";")[0].trim() || guessMimeType(fullPath);
  const ext = path.extname(fullPath).toLowerCase();
  const isImage = isImageMimeOrExt(mimeType, fullPath);
  const sizeBytes = params.buffer.byteLength;
  const sizeLabel = sizeBytes >= 1024 ? `${Math.round(sizeBytes / 1024)} KB` : `${sizeBytes} B`;

  let visionImage: LLMImageAttachment | undefined;
  let previewNote = "";

  if (isImage && sizeBytes <= MAX_VISION_IMAGE_BYTES) {
    visionImage = {
      mimeType: mimeType.startsWith("image/") ? mimeType : "image/png",
      base64: params.buffer.toString("base64"),
      name: relPath,
    };
    previewNote = "Attached directly to Vision context.";
  } else if (TEXT_EXTS.has(ext) && sizeBytes <= 256 * 1024 && !params.buffer.includes(0)) {
    const snippet = params.buffer.toString("utf8").slice(0, 4000);
    previewNote = `Inline text preview:\n\`\`\`\n${snippet}\n\`\`\``;
  } else if (RICH_DOC_EXTS.has(ext)) {
    try {
      const parsed = await runPythonWorker<{ ok?: boolean; text?: string }>(
        "doc_read",
        { path: fullPath, maxChars: 6000 },
        20_000
      );
      if (parsed.ok && parsed.text) {
        previewNote = `Extracted document preview (full text available via \`doc_read(path="${relPath}")\`):\n\`\`\`\n${String(parsed.text).slice(0, 4000)}\n\`\`\``;
      } else {
        previewNote = `Inspect with \`doc_read(path="${relPath}")\`.`;
      }
    } catch {
      previewNote = `Inspect with \`doc_read(path="${relPath}")\`.`;
    }
  } else {
    previewNote = `Saved in team workspace; inspect via \`workspace_read\` / \`doc_read\` / \`shell_exec\`.`;
  }

  const promptContext = `[Inbound Media Attachment]\n- Saved to workspace path: \`${relPath}\` (${mimeType}, ${sizeLabel})\n- ${previewNote}`;

  return {
    relPath,
    fullPath,
    sizeBytes,
    mimeType,
    isImage,
    promptContext,
    ...(visionImage ? { visionImage } : {}),
  };
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDirectories } from "../config.js";

const KEY_FILE = path.join(DATA_DIR, ".vault.key");
const PREFIX = "enc:v1:";

let _key: Buffer | null = null;

function getMasterKey(): Buffer {
  if (_key) return _key;
  ensureDirectories();
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (hex.length === 64) {
      _key = Buffer.from(hex, "hex");
      return _key;
    }
  }
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, fresh.toString("hex"), { mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    // ignore on Windows
  }
  _key = fresh;
  return _key;
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith(PREFIX)) return plain;
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // backwards-compatible with legacy plaintext
  try {
    const rest = stored.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = rest.split(":");
    if (!ivB64 || !tagB64 || !dataB64) return "";
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return "";
  }
}

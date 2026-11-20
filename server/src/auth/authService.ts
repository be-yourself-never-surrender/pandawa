import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { DEFAULT_PASSWORD } from "../config.js";
import { getSetting, setSetting, logAudit } from "../db/database.js";

const KEY_HASH = "auth_password_hash";
const KEY_SALT = "auth_password_salt";
const KEY_JWT_SECRET = "auth_jwt_secret";
const KEY_IS_DEFAULT = "auth_using_default_password";

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function getJwtSecret(): string {
  let secret = getSetting(KEY_JWT_SECRET);
  if (!secret) {
    secret = crypto.randomBytes(48).toString("hex");
    setSetting(KEY_JWT_SECRET, secret);
  }
  return secret;
}

export function initAuth(): void {
  const existingHash = getSetting(KEY_HASH);
  if (!existingHash) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(DEFAULT_PASSWORD, salt);
    setSetting(KEY_SALT, salt);
    setSetting(KEY_HASH, hash);
    setSetting(KEY_IS_DEFAULT, "true");
    getJwtSecret();
  }
}

export function isUsingDefaultPassword(): boolean {
  return getSetting(KEY_IS_DEFAULT) === "true";
}

export function verifyPassword(password: string): boolean {
  const salt = getSetting(KEY_SALT);
  const storedHash = getSetting(KEY_HASH);
  if (!salt || !storedHash) return false;
  const candidate = hashPassword(password, salt);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function changePassword(
  currentPassword: string,
  newPassword: string
): { ok: boolean; error?: string } {
  if (!verifyPassword(currentPassword)) {
    return { ok: false, error: "Current password is incorrect." };
  }
  if (!newPassword || newPassword.length < 4) {
    return { ok: false, error: "New password must be at least 4 characters." };
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(newPassword, salt);
  setSetting(KEY_SALT, salt);
  setSetting(KEY_HASH, hash);
  setSetting(KEY_IS_DEFAULT, "false");
  // Rotate JWT secret so old sessions are invalidated if needed? Keep current session valid by returning new token
  logAudit("admin", "auth.change_password", "system", "Admin password updated");
  return { ok: true };
}

export function issueToken(role = "admin"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: role,
      iat: now,
      exp: now + 60 * 60 * 24 * 7, // 7 days
    })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getJwtSecret())
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token: string): { valid: boolean; sub?: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false };
    const [header, payload, sig] = parts;
    const expected = crypto
      .createHmac("sha256", getJwtSecret())
      .update(`${header}.${payload}`)
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false };
    }
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: string;
      exp?: number;
    };
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false };
    }
    return { valid: true, sub: decoded.sub || "admin" };
  } catch {
    return { valid: false };
  }
}

export function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  const qToken = req.query.token;
  if (typeof qToken === "string" && qToken.length > 0) {
    return qToken;
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const check = verifyToken(token);
  if (!check.valid) {
    res.status(401).json({ error: "Invalid or expired session token" });
    return;
  }
  next();
}

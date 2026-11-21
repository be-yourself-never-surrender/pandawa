import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { DATA_DIR, DEFAULT_PASSWORD } from "../config.js";
import { getSetting, setSetting, logAudit } from "../db/database.js";

const KEY_HASH = "auth_password_hash";
const KEY_SALT = "auth_password_salt";
const KEY_JWT_SECRET = "auth_jwt_secret";
const KEY_TOKEN_VERSION = "auth_token_version";
const KEY_IS_DEFAULT = "auth_using_default_password";
const INITIAL_PW_FILE = path.join(DATA_DIR, ".initial_password");

const MIN_PASSWORD_LENGTH = 8;
const TOKEN_TTL_SEC = Math.max(3600, Number(process.env.PANDAWA_TOKEN_TTL_SEC || 60 * 60 * 48)); // 48h default

// Per-IP login rate limiting & progressive lockout
interface LoginRateEntry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}
const loginAttempts = new Map<string, LoginRateEntry>();

// One-time short-lived WebSocket tickets (30s expiry, single-use)
const wsTickets = new Map<string, { role: string; tv: number; expiresAt: number }>();

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

export function getTokenVersion(): number {
  const raw = getSetting(KEY_TOKEN_VERSION);
  if (!raw) {
    setSetting(KEY_TOKEN_VERSION, "1");
    return 1;
  }
  return Math.max(1, Number(raw) || 1);
}

export function initAuth(): void {
  const existingHash = getSetting(KEY_HASH);
  if (!existingHash) {
    const initialPw = DEFAULT_PASSWORD.trim() || crypto.randomBytes(12).toString("base64url");
    const isEnvProvided = Boolean(DEFAULT_PASSWORD.trim());
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(initialPw, salt);
    setSetting(KEY_SALT, salt);
    setSetting(KEY_HASH, hash);
    setSetting(KEY_TOKEN_VERSION, "1");
    setSetting(KEY_IS_DEFAULT, isEnvProvided && initialPw === "11111111" ? "true" : "false");
    getJwtSecret();

    if (!isEnvProvided) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(INITIAL_PW_FILE, `${initialPw}\n`, { mode: 0o600 });
        if (process.platform !== "win32") fs.chmodSync(INITIAL_PW_FILE, 0o600);
      } catch {
        // ignore write failure
      }
      console.log(
        `\n[Pandawa Security] Generated unique initial admin password: ${initialPw}\n` +
          `[Pandawa Security] Also saved (0600) to ${INITIAL_PW_FILE} — change it in Settings after login.\n`
      );
    }
  } else {
    // Ensure token version exists on upgraded databases
    getTokenVersion();
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

export function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const key = (ip || "unknown").trim();
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry) return { allowed: true, retryAfterSec: 0 };

  if (entry.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (now - entry.windowStart > 60_000) {
    loginAttempts.delete(key);
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function recordLoginFailure(ip: string): { locked: boolean; retryAfterSec: number } {
  const key = (ip || "unknown").trim();
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > 15 * 60_000) {
    entry = { failures: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.failures += 1;
  if (entry.failures >= 15) {
    entry.lockedUntil = now + 15 * 60_000;
  } else if (entry.failures >= 10) {
    entry.lockedUntil = now + 5 * 60_000;
  } else if (entry.failures >= 5) {
    entry.lockedUntil = now + 60_000;
  }
  loginAttempts.set(key, entry);
  const retryAfterSec = entry.lockedUntil > now ? Math.ceil((entry.lockedUntil - now) / 1000) : 0;
  return { locked: retryAfterSec > 0, retryAfterSec };
}

export function clearLoginFailures(ip: string): void {
  loginAttempts.delete((ip || "unknown").trim());
}

export function resetAllLoginRateLimits(): void {
  loginAttempts.clear();
}

export function changePassword(
  currentPassword: string,
  newPassword: string
): { ok: boolean; error?: string } {
  if (!verifyPassword(currentPassword)) {
    return { ok: false, error: "Current password is incorrect." };
  }
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(newPassword, salt);
  setSetting(KEY_SALT, salt);
  setSetting(KEY_HASH, hash);
  setSetting(KEY_IS_DEFAULT, "false");

  // Revoke ALL prior sessions immediately by rotating BOTH JWT secret and token_version!
  const nextTv = getTokenVersion() + 1;
  setSetting(KEY_TOKEN_VERSION, String(nextTv));
  setSetting(KEY_JWT_SECRET, crypto.randomBytes(48).toString("hex"));
  wsTickets.clear();

  try {
    if (fs.existsSync(INITIAL_PW_FILE)) fs.unlinkSync(INITIAL_PW_FILE);
  } catch {
    // ignore
  }

  logAudit("admin", "auth.change_password", "system", `Admin password updated; revoked prior tokens (tv=${nextTv})`);
  return { ok: true };
}

export function issueToken(role = "admin"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: role,
      tv: getTokenVersion(),
      iat: now,
      exp: now + TOKEN_TTL_SEC,
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
    const hdr = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: string };
    if (hdr.alg !== "HS256") return { valid: false };

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
      tv?: number;
      exp?: number;
    };
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false };
    }
    if (decoded.tv !== getTokenVersion()) {
      return { valid: false };
    }
    return { valid: true, sub: decoded.sub || "admin" };
  } catch {
    return { valid: false };
  }
}

export function issueWsTicket(role = "admin"): { ticket: string; expiresInSec: number } {
  const now = Date.now();
  // Prune expired tickets
  for (const [k, v] of wsTickets.entries()) {
    if (v.expiresAt <= now) wsTickets.delete(k);
  }
  const ticket = crypto.randomBytes(24).toString("base64url");
  wsTickets.set(ticket, { role, tv: getTokenVersion(), expiresAt: now + 30_000 });
  return { ticket, expiresInSec: 30 };
}

export function consumeWsTicket(ticket: string): { valid: boolean; role?: string } {
  if (!ticket) return { valid: false };
  const rec = wsTickets.get(ticket);
  if (!rec) return { valid: false };
  wsTickets.delete(ticket); // Strict single-use!
  if (rec.expiresAt < Date.now()) return { valid: false };
  if (rec.tv !== getTokenVersion()) return { valid: false };
  return { valid: true, role: rec.role };
}

export function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
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

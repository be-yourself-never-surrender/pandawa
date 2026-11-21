import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";

// Isolate test state in a temporary directory BEFORE importing Pandawa modules
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-test-"));
process.env.PANDAWA_DATA_DIR = tmpDir;
process.env.PANDAWA_DEFAULT_PASSWORD = ""; // Force random first-boot password generation!

const { initAuth, verifyPassword, changePassword, issueToken, verifyToken, issueWsTicket, consumeWsTicket, checkLoginRateLimit, recordLoginFailure, resetAllLoginRateLimits } = await import("../../dist/server/auth/authService.js");
const { encryptSecret, decryptSecret } = await import("../../dist/server/auth/cryptoVault.js");
const { getDb, setSetting } = await import("../../dist/server/db/database.js");
const { setApprovalMode, toolRequiresApproval } = await import("../../dist/server/engine/approvalManager.js");
const { assertSafeOutboundUrl } = await import("../../dist/server/tools/netGuard.js");
const { acquireFileLock, releaseAgentFileLocks, clearSessionFileLocks } = await import("../../dist/server/tools/toolRegistry.js");
const { runProgrammaticVerifyCommands, computeVerificationVerdict } = await import("../../dist/server/engine/teamEngine.js");
const { resolveBrainPath, extractWikilinks } = await import("../../dist/server/brains/brainFs.js");
const { createApiRouter } = await import("../../dist/server/routes/api.js");
const { seedInitialData } = await import("../../dist/server/db/seed.js");

seedInitialData();

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error on Windows locks
  }
});

test("1. Auth generates strong random initial password, rejects <8 chars, revokes old tokens on password change, rejects alg:none", () => {
  initAuth();
  const pwFile = path.join(tmpDir, ".initial_password");
  assert.equal(fs.existsSync(pwFile), true, ".initial_password file should exist on clean boot");
  const initialPw = fs.readFileSync(pwFile, "utf8").trim();
  assert.ok(initialPw.length >= 12, "Random initial password should be >= 12 chars");
  assert.notEqual(initialPw, "11111111", "Must not default to weak 11111111");
  assert.equal(verifyPassword(initialPw), true);

  // Reject alg:none JWT
  const fakeHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const fakePayload = Buffer.from(JSON.stringify({ sub: "admin", tv: 1, exp: Math.floor(Date.now() / 1000) + 9999 })).toString("base64url");
  assert.equal(verifyToken(`${fakeHeader}.${fakePayload}.`).valid, false);

  // Issue valid token, then change password -> old token MUST be revoked!
  const oldToken = issueToken("admin");
  assert.equal(verifyToken(oldToken).valid, true);

  const tooShort = changePassword(initialPw, "1234");
  assert.equal(tooShort.ok, false, "Should reject 4-char password");

  const updated = changePassword(initialPw, "StrongPandawa#2026!");
  assert.equal(updated.ok, true);
  assert.equal(fs.existsSync(pwFile), false, ".initial_password should be removed after password change");
  assert.equal(verifyToken(oldToken).valid, false, "Old token MUST be revoked after password change!");

  const freshToken = issueToken("admin");
  assert.equal(verifyToken(freshToken).valid, true);
});

test("2. One-time WebSocket ticket works exactly once and rejects replay", () => {
  const { ticket } = issueWsTicket("admin");
  assert.equal(consumeWsTicket(ticket).valid, true, "First use must succeed");
  assert.equal(consumeWsTicket(ticket).valid, false, "Replay must be rejected");
});

test("3. Login rate limiter locks IP after 5 failures", () => {
  resetAllLoginRateLimits();
  const ip = "203.0.113.99";
  for (let i = 0; i < 4; i++) {
    assert.equal(checkLoginRateLimit(ip).allowed, true);
    recordLoginFailure(ip);
  }
  const fifth = recordLoginFailure(ip);
  assert.equal(fifth.locked, true);
  assert.equal(checkLoginRateLimit(ip).allowed, false);
  resetAllLoginRateLimits();
});

test("4. AES-256-GCM vault encrypts & round-trips secrets cleanly", () => {
  const raw = "tg-bot-token-super-secret-9999";
  const enc = encryptSecret(raw);
  assert.ok(enc.startsWith("enc:v1:"));
  assert.notEqual(enc, raw);
  assert.equal(decryptSecret(enc), raw);
});

test("5. Approval Gate classifies shell, sensitive (incl. HTTP/browser/MCP), all, and auto (Full Freedom)", () => {
  setApprovalMode("auto");
  assert.equal(toolRequiresApproval("shell_exec"), false);
  assert.equal(toolRequiresApproval("http_request"), false);

  setApprovalMode("approve_shell");
  assert.equal(toolRequiresApproval("shell_exec"), true);
  assert.equal(toolRequiresApproval("term_exec"), true);
  assert.equal(toolRequiresApproval("brain_read"), false);

  setApprovalMode("approve_sensitive");
  assert.equal(toolRequiresApproval("http_request"), true);
  assert.equal(toolRequiresApproval("browser_interact"), true);
  assert.equal(toolRequiresApproval("workspace_write"), true);
  assert.equal(toolRequiresApproval("mcp__srv__tool"), true);
  assert.equal(toolRequiresApproval("brain_read"), false);

  setApprovalMode("approve_all");
  assert.equal(toolRequiresApproval("brain_read"), true);
  setApprovalMode("approve_shell");
});

test("6. SSRF Guard ALWAYS blocks cloud metadata IPs while allowing localhost in default dev mode", async () => {
  setSetting("ssrf_block_private", "0");
  await assert.rejects(() => assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data/"), /Blocked SSRF/);
  await assert.rejects(() => assertSafeOutboundUrl("http://metadata.google.internal/computeMetadata/v1/"), /Blocked SSRF/);

  // Dev mode allows localhost testing
  const okLocal = await assertSafeOutboundUrl("http://127.0.0.1:4000/health");
  assert.equal(okLocal.hostname, "127.0.0.1");

  // Strict private block denies private/loopback
  setSetting("ssrf_block_private", "1");
  await assert.rejects(() => assertSafeOutboundUrl("http://127.0.0.1:4000/health"), /Blocked SSRF/);
  await assert.rejects(() => assertSafeOutboundUrl("http://10.0.0.5/internal"), /Blocked SSRF/);
  setSetting("ssrf_block_private", "0");
});

test("7. Enforced workspace file lock prevents parallel multi-agent overwrite & releases cleanly", () => {
  const sid = "ses_lock_test";
  clearSessionFileLocks(sid);

  const a = acquireFileLock(sid, "src/app.ts", "Arjuna");
  assert.equal(a.acquired, true);

  const b = acquireFileLock(sid, "src/app.ts", "Bima");
  assert.equal(b.acquired, false);
  assert.equal(b.holder, "Arjuna");

  // Same agent re-acquiring is allowed
  const aAgain = acquireFileLock(sid, "src/app.ts", "Arjuna");
  assert.equal(aAgain.acquired, true);

  // Release Arjuna's locks -> Bima can now acquire cleanly
  releaseAgentFileLocks(sid, "Arjuna");
  const bAfter = acquireFileLock(sid, "src/app.ts", "Bima");
  assert.equal(bAfter.acquired, true);
  clearSessionFileLocks(sid);
});

test("8. Programmatic Execute & Verify rejects hallucinated VERDICT: PASS when exit code != 0", async () => {
  const failing = await runProgrammaticVerifyCommands(
    [
      { title: "Pass Check", verifyCmd: 'node -e "process.exit(0)"' },
      { title: "Fail Check", verifyCmd: 'node -e "console.error(\'boom\'); process.exit(1)"' },
    ],
    { skipApproval: true }
  );
  assert.equal(failing.length, 2);
  assert.equal(failing[0].passed, true);
  assert.equal(failing[1].passed, false);
  assert.equal(failing[1].exitCode, 1);

  // Even if LLM reviewer hallucinates VERDICT: PASS, verdict MUST be false!
  assert.equal(computeVerificationVerdict(failing, "Everything looks great!\nVERDICT: PASS"), false);

  const passing = await runProgrammaticVerifyCommands(
    [{ title: "OK Check", verifyCmd: 'node -e "console.log(\'ok\')"' }],
    { skipApproval: true }
  );
  assert.equal(computeVerificationVerdict(passing, "VERDICT: PASS"), true);
  assert.equal(computeVerificationVerdict(passing, "VERDICT: NEEDS_FIX"), false);
});

test("9. Brain path traversal blocked & [[wikilinks]] extracted cleanly", () => {
  assert.throws(() => resolveBrainPath("../etc/passwd"), /Path traversal/);
  const links = extractWikilinks("See [[rules]] and [[teams/core/guide|Guide]] plus [[rules#sec]]");
  assert.deepEqual(links, ["rules", "teams/core/guide"]);
});

test("10. HTTP API enforces header-only REST auth, login 429 rate-limit, encrypted masked channels/MCP, and mandatory webhook secret", async () => {
  resetAllLoginRateLimits();
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(() => {}));

  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 5 failed logins -> 6th MUST be 429
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      assert.equal(r.status, 401);
    }
    const locked = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "StrongPandawa#2026!" }),
    });
    assert.equal(locked.status, 429, "6th login attempt must be rate-limited with 429");
    resetAllLoginRateLimits();

    // Valid login succeeds
    const okLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "StrongPandawa#2026!" }),
    });
    assert.equal(okLogin.status, 200);
    const { token } = await okLogin.json();

    // Query string ?token= MUST be rejected on REST APIs
    const qRes = await fetch(`${base}/api/auth/me?token=${encodeURIComponent(token)}`);
    assert.equal(qRes.status, 401, "REST must not accept ?token= in query string");

    // Bearer header succeeds
    const hdrRes = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(hdrRes.status, 200);

    // WS ticket endpoint issues valid single-use ticket
    const tkRes = await fetch(`${base}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(tkRes.status, 200);
    const { ticket } = await tkRes.json();
    assert.equal(consumeWsTicket(ticket).valid, true);
    assert.equal(consumeWsTicket(ticket).valid, false);

    // Channel webhook auto-generates strong secret, encrypts in DB, masks in GET, rejects anon trigger
    const chRes = await fetch(`${base}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Test Hook", type: "webhook", config: {} }),
    });
    assert.equal(chRes.status, 200);
    const { id: chId, webhookSecret } = await chRes.json();
    assert.ok(webhookSecret && webhookSecret.length >= 32, "Auto-generated webhook secret expected");

    const dbRow = getDb().prepare("SELECT config_json FROM channels WHERE id = ?").get(chId);
    assert.ok(String(dbRow.config_json).includes("enc:v1:"), "Channel secret must be encrypted in SQLite");

    const listCh = await (await fetch(`${base}/api/channels`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const foundCh = listCh.channels.find((c) => c.id === chId);
    assert.ok(foundCh.config.secret.includes("••••"), "GET /channels must mask secret");
    assert.notEqual(foundCh.config.secret, webhookSecret);

    // Anon webhook trigger without secret MUST be rejected with 403
    const whDeny = await fetch(`${base}/api/webhooks/${chId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "evil" }),
    });
    assert.equal(whDeny.status, 403);

    // MCP headers encrypted in DB & masked in GET
    const mcpRes = await fetch(`${base}/api/connectors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "Secret MCP",
        transport: "http",
        urlOrCmd: "https://example.com/mcp",
        headers: { Authorization: "Bearer super-secret-mcp-key-999" },
      }),
    });
    const { id: mcpId } = await mcpRes.json();
    const mcpDb = getDb().prepare("SELECT headers_json FROM mcp_servers WHERE id = ?").get(mcpId);
    assert.ok(String(mcpDb.headers_json).includes("enc:v1:"), "MCP headers must be encrypted in SQLite");
    const mcpList = await (await fetch(`${base}/api/connectors`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const foundMcp = mcpList.servers.find((s) => s.id === mcpId);
    assert.ok(foundMcp.headers.Authorization.includes("••••"), "GET /connectors must mask MCP headers");
  } finally {
    srv.close();
  }
});

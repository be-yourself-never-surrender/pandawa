import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootstrapCustomTeam, startMockLlmServer, startPandawaServer, waitFor } from "./helpers/e2e_harness.mjs";

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";

/**
 * Generates real ZIP-valid synthetic .apk (with binary AXML AndroidManifest.xml,
 * classes.dex, signing cert, and native lib) and .apks (split bundle containing
 * splits/base-master.apk + splits/base-arm64_v8a.apk + toc.pb) using Python stdlib.
 */
function buildAndroidFixtures(tmpDir) {
  const pyScript = `
import io, os, struct, sys, zipfile

out_dir = sys.argv[1]

def build_axml_manifest():
    # Build minimal valid Android Binary XML (RES_XML_TYPE = 0x0003) with UTF-8 string pool
    strings = [
        "manifest", "package", "com.example.bountyapp", "versionName", "2.4.1", "versionCode",
        "uses-sdk", "minSdkVersion", "targetSdkVersion",
        "uses-permission", "name", "android.permission.INTERNET", "android.permission.CAMERA",
        "application", "debuggable", "allowBackup", "usesCleartextTraffic",
        "activity", "com.example.bountyapp.DeepLinkActivity", "exported",
        "intent-filter", "action", "android.intent.action.VIEW",
        "data", "scheme", "myapp", "host", "auth", "pathPrefix", "/callback",
    ]
    idx = {s: i for i, s in enumerate(strings)}

    # Build UTF-8 string pool body
    str_data = bytearray()
    offsets = []
    for s in strings:
        offsets.append(len(str_data))
        b = s.encode("utf-8")
        str_data.append(len(s))
        str_data.append(len(b))
        str_data.extend(b)
        str_data.append(0)
    while len(str_data) % 4 != 0:
        str_data.append(0)

    strings_start = 28 + 4 * len(strings)
    pool_size = strings_start + len(str_data)
    pool_hdr = struct.pack("<HHIIIIIII", 0x0001, 28, pool_size, len(strings), 0, 1 << 8, strings_start, 0, 0)[:28]
    # Header is 28 bytes: type(H), hdr_size(H), size(I), str_cnt(I), style_cnt(I), flags(I), str_start(I), style_start(I)
    pool_hdr = struct.pack("<HHIIIIII", 0x0001, 28, pool_size, len(strings), 0, 1 << 8, strings_start, 0)
    pool_offsets = b"".join(struct.pack("<I", o) for o in offsets)
    pool_chunk = pool_hdr + pool_offsets + bytes(str_data)

    def start_elem(tag, attrs):
        # attrs: list of (name, val_type, val_data, raw_str_or_none)
        body = bytearray()
        body.extend(struct.pack("<II", 1, 0xFFFFFFFF))  # line, comment
        body.extend(struct.pack("<II", 0xFFFFFFFF, idx[tag]))  # ns, name
        body.extend(struct.pack("<HHHHHH", 20, 20, len(attrs), 0, 0, 0))
        for aname, vtype, vdata, raw_str in attrs:
            raw_i = idx[raw_str] if raw_str is not None else 0xFFFFFFFF
            body.extend(struct.pack("<IIIHBBI", 0xFFFFFFFF, idx[aname], raw_i, 8, 0, vtype, vdata))
        return struct.pack("<HHI", 0x0102, 16, 8 + len(body)) + bytes(body)

    def end_elem(tag):
        body = struct.pack("<IIII", 1, 0xFFFFFFFF, 0xFFFFFFFF, idx[tag])
        return struct.pack("<HHI", 0x0103, 16, 8 + len(body)) + body

    chunks = bytearray()
    chunks.extend(pool_chunk)
    chunks.extend(start_elem("manifest", [
        ("package", 0x03, idx["com.example.bountyapp"], "com.example.bountyapp"),
        ("versionName", 0x03, idx["2.4.1"], "2.4.1"),
        ("versionCode", 0x10, 241, None),
    ]))
    chunks.extend(start_elem("uses-sdk", [
        ("minSdkVersion", 0x10, 24, None),
        ("targetSdkVersion", 0x10, 34, None),
    ]))
    chunks.extend(end_elem("uses-sdk"))
    chunks.extend(start_elem("uses-permission", [
        ("name", 0x03, idx["android.permission.INTERNET"], "android.permission.INTERNET"),
    ]))
    chunks.extend(end_elem("uses-permission"))
    chunks.extend(start_elem("uses-permission", [
        ("name", 0x03, idx["android.permission.CAMERA"], "android.permission.CAMERA"),
    ]))
    chunks.extend(end_elem("uses-permission"))
    chunks.extend(start_elem("application", [
        ("debuggable", 0x12, 1, None),
        ("allowBackup", 0x12, 1, None),
        ("usesCleartextTraffic", 0x12, 1, None),
    ]))
    chunks.extend(start_elem("activity", [
        ("name", 0x03, idx["com.example.bountyapp.DeepLinkActivity"], "com.example.bountyapp.DeepLinkActivity"),
        ("exported", 0x12, 1, None),
    ]))
    chunks.extend(start_elem("intent-filter", []))
    chunks.extend(start_elem("action", [
        ("name", 0x03, idx["android.intent.action.VIEW"], "android.intent.action.VIEW"),
    ]))
    chunks.extend(end_elem("action"))
    chunks.extend(start_elem("data", [
        ("scheme", 0x03, idx["myapp"], "myapp"),
        ("host", 0x03, idx["auth"], "auth"),
        ("pathPrefix", 0x03, idx["/callback"], "/callback"),
    ]))
    chunks.extend(end_elem("data"))
    chunks.extend(end_elem("intent-filter"))
    chunks.extend(end_elem("activity"))
    chunks.extend(end_elem("application"))
    chunks.extend(end_elem("manifest"))

    total_size = 8 + len(chunks)
    return struct.pack("<HHI", 0x0003, 8, total_size) + bytes(chunks)

axml = build_axml_manifest()

# 1. Single APK
apk_path = os.path.join(out_dir, "sample-target.apk")
with zipfile.ZipFile(apk_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("AndroidManifest.xml", axml)
    zf.writestr("classes.dex", b"dex\\n035\\x00" + b"A" * 64)
    zf.writestr("lib/arm64-v8a/libnative_auth.so", b"\\x7fELF" + b"B" * 32)
    zf.writestr("META-INF/CERT.RSA", b"CERTDATA")
    zf.writestr("res/xml/network_security_config.xml", b"<network-security-config/>")

# 2. Split APKS bundle (base-master + arm64 flutter split + toc.pb)
base_buf = io.BytesIO()
with zipfile.ZipFile(base_buf, "w", compression=zipfile.ZIP_DEFLATED) as bzf:
    bzf.writestr("AndroidManifest.xml", axml)
    bzf.writestr("classes.dex", b"dex\\n035\\x00" + b"C" * 64)
    bzf.writestr("META-INF/CERT.RSA", b"CERTDATA")

abi_buf = io.BytesIO()
with zipfile.ZipFile(abi_buf, "w", compression=zipfile.ZIP_DEFLATED) as azf:
    azf.writestr("lib/arm64-v8a/libflutter.so", b"\\x7fELF" + b"F" * 32)
    azf.writestr("lib/arm64-v8a/libapp.so", b"\\x7fELF" + b"G" * 32)

apks_path = os.path.join(out_dir, "sample-bundle.apks")
with zipfile.ZipFile(apks_path, "w", compression=zipfile.ZIP_DEFLATED) as szf:
    szf.writestr("toc.pb", b"toc-proto")
    szf.writestr("splits/base-master.apk", base_buf.getvalue())
    szf.writestr("splits/base-arm64_v8a.apk", abi_buf.getvalue())
`;
  execFileSync(PYTHON_BIN, ["-c", pyScript, tmpDir], { stdio: "pipe" });
  return {
    apkPath: path.join(tmpDir, "sample-target.apk"),
    apksPath: path.join(tmpDir, "sample-bundle.apks"),
    apkBuf: fs.readFileSync(path.join(tmpDir, "sample-target.apk")),
    apksBuf: fs.readFileSync(path.join(tmpDir, "sample-bundle.apks")),
  };
}

function readRawBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function extractUserText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object" && p.type === "text")
      .map((p) => String(p.text || ""))
      .join("\n");
  }
  return "";
}

test("Python worker doc_read natively decodes binary AXML .apk and split .apks bundles", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-apk-py-"));
  try {
    const { apkPath, apksPath } = buildAndroidFixtures(tmpDir);
    const workerPath = path.resolve("runtime/python_worker/doc_and_browser.py");

    const runWorker = (filePath) => {
      const out = execFileSync(PYTHON_BIN, [workerPath, "doc_read"], {
        input: JSON.stringify({ path: filePath, maxChars: 24000 }),
        encoding: "utf8",
      });
      return JSON.parse(out.trim());
    };

    const apkRes = runWorker(apkPath);
    assert.equal(apkRes.ok, true, `APK parse failed: ${apkRes.error}`);
    assert.equal(apkRes.format, "apk");
    assert.equal(apkRes.metadata.manifest.package, "com.example.bountyapp");
    assert.equal(apkRes.metadata.manifest.versionName, "2.4.1");
    assert.equal(apkRes.metadata.manifest.debuggable, true);
    assert.equal(apkRes.metadata.manifest.usesCleartextTraffic, true);
    assert.ok(apkRes.text.includes("myapp://auth/callback"), "Must extract deep link from binary AXML");
    assert.ok(apkRes.text.includes("libnative_auth.so"), "Must list native .so libraries");
    assert.ok(apkRes.text.includes("META-INF/CERT.RSA"), "Must list signing cert");

    const apksRes = runWorker(apksPath);
    assert.equal(apksRes.ok, true, `APKS parse failed: ${apksRes.error}`);
    assert.equal(apksRes.format, "apks");
    assert.equal(apksRes.baseApk, "splits/base-master.apk");
    assert.equal(apksRes.splits.length, 2);
    assert.equal(apksRes.metadata.manifest.package, "com.example.bountyapp");
    assert.ok(apksRes.text.includes("splits/base-master.apk") && apksRes.text.includes("[PRIMARY BASE]"));
    assert.ok(apksRes.text.includes("splits/base-arm64_v8a.apk"));
    assert.ok(apksRes.text.includes("libflutter.so"), "Must aggregate native libs from ABI split APK");
    assert.ok(apksRes.text.includes("Flutter"), "Must detect Flutter framework across splits");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("E2E: Workspace streaming upload + preview + Telegram/WA .apk/.apks inbound + >20MB Telegram error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-apk-e2e-"));
  const { apkBuf, apksBuf } = buildAndroidFixtures(tmpDir);

  let nextUpdateId = 8000;
  const tgUpdates = [];
  const tgSent = [];
  let tgWaiter = null;
  let tgClosed = false;

  const tgServer = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const fileMatch = u.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fileMatch && req.method === "GET") {
      const rel = decodeURIComponent(fileMatch[2]);
      const buf = rel === "docs/bundle.apks" ? apksBuf : null;
      if (!buf) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(buf);
      return;
    }
    const botMatch = u.pathname.match(/^\/bot([^/]+)\/([A-Za-z0-9_]+)$/);
    if (!botMatch) {
      sendJson(res, 404, { ok: false });
      return;
    }
    const method = botMatch[2];
    const rawBuf = await readRawBuffer(req);
    if (method === "getUpdates") {
      const offset = Number(u.searchParams.get("offset") || 0);
      let ready = tgUpdates.filter((x) => x.update_id >= offset);
      if (ready.length === 0 && !tgClosed) {
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            if (tgWaiter === done) tgWaiter = null;
            resolve();
          }, 600);
          const done = () => {
            clearTimeout(t);
            resolve();
          };
          tgWaiter = done;
        });
        ready = tgUpdates.filter((x) => x.update_id >= offset);
      }
      sendJson(res, 200, { ok: true, result: ready });
      return;
    }
    if (method === "getFile") {
      const fid = String(u.searchParams.get("file_id") || "");
      if (fid === "FID_TOO_BIG") {
        sendJson(res, 400, { ok: false, error_code: 400, description: "Bad Request: file is too big" });
        return;
      }
      if (fid === "FID_APKS") {
        sendJson(res, 200, { ok: true, result: { file_id: fid, file_path: "docs/bundle.apks", file_size: apksBuf.byteLength } });
        return;
      }
      sendJson(res, 404, { ok: false, description: "File not found" });
      return;
    }
    if (method === "sendMessage") {
      const body = JSON.parse(rawBuf.toString("utf8") || "{}");
      tgSent.push({ chatId: String(body.chat_id || ""), text: String(body.text || "") });
      sendJson(res, 200, { ok: true, result: { message_id: tgSent.length } });
      return;
    }
    sendJson(res, 200, { ok: true, result: true });
  });
  await new Promise((resolve) => tgServer.listen(0, "127.0.0.1", resolve));
  const tgBase = `http://127.0.0.1:${tgServer.address().port}`;

  // Mock WhatsApp Graph API serving .apk
  const waSent = [];
  let waPort = 0;
  const waServer = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (u.pathname === "/dl/WA_APK_1") {
      res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive" });
      res.end(apkBuf);
      return;
    }
    if (u.pathname === "/v21.0/WA_APK_1") {
      sendJson(res, 200, {
        id: "WA_APK_1",
        url: `http://127.0.0.1:${waPort}/dl/WA_APK_1`,
        mime_type: "application/vnd.android.package-archive",
        file_size: apkBuf.byteLength,
      });
      return;
    }
    if (u.pathname.endsWith("/messages")) {
      const body = JSON.parse((await readRawBuffer(req)).toString("utf8") || "{}");
      waSent.push(body);
      sendJson(res, 200, { messaging_product: "whatsapp", messages: [{ id: `wamid.${waSent.length}` }] });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => waServer.listen(0, "127.0.0.1", resolve));
  waPort = waServer.address().port;
  const waBase = `http://127.0.0.1:${waPort}`;

  const seenUserPrompts = [];
  const llm = await startMockLlmServer((ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const userMsgs = msgs.filter((m) => m.role === "user");
    const lastUser = extractUserText(userMsgs[userMsgs.length - 1]?.content);
    seenUserPrompts.push(lastUser);
    return {
      content: JSON.stringify({
        action: "direct_reply",
        reason: "APK metadata received and verified",
        reply: "APK/APKS diterima dan diinspeksi: com.example.bountyapp.",
      }),
    };
  });

  const srv = await startPandawaServer({
    telegramBaseUrl: tgBase,
    whatsappBaseUrl: waBase,
  });

  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      teamName: "Mobile Audit Squad",
      teamSlug: "mobile-audit-squad",
      collaborationMode: "execute",
      agents: [
        { key: "lead", name: "MobileLead", purpose: "strategy", title: "Mobile Audit Lead", toolPacks: ["brain", "team", "workspace"] },
        { key: "worker", name: "MobileHunter", purpose: "coding", title: "APK Hunter", toolPacks: ["brain", "team", "workspace", "shell"] },
      ],
    });
    const teamId = setup.team.id;

    // 1. Streaming binary upload (.apk) via Web UI endpoint
    const upApkRes = await fetch(
      `${srv.baseUrl}/api/workspaces/${encodeURIComponent(teamId)}/upload?filename=target-release.apk&dir=inbox`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${srv.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: apkBuf,
      }
    );
    assert.equal(upApkRes.status, 200);
    const upApk = await upApkRes.json();
    assert.equal(upApk.ok, true);
    assert.equal(upApk.isAndroidPackage, true);
    assert.equal(upApk.mimeType, "application/vnd.android.package-archive");
    assert.equal(upApk.size, apkBuf.byteLength);
    assert.ok(upApk.path.startsWith("inbox/") && upApk.path.endsWith("_target-release.apk"));
    assert.ok(upApk.androidPreview.includes("com.example.bountyapp"));

    // 2. Preview uploaded .apk via Workspace Explorer returns decoded Android inspection
    const prevRes = await srv.api(
      "GET",
      `/api/workspaces/${encodeURIComponent(teamId)}/file?path=${encodeURIComponent(upApk.path)}`
    );
    assert.equal(prevRes.status, 200);
    assert.equal(prevRes.data.isAndroidPackage, true);
    assert.equal(prevRes.data.kind, "text");
    assert.ok(prevRes.data.content.includes("myapp://auth/callback"));

    // 3. Streaming binary upload (.apks)
    const upApksRes = await fetch(
      `${srv.baseUrl}/api/workspaces/${encodeURIComponent(teamId)}/upload?filename=split-app.apks&dir=inbox`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${srv.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: apksBuf,
      }
    );
    assert.equal(upApksRes.status, 200);
    const upApks = await upApksRes.json();
    assert.equal(upApks.ok, true);
    assert.equal(upApks.isAndroidPackage, true);
    assert.equal(upApks.mimeType, "application/vnd.android.apks");
    assert.ok(upApks.androidPreview.includes("splits/base-master.apk") && upApks.androidPreview.includes("[PRIMARY BASE]"));
    assert.ok(upApks.androidPreview.includes("Flutter"));

    // 4. Reject path traversal on workspace upload
    const travRes = await fetch(
      `${srv.baseUrl}/api/workspaces/${encodeURIComponent(teamId)}/upload?filename=bad.apk&dir=../escape`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${srv.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: apkBuf,
      }
    );
    assert.equal(travRes.status, 400);

    // 5. Telegram inbound .apks document -> saved + pre-inspected + delivered to agent
    const tgCh = await srv.api("POST", "/api/channels", {
      name: "tg-apk-test",
      type: "telegram",
      targetType: "team",
      targetId: teamId,
      enabled: true,
      config: { botToken: "mock-tg-token", chatId: "999001" },
    });
    assert.equal(tgCh.status, 200);

    tgUpdates.push({
      update_id: nextUpdateId++,
      message: {
        message_id: 1,
        chat: { id: 999001 },
        from: { id: 10, username: "apk_tester" },
        caption: "Tolong analisa split apks ini",
        document: {
          file_id: "FID_APKS",
          file_name: "target_splits.apks",
          mime_type: "application/octet-stream",
        },
      },
    });
    if (tgWaiter) {
      const fn = tgWaiter;
      tgWaiter = null;
      fn();
    }

    const okReply = await waitFor(
      () => tgSent.find((m) => m.chatId === "999001" && m.text.includes("com.example.bountyapp")),
      { timeoutMs: 20000, label: "Telegram APKS reply" }
    );
    assert.ok(okReply);
    assert.ok(
      seenUserPrompts.some(
        (p) =>
          p.includes("target_splits.apks") &&
          p.includes("application/vnd.android.apks") &&
          p.includes("com.example.bountyapp") &&
          p.includes("splits/base-arm64_v8a.apk")
      ),
      "Agent must receive decoded .apks inspection in prompt context"
    );

    // 6. Telegram >20 MB ("file is too big") -> explicit actionable Indonesian error reply (NOT silent drop!)
    tgUpdates.push({
      update_id: nextUpdateId++,
      message: {
        message_id: 2,
        chat: { id: 999001 },
        from: { id: 10, username: "apk_tester" },
        document: {
          file_id: "FID_TOO_BIG",
          file_name: "huge-game.apk",
          mime_type: "application/vnd.android.package-archive",
        },
      },
    });
    if (tgWaiter) {
      const fn = tgWaiter;
      tgWaiter = null;
      fn();
    }

    const bigReply = await waitFor(
      () => tgSent.find((m) => m.chatId === "999001" && m.text.includes("20 MB") && m.text.includes("Team Workspaces")),
      { timeoutMs: 15000, label: "Telegram >20MB guidance reply" }
    );
    assert.ok(bigReply, "Must warn user about Telegram 20 MB limit and point to Team Workspaces upload");

    // 7. WhatsApp Cloud inbound .apk document
    const waSecret = "wa-apk-secret";
    const waCh = await srv.api("POST", "/api/channels", {
      name: "wa-apk-test",
      type: "whatsapp_cloud",
      targetType: "team",
      targetId: teamId,
      enabled: true,
      config: {
        phoneNumberId: "100200300",
        accessToken: "mock-wa-token",
        verifyToken: "verify-123",
        appSecret: waSecret,
        allowedNumbers: "6281234567890",
      },
    });
    assert.equal(waCh.status, 200);

    const waPayload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "6281234567890", profile: { name: "APK Sender" } }],
                messages: [
                  {
                    from: "6281234567890",
                    type: "document",
                    document: {
                      id: "WA_APK_1",
                      filename: "whatsapp-target.apk",
                      mime_type: "application/vnd.android.package-archive",
                      caption: "Cek celah apk ini",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig = "sha256=" + crypto.createHmac("sha256", waSecret).update(waPayload).digest("hex");
    const hookRes = await fetch(`${srv.baseUrl}/api/webhooks/whatsapp/${encodeURIComponent(waCh.data.id)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sig,
      },
      body: waPayload,
    });
    assert.equal(hookRes.status, 200);

    const waReply = await waitFor(
      () => waSent.find((m) => m.text?.body?.includes("com.example.bountyapp")),
      { timeoutMs: 20000, label: "WhatsApp Cloud APK reply" }
    );
    assert.ok(waReply);
    assert.ok(
      seenUserPrompts.some(
        (p) =>
          p.includes("whatsapp-target.apk") &&
          p.includes("application/vnd.android.package-archive") &&
          p.includes("myapp://auth/callback")
      ),
      "Agent must receive decoded .apk inspection from WhatsApp Cloud"
    );
  } finally {
    tgClosed = true;
    if (tgWaiter) tgWaiter();
    await srv.stop();
    await llm.close();
    await new Promise((resolve) => tgServer.close(() => resolve()));
    await new Promise((resolve) => waServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

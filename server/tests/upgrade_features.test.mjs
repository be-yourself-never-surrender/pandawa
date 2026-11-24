import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { bootstrapCustomTeam, startMockLlmServer, startPandawaServer, waitFor } from "./helpers/e2e_harness.mjs";

const VALID_1X1_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

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

async function createMediaTelegramMock(fixtures) {
  let nextUpdateId = 5000;
  const updatesQueue = [];
  const sentMessages = [];
  const sentUploads = [];
  let pendingWaiter = null;
  let closed = false;

  function wakeWaiter() {
    if (pendingWaiter) {
      const fn = pendingWaiter;
      pendingWaiter = null;
      fn();
    }
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || "/", "http://127.0.0.1");

    const fileMatch = urlObj.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fileMatch && req.method === "GET") {
      const rel = decodeURIComponent(fileMatch[2]);
      const buf = fixtures.files[rel];
      if (!buf) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(buf);
      return;
    }

    const botMatch = urlObj.pathname.match(/^\/bot([^/]+)\/([A-Za-z0-9_]+)$/);
    if (!botMatch) {
      sendJson(res, 404, { ok: false, description: "Unknown Telegram route" });
      return;
    }
    const method = botMatch[2];
    const rawBuf = await readRawBuffer(req);

    if (method === "getUpdates") {
      let body = {};
      try {
        body = JSON.parse(rawBuf.toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const offset = Number(urlObj.searchParams.get("offset") ?? body.offset ?? 0);
      const pickReady = () => updatesQueue.filter((u) => u.update_id >= offset);
      let ready = pickReady();
      if (ready.length === 0 && !closed) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (pendingWaiter === done) pendingWaiter = null;
            resolve();
          }, 900);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          pendingWaiter = done;
          req.once("close", () => {
            if (pendingWaiter === done) pendingWaiter = null;
            clearTimeout(timer);
            resolve();
          });
        });
        ready = pickReady();
      }
      sendJson(res, 200, { ok: true, result: ready });
      return;
    }

    if (method === "getFile") {
      const fileId = String(urlObj.searchParams.get("file_id") || "");
      const meta = fixtures.byFileId[fileId];
      if (!meta) {
        sendJson(res, 404, { ok: false, description: "File not found" });
        return;
      }
      sendJson(res, 200, { ok: true, result: meta });
      return;
    }

    if (method === "sendPhoto" || method === "sendDocument" || method === "sendAudio" || method === "sendVoice" || method === "sendVideo") {
      sentUploads.push({
        method,
        contentType: req.headers["content-type"] || "",
        rawBuffer: rawBuf,
        rawText: rawBuf.toString("latin1"),
        timestamp: Date.now(),
      });
      sendJson(res, 200, { ok: true, result: { message_id: sentUploads.length } });
      return;
    }

    if (method === "sendMessage") {
      const body = JSON.parse(rawBuf.toString("utf8") || "{}");
      sentMessages.push({ chatId: String(body.chat_id ?? ""), text: String(body.text ?? ""), body });
      sendJson(res, 200, { ok: true, result: { message_id: sentMessages.length } });
      return;
    }

    sendJson(res, 200, { ok: true, result: true });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sentMessages,
    sentUploads,
    pushUpdate(messageFields) {
      const update = {
        update_id: nextUpdateId++,
        message: {
          message_id: nextUpdateId,
          date: Math.floor(Date.now() / 1000),
          from: { id: 777, username: "media_tester", first_name: "Media" },
          ...messageFields,
        },
      };
      updatesQueue.push(update);
      wakeWaiter();
      return update;
    },
    waitForUpload(predicate, timeoutMs = 15000) {
      return waitFor(() => sentUploads.find(predicate), { timeoutMs, label: "Telegram upload" });
    },
    waitForSentMessage(predicate, timeoutMs = 15000) {
      return waitFor(() => sentMessages.find(predicate), { timeoutMs, label: "Telegram sendMessage" });
    },
    async close() {
      closed = true;
      wakeWaiter();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function createMediaWhatsAppMock(fixtures) {
  const uploadedMedia = [];
  const sentMessages = [];
  let port = 0;

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || "/", "http://127.0.0.1");

    const dlMatch = urlObj.pathname.match(/^\/dl\/([^/]+)$/);
    if (dlMatch && req.method === "GET") {
      const item = fixtures.byMediaId[decodeURIComponent(dlMatch[1])];
      if (!item) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": item.mimeType || "application/octet-stream" });
      res.end(item.buffer);
      return;
    }

    const metaMatch = urlObj.pathname.match(/^\/v\d+\.\d+\/([^/]+)$/);
    if (metaMatch && req.method === "GET") {
      const mediaId = decodeURIComponent(metaMatch[1]);
      const item = fixtures.byMediaId[mediaId];
      if (!item) {
        sendJson(res, 404, { error: { message: "Unknown media id" } });
        return;
      }
      sendJson(res, 200, {
        id: mediaId,
        url: `http://127.0.0.1:${port}/dl/${encodeURIComponent(mediaId)}`,
        mime_type: item.mimeType,
        file_size: item.buffer.byteLength,
      });
      return;
    }

    const mediaUploadMatch = urlObj.pathname.match(/^\/v\d+\.\d+\/([^/]+)\/media$/);
    if (mediaUploadMatch && req.method === "POST") {
      const rawBuf = await readRawBuffer(req);
      const id = `wa_up_media_${uploadedMedia.length + 1}`;
      uploadedMedia.push({
        id,
        phoneNumberId: decodeURIComponent(mediaUploadMatch[1]),
        authHeader: req.headers.authorization || "",
        contentType: req.headers["content-type"] || "",
        rawText: rawBuf.toString("latin1"),
        rawBuffer: rawBuf,
      });
      sendJson(res, 200, { id });
      return;
    }

    const msgMatch = urlObj.pathname.match(/^\/v\d+\.\d+\/([^/]+)\/messages$/);
    if (msgMatch && req.method === "POST") {
      const rawBuf = await readRawBuffer(req);
      const body = JSON.parse(rawBuf.toString("utf8") || "{}");
      sentMessages.push({ phoneNumberId: decodeURIComponent(msgMatch[1]), body });
      sendJson(res, 200, {
        messaging_product: "whatsapp",
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: `wamid.up.${sentMessages.length}` }],
      });
      return;
    }

    sendJson(res, 404, { error: { message: "Unknown WA route" } });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    uploadedMedia,
    sentMessages,
    waitForUpload(predicate, timeoutMs = 15000) {
      return waitFor(() => uploadedMedia.find(predicate), { timeoutMs, label: "WA Cloud /media upload" });
    },
    waitForSentMessage(predicate, timeoutMs = 15000) {
      return waitFor(() => sentMessages.find(predicate), { timeoutMs, label: "WA Cloud /messages send" });
    },
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test("1. Unit & API: OS Sandbox builder (bwrap args), policy toggle & runtime telemetry", async () => {
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-unit-sb-"));
  const prevDataDir = process.env.PANDAWA_DATA_DIR;
  process.env.PANDAWA_DATA_DIR = unitDir;

  try {
    const q = `?sb=${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const sbMod = await import(`../../dist/server/tools/sandboxRunner.js${q}`);
    const cfgMod = await import(`../../dist/server/config.js${q}`);
    sbMod.resetSandboxProbeCache();

    const wsDir = path.resolve(cfgMod.resolveTeamWorkspaceDir("team_sb_test"));
    const brainsDir = path.resolve(cfgMod.BRAINS_DIR);
    fs.mkdirSync(brainsDir, { recursive: true });
    const args = sbMod.buildBwrapArgs("echo hello_sandbox", wsDir, "team_sb_test");

    assert.ok(args.includes("--ro-bind"), "Must mount root/brains read-only");
    assert.ok(args.includes(brainsDir), "Must explicitly bind BRAINS_DIR read-only");
    assert.ok(args.includes("--bind"), "Must bind team workspace read-write");
    assert.ok(args.includes(wsDir), "Must bind active team workspace");
    assert.ok(args.includes("--unshare-pid"), "Must isolate PID namespace");
    assert.ok(args.includes("--die-with-parent"), "Must terminate child with parent");
    assert.ok(args.includes("--chdir"), "Must chdir inside sandbox");
    assert.ok(args.includes("--tmpfs"), "Must mask /tmp and external DATA_DIR with tmpfs");
    assert.equal(args[args.length - 1], "echo hello_sandbox");
  } finally {
    if (prevDataDir === undefined) delete process.env.PANDAWA_DATA_DIR;
    else process.env.PANDAWA_DATA_DIR = prevDataDir;
    fs.rmSync(unitDir, { recursive: true, force: true });
  }

  const srv = await startPandawaServer();
  try {
    const polGet = await srv.api("GET", "/api/system/policies");
    assert.equal(polGet.status, 200, polGet.text);
    assert.equal(polGet.data.sandboxMode, "auto");
    assert.ok(polGet.data.sandboxStatus && typeof polGet.data.sandboxStatus.effectiveEngine === "string");

    const polOff = await srv.api("PUT", "/api/system/policies", { sandboxMode: "off" });
    assert.equal(polOff.status, 200, polOff.text);
    assert.equal(polOff.data.sandboxMode, "off");
    assert.equal(polOff.data.sandboxStatus.effectiveEngine, "scoped_cwd");

    const rtRes = await srv.api("GET", "/api/system/runtime");
    assert.equal(rtRes.status, 200, rtRes.text);
    assert.equal(rtRes.data.sandbox?.mode, "off");
    assert.equal(rtRes.data.sandbox?.effectiveEngine, "scoped_cwd");

    const polAuto = await srv.api("PUT", "/api/system/policies", { sandboxMode: "auto" });
    assert.equal(polAuto.status, 200);
    assert.equal(polAuto.data.sandboxMode, "auto");
  } finally {
    await srv.stop().catch(() => {});
  }
});

test("2. E2E: Team Workspace Explorer tree, text/image preview, Bearer download, traversal block & checkpoint rollback", async () => {
  const llm = await startMockLlmServer(async () => ({ content: "OK" }));
  const srv = await startPandawaServer();
  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      teamName: "Explorer Squad",
      teamSlug: "explorer-squad",
    });

    const treeInitial = await srv.api("GET", `/api/workspaces/${setup.team.id}/tree`);
    assert.equal(treeInitial.status, 200, treeInitial.text);
    const wsDir = treeInitial.data.workspaceDir;
    assert.ok(wsDir && fs.existsSync(wsDir));

    fs.mkdirSync(path.join(wsDir, "reports"), { recursive: true });
    fs.mkdirSync(path.join(wsDir, "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(wsDir, "reports", "summary.md"), "# Audit\nVULN_ID=PANDAWA_WS_101\n", "utf8");
    fs.writeFileSync(path.join(wsDir, "artifacts", "proof.png"), VALID_1X1_PNG);

    const treeRes = await srv.api("GET", `/api/workspaces/${setup.team.id}/tree`);
    assert.equal(treeRes.status, 200);
    const reportsNode = treeRes.data.tree.find((n) => n.name === "reports" && n.type === "folder");
    assert.ok(reportsNode, "Tree must contain reports folder");
    assert.ok(reportsNode.children.some((c) => c.path === "reports/summary.md" && c.type === "file"));

    const textRes = await srv.api("GET", `/api/workspaces/${setup.team.id}/file?path=${encodeURIComponent("reports/summary.md")}`);
    assert.equal(textRes.status, 200, textRes.text);
    assert.equal(textRes.data.kind, "text");
    assert.ok(textRes.data.content.includes("PANDAWA_WS_101"));

    const imgRes = await srv.api("GET", `/api/workspaces/${setup.team.id}/file?path=${encodeURIComponent("artifacts/proof.png")}`);
    assert.equal(imgRes.status, 200, imgRes.text);
    assert.equal(imgRes.data.kind, "image");
    assert.equal(imgRes.data.mimeType, "image/png");
    assert.ok(String(imgRes.data.dataUrl || "").startsWith("data:image/png;base64,"));

    const travRes = await srv.api("GET", `/api/workspaces/${setup.team.id}/file?path=${encodeURIComponent("../secret.txt")}`);
    assert.equal(travRes.status, 400);

    const dlResp = await fetch(
      `${srv.baseUrl}/api/workspaces/${setup.team.id}/download?path=${encodeURIComponent("artifacts/proof.png")}`,
      { headers: { Authorization: `Bearer ${srv.token}` } }
    );
    assert.equal(dlResp.status, 200);
    const dlBuf = Buffer.from(await dlResp.arrayBuffer());
    assert.deepEqual(dlBuf, VALID_1X1_PNG);

    const cpCreate = await srv.api("POST", `/api/workspaces/${setup.team.id}/checkpoints`, {
      label: "Before Patch",
    });
    assert.equal(cpCreate.status, 200, cpCreate.text);
    assert.ok(cpCreate.data.id && cpCreate.data.files >= 2);

    const cpList = await srv.api("GET", `/api/workspaces/${setup.team.id}/checkpoints`);
    assert.equal(cpList.status, 200);
    assert.ok(cpList.data.checkpoints.some((c) => c.id === cpCreate.data.id));

    fs.writeFileSync(path.join(wsDir, "reports", "summary.md"), "CORRUPTED_FILE", "utf8");
    assert.equal(fs.readFileSync(path.join(wsDir, "reports", "summary.md"), "utf8"), "CORRUPTED_FILE");

    const rbRes = await srv.api(
      "POST",
      `/api/workspaces/${setup.team.id}/checkpoints/${encodeURIComponent(cpCreate.data.id)}/rollback`
    );
    assert.equal(rbRes.status, 200, rbRes.text);
    assert.ok(rbRes.data.restoredFiles >= 2);
    assert.ok(fs.readFileSync(path.join(wsDir, "reports", "summary.md"), "utf8").includes("PANDAWA_WS_101"));
  } finally {
    await srv.stop().catch(() => {});
    await llm.close().catch(() => {});
  }
});

test("3. E2E: Provider Health probe-all (with WS event), unkeyed provider badge state, Live Monitor feed/session & Cost Analytics", async () => {
  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const sys = String(msgs.find((m) => m.role === "system")?.content || "");
    const lastUser = extractUserText([...msgs].reverse().find((m) => m.role === "user")?.content);
    const agentName = sys.match(/- Name: \*\*([^*]+)\*\*/)?.[1]?.trim() || "Unknown";
    const toolMsgs = msgs.filter((m) => m.role === "tool");

    if (agentName === "LeadMonitor") {
      if (lastUser.includes("EXECUTE & SMART TRIAGE MODE")) {
        return {
          content: JSON.stringify({
            action: "delegate",
            needsReview: false,
            reason: "Run collaborative check",
            tasks: [
              {
                title: "Post finding & notify lead",
                owner: "WorkerMonitor",
                instructions: "Write blackboard note and send team_message.",
              },
            ],
          }),
        };
      }
      if (toolMsgs.length === 0) {
        return {
          content: "",
          toolCalls: [{ id: "tc_read_tm", name: "team_inbox", arguments: {} }],
        };
      }
      return { content: "Monitor synthesis complete." };
    }

    if (agentName === "WorkerMonitor") {
      if (toolMsgs.length === 0) {
        return {
          content: "",
          toolCalls: [
            {
              id: "tc_bb",
              name: "blackboard_post",
              arguments: { entry_type: "finding", title: "API Audit", content: "Endpoint rate limit verified." },
            },
            {
              id: "tc_tm",
              name: "team_message",
              arguments: { to_agent: "LeadMonitor", kind: "handoff", message: "READY_FOR_SYNTHESIS" },
            },
          ],
        };
      }
      return { content: "Worker posted to blackboard and messaged LeadMonitor." };
    }

    return { content: "OK" };
  });

  const srv = await startPandawaServer();
  const ws = await srv.connectWs();

  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      defaultModel: "gpt-4.1",
      teamName: "Telemetry Squad",
      teamSlug: "telemetry-squad",
      collaborationMode: "execute",
      agents: [
        { key: "lead", name: "LeadMonitor", purpose: "strategy", title: "Lead", model: "gpt-4.1", toolPacks: ["brain", "team"] },
        { key: "worker", name: "WorkerMonitor", purpose: "coding", title: "Worker", model: "gpt-4.1", toolPacks: ["brain", "team"] },
      ],
    });

    const noKeyRes = await srv.api("POST", "/api/providers", {
      name: "Unkeyed External Provider",
      kind: "openai",
      baseUrl: "https://api.example.invalid/v1",
      apiKey: "",
      defaultModel: "gpt-4.1",
      enabled: true,
    });
    assert.equal(noKeyRes.status, 200, noKeyRes.text);
    const unkeyedProvId = noKeyRes.data.provider.id;

    const listBefore = await srv.api("GET", "/api/providers");
    assert.equal(listBefore.status, 200);
    const mockBefore = listBefore.data.providers.find((p) => p.id === setup.provider.id);
    const unkeyedBefore = listBefore.data.providers.find((p) => p.id === unkeyedProvId);
    assert.equal(mockBefore?.health?.status, "unchecked");
    assert.equal(unkeyedBefore?.health?.status, "no_key");

    const probePromise = ws.waitForEvent((e) => e.type === "providers_health_updated");
    const probeRes = await srv.api("POST", "/api/providers/probe-all");
    assert.equal(probeRes.status, 200, probeRes.text);
    await probePromise;

    const probedMock = probeRes.data.results.find((r) => r.id === setup.provider.id);
    const probedUnkeyed = probeRes.data.results.find((r) => r.id === unkeyedProvId);
    assert.equal(probedMock?.ok, true);
    assert.equal(probedMock?.health?.status, "ready");
    assert.equal(typeof probedMock?.health?.latencyMs, "number");
    assert.equal(probedUnkeyed?.ok, false);
    assert.equal(probedUnkeyed?.health?.status, "no_key");

    const listAfter = await srv.api("GET", "/api/providers");
    assert.equal(listAfter.data.providers.find((p) => p.id === setup.provider.id)?.health?.status, "ready");

    await srv.api("PUT", "/api/approvals/mode", { mode: "auto" });
    const chatRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: setup.team.id,
      prompt: "Audit rate limit and coordinate via blackboard",
    });
    assert.equal(chatRes.status, 200, chatRes.text);
    const sid = chatRes.data.sessionId;

    const feedRes = await srv.api("GET", `/api/monitor/feed?teamId=${encodeURIComponent(setup.team.id)}`);
    assert.equal(feedRes.status, 200, feedRes.text);
    const feedRow = feedRes.data.feed.find((f) => f.id === sid);
    assert.ok(feedRow, "Feed must include executed team session");
    assert.equal(feedRow.targetName, "Telemetry Squad");
    assert.ok(feedRow.teamMessageCount >= 1);
    assert.ok(feedRow.blackboardCount >= 1);

    const detailRes = await srv.api("GET", `/api/monitor/session/${encodeURIComponent(sid)}`);
    assert.equal(detailRes.status, 200, detailRes.text);
    assert.ok(Array.isArray(detailRes.data.teamMessages) && detailRes.data.teamMessages.length >= 1);
    const handoff = detailRes.data.teamMessages.find((m) => String(m.content || "").includes("READY_FOR_SYNTHESIS"));
    assert.ok(handoff, "Session detail must contain team message");
    assert.ok(Array.isArray(handoff.readBy) && handoff.readBy.includes("LeadMonitor"), "readBy must be parsed array");
    assert.ok(detailRes.data.blackboard.some((b) => String(b.title || "").includes("API Audit")));
    assert.ok(detailRes.data.usage.totalTokens > 0);
    assert.ok(detailRes.data.usage.estimatedCostUsd > 0);

    const analyticsRes = await srv.api("GET", "/api/system/analytics");
    assert.equal(analyticsRes.status, 200, analyticsRes.text);
    assert.ok(Array.isArray(analyticsRes.data.byAgent) && analyticsRes.data.byAgent.length >= 1);
    assert.ok(Array.isArray(analyticsRes.data.byModel) && analyticsRes.data.byModel.length >= 1);
    assert.ok(
      Array.isArray(analyticsRes.data.byTeam) &&
        analyticsRes.data.byTeam.some((t) => t.teamId === setup.team.id && t.estimatedCostUsd > 0),
      "Analytics must include per-team cost breakdown"
    );
    assert.ok(analyticsRes.data.totals.estimatedCostUsd > 0);
  } finally {
    ws.close();
    await srv.stop().catch(() => {});
    await llm.close().catch(() => {});
  }
});

test("4. E2E: Omnichannel Media In/Out + channel_send_file (Telegram Photo & WhatsApp Cloud Document)", async () => {
  const waScopeBytes = Buffer.from("SECRET_SCOPE_TOKEN=WA_MEDIA_DOC_8899\nTarget: api.example.test\n", "utf8");
  const tgMock = await createMediaTelegramMock({
    byFileId: { tg_photo_99: { file_path: "photos/evidence.png", file_size: VALID_1X1_PNG.byteLength } },
    files: { "photos/evidence.png": VALID_1X1_PNG },
  });
  const waMock = await createMediaWhatsAppMock({
    byMediaId: { wa_doc_123: { buffer: waScopeBytes, mimeType: "text/plain" } },
  });

  let sawVisionImage = false;
  let sawWaDocPreview = false;

  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const sys = String(msgs.find((m) => m.role === "system")?.content || "");
    const userMsgs = msgs.filter((m) => m.role === "user");
    const lastUserObj = userMsgs[userMsgs.length - 1];
    const lastUserText = extractUserText(lastUserObj?.content);
    const agentName = sys.match(/- Name: \*\*([^*]+)\*\*/)?.[1]?.trim() || "Unknown";
    const toolMsgs = msgs.filter((m) => m.role === "tool");

    for (const um of userMsgs) {
      if (Array.isArray(um.content) && um.content.some((p) => p?.type === "image_url")) {
        sawVisionImage = true;
      }
      if (extractUserText(um.content).includes("WA_MEDIA_DOC_8899")) {
        sawWaDocPreview = true;
      }
    }

    if (agentName === "MediaLead") {
      if (lastUserText.includes("EXECUTE & SMART TRIAGE MODE")) {
        if (lastUserText.includes("WA_MEDIA_DOC_8899")) {
          return {
            content: JSON.stringify({
              action: "delegate",
              needsReview: false,
              reason: "Process WhatsApp document",
              tasks: [
                {
                  title: "Create findings.md & send back",
                  owner: "MediaWorker",
                  instructions: "Write findings.md with WA_FINDING_77 and call channel_send_file.",
                },
              ],
            }),
          };
        }
        return {
          content: JSON.stringify({
            action: "delegate",
            needsReview: false,
            reason: "Analyze Telegram photo & send report",
            tasks: [
              {
                title: "Create report.txt & send back",
                owner: "MediaWorker",
                instructions: "Write report.txt with TG_REPORT_42 and call channel_send_file.",
              },
            ],
          }),
        };
      }
      return { content: "Media pipeline complete." };
    }

    if (agentName === "MediaWorker") {
      const isWa = lastUserText.includes("WA_FINDING_77") || msgs.some((m) => extractUserText(m.content).includes("WA_FINDING_77"));
      const file = isWa ? "findings.md" : "report.txt";
      const token = isWa ? "WA_FINDING_77" : "TG_REPORT_42";
      const caption = isWa ? "WA Findings" : "Audit report";

      if (toolMsgs.length === 0) {
        return {
          content: "",
          toolCalls: [{ id: `tc_write_${file}`, name: "workspace_write", arguments: { path: file, content: `Result: ${token}\n` } }],
        };
      }
      if (toolMsgs.length === 1) {
        return {
          content: "",
          toolCalls: [{ id: `tc_send_${file}`, name: "channel_send_file", arguments: { path: file, caption } }],
        };
      }
      return { content: `Sent ${file} (${token})` };
    }

    return { content: "OK" };
  });

  const srv = await startPandawaServer({
    telegramBaseUrl: tgMock.baseUrl,
    whatsappBaseUrl: waMock.baseUrl,
  });

  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      teamName: "Media Squad",
      teamSlug: "media-squad",
      collaborationMode: "execute",
      agents: [
        { key: "lead", name: "MediaLead", purpose: "strategy", title: "Media Lead", toolPacks: ["brain", "team", "workspace"] },
        { key: "worker", name: "MediaWorker", purpose: "coding", title: "Media Worker", toolPacks: ["brain", "team", "workspace"] },
      ],
    });

    await srv.api("PUT", "/api/approvals/mode", { mode: "auto" });

    // A: Telegram photo inbound -> Vision -> outbound sendDocument
    const tgChRes = await srv.api("POST", "/api/channels", {
      name: "TG Media Bot",
      type: "telegram",
      targetType: "team",
      targetId: setup.team.id,
      config: { botToken: "tg_media_tok", chatId: "555111" },
    });
    assert.equal(tgChRes.status, 200, tgChRes.text);

    tgMock.pushUpdate({
      chat: { id: 555111, type: "private" },
      photo: [{ file_id: "tg_photo_99", file_size: VALID_1X1_PNG.byteLength }],
      caption: "Analyze screenshot and send report.txt",
    });

    const tgUpload = await tgMock.waitForUpload((u) => u.method === "sendDocument" && u.rawText.includes("TG_REPORT_42"), 20000);
    assert.ok(tgUpload.rawText.includes("report.txt"));
    assert.ok(tgUpload.rawText.includes("Audit report"));
    const tgReply = await tgMock.waitForSentMessage((m) => m.chatId === "555111" && m.text.includes("Media pipeline complete."), 20000);
    assert.ok(tgReply);
    assert.equal(sawVisionImage, true, "Inbound Telegram photo must reach LLM as Vision image_url");

    const wsTreeAfterTg = await srv.api("GET", `/api/workspaces/${setup.team.id}/tree`);
    const inboxDir = wsTreeAfterTg.data.tree.find((n) => n.name === "inbox" && n.type === "folder");
    assert.ok(inboxDir && inboxDir.children.length >= 1, "Downloaded Telegram media must be saved inside team inbox/");

    // B: WhatsApp Cloud document inbound -> inline text preview -> outbound /media + /messages
    const waAppSecret = "wa_media_sec_123";
    const waChRes = await srv.api("POST", "/api/channels", {
      name: "WA Cloud Media",
      type: "whatsapp_cloud",
      targetType: "team",
      targetId: setup.team.id,
      config: {
        phoneNumberId: "99887766",
        accessToken: "wa_tok_media",
        verifyToken: "wa_verify_media",
        appSecret: waAppSecret,
        allowedNumbers: "628123456789",
      },
    });
    assert.equal(waChRes.status, 200, waChRes.text);
    const waChannelId = waChRes.data.id;

    const webhookPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "628123456789", profile: { name: "WA Tester" } }],
                messages: [
                  {
                    from: "628123456789",
                    id: "wamid.in.doc1",
                    type: "document",
                    document: {
                      id: "wa_doc_123",
                      mime_type: "text/plain",
                      filename: "scope.txt",
                      caption: "Check scope doc and attach findings.md",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig = "sha256=" + crypto.createHmac("sha256", waAppSecret).update(webhookPayload, "utf8").digest("hex");

    const whResp = await srv.rawFetch(`/api/webhooks/whatsapp/${waChannelId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
      body: webhookPayload,
    });
    assert.equal(whResp.status, 200, whResp.text);

    const waUp = await waMock.waitForUpload((u) => u.rawText.includes("WA_FINDING_77"), 20000);
    assert.ok(waUp.rawText.includes("findings.md"));
    const waDocMsg = await waMock.waitForSentMessage((m) => m.body?.type === "document" && m.body?.document?.id === waUp.id, 20000);
    assert.equal(waDocMsg.body.document.caption, "WA Findings");
    assert.equal(waDocMsg.body.document.filename, "findings.md");
    const waTextMsg = await waMock.waitForSentMessage(
      (m) => m.body?.type === "text" && String(m.body?.text?.body || "").includes("Media pipeline complete."),
      20000
    );
    assert.ok(waTextMsg);
    assert.equal(sawWaDocPreview, true, "Downloaded WhatsApp text doc preview must reach LLM");
  } finally {
    await srv.stop().catch(() => {});
    await tgMock.close().catch(() => {});
    await waMock.close().catch(() => {});
    await llm.close().catch(() => {});
  }
});

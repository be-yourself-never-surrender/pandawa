import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bootstrapCustomTeam,
  createZipBase64,
  purgeStarterEntities,
  signWhatsAppPayload,
  sleep,
  startMockLlmServer,
  startMockTelegramServer,
  startMockWhatsAppServer,
  startPandawaServer,
  waitFor,
} from "./helpers/e2e_harness.mjs";

test("E2E 1 (R1): Explicit Team Role routing, all 3 modes, 422 on empty team, main_brain isolation & cross-session locks", async () => {
  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content || "";
    const sys = msgs.find((m) => m.role === "system")?.content || "";
    const isPlan = String(lastUser).includes("ROLE INSTRUCTIONS") && String(lastUser).includes("PLAN");
    if (String(lastUser).includes("Reviewer") || String(lastUser).includes("FINAL ANSWER")) {
      return { content: `VERDICT: PASS\nVerified response authored cleanly.` };
    }
    if (isPlan) {
      return {
        content: JSON.stringify({
          planSummary: "Delegate step to builder",
          tasks: [{ agentName: "BuilderBeta", title: "Implement task", instruction: "Build solution" }],
        }),
      };
    }
    const nameMatch = String(sys).match(/# AGENT IDENTITY: ([^\n]+)/);
    return { content: `[Agent:${nameMatch?.[1] || "Agent"}] completed task.` };
  });

  const srv = await startPandawaServer();
  const ws = await srv.connectWs();

  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      collaborationMode: "execute",
      agents: [
        { key: "lead", name: "PlannerAlpha", purpose: "strategy", title: "Team Lead", toolPacks: ["brain", "team", "workspace"] },
        { key: "specialist", name: "BuilderBeta", purpose: "coding", title: "Engineer", toolPacks: ["brain", "team", "workspace"] },
        { key: "reviewer", name: "VerifierGamma", purpose: "review", title: "QA Reviewer", toolPacks: ["brain", "team", "workspace"] },
        { key: "sender", name: "HeraldComms", purpose: "general", title: "Result Sender", toolPacks: ["brain", "team", "workspace"] },
      ],
    });

    const lead = setup.agentsByKey.lead;
    const reviewer = setup.agentsByKey.reviewer;
    const sender = setup.agentsByKey.sender;

    // 1. Execute mode with distinct Lead != Reviewer != Sender
    const execRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: setup.team.id,
      prompt: "Execute clean architecture verification",
    });
    assert.equal(execRes.status, 200, execRes.text);
    assert.equal(execRes.data.result.attribution.leadAgentId, lead.id);
    assert.equal(execRes.data.result.attribution.reviewerAgentId, reviewer.id);
    assert.equal(execRes.data.result.attribution.senderAgentId, sender.id);
    assert.equal(execRes.data.result.attribution.senderAgentName, "HeraldComms");
    assert.equal(execRes.data.result.synthesis.agentId, sender.id);
    assert.equal(execRes.data.result.synthesis.agentName, "HeraldComms");

    // 2. Deliberate mode preserves explicit roles
    await srv.api("PATCH", `/api/teams/${setup.team.id}`, {
      collaboration_mode: "deliberate",
      max_rounds: 2,
    });
    const delibRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: setup.team.id,
      prompt: "Deliberate on module boundaries",
    });
    assert.equal(delibRes.status, 200, delibRes.text);
    assert.equal(delibRes.data.result.mode, "deliberate");
    assert.equal(delibRes.data.result.synthesis.agentId, sender.id);

    // 3. Sequential mode saves final assistant message & emits team_done
    await srv.api("PATCH", `/api/teams/${setup.team.id}`, {
      collaboration_mode: "sequential",
    });
    const seqRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: setup.team.id,
      prompt: "Run sequential handoff",
    });
    assert.equal(seqRes.status, 200, seqRes.text);
    assert.equal(seqRes.data.result.mode, "sequential");
    assert.equal(seqRes.data.result.synthesis.agentId, sender.id);

    const msgsRes = await srv.api("GET", `/api/sessions/${seqRes.data.sessionId}/messages`);
    const assistants = (msgsRes.data?.messages || []).filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].agent_id, sender.id);
    const doneEvent = await ws.waitForEvent(
      (e) => e.type === "team_done" && e.sessionId === seqRes.data.sessionId
    );
    assert.equal(doneEvent.attribution.senderAgentId, sender.id);

    // 4. Empty team with 0 wired members returns HTTP 422 without hijacking unrelated agents
    const emptyTeamRes = await srv.api("POST", "/api/teams", {
      name: "Unwired Empty Team",
      collaboration_mode: "execute",
    });
    assert.equal(emptyTeamRes.status, 200);
    const emptyChat = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: emptyTeamRes.data.id,
      prompt: "Should fail because no agents are wired",
    });
    assert.equal(emptyChat.status, 422);
    assert.match(emptyChat.text, /has no enabled agents wired/i);

    // 5. Shared main_brain must NOT leak peer teammates between two separate teams
    const mainBrainRes = await srv.api("POST", "/api/brains", {
      name: "Shared Main Brain",
      layer: "main",
      folderPath: "shared-main",
    });
    assert.equal(mainBrainRes.status, 200);
    const teamBRes = await srv.api("POST", "/api/teams", { name: "Beta Squad", collaboration_mode: "execute" });
    const betaAgentRes = await srv.api("POST", "/api/agents", {
      name: "BetaSolo",
      purpose: "coding",
      provider_id: setup.provider.id,
      model: "mock-gpt-4.1",
    });
    const curTopo = await srv.api("GET", "/api/topology");
    const mbNodeId = "node_shared_mb";
    const tbBNodeId = `node_tb_${teamBRes.data.id}`;
    const agBNodeId = `node_ag_${betaAgentRes.data.id}`;
    const agANodeId = `node_ag_${lead.id}`;
    const mergedNodes = [
      ...(curTopo.data.nodes || []),
      { id: mbNodeId, type: "main_brain", refId: mainBrainRes.data.id, label: "Shared Main", position: { x: 100, y: 40 }, data: { folderPath: "shared-main" } },
      { id: tbBNodeId, type: "team_brain", refId: teamBRes.data.team_brain_id, label: "Beta Squad", position: { x: 600, y: 200 }, data: { teamId: teamBRes.data.id } },
      { id: agBNodeId, type: "agent", refId: betaAgentRes.data.id, label: "BetaSolo", position: { x: 600, y: 400 }, data: { agentId: betaAgentRes.data.id } },
    ];
    const mergedEdges = [
      ...(curTopo.data.edges || []),
      { id: "edge_mb_tba", source: mbNodeId, target: setup.tbNodeId, relation: "brain_link", permission: "read" },
      { id: "edge_mb_aga", source: mbNodeId, target: agANodeId, relation: "brain_link", permission: "read" },
      { id: "edge_mb_tbb", source: mbNodeId, target: tbBNodeId, relation: "brain_link", permission: "read" },
      { id: "edge_mb_agb", source: mbNodeId, target: agBNodeId, relation: "brain_link", permission: "read" },
      { id: "edge_tbb_agb", source: tbBNodeId, target: agBNodeId, relation: "brain_link", permission: "read_write" },
    ];
    const saveMerged = await srv.api("PUT", "/api/topology", { nodes: mergedNodes, edges: mergedEdges });
    assert.equal(saveMerged.status, 200, saveMerged.text);

    const compiledA = await srv.api("GET", `/api/agents/${lead.id}/compiled?teamId=${setup.team.id}`);
    assert.equal(compiledA.status, 200);
    const peerNamesA = (compiledA.data.peers || []).map((p) => p.name);
    assert.ok(!peerNamesA.includes("BetaSolo"), `Unexpected cross-team peer leak: ${peerNamesA.join(", ")}`);
  } finally {
    ws.close();
    await srv.stop();
    await llm.close();
  }
});

test("E2E 2 (R2): Non-blocking Telegram poller, per-chat FIFO queue, commands, attribution & orphan handling", async () => {
  const tg = await startMockTelegramServer();
  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const lastUser = String([...msgs].reverse().find((m) => m.role === "user")?.content || "");
    if (lastUser.includes("SLOW_MISSION")) {
      await sleep(1400);
      return { content: "SLOW_RESULT_COMPLETE" };
    }
    if (lastUser.includes("SECOND_SAME_CHAT")) {
      return { content: "SECOND_RESULT_COMPLETE" };
    }
    return { content: `FAST_RESULT:${lastUser.slice(0, 40)}` };
  });

  const srv = await startPandawaServer({ telegramBaseUrl: tg.baseUrl });
  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      collaborationMode: "execute",
      agents: [
        { key: "lead", name: "TelLead", purpose: "strategy", title: "Lead", toolPacks: ["brain", "team"] },
        { key: "reviewer", name: "TelQA", purpose: "review", title: "QA", toolPacks: ["brain", "team"] },
        { key: "sender", name: "TelHerald", purpose: "general", title: "Sender", toolPacks: ["brain", "team"] },
      ],
    });

    const chRes = await srv.api("POST", "/api/channels", {
      name: "E2E Telegram Bot",
      type: "telegram",
      targetType: "team",
      targetId: setup.team.id,
      config: { botToken: "12345:E2E_TOKEN" },
    });
    assert.equal(chRes.status, 200, chRes.text);
    const channelId = chRes.data.id;

    await waitFor(() => tg.getUpdatesCalls.length > 0, { timeoutMs: 8000, label: "initial TG getUpdates" });

    // 1. /start reports active Team / Mode / Lead / Sender (never team_pandawa crash)
    tg.pushMessage(111, "/start");
    const startMsg = await tg.waitForSentMessage((m) => m.chatId === "111" && m.text.includes("TelLead"));
    assert.ok(startMsg.text.includes("TelHerald"));
    assert.ok(!startMsg.text.includes("team_pandawa"));

    // 2. Non-blocking check: slow prompt on chat 111 must NOT block /status on chat 111 or prompt on chat 222
    const slowUpdate = tg.pushMessage(111, "SLOW_MISSION please process");
    await sleep(180);
    tg.pushMessage(111, "SECOND_SAME_CHAT");
    tg.pushMessage(111, "/status");
    tg.pushMessage(222, "FAST_OTHER_CHAT");

    const statusMsg = await tg.waitForSentMessage(
      (m) => m.chatId === "111" && (m.text.includes("Status") || m.text.includes("Route:")),
      6000
    );
    const chat222Msg = await tg.waitForSentMessage(
      (m) => m.chatId === "222" && m.text.includes("FAST_RESULT"),
      6000
    );
    const slowReply = await tg.waitForSentMessage(
      (m) => m.chatId === "111" && m.text.includes("SLOW_RESULT_COMPLETE"),
      10000
    );
    const secondReply = await tg.waitForSentMessage(
      (m) => m.chatId === "111" && m.text.includes("SECOND_RESULT_COMPLETE"),
      10000
    );

    assert.ok(statusMsg.timestamp < slowReply.timestamp, "/status must respond before slow mission completes");
    assert.ok(chat222Msg.timestamp < slowReply.timestamp, "Chat 222 must not block behind Chat 111");
    assert.ok(slowReply.timestamp <= secondReply.timestamp, "Chat 111 messages must run FIFO in order");
    assert.ok(!slowReply.text.includes("[Team:"), "Telegram reply must NOT include noisy [Team: ...] prefix");
    assert.ok(!slowReply.text.includes("Reply by:"), "Telegram reply must NOT include noisy Reply by prefix");
    assert.ok(statusMsg.text.includes("TelHerald"), "/status must still report explicit sender attribution");

    const actRes = await srv.api("GET", "/api/channels/activity");
    assert.equal(actRes.status, 200);
    const tgAct = (actRes.data.activity || []).find(
      (a) => a.attribution && a.attribution.senderAgentName === "TelHerald"
    );
    assert.ok(tgAct, "Channel activity metadata must still retain explicit sender attribution");

    // Offset advances past processed updates
    const latestPoll = await waitFor(
      () => tg.getUpdatesCalls.find((c) => c.offset > slowUpdate.update_id),
      { timeoutMs: 8000, label: "TG offset persistence" }
    );
    assert.ok(latestPoll.offset > slowUpdate.update_id);

    // /help and /new commands
    tg.pushMessage(111, "/help");
    await tg.waitForSentMessage((m) => m.chatId === "111" && m.text.includes("/stop"));
    tg.pushMessage(111, "/new");
    await tg.waitForSentMessage((m) => m.chatId === "111" && m.text.toLowerCase().includes("fresh"));

    // Orphaned channel target produces clear guidance (not team_pandawa crash)
    await srv.api("DELETE", `/api/teams/${setup.team.id}?cascade=true`);
    tg.pushMessage(111, "Hello after team deleted");
    const orphanReply = await tg.waitForSentMessage(
      (m) => m.chatId === "111" && /route|target|removed|no active/i.test(m.text),
      8000
    );
    assert.ok(!orphanReply.text.includes("team_pandawa"));

    // Silence unused var check
    assert.ok(channelId);
  } finally {
    await srv.stop();
    await llm.close();
    await tg.close();
  }
});

test("E2E 3 (R2): WhatsApp Cloud HMAC webhook, FIFO queue & bidirectional Canvas <-> Channel sync", async () => {
  const llm = await startMockLlmServer(async () => ({ content: "WA_REPLY_OK" }));
  const wa = await startMockWhatsAppServer();
  const srv = await startPandawaServer({ whatsappBaseUrl: wa.baseUrl });

  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      collaborationMode: "execute",
    });

    const appSecret = "wa_e2e_secret_123456";
    const chRes = await srv.api("POST", "/api/channels", {
      name: "E2E WA Cloud",
      type: "whatsapp_cloud",
      targetType: "team",
      targetId: setup.team.id,
      config: {
        phoneNumberId: "100200300",
        accessToken: "EAAG_E2E_TOKEN",
        verifyToken: "verify_e2e_token",
        appSecret,
      },
    });
    assert.equal(chRes.status, 200, chRes.text);
    const channelId = chRes.data.id;

    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "100200300" },
                messages: [
                  {
                    id: "wamid.1",
                    from: "6281234567890",
                    type: "text",
                    text: { body: "Check WhatsApp team reply" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    // Bad HMAC rejected
    const badSig = await srv.rawFetch(`/api/webhooks/whatsapp/${channelId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=deadbeef" },
      body: payload,
    });
    assert.equal(badSig.status, 403);

    // Valid HMAC accepted and answered asynchronously via WhatsApp Graph API
    const goodSig = await srv.rawFetch(`/api/webhooks/whatsapp/${channelId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signWhatsAppPayload(payload, appSecret),
      },
      body: payload,
    });
    assert.equal(goodSig.status, 200);

    const waSent = await wa.waitForSentMessage((m) => m.to === "6281234567890", 10000);
    assert.ok(waSent.text.includes("WA_REPLY_OK"));
    assert.ok(!waSent.text.includes("[Team:"), "WhatsApp reply must NOT include noisy [Team: ...] prefix");
    const waActRes = await srv.api("GET", "/api/channels/activity");
    assert.equal(waActRes.status, 200);
    const waAct = (waActRes.data.activity || []).find(
      (a) => a.attribution && a.attribution.senderAgentName === "PlannerAlpha"
    );
    assert.ok(waAct, "WhatsApp channel activity metadata must retain PlannerAlpha sender attribution");

    // Bidirectional sync: wire channel node to two targets -> HTTP 400 conflict!
    const chNodeId = `node_ch_${channelId}`;
    const secondAg = setup.agents[1];
    const agNodeId = `node_ag_${secondAg.id}`;
    const conflictRes = await srv.api("PUT", "/api/topology", {
      nodes: [
        ...setup.nodes,
        { id: chNodeId, type: "channel", refId: channelId, label: "E2E WA Cloud", position: { x: 50, y: 50 }, data: {} },
      ],
      edges: [
        ...setup.edges,
        { id: "edge_ch_tb", source: chNodeId, target: setup.tbNodeId, relation: "channel_route" },
        { id: "edge_ch_ag", source: chNodeId, target: agNodeId, relation: "channel_route" },
      ],
    });
    assert.equal(conflictRes.status, 400, conflictRes.text);
    assert.match(conflictRes.text, /multiple targets/i);

    // Valid single channel edge -> PATCH channel -> Canvas reflects target change!
    const singleTopo = await srv.api("PUT", "/api/topology", {
      nodes: [
        ...setup.nodes,
        { id: chNodeId, type: "channel", refId: channelId, label: "E2E WA Cloud", position: { x: 50, y: 50 }, data: {} },
      ],
      edges: [
        ...setup.edges,
        { id: "edge_ch_tb", source: chNodeId, target: setup.tbNodeId, relation: "channel_route" },
      ],
    });
    assert.equal(singleTopo.status, 200);

    const patchRes = await srv.api("PATCH", `/api/channels/${channelId}`, {
      targetType: "agent",
      targetId: secondAg.id,
    });
    assert.equal(patchRes.status, 200);

    const topoAfterPatch = await srv.api("GET", "/api/topology");
    const syncedEdge = (topoAfterPatch.data.edges || []).find(
      (e) => (e.source === chNodeId || e.target === chNodeId) && e.relation === "channel_route"
    );
    assert.ok(syncedEdge, "Expected channel_route edge updated on canvas after PATCH /api/channels/:id");
    assert.equal(syncedEdge.source === chNodeId ? syncedEdge.target : syncedEdge.source, agNodeId);

    // Removing edge from canvas clears channel target_id cleanly
    const orphanTopo = await srv.api("PUT", "/api/topology", {
      nodes: [
        ...setup.nodes,
        { id: chNodeId, type: "channel", refId: channelId, label: "E2E WA Cloud", position: { x: 50, y: 50 }, data: {} },
      ],
      edges: setup.edges,
    });
    assert.equal(orphanTopo.status, 200);
    const channelsAfterClear = await srv.api("GET", "/api/channels");
    const updatedCh = (channelsAfterClear.data.channels || []).find((c) => c.id === channelId);
    assert.equal(updatedCh.target_id, "");
  } finally {
    await srv.stop();
    await llm.close();
    await wa.close();
  }
});

test("E2E 4 (R3): Real completion probe, fallback isolation, lossless >200 ZIP import, lossless bundle export, history window & JSON 404", async () => {
  const llm = await startMockLlmServer(async (ctx) => {
    const auth = String(ctx.headers.authorization || ctx.headers["x-api-key"] || "");
    if (ctx.isModelsProbe) {
      return { status: 200, body: { object: "list", data: [{ id: "probe-model-1" }, { id: "probe-model-2" }] } };
    }
    if (auth.includes("KEY_403_COMPLETION")) {
      return { status: 403, error: "Forbidden upstream balance/policy" };
    }
    if (auth.includes("KEY_SSE_ERROR")) {
      return {
        rawSseChunks: [`data: ${JSON.stringify({ error: { message: "Stream quota exhausted", code: "rate_limit" } })}\n\n`],
      };
    }
    if (ctx.kind === "anthropic") return { content: "ANTHROPIC_OK" };
    if (ctx.kind === "gemini") return { content: "GEMINI_OK" };
    return { content: "OPENAI_OK" };
  });

  const srv = await startPandawaServer();
  try {
    await purgeStarterEntities(srv);

    // 1. /models 200 + completion 403 MUST return ok: false
    const p403 = await srv.api("POST", "/api/providers", {
      name: "FakeGreenOpenAI",
      kind: "openai",
      baseUrl: llm.openaiBaseUrl,
      apiKey: "KEY_403_COMPLETION",
      defaultModel: "probe-model-1",
    });
    const t403 = await srv.api("POST", `/api/providers/${p403.data.provider.id}/test`);
    assert.equal(t403.status, 200);
    assert.equal(t403.data.ok, false);
    assert.equal(t403.data.error?.stage, "completion");
    assert.match(t403.data.message, /403/);
    assert.match(t403.data.message, /FakeGreenOpenAI/);

    // 2. Working OpenAI returns ok: true + discoveredModels
    const pOk = await srv.api("POST", "/api/providers", {
      name: "HealthyOpenAI",
      kind: "openai",
      baseUrl: llm.openaiBaseUrl,
      apiKey: "KEY_HEALTHY",
      defaultModel: "probe-model-1",
    });
    const tOk = await srv.api("POST", `/api/providers/${pOk.data.provider.id}/test`);
    assert.equal(tOk.status, 200);
    assert.equal(tOk.data.ok, true);
    assert.ok(Array.isArray(tOk.data.discoveredModels) && tOk.data.discoveredModels.includes("probe-model-1"));

    // Working Anthropic & Gemini test probes
    const pAnth = await srv.api("POST", "/api/providers", {
      name: "HealthyAnthropic",
      kind: "anthropic",
      baseUrl: llm.baseUrl,
      apiKey: "KEY_HEALTHY_ANTH",
      defaultModel: "claude-sonnet-4-20250514",
    });
    const tAnth = await srv.api("POST", `/api/providers/${pAnth.data.provider.id}/test`);
    assert.equal(tAnth.data.ok, true);

    const pGem = await srv.api("POST", "/api/providers", {
      name: "HealthyGemini",
      kind: "gemini",
      baseUrl: `${llm.baseUrl}/v1beta`,
      apiKey: "KEY_HEALTHY_GEM",
      defaultModel: "gemini-2.5-flash",
    });
    const tGem = await srv.api("POST", `/api/providers/${pGem.data.provider.id}/test`);
    assert.equal(tGem.data.ok, true);

    // HTTP 200 SSE JSON error is caught cleanly by testProviderConnection
    const pSseErr = await srv.api("POST", "/api/providers", {
      name: "SseErrorProv",
      kind: "openai",
      baseUrl: llm.openaiBaseUrl,
      apiKey: "KEY_SSE_ERROR",
      defaultModel: "probe-model-1",
    });
    const tSseErr = await srv.api("POST", `/api/providers/${pSseErr.data.provider.id}/test`);
    assert.equal(tSseErr.data.ok, false);
    assert.match(tSseErr.data.message, /quota exhausted/i);

    // 3. Unwired DB provider is NEVER silently hijacked; wired fallback succeeds cleanly
    const pFail1 = p403.data.provider;
    const pFail2 = pSseErr.data.provider;
    const agSolo = await srv.api("POST", "/api/agents", {
      name: "IsolatedAgent",
      purpose: "coding",
      provider_id: pFail1.id,
      model: "probe-model-1",
    });
    // Wire ONLY primary failing + secondary failing provider on canvas (do NOT wire HealthyOpenAI!)
    await srv.api("PUT", "/api/topology", {
      nodes: [
        { id: "n_ag", type: "agent", refId: agSolo.data.id, label: "IsolatedAgent", position: { x: 200, y: 200 }, data: {} },
        { id: "n_p1", type: "provider", refId: pFail1.id, label: "F1", position: { x: 100, y: 400 }, data: { providerId: pFail1.id, model: "probe-model-1" } },
        { id: "n_p2", type: "provider", refId: pFail2.id, label: "F2", position: { x: 300, y: 400 }, data: { providerId: pFail2.id, model: "probe-model-1" } },
      ],
      edges: [
        { id: "e_p1", source: "n_p1", target: "n_ag", relation: "model_binding" },
        { id: "e_p2", source: "n_p2", target: "n_ag", relation: "model_binding" },
      ],
    });
    const combinedErr = await srv.api("POST", "/api/chat/send", {
      targetType: "agent",
      targetId: agSolo.data.id,
      prompt: "Must fail honestly combining primary + fallback errors",
    });
    assert.equal(combinedErr.status, 500);
    assert.match(combinedErr.text, /Primary:.*FakeGreenOpenAI/i);
    assert.match(combinedErr.text, /Fallback:.*SseErrorProv/i);

    // Rewire fallback to HealthyOpenAI -> succeeds cleanly via fallback!
    await srv.api("PUT", "/api/topology", {
      nodes: [
        { id: "n_ag", type: "agent", refId: agSolo.data.id, label: "IsolatedAgent", position: { x: 200, y: 200 }, data: {} },
        { id: "n_p1", type: "provider", refId: pFail1.id, label: "F1", position: { x: 100, y: 400 }, data: { providerId: pFail1.id, model: "probe-model-1" } },
        { id: "n_pok", type: "provider", refId: pOk.data.provider.id, label: "OK", position: { x: 300, y: 400 }, data: { providerId: pOk.data.provider.id, model: "probe-model-1" } },
      ],
      edges: [
        { id: "e_p1", source: "n_p1", target: "n_ag", relation: "model_binding" },
        { id: "e_pok", source: "n_pok", target: "n_ag", relation: "model_binding" },
      ],
    });
    const fallbackWin = await srv.api("POST", "/api/chat/send", {
      targetType: "agent",
      targetId: agSolo.data.id,
      prompt: "Succeed via wired fallback",
    });
    assert.equal(fallbackWin.status, 200, fallbackWin.text);
    assert.equal(fallbackWin.data.result.content, "OPENAI_OK");

    // 4. ZIP import >200 files without truncation + varied extensions + binary skip reporting
    const zipEntries = [];
    for (let i = 1; i <= 245; i++) {
      zipEntries.push({
        name: `vault/doc-${String(i).padStart(3, "0")}.md`,
        content: `# Note ${i}\nBody content for note ${i}\n`,
      });
    }
    zipEntries.push(
      { name: "vault/src/script.py", content: "print('hello pandawa')\n" },
      { name: "vault/config.yaml", content: "mode: strict\n" },
      { name: "vault/settings.toml", content: "port = 7777\n" },
      { name: "vault/Dockerfile", content: "FROM node:22-alpine\n" },
      { name: "vault/bin/opaque.bin", content: Buffer.from([0x00, 0xff, 0x10, 0x00, 0xfe]) }
    );
    const zipRes = await srv.api("POST", "/api/files/upload", {
      folder: "zip-e2e",
      files: [{ name: "large-vault.zip", base64: createZipBase64(zipEntries) }],
    });
    assert.equal(zipRes.status, 200, zipRes.text);
    assert.equal(zipRes.data.count, 249, `Expected all 249 text/code files without 200 cap, got ${zipRes.data.count}`);
    assert.equal(zipRes.data.paths.length, 249);
    assert.ok(zipRes.data.skipped >= 1);
    assert.ok((zipRes.data.skippedDetails || []).some((d) => d.path.includes("opaque.bin")));

    // 5. Lossless Scoped Bundle Export/Import (>120KB file, preserves maxIterations & roles, excludes other team)
    const teamOneRes = await srv.api("POST", "/api/teams", { name: "Scoped Export Squad", collaboration_mode: "execute" });
    const teamTwoRes = await srv.api("POST", "/api/teams", { name: "Unrelated Private Squad", collaboration_mode: "execute" });
    const agExport = await srv.api("POST", "/api/agents", {
      name: "ExportHero",
      purpose: "strategy",
      provider_id: pOk.data.provider.id,
      model: "probe-model-1",
    });
    await srv.api("PATCH", `/api/agents/${agExport.data.id}`, { max_iterations: 48 });
    await srv.api("PATCH", `/api/teams/${teamOneRes.data.id}`, {
      lead_agent_id: agExport.data.id,
      reviewer_agent_id: agExport.data.id,
      sender_agent_id: agExport.data.id,
    });

    const teamsAfterCreate = (await srv.api("GET", "/api/teams")).data.teams;
    const t1 = teamsAfterCreate.find((t) => t.id === teamOneRes.data.id);
    const brainsList = (await srv.api("GET", "/api/brains")).data.brains;
    const t1Brain = brainsList.find((b) => b.id === t1.team_brain_id);
    const t2 = teamsAfterCreate.find((t) => t.id === teamTwoRes.data.id);
    const t2Brain = brainsList.find((b) => b.id === t2.team_brain_id);

    const largeContent = `# Giant Spec\n` + "LINE_0123456789_PAYLOAD\n".repeat(6200); // > 140KB
    await srv.api("POST", "/api/files/write", {
      path: `${t1Brain.folder_path}/giant-spec.md`,
      content: largeContent,
    });
    await srv.api("POST", "/api/files/write", {
      path: `${t2Brain.folder_path}/secret-team2.md`,
      content: "DO_NOT_EXPORT_TO_TEAM_1",
    });

    await srv.api("PUT", "/api/topology", {
      nodes: [
        { id: "tb1", type: "team_brain", refId: t1.team_brain_id, label: t1.name, position: { x: 100, y: 100 }, data: { teamId: t1.id, folderPath: t1Brain.folder_path } },
        { id: "ag1", type: "agent", refId: agExport.data.id, label: "ExportHero", position: { x: 100, y: 300 }, data: { agentId: agExport.data.id } },
        { id: "tb2", type: "team_brain", refId: t2.team_brain_id, label: t2.name, position: { x: 500, y: 100 }, data: { teamId: t2.id, folderPath: t2Brain.folder_path } },
      ],
      edges: [{ id: "e_t1", source: "tb1", target: "ag1", relation: "brain_link" }],
    });

    const exportRes = await srv.api("GET", `/api/bundles/export?teamId=${t1.id}&includeMainBrain=false`);
    assert.equal(exportRes.status, 200, exportRes.text);
    const exportedLarge = (exportRes.data.files || []).find((f) => f.path.endsWith("giant-spec.md"));
    assert.ok(exportedLarge, "Expected giant-spec.md in bundle");
    assert.equal(exportedLarge.content.length, largeContent.length, "Large file must NOT be truncated at 40KB or 120KB");
    assert.ok(!(exportRes.data.files || []).some((f) => f.path.includes("secret-team2.md")));
    assert.ok(!(exportRes.data.topology?.nodes || []).some((n) => n.id === "tb2"));
    assert.equal(exportRes.data.agents[0]?.maxIterations, 48);
    assert.ok(exportRes.data.team.leadAgentSlug);

    // Bundle import round-trip preserves lossless >140KB file
    const importRes = await srv.api("POST", "/api/bundles/import", {
      ...exportRes.data,
      bundleName: "Reimported Export Squad",
      team: {
        ...exportRes.data.team,
        slug: `reimported-squad-${Date.now().toString(36)}`,
        name: "Reimported Export Squad",
      },
    });
    assert.equal(importRes.status, 200, importRes.text);
    const reReadRes = await srv.api(
      "GET",
      `/api/files/read?path=${encodeURIComponent(exportRes.data.files.find((f) => f.path.endsWith("giant-spec.md")).path)}`
    );
    assert.equal(reReadRes.data.content.length, largeContent.length);

    // 6. Chronological recent-24 history + JSON 404 on unknown /api route
    llm.resetRequests();
    const histSes = await srv.api("POST", "/api/sessions", {
      title: "History Window Test",
      targetType: "agent",
      targetId: agSolo.data.id,
    });
    for (let turn = 1; turn <= 15; turn++) {
      await srv.api("POST", "/api/chat/send", {
        sessionId: histSes.data.id,
        targetType: "agent",
        targetId: agSolo.data.id,
        prompt: `TURN_MARKER_${turn}`,
      });
    }
    const lastLlmReq = llm.requests[llm.requests.length - 1];
    const seenPromptHistory = (lastLlmReq.body?.messages || []).map((m) => String(m.content || "")).join("\n");
    assert.ok(seenPromptHistory.includes("TURN_MARKER_14"), "Recent turns must be retained in prompt history window");

    const notFoundApi = await srv.api("GET", "/api/this-route-does-not-exist");
    assert.equal(notFoundApi.status, 404);
    assert.equal(typeof notFoundApi.data?.error, "string");
  } finally {
    await srv.stop();
    await llm.close();
  }
});

test("Unit/Module (R1/R2): Cross-session workspace/brain locks & session-scoped approval modes", async () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-mod-test-"));
  process.env.PANDAWA_DATA_DIR = tmpData;
  try {
    const { acquireFileLock, releaseAgentFileLocks, clearSessionFileLocks } = await import(
      "../../dist/server/tools/toolRegistry.js"
    );
    const { getApprovalMode, setApprovalMode, clearSessionApprovalState } = await import(
      "../../dist/server/engine/approvalManager.js"
    );

    // 1. Workspace lock blocks across DIFFERENT agents/sessions, allows same session + same agent
    const w1 = acquireFileLock("ses_alpha", "src/main.ts", "AgentOne", "workspace");
    assert.equal(w1.acquired, true);
    const wSame = acquireFileLock("ses_alpha", "./src/main.ts", "AgentOne", "workspace");
    assert.equal(wSame.acquired, true);
    const wSameSessDiffAgent = acquireFileLock("ses_alpha", "./src/main.ts", "AgentTwo", "workspace");
    assert.equal(wSameSessDiffAgent.acquired, false);
    assert.equal(wSameSessDiffAgent.holder, "AgentOne");
    const wConflict = acquireFileLock("ses_beta", "./src/main.ts", "AgentThree", "workspace");
    assert.equal(wConflict.acquired, false);
    assert.match(wConflict.holder || "", /ses_alpha/);

    // 2. Brain scope lock blocks across different sessions (distinct from workspace scope of same path)
    const b1 = acquireFileLock("ses_alpha", "teams/alpha/notes.md", "AgentOne", "brain");
    assert.equal(b1.acquired, true);
    const bConflict = acquireFileLock("ses_beta", "/teams/alpha/notes.md", "AgentTwo", "brain");
    assert.equal(bConflict.acquired, false);
    assert.match(bConflict.holder || "", /ses_alpha/);

    clearSessionFileLocks("ses_alpha");
    const wAfterClear = acquireFileLock("ses_beta", "src/main.ts", "AgentThree", "workspace");
    assert.equal(wAfterClear.acquired, true);
    releaseAgentFileLocks("ses_beta", "AgentThree");
    const wAfterRel = acquireFileLock("ses_gamma", "src/main.ts", "AgentFour", "workspace");
    assert.equal(wAfterRel.acquired, true);
    clearSessionFileLocks("ses_gamma");

    // 3. Session-scoped approval mode stays isolated per session without overwriting global mode
    setApprovalMode("approve_shell");
    setApprovalMode("auto", "ses_tg_chat1");
    assert.equal(getApprovalMode("ses_tg_chat1"), "auto");
    assert.equal(getApprovalMode("ses_tg_chat2"), "approve_shell");
    assert.equal(getApprovalMode(), "approve_shell");
    clearSessionApprovalState("ses_tg_chat1");
  } finally {
    try {
      const { closeDb } = await import("../../dist/server/db/database.js");
      if (typeof closeDb === "function") closeDb();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpData, { recursive: true, force: true });
    } catch {
      // Windows holds SQLite mmap/WAL handles until worker exit if closeDb is absent
    }
  }
});

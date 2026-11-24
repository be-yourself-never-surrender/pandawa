import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bootstrapCustomTeam,
  startMockLlmServer,
  startMockTelegramServer,
  startPandawaServer,
  waitFor,
  sleep,
} from "./helpers/e2e_harness.mjs";

test("1. Unit: Clean channel reply formatting, per-team workspace isolation, scoped cwd & file locks", async () => {
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "pandawa-unit-iso-"));
  const prevDataDir = process.env.PANDAWA_DATA_DIR;
  process.env.PANDAWA_DATA_DIR = unitDir;

  try {
    const q = `?u=${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const configMod = await import(`../../dist/server/config.js${q}`);
    const toolMod = await import(`../../dist/server/tools/toolRegistry.js${q}`);
    const chanMod = await import(`../../dist/server/channels/channelManager.js${q}`);

    const cleanTeamReply = chanMod.formatChannelTeamReply(
      {
        teamId: "team_1",
        teamName: "Core Engineering Team",
        leadAgentId: "a1",
        leadAgentName: "Lead Commander",
        reviewerAgentId: "a2",
        reviewerAgentName: "QA Sentinel",
        senderAgentId: "a1",
        senderAgentName: "Lead Commander",
        senderModel: "gpt-4.1",
        mode: "execute",
      },
      "Halo bro, siap gas!"
    );
    assert.equal(cleanTeamReply, "Halo bro, siap gas!");
    assert.ok(!cleanTeamReply.includes("[Team:"));
    assert.ok(!cleanTeamReply.includes("Reply by:"));

    assert.equal(
      chanMod.formatChannelTeamReply(
        {
          teamId: "team_1",
          teamName: "X",
          leadAgentId: "a1",
          leadAgentName: "Lead",
          reviewerAgentId: "a1",
          reviewerAgentName: "Lead",
          senderAgentId: "a1",
          senderAgentName: "Lead",
          senderModel: "m",
          mode: "execute",
        },
        "   "
      ),
      "(Empty response)"
    );

    const cleanAgentReply = chanMod.formatChannelAgentReply("SoloAgent", "gpt-5", "Mantap bro");
    assert.equal(cleanAgentReply, "Mantap bro");
    assert.ok(!cleanAgentReply.includes("[Agent:"));

    const wsAlpha = configMod.resolveTeamWorkspaceDir("team_alpha");
    const wsBeta = configMod.resolveTeamWorkspaceDir("team_beta");
    assert.notEqual(wsAlpha, wsBeta);
    assert.ok(fs.existsSync(wsAlpha));
    assert.ok(fs.existsSync(wsBeta));
    assert.ok(wsAlpha.startsWith(path.resolve(configMod.WORKSPACES_ROOT_DIR)));
    assert.ok(wsBeta.startsWith(path.resolve(configMod.WORKSPACES_ROOT_DIR)));

    assert.throws(() => configMod.resolveScopedCwd("../team_beta", "team_alpha"), /escapes team workspace/i);
    assert.throws(() => configMod.resolveScopedCwd(wsBeta, "team_alpha"), /another team's workspace/i);
    assert.equal(configMod.resolveScopedCwd(wsAlpha, "team_alpha"), path.resolve(wsAlpha));

    toolMod.clearSessionFileLocks("ses_u1");
    toolMod.clearSessionFileLocks("ses_u2");
    const lockAlphaA = toolMod.acquireFileLock("ses_u1", "src/app.ts", "AgentA1", "workspace", "team_alpha");
    assert.equal(lockAlphaA.acquired, true);
    const lockBeta = toolMod.acquireFileLock("ses_u2", "src/app.ts", "AgentB1", "workspace", "team_beta");
    assert.equal(lockBeta.acquired, true, "Different teams must never collide on identical filenames");
    const lockAlphaConflict = toolMod.acquireFileLock("ses_u1", "src/app.ts", "AgentA2", "workspace", "team_alpha");
    assert.equal(lockAlphaConflict.acquired, false, "Same team second agent must still respect file lock");
    toolMod.clearSessionFileLocks("ses_u1");
    toolMod.clearSessionFileLocks("ses_u2");
  } finally {
    if (prevDataDir === undefined) delete process.env.PANDAWA_DATA_DIR;
    else process.env.PANDAWA_DATA_DIR = prevDataDir;
    fs.rmSync(unitDir, { recursive: true, force: true });
  }
});

test("2. E2E: Concurrent teams stay strictly isolated in separate workspaces on identical filenames", async () => {
  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const sys = String(msgs.find((m) => m.role === "system")?.content || "");
    const lastUser = String([...msgs].reverse().find((m) => m.role === "user")?.content || "");
    const agentName = sys.match(/- Name: \*\*([^*]+)\*\*/)?.[1]?.trim() || "Unknown";
    const toolMsgs = msgs.filter((m) => m.role === "tool");

    if (agentName === "AlphaLead") {
      if (lastUser.includes("EXECUTE & SMART TRIAGE MODE")) {
        return {
          content: JSON.stringify({
            action: "delegate",
            needsReview: true,
            reason: "Write Alpha report",
            tasks: [
              {
                title: "Create Alpha report.txt",
                owner: "AlphaBuilder",
                files: ["report.txt"],
                verifyCmd:
                  "node -e \"const fs=require('fs');const d=fs.readFileSync('report.txt','utf8');if(!d.includes('ALPHA_ONLY_TOKEN')||d.includes('BETA_ONLY_TOKEN'))process.exit(1);console.log('ALPHA_OK');\"",
                instructions: "Write report.txt and check cwd.",
              },
            ],
          }),
        };
      }
      return { content: "Alpha mission verified cleanly." };
    }

    if (agentName === "BetaLead") {
      if (lastUser.includes("EXECUTE & SMART TRIAGE MODE")) {
        return {
          content: JSON.stringify({
            action: "delegate",
            needsReview: true,
            reason: "Write Beta report",
            tasks: [
              {
                title: "Create Beta report.txt",
                owner: "BetaBuilder",
                files: ["report.txt"],
                verifyCmd:
                  "node -e \"const fs=require('fs');const d=fs.readFileSync('report.txt','utf8');if(!d.includes('BETA_ONLY_TOKEN')||d.includes('ALPHA_ONLY_TOKEN'))process.exit(1);console.log('BETA_OK');\"",
                instructions: "Write report.txt and check cwd.",
              },
            ],
          }),
        };
      }
      return { content: "Beta mission verified cleanly." };
    }

    if (agentName === "AlphaBuilder" || agentName === "BetaBuilder") {
      const token = agentName === "AlphaBuilder" ? "ALPHA_ONLY_TOKEN" : "BETA_ONLY_TOKEN";
      if (toolMsgs.length === 0) {
        if (agentName === "BetaBuilder") await sleep(60);
        return {
          content: "",
          toolCalls: [
            { id: `tc_w_${agentName}`, name: "workspace_write", arguments: { path: "report.txt", content: token } },
            {
              id: `tc_s_${agentName}`,
              name: "shell_exec",
              arguments: { command: 'node -e "console.log(process.cwd())"' },
            },
          ],
        };
      }
      return { content: `${agentName} wrote report.txt (${token}) | cwd output: ${toolMsgs.map((m) => m.content).join(" ; ")}` };
    }

    if (agentName === "AlphaQA" || agentName === "BetaQA") {
      return { content: "VERDICT: PASS\nVerified isolated workspace output." };
    }

    return { content: "OK" };
  });

  const srv = await startPandawaServer();
  try {
    const teamA = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      teamName: "Team Alpha",
      teamSlug: "team-alpha",
      collaborationMode: "execute",
      wireTopology: false,
      agents: [
        { key: "lead", name: "AlphaLead", purpose: "strategy", title: "Alpha Lead", toolPacks: ["brain", "team", "workspace"] },
        { key: "builder", name: "AlphaBuilder", purpose: "coding", title: "Alpha Builder", toolPacks: ["brain", "team", "workspace", "shell"] },
        { key: "reviewer", name: "AlphaQA", purpose: "review", title: "Alpha QA", toolPacks: ["brain", "team", "workspace"] },
      ],
    });

    const teamB = await bootstrapCustomTeam(srv, {
      purgeStarter: false,
      llmBaseUrl: llm.openaiBaseUrl,
      teamName: "Team Beta",
      teamSlug: "team-beta",
      collaborationMode: "execute",
      wireTopology: false,
      agents: [
        { key: "lead", name: "BetaLead", purpose: "strategy", title: "Beta Lead", toolPacks: ["brain", "team", "workspace"] },
        { key: "builder", name: "BetaBuilder", purpose: "coding", title: "Beta Builder", toolPacks: ["brain", "team", "workspace", "shell"] },
        { key: "reviewer", name: "BetaQA", purpose: "review", title: "Beta QA", toolPacks: ["brain", "team", "workspace"] },
      ],
    });

    const topoRes = await srv.api("PUT", "/api/topology", {
      nodes: [...teamA.nodes, ...teamB.nodes],
      edges: [...teamA.edges, ...teamB.edges],
    });
    assert.equal(topoRes.status, 200, topoRes.text);

    const teamsRes = await srv.api("GET", "/api/teams");
    assert.equal(teamsRes.status, 200);
    const listedA = (teamsRes.data?.teams || []).find((t) => t.id === teamA.team.id);
    const listedB = (teamsRes.data?.teams || []).find((t) => t.id === teamB.team.id);
    assert.ok(listedA?.workspaceDir && listedB?.workspaceDir);
    assert.notEqual(listedA.workspaceDir, listedB.workspaceDir);

    const modeRes = await srv.api("PUT", "/api/approvals/mode", { mode: "auto" });
    assert.equal(modeRes.status, 200);

    const [resA, resB] = await Promise.all([
      srv.api("POST", "/api/chat/send", {
        targetType: "team",
        targetId: teamA.team.id,
        prompt: "Build Alpha report.txt in isolated workspace",
      }),
      srv.api("POST", "/api/chat/send", {
        targetType: "team",
        targetId: teamB.team.id,
        prompt: "Build Beta report.txt in isolated workspace",
      }),
    ]);

    assert.equal(resA.status, 200, resA.text);
    assert.equal(resB.status, 200, resB.text);
    assert.equal(resA.data.result.verified, true);
    assert.equal(resB.data.result.verified, true);
    assert.equal(resA.data.result.verificationChecks?.[0]?.passed, true);
    assert.equal(resB.data.result.verificationChecks?.[0]?.passed, true);

    const dirA = resA.data.result.interactions?.workspaceDir;
    const dirB = resB.data.result.interactions?.workspaceDir;
    assert.ok(dirA && dirB && dirA !== dirB);
    assert.equal(fs.readFileSync(path.join(dirA, "report.txt"), "utf8"), "ALPHA_ONLY_TOKEN");
    assert.equal(fs.readFileSync(path.join(dirB, "report.txt"), "utf8"), "BETA_ONLY_TOKEN");
  } finally {
    await srv.stop().catch(() => {});
    await llm.close().catch(() => {});
  }
});

test("3. E2E: Genuine inter-agent interaction (consult_teammate, team_message, blackboard) & cross-team peer block", async () => {
  let backendPublishedContract = false;
  const consultedAgents = [];

  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const sys = String(msgs.find((m) => m.role === "system")?.content || "");
    const lastUser = String([...msgs].reverse().find((m) => m.role === "user")?.content || "");
    const agentName = sys.match(/- Name: \*\*([^*]+)\*\*/)?.[1]?.trim() || "Unknown";
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    const isConsultTurn = msgs.some((m) => String(m.content || "").includes("is consulting you mid-execution"));

    consultedAgents.push({ agentName, isConsultTurn });

    if (agentName === "Commander") {
      if (lastUser.includes("EXECUTE & SMART TRIAGE MODE")) {
        return {
          content: JSON.stringify({
            action: "delegate",
            needsReview: true,
            reason: "Backend & Frontend collaborate via contract.json and client.js",
            tasks: [
              {
                title: "Create orders API contract",
                owner: "BackendDev",
                files: ["contract.json"],
                verifyCmd:
                  "node -e \"const c=JSON.parse(require('fs').readFileSync('contract.json','utf8'));if(c.token!=='REAL_TOKEN_99')process.exit(1);\"",
                instructions: "Write contract.json, post to blackboard, notify FrontendDev via team_message.",
              },
              {
                title: "Create client integration",
                owner: "FrontendDev",
                files: ["client.js"],
                verifyCmd:
                  "node -e \"const s=require('fs').readFileSync('client.js','utf8');if(!s.includes('REAL_TOKEN_99'))process.exit(1);\"",
                instructions: "Consult BackendDev to inspect contract.json, read inbox, and generate client.js.",
              },
            ],
          }),
        };
      }
      return { content: "BackendDev and FrontendDev synced via real workspace files, consult_teammate, and QA." };
    }

    if (agentName === "BackendDev") {
      if (isConsultTurn) {
        if (toolMsgs.length === 0) {
          return {
            content: "",
            toolCalls: [{ id: "tc_consult_read", name: "workspace_read", arguments: { path: "contract.json" } }],
          };
        }
        const parsed = JSON.parse(String(toolMsgs[0].content || "{}"));
        return { content: `VERIFIED_FROM_WORKSPACE_FILE:${parsed.token}:${parsed.endpoint}` };
      }

      if (toolMsgs.length === 0) {
        return {
          content: "",
          toolCalls: [
            {
              id: "tc_be_write",
              name: "workspace_write",
              arguments: {
                path: "contract.json",
                content: JSON.stringify({ endpoint: "/api/v2/orders", token: "REAL_TOKEN_99" }, null, 2),
              },
            },
            {
              id: "tc_be_bb",
              name: "blackboard_post",
              arguments: {
                entry_type: "artifact",
                title: "Orders Contract Ready",
                content: "Written contract.json with /api/v2/orders",
              },
            },
            {
              id: "tc_be_msg",
              name: "team_message",
              arguments: {
                to_agent: "FrontendDev",
                kind: "handoff",
                message: "HANDOFF_CONTRACT_READY: contract.json ready for /api/v2/orders",
              },
            },
          ],
        };
      }
      backendPublishedContract = true;
      return { content: "BackendDev wrote contract.json and messaged FrontendDev." };
    }

    if (agentName === "FrontendDev") {
      if (toolMsgs.length === 0) {
        await waitFor(() => backendPublishedContract, { timeoutMs: 8000, label: "BackendDev contract publish" });
        return {
          content: "",
          toolCalls: [
            {
              id: "tc_fe_consult_ok",
              name: "consult_teammate",
              arguments: {
                teammate_name: "BackendDev",
                question: "Inspect contract.json in our team workspace and confirm exact token and endpoint.",
              },
            },
            {
              id: "tc_fe_consult_blocked",
              name: "consult_teammate",
              arguments: {
                teammate_name: "OutsiderDev",
                question: "Cross-team leak test",
              },
            },
            { id: "tc_fe_inbox", name: "team_inbox", arguments: { limit: 10 } },
          ],
        };
      }

      if (!toolMsgs.some((m) => String(m.content || "").includes("client.js"))) {
        const peerAnswer = String(toolMsgs[0]?.content || "");
        const outsiderAnswer = String(toolMsgs[1]?.content || "");
        assert.ok(
          outsiderAnswer.includes("not connected to your Team Brain"),
          `Expected cross-team consult block, got: ${outsiderAnswer}`
        );
        const m = peerAnswer.match(/VERIFIED_FROM_WORKSPACE_FILE:([^:\s]+):([^\s]+)/);
        assert.ok(m, `Expected real workspace token from BackendDev consult, got: ${peerAnswer}`);
        return {
          content: "",
          toolCalls: [
            {
              id: "tc_fe_write",
              name: "workspace_write",
              arguments: {
                path: "client.js",
                content: `export const ENDPOINT = "${m[2]}";\nexport const TOKEN = "${m[1]}";\n`,
              },
            },
          ],
        };
      }

      return { content: "FrontendDev consumed live peer answer and wrote client.js." };
    }

    if (agentName === "QASentinel") {
      if (toolMsgs.length === 0) {
        return {
          content: "",
          toolCalls: [{ id: "tc_qa_read", name: "workspace_read", arguments: { path: "client.js" } }],
        };
      }
      const clientCode = String(toolMsgs[0]?.content || "");
      return {
        content: clientCode.includes("REAL_TOKEN_99")
          ? "VERDICT: PASS\nInspected real client.js with synced token."
          : "VERDICT: NEEDS_FIX\nMissing token in client.js.",
      };
    }

    return { content: "OK" };
  });

  const srv = await startPandawaServer();
  try {
    const squad = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      teamName: "Interaction Squad",
      teamSlug: "interaction-squad",
      collaborationMode: "execute",
      wireTopology: false,
      agents: [
        { key: "lead", name: "Commander", purpose: "strategy", title: "Squad Lead", toolPacks: ["brain", "team", "workspace"] },
        { key: "be", name: "BackendDev", purpose: "coding", title: "Backend Dev", toolPacks: ["brain", "team", "workspace"] },
        { key: "fe", name: "FrontendDev", purpose: "coding", title: "Frontend Dev", toolPacks: ["brain", "team", "workspace"] },
        { key: "reviewer", name: "QASentinel", purpose: "review", title: "QA Verifier", toolPacks: ["brain", "team", "workspace"] },
      ],
    });

    const outsider = await bootstrapCustomTeam(srv, {
      purgeStarter: false,
      llmBaseUrl: llm.openaiBaseUrl,
      teamName: "Outsider Team",
      teamSlug: "outsider-team",
      collaborationMode: "execute",
      wireTopology: false,
      agents: [
        { key: "lead", name: "OutsiderLead", purpose: "strategy", title: "Outsider Lead", toolPacks: ["brain", "team", "workspace"] },
        { key: "dev", name: "OutsiderDev", purpose: "coding", title: "Outsider Dev", toolPacks: ["brain", "team", "workspace"] },
      ],
    });

    const topoRes = await srv.api("PUT", "/api/topology", {
      nodes: [...squad.nodes, ...outsider.nodes],
      edges: [...squad.edges, ...outsider.edges],
    });
    assert.equal(topoRes.status, 200, topoRes.text);
    assert.equal((await srv.api("PUT", "/api/approvals/mode", { mode: "auto" })).status, 200);

    const runRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: squad.team.id,
      prompt: "Build synced contract.json and client.js across BackendDev and FrontendDev",
    });
    assert.equal(runRes.status, 200, runRes.text);

    const result = runRes.data.result;
    assert.equal(result.verified, true);
    assert.equal(result.verificationChecks.length, 2);
    assert.ok(result.verificationChecks.every((c) => c.passed));
    assert.ok(result.interactions.peerConsults >= 1, "Must record real consult_teammate call");
    assert.ok(result.interactions.teamMessages >= 3, "Must record real team_message handoff + consult messages");
    assert.ok(result.interactions.blackboardEntries >= 2, "Must record real blackboard entries");

    assert.ok(
      consultedAgents.some((c) => c.agentName === "BackendDev" && c.isConsultTurn),
      "BackendDev must have run a real nested consult turn"
    );
    assert.equal(
      consultedAgents.filter((c) => c.agentName === "OutsiderDev").length,
      0,
      "OutsiderDev from another team must never be invoked"
    );

    const teamMsgsRes = await srv.api(
      "GET",
      `/api/teams/${squad.team.id}/messages?sessionId=${runRes.data.sessionId}`
    );
    assert.equal(teamMsgsRes.status, 200);
    const handoffRow = (teamMsgsRes.data?.messages || []).find((m) =>
      String(m.content || "").includes("HANDOFF_CONTRACT_READY")
    );
    assert.ok(handoffRow, "Persisted team_messages must include BackendDev handoff");
    assert.ok(
      String(handoffRow.read_by_json || "").includes("FrontendDev"),
      `Read receipt must record FrontendDev, got: ${handoffRow.read_by_json}`
    );

    const wsDir = result.interactions.workspaceDir;
    assert.ok(fs.readFileSync(path.join(wsDir, "contract.json"), "utf8").includes("REAL_TOKEN_99"));
    assert.ok(fs.readFileSync(path.join(wsDir, "client.js"), "utf8").includes("REAL_TOKEN_99"));
  } finally {
    await srv.stop().catch(() => {});
    await llm.close().catch(() => {});
  }
});

test("4. E2E: Telegram team direct_reply & standalone agent replies have NO noisy [Team:]/[Agent:] prefixes", async () => {
  const tg = await startMockTelegramServer();
  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const lastUser = String([...msgs].reverse().find((m) => m.role === "user")?.content || "");
    if (lastUser.includes("EXECUTE & SMART TRIAGE MODE")) {
      return {
        content: JSON.stringify({
          action: "direct_reply",
          reason: "Direct chat",
          reply: "Halo bro! Jawaban bersih tanpa prefix.",
        }),
      };
    }
    return { content: "Halo dari agen solo tanpa prefix!" };
  });

  const srv = await startPandawaServer({ telegramBaseUrl: tg.baseUrl });
  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      collaborationMode: "execute",
      agents: [
        { key: "lead", name: "CleanLead", purpose: "strategy", title: "Lead", toolPacks: ["brain", "team"] },
        { key: "reviewer", name: "CleanQA", purpose: "review", title: "QA", toolPacks: ["brain", "team"] },
      ],
    });

    const chRes = await srv.api("POST", "/api/channels", {
      name: "Clean TG",
      type: "telegram",
      targetType: "team",
      targetId: setup.team.id,
      config: { botToken: "99999:CLEAN_TOKEN" },
    });
    assert.equal(chRes.status, 200, chRes.text);
    const channelId = chRes.data.id;

    await waitFor(() => tg.getUpdatesCalls.length > 0, { timeoutMs: 8000, label: "TG poll ready" });

    tg.pushMessage(777, "Halo bro");
    const teamReply = await tg.waitForSentMessage(
      (m) => m.chatId === "777" && m.text.includes("Jawaban bersih tanpa prefix"),
      8000
    );
    assert.equal(teamReply.text, "Halo bro! Jawaban bersih tanpa prefix.");
    assert.ok(!teamReply.text.includes("[Team:"));
    assert.ok(!teamReply.text.includes("Reply by:"));

    // Switch channel target to standalone agent and verify [Agent: ...] is also gone
    const patchCh = await srv.api("PATCH", `/api/channels/${channelId}`, {
      targetType: "agent",
      targetId: setup.agentsByKey.lead.id,
    });
    assert.equal(patchCh.status, 200, patchCh.text);

    tg.pushMessage(777, "Cek agen solo");
    const agentReply = await tg.waitForSentMessage(
      (m) => m.chatId === "777" && m.text.includes("agen solo tanpa prefix"),
      8000
    );
    assert.equal(agentReply.text, "Halo dari agen solo tanpa prefix!");
    assert.ok(!agentReply.text.includes("[Agent:"));
  } finally {
    await srv.stop().catch(() => {});
    await llm.close().catch(() => {});
    await tg.close().catch(() => {});
  }
});

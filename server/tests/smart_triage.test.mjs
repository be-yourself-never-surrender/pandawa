import test from "node:test";
import assert from "node:assert/strict";
import { parseLeadTriagePlan } from "../../dist/server/engine/teamEngine.js";
import { bootstrapCustomTeam, startMockLlmServer, startPandawaServer } from "./helpers/e2e_harness.mjs";

test("parseLeadTriagePlan unit checks: direct_reply, selective delegate, legacy array, plain prose fallback", () => {
  const specs = [{ name: "BackendEng" }, { name: "SecurityEng" }];

  // 1. Direct reply inside fenced block + surrounding prose
  const p1 = parseLeadTriagePlan(
    'Note\n```json\n{"action":"direct_reply","reason":"Greeting","reply":"Halo juga bro!"}\n```',
    specs
  );
  assert.equal(p1.action, "direct_reply");
  assert.equal(p1.reply, "Halo juga bro!");
  assert.equal(p1.reason, "Greeting");
  assert.equal(p1.needsReview, false);
  assert.deepEqual(p1.tasks, []);

  // 2. Direct reply with omitted reply uses surrounding prose cleanly
  const p2 = parseLeadTriagePlan(
    'Siap bro, layanan sedang sehat.\n```json\n{"action":"direct_reply","reason":"Quick answer"}\n```',
    specs
  );
  assert.equal(p2.action, "direct_reply");
  assert.equal(p2.reply, "Siap bro, layanan sedang sehat.");

  // 3. Selective delegation with needsReview=false and legacy agentName/instruction aliases
  const p3 = parseLeadTriagePlan(
    '```json\n{"action":"delegate","needsReview":false,"reason":"API summary","tasks":[{"agentName":"BackendEng","title":"Inspect routes","instruction":"Summarize API endpoints"}]}\n```',
    specs
  );
  assert.equal(p3.action, "delegate");
  assert.equal(p3.needsReview, false);
  assert.equal(p3.tasks.length, 1);
  assert.equal(p3.tasks[0].owner, "BackendEng");
  assert.equal(p3.tasks[0].instructions, "Summarize API endpoints");

  // 4. Legacy top-level array defaults to delegate + needsReview=true
  const p4 = parseLeadTriagePlan(
    '[{"title":"Fix auth","owner":"SecurityEng","verifyCmd":"npm test","instructions":"Patch token verify"}]',
    specs
  );
  assert.equal(p4.action, "delegate");
  assert.equal(p4.needsReview, true);
  assert.equal(p4.tasks[0].owner, "SecurityEng");
  assert.equal(p4.tasks[0].verifyCmd, "npm test");

  // 5. Plain prose without JSON triggers safe fallback delegation
  const p5 = parseLeadTriagePlan("Just run the standard team workflow.", specs);
  assert.equal(p5.action, "delegate");
  assert.equal(p5.needsReview, true);
  assert.deepEqual(p5.tasks, []);

  // 6. Unfenced raw JSON following prose with stray/curly {braces} (e.g. plain-text / no-backticks user preference)
  const p6 = parseLeadTriagePlan(
    'Oke bro, konteks endpoint {id} & catatan {unclosed akan dicek oleh spesialis.\n' +
      '{"action":"delegate","needsReview":true,"reason":"Target API audit","tasks":[{"title":"Audit IDOR","owner":"SecurityEng","instructions":"Check object ownership"}]}',
    specs
  );
  assert.equal(p6.action, "delegate");
  assert.equal(p6.needsReview, true);
  assert.equal(p6.reason, "Target API audit");
  assert.equal(p6.tasks.length, 1);
  assert.equal(p6.tasks[0].owner, "SecurityEng");

  // 7. Unfenced raw direct_reply following prose with {braces}
  const p7 = parseLeadTriagePlan(
    'Catatan internal {debug} siap.\n{"action":"direct_reply","reason":"No tools needed","reply":"Halo bro, polos tanpa markdown."}',
    specs
  );
  assert.equal(p7.action, "direct_reply");
  assert.equal(p7.reply, "Halo bro, polos tanpa markdown.");
  assert.equal(p7.needsReview, false);
});

test("Smart Triage E2E: direct_reply wakes 0 specialists/reviewer; selective delegate wakes ONLY chosen specialist(s)", async () => {
  const agentCalls = [];

  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const sys = msgs.find((m) => m.role === "system")?.content || "";
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content || "";
    const nameMatch = String(sys).match(/- Name: \*\*([^*]+)\*\*/);
    const agentName = nameMatch?.[1]?.trim() || "Unknown";

    agentCalls.push({ agentName, userSnippet: String(lastUser).slice(0, 140) });

    if (agentName === "LeadChief") {
      if (String(lastUser).includes("EXECUTE & SMART TRIAGE MODE")) {
        if (String(lastUser).includes("Halo bro, apa kabar?")) {
          return {
            content:
              '```json\n{"action":"direct_reply","reason":"Casual greeting","reply":"Halo juga bro! Semua tim standby di markas."}\n```',
          };
        }
        if (String(lastUser).includes("Cek ringkasan arsitektur API")) {
          return {
            content:
              '```json\n{"action":"delegate","needsReview":false,"reason":"Backend API overview only","tasks":[{"title":"Summarize API architecture","owner":"BackendEng","instructions":"Provide API summary without modifying files."}]}\n```',
          };
        }
        if (String(lastUser).includes("Audit modul autentikasi")) {
          return {
            content:
              '```json\n{"action":"delegate","needsReview":true,"reason":"Security audit requires QA verify","tasks":[{"title":"Audit JWT auth","owner":"SecurityEng","files":["server/src/auth"],"verifyCmd":"node -e \\"console.log(\'AUDIT_OK\')\\"","instructions":"Verify auth flow cleanly."}]}\n```',
          };
        }
      }
      if (String(lastUser).includes("Original User Mission")) {
        return { content: "[LeadChief Final Synthesis] Completed per selective triage." };
      }
    }

    if (agentName === "QaReviewer") {
      return { content: "VERDICT: PASS\nProgrammatic command and security check verified." };
    }

    return { content: `[${agentName}] Completed assigned specialist task.` };
  });

  const srv = await startPandawaServer();
  const ws = await srv.connectWs();

  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      collaborationMode: "execute",
      agents: [
        { key: "lead", name: "LeadChief", purpose: "strategy", title: "Commander Lead", toolPacks: ["brain", "team"] },
        { key: "backend", name: "BackendEng", purpose: "coding", title: "Backend Engineer", toolPacks: ["brain", "team"] },
        { key: "security", name: "SecurityEng", purpose: "coding", title: "Security Specialist", toolPacks: ["brain", "team"] },
        { key: "reviewer", name: "QaReviewer", purpose: "review", title: "QA Verifier", toolPacks: ["brain", "team"] },
      ],
      senderAgentId: undefined,
    });

    // Enable auto approval so verifyCmd executes without interactive pause in Case C
    const modeRes = await srv.api("PUT", "/api/approvals/mode", { mode: "auto" });
    assert.equal(modeRes.status, 200);

    // Case A: Casual greeting -> Lead answers directly (0 specialists, 0 reviewer, 1 total LLM call)
    agentCalls.length = 0;
    const directRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: setup.team.id,
      prompt: "Halo bro, apa kabar?",
    });
    assert.equal(directRes.status, 200, directRes.text);
    assert.equal(directRes.data.result.triage?.action, "direct_reply");
    assert.deepEqual(directRes.data.result.triage?.delegatedAgents, []);
    assert.equal(directRes.data.result.triage?.skippedReview, true);
    assert.equal(directRes.data.result.contributions.length, 0);
    assert.equal(directRes.data.result.synthesis.content, "Halo juga bro! Semua tim standby di markas.");
    assert.deepEqual(
      agentCalls.map((c) => c.agentName),
      ["LeadChief"],
      "Casual chat must invoke ONLY LeadChief (0 specialists, 0 reviewer)"
    );

    const directMsgs = await srv.api("GET", `/api/sessions/${directRes.data.sessionId}/messages`);
    const assistantMsgs = (directMsgs.data?.messages || []).filter((m) => m.role === "assistant");
    const agentPlanMsgs = (directMsgs.data?.messages || []).filter((m) => m.role === "agent");
    assert.equal(assistantMsgs.length, 1);
    assert.equal(agentPlanMsgs.length, 0, "Direct reply must not emit raw Execution Plan internal messages");
    assert.equal(assistantMsgs[0].content, "Halo juga bro! Semua tim standby di markas.");

    // Case B: Lightweight lookup -> wakes ONLY BackendEng; skips SecurityEng & QaReviewer
    agentCalls.length = 0;
    const liteRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: setup.team.id,
      prompt: "Cek ringkasan arsitektur API",
    });
    assert.equal(liteRes.status, 200, liteRes.text);
    assert.equal(liteRes.data.result.triage?.action, "delegate");
    assert.deepEqual(liteRes.data.result.triage?.delegatedAgents, ["BackendEng"]);
    assert.equal(liteRes.data.result.triage?.skippedReview, true);
    assert.equal(agentCalls.filter((c) => c.agentName === "BackendEng").length, 1);
    assert.equal(agentCalls.filter((c) => c.agentName === "SecurityEng").length, 0, "Unrelated SecurityEng must NOT run");
    assert.equal(agentCalls.filter((c) => c.agentName === "QaReviewer").length, 0, "QaReviewer must be skipped when needsReview=false");

    // Case C: Security audit with verifyCmd -> wakes ONLY SecurityEng + QaReviewer; skips BackendEng
    agentCalls.length = 0;
    const auditRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: setup.team.id,
      prompt: "Audit modul autentikasi",
    });
    assert.equal(auditRes.status, 200, auditRes.text);
    assert.equal(auditRes.data.result.triage?.action, "delegate");
    assert.deepEqual(auditRes.data.result.triage?.delegatedAgents, ["SecurityEng"]);
    assert.equal(auditRes.data.result.triage?.skippedReview, false);
    assert.equal(auditRes.data.result.verified, true);
    assert.equal(auditRes.data.result.verificationChecks?.[0]?.passed, true);
    assert.equal(agentCalls.filter((c) => c.agentName === "SecurityEng").length, 1);
    assert.equal(agentCalls.filter((c) => c.agentName === "BackendEng").length, 0, "Unrelated BackendEng must NOT run");
    assert.equal(agentCalls.filter((c) => c.agentName === "QaReviewer").length, 1);
  } finally {
    try { ws.close(); } catch {}
    await srv.stop().catch(() => {});
    await llm.close().catch(() => {});
  }
});

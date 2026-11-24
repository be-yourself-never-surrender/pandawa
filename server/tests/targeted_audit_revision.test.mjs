import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseReviewerRevisions } from "../../dist/server/engine/teamEngine.js";
import { bootstrapCustomTeam, startMockLlmServer, startPandawaServer } from "./helpers/e2e_harness.mjs";

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

test("1. Unit: parseReviewerRevisions handles REVISE directives, JSON revisions, owner verifyCmd failures & fallback", () => {
  const tasks = [
    { agent: { id: "ag_a", name: "WorkerGood", slug: "worker-good" }, task: { title: "Build A" } },
    { agent: { id: "ag_b", name: "WorkerBuggy", slug: "worker-buggy" }, task: { title: "Build B" } },
  ];

  // (a) REVISE [AgentName]: ... targets ONLY named agent
  const a = parseReviewerRevisions(
    "Checked artifacts.\nREVISE [WorkerBuggy]: Replace placeholder token with FIXED_99.\nVERDICT: NEEDS_FIX",
    [{ title: "Build A", command: "true", exitCode: 0, passed: true, stdout: "", stderr: "", durationMs: 5, ownerAgentId: "ag_a", ownerAgentName: "WorkerGood" }],
    tasks
  );
  assert.equal(a.targeted, true);
  assert.deepEqual(a.targetAgentIds, ["ag_b"]);
  assert.ok(a.feedbackByAgentId.get("ag_b")?.includes("FIXED_99"));
  assert.equal(a.feedbackByAgentId.has("ag_a"), false);

  // (b) JSON revisions block targets ONLY named agent
  const b = parseReviewerRevisions(
    'VERDICT: NEEDS_FIX\n```json\n{"revisions":[{"agent":"WorkerGood","feedback":"Add missing unit doc"}]}\n```',
    [],
    tasks
  );
  assert.equal(b.targeted, true);
  assert.deepEqual(b.targetAgentIds, ["ag_a"]);
  assert.ok(b.feedbackByAgentId.get("ag_a")?.includes("Add missing unit doc"));

  // (c) Programmatic verifyCmd failure forces owner into targeted revisions even without REVISE line
  const c = parseReviewerRevisions(
    "VERDICT: NEEDS_FIX\nBuild B still broken.",
    [
      { title: "Build A", command: "node -e 1", exitCode: 0, passed: true, stdout: "", stderr: "", durationMs: 3, ownerAgentId: "ag_a", ownerAgentName: "WorkerGood" },
      { title: "Build B", command: "node check_b.js", exitCode: 1, passed: false, stdout: "", stderr: "MISSING_TOKEN", durationMs: 4, ownerAgentId: "ag_b", ownerAgentName: "WorkerBuggy" },
    ],
    tasks
  );
  assert.equal(c.targeted, true);
  assert.deepEqual(c.targetAgentIds, ["ag_b"]);
  assert.ok(c.feedbackByAgentId.get("ag_b")?.includes("MISSING_TOKEN"));

  // (d) Plain NEEDS_FIX with no agent targeting falls back to all active specialists
  const d = parseReviewerRevisions("Overall quality insufficient.\nVERDICT: NEEDS_FIX", [], tasks);
  assert.equal(d.targeted, false);
  assert.deepEqual(d.targetAgentIds.sort(), ["ag_a", "ag_b"]);
  assert.ok(d.feedbackByAgentId.get("ag_a")?.includes("Overall quality insufficient"));
  assert.ok(d.feedbackByAgentId.get("ag_b")?.includes("Overall quality insufficient"));
});

test("2. E2E: Targeted conversational audit wakes ONLY buggy specialist & logs read-receipted conversation in Live Monitor", async () => {
  const callsByAgent = new Map();

  const llm = await startMockLlmServer(async (ctx) => {
    const msgs = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
    const sys = String(msgs.find((m) => m.role === "system")?.content || "");
    const lastUser = extractUserText([...msgs].reverse().find((m) => m.role === "user")?.content);
    const agentName = sys.match(/- Name: \*\*([^*]+)\*\*/)?.[1]?.trim() || "Unknown";
    const toolMsgs = msgs.filter((m) => m.role === "tool");

    if (toolMsgs.length === 0) {
      callsByAgent.set(agentName, (callsByAgent.get(agentName) || 0) + 1);
    }

    if (agentName === "LeadCoord") {
      if (lastUser.includes("EXECUTE & SMART TRIAGE MODE")) {
        return {
          content: JSON.stringify({
            action: "delegate",
            needsReview: true,
            reason: "Good worker & buggy worker run separate files",
            tasks: [
              {
                title: "Create good.txt",
                owner: "WorkerGood",
                files: ["good.txt"],
                verifyCmd: "node -e \"if(!require('fs').readFileSync('good.txt','utf8').includes('GOOD_OK'))process.exit(1)\"",
                instructions: "Write good.txt containing GOOD_OK",
              },
              {
                title: "Create bug.txt",
                owner: "WorkerBuggy",
                files: ["bug.txt"],
                verifyCmd: "node -e \"if(!require('fs').readFileSync('bug.txt','utf8').includes('FIXED_TOKEN_99'))process.exit(1)\"",
                instructions: "Write bug.txt cleanly",
              },
            ],
          }),
        };
      }
      return { content: "Targeted audit & revision passed cleanly." };
    }

    if (agentName === "WorkerGood") {
      if (toolMsgs.length === 0) {
        return {
          content: "",
          toolCalls: [{ id: "tc_good", name: "workspace_write", arguments: { path: "good.txt", content: "GOOD_OK\n" } }],
        };
      }
      return { content: "WorkerGood created good.txt with GOOD_OK." };
    }

    if (agentName === "WorkerBuggy") {
      const isRevision = lastUser.includes("AUDIT REVISION REQUEST");
      const content = isRevision ? "FIXED_TOKEN_99\n" : "BROKEN\n";
      if (toolMsgs.length === 0) {
        return {
          content: "",
          toolCalls: [{ id: `tc_bug_${isRevision ? 2 : 1}`, name: "workspace_write", arguments: { path: "bug.txt", content } }],
        };
      }
      return { content: isRevision ? "Revised bug.txt with FIXED_TOKEN_99." : "Initial bug.txt created." };
    }

    if (agentName === "Auditor") {
      if (lastUser.includes("GOOD_OK") && lastUser.includes("FAIL (exit 1)") && !lastUser.includes("Revised in Fix #2")) {
        return {
          content:
            "good.txt passed, but bug.txt failed verifyCmd.\nREVISE [WorkerBuggy]: Replace BROKEN with FIXED_TOKEN_99 in bug.txt.\nVERDICT: NEEDS_FIX",
        };
      }
      return { content: "Both good.txt and bug.txt verified.\nVERDICT: PASS" };
    }

    return { content: "OK" };
  });

  const srv = await startPandawaServer();
  try {
    const setup = await bootstrapCustomTeam(srv, {
      llmBaseUrl: llm.openaiBaseUrl,
      teamName: "Targeted Audit Squad",
      teamSlug: "targeted-audit-squad",
      collaborationMode: "execute",
      maxRounds: 3,
      agents: [
        { key: "lead", name: "LeadCoord", purpose: "strategy", title: "Lead", toolPacks: ["brain", "team", "workspace"] },
        { key: "good", name: "WorkerGood", purpose: "coding", title: "Good Worker", toolPacks: ["brain", "team", "workspace"] },
        { key: "buggy", name: "WorkerBuggy", purpose: "coding", title: "Buggy Worker", toolPacks: ["brain", "team", "workspace"] },
        { key: "reviewer", name: "Auditor", purpose: "review", title: "QA Auditor", toolPacks: ["brain", "team", "workspace"] },
      ],
    });

    await srv.api("PUT", "/api/approvals/mode", { mode: "auto" });

    const runRes = await srv.api("POST", "/api/chat/send", {
      targetType: "team",
      targetId: setup.team.id,
      prompt: "Build good.txt and bug.txt with strict QA verification",
    });
    assert.equal(runRes.status, 200, runRes.text);
    assert.equal(runRes.data.result.verified, true);

    assert.equal(callsByAgent.get("WorkerGood"), 1, "Passing WorkerGood MUST NOT be re-run in Fix Cycle 2");
    assert.equal(callsByAgent.get("WorkerBuggy"), 2, "Flagged WorkerBuggy MUST run twice (initial + targeted Fix #2)");
    assert.equal(callsByAgent.get("Auditor"), 2, "Auditor MUST run initial verification + re-verification");

    const sid = runRes.data.sessionId;
    const monRes = await srv.api("GET", `/api/monitor/session/${encodeURIComponent(sid)}`);
    assert.equal(monRes.status, 200, monRes.text);

    const tmsgs = monRes.data.teamMessages || [];
    const reqMsg = tmsgs.find(
      (m) => m.from_agent === "Auditor" && m.to_agent === "WorkerBuggy" && m.kind === "review" && String(m.content || "").includes("NEEDS_FIX")
    );
    assert.ok(reqMsg, "Live Monitor must contain Auditor -> WorkerBuggy revision request bubble");
    assert.ok(
      Array.isArray(reqMsg.readBy) && reqMsg.readBy.includes("WorkerBuggy"),
      `Read receipt must confirm WorkerBuggy read the revision request, got: ${JSON.stringify(reqMsg.readBy)}`
    );

    const fixReply = tmsgs.find(
      (m) => m.from_agent === "WorkerBuggy" && m.to_agent === "Auditor" && m.kind === "update" && String(m.content || "").includes("[Fix #2]")
    );
    assert.ok(fixReply, "Live Monitor must contain WorkerBuggy -> Auditor Fix #2 reply");

    const passMsg = tmsgs.find(
      (m) => m.from_agent === "Auditor" && m.to_agent === "all" && m.kind === "review" && String(m.content || "").includes("PASS")
    );
    assert.ok(passMsg, "Live Monitor must contain Auditor -> all PASS sign-off bubble");

    const wsDir = runRes.data.result.interactions?.workspaceDir;
    assert.ok(fs.readFileSync(path.join(wsDir, "good.txt"), "utf8").includes("GOOD_OK"));
    assert.ok(fs.readFileSync(path.join(wsDir, "bug.txt"), "utf8").includes("FIXED_TOKEN_99"));
  } finally {
    await srv.stop().catch(() => {});
    await llm.close().catch(() => {});
  }
});

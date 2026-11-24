import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveTeamRoles,
  getAgentRoleBadges,
  getChannelRouteStatus,
  pickDefaultChannelTarget,
  pickInitialBrainFile,
  findTeamForAgent,
  advanceEventCursor,
} from "../src/utils/routingHelpers.ts";

const TEAM_FIXTURE = {
  id: "team_alpha",
  slug: "alpha-squad",
  name: "Alpha Squad",
  description: "Primary engineering squad",
  team_brain_id: "brain_alpha",
  collaboration_mode: "deliberate",
  max_rounds: 2,
  lead_agent_id: "ag_cmd",
  reviewer_agent_id: "ag_qa",
  sender_agent_id: "ag_reply",
  lead_agent_name: "Commander",
  reviewer_agent_name: "Sentinel",
  sender_agent_name: "Herald",
  enabled: true,
  members: [
    { id: "ag_eng", name: "Engineer", avatar: "E", title: "Builder", purpose: "coding", model: "gpt-4.1", color: "#fff" },
    { id: "ag_qa", name: "Sentinel", avatar: "S", title: "QA Lead", purpose: "review", model: "gpt-4.1", color: "#0ff" },
    { id: "ag_cmd", name: "Commander", avatar: "C", title: "Lead", purpose: "strategy", model: "gpt-4.1", color: "#ff0" },
    { id: "ag_reply", name: "Herald", avatar: "H", title: "Comms", purpose: "general", model: "gpt-4.1", color: "#0f0" },
  ],
};

test("resolveEffectiveTeamRoles respects explicit roles and falls back by purpose cleanly", () => {
  const explicit = resolveEffectiveTeamRoles(TEAM_FIXTURE);
  assert.deepEqual(explicit, {
    leadId: "ag_cmd",
    leadName: "Commander",
    reviewerId: "ag_qa",
    reviewerName: "Sentinel",
    senderId: "ag_reply",
    senderName: "Herald",
  });

  const implicit = resolveEffectiveTeamRoles({
    members: [
      { id: "m1", name: "Dev", avatar: "D", title: "Dev", purpose: "coding", model: "m", color: "#111" },
      { id: "m2", name: "Planner", avatar: "P", title: "Lead", purpose: "strategy", model: "m", color: "#222" },
      { id: "m3", name: "Checker", avatar: "C", title: "QA", purpose: "review", model: "m", color: "#333" },
    ],
  });
  assert.deepEqual(implicit, {
    leadId: "m2",
    leadName: "Planner",
    reviewerId: "m3",
    reviewerName: "Checker",
    senderId: "m2",
    senderName: "Planner",
  });
});

test("getAgentRoleBadges computes deduplicated LEAD/QA/REPLY badges", () => {
  assert.deepEqual(getAgentRoleBadges("ag_cmd", [TEAM_FIXTURE]), ["LEAD"]);
  assert.deepEqual(getAgentRoleBadges("ag_qa", [TEAM_FIXTURE]), ["QA"]);
  assert.deepEqual(getAgentRoleBadges("ag_reply", [TEAM_FIXTURE]), ["REPLY"]);
  assert.deepEqual(getAgentRoleBadges("ag_eng", [TEAM_FIXTURE]), []);

  const sharedTeam = {
    ...TEAM_FIXTURE,
    id: "team_shared",
    sender_agent_id: "ag_cmd",
    sender_agent_name: "Commander",
  };
  assert.deepEqual(getAgentRoleBadges("ag_cmd", [sharedTeam]), ["LEAD", "REPLY"]);
});

test("getChannelRouteStatus validates live team, empty team, agent, and orphaned routes", () => {
  const agents = [
    {
      id: "ag_eng",
      slug: "engineer",
      name: "Engineer",
      title: "Builder",
      role_description: "",
      avatar: "E",
      color: "#fff",
      provider_id: null,
      model: "gpt-4.1",
      purpose: "coding",
      temperature: 0.4,
      max_tokens: 4096,
      system_prompt: "",
      toolPacks: [],
      enabled: true,
    },
  ];

  const liveTeam = getChannelRouteStatus({ target_type: "team", target_id: "team_alpha" }, [TEAM_FIXTURE], agents);
  assert.equal(liveTeam.valid, true);
  assert.equal(liveTeam.orphaned, false);
  assert.equal(liveTeam.pipelineSummary, "Lead: Commander -> QA: Sentinel -> Reply: Herald");

  const emptyTeam = { ...TEAM_FIXTURE, id: "team_empty", name: "Empty Squad", members: [] };
  const emptyStatus = getChannelRouteStatus({ target_type: "team", target_id: "team_empty" }, [emptyTeam], agents);
  assert.equal(emptyStatus.valid, false);
  assert.equal(emptyStatus.orphaned, false);

  const orphanDeleted = getChannelRouteStatus({ target_type: "team", target_id: "deleted_team" }, [TEAM_FIXTURE], agents);
  assert.equal(orphanDeleted.valid, false);
  assert.equal(orphanDeleted.orphaned, true);

  const emptyTarget = getChannelRouteStatus({ target_type: "team", target_id: "" }, [TEAM_FIXTURE], agents);
  assert.equal(emptyTarget.valid, false);
  assert.equal(emptyTarget.orphaned, true);

  const agentTarget = getChannelRouteStatus({ target_type: "agent", target_id: "ag_eng" }, [TEAM_FIXTURE], agents);
  assert.equal(agentTarget.valid, true);
  assert.equal(agentTarget.orphaned, false);
  assert.match(agentTarget.label, /Engineer/);
});

test("pickDefaultChannelTarget, pickInitialBrainFile, and findTeamForAgent work without starter IDs", () => {
  assert.equal(pickDefaultChannelTarget([TEAM_FIXTURE], []), "team:team_alpha");
  assert.equal(
    pickDefaultChannelTarget([], [{ id: "ag_only" }]),
    "agent:ag_only"
  );
  assert.equal(pickDefaultChannelTarget([], []), "");

  const tree = [
    {
      name: "teams",
      path: "teams",
      type: "folder",
      children: [
        { name: "team.md", path: "teams/alpha/team.md", type: "file" },
        { name: "soul.md", path: "teams/alpha/soul.md", type: "file" },
      ],
    },
  ];
  assert.equal(pickInitialBrainFile(tree), "teams/alpha/soul.md");
  assert.equal(pickInitialBrainFile([]), "");

  const secondTeam = { ...TEAM_FIXTURE, id: "team_beta", members: [{ id: "ag_b", name: "Beta", avatar: "B", title: "B", purpose: "coding", model: "m", color: "#fff" }] };
  assert.equal(findTeamForAgent("ag_b", [TEAM_FIXTURE, secondTeam]), "team_beta");
  assert.equal(findTeamForAgent("unknown", [TEAM_FIXTURE, secondTeam], "team_beta"), "team_beta");
});

test("advanceEventCursor never drops burst WebSocket events", () => {
  const burst = [
    { type: "agent_start", _seq: 1 },
    { type: "whatsapp_status", channelId: "ch_1", status: "qr", _seq: 2 },
    { type: "topology_updated", _seq: 3 },
  ];
  const step1 = advanceEventCursor(burst, 0);
  assert.equal(step1.nextSeq, 3);
  assert.equal(step1.freshEvents.length, 3);

  const step2 = advanceEventCursor(burst, step1.nextSeq);
  assert.equal(step2.nextSeq, 3);
  assert.equal(step2.freshEvents.length, 0);
});

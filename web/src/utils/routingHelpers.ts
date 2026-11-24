import type { AgentItem, BrainTreeNode, TeamItem } from "../types";

export interface ResolvedTeamRoles {
  leadId: string;
  leadName: string;
  reviewerId: string;
  reviewerName: string;
  senderId: string;
  senderName: string;
}

export function resolveEffectiveTeamRoles(
  team: Pick<
    TeamItem,
    | "lead_agent_id"
    | "lead_agent_name"
    | "reviewer_agent_id"
    | "reviewer_agent_name"
    | "sender_agent_id"
    | "sender_agent_name"
    | "members"
  >
): ResolvedTeamRoles {
  const members = Array.isArray(team.members) ? team.members : [];
  if (members.length === 0) {
    return {
      leadId: String(team.lead_agent_id || ""),
      leadName: String(team.lead_agent_name || ""),
      reviewerId: String(team.reviewer_agent_id || ""),
      reviewerName: String(team.reviewer_agent_name || ""),
      senderId: String(team.sender_agent_id || ""),
      senderName: String(team.sender_agent_name || ""),
    };
  }

  const lead =
    (team.lead_agent_id ? members.find((m) => m.id === team.lead_agent_id) : undefined) ||
    members.find((m) => m.purpose === "strategy") ||
    members[0];

  const specialists = members.filter((m) => m.id !== lead.id);
  const reviewer =
    (team.reviewer_agent_id ? members.find((m) => m.id === team.reviewer_agent_id) : undefined) ||
    specialists.find((m) => m.purpose === "review") ||
    members.find((m) => m.purpose === "review") ||
    lead;

  const sender =
    (team.sender_agent_id ? members.find((m) => m.id === team.sender_agent_id) : undefined) ||
    lead;

  return {
    leadId: lead.id,
    leadName: team.lead_agent_name || lead.name,
    reviewerId: reviewer.id,
    reviewerName: team.reviewer_agent_name || reviewer.name,
    senderId: sender.id,
    senderName: team.sender_agent_name || sender.name,
  };
}

export function getAgentRoleBadges(agentId: string, teams: TeamItem[]): Array<"LEAD" | "QA" | "REPLY"> {
  if (!agentId) return [];
  const badges = new Set<"LEAD" | "QA" | "REPLY">();
  for (const t of teams) {
    if (!t.members?.some((m) => m.id === agentId)) continue;
    const roles = resolveEffectiveTeamRoles(t);
    if (roles.leadId === agentId) badges.add("LEAD");
    if (roles.reviewerId === agentId) badges.add("QA");
    if (roles.senderId === agentId) badges.add("REPLY");
  }
  return Array.from(badges);
}

export function formatTeamPipelineSummary(team: TeamItem): string {
  const members = Array.isArray(team.members) ? team.members : [];
  if (members.length === 0) return "0 members wired";
  const roles = resolveEffectiveTeamRoles(team);
  return `Lead: ${roles.leadName || "—"} -> QA: ${roles.reviewerName || "—"} -> Reply: ${roles.senderName || "—"}`;
}

export interface ChannelRouteStatus {
  valid: boolean;
  orphaned: boolean;
  label: string;
  pipelineSummary: string;
  team?: TeamItem;
  agent?: AgentItem;
}

export function getChannelRouteStatus(
  channel: { target_type: string; target_id: string },
  teams: TeamItem[],
  agents: AgentItem[]
): ChannelRouteStatus {
  const targetId = String(channel.target_id || "").trim();
  if (!targetId) {
    return {
      valid: false,
      orphaned: true,
      label: "Unrouted",
      pipelineSummary: "No target Team or Agent selected",
    };
  }

  if (channel.target_type === "agent") {
    const agent = agents.find((a) => a.id === targetId);
    if (!agent) {
      return {
        valid: false,
        orphaned: true,
        label: `Missing Agent (${targetId})`,
        pipelineSummary: `Target agent "${targetId}" no longer exists`,
      };
    }
    return {
      valid: true,
      orphaned: false,
      label: `Agent · ${agent.name}`,
      pipelineSummary: `Direct Agent: ${agent.name}${agent.title ? ` (${agent.title})` : ""}`,
      agent,
    };
  }

  const team = teams.find((t) => t.id === targetId);
  if (!team) {
    return {
      valid: false,
      orphaned: true,
      label: `Missing Team (${targetId})`,
      pipelineSummary: `Target team "${targetId}" no longer exists`,
    };
  }

  if (!team.members || team.members.length === 0) {
    return {
      valid: false,
      orphaned: false,
      label: `Team · ${team.name} (0 members)`,
      pipelineSummary: "Team has 0 wired members on Canvas",
      team,
    };
  }

  return {
    valid: true,
    orphaned: false,
    label: `Team · ${team.name}`,
    pipelineSummary: formatTeamPipelineSummary(team),
    team,
  };
}

export function pickDefaultChannelTarget(teams: TeamItem[], agents: AgentItem[]): string {
  if (teams.length > 0 && teams[0]?.id) return `team:${teams[0].id}`;
  if (agents.length > 0 && agents[0]?.id) return `agent:${agents[0].id}`;
  return "";
}

export function pickInitialBrainFile(tree: BrainTreeNode[]): string {
  const files: string[] = [];
  function walk(nodes: BrainTreeNode[]) {
    for (const node of nodes) {
      if (node.type === "file") {
        files.push(node.path);
      } else if (node.children?.length) {
        walk(node.children);
      }
    }
  }
  walk(tree);
  if (files.length === 0) return "";
  const preferred =
    files.find((p) => p.toLowerCase().endsWith("/soul.md") || p.toLowerCase() === "soul.md") ||
    files.find((p) => p.toLowerCase().endsWith("/team.md") || p.toLowerCase() === "team.md");
  return preferred || files[0] || "";
}

export function findTeamForAgent(agentId: string, teams: TeamItem[], focusTeamId?: string): string {
  if (focusTeamId && focusTeamId !== "all") {
    const focused = teams.find((t) => t.id === focusTeamId);
    if (focused && (!agentId || focused.members?.some((m) => m.id === agentId))) {
      return focused.id;
    }
  }
  if (agentId) {
    const matched = teams.find((t) => t.members?.some((m) => m.id === agentId));
    if (matched) return matched.id;
  }
  if (focusTeamId && focusTeamId !== "all") {
    const focused = teams.find((t) => t.id === focusTeamId);
    if (focused) return focused.id;
  }
  return teams[0]?.id || "";
}

export function advanceEventCursor(
  liveEvents: Array<Record<string, unknown>>,
  lastSeq: number
): { nextSeq: number; freshEvents: Array<Record<string, unknown>> } {
  if (!Array.isArray(liveEvents) || liveEvents.length === 0) {
    return { nextSeq: lastSeq, freshEvents: [] };
  }
  const hasSeq = liveEvents.some((ev) => typeof ev._seq === "number");
  if (!hasSeq) {
    const latest = liveEvents[liveEvents.length - 1];
    return { nextSeq: lastSeq, freshEvents: latest ? [latest] : [] };
  }
  let nextSeq = lastSeq;
  const freshEvents: Array<Record<string, unknown>> = [];
  for (const ev of liveEvents) {
    const seq = typeof ev._seq === "number" ? ev._seq : 0;
    if (seq > lastSeq) {
      freshEvents.push(ev);
      if (seq > nextSeq) nextSeq = seq;
    }
  }
  return { nextSeq, freshEvents };
}

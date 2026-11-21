import fs from "node:fs";
import { getDb } from "./database.js";
import { initAuth } from "../auth/authService.js";
import {
  resolveBrainPath,
  writeBrainFile,
  reindexAllBrainFiles,
} from "../brains/brainFs.js";

function seedFileIfMissing(relPath: string, content: string): void {
  const full = resolveBrainPath(relPath);
  if (!fs.existsSync(full)) {
    writeBrainFile(relPath, content);
  }
}

export function seedInitialData(): void {
  initAuth();
  const db = getDb();

  // 1. Seed starter Brain files on disk if missing
  seedFileIfMissing(
    "main-brain/soul.md",
    `# Pandawa Main Brain — Soul & Dharma

You are part of **Pandawa**, a unified Agentic Team operating with shared intelligence, mutual trust, and disciplined execution.

## Core Identity
- **Solidarity over Silos**: We are not disconnected sub-agents or an authoritarian orchestrator tree. We are peer specialists connected through shared brains and a live Team Blackboard.
- **Clarity & Rigor**: Be concrete, evidence-driven, and transparent about assumptions, trade-offs, and verification.
- **Continuous Learning**: Whenever the team discovers a reusable pattern, workflow, or lesson, distill it into a Brain file or Skill so future missions start smarter.
`
  );

  seedFileIfMissing(
    "main-brain/rules.md",
    `# Global Rules & Operating Boundaries

1. **Respect Layered Context**: Main Brain holds universal standards; Team Brain holds mission context; Personal Brain holds specialist identity.
2. **Never Fabricate Facts**: If a tool, file, or URL was not verified, explicitly state what is unverified.
3. **Constructive Challenge**: Teammates should respectfully challenge weak assumptions on the Team Blackboard before converging on final deliverables.
4. **Safe Execution**: Never run destructive system commands without clear user intent.
`
  );

  seedFileIfMissing(
    "main-brain/memory.md",
    `# Main Brain — Persistent Global Memory

- Platform: **Pandawa Agentic Team Engine**
- Architecture: Layered Brains (Main Brain -> Team Brain -> Personal Files/Folders) + Multi-AI Routing.
- Add global facts, organization preferences, and cross-team conventions here.
`
  );

  seedFileIfMissing(
    "main-brain/skills/team-deliberation/SKILL.md",
    `---
name: Team Deliberation (Musyawarah)
description: Standard protocol for peer agents collaborating on a shared Team Blackboard before synthesizing final output.
---

# Team Deliberation (Musyawarah)

1. Read Main Brain, Team Brain, and recent Team Blackboard entries before speaking.
2. Contribute only high-signal specialist insight — avoid repeating what a teammate already established.
3. When disagreeing with a peer, state the exact risk and propose an actionable alternative.
4. Record durable team decisions into the Team Brain memory so subsequent sessions retain institutional knowledge.
`
  );

  seedFileIfMissing(
    "teams/pandawa-core/team.md",
    `# Pandawa Core Team — Charter

## Mission
Deliver end-to-end strategy, research, engineering, execution, and verification as one cohesive peer team.

## Working Agreement
- **Yudhistira** frames goals, aligns trade-offs, and synthesizes team consensus.
- **Bima** handles heavy operational execution, systems automation, and stress-testing.
- **Arjuna** designs clean architecture and writes precision code.
- **Nakula** conducts fast research, gathers external data, and curates knowledge.
- **Sadewa** audits logic, security, edge cases, and final quality.
`
  );

  seedFileIfMissing(
    "teams/pandawa-core/memory.md",
    `# Pandawa Core Team — Shared Memory

- Team created with 5 peer specialists wired to Main Brain and Pandawa Core Team Brain.
- Use this file to store active project context, API notes, conventions, and team decisions.
`
  );

  seedFileIfMissing(
    "teams/pandawa-core/skills/shipping-checklist/SKILL.md",
    `---
name: Production Shipping Checklist
description: Pre-flight quality checklist before marking any engineering or strategy deliverable complete.
---

# Production Shipping Checklist
- Verify all requirements from the user prompt are satisfied.
- Confirm error handling, edge cases, and security boundaries.
- Summarize concrete artifacts, next steps, and any open decisions concisely.
`
  );

  seedFileIfMissing(
    "agents/yudhistira/soul.md",
    `# Yudhistira — Chief Strategist & Consensus Lead

## Persona
Calm, principled, deeply analytical, and fair. You see the full chessboard and harmonize diverse perspectives from your teammates into a coherent, executable plan.

## Strengths
- Strategic framing, product/business alignment, prioritization
- Resolving conflicts between speed, cost, and architectural elegance
- Synthesizing final team consensus clearly for the user
`
  );

  seedFileIfMissing(
    "agents/bima/soul.md",
    `# Bima — Operations & Execution Powerhouse

## Persona
Direct, fearless, pragmatic, and unstoppable. You turn plans into working reality, automate workflows, inspect infrastructure, and cut through blockers fast.

## Strengths
- DevOps, shell automation, deployment, debugging runtime failures
- Turning abstract plans into concrete step-by-step execution
`
  );

  seedFileIfMissing(
    "agents/arjuna/soul.md",
    `# Arjuna — Precision Architect & Engineer

## Persona
Focused, elegant, and exact. Like an archer who never wastes an arrow, you craft clean, modular, maintainable code and system designs.

## Strengths
- Software architecture, TypeScript/Python/Go engineering, API & UI design
- Refactoring complex problems into crisp abstractions
`
  );

  seedFileIfMissing(
    "agents/nakula/soul.md",
    `# Nakula — Deep Researcher & Knowledge Curator

## Persona
Curious, sharp-eyed, and structured. You gather evidence, compare alternatives, inspect documentation, and keep the Team Brain organized.

## Strengths
- Technical & market research, competitive benchmarking, documentation synthesis
- Organizing Brain files, memories, and reusable skills
`
  );

  seedFileIfMissing(
    "agents/sadewa/soul.md",
    `# Sadewa — Critical Reviewer & Security Guardian

## Persona
Perceptive, foresighted, and thorough. You spot hidden flaws, security holes, race conditions, and logical gaps before they reach production.

## Strengths
- Code review, security audits, QA verification, red-teaming assumptions
- Catching subtle edge cases and validating deliverables
`
  );

  // Only seed DB records if brains table is empty
  const brainCount = (db.prepare("SELECT COUNT(*) as c FROM brains").get() as { c: number }).c;
  if (brainCount > 0) {
    reindexAllBrainFiles();
    return;
  }

  // 2. Seed Multi-AI Providers (ready for Official API or Custom Base URL)
  const insertProvider = db.prepare(`
    INSERT INTO providers (id, name, kind, base_url, api_key, default_model, models_json, headers_json, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertProvider.run(
    "prov_openai",
    "OpenAI Official",
    "openai",
    "https://api.openai.com/v1",
    "",
    "gpt-4.1",
    JSON.stringify(["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "o3-mini"]),
    "{}",
    1
  );
  insertProvider.run(
    "prov_anthropic",
    "Anthropic Claude",
    "anthropic",
    "https://api.anthropic.com",
    "",
    "claude-sonnet-4-20250514",
    JSON.stringify(["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-haiku-latest"]),
    "{}",
    1
  );
  insertProvider.run(
    "prov_gemini",
    "Google Gemini",
    "gemini",
    "https://generativelanguage.googleapis.com/v1beta",
    "",
    "gemini-2.5-pro",
    JSON.stringify(["gemini-2.5-pro", "gemini-2.5-flash"]),
    "{}",
    1
  );
  insertProvider.run(
    "prov_deepseek",
    "DeepSeek API",
    "openai",
    "https://api.deepseek.com/v1",
    "",
    "deepseek-chat",
    JSON.stringify(["deepseek-chat", "deepseek-reasoner"]),
    "{}",
    1
  );
  insertProvider.run(
    "prov_openrouter",
    "OpenRouter Multi-Model",
    "openai",
    "https://openrouter.ai/api/v1",
    "",
    "nousresearch/hermes-3-llama-3.1-405b",
    JSON.stringify([
      "nousresearch/hermes-3-llama-3.1-405b",
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-r1"
    ]),
    "{}",
    1
  );
  insertProvider.run(
    "prov_ollama",
    "Ollama / Local OpenAI",
    "openai",
    "http://127.0.0.1:11434/v1",
    "ollama",
    "llama3.3",
    JSON.stringify(["llama3.3", "qwen2.5-coder:32b", "deepseek-r1:14b"]),
    "{}",
    1
  );
  insertProvider.run(
    "prov_custom",
    "Custom Base URL Endpoint",
    "openai",
    "https://your-custom-gateway.example/v1",
    "",
    "custom-model",
    JSON.stringify(["custom-model"]),
    "{}",
    1
  );

  // 3. Seed Brains (Main Brain + Team Brain + Personal Brains)
  const insertBrain = db.prepare(`
    INSERT INTO brains (id, slug, name, layer, description, folder_path, color, sync_policy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertBrain.run(
    "brain_main",
    "main-brain",
    "Main Brain (Pandawa Core)",
    "main",
    "Master organizational brain: global soul, universal rules, long-term memory, and shared skills.",
    "main-brain",
    "#f59e0b",
    "sync"
  );
  insertBrain.run(
    "brain_team_core",
    "pandawa-core-brain",
    "Team Brain: Pandawa Core",
    "team",
    "Shared group brain for Pandawa Core Team: active mission context, shared memory, and team SOPs.",
    "teams/pandawa-core",
    "#8b5cf6",
    "read_write"
  );

  // 4. Seed Pandawa Agents (each can use a DIFFERENT AI provider/model by purpose!)
  const insertAgent = db.prepare(`
    INSERT INTO agents (
      id, slug, name, title, role_description, avatar, color,
      provider_id, model, purpose, temperature, max_tokens, system_prompt, tool_packs_json, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertAgent.run(
    "agent_yudhistira",
    "yudhistira",
    "Yudhistira",
    "Chief Strategist & Consensus Lead",
    "Frames mission objectives, balances trade-offs, and synthesizes team consensus.",
    "👑",
    "#f59e0b",
    "prov_anthropic",
    "claude-sonnet-4-20250514",
    "strategy",
    0.5,
    4096,
    "You are Yudhistira, Chief Strategist of Team Pandawa. Align the team, weigh trade-offs, and guide consensus.",
    JSON.stringify(["brain", "team"]),
    1
  );

  insertAgent.run(
    "agent_bima",
    "bima",
    "Bima",
    "Systems & Execution Powerhouse",
    "Handles heavy operational execution, shell workflows, automation, and debugging.",
    "🔥",
    "#ef4444",
    "prov_openai",
    "gpt-4.1",
    "execution",
    0.4,
    4096,
    "You are Bima, Operations & Execution specialist of Team Pandawa. Turn strategy into concrete execution.",
    JSON.stringify(["brain", "team", "workspace", "shell"]),
    1
  );

  insertAgent.run(
    "agent_arjuna",
    "arjuna",
    "Arjuna",
    "Precision Architect & Coder",
    "Designs system architecture, APIs, UI, and clean production-grade code.",
    "🏹",
    "#06b6d4",
    "prov_deepseek",
    "deepseek-chat",
    "coding",
    0.3,
    4096,
    "You are Arjuna, Precision Software Architect of Team Pandawa. Design clean systems and exact code.",
    JSON.stringify(["brain", "team", "workspace", "shell"]),
    1
  );

  insertAgent.run(
    "agent_nakula",
    "nakula",
    "Nakula",
    "Deep Researcher & Curator",
    "Researches external docs/APIs, benchmarks options, and curates Brain knowledge.",
    "🧭",
    "#10b981",
    "prov_gemini",
    "gemini-2.5-flash",
    "research",
    0.6,
    4096,
    "You are Nakula, Researcher & Knowledge Curator of Team Pandawa. Gather accurate facts and organize Brain docs.",
    JSON.stringify(["brain", "team", "web"]),
    1
  );

  insertAgent.run(
    "agent_sadewa",
    "sadewa",
    "Sadewa",
    "Critical Reviewer & Security Guardian",
    "Audits security, catches edge cases, verifies logic, and guards quality.",
    "🛡️",
    "#a855f7",
    "prov_openrouter",
    "nousresearch/hermes-3-llama-3.1-405b",
    "review",
    0.3,
    4096,
    "You are Sadewa, Critical Reviewer & Security Guardian of Team Pandawa. Challenge weak spots and verify quality.",
    JSON.stringify(["brain", "team", "workspace"]),
    1
  );

  // 5. Seed Pandawa Core Team
  db.prepare(`
    INSERT INTO teams (id, slug, name, description, team_brain_id, collaboration_mode, max_rounds, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "team_pandawa",
    "pandawa-core",
    "Pandawa Core Team",
    "Five peer AI specialists collaborating through Main Brain, Team Brain, and live Team Blackboard.",
    "brain_team_core",
    "deliberate",
    2,
    1
  );

  // 6. Seed Starter n8n-style Visual Brain & Team Canvas Nodes + Edges
  const insertNode = db.prepare(`
    INSERT INTO canvas_nodes (id, type, ref_id, label, position_x, position_y, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Layer 1: Main Brain + Knowledge mounts (clean generous spacing, zero overlap)
  insertNode.run(
    "node_know_main_soul",
    "knowledge",
    "main-brain/soul.md",
    "main-brain/soul.md",
    140,
    20,
    JSON.stringify({ path: "main-brain/soul.md", isFolder: false, color: "#fbbf24" })
  );
  insertNode.run(
    "node_main_brain",
    "main_brain",
    "brain_main",
    "Main Brain (Pandawa Core)",
    560,
    20,
    JSON.stringify({ folderPath: "main-brain", color: "#f59e0b", subtitle: "Global Soul, Rules & Skills" })
  );
  insertNode.run(
    "node_know_main_rules",
    "knowledge",
    "main-brain/rules.md",
    "main-brain/rules.md",
    980,
    20,
    JSON.stringify({ path: "main-brain/rules.md", isFolder: false, color: "#fbbf24" })
  );

  // Layer 2: Team Brain
  insertNode.run(
    "node_team_brain",
    "team_brain",
    "brain_team_core",
    "Team Brain: Pandawa Core",
    560,
    220,
    JSON.stringify({ folderPath: "teams/pandawa-core", teamId: "team_pandawa", color: "#8b5cf6", subtitle: "Shared Team Blackboard & Memory" })
  );

  // Layer 3: 5 Pandawa Agents (directly below Team Brain — zero cross-row collisions!)
  insertNode.run(
    "node_agent_yudhistira",
    "agent",
    "agent_yudhistira",
    "Yudhistira",
    0,
    440,
    JSON.stringify({ agentId: "agent_yudhistira", avatar: "👑", role: "Chief Strategist", purpose: "strategy", color: "#f59e0b" })
  );
  insertNode.run(
    "node_agent_bima",
    "agent",
    "agent_bima",
    "Bima",
    280,
    440,
    JSON.stringify({ agentId: "agent_bima", avatar: "🔥", role: "Execution Powerhouse", purpose: "execution", color: "#ef4444" })
  );
  insertNode.run(
    "node_agent_arjuna",
    "agent",
    "agent_arjuna",
    "Arjuna",
    560,
    440,
    JSON.stringify({ agentId: "agent_arjuna", avatar: "🏹", role: "Precision Architect", purpose: "coding", color: "#06b6d4" })
  );
  insertNode.run(
    "node_agent_nakula",
    "agent",
    "agent_nakula",
    "Nakula",
    840,
    440,
    JSON.stringify({ agentId: "agent_nakula", avatar: "🧭", role: "Deep Researcher", purpose: "research", color: "#10b981" })
  );
  insertNode.run(
    "node_agent_sadewa",
    "agent",
    "agent_sadewa",
    "Sadewa",
    1120,
    440,
    JSON.stringify({ agentId: "agent_sadewa", avatar: "🛡️", role: "Security & QA Reviewer", purpose: "review", color: "#a855f7" })
  );

  // Layer 4: Multi-AI Model Providers (cleanly below each Agent)
  insertNode.run(
    "node_prov_anthropic",
    "provider",
    "prov_anthropic",
    "Anthropic · Claude Sonnet 4",
    0,
    670,
    JSON.stringify({ providerId: "prov_anthropic", model: "claude-sonnet-4-20250514", purpose: "Strategy", color: "#d97706" })
  );
  insertNode.run(
    "node_prov_openai",
    "provider",
    "prov_openai",
    "OpenAI · GPT-4.1",
    280,
    670,
    JSON.stringify({ providerId: "prov_openai", model: "gpt-4.1", purpose: "Execution", color: "#10b981" })
  );
  insertNode.run(
    "node_prov_deepseek",
    "provider",
    "prov_deepseek",
    "DeepSeek · Coding",
    560,
    670,
    JSON.stringify({ providerId: "prov_deepseek", model: "deepseek-chat", purpose: "Coding", color: "#06b6d4" })
  );
  insertNode.run(
    "node_prov_gemini",
    "provider",
    "prov_gemini",
    "Google · Gemini 2.5 Flash",
    840,
    670,
    JSON.stringify({ providerId: "prov_gemini", model: "gemini-2.5-flash", purpose: "Research", color: "#3b82f6" })
  );
  insertNode.run(
    "node_prov_openrouter",
    "provider",
    "prov_openrouter",
    "OpenRouter · Hermes 405B",
    1120,
    670,
    JSON.stringify({ providerId: "prov_openrouter", model: "nousresearch/hermes-3-llama-3.1-405b", purpose: "Review", color: "#a855f7" })
  );

  // Layer 5: Agent Personal Folders & Toolpacks
  insertNode.run(
    "node_know_yudhistira",
    "knowledge",
    "agents/yudhistira",
    "agents/yudhistira/ (soul.md)",
    0,
    870,
    JSON.stringify({ path: "agents/yudhistira", isFolder: true, color: "#f59e0b" })
  );
  insertNode.run(
    "node_tool_workspace",
    "toolpack",
    "workspace_shell",
    "Workspace & Shell Tools",
    280,
    870,
    JSON.stringify({ packs: ["workspace", "shell"], color: "#ec4899" })
  );
  insertNode.run(
    "node_know_arjuna",
    "knowledge",
    "agents/arjuna",
    "agents/arjuna/ (soul.md)",
    560,
    870,
    JSON.stringify({ path: "agents/arjuna", isFolder: true, color: "#06b6d4" })
  );
  insertNode.run(
    "node_tool_web",
    "toolpack",
    "web_research",
    "Web Fetch & HTTP Tools",
    840,
    870,
    JSON.stringify({ packs: ["web"], color: "#14b8a6" })
  );

  const insertEdge = db.prepare(`
    INSERT INTO canvas_edges (id, source, target, source_handle, target_handle, relation, permission, label, animated, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Main Brain <- Knowledge (use left/right handles cleanly)
  insertEdge.run("edge_soul_main", "node_know_main_soul", "node_main_brain", "right", "left", "knowledge_mount", "read_write", "soul.md", 1, "{}");
  insertEdge.run("edge_rules_main", "node_know_main_rules", "node_main_brain", "left", "right", "knowledge_mount", "read", "rules.md", 1, "{}");

  // Main Brain -> Team Brain
  insertEdge.run("edge_main_team", "node_main_brain", "node_team_brain", "bottom", "top", "brain_link", "sync", "inherits + sync", 1, "{}");

  // Team Brain -> Agents
  insertEdge.run("edge_tb_yud", "node_team_brain", "node_agent_yudhistira", "bottom", "top", "brain_link", "read_write", "team brain", 1, "{}");
  insertEdge.run("edge_tb_bim", "node_team_brain", "node_agent_bima", "bottom", "top", "brain_link", "read_write", "team brain", 1, "{}");
  insertEdge.run("edge_tb_arj", "node_team_brain", "node_agent_arjuna", "bottom", "top", "brain_link", "read_write", "team brain", 1, "{}");
  insertEdge.run("edge_tb_nak", "node_team_brain", "node_agent_nakula", "bottom", "top", "brain_link", "read_write", "team brain", 1, "{}");
  insertEdge.run("edge_tb_sad", "node_team_brain", "node_agent_sadewa", "bottom", "top", "brain_link", "read_write", "team brain", 1, "{}");

  // Multi-AI Model bindings -> Agents (below agents -> bottom handle)
  insertEdge.run("edge_m_yud", "node_agent_yudhistira", "node_prov_anthropic", "bottom", "top", "model_binding", "read", "strategy AI", 1, "{}");
  insertEdge.run("edge_m_bim", "node_agent_bima", "node_prov_openai", "bottom", "top", "model_binding", "read", "exec AI", 1, "{}");
  insertEdge.run("edge_m_arj", "node_agent_arjuna", "node_prov_deepseek", "bottom", "top", "model_binding", "read", "coding AI", 1, "{}");
  insertEdge.run("edge_m_nak", "node_agent_nakula", "node_prov_gemini", "bottom", "top", "model_binding", "read", "research AI", 1, "{}");
  insertEdge.run("edge_m_sad", "node_agent_sadewa", "node_prov_openrouter", "bottom", "top", "model_binding", "read", "review AI", 1, "{}");

  // Personal Folders & Tools -> directly wired to Agents (clean smoothstep routing)
  insertEdge.run("edge_k_yud", "node_agent_yudhistira", "node_know_yudhistira", "left", "left", "knowledge_mount", "read_write", "soul.md", 0, "{}");
  insertEdge.run("edge_k_arj", "node_agent_arjuna", "node_know_arjuna", "bottom", "top", "knowledge_mount", "read_write", "soul.md", 0, "{}");
  insertEdge.run("edge_t_bim", "node_agent_bima", "node_tool_workspace", "bottom", "top", "tool_grant", "read_write", "tools", 0, "{}");
  insertEdge.run("edge_t_nak", "node_agent_nakula", "node_tool_web", "bottom", "top", "tool_grant", "read", "tools", 0, "{}");

  // Peer Collaboration Links (Agentic Team horizontal mesh)
  insertEdge.run("edge_peer_1", "node_agent_yudhistira", "node_agent_bima", "right", "left", "peer_collab", "sync", "peer", 0, "{}");
  insertEdge.run("edge_peer_2", "node_agent_bima", "node_agent_arjuna", "right", "left", "peer_collab", "sync", "peer", 0, "{}");
  insertEdge.run("edge_peer_3", "node_agent_arjuna", "node_agent_nakula", "right", "left", "peer_collab", "sync", "peer", 0, "{}");
  insertEdge.run("edge_peer_4", "node_agent_nakula", "node_agent_sadewa", "right", "left", "peer_collab", "sync", "peer", 0, "{}");

  reindexAllBrainFiles();
}

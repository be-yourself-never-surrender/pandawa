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

  // Only seed starter files & DB topology on a clean database
  // (never re-create files the user intentionally deleted or reorganized!)
  const brainCount = (db.prepare("SELECT COUNT(*) as c FROM brains").get() as { c: number }).c;
  if (brainCount > 0) {
    reindexAllBrainFiles();
    return;
  }

  // 1. Minimal, easy-to-customize starter Brain files (only 4 core files)
  seedFileIfMissing(
    "main-brain/soul.md",
    `# Main Brain — Identity & Goals

Define who your AI team is, your tone, priorities, and operating philosophy here.

- Be concrete, honest, and concise.
- Verify real outputs before claiming success.
`
  );

  seedFileIfMissing(
    "main-brain/rules.md",
    `# Operating Rules

1. Follow instructions in Main Brain, Team Brain, and any mounted files/skills.
2. Never fabricate command output, file paths, or verification results.
3. Ask before destructive changes when Approval Gate is enabled.
`
  );

  seedFileIfMissing(
    "main-brain/memory.md",
    `# Persistent Memory

Store durable facts, project conventions, and user preferences here.
`
  );

  seedFileIfMissing(
    "teams/pandawa-core/team.md",
    `# Pandawa Core Team

Starter 2-agent workspace. Customize roles, add more agents on Brain Canvas, or wire a Telegram/WhatsApp channel directly to this team.
`
  );

  // 2. Seed Multi-AI Providers (all keys blank — user configures whichever provider they use)
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
    "anthropic/claude-sonnet-4",
    JSON.stringify([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-r1",
    ]),
    "{}",
    1
  );
  insertProvider.run(
    "prov_ollama",
    "Ollama / Local OpenAI",
    "openai",
    "http://127.0.0.1:11434/v1",
    "",
    "llama3.3",
    JSON.stringify(["llama3.3", "qwen2.5-coder:32b", "deepseek-r1:14b"]),
    "{}",
    0
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

  // 3. Seed Minimal Brains (1 Main Brain + 1 Team Brain)
  const insertBrain = db.prepare(`
    INSERT INTO brains (id, slug, name, layer, description, folder_path, color, sync_policy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertBrain.run(
    "brain_main",
    "main-brain",
    "Main Brain",
    "main",
    "Global soul, rules, memory, and installed skills shared across teams.",
    "main-brain",
    "#e5a00d",
    "sync"
  );
  insertBrain.run(
    "brain_team_core",
    "pandawa-core-brain",
    "Team Brain: Core",
    "team",
    "Shared workspace context and memory for your starter team.",
    "teams/pandawa-core",
    "#a1a1aa",
    "read_write"
  );

  // 4. Seed Lean 2-Agent Starter Squad (easy to customize or expand via + Agent / + Team Kit)
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
    "Lead & Coordinator",
    "Frames goals, coordinates peers, and synthesizes clear answers.",
    "Y",
    "#e5a00d",
    "prov_openai",
    "gpt-4.1",
    "strategy",
    0.5,
    4096,
    "You are Yudhistira, Lead Coordinator. Plan clearly, align with teammates, and deliver crisp results.",
    JSON.stringify(["brain", "team", "web"]),
    1
  );

  insertAgent.run(
    "agent_arjuna",
    "arjuna",
    "Arjuna",
    "Builder & Executor",
    "Writes code, runs terminal/workspace tools, and verifies results.",
    "A",
    "#a1a1aa",
    "prov_openai",
    "gpt-4.1",
    "coding",
    0.3,
    4096,
    "You are Arjuna, Builder & Executor. Implement cleanly, verify outputs in workspace/terminal, and report exact evidence.",
    JSON.stringify(["brain", "team", "workspace", "shell", "terminal"]),
    1
  );

  // 5. Seed Starter Core Team
  db.prepare(`
    INSERT INTO teams (id, slug, name, description, team_brain_id, collaboration_mode, max_rounds, lead_agent_id, reviewer_agent_id, sender_agent_id, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "team_pandawa",
    "pandawa-core",
    "Pandawa Core Team",
    "Clean 2-agent starter team. Add more agents, wire models, or connect Telegram/WhatsApp on Brain Canvas.",
    "brain_team_core",
    "execute",
    2,
    "agent_yudhistira",
    "",
    "agent_yudhistira",
    1
  );

  // 6. Seed Clean Minimal Visual Brain Canvas (5 nodes, 5 wires — zero clutter!)
  const insertNode = db.prepare(`
    INSERT INTO canvas_nodes (id, type, ref_id, label, position_x, position_y, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertNode.run(
    "node_main_brain",
    "main_brain",
    "brain_main",
    "Main Brain",
    260,
    40,
    JSON.stringify({ folderPath: "main-brain", subtitle: "soul.md · rules.md · skills" })
  );
  insertNode.run(
    "node_team_brain",
    "team_brain",
    "brain_team_core",
    "Team Brain: Core",
    260,
    210,
    JSON.stringify({ folderPath: "teams/pandawa-core", teamId: "team_pandawa", subtitle: "Shared team context" })
  );
  insertNode.run(
    "node_agent_yudhistira",
    "agent",
    "agent_yudhistira",
    "Yudhistira",
    100,
    390,
    JSON.stringify({ agentId: "agent_yudhistira", avatar: "Y", role: "Lead & Coordinator", purpose: "strategy" })
  );
  insertNode.run(
    "node_agent_arjuna",
    "agent",
    "agent_arjuna",
    "Arjuna",
    420,
    390,
    JSON.stringify({ agentId: "agent_arjuna", avatar: "A", role: "Builder & Executor", purpose: "coding" })
  );
  insertNode.run(
    "node_prov_primary",
    "provider",
    "prov_openai",
    "OpenAI · gpt-4.1",
    260,
    580,
    JSON.stringify({ providerId: "prov_openai", model: "gpt-4.1", purpose: "Primary" })
  );

  const insertEdge = db.prepare(`
    INSERT INTO canvas_edges (id, source, target, source_handle, target_handle, relation, permission, label, animated, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertEdge.run("edge_main_team", "node_main_brain", "node_team_brain", "bottom", "top", "brain_link", "sync", "inherits", 1, "{}");
  insertEdge.run("edge_tb_yud", "node_team_brain", "node_agent_yudhistira", "bottom", "top", "brain_link", "read_write", "team", 1, "{}");
  insertEdge.run("edge_tb_arj", "node_team_brain", "node_agent_arjuna", "bottom", "top", "brain_link", "read_write", "team", 1, "{}");
  insertEdge.run("edge_peer_1", "node_agent_yudhistira", "node_agent_arjuna", "right", "left", "peer_collab", "sync", "peer", 0, "{}");
  insertEdge.run("edge_m_yud", "node_agent_yudhistira", "node_prov_primary", "bottom", "top", "model_binding", "read", "model", 1, "{}");
  insertEdge.run("edge_m_arj", "node_agent_arjuna", "node_prov_primary", "bottom", "top", "model_binding", "read", "model", 1, "{}");

  reindexAllBrainFiles();
}

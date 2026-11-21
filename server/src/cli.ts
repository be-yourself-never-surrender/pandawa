#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PORT, HOST, DATA_DIR, BRAINS_DIR, WORKSPACE_DIR, ensureDirectories, generateId } from "./config.js";
import { getDb } from "./db/database.js";
import { seedInitialData } from "./db/seed.js";
import { listSkills } from "./brains/brainFs.js";
import { getApprovalMode, setApprovalMode, type ApprovalMode } from "./engine/approvalManager.js";
import { runTeamMission } from "./engine/teamEngine.js";
import { runAgentTurn } from "./engine/agentRunner.js";
import { exportTeamBundle } from "./bundles/bundleService.js";
import { listAllToolPacks } from "./tools/toolRegistry.js";

const [, , cmd = "help", ...rest] = process.argv;

function printHelp() {
  console.log(`
Pandawa v4.0 — Visual Agentic Team & Layered Brain CLI

Usage:
  pandawa start                 Start the Pandawa Web Studio & API server (port ${PORT})
  pandawa chat [prompt]         Interactive terminal session with Team Pandawa (or single prompt)
  pandawa status                Show active Brains, Teams, Agents, Providers, Skills & Tools
  pandawa doctor                Run full environment & storage health diagnostics
  pandawa approval <mode>       Set approval mode: auto | approve_shell | approve_sensitive | approve_all
  pandawa backup [file.json]    Export Team + Brains + Canvas into a portable .pandawa.json kit
  pandawa help                  Show this help screen
`);
}

async function cmdStatus() {
  ensureDirectories();
  seedInitialData();
  const db = getDb();
  const brains = db.prepare("SELECT name, layer, folder_path FROM brains").all() as Array<{ name: string; layer: string; folder_path: string }>;
  const teams = db.prepare("SELECT id, name, collaboration_mode FROM teams").all() as Array<{ id: string; name: string; collaboration_mode: string }>;
  const agents = db.prepare("SELECT name, title, purpose, model FROM agents WHERE enabled = 1").all() as Array<{ name: string; title: string; purpose: string; model: string }>;
  const providers = db.prepare("SELECT name, kind, base_url, length(trim(api_key)) as hasKey FROM providers").all() as Array<{ name: string; kind: string; base_url: string; hasKey: number }>;
  const packs = listAllToolPacks();
  const totalTools = packs.reduce((acc, p) => acc + p.tools.length, 0);

  console.log(`\n⚡ PANDAWA v4.0 STATUS`);
  console.log(`   Data Dir      : ${DATA_DIR}`);
  console.log(`   Approval Mode : ${getApprovalMode()}`);
  console.log(`   Brains (${brains.length})    : ${brains.map((b) => `[${b.layer}] ${b.name}`).join(", ")}`);
  console.log(`   Teams (${teams.length})     : ${teams.map((t) => `${t.name} (${t.collaboration_mode})`).join(", ")}`);
  console.log(`   Agents (${agents.length})    : ${agents.map((a) => `${a.name}[${a.model || a.purpose}]`).join(", ")}`);
  console.log(`   Providers     : ${providers.filter((p) => p.hasKey > 0).length}/${providers.length} ready`);
  console.log(`   Skills        : ${listSkills().length} SKILL.md playbooks`);
  console.log(`   Tool Arsenal  : ${totalTools} built-in tools across ${packs.length} toolpacks (+ live MCP)\n`);
}

async function cmdDoctor() {
  console.log(`\n🩺 PANDAWA DOCTOR — Diagnostics`);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  console.log(`   [${nodeMajor >= 22 ? "OK" : "WARN"}] Node.js ${process.version} (recommended: v24+)`);
  try {
    ensureDirectories();
    seedInitialData();
    const db = getDb();
    db.prepare("SELECT count(*) FROM brains").get();
    console.log(`   [OK] Native node:sqlite + FTS5 database operational`);
  } catch (err) {
    console.log(`   [FAIL] SQLite error: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`   [OK] Brains folder   : ${BRAINS_DIR}`);
  console.log(`   [OK] Workspace folder: ${WORKSPACE_DIR}`);
  console.log(`   [OK] Host RAM        : ${Math.round(os.freemem() / 1024 / 1024)} MB free / ${Math.round(os.totalmem() / 1024 / 1024)} MB total`);
  console.log(`   [OK] Vault Key       : ${fs.existsSync(path.join(DATA_DIR, ".vault.key")) ? "present (AES-256-GCM)" : "auto-created on first key save"}`);
  console.log(`   [OK] Server Endpoint : http://${HOST}:${PORT}\n`);
}

async function cmdChat(initialPrompt: string) {
  ensureDirectories();
  seedInitialData();
  const db = getDb();
  let targetType: "team" | "agent" = "team";
  let targetId = "team_pandawa";
  let sessionId = generateId("ses");
  db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
    sessionId,
    initialPrompt ? `[CLI] ${initialPrompt.slice(0, 48)}` : "[CLI] Interactive Session",
    targetType,
    targetId
  );

  async function runOne(text: string) {
    if (text.startsWith("/")) {
      const [slash, ...args] = text.trim().split(/\s+/);
      if (slash === "/status") return cmdStatus();
      if (slash === "/new") {
        sessionId = generateId("ses");
        db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
          sessionId,
          "[CLI] New Session",
          targetType,
          targetId
        );
        console.log("Started fresh session:", sessionId);
        return;
      }
      if (slash === "/agent" && args[0]) {
        const a = db
          .prepare("SELECT id, name FROM agents WHERE lower(name) LIKE ? OR lower(slug) LIKE ? LIMIT 1")
          .get(`%${args[0].toLowerCase()}%`, `%${args[0].toLowerCase()}%`) as { id: string; name: string } | undefined;
        if (a) {
          targetType = "agent";
          targetId = a.id;
          console.log(`Switched to single agent: ${a.name}`);
        } else console.log(`Agent "${args[0]}" not found.`);
        return;
      }
      if (slash === "/team") {
        targetType = "team";
        targetId = args[0] || "team_pandawa";
        console.log(`Switched to team: ${targetId}`);
        return;
      }
      if (slash === "/auto") {
        setApprovalMode("auto");
        console.log("Approval mode -> auto (Full Freedom)");
        return;
      }
      console.log("Slash commands: /status, /new, /team, /agent <name>, /auto, /exit");
      return;
    }

    if (targetType === "agent") {
      const res = await runAgentTurn({
        agentId: targetId,
        sessionId,
        prompt: text,
        onEvent: (ev) => {
          if (ev.type === "tool_call") process.stdout.write(`\n  [tool] ${ev.agentName} -> ${ev.toolName}\n`);
        },
      });
      console.log(`\n${res.avatar} ${res.agentName} [${res.model}]:\n${res.content}\n`);
    } else {
      const res = await runTeamMission({
        teamId: targetId,
        sessionId,
        userPrompt: text,
        onEvent: (ev) => {
          if (ev.type === "team_phase" && ev.detail) console.log(`  › ${ev.detail}`);
          if (ev.type === "tool_call") console.log(`  [tool] ${ev.agentName} -> ${ev.toolName}`);
        },
      });
      console.log(`\n👑 ${res.teamName} Consensus:\n${res.synthesis.content}\n`);
    }
  }

  if (initialPrompt.trim()) {
    await runOne(initialPrompt.trim());
    return;
  }

  console.log(`\n⚡ Pandawa Interactive CLI (target: ${targetType}:${targetId})`);
  console.log(`   Commands: /team, /agent <name>, /new, /status, /auto, /exit\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "pandawa> " });
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }
    if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit") break;
    try {
      await runOne(trimmed);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
    }
    rl.prompt();
  }
  rl.close();
}

async function main() {
  switch (cmd) {
    case "start":
      await import("./index.js");
      break;
    case "status":
      await cmdStatus();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "chat":
      await cmdChat(rest.join(" "));
      break;
    case "approval": {
      ensureDirectories();
      seedInitialData();
      const mode = rest[0] as ApprovalMode | undefined;
      if (mode && ["auto", "approve_shell", "approve_sensitive", "approve_all"].includes(mode)) {
        setApprovalMode(mode);
        console.log(`Approval mode updated -> ${mode}`);
      } else {
        console.log(`Current approval mode: ${getApprovalMode()}`);
        console.log(`Valid options: auto | approve_shell | approve_sensitive | approve_all`);
      }
      break;
    }
    case "backup": {
      ensureDirectories();
      seedInitialData();
      const outPath = rest[0] || `pandawa-backup-${Date.now()}.pandawa.json`;
      const bundle = exportTeamBundle({ includeMainBrain: true });
      fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2), "utf8");
      console.log(`Exported backup kit to ${outPath} (${bundle.files.length} brain files, ${bundle.agents.length} agents).`);
      break;
    }
    default:
      printHelp();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

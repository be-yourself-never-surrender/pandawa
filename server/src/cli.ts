#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import {
  PANDAWA_VERSION,
  PORT,
  HOST,
  DATA_DIR,
  BRAINS_DIR,
  WORKSPACE_DIR,
  ensureDirectories,
  generateId,
} from "./config.js";
import { getDb } from "./db/database.js";
import { seedInitialData } from "./db/seed.js";
import { listSkills } from "./brains/brainFs.js";
import {
  getApprovalMode,
  setApprovalMode,
  resolveApproval,
  setApprovalRequestedHook,
  type ApprovalMode,
} from "./engine/approvalManager.js";
import { runTeamMission } from "./engine/teamEngine.js";
import { runAgentTurn } from "./engine/agentRunner.js";
import { exportTeamBundle } from "./bundles/bundleService.js";
import { listAllToolPacks } from "./tools/toolRegistry.js";
import {
  listTerminals,
  openTerminal,
  readTerminal,
  closeTerminal,
} from "./tools/terminalManager.js";
import { getPythonWorkerStatus } from "./tools/pythonWorker.js";
import { listBackgroundJobs } from "./engine/backgroundRunner.js";

const [, , cmd = "help", ...rest] = process.argv;

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  amber: "\x1b[33m",
  cyan: "\x1b[36m",
  violet: "\x1b[35m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function printHelp() {
  console.log(`
${C.amber}${C.bold}⚡ Pandawa OS v${PANDAWA_VERSION} — Living Agentic OS & Layered Brain CLI${C.reset}

${C.bold}Usage:${C.reset}
  pandawa start                      Start Pandawa Web Studio, API & Background Daemon (port ${PORT})
  pandawa live [prompt]              Live interactive Terminal TUI with streaming agents, tools & inline approvals
  pandawa chat [prompt]              Alias for 'pandawa live'
  pandawa term [list|open|attach|read|close] [name]
                                     Manage or attach (tmux) directly into living shared agent terminals
  pandawa status                     Show Brains, Teams, Agents, Providers, Terminals, Jobs & Tool Arsenal
  pandawa doctor                     Check Node, SQLite FTS5, Python Worker, tmux, Playwright & Doc parsers
  pandawa approval <mode>            Set approval mode: auto | approve_shell | approve_sensitive | approve_all
  pandawa backup [file.json]         Export Team + Brains + Canvas into portable .pandawa.json kit
  pandawa help                       Show this help screen
`);
}

async function cmdStatus() {
  ensureDirectories();
  seedInitialData();
  const db = getDb();
  const brains = db.prepare("SELECT name, layer, folder_path FROM brains").all() as Array<{
    name: string;
    layer: string;
    folder_path: string;
  }>;
  const teams = db.prepare("SELECT id, name, collaboration_mode FROM teams").all() as Array<{
    id: string;
    name: string;
    collaboration_mode: string;
  }>;
  const agents = db
    .prepare("SELECT name, title, purpose, model, max_iterations FROM agents WHERE enabled = 1")
    .all() as Array<{ name: string; title: string; purpose: string; model: string; max_iterations?: number }>;
  const providers = db
    .prepare("SELECT name, kind, base_url, api_key, enabled FROM providers")
    .all() as Array<{ name: string; kind: string; base_url: string; api_key: string; enabled: number }>;
  const readyProviderCount = providers.filter(
    (p) => p.enabled === 1 && p.api_key.trim().length > 0 && p.api_key.trim().toLowerCase() !== "ollama"
  ).length;
  const packs = listAllToolPacks();
  const totalTools = packs.reduce((acc, p) => acc + p.tools.length, 0);
  const terms = await listTerminals();
  const jobs = listBackgroundJobs(20);
  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "queued").length;

  console.log(`\n${C.amber}${C.bold}⚡ PANDAWA v${PANDAWA_VERSION} — LIVING AGENTIC OS STATUS${C.reset}`);
  console.log(`   Data Dir       : ${DATA_DIR}`);
  console.log(`   Approval Mode  : ${C.cyan}${getApprovalMode()}${C.reset}`);
  console.log(`   Brains (${brains.length})     : ${brains.map((b) => `[${b.layer}] ${b.name}`).join(", ")}`);
  console.log(`   Teams (${teams.length})      : ${teams.map((t) => `${t.name} (${t.collaboration_mode})`).join(", ")}`);
  console.log(
    `   Agents (${agents.length})     : ${agents
      .map((a) => `${a.name}[${a.model || a.purpose}·${a.max_iterations || 35}st]`)
      .join(", ")}`
  );
  console.log(`   Providers      : ${readyProviderCount}/${providers.length} ready`);
  console.log(`   Skills         : ${listSkills().length} SKILL.md playbooks`);
  console.log(`   Tool Arsenal   : ${totalTools} built-in tools across ${packs.length} toolpacks (+ live MCP)`);
  console.log(
    `   Terminals      : ${terms.sessions.length} living (${terms.tmux ? "tmux ready" : "tmux missing"})`
  );
  console.log(`   Background Jobs: ${activeJobs} active / ${jobs.length} recent\n`);
}

async function cmdDoctor() {
  console.log(`\n${C.cyan}${C.bold}🩺 PANDAWA v${PANDAWA_VERSION} DOCTOR — Hybrid Runtime Diagnostics${C.reset}`);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  console.log(`   [${nodeMajor >= 22 ? "OK" : "WARN"}] Node.js ${process.version}`);
  try {
    ensureDirectories();
    seedInitialData();
    const db = getDb();
    db.prepare("SELECT count(*) FROM brains").get();
    console.log(`   [OK] Native node:sqlite + FTS5 + Team Messages + Background Jobs`);
  } catch (err) {
    console.log(`   [FAIL] SQLite error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const terms = await listTerminals();
  console.log(
    `   [${terms.tmux ? "OK" : "WARN"}] Shared Persistent Terminals (tmux): ${
      terms.tmux ? `${terms.sessions.length} active session(s)` : "tmux not found"
    }`
  );
  const py = await getPythonWorkerStatus();
  const caps = (py.capabilities || {}) as Record<string, boolean>;
  console.log(
    `   [${py.ok ? "OK" : "WARN"}] Python Living Worker: ${py.python || "unavailable"} (${py.executable || "n/a"})`
  );
  console.log(
    `        Capabilities -> playwright:${caps.playwright ? "YES" : "no"} | pypdf:${caps.pypdf ? "YES" : "no"} | docx:${
      caps.docx ? "YES" : "no"
    } | openpyxl:${caps.openpyxl ? "YES" : "no"}`
  );
  console.log(`   [OK] Brains Vault    : ${BRAINS_DIR}`);
  console.log(`   [OK] Workspace Dir   : ${WORKSPACE_DIR}`);
  console.log(
    `   [OK] Host RAM        : ${Math.round(os.freemem() / 1024 / 1024)} MB free / ${Math.round(
      os.totalmem() / 1024 / 1024
    )} MB total`
  );
  console.log(
    `   [OK] Vault Key       : ${
      fs.existsSync(path.join(DATA_DIR, ".vault.key")) ? "present (AES-256-GCM)" : "auto-created on first key save"
    }`
  );
  console.log(`   [OK] Server Endpoint : http://${HOST}:${PORT}\n`);
}

async function cmdTerm(args: string[]) {
  const sub = (args[0] || "list").toLowerCase();
  const name = args[1] || "main";

  if (sub === "list" || sub === "ls") {
    const res = await listTerminals();
    if (!res.tmux) {
      console.log(`${C.red}tmux is not available on this host.${C.reset}`);
      return;
    }
    if (res.sessions.length === 0) {
      console.log(`${C.dim}No living Pandawa terminal sessions. Run: pandawa term open main${C.reset}`);
      return;
    }
    console.log(`\n${C.cyan}${C.bold}🖥️  Living Shared Pandawa Terminals (${res.sessions.length})${C.reset}`);
    for (const s of res.sessions) {
      console.log(
        `  • ${C.amber}${s.name}${C.reset} (${s.tmuxName})  owner=${s.ownerAgent}  cmd=${C.green}${s.currentCommand}${C.reset}  cwd=${C.dim}${s.cwd}${C.reset}`
      );
      console.log(`    attach: ${C.cyan}pandawa term attach ${s.name}${C.reset}  (or: ${s.attachCommand})`);
    }
    console.log();
    return;
  }

  if (sub === "open") {
    const res = await openTerminal({ name, ownerAgent: "cli" });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (sub === "read") {
    const res = await readTerminal(name, Number(args[2] || 120));
    if (res.ok) console.log(res.output);
    else console.error(res.error);
    return;
  }

  if (sub === "close" || sub === "kill") {
    const res = await closeTerminal(name);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (sub === "attach") {
    const slug = name.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase();
    const tname = slug.startsWith("pdw_") ? slug : `pdw_${slug}`;
    console.log(`${C.cyan}Attaching to ${tname} (detach anytime with Ctrl+B then D)...${C.reset}`);
    spawnSync("tmux", ["attach", "-t", tname], { stdio: "inherit" });
    return;
  }

  console.log("Usage: pandawa term [list | open <name> | attach <name> | read <name> | close <name>]");
}

async function cmdLive(initialPrompt: string) {
  ensureDirectories();
  seedInitialData();
  const db = getDb();
  let targetType: "team" | "agent" = "team";
  let targetId = "team_pandawa";
  let modeOverride: string | undefined = undefined;
  let sessionId = generateId("ses");
  db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
    sessionId,
    initialPrompt ? `[TUI] ${initialPrompt.slice(0, 48)}` : "[TUI] Live Terminal Session",
    targetType,
    targetId
  );

  // Enable inline interactive Approval prompts directly in the terminal TUI!
  let promptingApproval = false;
  setApprovalRequestedHook((record) => {
    if (promptingApproval) return;
    promptingApproval = true;
    const askRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(
      `\n${C.amber}${C.bold}🛡️  APPROVAL GATE [${record.id}]${C.reset} — ${C.cyan}${record.agentName}${C.reset} wants to run ${C.bold}${record.toolName}${C.reset}`
    );
    console.log(`   ${C.dim}${JSON.stringify(record.args).slice(0, 320)}${C.reset}`);
    askRl.question(
      `${C.amber}   [y] Approve  [a] Approve & Switch Auto  [n] Reject > ${C.reset}`,
      (ans) => {
        askRl.close();
        promptingApproval = false;
        const k = ans.trim().toLowerCase();
        if (k === "a" || k === "auto") {
          resolveApproval(record.id, true, { switchToAuto: true });
          console.log(`${C.green}   ✓ Approved & switched Approval Gate -> auto (Full Freedom)${C.reset}`);
        } else if (k === "n" || k === "no") {
          resolveApproval(record.id, false, { reason: "Rejected in Terminal TUI" });
          console.log(`${C.red}   ✗ Rejected${C.reset}`);
        } else {
          resolveApproval(record.id, true);
          console.log(`${C.green}   ✓ Approved${C.reset}`);
        }
      }
    );
  });

  let lastStreamAgent = "";
  function renderLiveEvent(ev: Record<string, unknown>) {
    const t = String(ev.type || "");
    if (t === "team_phase" && ev.detail) {
      if (lastStreamAgent) {
        process.stdout.write("\n");
        lastStreamAgent = "";
      }
      console.log(`${C.violet}▸ ${ev.detail}${C.reset}`);
    } else if (t === "agent_start") {
      if (lastStreamAgent) process.stdout.write("\n");
      lastStreamAgent = "";
      console.log(
        `${C.cyan}${C.bold}● ${ev.avatar || "⚡"} ${ev.agentName}${C.reset} ${C.dim}[${ev.model || "default"}]${C.reset}`
      );
    } else if (t === "agent_token") {
      const aid = String(ev.agentId || "");
      if (aid !== lastStreamAgent) {
        if (lastStreamAgent) process.stdout.write("\n");
        process.stdout.write(`${C.dim}${ev.agentName}:${C.reset} `);
        lastStreamAgent = aid;
      }
      process.stdout.write(String(ev.delta || ""));
    } else if (t === "tool_call") {
      if (lastStreamAgent) {
        process.stdout.write("\n");
        lastStreamAgent = "";
      }
      const stepStr = ev.step ? `[${ev.step}/${ev.maxSteps || 35}] ` : "";
      console.log(
        `  ${C.amber}⚙ ${stepStr}${ev.agentName} → ${ev.toolName}${C.reset} ${C.dim}${JSON.stringify(ev.args || {}).slice(0, 120)}${C.reset}`
      );
    } else if (t === "team_message") {
      if (lastStreamAgent) {
        process.stdout.write("\n");
        lastStreamAgent = "";
      }
      console.log(
        `  ${C.green}💬 ${ev.fromAgent} → ${ev.toAgent} [${ev.kind}]:${C.reset} ${String(ev.content || "").slice(0, 180)}`
      );
    } else if (t === "context_compacted") {
      console.log(
        `  ${C.dim}🗜️  Compacted ${ev.compactedCount} earlier steps for ${ev.agentName}${C.reset}`
      );
    } else if (t === "agent_done") {
      if (lastStreamAgent) {
        process.stdout.write("\n");
        lastStreamAgent = "";
      }
    }
  }

  async function runOne(text: string) {
    if (text.startsWith("/")) {
      const [slash, ...args] = text.trim().split(/\s+/);
      if (slash === "/status") return cmdStatus();
      if (slash === "/doctor") return cmdDoctor();
      if (slash === "/term") return cmdTerm(args);
      if (slash === "/new") {
        sessionId = generateId("ses");
        db.prepare("INSERT INTO sessions (id, title, target_type, target_id) VALUES (?, ?, ?, ?)").run(
          sessionId,
          "[TUI] New Session",
          targetType,
          targetId
        );
        console.log(`${C.green}Started fresh session:${C.reset} ${sessionId}`);
        return;
      }
      if (slash === "/mode" && args[0]) {
        const m = args[0].toLowerCase();
        if (["execute", "deliberate", "parallel", "sequential", "consensus"].includes(m)) {
          modeOverride = m;
          db.prepare("UPDATE teams SET collaboration_mode = ? WHERE id = ?").run(m, targetId);
          console.log(`${C.amber}Team collaboration mode -> ${m}${C.reset}`);
        } else {
          console.log("Valid modes: execute | deliberate | parallel | sequential | consensus");
        }
        return;
      }
      if (slash === "/tasks") {
        const rows = db
          .prepare("SELECT id, title, owner_agent, status FROM team_tasks WHERE team_id = ? ORDER BY updated_at DESC LIMIT 15")
          .all(targetId) as Array<{ id: string; title: string; owner_agent: string; status: string }>;
        if (!rows.length) console.log(`${C.dim}No team tasks yet.${C.reset}`);
        for (const r of rows) {
          console.log(`  [${r.status.toUpperCase()}] ${r.title} (${C.cyan}${r.owner_agent}${C.reset})`);
        }
        return;
      }
      if (slash === "/board") {
        const rows = db
          .prepare("SELECT author_name, entry_type, title, content FROM blackboard_entries WHERE team_id = ? ORDER BY created_at DESC LIMIT 8")
          .all(targetId) as Array<{ author_name: string; entry_type: string; title: string; content: string }>;
        for (const r of rows.reverse()) {
          console.log(`  ${C.violet}[${r.entry_type}] ${r.title}${C.reset} (${r.author_name}): ${r.content.slice(0, 140)}`);
        }
        return;
      }
      if (slash === "/jobs") {
        const jobs = listBackgroundJobs(10);
        for (const j of jobs) {
          console.log(`  ${j.id} [${j.status}] ${j.prompt.slice(0, 60)} — ${C.dim}${j.progress_text}${C.reset}`);
        }
        return;
      }
      if (slash === "/agent" && args[0]) {
        const a = db
          .prepare("SELECT id, name FROM agents WHERE lower(name) LIKE ? OR lower(slug) LIKE ? LIMIT 1")
          .get(`%${args[0].toLowerCase()}%`, `%${args[0].toLowerCase()}%`) as { id: string; name: string } | undefined;
        if (a) {
          targetType = "agent";
          targetId = a.id;
          console.log(`${C.cyan}Switched to single agent: ${a.name}${C.reset}`);
        } else console.log(`Agent "${args[0]}" not found.`);
        return;
      }
      if (slash === "/team") {
        targetType = "team";
        targetId = args[0] || "team_pandawa";
        console.log(`${C.amber}Switched to team: ${targetId}${C.reset}`);
        return;
      }
      if (slash === "/auto") {
        setApprovalMode("auto");
        console.log(`${C.green}Approval mode -> auto (Full Freedom)${C.reset}`);
        return;
      }
      if (slash === "/approve") {
        setApprovalMode("approve_shell");
        console.log(`${C.amber}Approval mode -> approve_shell${C.reset}`);
        return;
      }
      console.log(
        "Commands: /mode execute|deliberate|parallel|sequential, /term [list|open|attach|read], /tasks, /board, /jobs, /team, /agent <name>, /auto, /approve, /status, /doctor, /new, /exit"
      );
      return;
    }

    if (targetType === "agent") {
      const res = await runAgentTurn({
        agentId: targetId,
        sessionId,
        prompt: text,
        onEvent: renderLiveEvent,
      });
      console.log(
        `\n${C.green}${C.bold}${res.avatar} ${res.agentName}${C.reset} ${C.dim}[${res.model} · ${res.stepsUsed || 1} step(s)]${C.reset}\n${res.content}\n`
      );
    } else {
      const res = await runTeamMission({
        teamId: targetId,
        sessionId,
        userPrompt: text,
        modeOverride,
        onEvent: renderLiveEvent,
      });
      console.log(
        `\n${C.amber}${C.bold}👑 ${res.teamName} (${res.mode})${res.verified ? " ✅ VERIFIED" : ""}:${C.reset}\n${res.synthesis.content}\n`
      );
    }
  }

  if (initialPrompt.trim()) {
    await runOne(initialPrompt.trim());
    return;
  }

  console.log(`\n${C.amber}${C.bold}⚡ Pandawa v${PANDAWA_VERSION} — Live Interactive Terminal OS${C.reset}`);
  console.log(
    `${C.dim}   Target: ${targetType}:${targetId} | Approval: ${getApprovalMode()} | Type /mode execute for Plan→Build→Verify${C.reset}`
  );
  console.log(
    `${C.dim}   Commands: /mode execute, /term list, /term attach <name>, /tasks, /board, /auto, /status, /exit${C.reset}\n`
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.amber}pandawa>${C.reset} `,
  });
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
      console.error(`${C.red}Error:${C.reset}`, err instanceof Error ? err.message : String(err));
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
    case "term":
    case "terminal":
      await cmdTerm(rest);
      break;
    case "live":
    case "tui":
    case "chat":
      await cmdLive(rest.join(" "));
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
      console.log(
        `Exported backup kit to ${outPath} (${bundle.files.length} brain files, ${bundle.agents.length} agents).`
      );
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

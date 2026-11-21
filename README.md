<p align="center">
  <img src="assets/banner.jpg" alt="Pandawa OS — Living Agentic Team OS & Visual Layered Brain Platform" width="100%">
</p>

<h1 align="center">PANDAWA OS ⚡</h1>

<p align="center">
  <strong>Hybrid TypeScript + Python Living Agentic Team OS · Visual [[Wikilink]] Layered Brains · Shared Persistent Terminals · Multi-AI Routing</strong>
</p>

<p align="center">
  <a href="https://github.com/be-yourself-never-surrender/pandawa/releases"><img src="https://img.shields.io/badge/Version-6.0.0-f59e0b?style=for-the-badge" alt="Version 6.0.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-10b981?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Runtime-Node.js%2024%20%2B%20Python%203-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node 24 + Python">
  <img src="https://img.shields.io/badge/Terminal-Shared%20PTY%20%2F%20tmux-06b6d4?style=for-the-badge" alt="Shared PTY / tmux">
  <img src="https://img.shields.io/badge/Brain-Obsidian%2B%20%5B%5BWikilinks%5D%5D-8b5cf6?style=for-the-badge" alt="Living Brain">
  <img src="https://img.shields.io/badge/Safety-Approval%20Gate%20%7C%20Zero%20Guardrails-ef4444?style=for-the-badge" alt="User-Controlled Approval">
</p>

---

**Pandawa OS** is a clean-room, self-hosted **Living Agentic Team Operating System** powered by a **Hybrid TypeScript + Python architecture** (~30 MB idle RAM footprint, ready for commercial use). Inspired by the Javanese legend of the **Pandawa Lima** (*Yudhistira, Bima, Arjuna, Nakula, Sadewa*), Pandawa connects multiple AI models into **persistent peer teams that actually live, collaborate, build, test, and verify inside shared terminals**.

- **Beyond Obsidian:** Your Markdown vault isn't passive notes — it's an **executable, layered Living Brain** (`Main Brain → Team Brain → Personal Brain`) with `[[wikilinks]]`, backlinks, progressive disclosure skill loading, FTS5 search, and automatic post-mission self-reflection.
- **Beyond Single-Agent Terminal Tools:** Not just one agent in one shell — **persistent multi-model specialists** running **35–100 step Execute & Verify loops** with LLM semantic compaction, live mid-turn `team_message` chatter, shared `tmux`/PTY terminals, Playwright vision, and automatic fix rounds.
- **Beyond Chat Daemons:** Run decoupled **24/7 Background Daemon Missions** that keep executing even when you close your browser, and watch, steer, or approve actions from **Web Studio**, **Live Terminal TUI (`pandawa live`)**, **`tmux attach`**, or **Telegram**.

<table>
<tr><td><b>Execute &amp; Verify Team Engine (35–100 Steps)</b></td><td>Five modes led by <b>Execute &amp; Verify</b> (Architect splits tasks → Specialists build in shared terminals with file locks → Reviewer runs real builds/tests → Auto-fix loop) plus <b>Musyawarah</b>, <b>Parallel</b>, <b>Sequential</b>, and <b>Rapid Council</b>.</td></tr>
<tr><td><b>Living Shared Terminals (Python PTY / tmux)</b></td><td>Stateful terminal sessions where <code>cd</code>, env vars, virtualenvs, and servers persist across steps. Teammates inspect each other&apos;s terminals (<code>term_read</code>), you watch &amp; type in <b>Web Studio → Live Terminal</b>, or drop directly in via <code>pandawa term attach &lt;name&gt;</code>.</td></tr>
<tr><td><b>Visual Brain Canvas + Living [[Wikilink]] Vault</b></td><td>n8n-style visual wiring for <b>Main Brains</b>, <b>Team Brains</b>, <b>Agents</b>, <b>AI Models</b>, <b>Files/Folders</b>, and <b>Toolpacks</b>. Core files (<code>soul.md</code>, <code>rules.md</code>) auto-load + follow 1-hop <code>[[wikilinks]]</code>, while skills &amp; docs load progressively on demand.</td></tr>
<tr><td><b>Hybrid Python Living Worker &amp; Multimodal Vision</b></td><td>On-demand isolated Python worker powering <b>real headless Chromium (Playwright)</b> (click, fill, eval JS, capture screenshots directly into Vision LLMs), <b>PDF / DOCX / XLSX</b> document reading, plus image upload &amp; clipboard paste in Mission Room.</td></tr>
<tr><td><b>44 Built-In Power Tools + Live MCP</b></td><td>Shared PTY/tmux terminals, live inter-agent <code>team_message</code>/<code>team_inbox</code>, surgical file patching &amp; checkpoints, Python/Node/Bash code execution, zero-key web search, Playwright browser, vision inspection, cron, and live <b>HTTP/SSE + STDIO MCP</b>.</td></tr>
<tr><td><b>Always-On Daemon + Live TUI + Telegram Control</b></td><td>Decoupled <b>Background Mission Queue</b> survives browser closes. Use <code>pandawa live</code> for an interactive ANSI terminal cockpit, or approve/reject/monitor missions remotely from <b>Telegram</b> (<code>/approve</code>, <code>/auto</code>, <code>/reject</code>, <code>/term</code>).</td></tr>
<tr><td><b>Built for Freedom (Approval Gate Only)</b></td><td>Zero hidden guardrails or command blocklists. Govern execution purely through your <b>Approval Gate</b> (<b>Auto / Approve Shell / Approve Sensitive / Approve All</b>) across Web Popup, Terminal TUI, and Telegram.</td></tr>
<tr><td><b>Commercial Brain Kits (<code>.pandawa.json</code>)</b></td><td>Export any Team + Layered Brains + <code>soul.md</code>/skills + Canvas wiring into a clean portable kit (all API keys stripped) with an interactive <b>Preview Modal</b> before install.</td></tr>
</table>

---

## System Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                           Control Surfaces                                 │
│  Web Studio (Canvas · Mission · Live Terminal)  ·  CLI TUI (`pandawa live`)│
│  Direct Shell (`tmux attach`)  ·  2-Way Telegram (+ /approve)  ·  Cron     │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│            Living Brain Vault & Progressive Context Compiler               │
│   [Main Brain] ──▶ [Team Brain] ──▶ [Personal / [[Wikilink]] Graph]        │
│   Core Auto-Load + On-Demand Skill Index + SQLite FTS5 + Auto-Reflection   │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│     Deep Autonomous Team Engine (Execute & Verify · 35–100 Steps)          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Yudhistira  │◀▶│     Bima     │◀▶│    Arjuna    │◀▶│Nakula/Sadewa │   │
│  │ Architect    │  │ Ops / PTY    │  │ Engineering  │  │ Research/QA  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         ▼                 ▼                 ▼                 ▼            │
│   Multi-AI Hub (OpenAI · Anthropic · Gemini · DeepSeek · Custom Base URL)  │
│   SSE Streaming · Vision · LLM Semantic Compaction · Background Daemon     │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│    User Approval Gate (Web / TUI / Telegram) & Hybrid TS + Python Body     │
│  TS Core: 44 Tools · File Locks · Team Chat · Checkpoints · HTTP/STDIO MCP │
│  Python Worker: Shared tmux/PTY · Playwright Chromium · PDF / DOCX / XLSX  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Install

### Linux, macOS, WSL2 (1-Line Installer)

```bash
curl -fsSL https://raw.githubusercontent.com/be-yourself-never-surrender/pandawa/main/scripts/install.sh | bash
# Optional: enable full Python Living Worker (Playwright Chromium + PDF/DOCX/XLSX)
bash ~/.pandawa/runtime/python_worker/setup.sh
```

### Windows (PowerShell)

```powershell
iex (irm https://raw.githubusercontent.com/be-yourself-never-surrender/pandawa/main/scripts/install.ps1)
```

### Docker Compose (Includes Node 24 + Python 3 + tmux)

```bash
git clone https://github.com/be-yourself-never-surrender/pandawa.git
cd pandawa
docker compose up -d --build
```

### Manual Source Build

```bash
git clone https://github.com/be-yourself-never-surrender/pandawa.git
cd pandawa
npm install && npm --prefix web install
npm run build
bash runtime/python_worker/setup.sh   # optional: Playwright + PDF/DOCX/XLSX
PANDAWA_PORT=7777 npm start
```

Open **`http://localhost:7777`** (or **`http://<VPS_IP>:7777`**) and sign in with the default password **`11111111`**, then change your password under **Settings & VPS**.

---

## Terminal OS & CLI Quick Reference

```bash
pandawa start                     # Start Web Studio, API & Background Daemon (port 7777)
pandawa live                      # Interactive ANSI Live TUI (streaming + inline approvals)
pandawa live "Build & test API"   # Run a live mission straight from terminal
pandawa term list                 # List all active shared agent terminals (tmux)
pandawa term attach main          # Jump directly into a living agent terminal (`tmux attach`)
pandawa status                    # Inspect Brains, Teams, Agents, Terminals, Jobs & Tools
pandawa doctor                    # Verify Node, SQLite FTS5, tmux, Python Worker & Playwright
pandawa approval auto             # Switch Approval Gate (auto | approve_shell | approve_sensitive | approve_all)
pandawa backup kit.json           # Export Team + Brains + Canvas into .pandawa.json kit
```

### Mission Room, Live TUI & Telegram Commands

| Command / Syntax | Where | Description |
| --- | --- | --- |
| `@main-brain/soul.md` | Web / TUI | Inline any Brain file directly into your mission prompt |
| `[[note-name]]` | Brain Files | Obsidian-style wikilink auto-followed at compile time + clickable backlinks |
| `/mode execute` | Web / TUI | Switch to **Execute & Verify** (`Plan → PTY Build → Test → Fix Loop`) |
| `/mode deliberate` | Web / TUI | Switch to **Musyawarah** (`deliberate`, `parallel`, `sequential`, `consensus`) |
| `/term list` / `/term attach <name>` | TUI | Inspect or attach live to any shared agent `tmux` terminal |
| `/approve [id]` / `/auto [id]` / `/reject [id]` | Telegram | Remotely approve or reject agent actions from your phone |
| `/auto` / `/approve` | Web / TUI | Toggle **Auto (Full Freedom)** vs **Approve Shell** |

---

## Complete Tool Arsenal (44 Built-In Tools · 8 Toolpacks + Live MCP)

| Toolpack | Included Tools |
| --- | --- |
| **`terminal`** *(Shared PTY/tmux)* | `term_open`, `term_exec`, `term_send`, `term_read`, `term_list`, `term_close` |
| **`brain`** *(Living Vault & FTS5)* | `brain_search`, `brain_list`, `brain_read`, `brain_write`, `remember_fact`, `learn_skill`, `session_search` |
| **`team`** *(Live Peer Collaboration)* | `blackboard_post`, `blackboard_read`, `consult_teammate`, `team_todo_manage`, `team_message`, `team_inbox` |
| **`workspace`** *(Engineering & Docs)* | `workspace_list`, `workspace_read`, `workspace_write`, `workspace_patch`, `workspace_grep`, `checkpoint_create`, `checkpoint_rollback`, `doc_read` (PDF/DOCX/XLSX), `vision_inspect` |
| **`shell`** *(Exec & Processes)* | `shell_exec`, `code_execute` (Python/Node/Bash), `process_start`, `process_list`, `process_logs`, `process_kill` |
| **`web`** *(Search & HTTP)* | `web_search` (zero-key DuckDuckGo + optional Tavily), `web_fetch`, `http_request` |
| **`browser`** *(Playwright + Vision)* | `browser_open`, `browser_interact` (click/fill/press/eval), `browser_screenshot` (auto-attaches to Vision LLM), `browser_extract` |
| **`automation`** *(24/7 Ops)* | `cron_create`, `cron_list`, `channel_notify` (Telegram / Discord / Webhook) |
| **`mcp`** *(Dynamic)* | Live **HTTP/SSE** & **Local STDIO** MCP auto-discovery (`mcp__<server>__<tool>`) |

---

## Multi-AI Provider Support

Configure unlimited providers in **Multi-AI Hub** (encrypted at rest via **AES-256-GCM**) with full **Multimodal Vision**, SSE streaming, retry backoff, and automatic backup fallback:

| Protocol (`kind`) | Supported Providers & Endpoints |
| --- | --- |
| **`openai`** | OpenAI Official, DeepSeek, Groq, xAI, Mistral, OpenRouter, Ollama, vLLM, LM Studio, LiteLLM, **any Custom Base URL** |
| **`anthropic`** | Anthropic Official (`api.anthropic.com`) with ephemeral prompt caching & vision, or Anthropic-compatible endpoints |
| **`gemini`** | Google Gemini Native API (`generativelanguage.googleapis.com/v1beta`) with SSE streaming & vision |

---

## Production Deployment with Auto-HTTPS (Caddy)

```caddyfile
pandawa.yourdomain.com {
    reverse_proxy 127.0.0.1:7777
}
```

## License

**MIT License** — 100% original clean-room codebase. Free to self-host, modify, white-label, and commercialize.

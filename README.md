<p align="center">
  <img src="assets/banner.jpg" alt="Pandawa OS — Living Agentic Team OS & Visual Layered Brain Platform" width="100%">
</p>

<h1 align="center">PANDAWA OS ⚡</h1>

<p align="center">
  <strong>Hardened Hybrid TypeScript + Python Agentic Team OS · Visual [[Wikilink]] Layered Brains · Real-Time xterm.js PTY · Multi-AI Routing</strong>
</p>

<p align="center">
  <a href="https://github.com/be-yourself-never-surrender/pandawa/actions"><img src="https://img.shields.io/github/actions/workflow/status/be-yourself-never-surrender/pandawa/ci.yml?style=for-the-badge&label=CI%20Build%20%26%20Tests" alt="CI Status"></a>
  <a href="https://github.com/be-yourself-never-surrender/pandawa/releases"><img src="https://img.shields.io/badge/Version-7.0.0-f59e0b?style=for-the-badge" alt="Version 7.0.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-10b981?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Runtime-Node.js%2022.5%2B%20%2F%2024%20%2B%20Python%203-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node 24 + Python">
  <img src="https://img.shields.io/badge/Terminal-xterm.js%20PTY%20%2F%20tmux-06b6d4?style=for-the-badge" alt="xterm PTY">
  <a href="SECURITY.md"><img src="https://img.shields.io/badge/Security-Hardened%20%7C%20Approval%20Gate-ef4444?style=for-the-badge" alt="Security"></a>
</p>

---

**Pandawa OS** is a clean-room, self-hosted **Agentic Team Operating System** built with a **Hybrid TypeScript + Python architecture**. Inspired by the Javanese legend of the **Pandawa Lima** (*Yudhistira, Bima, Arjuna, Nakula, Sadewa*), Pandawa connects multiple AI models into **persistent peer teams** sharing visual layered brains, real-time `xterm.js` / `tmux` terminals, programmatic verification loops, and user-controlled approval gates.

- **Executable Layered Brain Vault:** `Main Brain → Team Brain → Personal Brain` stored as transparent Markdown with `[[wikilinks]]`, backlinks, progressive on-demand skill loading, FTS5 search, hybrid semantic search (offline TF-IDF + n-gram + optional dense neural embeddings), and import for **Files, Entire Folders (Obsidian Vaults), `.zip`, PDF, DOCX, and XLSX**.
- **Programmatic Execute & Verify Engine:** Multi-model teams running up to **100 steps/turn** with **machine-enforced `verifyCmd` exit-code checks** (preventing false-positive LLM verdicts), enforced parallel file locks with atomic writes, live mid-turn `team_message` coordination, LLM semantic compaction, and mission token budget caps.
- **Hardened by Default, Freedom by Choice:** Unique random initial password on fresh boot, login rate-limiting (`429`), instant JWT revocation on password change, single-use 30s WebSocket tickets, same-origin CORS, mandatory constant-time webhook secrets, `AES-256-GCM` encryption for **all** provider keys / Telegram tokens / webhook secrets / MCP headers, cloud-metadata SSRF blocking, and non-root Docker — with **zero hidden content censorship** (governed solely by your Approval Gate).

<table>
<tr><td><b>Programmatic Execute &amp; Verify (Up to 100 Steps)</b></td><td>Architect splits tasks with <code>verifyCmd</code> → Builders execute in shared terminals under enforced file locks → Orchestrator runs <code>verifyCmd</code> directly and enforces real exit codes (<code>verified=true</code> only on exit <code>0</code>) → Auto-fix loop. Plus <b>Musyawarah</b> (Deliberate + Cross-Review), <b>Parallel/Rapid Council</b>, and <b>Sequential Relay</b>.</td></tr>
<tr><td><b>Real-Time xterm.js PTY Terminal (Linux / macOS / WSL2)</b></td><td>Interactive 60fps ANSI terminal right inside Web Studio (<code>xterm.js</code> ↔ WebSocket ticket ↔ Python PTY ↔ <code>tmux</code>) shared live with Pandawa agents, or attach over SSH via <code>pandawa term attach &lt;name&gt;</code>. <i>(Windows users: run under WSL2 or Docker for full PTY/tmux support.)</i></td></tr>
<tr><td><b>Visual Brain Canvas + Living [[Wikilink]] Vault</b></td><td>n8n-style visual wiring for <b>Main Brains</b>, <b>Team Brains</b>, <b>Agents</b>, <b>AI Models</b>, <b>Files/Folders</b>, and <b>Toolpacks</b>. Core files auto-load + follow 1-hop <code>[[wikilinks]]</code>; skills &amp; notes load progressively. Import individual files, full Obsidian folders, <code>.zip</code> archives (anti-zip-slip), or PDF/DOCX/XLSX.</td></tr>
<tr><td><b>Hybrid Semantic Search &amp; Python Worker (Optional Setup)</b></td><td>Offline semantic engine (sublinear TF-IDF + char n-grams + wikilink boost) works out of the box and auto-upgrades to dense neural vectors (RRF) when an OpenAI/OpenRouter/Gemini key is configured. Optional <code>runtime/python_worker/setup.sh</code> installs <b>Playwright Chromium</b> + <b>PDF/DOCX/XLSX</b> parsers.</td></tr>
<tr><td><b>46 Built-In Power Tools + Live MCP</b></td><td>Shared PTY/tmux terminals, live inter-agent <code>team_message</code>/<code>team_inbox</code>, <code>brain_semantic_search</code>, <code>heartbeat_configure</code>, atomic file patching &amp; checkpoints, Python/Node/Bash execution, web search, Playwright + Vision, cron, and <b>HTTP/STDIO MCP</b>.</td></tr>
<tr><td><b>Proactive Heartbeat Daemon + Live TUI + Telegram</b></td><td>24/7 <b>Proactive Heartbeat</b> (<code>main-brain/HEARTBEAT.md</code> — logs <code>HEARTBEAT_OK</code> silently and alerts only on real issues), background mission queue (persists across browser closes; pair with <code>systemd</code>/Docker for reboot persistence), ANSI TUI (<code>pandawa live</code>), and Telegram remote approval (<code>/approve</code>, <code>/auto</code>, <code>/reject</code>).</td></tr>
<tr><td><b>Hardened Security + Zero Hidden Guardrails</b></td><td>Random first-boot password, login rate-limiting, token revocation on password change, single-use WS tickets, encrypted DB secrets (<code>0600</code>), mandatory webhook secrets, cloud-metadata SSRF blocking, token budget caps, and configurable <b>Approval Gate</b> (<code>auto</code> / <code>approve_shell</code> / <code>approve_sensitive</code> / <code>approve_all</code>). See <a href="SECURITY.md">SECURITY.md</a>.</td></tr>
<tr><td><b>Commercial Brain Kits (<code>.pandawa.json</code>)</b></td><td>Package any Team + Layered Brains + <code>soul.md</code>/skills + Canvas wiring into a portable kit (providers, channels &amp; secrets are never exported) with an interactive <b>Preview Modal</b> before install.</td></tr>
</table>

---

## System Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                   Control Surfaces (Hardened Perimeter)                    │
│  Web Studio (Canvas · Mission · xterm PTY) · CLI TUI (`pandawa live`)      │
│  Direct Shell (`tmux attach`) · 2-Way Telegram (+ /approve) · Webhooks     │
│  (Same-Origin CORS · Login Rate Limit · 1-Time WS Tickets · Secret Vault)  │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│            Living Brain Vault & Progressive Context Compiler               │
│   [Main Brain] ──▶ [Team Brain] ──▶ [Personal / [[Wikilink]] Graph]        │
│   Core Auto-Load + Progressive Index + SQLite FTS5 + Hybrid Semantic RRF   │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│       Autonomous Team Engine (Programmatic Execute & Verify · ≤100 Steps)  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Yudhistira  │◀▶│     Bima     │◀▶│    Arjuna    │◀▶│Nakula/Sadewa │   │
│  │ Architect    │  │ Ops / PTY    │  │ Engineering  │  │ Research/QA  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         ▼                 ▼                 ▼                 ▼            │
│   Multi-AI Hub (OpenAI · Anthropic · Gemini · DeepSeek · Custom Base URL)  │
│   SSE Streaming · Vision · Semantic Compaction · Token Cap · Exit-Code QA  │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│    User Approval Gate & Hybrid TS + Python Body (46 Tools + Live MCP)      │
│  TS Core: Atomic File Locks · Team Chat · Checkpoints · SSRF Guard · MCP   │
│  Python Worker: Shared tmux/PTY · Playwright Chromium · PDF / DOCX / XLSX  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Install

### Linux, macOS, WSL2 (1-Line Installer)

```bash
curl -fsSL https://raw.githubusercontent.com/be-yourself-never-surrender/pandawa/main/scripts/install.sh | bash
# Optional: install isolated Python venv for Playwright Chromium + PDF/DOCX/XLSX parsing
bash ~/.pandawa/runtime/python_worker/setup.sh
```

### Docker Compose (Non-Root Container, Node 24 + Python 3 + tmux)

```bash
git clone https://github.com/be-yourself-never-surrender/pandawa.git
cd pandawa
docker compose up -d --build
# View auto-generated first-boot admin password:
docker logs pandawa
```

*(Note: To enable optional Playwright Chromium & PDF/DOCX/XLSX inside the container, run `docker exec -it pandawa bash runtime/python_worker/setup.sh`.)*

### Manual Source Build (Node.js ≥ 22.5 / Recommended v24 LTS)

```bash
git clone https://github.com/be-yourself-never-surrender/pandawa.git
cd pandawa
npm install && npm --prefix web install
npm run build
npm test
npm start
```

- By default, Pandawa binds safely to **`http://127.0.0.1:7777`** and prints a unique random first-boot password (also saved `0600` to `data/.initial_password`).
- For VPS access behind HTTPS, set `PANDAWA_HOST=0.0.0.0` (or keep `127.0.0.1` behind Caddy/Nginx on the same host) and supervise with `systemd` or Docker `restart: unless-stopped`.
- **Windows:** Native PowerShell works for Web Studio & API, while shared `tmux`/PTY terminals require **WSL2** or **Docker**.

---

## Terminal OS & CLI Quick Reference

```bash
pandawa start                     # Start Web Studio, API & Background Daemon
pandawa live                      # Interactive ANSI Live TUI (streaming + inline approvals)
pandawa live "Build & test API"   # Run a live mission straight from terminal
pandawa term list                 # List all active shared agent terminals (tmux)
pandawa term attach main          # Jump directly into a living agent terminal (`tmux attach`)
pandawa status                    # Inspect Brains, Teams, Agents, Terminals, Jobs & Tools
pandawa doctor                    # Verify Node, SQLite FTS5, tmux, Python Worker & Playwright
pandawa approval approve_shell    # Switch Approval Gate (auto | approve_shell | approve_sensitive | approve_all)
pandawa backup kit.json           # Export Team + Brains + Canvas into .pandawa.json kit
```

---

## Complete Tool Arsenal (46 Built-In Tools · 8 Toolpacks + Live MCP)

| Toolpack | Included Tools |
| --- | --- |
| **`terminal`** *(Shared PTY/tmux)* | `term_open`, `term_exec`, `term_send`, `term_read`, `term_list`, `term_close` |
| **`brain`** *(Living Vault & Semantic)* | `brain_search`, `brain_semantic_search`, `brain_list`, `brain_read`, `brain_write`, `remember_fact`, `learn_skill`, `session_search` |
| **`team`** *(Live Peer Collaboration)* | `blackboard_post`, `blackboard_read`, `consult_teammate`, `team_todo_manage`, `team_message`, `team_inbox` |
| **`workspace`** *(Atomic Engineering & Docs)* | `workspace_list`, `workspace_read`, `workspace_write`, `workspace_patch`, `workspace_grep`, `checkpoint_create`, `checkpoint_rollback`, `doc_read` (PDF/DOCX/XLSX), `vision_inspect` |
| **`shell`** *(Exec & Processes)* | `shell_exec`, `code_execute` (Python/Node/Bash), `process_start`, `process_list`, `process_logs`, `process_kill` |
| **`web`** *(Search & HTTP + SSRF Guard)* | `web_search` (DuckDuckGo + optional Tavily), `web_fetch`, `http_request` |
| **`browser`** *(Playwright + Vision)* | `browser_open`, `browser_interact` (click/fill/press/eval), `browser_screenshot` (auto-attaches to Vision LLM), `browser_extract` |
| **`automation`** *(Heartbeat & Ops)* | `heartbeat_configure`, `cron_create`, `cron_list`, `channel_notify` (Telegram / Discord / Webhook) |
| **`mcp`** *(Dynamic)* | Live **HTTP** & **Local STDIO** MCP auto-discovery (`mcp__<server>__<tool>`) |

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PANDAWA_PORT` | `7777` | HTTP & WebSocket server port |
| `PANDAWA_HOST` | `127.0.0.1` | Bind interface (`0.0.0.0` in Docker / systemd behind HTTPS) |
| `PANDAWA_DATA_DIR` | `./data` | Storage for `pandawa.db` (`0600`), `.vault.key` (`0600`), `brains/`, `workspace/` |
| `PANDAWA_DEFAULT_PASSWORD` | *(random 16-char)* | Optional override for first-boot admin password |
| `PANDAWA_CORS_ORIGINS` | *(same-origin)* | Comma-separated extra allowed CORS origins |
| `PANDAWA_TOKEN_TTL_SEC` | `172800` (48h) | Admin session JWT lifetime in seconds |
| `TAVILY_API_KEY` | *(optional)* | Upgrades `web_search` from DuckDuckGo to Tavily API |

---

## Testing & Security

Run the full automated security & engine test suite locally:

```bash
npm run build && npm test
```

See [SECURITY.md](SECURITY.md) for the complete security architecture and production deployment checklist.

## License

**MIT License** — clean-room codebase. Free to self-host, modify, white-label, and commercialize.

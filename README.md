<p align="center">
  <img src="assets/banner.jpg" alt="Pandawa OS — Living Agentic Team OS & Visual Control Plane" width="100%">
</p>

<h1 align="center">PANDAWA OS</h1>

<p align="center">
  <strong>Self-Hosted Agentic Team OS · Visual Control Plane (Brain Canvas) · Omnichannel (WhatsApp QR/Cloud, Telegram, Discord, Slack) · xterm.js PTY · Skill Installer</strong>
</p>

<p align="center">
  <a href="https://github.com/be-yourself-never-surrender/pandawa/actions"><img src="https://img.shields.io/github/actions/workflow/status/be-yourself-never-surrender/pandawa/ci.yml?style=for-the-badge&label=CI%20Build%20%26%20Tests" alt="CI Status"></a>
  <a href="https://github.com/be-yourself-never-surrender/pandawa/releases"><img src="https://img.shields.io/badge/Version-7.0.0-e5a00d?style=for-the-badge" alt="Version 7.0.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-10b981?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Runtime-Node.js%2022.5%2B%20%2F%2024%20%2B%20Python%203-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node 24 + Python">
  <img src="https://img.shields.io/badge/Channels-WhatsApp%20%7C%20Telegram%20%7C%20Discord-06b6d4?style=for-the-badge" alt="Omnichannel">
  <a href="SECURITY.md"><img src="https://img.shields.io/badge/Security-Hardened%20%7C%20Zero%20Mock-ef4444?style=for-the-badge" alt="Security"></a>
</p>

---

**Pandawa OS** is a clean-room, self-hosted **Agentic Team Operating System** built with a **Hybrid TypeScript + Python architecture** and an **Obsidian Instrument Visual Control Plane**.

- **Web UI = Pure Control Plane (Zero Web Chat Bloat):** Use the Web UI (`Command Center`, `Brain Canvas`, `Channels`, `Brain Files`, `AI Providers`, `Skills & Memory`, `Live Terminal`, `Automation & MCP`, `⌘K` Command Palette) to assemble agents, wire models/brains/channels visually, and monitor terminals — while chatting with your Pandawa teams daily from **WhatsApp (QR Baileys OR Official Meta Cloud API)**, **Telegram**, **Discord**, **Slack**, **Webhooks**, or CLI (`pandawa live`).
- **Minimal Clean-Slate Starter:** Fresh installs start lean (**5 clean nodes on Brain Canvas**, **2 starter agents**, **4 editable Brain files**) so you can customize immediately without deleting 20 boilerplate nodes — or spawn full multi-agent squads (`Pandawa Lima`, `Software`, `Growth`, `Research`) in 1 click.
- **Zero Mock · Zero Dry-Run · Hardened by Default:** Missing AI providers fail fast with HTTP `422` (never simulated responses). Unique random first-boot password, login rate-limiting (`429`), instant JWT revocation on password change, single-use 30s WebSocket tickets, same-origin CORS, mandatory webhook secrets, `AES-256-GCM` encryption for all provider/channel/MCP secrets, cloud-metadata SSRF blocking, and non-root Docker — with **zero hidden content censorship** (governed solely by your Approval Gate).

<table>
<tr><td><b>Visual Control Plane &amp; Channel Routing (Brain Canvas)</b></td><td>Wire <b>Channels</b> (WhatsApp / Telegram / Webhooks) → <b>Team Brains</b> → <b>Agents</b> → <b>AI Models</b> → <b>Files/Folders</b> &amp; <b>Toolpacks</b> visually. Saving a <code>Channel → Team/Agent</code> wire updates live bot routing instantly without restarting!</td></tr>
<tr><td><b>Smart Triage &amp; Programmatic Execute &amp; Verify (Up to 100 Steps)</b></td><td><code>execute</code> mode starts with Lead <b>Smart Triage</b> (<code>direct_reply</code> for casual chat without waking specialists, or selective delegation with <code>needsReview</code>) → Builders work under enforced locks in <b>per-team isolated workspaces</b> (<code>data/workspaces/&lt;teamId&gt;/</code>) → Real peer collaboration (<code>consult_teammate</code>, live mid-turn <code>team_message</code> with read receipts, Team Blackboard) → Programmatic exit-code <code>verifyCmd</code> gate &amp; auto-fix loop.</td></tr>
<tr><td><b>Omnichannel Messaging (WhatsApp QR + Cloud API + Telegram)</b></td><td>Choose either <b>WhatsApp QR (Baileys — free 2-way, live QR scanner right in Web UI)</b> OR <b>WhatsApp Official Meta Cloud API</b> (<code>GET/POST /api/webhooks/whatsapp/:id</code> with HMAC-SHA256 verification), plus <b>Telegram 2-way</b>, <b>Discord</b>, <b>Slack</b>, and <b>Webhooks</b> — delivering clean natural replies in chat (no noisy headers) while preserving full agent attribution in metadata &amp; <code>/status</code>, plus persistent threads (<code>/new</code>) and mobile approvals (<code>/approve</code>, <code>/auto</code>, <code>/reject</code>, <code>/term</code>).</td></tr>
<tr><td><b>Official API Keys + OpenAI Responses API &amp; Custom Gateways</b></td><td>Connect official keys (<b>OpenAI</b> Chat Completions or native <code>openai_responses</code> <code>/v1/responses</code>, <b>Anthropic</b>, <b>Gemini</b>, <b>DeepSeek</b>, <b>OpenRouter</b>), <b>Ollama</b>, or your own external proxy such as a <b>9Router / LiteLLM Gateway</b> preset — keeping Pandawa focused cleanly on Agentic Teaming.</td></tr>
<tr><td><b>Pandawa Skill Installer (GitHub / URL / .zip / Folder / CLI)</b></td><td>Install multi-file <code>SKILL.md</code> packages (preserving <code>scripts/</code> &amp; <code>references/</code>) from <b>GitHub repos/folders</b> (<code>owner/repo</code>), raw URLs, <code>.zip</code> packs, or local folders — with <b>pre-install preview &amp; static security scanning</b> (<code>CLEAN</code> / <code>REVIEW</code> / <code>CAUTION</code>) and 1-click uninstall.</td></tr>
<tr><td><b>Executable Layered Brain Vault (<code>[[wikilinks]]</code>)</b></td><td><code>Main Brain → Team Brain → Personal Brain</code> stored as plain Markdown with <code>[[wikilinks]]</code>, backlinks, SQLite FTS5, hybrid semantic search (offline TF-IDF + optional neural RRF), and bulk import for <b>Files, Obsidian Folders, <code>.zip</code>, PDF, DOCX, and XLSX</b>.</td></tr>
<tr><td><b>Real-Time xterm.js PTY Terminal (Linux / macOS / WSL2)</b></td><td>Interactive 60fps ANSI terminal inside Web Control Plane (<code>xterm.js</code> ↔ single-use WS ticket ↔ Python PTY ↔ team-scoped <code>tmux</code>) shared live with teammates in their team workspace, or attach via SSH (<code>pandawa term attach &lt;name&gt;</code>). <i>(Windows: run under WSL2 or Docker for PTY/tmux.)</i></td></tr>
<tr><td><b>46 Built-In Power Tools + Live MCP + Heartbeat Daemon</b></td><td>Team-scoped PTY/tmux terminals &amp; managed processes, genuine inter-agent <code>consult_teammate</code> &amp; <code>team_message</code>/<code>team_inbox</code> (with SQLite read receipts), <code>brain_semantic_search</code>, <code>heartbeat_configure</code> (24/7 daemon), atomic file patching &amp; checkpoints, Python/Node/Bash execution, web search, Playwright + Vision, cron, and <b>HTTP/STDIO MCP</b>.</td></tr>
<tr><td><b>Commercial Brain Kits (<code>.pandawa.json</code>)</b></td><td>Export any Team + Layered Brains + Canvas topology into a portable kit (providers, channels &amp; secrets are never exported) with a pre-install Preview Modal.</td></tr>
</table>

---

## System Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│            Messaging Channels (Daily Interaction · 2-Way Mobile)           │
│  WhatsApp QR (Baileys) · WhatsApp Meta Cloud API · Telegram Bot            │
│  Discord · Slack · Secret-Signed Webhooks · CLI TUI (`pandawa live`)       │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │  (Routed live via Visual Brain Canvas)
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│        Obsidian Instrument Web Control Plane (Hardened Perimeter)          │
│  Command Center · Brain Canvas · Channels Hub · Brain Files · Skill Hub    │
│  AI Providers · Live xterm PTY · Automation & MCP · Cmd+K Palette          │
│  (Same-Origin CORS · 429 Rate Limit · 1-Time WS Tickets · 0600 Vault)      │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│            Living Brain Vault & Progressive Context Compiler               │
│   [Main Brain] ──▶ [Team Brain] ──▶ [Personal / [[Wikilink]] Graph]        │
│   Core Auto-Load + Installed SKILL.md Packs + SQLite FTS5 + Semantic RRF   │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│       Autonomous Team Engine (Smart Triage -> Execute -> Verify · ≤100)    │
│  Per-Team Isolated Workspaces · Real Peer Consult & Team Messages          │
│  Official & Custom API Keys · OpenAI Responses (/v1/responses) · Vision    │
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
npm test && npm run test:web
npm start
```

- By default, Pandawa binds safely to **`http://127.0.0.1:7777`** and prints a unique random first-boot password (also saved `0600` to `data/.initial_password`).
- For VPS access behind HTTPS, set `PANDAWA_HOST=0.0.0.0` (or keep `127.0.0.1` behind Caddy/Nginx on the same host) and supervise with `systemd` or Docker `restart: unless-stopped`.
- **Windows:** Native PowerShell works for Web Control Plane & API, while shared `tmux`/PTY terminals require **WSL2** or **Docker**.

---

## CLI Quick Reference

```bash
pandawa start                         # Start Control Plane, API, Channels & Daemons (port 7777)
pandawa live [prompt]                 # Interactive ANSI Terminal TUI with streaming & inline approvals
pandawa skill install owner/repo      # Preview, security-scan & install SKILL.md packs (GitHub/URL/zip/local)
pandawa skill list                    # List installed skills across Main Brain & Team Brains
pandawa skill remove <slug>           # Uninstall a skill package cleanly
pandawa term list                     # List active shared agent terminals (tmux)
pandawa term attach main              # Jump directly into a living agent terminal (`tmux attach`)
pandawa status                        # Inspect Brains, Teams, Agents, Providers, Terminals & Jobs
pandawa doctor                        # Verify Node, SQLite FTS5, tmux, Python Worker & Playwright
pandawa approval approve_shell        # Set Approval Gate (auto | approve_shell | approve_sensitive | approve_all)
pandawa backup kit.json               # Export Team + Brains + Canvas into portable .pandawa.json kit
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
| **`automation`** *(Heartbeat & Ops)* | `heartbeat_configure`, `cron_create`, `cron_list`, `channel_notify` (WhatsApp / Telegram / Discord / Slack / Webhook) |
| **`mcp`** *(Dynamic)* | Live **HTTP** & **Local STDIO** MCP auto-discovery (`mcp__<server>__<tool>`) |

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PANDAWA_PORT` | `7777` | HTTP & WebSocket server port |
| `PANDAWA_HOST` | `127.0.0.1` | Bind interface (`0.0.0.0` in Docker / systemd behind HTTPS) |
| `PANDAWA_DATA_DIR` | `./data` | Storage for `pandawa.db` (`0600`), `.vault.key` (`0600`), `whatsapp_sessions/` (`0700`), `brains/`, per-team `workspaces/` & `workspace/` |
| `PANDAWA_DEFAULT_PASSWORD` | *(random 16-char)* | Optional override for first-boot admin password |
| `PANDAWA_CORS_ORIGINS` | *(same-origin)* | Comma-separated extra allowed CORS origins |
| `PANDAWA_TOKEN_TTL_SEC` | `172800` (48h) | Admin session JWT lifetime in seconds |
| `TAVILY_API_KEY` | *(optional)* | Upgrades `web_search` from DuckDuckGo to Tavily API |

---

## Testing & Security

```bash
npm run build && npm test && npm run test:web
```

Runs 22 server unit/E2E tests (auth, SSRF guard, file locks, Smart Triage, OpenAI `/v1/responses`, multi-team workspace isolation, inter-agent collaboration, Telegram & WhatsApp channels) plus 5 Web Control Plane utility tests.

See [SECURITY.md](SECURITY.md) for the full security architecture and production deployment checklist.

## License

**MIT License** — clean-room codebase. Free to self-host, modify, white-label, and commercialize.

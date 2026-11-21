# Pandawa v3.0 — Visual Agentic Team & Layered Brain Platform

**Pandawa** is a clean-room, commercial-ready **Agentic Team** platform built from scratch in TypeScript (Node.js 24 + native SQLite FTS5 + React + React Flow). Inspired by the Javanese legend of the **Pandawa Lima** (Yudhistira, Bima, Arjuna, Nakula, Sadewa), Pandawa connects diverse specialist AI models into one cohesive peer team through a visual n8n-style **Brain & Team Topology Canvas**.

---

## Why Pandawa Is Different

- **True Peer Agentic Team (*Musyawarah & Eksekusi*)**: Specialists share a **Main Brain**, **Team Brain**, and live **Team Blackboard** — collaborating horizontally with peer cross-review instead of top-down orchestrator trees or stateless swarms.
- **Built for Freedom (Approval Gate, Zero Hidden Guardrails)**: Pandawa imposes no opinionated content/command censorship. You choose whether tools execute immediately (**Auto / Full Freedom**) or pause for a live popup **Approval Gate** (**Approve / Auto All / Reject**).
- **100% Clean-Room Commercial-Ready Codebase**: Zero external agent boilerplate, ultra-lightweight (~30 MB RAM), encrypted API vault, and Docker-ready.

---

## Key Features (v3.0)

1. **n8n-Style Visual Brain & Team Canvas (`@xyflow/react`)**
   - Drag, drop, and wire **Main Brains**, **Team Brains**, **Agents**, **AI Models**, **Files / Folders (`soul.md`, etc.)**, and **Toolpacks**.
   - **Live Active-Node Pulse**: Agent nodes glow and pulse in real time on the canvas while thinking or calling tools.
   - **1-Click Team Kits + Team-Clustered Smart Auto-Layout**: Spawn pre-wired squads (*Software Engineering*, *Growth & Content*, *Deep Research*) side-by-side with zero overlap, or remove entire squads cleanly in 1 click.
2. **Real-Time Token Streaming, Stop Control, Auto-Retry & Fallback**
   - True SSE streaming with **Markdown + Copy Code** rendering across OpenAI-compatible, Anthropic Messages (with ephemeral prompt caching), and Google Gemini APIs.
   - Live **Stop / Abort Mission** button, exponential backoff retry on `429`/`5xx`, automatic backup provider fallback, and WebSocket auto-reconnect.
3. **Dynamic Peer Consultation & Autonomous Web Search**
   - Teammates can directly consult each other mid-task via `consult_teammate` and research live sources via `web_search` + `web_fetch`.
4. **Commercial Brain Kit Marketplace Format (`.pandawa.json`)**
   - Export any Team + layered Brains + `soul.md`/skills + Canvas topology with **API keys stripped**, and inspect packages via the built-in **Brain Kit Preview Modal** before installing.
5. **Multi-AI Provider Hub + AES-256-GCM Vault + Token Analytics**
   - Bind different Official APIs or Custom Base URLs to each teammate, encrypted at rest with **AES-256-GCM**, with per-agent & per-model token analytics.
6. **Live MCP Client, 2-Way Telegram Bot Gateway, Webhooks & Cron**
   - Auto-discover and invoke tools from HTTP/SSE MCP servers, run live 2-way Telegram polling bots, Discord/HTTP webhooks, and scheduled Cron missions.
7. **Built-In Web Auth, Approval Gate & Auto-HTTPS (Caddy) Generator**
   - Salted `scrypt` login (default password `11111111`), live floating **Approval Overlay** (zero hidden guardrails), and ready-to-run Caddy HTTPS setup.

---

## Quick Start

### Option 1: Docker Compose (Recommended)
```bash
docker compose up -d --build
```

### Option 2: Node.js 24+
```bash
npm install
npm --prefix web install
npm run build
PANDAWA_PORT=7777 npm start
```

Open `http://localhost:7777` (or `http://<VPS_IP>:7777`), log in with default password `11111111`, and change your password under **Settings & VPS**.

---

## License

MIT — 100% original clean-room codebase ready for commercial use.

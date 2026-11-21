# Pandawa v2.0 — Visual Agentic Team & Layered Brain Platform

**Pandawa** is a clean-room, commercial-ready **Agentic Team** platform built from scratch in TypeScript (Node.js 24 + native SQLite FTS5 + React + React Flow). Inspired by the Javanese legend of the **Pandawa Lima** (Yudhistira, Bima, Arjuna, Nakula, Sadewa), Pandawa connects diverse specialist AI models into one cohesive peer team through a visual n8n-style **Brain & Team Topology Canvas**.

---

## Why Pandawa Is Different

- **True Peer Agentic Team (*Musyawarah & Eksekusi*)**: Specialists share a **Main Brain**, **Team Brain**, and live **Team Blackboard** — collaborating horizontally with peer cross-review instead of top-down orchestrator trees or stateless swarms.
- **Built for Freedom (Approval Gate, Zero Hidden Guardrails)**: Pandawa imposes no opinionated content/command censorship. You choose whether tools execute immediately (**Auto / Full Freedom**) or pause for a live popup **Approval Gate** (**Approve / Auto All / Reject**).
- **100% Clean-Room Commercial-Ready Codebase**: Zero external agent boilerplate, ultra-lightweight (~30 MB RAM), encrypted API vault, and Docker-ready.

---

## Key Features (v2.0)

1. **n8n-Style Visual Brain & Team Canvas (`@xyflow/react`)**
   - Drag, drop, and wire **Main Brains**, **Team Brains**, **Agents**, **AI Models**, **Files / Folders (`soul.md`, etc.)**, and **Toolpacks**.
   - **Live Active-Node Pulse**: Agent nodes glow and pulse in real time on the canvas while thinking or calling tools.
   - **1-Click Team Kits**: Spawn complete pre-wired squads (*Software Engineering Squad*, *Growth & Content Squad*, *Deep Research & Alpha Squad*) directly onto the canvas.
2. **Real-Time Token Streaming + Prompt Caching**
   - True SSE streaming across OpenAI-compatible, Anthropic Messages (with ephemeral prompt caching), and Google Gemini APIs.
3. **Multi-AI Provider Hub + AES-256-GCM Vault**
   - Bind different Official APIs or Custom Base URLs to each teammate by purpose.
   - All provider API keys are encrypted at rest with **AES-256-GCM**.
4. **Live MCP Client (Auto-Discovery & Execution)**
   - Connect any HTTP/SSE MCP server, click **Discover Tools**, and every tool becomes immediately callable by Pandawa agents.
5. **Live 2-Way Telegram Bot Gateway + Webhooks + Discord + Cron**
   - Built-in 2-way Telegram long-polling bot wired directly to your Pandawa Teams or Agents, plus Discord webhooks, inbound/outbound webhooks, and a Cron Scheduler.
6. **Brain Files & Folders Manager + Self-Learning Skills**
   - Full file/folder explorer & Markdown editor with SQLite **FTS5** instant search, 1-click **+ Brain Kit**, and reusable `SKILL.md` learning loop.
7. **Built-In Web Auth & Approval Control**
   - Salted `scrypt` login (default password `11111111`, changeable inside Settings) + live floating Approval Overlay.

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

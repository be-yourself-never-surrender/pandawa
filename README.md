# Pandawa — Visual Agentic Team & Layered Brain Platform

**Pandawa** is a clean-room, commercial-ready **Agentic Team** platform built from scratch in TypeScript (Node.js 24 + native SQLite FTS5 + React + React Flow). Inspired by the Javanese legend of the **Pandawa Lima** (Yudhistira, Bima, Arjuna, Nakula, Sadewa), Pandawa connects diverse specialist AI models into one cohesive peer team through a visual n8n-style **Brain & Team Topology Canvas**.

---

## Why Pandawa Is Different from Swarms, Sub-Agents, and Orchestrators

- **No Rigid Top-Down Orchestrator**: Agents are not blind workers taking isolated one-shot commands.
- **No Stateless Swarm Handoffs**: Every teammate retains persistent identity, layered Brain memory, and mutual visibility.
- **True Peer Agentic Team (*Musyawarah & Eksekusi*)**:
  - **Main Brain** — Global organizational identity (`soul.md`), universal rules (`rules.md`), shared skills, and long-term memory.
  - **Group / Team Brain** — Shared team charter (`team.md`), shared memory (`memory.md`), team SOPs, and a live **Team Blackboard** where peers post proposals, findings, critiques, and decisions.
  - **Personal & Custom Knowledge Folders** — Mount any file (`soul.md`, `playbook.md`, etc.) or complete folder directly onto any Brain or Agent on the visual canvas.
  - **Peer Deliberation & Cross-Review** — Specialists analyze missions in parallel using their own models and brains, cross-critique each other on the Team Blackboard, and synthesize unified team consensus.

---

## Key Features

1. **n8n-Style Visual Brain & Team Canvas (`@xyflow/react`)**
   - Drag, drop, and wire **Main Brains**, **Team Brains**, **Agents**, **AI Models**, **Files / Folders**, and **Toolpacks**.
   - Live connection edges (`brain_link`, `model_binding`, `knowledge_mount`, `peer_collab`, `tool_grant`) with configurable permissions (`read`, `read_write`, `sync`).
   - Built-in **Compiled Brain Inspector** to preview the exact prompt assembled from the graph for any Agent.
2. **Multi-AI Provider Hub (Official APIs + Custom Base URLs)**
   - Run different models for different roles in the same team (e.g., Anthropic for Strategy, OpenAI for Execution, DeepSeek for Coding, Gemini for Research, OpenRouter / Ollama / Custom Base URL for Review).
   - Supports OpenAI-compatible, Anthropic Messages, and Google Gemini native protocols + live connection testing.
3. **Brain Files & Folders Manager (`soul.md`, `rules.md`, `memory.md`, `skills/`)**
   - Full file/folder explorer & live Markdown editor with SQLite **FTS5** instant full-text search.
   - 1-click **+ Brain Kit** folder creation and 1-click **Pin to Canvas**.
4. **Self-Learning Skills & Persistent Episodic Memory**
   - Agents can distill repeatable workflows into reusable `SKILL.md` files and store facts/lessons into Main Brain or Team Brain.
5. **Automation, Channels & MCP**
   - Built-in Cron Scheduler, Inbound/Outbound Webhooks, Telegram & Discord Bridges, and MCP Server Registry.
6. **Built-In Web Authentication & VPS Monitor**
   - Salted `scrypt` password protection (default password: `11111111`), instant password change inside Settings UI, live VPS memory/uptime/token usage dashboard, and audit logs.

---

## Quick Start

```bash
# Install backend + frontend dependencies
npm install
npm --prefix web install

# Build backend & web UI
npm run build

# Start Pandawa (default port 7777)
PANDAWA_PORT=7777 npm start
```

Open `http://localhost:7777` (or `http://<VPS_IP>:7777`) and sign in with default password `11111111`, then change your password in **Settings & VPS**.

---

## License

MIT — 100% original clean-room codebase ready for commercial use.

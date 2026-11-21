# Security Policy — Pandawa OS

## Supported Versions

Security fixes are applied to the latest `7.x` release on `main`.

## Built-In Security Controls (v7.0+)

Pandawa OS is designed for **self-hosted freedom** (zero hidden content censorship) while enforcing strong perimeter and credential hygiene by default:

1. **Unique First-Boot Admin Secret:** Fresh installs generate a random 16-character admin password (saved `0600` to `data/.initial_password` and deleted automatically upon password change) unless `PANDAWA_DEFAULT_PASSWORD` is explicitly set.
2. **Per-IP Login Rate Limiting & Lockout:** Progressive backoff (`429 Too Many Requests` + `Retry-After`) after 5 failed login attempts per IP.
3. **Instant Session Revocation:** Changing the admin password rotates both the JWT signing secret and `token_version`, invalidating all prior tokens immediately.
4. **One-Time WebSocket Tickets:** REST routes strictly require `Authorization: Bearer <token>`. WebSockets (`/ws`, `/ws/terminal`) authenticate via single-use 30-second tickets (`POST /api/auth/ws-ticket`) rather than exposing long-lived JWTs in URLs.
5. **Same-Origin + Allowlist CORS:** Cross-origin requests from arbitrary third-party websites are blocked (`403`); configure `PANDAWA_CORS_ORIGINS` if running behind a separate frontend domain.
6. **Encrypted Secret Vault (`AES-256-GCM`):** Provider API keys, Telegram bot tokens, Discord/Webhook URLs & secrets, and MCP connector headers are encrypted at rest with a `0600` vault key, and `pandawa.db` is restricted to `0600` on POSIX hosts.
7. **Mandatory Webhook Secrets:** Every webhook channel enforces a constant-time (`crypto.timingSafeEqual`) secret check and per-IP rate limiting.
8. **SSRF Protection:** Outbound HTTP and Playwright browser tools always block cloud instance metadata endpoints (`169.254.169.254`, `metadata.google.internal`, etc.), with an optional strict private-LAN block toggle in Settings.
9. **User-Controlled Approval Gate & Token Budget Cap:** Default mode is `approve_shell`, `approve_sensitive` covers shell/writes/HTTP/browser/MCP, and `max_tokens_per_mission` caps runaway API usage.
10. **Non-Root Container Execution:** The official `Dockerfile` runs as an unprivileged `pandawa` user.

## Production Deployment Checklist

- Never expose raw port `7777` directly to the public internet without a reverse proxy (Caddy/Nginx with HTTPS) or VPN (Tailscale/WireGuard).
- Keep `PANDAWA_HOST=127.0.0.1` when running behind a local reverse proxy on the same host.
- Do **not** run Pandawa as `root` on a host containing sensitive credentials, crypto wallets, or unrelated production services.
- Keep Approval Mode at `approve_shell` or `approve_sensitive` unless running inside a disposable sandbox/container.

## Reporting a Vulnerability

Please open a private GitHub Security Advisory on `be-yourself-never-surrender/pandawa` (or report via repository maintainers) with reproduction steps and affected commit SHA.

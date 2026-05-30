# Heimdall

OAuth 2.1 PKCE gateway for the Bifrost MCP fleet. Single public hostname (`heimdall.exe.pm`) that handles both the OAuth handshake and the per-MCP resource-server proxy via path-based routing. Sits in front of every internal `*-mcp` container and exposes them to remote clients (Claude Desktop, browser-based MCP clients) over HTTPS with a spec-compliant OAuth 2.1 + PKCE handshake.

Named after the Norse watchman who guards the Bifrost bridge — same job here.

## What it does

Single container, single hostname, dual role:

| Role | Path | Function |
|---|---|---|
| **Authorization Server** | `https://heimdall.exe.pm/` | OAuth 2.1 AS (RFC 8414 metadata, DCR per RFC 7591, `/authorize`, `/token`, PKCE S256). Delegates user-auth to GitHub OAuth and enforces a login allowlist. Mints short-lived JWT access tokens bound to a specific resource. |
| **Resource-server proxy** | `https://heimdall.exe.pm/<slug>/mcp` | RFC 9728 metadata at `/.well-known/oauth-protected-resource/<slug>`, `/<slug>/mcp` endpoint that validates the bearer JWT (`aud` must be `https://heimdall.exe.pm/<slug>`) and proxies to `http://<slug>:8080/mcp` on the Bifrost network. |

## Why

- **Claude Desktop custom connectors** support only authless or OAuth 2.1 — no bearer-token-paste, no `CF-Access-Client-Id/Secret` header. Plain Cloudflare Access browser SSO **breaks the connector handshake**.
- **MCPs are personal/CRM data and container control** — authless is unacceptable.
- → Need a real OAuth 2.1 AS in front, delegating user-auth to an IdP we already use (GitHub).
- **Scales to N MCPs** with no new container, no new GitHub OAuth App, no new DNS, no new tunnel rule — just one entry in `config.yml`.

## Architecture

```
Claude Desktop (or any OAuth 2.1 MCP client)
        │
        │ HTTPS + Streamable HTTP + OAuth 2.1 PKCE
        ▼
┌──────────────────────────────────────────────────┐
│  Cloudflare Tunnel  (existing, on bridge network) │
│  heimdall.exe.pm  →  http://192.168.0.20:6115     │
└──────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────┐
│  heimdall  (Bifrost + port 6115)                  │
│   ├─ /authorize, /token, /register, ...           │
│   ├─ /cos-mcp/mcp       → proxy to cos-mcp        │
│   ├─ /kanban-mcp/mcp    → proxy to kanban-mcp     │
│   └─ /<future>/mcp                                │
└──────────────────────────────────────────────────┘
        │  (Bifrost DNS)
        ▼
┌──────────────────────────────────────────────────┐
│  cos-mcp:8080/mcp     ◀─ existing                 │
│  kanban-mcp:8080/mcp  ◀─ existing                 │
└──────────────────────────────────────────────────┘
```

## OAuth flow (for the curious)

1. Claude Desktop hits `https://heimdall.exe.pm/cos-mcp/mcp` with no token.
2. Heimdall returns `401 Bearer resource_metadata="https://heimdall.exe.pm/.well-known/oauth-protected-resource/cos-mcp"`.
3. Claude reads that metadata → `authorization_servers: ["https://heimdall.exe.pm"]`, `resource: "https://heimdall.exe.pm/cos-mcp"`.
4. Claude reads `https://heimdall.exe.pm/.well-known/oauth-authorization-server` → AS endpoints.
5. Claude POSTs `/register` (DCR) → gets a `client_id` (public client, no secret, PKCE required).
6. Claude opens browser to `/authorize?response_type=code&client_id=...&code_challenge=...&code_challenge_method=S256&resource=https://heimdall.exe.pm/cos-mcp&state=...`.
7. Heimdall stashes the PKCE challenge + audience + redirect, redirects browser to GitHub OAuth.
8. User signs in with GitHub. GitHub redirects to `https://heimdall.exe.pm/oauth/github/callback`.
9. Heimdall verifies the GitHub login is in `github.login_allowlist`. Mints an auth code, redirects browser back to Claude.
10. Claude POSTs `/token` with `code` + `code_verifier`. Heimdall validates SHA-256(verifier) == challenge.
11. Heimdall mints a JWT with `aud=https://heimdall.exe.pm/cos-mcp`, `iss=https://heimdall.exe.pm`, `sub=<github-login>`, 15-min TTL.
12. Claude calls `https://heimdall.exe.pm/cos-mcp/mcp` with `Authorization: Bearer <JWT>`. Heimdall validates audience + signature, strips the header, proxies to `http://cos-mcp:8080/mcp`.

No refresh tokens (yet). Re-auth on expiry.

## Configuration

`config.example.yml` is **baked into the image** at `/etc/heimdall/config.yml`. Edit it and re-publish to change which MCPs are exposed, or mount a custom file over it.

Secrets come from env vars only:

| Env var | Purpose |
|---|---|
| `GITHUB_CLIENT_ID` | The heimdall GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | The heimdall GitHub OAuth App client secret |
| `JWT_SECRET` | HS256 signing key. Generate with `openssl rand -hex 48`. |
| `CONFIG_PATH` | Override config path. Default `/etc/heimdall/config.yml`. |
| `PORT` / `HOST` | Bind address. Default `0.0.0.0:8080`. |

## Adding a new MCP

1. Add an entry to `config.example.yml` under `mcps:` keyed by the path slug (lowercase, `[a-z0-9-]+`):
   ```yaml
   mcps:
     muninn-mcp:
       upstream: http://muninn-mcp:8080
       description: "Memory store (read-only)"
   ```
   Reserved slugs: `health`, `authorize`, `token`, `register`, `oauth`, `well-known`.
2. Commit + push. Watchtower picks up the new image within 5 min.
3. Make sure the MCP container is on the `bifrost` network so heimdall can DNS-resolve it.
4. Add the connector in Claude Desktop: `https://heimdall.exe.pm/muninn-mcp/mcp`.

No new DNS, no new tunnel rule, no new Cloudflare Access bypass — one hostname covers them all.

## First-time deployment

See `SETUP.md` for the full step-by-step (GitHub OAuth App registration, Cloudflare DNS + Tunnel ingress, Portainer stack, Claude Desktop connector setup).

## Security notes

- **Default-deny:** any slug not listed in `config.mcps` returns 404.
- **Allowlist:** `github.login_allowlist` is the only thing standing between the public internet and your MCPs. Keep it tight.
- **Audience binding:** a token minted for `cos-mcp` cannot be used against `kanban-mcp` (different `aud` claim).
- **Short TTL:** tokens expire after 15 min. No refresh tokens.
- **No upstream credential leak:** the `Authorization` header is stripped before the proxy hop.
- **`portainer-mcp` is deliberately NOT in the config** — too dangerous to put behind a remote connector today. Manage containers from Claude Code instead.

## Status

Phase 1 — exposes `cos-mcp` and `kanban-mcp` only. Both forced read-only (`KANBAN_WRITE_ENABLED=false` in kanban-mcp stack). Writes will be re-enabled per MCP once the connector flow is verified end-to-end.

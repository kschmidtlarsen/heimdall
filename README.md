# Heimdall

OAuth 2.1 (PKCE) gateway for the Bifrost MCP fleet — a combined **Authorization Server** and per-MCP **resource-server proxy** that lets remote MCP clients (e.g. Claude Desktop) authenticate against internal MCP containers with GitHub-backed login.

Named after the Norse watchman who guards the Bifrost bridge — same job here.

## Overview

Internal MCP servers on the Yggdrasil stack live on the private `bifrost` Docker network and speak plain HTTP with no auth. Heimdall is the single public door in front of them, on one hostname (`heimdall.exe.pm`) with path-based routing. It:

- Implements a minimal **OAuth 2.1 Authorization Server** with **Dynamic Client Registration** (RFC 7591), **PKCE** (S256 only), and **RFC 8414 / RFC 9728** discovery metadata.
- Delegates the actual human login to **GitHub** and gates access with a **login allowlist**.
- Mints short-lived **HS256 JWT access tokens** that are **audience-bound** to a specific MCP.
- Acts as a **reverse proxy**: once a request to `/<slug>/mcp` presents a valid, correctly-audienced token, it forwards the raw MCP traffic to the upstream container and strips its own `Authorization` header so the MCP never sees the JWT.

This is what makes path-based URLs like `https://heimdall.exe.pm/cos-mcp/mcp` reachable from Claude Desktop while the underlying `cos-mcp` container stays private on Bifrost. It scales to N MCPs with no new container, GitHub OAuth App, DNS record, or tunnel rule — just one entry in `config.yml`.

## Tech stack

- **Runtime**: Node.js 22 (ESM), TypeScript (compiled to `dist/` via `tsc`)
- **HTTP**: Express 4
- **JWT**: [`jose`](https://github.com/panva/jose) (HS256, `at+jwt` typ)
- **Config**: YAML (`yaml`), loaded from disk at startup
- **State**: in-memory (`Map`) — no database
- **Container**: multi-stage Node 22 Alpine image, published to GHCR

## Architecture

Three source layers, wired together in `src/index.ts`:

1. **Authorization Server** (`src/auth-server.ts`) — mounted at the root. Handles discovery, client registration, the `/authorize` → GitHub hop, the GitHub callback, and `/token`.
2. **Resource Server / proxy** (`src/proxy.ts`) — serves per-slug protected-resource metadata and proxies authenticated `/<slug>/mcp` traffic upstream.
3. **Supporting modules** — `config.ts` (YAML load + validation, slug/resource helpers), `github.ts` (GitHub OAuth calls), `jwt.ts` (mint/verify), `store.ts` (in-memory clients, pending flows, auth codes).

### Request path

```
Claude Desktop (or any OAuth 2.1 MCP client)
        │  HTTPS + Streamable HTTP + OAuth 2.1 PKCE
        ▼
  Cloudflare Tunnel  (on bridge network)
  heimdall.exe.pm  →  http://192.168.0.20:6115
        │
        ▼
  heimdall  (on bifrost + host port 6115)
   ├─ /authorize, /token, /register, /.well-known/...
   ├─ /cos-mcp/mcp     → proxy to http://cos-mcp:8080/mcp
   ├─ /kanban-mcp/mcp  → proxy to http://kanban-mcp:8080/mcp
   └─ /muninn/mcp      → proxy to http://muninn-mcp:8080/mcp
        │  (Bifrost DNS)
        ▼
  upstream MCP containers  (private, no auth)
```

### OAuth flow

1. Client hits `/<slug>/mcp` with no token → `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/<slug>"`.
2. Client reads that RS metadata → learns the resource id and authorization server.
3. Client reads `/.well-known/oauth-authorization-server` → AS endpoints.
4. Client `POST /register` (DCR) → gets a public `client_id` (no secret; PKCE required).
5. Client opens `/authorize?response_type=code&client_id=…&code_challenge=…&code_challenge_method=S256&resource=…&state=…`.
6. Heimdall stashes the PKCE challenge + audience + redirect and redirects the browser to GitHub OAuth.
7. User signs in with GitHub; GitHub redirects to `/oauth/github/callback`.
8. Heimdall checks the login against `github.login_allowlist`, mints an auth code, redirects back to the client.
9. Client `POST /token` with `code` + `code_verifier`; Heimdall verifies `SHA-256(verifier) == challenge`.
10. Heimdall mints a JWT (`iss`, `aud=${issuer}/<slug>`, `sub=<github-login>`, 15-min TTL).
11. Client calls `/<slug>/mcp` with `Authorization: Bearer <JWT>`; Heimdall validates audience/issuer/signature, strips the header, and proxies upstream.

No refresh tokens — clients re-auth on expiry.

### Endpoints

**Authorization Server**

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 AS metadata (issuer, endpoints, PKCE S256, `token_endpoint_auth_methods=none`) |
| `POST` | `/register` | Dynamic Client Registration (public clients only; requires `redirect_uris`) |
| `GET` | `/authorize` | Starts PKCE flow, validates client/redirect/resource, redirects to GitHub |
| `GET` | `/oauth/github/callback` | GitHub OAuth callback; enforces allowlist, mints authorization code |
| `POST` | `/token` | Exchanges `authorization_code` + `code_verifier` for an audience-bound JWT |

**Resource Server**

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/.well-known/oauth-protected-resource/:slug` | RFC 9728 protected-resource metadata for one MCP |
| `ALL` | `/:slug/mcp` | Verifies Bearer JWT (aud = `${issuer}/${slug}`), proxies to the upstream MCP; `401` with `WWW-Authenticate` when unauthenticated |

**Health**

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness (`{status:"ok"}`) — used by the Docker healthcheck |
| `GET` | `/api/health` | Reports the running build commit for Yggdrasil's deploy-lag monitor |

### Security notes

- **Default-deny** — any slug not in `config.mcps` returns `404`.
- **PKCE S256 is mandatory** — `/authorize` rejects requests without a valid S256 challenge; `/token` recomputes the challenge from the verifier and rejects a mismatch.
- **Tokens are audience-bound** — a token minted for one slug cannot be replayed against another; the proxy checks `aud`, `iss`, and `exp` on every call.
- **Allowlist gate** — only GitHub logins in `github.login_allowlist` are issued authorization codes.
- **Short lifetimes** — access tokens default to 15 min; pending flows expire after 5 min and auth codes after 1 min (swept every 60 s).
- **Slug hardening** — slugs must match `^[a-z0-9][a-z0-9-]*$` and may not collide with reserved paths (`health`, `authorize`, `token`, `register`, `oauth`, `.well-known`).
- The upstream MCP never receives Heimdall's `Authorization` header (stripped in the proxy).

## Getting started

### Prerequisites

- Node.js 22+
- A GitHub OAuth App (for `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`), callback URL set to `<issuer>/oauth/github/callback`
- A `config.yml` (copy `config.example.yml`)

### Local run

```bash
npm install

export CONFIG_PATH=./config.example.yml
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export JWT_SECRET=$(openssl rand -hex 48)

# Dev (watch mode via tsx)
npm run dev

# or build + run the compiled output
npm run build
npm start
```

The server listens on `HOST:PORT` (default `0.0.0.0:8080`).

## Configuration

### Environment variables

| Name | Purpose | Required |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID | Yes |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret | Yes |
| `JWT_SECRET` | HMAC secret for signing/verifying access tokens (64+ random hex chars) | Yes |
| `CONFIG_PATH` | Path to the YAML config file (default `/etc/heimdall/config.yml`) | No |
| `PORT` | Listen port (default `8080`) | No |
| `HOST` | Listen host (default `0.0.0.0`) | No |
| `BUILD_COMMIT` | Build commit surfaced at `/api/health` (set by CI) | No |

### `config.yml`

Non-secret settings live in YAML (never put secrets here). See `config.example.yml`:

```yaml
issuer: https://heimdall.exe.pm

github:
  login_allowlist:
    - kschmidtlarsen

jwt:
  ttl_seconds: 900   # access-token lifetime (15 min)

mcps:
  cos-mcp:
    upstream: http://cos-mcp:8080
    description: "Chief of Staff CRM (read-only)"
  kanban-mcp:
    upstream: http://kanban-mcp:8080
    description: "Kanban board (currently read-only)"
  muninn:
    upstream: http://muninn-mcp:8080
    description: "Muninn — personality, preferences, goals, calendar (read-only)"
```

For a slug `cos-mcp` with issuer `https://heimdall.exe.pm`:

- Resource identifier: `https://heimdall.exe.pm/cos-mcp`
- RS metadata: `https://heimdall.exe.pm/.well-known/oauth-protected-resource/cos-mcp`
- MCP endpoint clients connect to: `https://heimdall.exe.pm/cos-mcp/mcp`

Config is validated at startup: the issuer must be `https://`, each `upstream` must be `http://`, at least one MCP is required, and slugs are checked against the pattern and reserved list.

### Adding a new MCP

1. Add an entry under `mcps:` in `config.yml`, keyed by the path slug.
2. Ensure the target container is on the `bifrost` network so Heimdall can DNS-resolve it.
3. Commit, push, and republish the image (Watchtower redeploys).
4. Add the connector in the client: `https://heimdall.exe.pm/<slug>/mcp`.

## Project structure

```
src/
  index.ts        Express app wiring: CORS, raw-body capture for /*/mcp, health, routers
  auth-server.ts  OAuth 2.1 AS: metadata, /register, /authorize, GitHub callback, /token
  proxy.ts        RS metadata + authenticated reverse proxy to upstream MCPs
  config.ts       YAML load + validation, resourceUrl / slugFromResource helpers
  github.ts       GitHub OAuth: authorize URL, code exchange, /user fetch
  jwt.ts          Mint / verify HS256 access tokens (jose)
  store.ts        In-memory clients, pending flows, and auth codes (with TTL sweep)
config.example.yml       Example config, baked into the image at /etc/heimdall/config.yml
Dockerfile               Multi-stage Node 22 Alpine build
docker-compose.prod.yml  Production stack definition
SETUP.md                 First-time deployment guide (GitHub OAuth App, DNS/Tunnel, connector)
.github/workflows/docker-build.yml   CI: build & push image to GHCR
```

## Deployment

Yggdrasil auto-deploy flow:

1. `git push` to `main`.
2. GitHub Actions (`.github/workflows/docker-build.yml`) builds the image and pushes `ghcr.io/kschmidtlarsen/heimdall:latest` (and a `:${sha}` tag), injecting `BUILD_COMMIT` as a build arg. Doc-only changes (`*.md`, `.gitignore`) are skipped.
3. Watchtower (label `com.centurylinklabs.watchtower.enable=true`) picks up the new image and redeploys.

Runtime facts (from `docker-compose.prod.yml`):

- **Container**: `heimdall`
- **Port**: host `6115` → container `8080`
- **Networks**: joins the external `bifrost` network to reach MCP containers by DNS; the host port binding lets the Cloudflare Tunnel (on `bridge`) reach it via `192.168.0.20:6115`
- **Domain**: `https://heimdall.exe.pm` (the configured issuer)
- **Portainer stack ID**: 90
- **Required stack env vars**: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET`
- **Resource limits**: 0.25 CPU / 192 MB

To change which MCPs are exposed, edit `config.yml` (baked into the image, or mount a custom file at `/etc/heimdall/config.yml`) and republish. See `SETUP.md` for the full first-time deployment walkthrough.

## Related services

- **Bifrost MCP fleet** — the upstream MCP containers Heimdall fronts (e.g. `cos-mcp`, `kanban-mcp`, `muninn-mcp`).
- **Yggdrasil dashboard** — consumes `/api/health` for deploy-lag monitoring.
- Part of the broader Yggdrasil stack; other apps in the ecosystem share the [Graphite Iris design system](https://design.exe.pm).

## License

MIT

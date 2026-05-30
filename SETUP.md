# Heimdall — First-time setup

Step-by-step to bring heimdall online and connect Claude Desktop to the first two MCPs (`cos-mcp`, `kanban-mcp`). Single hostname (`heimdall.exe.pm`) — path-based routing for each MCP.

## 1. Register the GitHub OAuth App  *(you)*

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

| Field | Value |
|---|---|
| Application name | `Heimdall (Bifrost MCP gateway)` |
| Homepage URL | `https://heimdall.exe.pm` |
| Authorization callback URL | `https://heimdall.exe.pm/oauth/github/callback` |
| Enable Device Flow | unchecked |

Click **Register application**. On the next page, click **Generate a new client secret** and copy:

- **Client ID** → save for step 4 (`GITHUB_CLIENT_ID`)
- **Client secret** → save for step 4 (`GITHUB_CLIENT_SECRET`)

## 2. Cloudflare DNS  *(you)*

In the Cloudflare dashboard for `exe.pm`, add **one** CNAME record (or A record pointing at the tunnel — whichever pattern your existing `*.exe.pm` hostnames use):

| Hostname | Target |
|---|---|
| `heimdall.exe.pm` | same as `kanban.exe.pm` etc. (your existing Cloudflare Tunnel) |

Cloudflare proxy: **on** (orange cloud). TLS: full / strict per existing convention.

## 3. Cloudflare Tunnel ingress  *(you)*

Cloudflare → **Zero Trust → Networks → Tunnels → [your tunnel] → Public Hostnames**. Add one:

| Subdomain | Domain | Path | Service |
|---|---|---|---|
| `heimdall` | `exe.pm` | (blank) | `http://192.168.0.20:6115` |

**Important:** if your default `*.exe.pm` policy enforces Cloudflare Access, add a **bypass policy** for `heimdall.exe.pm` (allow everyone, all paths). The OAuth handshake is inside heimdall; Access SSO in front would break it.

## 4. Generate a JWT signing secret  *(you, one-liner)*

```bash
openssl rand -hex 48
```

Save the output for the `JWT_SECRET` env var.

## 5. Push and build  *(me)*

```
cd /websites/heimdall
git push origin main
```

GitHub Actions builds and publishes `ghcr.io/kschmidtlarsen/heimdall:latest` (~1 min).

## 6. Create the Portainer stack  *(me, via Portainer MCP)*

Stack name: `heimdall`. Git-managed from `kschmidtlarsen/heimdall`, compose file `docker-compose.prod.yml`.

Env vars to set on the stack:

```
GITHUB_CLIENT_ID=<from step 1>
GITHUB_CLIENT_SECRET=<from step 1>
JWT_SECRET=<from step 4>
```

Deploy. Watchtower then keeps the image fresh on future pushes.

## 7. Flip kanban-mcp to read-only  *(me)*

Update kanban-mcp stack (76) env: `KANBAN_WRITE_ENABLED=false`. Redeploy.

## 8. Verify  *(me, via curl)*

```bash
# AS metadata
curl -s https://heimdall.exe.pm/.well-known/oauth-authorization-server | jq .

# Resource metadata per MCP
curl -s https://heimdall.exe.pm/.well-known/oauth-protected-resource/cos-mcp | jq .
curl -s https://heimdall.exe.pm/.well-known/oauth-protected-resource/kanban-mcp | jq .

# Unauthenticated hit returns 401 with WWW-Authenticate
curl -i https://heimdall.exe.pm/cos-mcp/mcp
```

Expected: 401 with `WWW-Authenticate: Bearer resource_metadata="https://heimdall.exe.pm/.well-known/oauth-protected-resource/cos-mcp"`.

## 9. Add the connectors in Claude Desktop  *(you)*

Claude Desktop → **Settings → Connectors → + Add custom connector**. For each MCP:

| Field | `cos-mcp` | `kanban-mcp` |
|---|---|---|
| URL | `https://heimdall.exe.pm/cos-mcp/mcp` | `https://heimdall.exe.pm/kanban-mcp/mcp` |
| Advanced settings | (leave empty — DCR handles it) | (leave empty) |

Claude will:
1. Register itself dynamically (no client_id needed)
2. Pop a browser window to GitHub
3. Sign you in (any browser session works, but only `kschmidtlarsen` is allowed)
4. Hand back to Claude with a token
5. The connector goes "connected" and tools appear

## 10. Test  *(you, in Claude Desktop)*

- `cos-mcp` → ask Claude to "look up person X" or "get my writing style". Should work.
- `kanban-mcp` → ask Claude to "list cards on the kanban board". Should work, but **any write attempt should fail** while `KANBAN_WRITE_ENABLED=false`.

If both work, Phase 1 is done. Tell me when you're ready to re-enable kanban writes (Phase 2).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Connector stays "Connecting…" | DCR endpoint not reachable | Verify `https://heimdall.exe.pm/.well-known/oauth-authorization-server` returns JSON |
| Browser shows Cloudflare Access login | Access policy still in front of heimdall.exe.pm | Add a bypass policy for the hostname (see step 3) |
| `access_denied: user not allowlisted` | Signed in with a different GitHub account | Sign out of GitHub and retry, or add the login to `github.login_allowlist` |
| `invalid_target` | The resource URL doesn't match any configured slug | Ensure the connector URL is `https://heimdall.exe.pm/<slug>/mcp` where `<slug>` is in `config.mcps` |
| `bad_gateway` from /mcp after auth | Heimdall can't reach the upstream by DNS | Verify the MCP container is on the `bifrost` network |
| Tunnel can't reach heimdall | Tunnel is on `bridge`, not Bifrost | Confirm tunnel ingress points to `http://192.168.0.20:6115` (host port), not container DNS |

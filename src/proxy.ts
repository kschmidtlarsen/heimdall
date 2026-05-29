import { Router, type Request, type Response } from "express";
import type { HeimdallConfig, McpConfig } from "./config.js";
import { verifyAccessToken } from "./jwt.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function proxyRouter(cfg: HeimdallConfig): Router {
  const router = Router();

  // Resource-server metadata (RFC 9728)
  router.get("/.well-known/oauth-protected-resource", (req, res) => {
    const host = mcpHost(req);
    if (!host || !cfg.mcps[host]) return res.status(404).send("not an MCP host");
    res.json({
      resource: `https://${host}`,
      authorization_servers: [cfg.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  });

  router.all("/mcp", async (req, res) => {
    const host = mcpHost(req);
    if (!host) return res.status(404).send("not an MCP host");
    const mcp = cfg.mcps[host];
    if (!mcp) return res.status(404).send(`no MCP configured for host ${host}`);

    const audience = `https://${host}`;
    const auth = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) return unauthorized(res, host, cfg.issuer);

    try {
      await verifyAccessToken(cfg, m[1], audience);
    } catch (e) {
      return unauthorized(res, host, cfg.issuer, "invalid_token");
    }

    await proxyTo(req, res, mcp, "/mcp");
  });

  // Pass-through health for the upstream (debug helper, no auth)
  router.get("/health", (_req, res) => res.json({ status: "ok" }));

  return router;
}

function mcpHost(req: Request): string | undefined {
  // Cloudflare Tunnel forwards original Host header; behind `trust proxy`, req.hostname respects X-Forwarded-Host.
  const h = (req.header("x-forwarded-host") ?? req.header("host") ?? "").split(",")[0].trim().toLowerCase();
  return h || undefined;
}

function unauthorized(res: Response, host: string, issuer: string, error?: string): void {
  const resourceMeta = `https://${host}/.well-known/oauth-protected-resource`;
  let header = `Bearer resource_metadata="${resourceMeta}"`;
  if (error) header += `, error="${error}"`;
  res.set("WWW-Authenticate", header);
  res.status(401).json({ error: error ?? "unauthorized" });
}

async function proxyTo(req: Request, res: Response, mcp: McpConfig, path: string): Promise<void> {
  const target = mcp.upstream.replace(/\/$/, "") + path;

  // Rebuild headers minus hop-by-hop and Authorization (we already validated, MCP shouldn't see our JWT).
  const fwdHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "authorization") continue;
    if (Array.isArray(v)) fwdHeaders[k] = v.join(",");
    else if (v != null) fwdHeaders[k] = String(v);
  }

  const init: RequestInit = {
    method: req.method,
    headers: fwdHeaders,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    // express.json() / express.raw() consumed the body — fall back to the raw buffer if present
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const bodyBuf: Buffer | undefined = raw ?? (req.body !== undefined ? Buffer.from(JSON.stringify(req.body)) : undefined);
    if (bodyBuf) {
      init.body = new Uint8Array(bodyBuf);
      if (!fwdHeaders["content-type"]) fwdHeaders["content-type"] = "application/json";
    }
  }

  try {
    const upstream = await fetch(target, init);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key.toLowerCase())) return;
      res.setHeader(key, value);
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    console.error("[heimdall] proxy error", e);
    res.status(502).json({ error: "bad_gateway" });
  }
}

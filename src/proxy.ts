import { Router, type Request, type Response } from "express";
import { type HeimdallConfig, type McpConfig, resourceUrl } from "./config.js";
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

  // Resource-server metadata (RFC 9728 path form: /.well-known/oauth-protected-resource/<slug>)
  router.get("/.well-known/oauth-protected-resource/:slug", (req, res) => {
    const slug = req.params.slug;
    const mcp = cfg.mcps[slug];
    if (!mcp) return res.status(404).json({ error: "unknown_resource" });
    res.json({
      resource: resourceUrl(cfg, slug),
      authorization_servers: [cfg.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  });

  // MCP endpoint: /<slug>/mcp — authenticated, proxied to upstream container.
  router.all("/:slug/mcp", async (req, res) => {
    const slug = req.params.slug;
    const mcp = cfg.mcps[slug];
    if (!mcp) return res.status(404).json({ error: "unknown_resource" });

    const audience = resourceUrl(cfg, slug);
    const auth = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) return unauthorized(res, cfg.issuer, slug);

    try {
      await verifyAccessToken(cfg, m[1], audience);
    } catch {
      return unauthorized(res, cfg.issuer, slug, "invalid_token");
    }

    await proxyTo(req, res, mcp, "/mcp");
  });

  return router;
}

function unauthorized(res: Response, issuer: string, slug: string, error?: string): void {
  const resourceMeta = `${issuer}/.well-known/oauth-protected-resource/${slug}`;
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

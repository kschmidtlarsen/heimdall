import express, { type Request, type Response, type NextFunction } from "express";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { authServerRouter } from "./auth-server.js";
import { proxyRouter } from "./proxy.js";

const cfg = loadConfig();
const store = new Store();

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// CORS — permissive for public OAuth 2.1 client + browser-initiated MCP traffic.
// All endpoints we expose are either public (metadata, /register, /token) or audience-bound
// (the proxied /mcp). No cookies, no credentials — `*` is safe.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, MCP-Protocol-Version, X-MCP-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Capture the raw body for /:slug/mcp paths (so we can forward verbatim) before parsers consume it.
const MCP_PATH_RE = /^\/[a-z0-9][a-z0-9-]*\/mcp\/?$/i;
app.use((req, _res, next) => {
  if (!MCP_PATH_RE.test(req.path)) return next();
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on("end", () => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });
  req.on("error", next);
});

// Parsers for AS endpoints. Skipped on /:slug/mcp (handled above — the stream is already drained).
const json = express.json({ limit: "1mb" });
const form = express.urlencoded({ extended: false });
app.use((req, res, next) => (MCP_PATH_RE.test(req.path) ? next() : json(req, res, next)));
app.use((req, res, next) => (MCP_PATH_RE.test(req.path) ? next() : form(req, res, next)));

// Health (no auth — used by Docker healthcheck inside the container)
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Authorization Server (root paths: /.well-known/oauth-authorization-server, /authorize, /token, /register, /oauth/...)
app.use(authServerRouter(cfg, store));

// Resource Server (/.well-known/oauth-protected-resource/:slug, /:slug/mcp)
app.use(proxyRouter(cfg));

// 404 fallthrough
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[heimdall] unhandled error", err);
  res.status(500).json({ error: "server_error" });
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
app.listen(port, host, () => {
  console.log(`[heimdall] listening on ${host}:${port}`);
  console.log(`[heimdall] issuer=${cfg.issuer}`);
  console.log(`[heimdall] mcps=${Object.keys(cfg.mcps).join(", ")}`);
});

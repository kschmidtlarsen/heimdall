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

// Capture the raw body for the proxy path (so we can forward it verbatim) before parsers consume it.
app.use((req, _res, next) => {
  if (req.path !== "/mcp") return next();
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on("end", () => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });
  req.on("error", next);
});

// Parsers for AS endpoints. Skipped on /mcp (handled above).
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// Health (no host gating — used by Docker healthcheck inside the container)
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Host-based routing: the AS lives on the issuer host; everything else is an MCP host.
const issuerHost = new URL(cfg.issuer).host.toLowerCase();
const knownMcpHosts = new Set(Object.keys(cfg.mcps).map((h) => h.toLowerCase()));

app.use((req, res, next) => {
  const host = ((req.header("x-forwarded-host") ?? req.header("host") ?? "").split(",")[0] || "").trim().toLowerCase();
  (req as Request & { _host?: string })._host = host;
  if (host === issuerHost) {
    return authServerRouter(cfg, store)(req, res, next);
  }
  if (knownMcpHosts.has(host)) {
    return proxyRouter(cfg)(req, res, next);
  }
  return next();
});

// 404 fallthrough
app.use((req, res) => {
  res.status(404).json({ error: "not_found", host: (req as Request & { _host?: string })._host });
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

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface McpConfig {
  upstream: string;
  description?: string;
}

export interface HeimdallConfig {
  issuer: string;
  github: {
    client_id: string;
    client_secret: string;
    login_allowlist: string[];
  };
  jwt: {
    secret: string;
    ttl_seconds: number;
  };
  mcps: Record<string, McpConfig>;
}

const RESERVED_SLUGS = new Set([
  "health",
  "authorize",
  "token",
  "register",
  "oauth",
  ".well-known",
  "well-known",
]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): HeimdallConfig {
  const path = process.env.CONFIG_PATH ?? "/etc/heimdall/config.yml";
  const raw = parse(readFileSync(path, "utf8")) as {
    issuer: string;
    github: { login_allowlist: string[] };
    jwt: { ttl_seconds: number };
    mcps: Record<string, McpConfig>;
  };

  if (!raw.issuer?.startsWith("https://")) {
    throw new Error("config.issuer must be an https URL");
  }
  if (!raw.mcps || Object.keys(raw.mcps).length === 0) {
    throw new Error("config.mcps must define at least one MCP");
  }
  for (const [slug, mcp] of Object.entries(raw.mcps)) {
    if (!SLUG_RE.test(slug)) {
      throw new Error(`mcps.${slug}: slug must match ${SLUG_RE} (lowercase, alphanumeric + hyphen)`);
    }
    if (RESERVED_SLUGS.has(slug)) {
      throw new Error(`mcps.${slug}: slug is reserved`);
    }
    if (!mcp.upstream?.startsWith("http://")) {
      throw new Error(`mcps.${slug}.upstream must be a http:// URL`);
    }
  }

  return {
    issuer: raw.issuer.replace(/\/$/, ""),
    github: {
      client_id: requireEnv("GITHUB_CLIENT_ID"),
      client_secret: requireEnv("GITHUB_CLIENT_SECRET"),
      login_allowlist: raw.github?.login_allowlist ?? [],
    },
    jwt: {
      secret: requireEnv("JWT_SECRET"),
      ttl_seconds: raw.jwt?.ttl_seconds ?? 900,
    },
    mcps: raw.mcps,
  };
}

/** Resource identifier for a configured MCP slug: `${issuer}/${slug}`. */
export function resourceUrl(cfg: HeimdallConfig, slug: string): string {
  return `${cfg.issuer}/${slug}`;
}

/** Parse a resource URL the client sent (e.g. on /authorize) and return its slug, if known. */
export function slugFromResource(cfg: HeimdallConfig, resource: string): string | undefined {
  try {
    const u = new URL(resource);
    const iss = new URL(cfg.issuer);
    if (u.origin !== iss.origin) return undefined;
    const slug = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    return slug && cfg.mcps[slug] ? slug : undefined;
  } catch {
    return undefined;
  }
}

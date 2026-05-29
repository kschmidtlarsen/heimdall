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
  for (const [host, mcp] of Object.entries(raw.mcps)) {
    if (!mcp.upstream?.startsWith("http://")) {
      throw new Error(`mcps.${host}.upstream must be a http:// URL`);
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

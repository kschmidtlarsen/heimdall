import { randomBytes, createHash } from "node:crypto";
import { Router, type Response } from "express";
import { type HeimdallConfig, resourceUrl, slugFromResource } from "./config.js";
import type { Store } from "./store.js";
import { buildGitHubAuthorizeUrl, exchangeGitHubCode, fetchGitHubUser } from "./github.js";
import { mintAccessToken } from "./jwt.js";

const GITHUB_CALLBACK_PATH = "/oauth/github/callback";

export function authServerRouter(cfg: HeimdallConfig, store: Store): Router {
  const router = Router();

  // ─── OAuth 2.1 Authorization Server metadata (RFC 8414) ──────────────────
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/authorize`,
      token_endpoint: `${cfg.issuer}/token`,
      registration_endpoint: `${cfg.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  // ─── Dynamic Client Registration (RFC 7591) ──────────────────────────────
  router.post("/register", (req, res) => {
    const body = req.body as {
      client_name?: string;
      redirect_uris?: unknown;
      token_endpoint_auth_method?: string;
    };
    const redirect_uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (redirect_uris.length === 0) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris required" });
    }
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
      return res.status(400).json({
        error: "invalid_client_metadata",
        error_description: "only token_endpoint_auth_method=none (public client + PKCE) is supported",
      });
    }
    const client = store.registerClient(body.client_name, redirect_uris);
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  });

  // ─── /authorize — initiates PKCE flow, hops to GitHub ────────────────────
  router.get("/authorize", (req, res) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      scope,
      resource,
    } = req.query as Record<string, string>;

    if (response_type !== "code") return errorRedirect(res, redirect_uri, state, "unsupported_response_type");
    if (!client_id) return res.status(400).send("client_id required");
    const client = store.getClient(client_id);
    if (!client) return res.status(400).send("unknown client_id");
    if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      return res.status(400).send("redirect_uri not registered for client");
    }
    if (!code_challenge || code_challenge_method !== "S256") {
      return errorRedirect(res, redirect_uri, state, "invalid_request", "PKCE S256 required");
    }
    const slug = resource ? slugFromResource(cfg, resource) : undefined;
    if (!slug) {
      return errorRedirect(res, redirect_uri, state, "invalid_target", `unknown resource: ${resource}`);
    }
    const canonicalResource = resourceUrl(cfg, slug);

    const github_state = randomBytes(24).toString("hex");
    store.saveFlow({
      client_id,
      redirect_uri,
      state: state ?? "",
      code_challenge,
      code_challenge_method: "S256",
      resource: canonicalResource,
      scope,
      github_state,
      created_at: Date.now(),
    });

    const callback = cfg.issuer + GITHUB_CALLBACK_PATH;
    res.redirect(buildGitHubAuthorizeUrl(cfg.github.client_id, callback, github_state));
  });

  // ─── GitHub callback — closes loop, mints authorization code ─────────────
  router.get(GITHUB_CALLBACK_PATH, async (req, res) => {
    const { code, state } = req.query as Record<string, string>;
    if (!code || !state) return res.status(400).send("missing code or state");

    const flow = store.consumeFlow(state);
    if (!flow) return res.status(400).send("unknown or expired flow state");

    try {
      const callback = cfg.issuer + GITHUB_CALLBACK_PATH;
      const token = await exchangeGitHubCode(cfg.github.client_id, cfg.github.client_secret, code, callback);
      const user = await fetchGitHubUser(token.access_token);
      if (!cfg.github.login_allowlist.includes(user.login)) {
        console.warn(`[heimdall] denied login for github user "${user.login}"`);
        return errorRedirect(res, flow.redirect_uri, flow.state, "access_denied", "user not allowlisted");
      }

      const authCode = randomBytes(24).toString("hex");
      store.saveCode(authCode, {
        client_id: flow.client_id,
        redirect_uri: flow.redirect_uri,
        code_challenge: flow.code_challenge,
        code_challenge_method: flow.code_challenge_method,
        resource: flow.resource,
        scope: flow.scope,
        sub: user.login,
        created_at: Date.now(),
      });

      const u = new URL(flow.redirect_uri);
      u.searchParams.set("code", authCode);
      if (flow.state) u.searchParams.set("state", flow.state);
      res.redirect(u.toString());
    } catch (e) {
      console.error("[heimdall] github callback failed", e);
      return errorRedirect(res, flow.redirect_uri, flow.state, "server_error");
    }
  });

  // ─── /token — exchanges code+verifier for JWT ────────────────────────────
  router.post("/token", async (req, res) => {
    const body = req.body as Record<string, string>;
    const grant_type = body.grant_type;
    if (grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }
    const { code, code_verifier, client_id, redirect_uri, resource } = body;
    if (!code || !code_verifier || !client_id) {
      return res.status(400).json({ error: "invalid_request" });
    }
    const rec = store.consumeCode(code);
    if (!rec) return res.status(400).json({ error: "invalid_grant", error_description: "code unknown or expired" });
    if (rec.client_id !== client_id) {
      return res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
    }
    if (redirect_uri && redirect_uri !== rec.redirect_uri) {
      return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    }
    if (resource && resource !== rec.resource) {
      return res.status(400).json({ error: "invalid_target", error_description: "resource mismatch" });
    }

    const challenge = createHash("sha256").update(code_verifier).digest("base64url");
    if (challenge !== rec.code_challenge) {
      return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verifier mismatch" });
    }

    const access_token = await mintAccessToken(cfg, rec.sub, rec.resource, rec.scope);
    res.json({
      access_token,
      token_type: "Bearer",
      expires_in: cfg.jwt.ttl_seconds,
      scope: rec.scope ?? "",
    });
  });

  return router;
}

function errorRedirect(
  res: Response,
  redirect_uri: string | undefined,
  state: string | undefined,
  error: string,
  error_description?: string,
): void {
  if (!redirect_uri) {
    res.status(400).send(`${error}${error_description ? `: ${error_description}` : ""}`);
    return;
  }
  const u = new URL(redirect_uri);
  u.searchParams.set("error", error);
  if (error_description) u.searchParams.set("error_description", error_description);
  if (state) u.searchParams.set("state", state);
  res.redirect(u.toString());
}

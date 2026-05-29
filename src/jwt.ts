import { SignJWT, jwtVerify } from "jose";
import type { HeimdallConfig } from "./config.js";

export async function mintAccessToken(
  cfg: HeimdallConfig,
  sub: string,
  audience: string,
  scope?: string,
): Promise<string> {
  const secret = new TextEncoder().encode(cfg.jwt.secret);
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ scope: scope ?? "" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(cfg.issuer)
    .setSubject(sub)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + cfg.jwt.ttl_seconds)
    .sign(secret);
}

export async function verifyAccessToken(
  cfg: HeimdallConfig,
  token: string,
  expectedAudience: string,
): Promise<{ sub: string; scope: string }> {
  const secret = new TextEncoder().encode(cfg.jwt.secret);
  const { payload } = await jwtVerify(token, secret, {
    issuer: cfg.issuer,
    audience: expectedAudience,
  });
  return {
    sub: payload.sub as string,
    scope: (payload.scope as string) ?? "",
  };
}

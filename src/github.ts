// Thin GitHub OAuth helper — we only need login (read user) scope.

interface GitHubToken {
  access_token: string;
  token_type: string;
  scope: string;
}

interface GitHubUser {
  login: string;
  id: number;
}

export function buildGitHubAuthorizeUrl(
  client_id: string,
  callback: string,
  github_state: string,
): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", client_id);
  u.searchParams.set("redirect_uri", callback);
  u.searchParams.set("state", github_state);
  u.searchParams.set("scope", "read:user");
  u.searchParams.set("allow_signup", "false");
  return u.toString();
}

export async function exchangeGitHubCode(
  client_id: string,
  client_secret: string,
  code: string,
  callback: string,
): Promise<GitHubToken> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id, client_secret, code, redirect_uri: callback }),
  });
  if (!res.ok) throw new Error(`github token exchange failed: ${res.status}`);
  const json = (await res.json()) as GitHubToken & { error?: string; error_description?: string };
  if (json.error) throw new Error(`github error: ${json.error_description ?? json.error}`);
  return json;
}

export async function fetchGitHubUser(access_token: string): Promise<GitHubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "heimdall",
    },
  });
  if (!res.ok) throw new Error(`github /user fetch failed: ${res.status}`);
  return (await res.json()) as GitHubUser;
}

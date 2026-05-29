import { randomBytes } from "node:crypto";

export interface ClientRecord {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}

export interface PendingFlow {
  // Original Claude-side parameters
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: "S256";
  resource: string; // audience the token will bind to (e.g. https://cos-mcp.exe.pm)
  scope?: string;
  // Internal state for the GitHub round-trip
  github_state: string;
  created_at: number;
}

export interface AuthCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  resource: string;
  scope?: string;
  sub: string; // GitHub login
  created_at: number;
}

const FIVE_MIN = 5 * 60 * 1000;
const ONE_MIN = 60 * 1000;

export class Store {
  private clients = new Map<string, ClientRecord>();
  private flowsByGithubState = new Map<string, PendingFlow>();
  private codes = new Map<string, AuthCodeRecord>();

  constructor() {
    // periodic sweep
    setInterval(() => this.sweep(), 60_000).unref();
  }

  registerClient(client_name: string | undefined, redirect_uris: string[]): ClientRecord {
    const client_id = "heimdall_" + randomBytes(16).toString("hex");
    const rec: ClientRecord = {
      client_id,
      client_name,
      redirect_uris,
      created_at: Date.now(),
    };
    this.clients.set(client_id, rec);
    return rec;
  }

  getClient(client_id: string): ClientRecord | undefined {
    return this.clients.get(client_id);
  }

  saveFlow(flow: PendingFlow): void {
    this.flowsByGithubState.set(flow.github_state, flow);
  }

  consumeFlow(github_state: string): PendingFlow | undefined {
    const flow = this.flowsByGithubState.get(github_state);
    if (flow) this.flowsByGithubState.delete(github_state);
    return flow;
  }

  saveCode(code: string, rec: AuthCodeRecord): void {
    this.codes.set(code, rec);
  }

  consumeCode(code: string): AuthCodeRecord | undefined {
    const rec = this.codes.get(code);
    if (rec) this.codes.delete(code);
    return rec;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.flowsByGithubState) {
      if (now - v.created_at > FIVE_MIN) this.flowsByGithubState.delete(k);
    }
    for (const [k, v] of this.codes) {
      if (now - v.created_at > ONE_MIN) this.codes.delete(k);
    }
  }
}

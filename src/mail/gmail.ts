import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import type { MailMessage, MailSource } from "./verification.ts";

/**
 * The owner's Gmail, read through the API with the token the gmail skill set up
 * (~/.my-claw/secrets/gmail-token.json, the Google "authorized user" shape). Read-only calls only:
 * list and get. The token file carries the refresh token, the client id and its secret; the access
 * token it yields is kept in memory until it expires, and never written back.
 */
export function tokenFilePath(): string {
  return join(MY_CLAW_DIR, "secrets", "gmail-token.json");
}

interface TokenFile {
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  token_uri?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

function decode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function bodiesOf(payload: GmailPart): { text: string; html?: string } {
  const text: string[] = [];
  const html: string[] = [];
  const stack = [payload];
  while (stack.length > 0) {
    const part = stack.pop()!;
    if (!part.filename && part.body?.data) {
      if (part.mimeType === "text/plain") text.push(decode(part.body.data));
      else if (part.mimeType === "text/html") html.push(decode(part.body.data));
    }
    stack.push(...(part.parts ?? []));
  }
  return { text: text.join("\n"), ...(html.length > 0 ? { html: html.join("\n") } : {}) };
}

export class GmailSource implements MailSource {
  private access?: { token: string; expiresAt: number };

  constructor(
    private readonly tokenPath: string = tokenFilePath(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the mailbox was set up at all: without the token file the tool says so and stops. */
  async configured(): Promise<boolean> {
    return (await this.readToken()) !== undefined;
  }

  async recent(sinceMs: number, domains: readonly string[]): Promise<MailMessage[]> {
    const token = await this.accessToken();
    const q = `after:${Math.floor(sinceMs / 1000)} from:(${domains.join(" OR ")})`;
    const list = await this.get<{ messages?: Array<{ id: string }> }>(
      token,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(q)}`,
    );
    const out: MailMessage[] = [];
    for (const { id } of list.messages ?? []) {
      const message = await this.get<{ id: string; internalDate?: string; payload?: GmailPart }>(
        token,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      );
      const payload = message.payload ?? {};
      const from = payload.headers?.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
      const receivedAt = Number(message.internalDate ?? 0);
      if (receivedAt < sinceMs) continue;
      out.push({ id: message.id, from, receivedAt, ...bodiesOf(payload) });
    }
    return out.sort((a, b) => b.receivedAt - a.receivedAt);
  }

  private async readToken(): Promise<TokenFile | undefined> {
    try {
      const data = JSON.parse(await readFile(this.tokenPath, "utf8")) as TokenFile;
      return data.refresh_token && data.client_id && data.client_secret ? data : undefined;
    } catch {
      return undefined;
    }
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt > this.now() + 60_000) return this.access.token;
    const file = await this.readToken();
    if (!file) throw new Error("Gmail is not set up on this machine (no token in ~/.my-claw/secrets/gmail-token.json).");
    const response = await fetch(file.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: file.refresh_token!,
        client_id: file.client_id!,
        client_secret: file.client_secret!,
      }).toString(),
    });
    if (!response.ok) throw new Error(`Gmail refused the token refresh (HTTP ${response.status}).`);
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("Gmail answered the token refresh without a token.");
    this.access = { token: data.access_token, expiresAt: this.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }

  private async get<T>(token: string, url: string): Promise<T> {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Gmail answered HTTP ${response.status}.`);
    return (await response.json()) as T;
  }
}

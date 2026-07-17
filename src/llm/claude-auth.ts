import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";

// The Claude subscription token (from `claude setup-token`, valid ~1 year). Stored in a
// my-claw-owned file so it survives restarts and the SDK backend can inject it per run,
// independent of the systemd EnvironmentFile / ~/.my-claw/.env split. See docs/claude-sdk-backend.md.
const AUTH_PATH = join(MY_CLAW_DIR, "claude", "auth.json");
const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
// setup-token prints an "sk-ant-oat..." token; capture it defensively from mixed output.
const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9._-]+/;

interface ClaudeAuthFile {
  token?: string;
}

async function readStoredToken(): Promise<string | null> {
  try {
    const raw = await readFile(AUTH_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ClaudeAuthFile;
    if (parsed.token && parsed.token.length > 0) return parsed.token;
  } catch {
    // No stored token yet.
  }
  return null;
}

/** Token for the SDK backend: the my-claw-owned file wins, else the ambient env token. */
export async function loadClaudeToken(): Promise<string | null> {
  return (await readStoredToken()) ?? process.env[TOKEN_ENV] ?? null;
}

export async function setClaudeToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("empty token");
  await writeFileAtomically(AUTH_PATH, JSON.stringify({ token: trimmed }, null, 2), { mode: 0o600 });
}

export async function clearClaudeToken(): Promise<void> {
  await writeFileAtomically(AUTH_PATH, "{}", { mode: 0o600 }).catch(() => {});
}

export interface ClaudeTokenStatus {
  present: boolean;
  source: "my-claw" | "env" | "none";
  masked?: string;
}

function mask(token: string): string {
  return token.length <= 14 ? "set" : `${token.slice(0, 10)}…${token.slice(-4)}`;
}

export async function claudeTokenStatus(): Promise<ClaudeTokenStatus> {
  const stored = await readStoredToken();
  if (stored) return { present: true, source: "my-claw", masked: mask(stored) };
  const env = process.env[TOKEN_ENV];
  if (env) return { present: true, source: "env", masked: mask(env) };
  return { present: false, source: "none" };
}

/**
 * Run the official `claude setup-token` (interactive OAuth), capture the printed token and store
 * it. Terminal-only: the underlying tool needs a browser/TTY, which is why there is no in-chat
 * equivalent (the paste path is `setClaudeToken`). Reimplementing Anthropic's OAuth is out —
 * this wraps their sanctioned tool.
 */
export function runClaudeSetupToken(): Promise<{ ok: boolean; token?: string; message: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("claude", ["setup-token"], { stdio: ["inherit", "pipe", "inherit"] });
    } catch (err) {
      resolve({ ok: false, message: `Could not run 'claude setup-token': ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.on("error", (err: Error) => {
      resolve({ ok: false, message: `Could not run 'claude setup-token': ${err.message}. Is the Claude CLI installed and on PATH?` });
    });
    child.on("close", async () => {
      const match = out.match(TOKEN_PATTERN);
      if (!match) {
        resolve({ ok: false, message: "No token detected in 'claude setup-token' output. Copy it and run: my-claw claude set-token <token>" });
        return;
      }
      try {
        await setClaudeToken(match[0]);
        resolve({ ok: true, token: match[0], message: "Claude token stored in ~/.my-claw/claude/auth.json." });
      } catch (err) {
        resolve({ ok: false, message: `Failed to store token: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  });
}

import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");
const SUBAGENT_DIR = join(SESSIONS_DIR, "subagent");

function randomHex(n: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < n; i++) {
    out += chars[Math.floor(Math.random() * 16)];
  }
  return out;
}

export class SubAgentRegistry {
  private queues = new Map<string, Promise<void>>();

  async load(): Promise<void> {
    try {
      await access(SUBAGENT_DIR);
    } catch {
      return;
    }
  }

  generateId(displayName: string, existing: Set<string>): string {
    let id: string;
    do {
      id = `subagent/${displayName}-${randomHex(4)}`;
    } while (existing.has(id));
    return id;
  }

  async listExistingIds(): Promise<Set<string>> {
    const set = new Set<string>();
    try {
      const entries = await readdir(SUBAGENT_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          set.add(`subagent/${entry.name.slice(0, -5)}`);
        }
      }
    } catch {
      // directory does not exist
    }
    return set;
  }

  async enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id);

    const wrapped = (previous ?? Promise.resolve()).then(() => task());

    const cleanup = wrapped
      .then(() => {})
      .catch(() => {});

    this.queues.set(id, cleanup);

    try {
      return await wrapped;
    } finally {
      if (this.queues.get(id) === cleanup) {
        this.queues.delete(id);
      }
    }
  }

  isRunning(id: string): boolean {
    return this.queues.has(id);
  }
}

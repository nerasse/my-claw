import { createHash } from "node:crypto";
import { lstat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR, type ResolvedLlmConfig } from "../core/config.ts";
import { log } from "../utils/logger.ts";

const directory = join(MY_CLAW_DIR, "secrets", "llm-sse");
const ARM_TTL_MS = 10 * 60 * 1000;
const CAPTURE_BYTES = 4 * 1024 * 1024;

export async function claimSseCapture(config: ResolvedLlmConfig): Promise<{
  append(chunk: Uint8Array): void;
  save(): Promise<void>;
} | undefined> {
  if (!config.provider) return undefined;
  const route = `${config.provider}/${config.apiModel ?? config.model}`;
  const hash = createHash("sha256").update(route).digest("hex");
  const pending = join(directory, `${hash}.pending`);
  try {
    const arm = await lstat(pending);
    if (!arm.isFile() || (arm.mode & 0o077) !== 0) return undefined;
    const target = await lstat(directory);
    if (!target.isDirectory() || (target.mode & 0o077) !== 0) return undefined;
    // Only the reader that removes the arm can capture, even if two calls arrive together.
    await unlink(pending);
    const age = Date.now() - Math.floor(arm.mtimeMs);
    if (age < 0 || age > ARM_TTL_MS) return undefined;
  } catch {
    return undefined;
  }

  const buffer = Buffer.allocUnsafe(CAPTURE_BYTES);
  let size = 0;
  let partial = false;
  return {
    append(chunk) {
      const copied = Math.min(buffer.length - size, chunk.byteLength);
      buffer.set(chunk.subarray(0, copied), size);
      size += copied;
      if (copied < chunk.byteLength) partial = true;
    },
    async save() {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `${timestamp}-${crypto.randomUUID()}${partial ? ".partial" : ""}.sse`;
      try {
        await writeFile(join(directory, name), buffer.subarray(0, size), { mode: 0o600, flag: "wx" });
      } catch {
        void log("warn", "could not save the armed SSE capture");
      }
    },
  };
}

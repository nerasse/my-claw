import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../config.ts";

const LOGS_DIR = join(MY_CLAW_DIR, "logs");

type LogLevel = "info" | "warn" | "error" | "debug";

export async function log(level: LogLevel, message: string, data?: unknown): Promise<void> {
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({ timestamp, level, message, data }) + "\n";

  console.log(`[${level.toUpperCase()}] ${message}`);

  try {
    await mkdir(LOGS_DIR, { recursive: true });
    const date = timestamp.split("T")[0];
    await appendFile(join(LOGS_DIR, `${date}.log`), line);
  } catch {
    // logging should never crash the app
  }
}

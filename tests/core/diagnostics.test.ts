import { test, expect } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { readLogEntries, formatLogEntries, collectSecrets, redactSecrets } from "../../src/core/diagnostics.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

const LOGS_DIR = join(MY_CLAW_DIR, "logs");

async function seedLog(name: string, entries: object[]): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });
  await writeFile(join(LOGS_DIR, name), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function entry(over: Partial<{ level: string; scope: string; run: string; message: string }>): object {
  return {
    timestamp: "2026-08-06T10:00:00.000Z",
    scope: over.scope ?? "mobile",
    level: over.level ?? "info",
    ...(over.run ? { run: over.run } : {}),
    message: over.message ?? "something happened",
  };
}

function config(): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: { mobile: { devices: { "dev-1": { token: "super-secret-device-token" } } } },
    llm: { provider: "x", baseUrl: "https://example.com", model: "m", apiKey: "sk-abcdef1234567890" },
    agents: {},
  };
}

test("the log tail filters by run id, which is the whole point of stamping it", async () => {
  await rm(LOGS_DIR, { recursive: true, force: true });
  await seedLog("mobile-2026-08-06.log", [
    entry({ run: "aaaa1111", message: "first" }),
    entry({ run: "bbbb2222", message: "other run" }),
    entry({ run: "aaaa1111", message: "second" }),
  ]);

  const entries = await readLogEntries({ run: "aaaa1111" });

  expect(entries.length).toBe(2);
  expect(entries.every((e) => e.run === "aaaa1111")).toBe(true);
});

test("the log tail filters by level and keeps the newest lines first", async () => {
  await rm(LOGS_DIR, { recursive: true, force: true });
  await seedLog("orchestrator-2026-08-06.log", [
    entry({ level: "debug", message: "noise" }),
    entry({ level: "warn", message: "a warning" }),
    entry({ level: "error", message: "a failure" }),
  ]);

  const entries = await readLogEntries({ level: "warn" });

  expect(entries.map((e) => e.message)).toEqual(["a failure", "a warning"]);
});

test("the log tail can be scoped to one channel", async () => {
  await rm(LOGS_DIR, { recursive: true, force: true });
  await seedLog("mobile-2026-08-06.log", [entry({ scope: "mobile", message: "from mobile" })]);
  await seedLog("telegram-2026-08-06.log", [entry({ scope: "telegram", message: "from telegram" })]);

  const entries = await readLogEntries({ scope: "mobile" });

  expect(entries.map((e) => e.message)).toEqual(["from mobile"]);
});

test("secrets never leave the server, whether named in the config or matched by shape", () => {
  const secrets = collectSecrets(config());
  const text = [
    "device token=super-secret-device-token",
    "key sk-abcdef1234567890",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef",
    "bot 123456789:AAHkm9-fakeTelegramTokenValue_padding123",
  ].join("\n");

  const clean = redactSecrets(text, secrets);

  expect(clean).not.toContain("super-secret-device-token");
  expect(clean).not.toContain("sk-abcdef1234567890");
  expect(clean).not.toContain("eyJhbGciOiJIUzI1NiJ9abcdef");
  expect(clean).not.toContain("AAHkm9-fakeTelegramTokenValue_padding123");
  expect(clean).toContain("[redacted]");
});

test("the formatted tail is redacted and reads oldest to newest", async () => {
  await rm(LOGS_DIR, { recursive: true, force: true });
  await seedLog("mobile-2026-08-06.log", [
    entry({ run: "aaaa1111", message: "older" }),
    { ...entry({ run: "aaaa1111", message: "newer" }), data: { token: "super-secret-device-token" } },
  ]);

  const text = formatLogEntries(await readLogEntries({}), collectSecrets(config()));

  expect(text.indexOf("older")).toBeLessThan(text.indexOf("newer"));
  expect(text).toContain("run=aaaa1111");
  expect(text).not.toContain("super-secret-device-token");
});

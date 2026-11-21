import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { MY_CLAW_DIR, type ResolvedLlmConfig } from "../../src/core/config.ts";
import { chatCompletionStream } from "../../src/llm/provider.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const dir = join(MY_CLAW_DIR, "secrets", "llm-sse");
const config: ResolvedLlmConfig = {
  provider: "synthetic",
  model: "synthetic/deepseek-fixture",
  apiModel: "deepseek/fixture",
  baseUrl: "https://fixture.example/v1",
  apiKey: "fixture-authorization",
  backend: "openai",
};
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const reply = event({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";

async function arm(): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(`${config.provider}/${config.apiModel}`).digest("hex");
  const marker = join(dir, `${hash}.pending`);
  await writeFile(marker, "", { mode: 0o600, flag: "wx" });
  return marker;
}

function call(route = config) {
  return chatCompletionStream(route, [{ role: "user", content: "fixture-request-body" }], () => {});
}

function mockStream(wire: string) {
  return mockFetch(async () => new Response(wire, {
    headers: { "Content-Type": "text/event-stream", "X-Fixture": "fixture-response-header" },
  }));
}

afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("SSE capture writes nothing without an arm", async () => {
  const mock = mockStream(reply);
  try {
    expect((await call()).content).toBe("OK");
    await expect(stat(dir)).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    mock.restore();
  }
});

test("an arm claims one matching response, with only the SSE body in a private file", async () => {
  await arm();
  const mock = mockStream(reply);
  try {
    await call({ ...config, provider: "another-provider" });
    await call({ ...config, apiModel: "another-model" });
    expect((await readdir(dir)).filter((name) => name.endsWith(".sse"))).toEqual([]);
    const replies = await Promise.all([call(), call()]);
    expect(replies.map((result) => result.content)).toEqual(["OK", "OK"]);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith(".sse");
    const file = join(dir, files[0]!);
    expect(await readFile(file, "utf8")).toBe(reply);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    mock.restore();
  }
});

test("a directory shared with other users cannot receive a capture", async () => {
  const marker = await arm();
  await chmod(dir, 0o755);
  const mock = mockStream(reply);
  try {
    expect((await call()).content).toBe("OK");
    expect(await readdir(dir)).toEqual([basename(marker)]);
  } finally {
    mock.restore();
  }
});

test("an expired arm never records the next request", async () => {
  const marker = await arm();
  await utimes(marker, new Date(0), new Date(0));
  const mock = mockStream(reply);
  try {
    expect((await call()).content).toBe("OK");
    expect(await readdir(dir)).toEqual([]);
  } finally {
    mock.restore();
  }
});

test("a cut is captured and a large body is bounded and marked partial", async () => {
  const limit = 4 * 1024 * 1024;
  const wire = ":" + "x".repeat(limit + 1) + "\n" + event({ choices: [{ delta: { content: "unfinished" } }] });
  await arm();
  const mock = mockStream(wire);
  try {
    await expect(call()).rejects.toThrow("closed before the provider said it was done");
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith(".partial.sse");
    expect(await readFile(join(dir, files[0]!), "utf8")).toBe(wire.slice(0, limit));
  } finally {
    mock.restore();
  }
});

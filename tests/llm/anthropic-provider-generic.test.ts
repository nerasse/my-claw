import { test } from "bun:test";
import assert from "node:assert/strict";
import type { LlmConfig } from "../../src/core/config.ts";
import { anthropicResponseStream } from "../../src/llm/anthropic.ts";
import { ModelCatalog } from "../../src/llm/catalog.ts";
import { resolveLlmConfig } from "../../src/llm/resolver.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";

/** The subscription's sign-in is the provider's own file (accounts-store.ts), not an env variable. */
const SUBSCRIPTION = "CLAUDE_CODE_OAUTH_TOKEN";
/** The plan providers these tests declare: "claude" for the runs, "abo" for discovery. */
const ACCOUNTS = ["claude", "abo"].map((key) => join(MY_CLAW_DIR, "accounts", `${key}.json`));

/**
 * `type: "anthropic"` is a transport, not one endpoint with one credential: `baseUrl` says where
 * the request goes and `apiKeyEnv` says what signs it, each defaulting on its own
 * (api.anthropic.com, the Claude subscription). See docs/anthropic-backend.md.
 *
 * Half of what follows guards the generalization; the other half guards the default, which is the
 * part nobody notices breaking until a run fails.
 */

const KEY_ENV = "MY_CLAW_TEST_ANTHROPIC_KEY";
const ZAI = "https://api.z.ai/api/anthropic";

function withEnv(vars: Record<string, string | undefined>): { restore(): void } {
  const previous = new Map<string, string | undefined>();
  const { [SUBSCRIPTION]: token, ...env } = vars;
  if (token) {
    mkdirSync(join(MY_CLAW_DIR, "accounts"), { recursive: true });
    for (const file of ACCOUNTS) writeFileSync(file, JSON.stringify({ token }));
  }
  for (const [name, value] of Object.entries(env)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return {
    restore() {
      for (const file of ACCOUNTS) rmSync(file, { force: true });
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

function config(providerFields: Record<string, unknown>): LlmConfig {
  return {
    defaultProvider: "claude",
    defaultModel: "claude/claude-opus-5",
    providers: { claude: { type: "anthropic", ...providerFields } },
    models: [{ id: "claude/claude-opus-5", label: "Opus 5", provider: "claude", apiId: "claude-opus-5" }],
  };
}

// ============================================================================
// Resolution
// ============================================================================

test("a provider declaring only its type stays the subscription, whatever keys the box exports", () => {
  // The trap this exists for: reusing the openai branch's key resolution would pick up the
  // last-resort FIREWORKS/OPENAI env names and hand a subscription provider a stranger's key on
  // any machine that has one exported.
  const env = withEnv({ OPENAI_API_KEY: "sk-openai", FIREWORKS_API_KEY: "fw-key", [KEY_ENV]: "zai-secret" });
  try {
    const resolved = resolveLlmConfig(config({}), "claude/claude-opus-5");
    assert.equal(resolved.backend, "anthropic");
    assert.equal(resolved.baseUrl, "https://api.anthropic.com");
    assert.equal(resolved.apiKey, undefined);
    assert.equal(resolved.apiKeyEnv, undefined);
  } finally {
    env.restore();
  }
});

test("a provider declaring an endpoint and a key env resolves both", () => {
  const env = withEnv({ [KEY_ENV]: "zai-secret" });
  try {
    const resolved = resolveLlmConfig(config({ baseUrl: ZAI, apiKeyEnv: KEY_ENV }), "claude/claude-opus-5");
    assert.equal(resolved.backend, "anthropic");
    assert.equal(resolved.baseUrl, ZAI);
    assert.equal(resolved.apiKey, "zai-secret");
    assert.equal(resolved.apiKeyEnv, KEY_ENV);
  } finally {
    env.restore();
  }
});

test("a key env that holds nothing is still carried, so nothing can read it as the subscription", () => {
  const env = withEnv({ [KEY_ENV]: undefined });
  try {
    const resolved = resolveLlmConfig(config({ baseUrl: ZAI, apiKeyEnv: KEY_ENV }), "claude/claude-opus-5");
    assert.equal(resolved.apiKey, undefined);
    assert.equal(resolved.apiKeyEnv, KEY_ENV);
  } finally {
    env.restore();
  }
});

// ============================================================================
// What the request carries
// ============================================================================

interface SeenRequest {
  url: string;
  headers: Headers;
}

async function send(providerFields: Record<string, unknown>): Promise<SeenRequest[]> {
  const seen: SeenRequest[] = [];
  const mock = mockFetch(async (url?: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response('data: {"type":"message_stop"}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  try {
    const resolved = resolveLlmConfig(config(providerFields), "claude/claude-opus-5");
    await anthropicResponseStream(resolved, [{ role: "user", content: "hi" }], () => {});
  } finally {
    mock.restore();
  }
  return seen;
}

test("the subscription signs with a bearer token, against Anthropic's own endpoint", async () => {
  const env = withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-sub" });
  try {
    const [request] = await send({});
    assert.equal(request?.url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(request?.headers.get("authorization"), "Bearer sk-ant-oat-sub");
    assert.equal(request?.headers.get("x-api-key"), null);
  } finally {
    env.restore();
  }
});

test("a provider with its own key signs with x-api-key, and the subscription token never leaves the box", async () => {
  const env = withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-sub", [KEY_ENV]: "zai-secret" });
  try {
    const [request] = await send({ baseUrl: ZAI, apiKeyEnv: KEY_ENV });
    assert.equal(request?.url, `${ZAI}/v1/messages?beta=true`);
    assert.equal(request?.headers.get("x-api-key"), "zai-secret");
    // The whole point of keeping the two credentials apart: a subscription token handed to a third
    // party is a leak, and it is one env var away from happening by accident.
    assert.equal(request?.headers.get("authorization"), null);
  } finally {
    env.restore();
  }
});

test("a declared key env that is unset fails the run instead of falling back to the subscription", async () => {
  const env = withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-sub", [KEY_ENV]: undefined });
  let calls = 0;
  const mock = mockFetch(async () => {
    calls++;
    return new Response("", { status: 200 });
  });
  try {
    const resolved = resolveLlmConfig(config({ baseUrl: ZAI, apiKeyEnv: KEY_ENV }), "claude/claude-opus-5");
    await assert.rejects(
      () => anthropicResponseStream(resolved, [{ role: "user", content: "hi" }], () => {}),
      new RegExp(`"claude".*${KEY_ENV}`),
    );
    assert.equal(calls, 0, "nothing may reach the network on a credential the owner declared and did not set");
  } finally {
    mock.restore();
    env.restore();
  }
});

// ============================================================================
// Discovery
// ============================================================================

test("each provider is discovered from its own endpoint under its own credential", async () => {
  const env = withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-sub", [KEY_ENV]: "zai-secret" });
  const seen: SeenRequest[] = [];
  const mock = mockFetch(async (url?: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ data: [{ id: "m-1", display_name: "M 1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  try {
    const catalog = new ModelCatalog(() => ({
      providers: {
        abo: { type: "anthropic", discover: true },
        zai: { type: "anthropic", baseUrl: ZAI, apiKeyEnv: KEY_ENV, discover: true },
      },
    }));
    await catalog.refresh();

    const abo = seen.find((r) => r.url.startsWith("https://api.anthropic.com"));
    const zai = seen.find((r) => r.url.startsWith(ZAI));
    assert.ok(abo, `subscription discovery should read api.anthropic.com, saw ${seen.map((r) => r.url).join(", ")}`);
    assert.ok(zai, `keyed discovery should read its own baseUrl, saw ${seen.map((r) => r.url).join(", ")}`);
    assert.equal(abo.headers.get("authorization"), "Bearer sk-ant-oat-sub");
    assert.equal(abo.headers.get("x-api-key"), null);
    assert.equal(zai.headers.get("x-api-key"), "zai-secret");
    assert.equal(zai.headers.get("authorization"), null);

    // Both listed the same wire id, and both copies survive: the reference carries the provider.
    assert.deepEqual(catalog.discovered().map((m) => m.id).sort(), ["abo/m-1", "zai/m-1"]);
  } finally {
    mock.restore();
    env.restore();
  }
});

import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  fetchAnthropicModels,
  splitAnthropicDisplayName,
  anthropicEffortLevels,
} from "../../src/llm/anthropic-models.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

test("splitAnthropicDisplayName: strips the Claude prefix and separates the family", () => {
  assert.deepEqual(splitAnthropicDisplayName("Claude Opus 4.8", "claude-opus-4-8"), {
    label: "Opus 4.8",
    family: "Opus",
  });
  assert.deepEqual(splitAnthropicDisplayName("Claude Sonnet 5", "claude-sonnet-5"), {
    label: "Sonnet 5",
    family: "Sonnet",
  });
  // A name with no trailing version stays whole rather than losing its last word.
  assert.deepEqual(splitAnthropicDisplayName("Claude Fable", "claude-fable"), {
    label: "Fable",
    family: "Fable",
  });
  // Missing display name must never produce an empty button label.
  assert.deepEqual(splitAnthropicDisplayName("", "claude-opus-4-1-20250805"), {
    label: "claude-opus-4-1-20250805",
    family: "claude-opus-4-1-20250805",
  });
});

test("anthropicEffortLevels: only levels the model actually supports, in menu order", () => {
  assert.deepEqual(
    anthropicEffortLevels({
      supported: true,
      // Deliberately out of order to prove the result is normalized.
      max: { supported: true },
      low: { supported: true },
      high: { supported: true },
      medium: { supported: true },
    }),
    ["low", "medium", "high", "max"],
  );
  // Opus 4.6 style: no xhigh. Offering it would let the picker propose a rejected level.
  assert.deepEqual(
    anthropicEffortLevels({
      supported: true,
      low: { supported: true },
      xhigh: { supported: false },
      max: { supported: true },
    }),
    ["low", "max"],
  );
  assert.deepEqual(anthropicEffortLevels({ supported: false, low: { supported: true } }), []);
  assert.deepEqual(anthropicEffortLevels(undefined), []);
});

test("fetchAnthropicModels: sends subscription auth and maps capabilities", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const mock = mockFetch(async (url?: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "claude-opus-4-8",
            display_name: "Claude Opus 4.8",
            max_input_tokens: 1000000,
            max_tokens: 128000,
            capabilities: {
              effort: { supported: true, low: { supported: true }, max: { supported: true } },
              image_input: { supported: true },
            },
          },
          {
            id: "claude-haiku-4-5-20251001",
            display_name: "Claude Haiku 4.5",
            max_input_tokens: 200000,
            capabilities: { effort: { supported: false }, image_input: { supported: false } },
          },
          { display_name: "No id" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  try {
    const models = await fetchAnthropicModels("tok-123");
    assert.match(seenUrl, /^https:\/\/api\.anthropic\.com\/v1\/models\?limit=100$/);
    assert.equal(seenHeaders["authorization"], "Bearer tok-123");
    assert.equal(seenHeaders["anthropic-version"], "2023-06-01");

    // The entry without an id is dropped rather than producing an unusable menu button.
    assert.deepEqual(models.map((m) => m.id), ["claude-opus-4-8", "claude-haiku-4-5-20251001"]);

    const opus = models[0]!;
    assert.equal(opus.label, "Opus 4.8");
    assert.equal(opus.family, "Opus");
    assert.deepEqual(opus.effortLevels, ["low", "max"]);
    assert.equal(opus.vision, true);
    assert.equal(opus.contextLimit, 1000000);
    assert.equal(opus.outputLimit, 128000);

    const haiku = models[1]!;
    assert.deepEqual(haiku.effortLevels, []);
    assert.equal(haiku.vision, false);
  } finally {
    mock.restore();
  }
});

test("fetchAnthropicModels: a non-ok response throws so the caller keeps its cached set", async () => {
  const mock = mockFetch(async () => new Response("nope", { status: 401 }));
  try {
    await assert.rejects(() => fetchAnthropicModels("bad"), /HTTP 401/);
  } finally {
    mock.restore();
  }
});

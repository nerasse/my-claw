import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMyClawAppCommandHandler, instructionsText } from "../src/channels/my-claw-app/commands.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { ModelPicker } from "../src/channels/model-picker.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import { hooks } from "../src/hooks/index.ts";

describe("/instructions on the app channel", () => {
  async function dumpFile(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "prompt-test-"));
    const file = join(dir, "prompt-main.md");
    await writeFile(file, body, "utf-8");
    return file;
  }

  test("the prompt goes inline instead of being stringified into [object Object]", async () => {
    const file = await dumpFile("# Core directives\nbe useful");
    const text = await instructionsText({
      text: "Instructions de Orchestrator — 31 octets",
      attachments: [{ type: "file", path: file, filename: "prompt-main.md", mimeType: "text/markdown" }],
    });

    expect(text).not.toContain("[object Object]");
    expect(text).toContain("Instructions de Orchestrator");
    expect(text).toContain("# Core directives");
  });

  test("the temp file the helper wrote is removed, not leaked on every call", async () => {
    const file = await dumpFile("body");
    await instructionsText({ text: "summary", attachments: [{ type: "file", path: file }] });
    expect(existsSync(file)).toBe(false);
  });

  test("a refusal is plain text already and passes through untouched", async () => {
    expect(await instructionsText("agent inconnu : ghost")).toBe("agent inconnu : ghost");
  });

  test("a message without an attachment keeps its text", async () => {
    expect(await instructionsText({ text: "summary only" })).toBe("summary only");
  });

  test("an unreadable dump still answers the summary", async () => {
    // The file is gone: losing the dump must not turn the command into a dead button.
    const text = await instructionsText({
      text: "summary",
      attachments: [{ type: "file", path: join(tmpdir(), "prompt-missing", "prompt-main.md") }],
    });
    expect(text).toBe("summary");
  });

  test("the inlined body is the file's, byte for byte", async () => {
    const body = "# Available tools\n- read: read tool\n\n```\nfenced block\n```\n";
    const file = await dumpFile(body);
    const text = await instructionsText({ text: "summary", attachments: [{ type: "file", path: file }] });
    expect(text.endsWith(body)).toBe(true);
  });
});

describe("/status on the app channel", () => {
  const config = {
    llm: { defaultModel: "claude-opus-5", models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }] },
  } as unknown as MyClawConfig;

  test("the handler answers the structured payload the page draws, not just text", async () => {
    // The adapter reads `output.status` and refuses with "status unavailable" when it is absent.
    // The adapter tests stub the handler, so only the real one wired here catches that drift.
    const handler = createMyClawAppCommandHandler({
      config,
      sessionManager: new SessionManager(),
      // The status branch never reaches the picker; the menu lives behind its own frames.
      modelPicker: {} as ModelPicker,
    });

    const output = await handler("neras", "thread-status", "status", "");

    expect(output).toBeDefined();
    expect(typeof output).toBe("object");
    const report = output as { text: string; status?: { model: { current: string } } };
    expect(report.status?.model.current).toBe("claude-opus-5");
    expect(report.text).toContain("claude-opus-5");
  });
});

describe("/effort and /cap on the app channel", () => {
  const effortConfig = {
    llm: {
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 }, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] }],
    },
  } as unknown as MyClawConfig;

  function makeHandler() {
    const picker = new ModelPicker(
      [{ id: "claude-opus-5", label: "Opus 5" }],
      { enabled: true, levels: ["low", "medium", "high"] },
    );
    return createMyClawAppCommandHandler({
      config: effortConfig,
      sessionManager: new SessionManager(),
      modelPicker: picker,
    });
  }

  test("/effort without args reports the current effort and the levels", async () => {
    const handler = makeHandler();
    const output = await handler("neras", "t1", "effort", "");
    expect(output).toContain("current:");
    expect(output).toContain("low, medium, high");
  });

  test("/effort with a level pins it, and /effort reset clears it", async () => {
    const handler = makeHandler();
    const set = await handler("neras", "t1", "effort", "high");
    expect(set).toBe("Effort set to high");
    const cleared = await handler("neras", "t1", "effort", "reset");
    expect(cleared).toContain("reset");
  });

  test("/cap without args reports the window", async () => {
    const handler = makeHandler();
    const output = await handler("neras", "t1", "cap", "");
    expect(output).toContain("Context");
  });

  test("/cap full resets the window and /cap <tokens> lowers it", async () => {
    const handler = makeHandler();
    const set = await handler("neras", "t1", "cap", "128000");
    expect(set).toBe("Cap set to 128000 tokens");
    const full = await handler("neras", "t1", "cap", "full");
    expect(full).toBe("Cap set to full tokens (model window)");
  });

  test("/cap refuses a non-positive token count", async () => {
    const handler = makeHandler();
    const output = await handler("neras", "t1", "cap", "-5");
    expect(output).toContain("Unknown cap");
  });
});

describe("/model on the app channel", () => {
  const tagConfig = {
    llm: {
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }],
    },
    tags: { Cheap: { model: "claude-opus-5", effort: "low", contextCap: 700_000 } },
  } as unknown as MyClawConfig;

  async function withSession(pins: Record<string, unknown>): Promise<{ manager: SessionManager; id: string }> {
    const manager = new SessionManager();
    const id = SessionManager.resolveSessionId("my-claw-app", "dm", "neras", "neras", {
      threadId: "t1",
      sessionScope: "per-user",
    });
    const session = await manager.getOrCreateWithMeta(id, "my-claw-app", "dm");
    Object.assign(session, pins);
    await manager.persist(id);
    return { manager, id };
  }

  test("picking a tag hands the conversation's effort and ceiling to it", async () => {
    const { manager, id } = await withSession({ effortOverride: "high", contextOverride: 128_000 });
    const handler = createMyClawAppCommandHandler({
      config: tagConfig,
      sessionManager: manager,
      modelPicker: new ModelPicker([{ id: "claude-opus-5", label: "Opus 5" }, { id: "tag:Cheap", label: "Cheap", group: "Tags" }]),
    });

    await handler("neras", "t1", "model", "tag:Cheap");

    // A tag is indivisible: a leftover pin would outrank its own effort and cap
    // (docs/context-window.md), and the tag is what the owner just picked.
    const session = await manager.peek(id);
    expect(session?.modelOverride).toBe("tag:Cheap");
    expect(session?.effortOverride).toBeUndefined();
    expect(session?.contextOverride).toBeUndefined();
  });

  test("picking the default model hands back the whole combo, not just the model", async () => {
    const { manager, id } = await withSession({
      modelOverride: "tag:Cheap",
      effortOverride: "high",
      contextOverride: 64_000,
    });
    const handler = createMyClawAppCommandHandler({
      config: tagConfig,
      sessionManager: manager,
      modelPicker: new ModelPicker([{ id: "claude-opus-5", label: "Opus 5" }, { id: "tag:Cheap", label: "Cheap", group: "Tags" }]),
    });

    await handler("neras", "t1", "model", "claude-opus-5");

    const session = await manager.peek(id);
    expect(session?.modelOverride).toBeUndefined();
    expect(session?.effortOverride).toBeUndefined();
    expect(session?.contextOverride).toBeUndefined();
  });
});

describe("/new on the app channel", () => {
  const config = {
    llm: { defaultModel: "claude-opus-5", models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }] },
  } as unknown as MyClawConfig;

  function makeHandler(sessionManager: SessionManager) {
    return createMyClawAppCommandHandler({
      config,
      sessionManager,
      modelPicker: new ModelPicker([{ id: "claude-opus-5", label: "Opus 5" }]),
    });
  }

  test("creates a new empty thread without changing the current one", async () => {
    const sessionManager = new SessionManager();
    const currentThreadId = "current-thread";
    const currentSessionId = SessionManager.resolveSessionId("my-claw-app", "dm", "neras", "neras", {
      threadId: currentThreadId,
      sessionScope: "per-user",
    });
    const current = await sessionManager.getOrCreateWithMeta(currentSessionId, "my-claw-app", "dm", "sofa");
    current.modelOverride = "pinned-model";
    await sessionManager.persist(currentSessionId);

    const output = await makeHandler(sessionManager)("neras", currentThreadId, "new", "");
    expect(output).toMatchObject({ text: "New session started." });
    const newThreadId = (output as { newThreadId?: string }).newThreadId;
    expect(newThreadId).toMatch(/^[0-9a-f-]{36}$/);

    const newSessionId = SessionManager.resolveSessionId("my-claw-app", "dm", "neras", "neras", {
      threadId: newThreadId!,
      sessionScope: "per-user",
    });
    const created = await sessionManager.peek(newSessionId);
    expect(created?.workspace).toBe("sofa");
    expect(created?.modelOverride).toBeUndefined();
    expect(created?.createdAt).toBeDefined();

    const unchanged = await sessionManager.peek(currentSessionId);
    expect(unchanged?.modelOverride).toBe("pinned-model");
  });

  test("does not treat arguments as the no-argument command", async () => {
    const output = await makeHandler(new SessionManager())("neras", "current-thread", "new", "please explain");
    expect(output).toBeUndefined();
  });
});

describe("what a command writes down about itself", () => {
  /**
   * `/claude set-token <token>` hands over a live credential. The session journal masked it from
   * the start; the orchestrator log and the `command:received` hook did not, so the token sat in
   * a file kept for thirty days, readable through `logs.tail` and through the agent's own shell.
   */
  test("a credential never reaches the hook the plugins listen on", async () => {
    const seen: string[] = [];
    const listener = (payload: { args?: unknown }): void => {
      seen.push(String(payload.args ?? ""));
    };
    hooks.on("command:received", listener);
    const handler = createMyClawAppCommandHandler({
      config: { llm: { defaultModel: "claude-opus-5", models: [] } } as unknown as MyClawConfig,
      sessionManager: new SessionManager(),
      modelPicker: new ModelPicker([], { enabled: false, levels: [] }),
    });

    await handler("neras", "t-secret", "claude", "set-token sk-ant-oat01-THE-SECRET");
    hooks.off("command:received", listener);

    expect(seen.join(" ")).not.toContain("sk-ant-oat01-THE-SECRET");
    expect(seen.join(" ")).toContain("set-token [redacted]");
  });

  test("a command with nothing to hide is logged as typed", async () => {
    const seen: string[] = [];
    const listener = (payload: { args?: unknown }): void => {
      seen.push(String(payload.args ?? ""));
    };
    hooks.on("command:received", listener);
    const handler = createMyClawAppCommandHandler({
      config: { llm: { defaultModel: "claude-opus-5", models: [] } } as unknown as MyClawConfig,
      sessionManager: new SessionManager(),
      modelPicker: new ModelPicker([], { enabled: false, levels: [] }),
    });

    await handler("neras", "t-plain", "claude", "status");
    hooks.off("command:received", listener);

    expect(seen).toContain("status");
  });
});

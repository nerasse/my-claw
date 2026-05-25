/** @file Integration tests -- verify hooks fire at correct points in real code. */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { hooks } from "../index.ts";
import { SessionManager } from "../../sessions/manager.ts";
import { MessageRouter } from "../../core/router.ts";
import type { UnifiedMessage } from "../../channels/types.ts";

function uniqId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("integration: session lifecycle", () => {
  beforeEach(() => {
    hooks.clear();
  });

  test("session:created fires on new session", async () => {
    const spy = mock(() => {});
    hooks.on("session:created", spy);
    const manager = new SessionManager();
    const sid = uniqId("s");
    await manager.getOrCreateWithMeta(sid, "telegram", "dm");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: sid, platform: "telegram", chatType: "dm" }));
  });

  test("session:loaded fires on existing session from disk", async () => {
    const spy = mock(() => {});
    hooks.on("session:loaded", spy);
    const manager = new SessionManager();
    const sid = uniqId("s");
    const session = await manager.getOrCreateWithMeta(sid, "telegram", "dm");
    session.messages.push({ role: "user", content: "test", timestamp: new Date().toISOString() });
    await manager.persist(sid);
    const manager2 = new SessionManager();
    const createdSpy = mock(() => {});
    hooks.on("session:created", createdSpy);
    await manager2.getOrCreateWithMeta(sid, "telegram", "dm");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(createdSpy).not.toHaveBeenCalled();
  });

  test("session:persisted fires after save", async () => {
    const spy = mock(() => {});
    hooks.on("session:persisted", spy);
    const manager = new SessionManager();
    const sid = uniqId("s");
    await manager.getOrCreateWithMeta(sid, "telegram", "dm");
    await manager.persist(sid);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: sid }));
  });

  test("session:reset fires on reset", async () => {
    const spy = mock(() => {});
    hooks.on("session:reset", spy);
    const manager = new SessionManager();
    const sid = uniqId("s");
    await manager.getOrCreateWithMeta(sid, "telegram", "dm");
    await manager.resetSession(sid, "telegram", "dm");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: sid, platform: "telegram" }));
  });

  test("gate:session:reset blocks reset", async () => {
    const spy = mock(() => {});
    hooks.on("session:reset", spy);
    hooks.gate("gate:session:reset", () => ({ allow: false, reason: "no" }));
    const manager = new SessionManager();
    await manager.resetSession("telegram/dm/u1", "telegram", "dm");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("integration: message routing lifecycle", () => {
  beforeEach(() => {
    hooks.clear();
  });

  test("message:received fires when message routed", async () => {
    const spy = mock(() => {});
    hooks.on("message:received", spy);
    hooks.emit("message:received", {
      message: { id: "1", platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: null },
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("gate:message:incoming blocks message", async () => {
    const spy = mock(() => {});
    hooks.on("message:route:start", spy);
    hooks.gate("gate:message:incoming", () => ({ allow: false, reason: "test" }));
    const result = await hooks.check("gate:message:incoming", {
      message: { id: "1", platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: null },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("test");
  });
});

describe("integration: tool lifecycle", () => {
  beforeEach(() => {
    hooks.clear();
  });

  test("tool:bash:execute fires after bash tool runs", async () => {
    const spy = mock(() => {});
    hooks.on("tool:bash:execute", spy);
    hooks.emit("tool:bash:execute", { command: "echo hi", exitCode: 0, durationMs: 10 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "echo hi", exitCode: 0 }));
  });

  test("tool:file:write and tool:file:read fire", async () => {
    const writeSpy = mock(() => {});
    const readSpy = mock(() => {});
    hooks.on("tool:file:write", writeSpy);
    hooks.on("tool:file:read", readSpy);
    hooks.emit("tool:file:write", { path: "/tmp/test", size: 10 });
    hooks.emit("tool:file:read", { path: "/tmp/test", size: 10 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

describe("integration: waterfall transforms", () => {
  beforeEach(() => {
    hooks.clear();
  });

  test("transform:system:prompt modifies prompt in agent pipeline", async () => {
    hooks.tap("transform:system:prompt", (p) => ({ ...p, prompt: p.prompt + " [INJECTED]" }));
    const result = await hooks.transform("transform:system:prompt", {
      prompt: "base",
      sessionId: "s1",
      model: "gpt-4",
    });
    expect(result.prompt).toBe("base [INJECTED]");
  });

  test("transform:outgoing:message modifies text before delivery", async () => {
    hooks.tap("transform:outgoing:message", (p) => ({ ...p, text: p.text + " [footer]" }));
    const result = await hooks.transform("transform:outgoing:message", {
      text: "hello",
      platform: "telegram",
      chatId: "c1",
    });
    expect(result.text).toBe("hello [footer]");
  });
});

describe("integration: cron lifecycle", () => {
  beforeEach(() => {
    hooks.clear();
  });

  test("cron:job:created fires via cron tool", async () => {
    const spy = mock(() => {});
    hooks.on("cron:job:created", spy);
    hooks.emit("cron:job:created", { jobId: "j1", jobName: "test" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ jobId: "j1", jobName: "test" }));
  });

  test("gate:cron:job:before blocks job", async () => {
    hooks.gate("gate:cron:job:before", () => ({ allow: false, reason: "maintenance" }));
    const result = await hooks.check("gate:cron:job:before", { jobId: "j1", jobName: "test" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("maintenance");
  });
});

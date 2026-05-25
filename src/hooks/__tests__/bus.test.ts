/** @file Unit tests for HookBus core mechanics. */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { HookBus } from "../bus.ts";
import type { HookEventMap } from "../types.ts";

let bus: HookBus;

beforeEach(() => {
  bus = new HookBus();
});

// =============================================================================
// Void events
// =============================================================================

describe("void events", () => {
  test("emit with no handlers is a no-op", () => {
    bus.emit("app:ready", { channels: [] });
  });

  test("on registers handler, emit calls it with correct payload", () => {
    const handler = mock<(p: HookEventMap["app:ready"]) => void>(() => {});
    bus.on("app:ready", handler);
    bus.emit("app:ready", { channels: ["telegram"] });
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0]!)[0]).toEqual({ channels: ["telegram"] });
  });

  test("multiple handlers on same event all called", () => {
    const h1 = mock(() => {});
    const h2 = mock(() => {});
    bus.on("app:ready", h1);
    bus.on("app:ready", h2);
    bus.emit("app:ready", { channels: [] });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  test("handlers receive exact payload object", () => {
    const payload = { channels: ["matrix"] };
    const handler = mock((_: HookEventMap["app:ready"]) => {});
    bus.on("app:ready", handler);
    bus.emit("app:ready", payload);
    expect((handler.mock.calls[0]!)[0]).toBe(payload);
  });

  test("off removes specific handler", () => {
    const h1 = mock(() => {});
    const h2 = mock(() => {});
    bus.on("app:ready", h1);
    bus.on("app:ready", h2);
    bus.off("app:ready", h1);
    bus.emit("app:ready", { channels: [] });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  test("off with unregistered handler is a no-op", () => {
    const handler = mock(() => {});
    bus.off("app:ready", handler);
    bus.emit("app:ready", { channels: [] });
    expect(handler).not.toHaveBeenCalled();
  });

  test("clear removes all handlers on all events", () => {
    const h1 = mock(() => {});
    const h2 = mock(() => {});
    bus.on("app:ready", h1);
    bus.on("app:shutdown", h2);
    bus.clear();
    bus.emit("app:ready", { channels: [] });
    bus.emit("app:shutdown", { signal: "SIGINT" });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  test("handlers run in parallel", async () => {
    let order = "";
    const h1 = async () => {
      await new Promise((r) => setTimeout(r, 20));
      order += "A";
    };
    const h2 = async () => {
      await new Promise((r) => setTimeout(r, 10));
      order += "B";
    };
    bus.on("app:ready", h1);
    bus.on("app:ready", h2);
    bus.emit("app:ready", { channels: [] });
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toBe("BA");
  });

  test("handler error is caught and does not propagate", () => {
    const bad = () => {
      throw new Error("boom");
    };
    const good = mock(() => {});
    bus.on("app:ready", bad);
    bus.on("app:ready", good);
    expect(() => bus.emit("app:ready", { channels: [] })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  test("handler error does not prevent other handlers from running", () => {
    const bad = () => {
      throw new Error("boom");
    };
    const good = mock(() => {});
    bus.on("app:ready", bad);
    bus.on("app:ready", good);
    bus.emit("app:ready", { channels: [] });
    expect(good).toHaveBeenCalledTimes(1);
  });

  test("async handler error is caught and does not propagate", async () => {
    const bad = async () => {
      throw new Error("async boom");
    };
    const good = mock(() => {});
    bus.on("app:ready", bad);
    bus.on("app:ready", good);
    bus.emit("app:ready", { channels: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(good).toHaveBeenCalledTimes(1);
  });

  test("emit returns void (fire-and-forget)", () => {
    bus.on("app:ready", () => {});
    const result = bus.emit("app:ready", { channels: [] });
    expect(result).toBeUndefined();
  });

  test("registering during emit may be seen by current batch (JS Set behavior)", () => {
    let second = false;
    bus.on("app:ready", () => {
      bus.on("app:ready", () => {
        second = true;
      });
    });
    bus.emit("app:ready", { channels: [] });
    expect(second).toBe(true);
  });

  test("off during emit does not skip current handler", () => {
    let called = false;
    const handler = () => {
      called = true;
    };
    bus.on("app:ready", handler);
    bus.on("app:ready", () => {
      bus.off("app:ready", handler);
    });
    bus.emit("app:ready", { channels: [] });
    expect(called).toBe(true);
  });
});

// =============================================================================
// Gate events
// =============================================================================

describe("gate events", () => {
  test("check with no handlers returns allowed", async () => {
    const result = await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(result.allowed).toBe(true);
  });

  test("gate registers handler, check calls it", async () => {
    const handler = mock(() => ({ allow: true }));
    bus.gate("gate:message:incoming", handler);
    await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("handler returning allow:true -> allowed", async () => {
    bus.gate("gate:message:incoming", () => ({ allow: true }));
    const result = await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(result.allowed).toBe(true);
  });

  test("handler returning allow:false -> blocked", async () => {
    bus.gate("gate:message:incoming", () => ({ allow: false, reason: "spam" }));
    const result = await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("spam");
  });

  test("multiple handlers all allow -> allowed", async () => {
    bus.gate("gate:message:incoming", () => ({ allow: true }));
    bus.gate("gate:message:incoming", () => ({ allow: true }));
    const result = await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(result.allowed).toBe(true);
  });

  test("multiple handlers, second blocks -> blocked", async () => {
    bus.gate("gate:message:incoming", () => ({ allow: true }));
    bus.gate("gate:message:incoming", () => ({ allow: false, reason: "blocked" }));
    const result = await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("blocked");
  });

  test("first block short-circuits remaining handlers", async () => {
    const late = mock(() => ({ allow: true }));
    bus.gate("gate:message:incoming", () => ({ allow: false }));
    bus.gate("gate:message:incoming", late);
    await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(late).not.toHaveBeenCalled();
  });

  test("handlers run sequentially not parallel", async () => {
    let order = "";
    bus.gate("gate:message:incoming", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order += "A";
      return { allow: true };
    });
    bus.gate("gate:message:incoming", async () => {
      order += "B";
      return { allow: true };
    });
    await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(order).toBe("AB");
  });

  test("handler error -> fail-open (allowed)", async () => {
    bus.gate("gate:message:incoming", () => {
      throw new Error("crash");
    });
    const result = await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(result.allowed).toBe(true);
  });

  test("handler error does not prevent subsequent handlers", async () => {
    const late = mock(() => ({ allow: false, reason: "late" }));
    bus.gate("gate:message:incoming", () => {
      throw new Error("crash");
    });
    bus.gate("gate:message:incoming", late);
    const result = await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("late");
  });

  test("ungate removes specific handler", async () => {
    const h1 = mock(() => ({ allow: false }));
    const h2 = mock(() => ({ allow: true }));
    bus.gate("gate:message:incoming", h1);
    bus.gate("gate:message:incoming", h2);
    bus.ungate("gate:message:incoming", h1);
    const result = await bus.check("gate:message:incoming", {
      message: {} as HookEventMap["message:received"]["message"],
    });
    expect(result.allowed).toBe(true);
    expect(h2).toHaveBeenCalled();
  });
});

// =============================================================================
// Waterfall events
// =============================================================================

describe("waterfall events", () => {
  test("transform with no handlers returns input unchanged", async () => {
    const input = { prompt: "hello", sessionId: "s1", model: "gpt-4" };
    const result = await bus.transform("transform:system:prompt", input);
    expect(result).toBe(input);
  });

  test("tap registers handler, transform calls it", async () => {
    const handler = mock((p: { prompt: string; sessionId: string; model: string }) => ({ ...p, prompt: p.prompt + "!" }));
    bus.tap("transform:system:prompt", handler as import("../types.ts").WaterfallHandler<{ prompt: string; sessionId: string; model: string }>);
    const result = await bus.transform("transform:system:prompt", {
      prompt: "hi",
      sessionId: "s1",
      model: "gpt-4",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.prompt).toBe("hi!");
  });

  test("multiple handlers chained: each receives previous output", async () => {
    bus.tap("transform:system:prompt", (p) => ({ ...p, prompt: p.prompt + "-A" }));
    bus.tap("transform:system:prompt", (p) => ({ ...p, prompt: p.prompt + "-B" }));
    const result = await bus.transform("transform:system:prompt", {
      prompt: "x",
      sessionId: "s1",
      model: "gpt-4",
    });
    expect(result.prompt).toBe("x-A-B");
  });

  test("3 handlers: A->B->C, output is C(B(A(input)))", async () => {
    bus.tap("transform:system:prompt", (p) => ({ ...p, prompt: p.prompt + "1" }));
    bus.tap("transform:system:prompt", (p) => ({ ...p, prompt: p.prompt + "2" }));
    bus.tap("transform:system:prompt", (p) => ({ ...p, prompt: p.prompt + "3" }));
    const result = await bus.transform("transform:system:prompt", {
      prompt: "x",
      sessionId: "s1",
      model: "gpt-4",
    });
    expect(result.prompt).toBe("x123");
  });

  test("handlers run sequentially (order guaranteed)", async () => {
    let order = "";
    bus.tap("transform:system:prompt", async (p) => {
      await new Promise((r) => setTimeout(r, 20));
      order += "A";
      return p;
    });
    bus.tap("transform:system:prompt", (p) => {
      order += "B";
      return p;
    });
    await bus.transform("transform:system:prompt", {
      prompt: "x",
      sessionId: "s1",
      model: "gpt-4",
    });
    expect(order).toBe("AB");
  });

  test("handler error -> value passes through unchanged", async () => {
    bus.tap("transform:system:prompt", () => {
      throw new Error("crash");
    });
    const input = { prompt: "safe", sessionId: "s1", model: "gpt-4" };
    const result = await bus.transform("transform:system:prompt", input);
    expect(result.prompt).toBe("safe");
  });

  test("handler error in 3-handler chain: A ok, B crash, C receives A's output", async () => {
    bus.tap("transform:system:prompt", (p) => ({ ...p, prompt: p.prompt + "-A" }));
    bus.tap("transform:system:prompt", () => {
      throw new Error("crash");
    });
    bus.tap("transform:system:prompt", (p) => ({ ...p, prompt: p.prompt + "-C" }));
    const result = await bus.transform("transform:system:prompt", {
      prompt: "x",
      sessionId: "s1",
      model: "gpt-4",
    });
    expect(result.prompt).toBe("x-A-C");
  });

  test("all handlers crash -> original input returned", async () => {
    bus.tap("transform:system:prompt", () => {
      throw new Error("1");
    });
    bus.tap("transform:system:prompt", () => {
      throw new Error("2");
    });
    const input = { prompt: "original", sessionId: "s1", model: "gpt-4" };
    const result = await bus.transform("transform:system:prompt", input);
    expect(result).toBe(input);
  });

  test("untap removes specific handler", async () => {
    type W = import("../types.ts").WaterfallHandler<{ prompt: string; sessionId: string; model: string }>;
    const h1 = mock((p: { prompt: string; sessionId: string; model: string }) => ({ ...p, prompt: p.prompt + "-h1" }));
    const h2 = mock((p: { prompt: string; sessionId: string; model: string }) => ({ ...p, prompt: p.prompt + "-h2" }));
    bus.tap("transform:system:prompt", h1 as W);
    bus.tap("transform:system:prompt", h2 as W);
    bus.untap("transform:system:prompt", h1);
    const result = await bus.transform("transform:system:prompt", {
      prompt: "x",
      sessionId: "s1",
      model: "gpt-4",
    });
    expect(result.prompt).toBe("x-h2");
    expect(h2).toHaveBeenCalled();
  });
});

// =============================================================================
// Bus lifecycle
// =============================================================================

describe("bus lifecycle", () => {
  test("fresh bus has no handlers", () => {
    const fresh = new HookBus();
    let called = false;
    fresh.on("app:ready", () => {
      called = true;
    });
    fresh.emit("app:ready", { channels: [] });
    expect(called).toBe(true);
    fresh.clear();
    called = false;
    fresh.emit("app:ready", { channels: [] });
    expect(called).toBe(false);
  });

  test("multiple buses are independent", () => {
    const b1 = new HookBus();
    const b2 = new HookBus();
    let called1 = false;
    let called2 = false;
    b1.on("app:ready", () => {
      called1 = true;
    });
    b2.on("app:ready", () => {
      called2 = true;
    });
    b1.emit("app:ready", { channels: [] });
    expect(called1).toBe(true);
    expect(called2).toBe(false);
  });
});

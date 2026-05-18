import { resetCircuitBreaker } from "../../src/llm/provider.ts";

let nodeMock: typeof import("node:test")["mock"] | undefined;
try {
  const nt = await import("node:test");
  nodeMock = nt.mock;
} catch {
  nodeMock = undefined;
}

export function mockFetch(impl: typeof globalThis.fetch): { restore(): void } {
  resetCircuitBreaker();

  if (nodeMock && typeof nodeMock.method === "function") {
    const handle = nodeMock.method(globalThis, "fetch", impl as never);
    return {
      restore() {
        (handle as { mock?: { restore(): void } }).mock?.restore?.();
        resetCircuitBreaker();
      },
    };
  }

  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return {
    restore() {
      globalThis.fetch = original;
      resetCircuitBreaker();
    },
  };
}

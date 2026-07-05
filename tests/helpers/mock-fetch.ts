import { resetCircuitBreaker } from "../../src/llm/provider.ts";

let nodeMock: typeof import("node:test")["mock"] | undefined;
try {
  const nt = await import("node:test");
  nodeMock = nt.mock;
} catch {
  nodeMock = undefined;
}

// Loose fetch shape for tests: a mock only needs to accept the usual args and
// resolve a Response. The extra static members of the real `fetch` (e.g. Bun's
// `preconnect`) are irrelevant to what the code under test calls.
type FetchMockImpl = (input?: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function mockFetch(impl: FetchMockImpl): { restore(): void } {
  resetCircuitBreaker();
  const fetchImpl = impl as unknown as typeof globalThis.fetch;

  if (nodeMock && typeof nodeMock.method === "function") {
    const handle = nodeMock.method(globalThis, "fetch", fetchImpl as never);
    return {
      restore() {
        (handle as { mock?: { restore(): void } }).mock?.restore?.();
        resetCircuitBreaker();
      },
    };
  }

  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return {
    restore() {
      globalThis.fetch = original;
      resetCircuitBreaker();
    },
  };
}

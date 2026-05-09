let nodeMock: typeof import("node:test")["mock"] | undefined;
try {
  const nt = await import("node:test");
  nodeMock = nt.mock;
} catch {
  nodeMock = undefined;
}

export function mockFetch(impl: typeof globalThis.fetch): { restore(): void } {
  if (nodeMock && typeof nodeMock.method === "function") {
    const handle = nodeMock.method(globalThis, "fetch", impl as never);
    return {
      restore() {
        (handle as { mock?: { restore(): void } }).mock?.restore?.();
      },
    };
  }

  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

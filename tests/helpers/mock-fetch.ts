import { resetCircuitBreaker } from "../../src/llm/provider.ts";

// Loose fetch shape for tests: a mock only needs to accept the usual args and
// resolve a Response. The extra static members of the real `fetch` (e.g. Bun's
// `preconnect`) are irrelevant to what the code under test calls.
type FetchMockImpl = (input?: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The mocks in place, innermost last, over the fetch they replaced. A restore takes its own mock
 * out wherever it sits and puts back what is left. Each restore used to put back the fetch it had
 * found: restored out of order -- a test timed out, its abandoned body restoring after the next
 * test had mocked -- the older mock came back and outlived both, and the files after it answered
 * from a stranger's script (CI 2510; agent-scope then network-guard, 2026-10-05).
 */
const active: FetchMockImpl[] = [];
let underneath: typeof globalThis.fetch | undefined;

export function mockFetch(impl: FetchMockImpl): { restore(): void } {
  resetCircuitBreaker();
  if (active.length === 0) underneath = globalThis.fetch;
  active.push(impl);
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
  return {
    restore() {
      const at = active.lastIndexOf(impl);
      if (at !== -1) active.splice(at, 1);
      globalThis.fetch = (active.at(-1) as unknown as typeof globalThis.fetch | undefined) ?? underneath!;
      resetCircuitBreaker();
    },
  };
}

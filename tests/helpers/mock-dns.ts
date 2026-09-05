import { setHostResolver } from "../../src/tools/fetch.ts";

/**
 * A resolver for the SSRF guard, so the default suite never asks the network a question.
 *
 * The guard fails closed: a name it cannot resolve is refused, because a resolver that errors
 * here can still succeed inside fetch and hand back a private address. That makes an unmocked
 * hostname a blocked hostname the moment the machine running the tests has no DNS, which is
 * exactly the flakiness AGENTS.md forbids.
 *
 * `addresses` defaults to a public one: a test that fetches example.com is testing the tool, not
 * the guard. Tests about the guard itself pass their own, or pass `null` to make a name fail.
 */
export function mockDns(addresses: string[] | null = ["93.184.216.34"]): { restore(): void } {
  setHostResolver(hostname => {
    if (addresses === null) return Promise.reject(new Error(`ENOTFOUND ${hostname}`));
    return Promise.resolve(addresses.map(address => ({ address })));
  });
  return { restore: () => setHostResolver(null) };
}

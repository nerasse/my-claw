import { test, expect } from "bun:test";

// tests/setup-globals.ts: a unit test that reaches past loopback fails at once, with the mock to
// use, instead of passing or failing on whatever answers that day.

test("a unit test cannot reach the network", async () => {
  await expect(fetch("https://openrouter.ai/api/v1/key")).rejects.toThrow("a unit test tried to reach the network (openrouter.ai)");
  await expect(fetch(new URL("http://test/v1/chat/completions"))).rejects.toThrow("(test)");
});

test("loopback stays open: the tests that serve their own endpoint go on working", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  try {
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("ok");
  } finally {
    server.stop(true);
  }
});

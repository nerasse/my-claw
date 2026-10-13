import { describe, test, expect } from "bun:test";
import { nodeServerUrl } from "../../src/nodes/cli.ts";

describe("myclaw node cli", () => {
  test("the server URL is the given base, as a ws endpoint", () => {
    expect(nodeServerUrl("https://myclaw.example", {}, 8080)).toBe("wss://myclaw.example/node");
    expect(nodeServerUrl("http://192.168.1.10:8080/", {}, 8080)).toBe("ws://192.168.1.10:8080/node");
  });

  test("MYCLAW_PUBLIC_URL stands in when no flag is given", () => {
    expect(nodeServerUrl(undefined, { MYCLAW_PUBLIC_URL: "https://public.example/" }, 8080)).toBe("wss://public.example/node");
  });

  test("without either, it points at the daemon on loopback", () => {
    expect(nodeServerUrl(undefined, {}, 9090)).toBe("ws://127.0.0.1:9090/node");
  });
});

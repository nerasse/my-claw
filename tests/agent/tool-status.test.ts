import { expect, test, describe } from "bun:test";
import { formatToolStatus } from "../../src/agent/tool-status.ts";

describe("formatToolStatus", () => {
  test("empty array returns empty string", () => {
    expect(formatToolStatus([])).toBe("");
  });

  test("single tool with short args (full display)", () => {
    const result = formatToolStatus([{ name: "bash", arguments: { command: "ls -la" } }]);
    expect(result).toBe('\n\n```\nbash({"command":"ls -la"})\n```\n');
  });

  test("single tool with long args (>300 chars truncated to 240)", () => {
    const longValue = "x".repeat(500);
    const result = formatToolStatus([{ name: "write", arguments: { path: "/tmp/f", content: longValue } }]);
    expect(result.startsWith("\n\n```\nwrite(")).toBe(true);
    expect(result.includes("...")).toBe(true);
    expect(result.length).toBeLessThan(320);
  });

  test("multi-tool calls", () => {
    const result = formatToolStatus([
      { name: "bash", arguments: { command: "ls" } },
      { name: "read", arguments: { path: "/tmp/test.ts" } },
    ]);
    expect(result).toBe('\n\n```\nbash({"command":"ls"})\nread({"path":"/tmp/test.ts"})\n```\n');
  });
});

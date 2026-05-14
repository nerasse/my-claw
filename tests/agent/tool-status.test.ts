import { expect, test, describe } from "bun:test";
import { formatToolStatusVerbose, formatToolStatusCompact } from "../../src/agent/tool-status.ts";

describe("formatToolStatusVerbose", () => {
  test("empty array returns empty string", () => {
    expect(formatToolStatusVerbose([])).toBe("");
  });

  test("single tool with short args and timing", () => {
    const result = formatToolStatusVerbose([{ name: "bash", arguments: { command: "ls -la" }, durationMs: 120 }]);
    expect(result).toBe('\n\n```\nbash({"command":"ls -la"}) [120ms]\n```\n');
  });

  test("single tool with long args truncated", () => {
    const longValue = "x".repeat(500);
    const result = formatToolStatusVerbose([{ name: "write", arguments: { path: "/tmp/f", content: longValue }, durationMs: 45 }]);
    expect(result.startsWith("\n\n```\nwrite(")).toBe(true);
    expect(result).toContain("...");
    expect(result).toContain("[45ms]");
  });

  test("multi-tool calls with timing", () => {
    const result = formatToolStatusVerbose([
      { name: "bash", arguments: { command: "ls" }, durationMs: 120 },
      { name: "read", arguments: { path: "/tmp/test.ts" }, durationMs: 5 },
    ]);
    expect(result).toBe('\n\n```\nbash({"command":"ls"}) [120ms]\nread({"path":"/tmp/test.ts"}) [5ms]\n```\n');
  });
});

describe("formatToolStatusCompact", () => {
  test("empty array returns empty string", () => {
    expect(formatToolStatusCompact([])).toBe("");
  });

  test("single tool shows name only", () => {
    const result = formatToolStatusCompact([{ name: "bash", arguments: { command: "ls" }, durationMs: 120 }]);
    expect(result).toBe("\n\n> bash\n");
  });

  test("multi-tool shows comma-separated names", () => {
    const result = formatToolStatusCompact([
      { name: "bash", arguments: { command: "ls" }, durationMs: 100 },
      { name: "read", arguments: { path: "/tmp" }, durationMs: 50 },
    ]);
    expect(result).toBe("\n\n> bash, read\n");
  });
});

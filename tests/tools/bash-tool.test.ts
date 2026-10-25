import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { bashTool, bashEnv, exitOneMeaning, setBashEnvPassthrough, DEFAULT_PASSTHROUGH } from "../../src/tools/bash.ts";

test("bash: runs simple echo command", async () => {
  const result = await bashTool.execute({ command: "echo hello" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("hello"));
});

test("bash: failed command returns success false with exit code", async () => {
  const result = await bashTool.execute({ command: "exit 42" });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("exit code"));
});

test("bash: empty command returns success false", async () => {
  const result = await bashTool.execute({ command: "" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("required"));
});

test("bash: captures stderr", async () => {
  const result = await bashTool.execute({ command: "echo oops >&2" });
  assert.ok(result.output.includes("STDERR"));
});

test("bash: respects __workspaceDir for cwd", async () => {
  const result = await bashTool.execute({ command: "pwd", __workspaceDir: "/tmp" });
  assert.ok(result.success);
  assert.ok(result.output.trim().startsWith("/tmp"));
});

test("bash: absolute workdir sets cwd", async () => {
  const result = await bashTool.execute({ command: "pwd", workdir: "/tmp" });
  assert.ok(result.success);
  assert.ok(result.output.trim().startsWith("/tmp"));
});

test("bash: relative workdir resolves against workspace", async () => {
  const result = await bashTool.execute({ command: "pwd", workdir: ".", __workspaceDir: "/tmp" });
  assert.ok(result.success);
  assert.ok(result.output.trim().startsWith("/tmp"));
});

test("bash: non-existent workdir fails cleanly", async () => {
  const result = await bashTool.execute({ command: "pwd", workdir: "/no/such/dir/xyz" });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("does not exist"));
});

test("bash: a command does not see the provider keys the process holds", async () => {
  // Bun.spawn without `env` hands the child the whole process environment, and this host loads its
  // keys from an .env: every provider credential was one `echo` away. The model writes these
  // commands -- a page it was asked to read only has to suggest one.
  process.env.GROQ_API_KEY = "gsk-should-not-leak";
  process.env.LITELLM_API_KEY = "sk-should-not-leak";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-should-not-leak";
  process.env.FORGEJO_TOKEN = "forgejo-must-stay";
  try {
    const result = await bashTool.execute({ command: "env" });
    assert.equal(result.success, true);
    assert.ok(!result.output.includes("should-not-leak"), "no provider key reaches the shell");
    // The release channel: 36 references across the skills read it, and it is not an escalation.
    assert.ok(result.output.includes("forgejo-must-stay"), "the service token the skills drive stays");
    // A shell still has to behave like one.
    assert.match(result.output, /^PATH=/m);
    assert.match(result.output, /^HOME=/m);
  } finally {
    delete process.env.GROQ_API_KEY;
    delete process.env.LITELLM_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.FORGEJO_TOKEN;
  }
});

test("bash: the passthrough list is what the owner configured", async () => {
  process.env.MY_OWN_SERVICE_TOKEN = "wired-by-the-owner";
  setBashEnvPassthrough(["MY_OWN_SERVICE_TOKEN"]);
  try {
    const result = await bashTool.execute({ command: "env" });
    assert.ok(result.output.includes("wired-by-the-owner"));
  } finally {
    setBashEnvPassthrough(undefined);
    delete process.env.MY_OWN_SERVICE_TOKEN;
  }
});

test("bashEnv: locale and desktop wiring pass, anything else has to be named", () => {
  const env = bashEnv(
    { LC_ALL: "fr_FR.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000", SOME_SECRET: "no", FORGEJO_URL: "https://git" },
    DEFAULT_PASSTHROUGH,
  );
  assert.equal(env.LC_ALL, "fr_FR.UTF-8");
  assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(env.FORGEJO_URL, "https://git");
  assert.equal(env.SOME_SECRET, undefined);
});

test("bash: a search that finds nothing is an answer, not a failure", async () => {
  for (const command of ["grep nothing-here /dev/null", "grep -E 'a|b' /dev/null", "cd /tmp && grep -c zzz /dev/null 2>&1"]) {
    const result = await bashTool.execute({ command });
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("no-match");
    expect(result.output).toContain("[exit 1: no match]");
  }
});

test("bash: a diff that finds differences keeps them and is not a failure", async () => {
  const result = await bashTool.execute({ command: "diff <(echo a) <(echo b)" });
  expect(result.success).toBe(true);
  expect(result.outcome).toBe("differ");
  expect(result.output).toContain("< a");
});

test("bash: exit 1 stays a failure when the search is not the last command, or wrote to stderr", async () => {
  expect((await bashTool.execute({ command: "grep -q nope /dev/null && echo found" })).success).toBe(false);
  expect((await bashTool.execute({ command: "echo oops >&2; grep nope /dev/null" })).success).toBe(false);
  expect((await bashTool.execute({ command: "false" })).success).toBe(false);
});

test("bash: exitOneMeaning reads the last simple command", () => {
  expect(exitOneMeaning("rg -n 'foo|bar' src | head")).toBe(undefined);
  expect(exitOneMeaning("cd x && rg -n 'foo|bar' src")).toBe("no-match");
  expect(exitOneMeaning("LC_ALL=C sudo grep x f")).toBe("no-match");
  expect(exitOneMeaning("timeout 5 /usr/bin/grep x f")).toBe("no-match");
  expect(exitOneMeaning("git --no-pager -C repo grep foo")).toBe("no-match");
  expect(exitOneMeaning("git diff --quiet")).toBe("differ");
  expect(exitOneMeaning("git status")).toBe(undefined);
  expect(exitOneMeaning("for f in *; do grep x $f; done")).toBe(undefined);
  expect(exitOneMeaning("echo 'a; grep'")).toBe(undefined);
});

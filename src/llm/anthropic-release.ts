/**
 * The three values a subscription request claims about the client it pretends to be.
 *
 * **Pinned on purpose, and pinned together.** They ship as one CLI release, so a user-agent from
 * one release beside a stainless package version from another is an inconsistency the account does
 * not need to advertise. Deriving them at runtime was considered and rejected: it would make the
 * request shape depend on whichever `claude` happens to sit on the box, so an unrelated CLI upgrade
 * would silently change what we send.
 *
 * How to refresh, when a capture shows drift:
 *
 * 1. `scripts/capture-anthropic-proxy.ts`, then drive `claude -p` through it
 * 2. read `user-agent`, `x-stainless-package-version` and `x-stainless-runtime-version` off the
 *    captured request and replace all three here, never one at a time
 * 3. re-run `tests/llm/anthropic-capture-parity.test.ts` against the new artifact
 *
 * `ANTHROPIC_CLI_VERSION` and `ANTHROPIC_USER_AGENT` override without a rebuild. The node version
 * is the runtime the CLI bundles, not the one we run: my-claw is on Bun.
 *
 * Its own module because both halves of the subscription need it and they cannot import each other:
 * the transport asks `claude-auth` for a token, and `claude-auth` speaks to the OAuth endpoints as
 * the same client.
 */
export const CLI_RELEASE = {
  version: process.env["ANTHROPIC_CLI_VERSION"] || "2.1.261",
  stainlessPackage: "0.112.1",
  nodeVersion: "v26.3.0",
} as const;

export const CLAUDE_USER_AGENT = process.env["ANTHROPIC_USER_AGENT"] || `claude-cli/${CLI_RELEASE.version} (external, sdk-cli)`;

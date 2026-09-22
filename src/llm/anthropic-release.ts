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
 * The version is resolved per request (`claudeRelease`), so `ANTHROPIC_CLI_VERSION` and
 * `ANTHROPIC_USER_AGENT` in `~/.my-claw/.env` apply on the next call of a run in flight -- the
 * Anthropic account gates a new model on the claimed client version (measured 2026-09-22:
 * `claude_code_version_too_old` on `claude-opus-5-5` below 2.1.280, the same gate that rejected
 * cc_version 2.1.217 below 2.1.251), and waiting for a release to say 2.1.280 is not a reason to
 * wait for a release. The override moves `version` and the derived user-agent only; the stainless
 * pair is untouched, which the 2.1.280 capture confirms is harmless: 2.1.261 and 2.1.280 ship the
 * same `0.112.1` and `v26.3.0`.
 *
 * The node version is the runtime the CLI bundles, not the one we run: my-claw is on Bun.
 *
 * Its own module because both halves of the subscription need it and they cannot import each other:
 * the transport asks `claude-auth` for a token, and `claude-auth` speaks to the OAuth endpoints as
 * the same client.
 */
import { refreshEnvFile } from "../core/config.ts";

export const CLI_RELEASE = {
  version: "2.1.280",
  stainlessPackage: "0.112.1",
  nodeVersion: "v26.3.0",
} as const;

/** The claimed client release, with the `.env` levers applied as of now. */
export function claudeRelease(): { version: string; stainlessPackage: string; nodeVersion: string } {
  refreshEnvFile();
  return {
    version: process.env["ANTHROPIC_CLI_VERSION"] || CLI_RELEASE.version,
    stainlessPackage: CLI_RELEASE.stainlessPackage,
    nodeVersion: CLI_RELEASE.nodeVersion,
  };
}

/**
 * What a subscription request would claim right now, and where the number comes from. This is the
 * claim, not the file: `version` is what goes on the wire, `pinned` is the captured trio, and
 * `overridden` says `.env` is steering. The owner asked to set the version from the provider page
 * (2026-09-22) because a new model is gated on it and a release must not be the only lever.
 */
export function claudeClaim(): { version: string; pinned: string; overridden: boolean } {
  refreshEnvFile();
  return {
    version: claudeRelease().version,
    pinned: CLI_RELEASE.version,
    overridden: process.env["ANTHROPIC_CLI_VERSION"] !== undefined,
  };
}

export function claudeUserAgent(): string {
  refreshEnvFile();
  const explicit = process.env["ANTHROPIC_USER_AGENT"];
  if (explicit) return explicit;
  return `claude-cli/${claudeRelease().version} (external, sdk-cli)`;
}

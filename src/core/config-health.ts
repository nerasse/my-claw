/** @file A/B boot confirmation: decide what to do when a config never becomes healthy. */

import { bumpStrike, hasEverBeenConfirmed } from "./config-store.ts";

/** Unhealthy verdicts on the same content before it is reverted. Two, so a transient failure at
 *  boot (network down while the channel connects) costs one retry instead of a rollback. */
export const MAX_STRIKES = 2;

export interface HealthInput {
  /** The config declares at least one enabled channel. */
  expectsChannel: boolean;
  /** Channels currently up, as tracked from channel:started / :stopped / :error. */
  liveChannels: number;
}

/**
 * "Booted" is not "works": the case the whole loop exists for is a config that parses, starts, and
 * leaves the owner with no way to reach the agent. A config that enables no channel at all is
 * healthy on uptime alone -- otherwise a deliberately channel-less setup would revert forever.
 */
export function isHealthy(input: HealthInput): boolean {
  return !input.expectsChannel || input.liveChannels > 0;
}

export type HealthOutcome =
  | { action: "confirm" }
  | { action: "retry"; strikes: number; reason: string }
  | { action: "quarantine"; strikes: number; reason: string }
  | { action: "warn"; reason: string };

export interface HealthDecision {
  healthy: boolean;
  currentSha: string;
  /** Content of the last confirmed snapshot, or null when there is nothing to fall back to. */
  confirmedSha: string | null;
  /** systemd sets INVOCATION_ID. Without a supervisor, exiting would leave nothing running. */
  underServiceManager: boolean;
}

/**
 * The verdict at the end of the health window. Restarting is only ever proposed when there is a
 * better config to land on, so an unrecoverable situation degrades to a warning instead of a boot
 * loop that would replace a broken channel with no agent at all.
 */
export async function decideAfterHealthGate(d: HealthDecision): Promise<HealthOutcome> {
  if (d.healthy) return { action: "confirm" };

  if (!d.confirmedSha || d.confirmedSha === d.currentSha) {
    return { action: "warn", reason: "aucune version confirmée différente vers laquelle revenir" };
  }
  if (await hasEverBeenConfirmed(d.currentSha)) {
    return { action: "warn", reason: "cette config a déjà fonctionné : panne d'environnement plutôt que de config" };
  }
  if (!d.underServiceManager) {
    return { action: "warn", reason: "pas de superviseur : un redémarrage laisserait la machine sans agent" };
  }

  const strikes = await bumpStrike(d.currentSha);
  const reason = `aucun canal actif ${strikes} fois de suite sur cette config`;
  return strikes >= MAX_STRIKES ? { action: "quarantine", strikes, reason } : { action: "retry", strikes, reason };
}

import type { AvailabilityWorld } from "./run-model.ts";

/**
 * Everything is runnable and no provider has testified. This is what resolution sees before boot
 * wires the real world in, and it is deliberately the *permissive* answer: a resolution that runs
 * early must behave exactly as it did before availability existed, never hide a model because the
 * catalog has not spoken yet.
 */
export const PERMISSIVE_WORLD: AvailabilityWorld = {
  answered: () => false,
  listedBy: () => new Set(),
  // Not `process.env`: reading the real environment here would make this world judge a key-less
  // provider unrunnable, which is the opposite of permissive and would silently move a run onto
  // another model. The real environment is read by the world boot installs.
  hasEnv: () => true,
  claudeAuth: true,
  codexAuth: true,
};

let current: () => AvailabilityWorld = () => PERMISSIVE_WORLD;

/**
 * Boot hands in a reader over the live catalog and the two subscription auth states. A function
 * rather than a value: the catalog refreshes and a token can be pasted mid-process, and a snapshot
 * captured at boot would make the picker wrong for the rest of the run.
 */
export function setAvailabilityWorld(reader: () => AvailabilityWorld): void {
  current = reader;
}

export function availabilityWorld(): AvailabilityWorld {
  return current();
}

/** Test seam: module state is shared by every test file, so it is reset centrally. */
export function resetAvailabilityWorld(): void {
  current = () => PERMISSIVE_WORLD;
}

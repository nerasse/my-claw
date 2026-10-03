import { afterEach, describe, expect, it } from "bun:test";
import { runRegistry } from "../../src/core/run-registry.ts";
import { COMPOSE_UPDATE, requestSelfUpdate, type UnitStarter } from "../../src/core/self-update.ts";

/**
 * The gate on the server's side of the update button.
 *
 * The unit itself is systemd's problem; what is tested here is the only decision this module
 * makes, which is whether to ask at all, and how it reads the refusal it gets back.
 */

afterEach(() => {
  runRegistry.clear();
});

function starter(code: number, stderr = ""): { run: UnitStarter; units: string[] } {
  const units: string[] = [];
  return {
    units,
    run: async (unit) => {
      units.push(unit);
      return { code, stderr };
    },
  };
}

describe("requestSelfUpdate", () => {
  it("starts the maintenance unit when nothing is running", async () => {
    const { run, units } = starter(0);
    await expect(requestSelfUpdate(run)).resolves.toEqual({ started: true });
    expect(units).toEqual(["my-claw-auto-update.service"]);
  });

  it("refuses while a run is in flight, and never touches systemd", async () => {
    const { run, units } = starter(0);
    const { end } = runRegistry.startRoot("session-1");
    try {
      expect(await requestSelfUpdate(run)).toEqual({ started: false, reason: "busy" });
      expect(units).toEqual([]);
    } finally {
      end();
    }
  });

  it("lets the update through once the run has ended", async () => {
    const { run } = starter(0);
    const { end } = runRegistry.startRoot("session-1");
    end();
    expect(await requestSelfUpdate(run)).toEqual({ started: true });
  });

  it("tells a missing privilege apart from a broken unit", async () => {
    const denied = starter(1, "sudo: a password is required");
    expect(await requestSelfUpdate(denied.run)).toEqual({
      started: false,
      reason: "denied",
      detail: "sudo: a password is required",
    });

    const failed = starter(1, "Failed to start my-claw-auto-update.service: Unit not found.");
    expect(await requestSelfUpdate(failed.run)).toEqual({
      started: false,
      reason: "failed",
      detail: "Failed to start my-claw-auto-update.service: Unit not found.",
    });
  });

  it("reports a starter that throws rather than claiming an update", async () => {
    const outcome = await requestSelfUpdate(() => Promise.reject(new Error("no systemctl")));
    expect(outcome.started).toBe(false);
    expect(outcome.reason).toBe("failed");
    expect(outcome.detail).toContain("no systemctl");
  });

  it("never starts a unit on a compose install, and says how it is updated", async () => {
    const run = starter(0);
    const outcome = await requestSelfUpdate(run.run, "compose");
    expect(outcome).toEqual({ started: false, reason: "failed", detail: COMPOSE_UPDATE });
    expect(run.units).toEqual([]);
  });
});

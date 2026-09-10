/**
 * Removing a provider from the app.
 *
 * Two things here were wrong in the field, and both made the button look dead. The refusal listed
 * the blocking declarations in the server log only -- on screen it read "providers.remove failed",
 * which names nothing to fix. And there was no way to accept the cascade, so the refusal was the
 * end of the road: the owner hand-edited config.json instead, which is exactly how a curated model
 * ends up under a provider that no longer exists (commandcode, 2026-09-09).
 */

import { test, expect } from "bun:test";
import { refusalFrame } from "../../../src/channels/my-claw-app/adapter.ts";
import { handleProviderRemove } from "../../../src/channels/my-claw-app/settings-handlers.ts";
import type { MyClawAppSettingsDeps } from "../../../src/channels/my-claw-app/settings-handlers.ts";
import type { MyClawAppServerFrame } from "../../../src/channels/my-claw-app/types.ts";

const WS = { data: { owner: "neras", deviceId: "d1" } } as never;

function deps(remove: (key: string, withModels?: boolean) => Promise<unknown>): {
  d: MyClawAppSettingsDeps;
  sent: MyClawAppServerFrame[];
  broadcast: MyClawAppServerFrame[];
} {
  const sent: MyClawAppServerFrame[] = [];
  const broadcast: MyClawAppServerFrame[] = [];
  const d = {
    providers: { remove },
    sendFrame: (_ws: unknown, frame: MyClawAppServerFrame) => sent.push(frame),
    broadcastFrame: (_owner: string, frame: MyClawAppServerFrame) => broadcast.push(frame),
    // The adapter's own frame builder, so the assertion covers the code that ships.
    refuse: async (_ws: unknown, scope: string, message: string, data?: Record<string, unknown>) => {
      sent.push(refusalFrame(scope as never, message, data));
    },
    sessionIdOf: () => ({}),
  } as unknown as MyClawAppSettingsDeps;
  return { d, sent, broadcast };
}

test("the refusal carries the reason, not just the operation that failed", async () => {
  const { d, sent } = deps(async () => {
    throw new Error("Cannot remove commandcode: still referenced by curated model commandcode/deepseek/deepseek-v4-flash-vision-exp");
  });
  await handleProviderRemove(d, WS, { type: "providers.remove", key: "commandcode" } as never);
  const frame = sent[0] as { type: string; message: string; detail?: string };
  expect(frame.type).toBe("error");
  expect(frame.message).toBe("providers.remove failed");
  expect(frame.detail).toContain("curated model commandcode/deepseek/deepseek-v4-flash-vision-exp");
});

test("the cascade flag reaches the controller, and its answer goes back to the owner", async () => {
  const calls: Array<[string, boolean | undefined]> = [];
  const { d, broadcast, sent } = deps(async (key, withModels) => {
    calls.push([key, withModels]);
    return { type: "agents.config.result", defaultModel: "", defaultEffort: "", effortLevels: [], fallback: "", providers: [], agents: [] };
  });
  await handleProviderRemove(d, WS, { type: "providers.remove", key: "commandcode", withModels: true } as never);
  expect(calls).toEqual([["commandcode", true]]);
  expect(broadcast[0]?.type).toBe("agents.config.result");
  expect(sent).toHaveLength(0);
});

test("without the flag it is the plain removal", async () => {
  const calls: Array<[string, boolean | undefined]> = [];
  const { d } = deps(async (key, withModels) => {
    calls.push([key, withModels]);
    return { type: "agents.config.result", defaultModel: "", defaultEffort: "", effortLevels: [], fallback: "", providers: [], agents: [] };
  });
  await handleProviderRemove(d, WS, { type: "providers.remove", key: "groq" } as never);
  expect(calls).toEqual([["groq", false]]);
});

import { describe, test, expect } from "bun:test";
import type { MatrixClient } from "matrix-js-sdk";
import { MatrixReactionManager } from "../../src/channels/matrix/reactions.ts";
import { MATRIX_REACTION_BUTTON_EMOJIS } from "../../src/channels/matrix/actions.ts";

function managerWithSpy(enabled = true): { manager: MatrixReactionManager; keys: string[] } {
  const keys: string[] = [];
  const client = {
    sendEvent: (_roomId: string, _type: string, content: Record<string, unknown>) => {
      const relates = content["m.relates_to"] as { key: string };
      keys.push(relates.key);
      return Promise.resolve({ event_id: `$r${keys.length}` });
    },
  } as unknown as MatrixClient;
  return {
    manager: new MatrixReactionManager(client, { enabled, emojis: {} as never }),
    keys,
  };
}

describe("seedChoices", () => {
  test("seeds one reaction per option past the tenth", async () => {
    // The clickable reactions used to stop at ten while the menu listed more options, so options
    // 11+ could only be picked by typing.
    const { manager, keys } = managerWithSpy();
    const ids = await manager.seedChoices("!room:test", "$menu", 12);
    expect(ids).toHaveLength(12);
    expect(keys[9]).toBe("\u{1F51F}");
    expect(keys[10]).toBe("\u{1F1E6}");
    expect(keys[11]).toBe("\u{1F1E7}");
  });

  test("caps at the number of available symbols", async () => {
    const { manager, keys } = managerWithSpy();
    const ids = await manager.seedChoices("!room:test", "$menu", MATRIX_REACTION_BUTTON_EMOJIS.length + 5);
    expect(ids).toHaveLength(MATRIX_REACTION_BUTTON_EMOJIS.length);
    expect(keys.at(-1)).toBe("\u{1F1FF}");
  });

  test("seeds nothing when reactions are disabled", async () => {
    const { manager, keys } = managerWithSpy(false);
    expect(await manager.seedChoices("!room:test", "$menu", 12)).toEqual([]);
    expect(keys).toHaveLength(0);
  });
});

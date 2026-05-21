import { describe, test, expect } from "bun:test";
import {
  extractReactionAnnotation,
  resolveActionForReaction,
  resolveActionForTextReply,
  pendingActionKey,
  rememberPendingAction,
  resolvePendingAction,
  prunePendingActions,
  MATRIX_REACTION_BUTTON_EMOJIS,
} from "../../src/channels/matrix/actions.ts";
import type { ConfirmationButton } from "../../src/channels/types.ts";
import type { PendingMatrixAction } from "../../src/channels/matrix/types.ts";

const buttons: ConfirmationButton[] = [
  { label: "Approve", action: "approve" },
  { label: "Deny", action: "deny" },
];

describe("extractReactionAnnotation", () => {
  test("valid annotation content returns eventId and key", () => {
    const content = {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$abc123",
        key: "thumbsup",
      },
    };
    expect(extractReactionAnnotation(content)).toEqual({
      eventId: "$abc123",
      key: "thumbsup",
    });
  });

  test("missing m.relates_to returns undefined", () => {
    expect(extractReactionAnnotation({})).toBeUndefined();
  });

  test("wrong rel_type returns undefined", () => {
    const content = {
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: "$abc123",
        key: "thumbsup",
      },
    };
    expect(extractReactionAnnotation(content)).toBeUndefined();
  });

  test("missing event_id returns undefined", () => {
    const content = {
      "m.relates_to": {
        rel_type: "m.annotation",
        key: "thumbsup",
      },
    };
    expect(extractReactionAnnotation(content)).toBeUndefined();
  });

  test("missing key returns undefined", () => {
    const content = {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$abc123",
      },
    };
    expect(extractReactionAnnotation(content)).toBeUndefined();
  });
});

describe("resolveActionForReaction", () => {
  test("first emoji maps to first button action", () => {
    expect(resolveActionForReaction(buttons, MATRIX_REACTION_BUTTON_EMOJIS[0])).toBe("approve");
  });

  test("second emoji maps to second button action", () => {
    expect(resolveActionForReaction(buttons, MATRIX_REACTION_BUTTON_EMOJIS[1])).toBe("deny");
  });

  test("unknown emoji returns undefined", () => {
    expect(resolveActionForReaction(buttons, "unknown-emoji")).toBeUndefined();
  });

  test("emoji index beyond buttons length returns undefined", () => {
    expect(resolveActionForReaction(buttons, MATRIX_REACTION_BUTTON_EMOJIS[5])).toBeUndefined();
  });
});

describe("resolveActionForTextReply", () => {
  test("'1' maps to first button action", () => {
    expect(resolveActionForTextReply(buttons, "1")).toBe("approve");
  });

  test("'/2' maps to second button action", () => {
    expect(resolveActionForTextReply(buttons, "/2")).toBe("deny");
  });

  test("'1.' maps to first button action", () => {
    expect(resolveActionForTextReply(buttons, "1.")).toBe("approve");
  });

  test("'1)' maps to first button action", () => {
    expect(resolveActionForTextReply(buttons, "1)")).toBe("approve");
  });

  test("label match is case insensitive", () => {
    expect(resolveActionForTextReply(buttons, "approve")).toBe("approve");
    expect(resolveActionForTextReply(buttons, "APPROVE")).toBe("approve");
    expect(resolveActionForTextReply(buttons, "Deny")).toBe("deny");
  });

  test("empty text returns undefined", () => {
    expect(resolveActionForTextReply(buttons, "")).toBeUndefined();
    expect(resolveActionForTextReply(buttons, "   ")).toBeUndefined();
  });

  test("non-matching text returns undefined", () => {
    expect(resolveActionForTextReply(buttons, "something else")).toBeUndefined();
  });
});

describe("pendingActionKey", () => {
  test("formats as roomId:eventId", () => {
    expect(pendingActionKey("!room:server", "$event123")).toBe("!room:server:$event123");
  });
});

describe("rememberPendingAction", () => {
  test("stores action and can be resolved", () => {
    const pendingActions = new Map<string, PendingMatrixAction>();
    rememberPendingAction({
      pendingActions,
      roomId: "!room:server",
      eventId: "$ev1",
      buttons,
      ttlMs: 60_000,
      limit: 10,
    });
    const resolved = resolvePendingAction(pendingActions, "!room:server", "$ev1");
    expect(resolved).toBeDefined();
    expect(resolved!.buttons).toEqual(buttons);
    expect(resolved!.roomId).toBe("!room:server");
    expect(resolved!.eventId).toBe("$ev1");
  });

  test("empty buttons deletes existing action", () => {
    const pendingActions = new Map<string, PendingMatrixAction>();
    rememberPendingAction({
      pendingActions,
      roomId: "!room:server",
      eventId: "$ev1",
      buttons,
      ttlMs: 60_000,
      limit: 10,
    });
    expect(pendingActions.size).toBe(1);

    rememberPendingAction({
      pendingActions,
      roomId: "!room:server",
      eventId: "$ev1",
      buttons: [],
      ttlMs: 60_000,
      limit: 10,
    });
    expect(pendingActions.size).toBe(0);
  });

  test("respects limit by pruning oldest entries", () => {
    const pendingActions = new Map<string, PendingMatrixAction>();
    for (let i = 0; i < 5; i++) {
      rememberPendingAction({
        pendingActions,
        roomId: "!room:server",
        eventId: `$ev${i}`,
        buttons,
        ttlMs: 60_000,
        limit: 3,
      });
    }
    expect(pendingActions.size).toBe(3);
    expect(resolvePendingAction(pendingActions, "!room:server", "$ev0")).toBeUndefined();
    expect(resolvePendingAction(pendingActions, "!room:server", "$ev1")).toBeUndefined();
    expect(resolvePendingAction(pendingActions, "!room:server", "$ev4")).toBeDefined();
  });
});

describe("resolvePendingAction", () => {
  test("returns action if exists and not expired", () => {
    const pendingActions = new Map<string, PendingMatrixAction>();
    const key = pendingActionKey("!room:server", "$ev1");
    pendingActions.set(key, {
      roomId: "!room:server",
      eventId: "$ev1",
      buttons,
      expiresAt: Date.now() + 60_000,
    });
    const result = resolvePendingAction(pendingActions, "!room:server", "$ev1");
    expect(result).toBeDefined();
    expect(result!.eventId).toBe("$ev1");
  });

  test("returns undefined if expired", () => {
    const pendingActions = new Map<string, PendingMatrixAction>();
    const key = pendingActionKey("!room:server", "$ev1");
    pendingActions.set(key, {
      roomId: "!room:server",
      eventId: "$ev1",
      buttons,
      expiresAt: Date.now() - 1000,
    });
    expect(resolvePendingAction(pendingActions, "!room:server", "$ev1")).toBeUndefined();
    expect(pendingActions.has(key)).toBe(false);
  });

  test("returns undefined if not found", () => {
    const pendingActions = new Map<string, PendingMatrixAction>();
    expect(resolvePendingAction(pendingActions, "!room:server", "$missing")).toBeUndefined();
  });
});

describe("prunePendingActions", () => {
  test("removes expired entries", () => {
    const pendingActions = new Map<string, PendingMatrixAction>();
    pendingActions.set("expired", {
      roomId: "!room:server",
      eventId: "$old",
      buttons,
      expiresAt: Date.now() - 1000,
    });
    pendingActions.set("also-expired", {
      roomId: "!room:server",
      eventId: "$older",
      buttons,
      expiresAt: Date.now() - 5000,
    });
    prunePendingActions(pendingActions);
    expect(pendingActions.size).toBe(0);
  });

  test("keeps non-expired entries", () => {
    const pendingActions = new Map<string, PendingMatrixAction>();
    pendingActions.set("valid", {
      roomId: "!room:server",
      eventId: "$fresh",
      buttons,
      expiresAt: Date.now() + 60_000,
    });
    pendingActions.set("expired", {
      roomId: "!room:server",
      eventId: "$old",
      buttons,
      expiresAt: Date.now() - 1000,
    });
    prunePendingActions(pendingActions);
    expect(pendingActions.size).toBe(1);
    expect(pendingActions.has("valid")).toBe(true);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  isDirectMessage,
  isAllowedByPolicy,
  isRoomAllowed,
  resolveRoomConfig,
  resolveAutoJoinAllowed,
} from "../src/channels/matrix/policy.ts";
import type { MatrixChannelConfig } from "../src/core/config.ts";

test("isDirectMessage: returns true when room has DM inviter", () => {
  const room = {
    getDMInviter: () => "@alice:example.org",
    getJoinedMembers: () => [{ userId: "@alice:example.org" }, { userId: "@bot:example.org" }],
  } as unknown as import("matrix-js-sdk").Room;

  assert.equal(isDirectMessage(room, "@bot:example.org"), true);
});

test("isDirectMessage: returns false for 2-member room without DM inviter", () => {
  const room = {
    getDMInviter: () => undefined,
    getJoinedMembers: () => [{ userId: "@alice:example.org" }, { userId: "@bot:example.org" }],
  } as unknown as import("matrix-js-sdk").Room;

  assert.equal(isDirectMessage(room, "@bot:example.org"), false);
});

test("isDirectMessage: returns false for multi-member room", () => {
  const room = {
    getDMInviter: () => undefined,
    getJoinedMembers: () => [
      { userId: "@alice:example.org" },
      { userId: "@bob:example.org" },
      { userId: "@bot:example.org" },
    ],
  } as unknown as import("matrix-js-sdk").Room;

  assert.equal(isDirectMessage(room, "@bot:example.org"), false);
});

test("isDirectMessage: returns false for empty room", () => {
  const room = {
    getDMInviter: () => undefined,
    getJoinedMembers: () => [],
  } as unknown as import("matrix-js-sdk").Room;

  assert.equal(isDirectMessage(room, "@bot:example.org"), false);
});

test("resolveAutoJoinAllowed: roomId allowlist works", () => {
  const config: MatrixChannelConfig = {
    homeserver: "https://example.org",
    accessToken: "",
    autoJoin: "allowlist",
    autoJoinAllowlist: ["!room1:example.org"],
  };

  assert.equal(resolveAutoJoinAllowed("!room1:example.org", config), true);
  assert.equal(resolveAutoJoinAllowed("!room2:example.org", config), false);
});

test("resolveAutoJoinAllowed: inviter in dm.allowFrom is allowed", () => {
  const config: MatrixChannelConfig = {
    homeserver: "https://example.org",
    accessToken: "",
    autoJoin: "allowlist",
    dm: { allowFrom: ["@alice:example.org"] },
    groupAllowFrom: ["@bob:example.org"],
    groups: {},
  };

  assert.equal(resolveAutoJoinAllowed("!room:example.org", config, "@alice:example.org"), true);
  assert.equal(resolveAutoJoinAllowed("!room:example.org", config, "@unknown:example.org"), false);
});

test("resolveAutoJoinAllowed: inviter in groupAllowFrom is allowed", () => {
  const config: MatrixChannelConfig = {
    homeserver: "https://example.org",
    accessToken: "",
    autoJoin: "allowlist",
    groupAllowFrom: ["@alice:example.org"],
    groups: {},
  };

  assert.equal(resolveAutoJoinAllowed("!room:example.org", config, "@alice:example.org"), true);
  assert.equal(resolveAutoJoinAllowed("!room:example.org", config, "@unknown:example.org"), false);
});

test("resolveAutoJoinAllowed: inviter in groups[*].users is allowed", () => {
  const config: MatrixChannelConfig = {
    homeserver: "https://example.org",
    accessToken: "",
    autoJoin: "allowlist",
    groups: {
      "*": { users: ["@alice:example.org"] },
    },
  };

  assert.equal(resolveAutoJoinAllowed("!room:example.org", config, "@alice:example.org"), true);
  assert.equal(resolveAutoJoinAllowed("!room:example.org", config, "@unknown:example.org"), false);
});

test("isAllowedByPolicy: DM allowlist only allows listed users", () => {
  const config: MatrixChannelConfig = {
    homeserver: "https://example.org",
    accessToken: "",
    dm: { policy: "allowlist", allowFrom: ["@alice:example.org"] },
    groupPolicy: "allowlist",
  };

  const roomConfig = resolveRoomConfig(config, "!room:example.org");
  const whitelist = new Set<string>();

  assert.equal(isAllowedByPolicy(config, whitelist, roomConfig, "@alice:example.org", "dm"), true);
  assert.equal(isAllowedByPolicy(config, whitelist, roomConfig, "@unknown:example.org", "dm"), false);
});

test("isAllowedByPolicy: whitelist bypasses all checks", () => {
  const config: MatrixChannelConfig = {
    homeserver: "https://example.org",
    accessToken: "",
    dm: { policy: "disabled" },
    groupPolicy: "disabled",
  };

  const roomConfig = resolveRoomConfig(config, "!room:example.org");
  const whitelist = new Set(["@admin:example.org"]);

  assert.equal(isAllowedByPolicy(config, whitelist, roomConfig, "@admin:example.org", "dm"), true);
  assert.equal(isAllowedByPolicy(config, whitelist, roomConfig, "@admin:example.org", "group"), true);
});

test("isRoomAllowed: group allowlist requires configured rooms", () => {
  const config: MatrixChannelConfig = {
    homeserver: "https://example.org",
    accessToken: "",
    groupPolicy: "allowlist",
    groups: {},
  };

  assert.equal(isRoomAllowed(config, null, "group"), false);
});

test("isRoomAllowed: group open allows any room", () => {
  const config: MatrixChannelConfig = {
    homeserver: "https://example.org",
    accessToken: "",
    groupPolicy: "open",
  };

  assert.equal(isRoomAllowed(config, null, "group"), true);
});

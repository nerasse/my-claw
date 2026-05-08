import test from "node:test";
import assert from "node:assert/strict";
import { createMatrixSyncLifecycle } from "../src/channels/matrix/sync-lifecycle.ts";

function createEvent(params: { ts?: number; age?: number }) {
  return {
    getTs() {
      return params.ts ?? Number.NaN;
    },
    getUnsigned() {
      return typeof params.age === "number" ? { age: params.age } : {};
    },
  };
}

test("Matrix sync lifecycle drops only pre-startup backlog on cold start", () => {
  const lifecycle = createMatrixSyncLifecycle({
    startupMs: 1_000,
    startupGraceMs: 50,
    dropPreStartupMessages: true,
  });

  assert.equal(lifecycle.shouldDropEvent(createEvent({ ts: 900 })), true);
  assert.equal(lifecycle.shouldDropEvent(createEvent({ ts: 960 })), false);
  assert.equal(lifecycle.shouldDropEvent(createEvent({ age: 100 })), true);
  assert.equal(lifecycle.shouldDropEvent(createEvent({ age: 40 })), false);
});

test("Matrix sync lifecycle keeps events when persisted replay is trusted", () => {
  const lifecycle = createMatrixSyncLifecycle({
    startupMs: 1_000,
    startupGraceMs: 0,
    dropPreStartupMessages: false,
  });

  assert.equal(lifecycle.shouldDropEvent(createEvent({ ts: 1 })), false);
  assert.equal(lifecycle.shouldDropEvent(createEvent({ age: 10_000 })), false);
});

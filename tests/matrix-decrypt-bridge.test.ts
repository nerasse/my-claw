import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MatrixEventEvent } from "matrix-js-sdk";
import { MatrixDecryptBridge } from "../src/channels/matrix/decrypt-bridge.ts";

class FakeMatrixEvent extends EventEmitter {
  decryptionFailureReason: string | null;
  private roomId: string;
  private eventId: string;
  private sender: string;
  private failed = false;

  constructor(params: {
      roomId?: string;
      eventId?: string;
      sender?: string;
      decryptionFailureReason?: string | null;
      failed?: boolean;
    } = {}) {
    super();
    this.roomId = params.roomId ?? "!room:test";
    this.eventId = params.eventId ?? "$evt1";
    this.sender = params.sender ?? "@u1:example.org";
    this.decryptionFailureReason = params.decryptionFailureReason ?? null;
    this.failed = params.failed === true;
  }

  getId(): string {
    return this.eventId;
  }

  getRoomId(): string {
    return this.roomId;
  }

  getSender(): string {
    return this.sender;
  }

  isDecryptionFailure(): boolean {
    return this.failed;
  }

  markDecrypted(): void {
    this.failed = false;
    this.decryptionFailureReason = null;
  }
}

test("MatrixDecryptBridge suppresses raw duplicate after decrypted delivery", async () => {
  const delivered: string[] = [];
  const bridge = new MatrixDecryptBridge({
    client: {
      async decryptEventIfNeeded() {
        return;
      },
    },
    emitDecryptedEvent: (_roomId, event) => {
      delivered.push(event.getId() ?? "");
    },
  });

  const event = new FakeMatrixEvent();
  bridge.attachEncryptedEvent(event as never, "!room:test");
  event.emit(MatrixEventEvent.Decrypted, event, undefined);

  assert.deepEqual(delivered, ["$evt1"]);
  assert.equal(bridge.shouldEmitUnencryptedMessage("!room:test", "$evt1"), false);
  assert.equal(bridge.shouldEmitUnencryptedMessage("!room:test", "$evt1"), true);
});

test("MatrixDecryptBridge retries late decrypt failures and emits once recovered", async () => {
  const delivered: string[] = [];
  let decryptCalls = 0;
  const event = new FakeMatrixEvent({
    eventId: "$late",
    failed: true,
    decryptionFailureReason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
  });
  const bridge = new MatrixDecryptBridge({
    client: {
      async decryptEventIfNeeded(target, opts) {
        decryptCalls += 1;
        if (opts?.isRetry) {
          (target as unknown as FakeMatrixEvent).markDecrypted();
          target.emit(MatrixEventEvent.Decrypted, target, undefined);
        }
      },
    },
    emitDecryptedEvent: (_roomId, deliveredEvent) => {
      delivered.push(deliveredEvent.getId() ?? "");
    },
  });

  bridge.attachEncryptedEvent(event as never, "!room:test");
  await bridge.drainPendingDecryptions("test retry");

  assert.equal(decryptCalls >= 2, true);
  assert.deepEqual(delivered, ["$late"]);
});

test("MatrixDecryptBridge emits rich failed decryption metadata once per event", async () => {
  const failures: Array<{
    roomId: string;
    eventId?: string;
    sender?: string;
    retryable: boolean;
    error: string;
  }> = [];
  const event = new FakeMatrixEvent({
    eventId: "$failed",
    sender: "@alice:example.org",
    failed: true,
    decryptionFailureReason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
  });
  const bridge = new MatrixDecryptBridge({
    client: {
      async decryptEventIfNeeded() {
        return;
      },
    },
    emitDecryptedEvent: () => {},
    emitFailedDecryption: (failure) => {
      failures.push({
        roomId: failure.roomId,
        eventId: failure.eventId,
        sender: failure.sender,
        retryable: failure.isRetryable,
        error: String(failure.error),
      });
    },
  });

  bridge.attachEncryptedEvent(event as never, "!room:test");
  event.emit(MatrixEventEvent.Decrypted, event, new Error("decrypt failed"));
  event.emit(MatrixEventEvent.Decrypted, event, new Error("decrypt failed again"));

  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], {
    roomId: "!room:test",
    eventId: "$failed",
    sender: "@alice:example.org",
    retryable: true,
    error: "Error: decrypt failed",
  });
});

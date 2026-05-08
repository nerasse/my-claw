import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MatrixEventEvent } from "matrix-js-sdk";
import { MatrixDecryptBridge } from "../src/channels/matrix/decrypt-bridge.ts";

class FakeMatrixEvent extends EventEmitter {
  decryptionFailureReason: string | null;
  private roomId: string;
  private eventId: string;
  private failed = false;

  constructor(params: {
    roomId?: string;
    eventId?: string;
    decryptionFailureReason?: string | null;
    failed?: boolean;
  } = {}) {
    super();
    this.roomId = params.roomId ?? "!room:test";
    this.eventId = params.eventId ?? "$evt1";
    this.decryptionFailureReason = params.decryptionFailureReason ?? null;
    this.failed = params.failed === true;
  }

  getId(): string {
    return this.eventId;
  }

  getRoomId(): string {
    return this.roomId;
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

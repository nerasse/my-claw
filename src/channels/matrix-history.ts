export interface MatrixRoomHistoryEntry {
  messageId: string;
  senderId: string;
  text: string;
}

export interface MatrixRoomHistorySnapshot {
  messageId: string;
  queueGeneration: number;
  snapshotIndex: number;
}

export interface PreparedMatrixRoomHistory extends MatrixRoomHistorySnapshot {
  history: MatrixRoomHistoryEntry[];
}

type RoomQueue = {
  entries: MatrixRoomHistoryEntry[];
  baseIndex: number;
  consumedIndex: number;
  generation: number;
  preparedTriggers: Map<string, PreparedMatrixRoomHistory>;
};

const DEFAULT_MAX_QUEUE_SIZE = 200;
const MAX_PREPARED_TRIGGER_ENTRIES = 256;

export function createMatrixRoomHistoryTracker(maxQueueSize = DEFAULT_MAX_QUEUE_SIZE) {
  const roomQueues = new Map<string, RoomQueue>();
  let nextGeneration = 1;

  const getOrCreateQueue = (roomId: string): RoomQueue => {
    const existing = roomQueues.get(roomId);
    if (existing) return existing;

    const created: RoomQueue = {
      entries: [],
      baseIndex: 0,
      consumedIndex: 0,
      generation: nextGeneration++,
      preparedTriggers: new Map(),
    };
    roomQueues.set(roomId, created);
    return created;
  };

  const append = (queue: RoomQueue, entry: MatrixRoomHistoryEntry): MatrixRoomHistorySnapshot => {
    queue.entries.push(entry);
    if (queue.entries.length > maxQueueSize) {
      const overflow = queue.entries.length - maxQueueSize;
      queue.entries.splice(0, overflow);
      queue.baseIndex += overflow;
    }
    return {
      messageId: entry.messageId,
      queueGeneration: queue.generation,
      snapshotIndex: queue.baseIndex + queue.entries.length,
    };
  };

  const pendingHistory = (queue: RoomQueue, limit: number): MatrixRoomHistoryEntry[] => {
    if (limit <= 0 || queue.entries.length === 0) return [];

    const startAbs = Math.max(queue.consumedIndex, queue.baseIndex);
    const startRel = startAbs - queue.baseIndex;
    const available = queue.entries.slice(startRel);
    return available.length > limit ? available.slice(-limit) : available;
  };

  const rememberPrepared = (queue: RoomQueue, prepared: PreparedMatrixRoomHistory): PreparedMatrixRoomHistory => {
    if (!prepared.messageId) return prepared;

    if (queue.preparedTriggers.has(prepared.messageId)) {
      queue.preparedTriggers.delete(prepared.messageId);
    }
    queue.preparedTriggers.set(prepared.messageId, prepared);

    if (queue.preparedTriggers.size > MAX_PREPARED_TRIGGER_ENTRIES) {
      const oldest = queue.preparedTriggers.keys().next().value;
      if (typeof oldest === "string") {
        queue.preparedTriggers.delete(oldest);
      }
    }

    return prepared;
  };

  return {
    recordPending(roomId: string, entry: MatrixRoomHistoryEntry): void {
      append(getOrCreateQueue(roomId), entry);
    },

    prepareTrigger(roomId: string, limit: number, entry: MatrixRoomHistoryEntry): PreparedMatrixRoomHistory {
      const queue = getOrCreateQueue(roomId);
      const retryKey = entry.messageId.trim();
      if (retryKey) {
        const prepared = queue.preparedTriggers.get(retryKey);
        if (prepared) {
          return rememberPrepared(queue, prepared);
        }
      }

      const prepared = {
        history: pendingHistory(queue, limit),
        ...append(queue, entry),
      };
      return rememberPrepared(queue, prepared);
    },

    consumeHistory(roomId: string, snapshot: MatrixRoomHistorySnapshot): void {
      const queue = roomQueues.get(roomId);
      if (!queue) return;
      if (queue.generation !== snapshot.queueGeneration) return;

      queue.consumedIndex = Math.max(queue.consumedIndex, snapshot.snapshotIndex);
      if (snapshot.messageId) {
        queue.preparedTriggers.delete(snapshot.messageId);
      }
    },
  };
}

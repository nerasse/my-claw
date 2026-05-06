import {
  ClientEvent,
  RoomEvent,
  SyncState,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";

export interface MatrixRuntimeConfig {
  homeserver: string;
  accessToken: string;
  userId?: string;
  deviceId?: string;
  initialSyncLimit?: number;
}

export interface MatrixTimelineEvent {
  room: Room;
  event: MatrixEvent;
  toStartOfTimeline: boolean;
  removed: boolean;
}

export class MatrixClientRuntime {
  private client: MatrixClient;
  private readyPromise: Promise<void> | null = null;
  private timelineHandlers = new Set<(event: MatrixTimelineEvent) => void | Promise<void>>();
  private started = false;

  constructor(
    private config: MatrixRuntimeConfig,
    client?: MatrixClient,
  ) {
    this.client =
      client ??
      createClient({
        baseUrl: config.homeserver,
        accessToken: config.accessToken,
        userId: config.userId,
        deviceId: config.deviceId,
      });
  }

  get sdk(): MatrixClient {
    return this.client;
  }

  onTimeline(handler: (event: MatrixTimelineEvent) => void | Promise<void>): () => void {
    this.timelineHandlers.add(handler);
    return () => {
      this.timelineHandlers.delete(handler);
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      if (this.readyPromise) await this.readyPromise;
      return;
    }

    this.started = true;
    this.client.on(RoomEvent.Timeline, this.handleTimeline);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const onSync = (state: SyncState, _prev: SyncState | null, data?: { error?: Error }) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          this.client.off(ClientEvent.Sync, onSync);
          resolve();
        }
        if (state === SyncState.Error && data?.error) {
          this.client.off(ClientEvent.Sync, onSync);
          reject(data.error);
        }
      };
      this.client.on(ClientEvent.Sync, onSync);
    });

    await this.client.startClient({ initialSyncLimit: this.config.initialSyncLimit ?? 20 });
    await this.readyPromise;
  }

  async stop(): Promise<void> {
    this.client.off(RoomEvent.Timeline, this.handleTimeline);
    this.client.stopClient();
  }

  private handleTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    removed: boolean,
  ): void => {
    if (!room) return;
    void Promise.allSettled(
      [...this.timelineHandlers].map((handler) =>
        Promise.resolve(
          handler({ room, event, toStartOfTimeline: toStartOfTimeline === true, removed }),
        ),
      ),
    );
  };
}

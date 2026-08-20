import { log } from "../utils/logger.ts";

export interface RecreatableAdapter {
  stop(): Promise<void>;
}

export interface RecreateChannelOptions<T extends RecreatableAdapter> {
  /** The currently running adapter, if any. */
  current: T | undefined;
  /** The shared adapters list the old instance must be removed from. */
  adapters: RecreatableAdapter[];
  /** Build + start a fresh adapter. Returns undefined if the channel is now disabled. */
  build: () => Promise<T | undefined>;
  /** Re-point holders that captured the concrete instance (cron adapters map, etc.). */
  repoint: (next: T | undefined) => void;
  /** Label for logs. */
  label?: string;
}

/**
 * Recreate a channel adapter in place on an identity/token change, without a restart.
 *
 * Sequential by contract: the old adapter is FULLY stopped before the new one is built, so the
 * two never overlap on the same credentials/store. A failing stop is logged, not thrown, so the
 * new adapter still comes up.
 */
export async function recreateChannelAdapter<T extends RecreatableAdapter>(
  opts: RecreateChannelOptions<T>,
): Promise<T | undefined> {
  const { current, adapters, build, repoint, label } = opts;
  if (current) {
    await current.stop().catch((err) =>
      void log("warn", "adapter stop during recreate failed", { label, error: String(err) }),
    );
    const i = adapters.indexOf(current);
    if (i >= 0) adapters.splice(i, 1);
  }
  const next = await build();
  repoint(next);
  return next;
}

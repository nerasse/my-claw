import { watch, type FSWatcher, type WatchListener } from "node:fs";
import { log } from "./logger.ts";

/**
 * `watch()` hands back an EventEmitter, and an `error` event with no listener is rethrown as an
 * uncaught exception, which takes the whole process down. The two ways in are ordinary on a
 * long-running daemon: the watched directory is deleted, or the inotify budget runs out while a
 * workspace is being added. Every watcher goes through here so that costs one log line.
 */
export function watchQuiet(path: string, label: string, listener: WatchListener<string>): FSWatcher {
  const watcher = watch(path, listener);
  watcher.on("error", (err) => {
    void log("warn", "watcher error", { label, path, error: String(err) });
  });
  return watcher;
}

/** @file HookBus -- unified event system for MyClaw. */

import { log } from "../utils/logger.ts";
import type {
  GateEventMap,
  GateEventName,
  GateHandler,
  GateResult,
  HookEventMap,
  HookEventName,
  HookHandler,
  WaterfallEventMap,
  WaterfallEventName,
  WaterfallHandler,
} from "./types.ts";

// Internal storage uses unknown to avoid union-type narrowing issues with generics.
type UnknownHandler = (payload: unknown) => unknown;

export class HookBus {
  private voids = new Map<string, Set<UnknownHandler>>();
  private gates = new Map<string, Set<UnknownHandler>>();
  private falls = new Map<string, Set<UnknownHandler>>();

  // ---------------------------------------------------------------------------
  // Void events
  // ---------------------------------------------------------------------------

  on<K extends HookEventName>(event: K, handler: HookHandler<HookEventMap[K]>): void {
    const set = this.voids.get(event);
    if (set) {
      set.add(handler as UnknownHandler);
    } else {
      this.voids.set(event, new Set([handler as UnknownHandler]));
    }
  }

  off<K extends HookEventName>(event: K, handler: HookHandler<HookEventMap[K]>): void {
    this.voids.get(event)?.delete(handler as UnknownHandler);
  }

  emit<K extends HookEventName>(event: K, payload: HookEventMap[K]): void {
    const handlers = this.voids.get(event);
    if (!handlers || handlers.size === 0) return;

    const promises: Promise<void>[] = [];
    for (const handler of handlers) {
      try {
        const result = (handler as HookHandler<HookEventMap[K]>)(payload);
        if (result instanceof Promise) {
          promises.push(
            result.catch((err) => {
              void log("error", `hook error in "${event}"`, { error: String(err) });
            }),
          );
        }
      } catch (err) {
        void log("error", `hook error in "${event}"`, { error: String(err) });
      }
    }

    if (promises.length > 0) {
      void Promise.all(promises);
    }
  }

  // ---------------------------------------------------------------------------
  // Gate events
  // ---------------------------------------------------------------------------

  gate<K extends GateEventName>(event: K, handler: GateHandler<GateEventMap[K]>): void {
    const set = this.gates.get(event);
    if (set) {
      set.add(handler as UnknownHandler);
    } else {
      this.gates.set(event, new Set([handler as UnknownHandler]));
    }
  }

  ungate<K extends GateEventName>(event: K, handler: GateHandler<GateEventMap[K]>): void {
    this.gates.get(event)?.delete(handler as UnknownHandler);
  }

  async check<K extends GateEventName>(event: K, payload: GateEventMap[K]): Promise<GateResult> {
    const handlers = this.gates.get(event);
    if (!handlers || handlers.size === 0) {
      return { allowed: true };
    }

    for (const handler of handlers) {
      try {
        const result = await (handler as GateHandler<GateEventMap[K]>)(payload);
        if (result.allow === false) {
          return { allowed: false, reason: result.reason };
        }
      } catch (err) {
        void log("error", `gate handler error in "${event}" -- fail-open`, { error: String(err) });
      }
    }

    return { allowed: true };
  }

  // ---------------------------------------------------------------------------
  // Waterfall events
  // ---------------------------------------------------------------------------

  tap<K extends WaterfallEventName>(event: K, handler: WaterfallHandler<WaterfallEventMap[K]>): void {
    const set = this.falls.get(event);
    if (set) {
      set.add(handler as UnknownHandler);
    } else {
      this.falls.set(event, new Set([handler as UnknownHandler]));
    }
  }

  untap<K extends WaterfallEventName>(event: K, handler: WaterfallHandler<WaterfallEventMap[K]>): void {
    this.falls.get(event)?.delete(handler as UnknownHandler);
  }

  async transform<K extends WaterfallEventName>(event: K, payload: WaterfallEventMap[K]): Promise<WaterfallEventMap[K]> {
    const handlers = this.falls.get(event);
    if (!handlers || handlers.size === 0) {
      return payload;
    }

    let value: unknown = payload;
    for (const handler of handlers) {
      try {
        value = await (handler as WaterfallHandler<WaterfallEventMap[K]>)(value as WaterfallEventMap[K]);
      } catch (err) {
        void log("error", `waterfall handler error in "${event}" -- passthrough`, { error: String(err) });
      }
    }

    return value as WaterfallEventMap[K];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  clear(): void {
    this.voids.clear();
    this.gates.clear();
    this.falls.clear();
  }
}

// Global singleton
export const hooks = new HookBus();

export type MatrixStartupEvent = {
  getTs: () => number;
  getUnsigned: () => { age?: unknown };
};

export type MatrixSyncLifecycle = {
  startupMs: number;
  startupGraceMs: number;
  dropPreStartupMessages: boolean;
  shouldDropEvent: (event: MatrixStartupEvent) => boolean;
};

export function createMatrixSyncLifecycle(params: {
  startupMs?: number;
  startupGraceMs?: number;
  dropPreStartupMessages?: boolean;
}): MatrixSyncLifecycle {
  const startupMs =
    typeof params.startupMs === "number" && Number.isFinite(params.startupMs)
      ? Math.floor(params.startupMs)
      : Date.now();
  const startupGraceMs =
    typeof params.startupGraceMs === "number" && Number.isFinite(params.startupGraceMs)
      ? Math.max(0, Math.floor(params.startupGraceMs))
      : 0;
  const dropPreStartupMessages = params.dropPreStartupMessages === true;

  return {
    startupMs,
    startupGraceMs,
    dropPreStartupMessages,
    shouldDropEvent: (event) => {
      if (!dropPreStartupMessages) {
        return false;
      }

      const eventTs = event.getTs();
      if (Number.isFinite(eventTs) && eventTs < startupMs - startupGraceMs) {
        return true;
      }

      if (Number.isFinite(eventTs)) {
        return false;
      }

      const age = event.getUnsigned().age;
      return typeof age === "number" && Number.isFinite(age) && age > startupGraceMs;
    },
  };
}

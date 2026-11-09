export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PurgeRunner {
  execute(): Promise<number>;
}

export interface PurgeSchedulerOptions {
  intervalMs?: number;
  /** Injectable for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => { unref(): unknown };
  clearIntervalFn?: (timer: never) => void;
}

/**
 * Runs the purge once at start and then every `intervalMs` (default daily). The timer is unref-ed so
 * it never keeps the process alive, and a failing run is logged (message only) and retried next tick.
 * Returns a function that stops the schedule.
 */
export function startUnmatchedPurge(runner: PurgeRunner, options: PurgeSchedulerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? PURGE_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as never));

  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    runner
      .execute()
      .catch((error: unknown) => {
        console.error('unmatched purge failed:', error instanceof Error ? error.message : 'unknown error');
      })
      .finally(() => {
        running = false;
      });
  };

  run();
  const timer = setIntervalFn(run, intervalMs);
  timer.unref();
  return () => clearIntervalFn(timer as never);
}

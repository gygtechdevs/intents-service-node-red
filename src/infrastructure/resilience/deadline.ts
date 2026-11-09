export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export interface Deadline {
  remainingMs(): number;
}

/** Overall time budget for a request; remainingMs() never goes below 0. */
export const createDeadline = (totalMs: number, now: () => number = Date.now): Deadline => {
  const end = now() + totalMs;
  return { remainingMs: () => Math.max(0, end - now()) };
};

/**
 * Runs fn with an AbortSignal that fires after `ms` (or when `parent` aborts).
 * Rejects with TimeoutError on timeout even if fn ignores the signal.
 */
export const runWithTimeout = <T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> => {
  if (!(ms > 0)) return Promise.reject(new TimeoutError(ms));
  if (parent?.aborted) return Promise.reject(new Error('Aborted'));

  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const onParentAbort = () => {
      controller.abort();
      cleanup();
      reject(new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      controller.abort();
      cleanup();
      reject(new TimeoutError(ms));
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    };
    parent?.addEventListener('abort', onParentAbort, { once: true });

    fn(controller.signal).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
};

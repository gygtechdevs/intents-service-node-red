export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit breaker is open');
    this.name = 'CircuitOpenError';
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

/**
 * closed -> open after N consecutive failures -> rejects instantly for the cooldown
 * -> half-open (a single probe) -> closed on success / open again on failure.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private current: CircuitState = 'closed';
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    return this.current;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let isProbe = false;
    if (this.current === 'open') {
      if (this.now() - this.openedAt < this.options.cooldownMs) throw new CircuitOpenError();
      this.current = 'half-open';
    }
    if (this.current === 'half-open') {
      if (this.probeInFlight) throw new CircuitOpenError();
      this.probeInFlight = true;
      isProbe = true;
    }

    try {
      const result = await fn();
      this.failures = 0;
      this.current = 'closed';
      return result;
    } catch (error) {
      this.failures += 1;
      if (isProbe || this.failures >= this.options.failureThreshold) {
        this.current = 'open';
        this.openedAt = this.now();
      }
      throw error;
    } finally {
      if (isProbe) this.probeInFlight = false;
    }
  }
}

import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../../src/infrastructure/resilience/CircuitBreaker';
import { createDeadline, runWithTimeout, TimeoutError } from '../../src/infrastructure/resilience/deadline';

const makeBreaker = () => {
  let t = 1000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30000, now: clock.now });
  return { breaker, clock };
};
const fail = () => Promise.reject(new Error('boom'));

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold and resets on success', async () => {
    const { breaker } = makeBreaker();
    await expect(breaker.execute(fail)).rejects.toThrow('boom');
    await expect(breaker.execute(fail)).rejects.toThrow('boom');
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    await expect(breaker.execute(fail)).rejects.toThrow('boom');
    await expect(breaker.execute(fail)).rejects.toThrow('boom');
    expect(breaker.state).toBe('closed');
  });

  it('opens after N consecutive failures and rejects instantly without calling fn', async () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i++) await expect(breaker.execute(fail)).rejects.toThrow('boom');
    expect(breaker.state).toBe('open');
    let called = false;
    await expect(breaker.execute(async () => { called = true; })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('goes half-open after the cooldown and closes on a successful probe', async () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) await expect(breaker.execute(fail)).rejects.toThrow('boom');
    clock.advance(29999);
    await expect(breaker.execute(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError);
    clock.advance(1);
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('re-opens (new cooldown) when the half-open probe fails', async () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) await expect(breaker.execute(fail)).rejects.toThrow('boom');
    clock.advance(30000);
    await expect(breaker.execute(fail)).rejects.toThrow('boom');
    expect(breaker.state).toBe('open');
    await expect(breaker.execute(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('allows only a single probe while half-open', async () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) await expect(breaker.execute(fail)).rejects.toThrow('boom');
    clock.advance(30000);
    let release!: (v: string) => void;
    const probe = breaker.execute(() => new Promise<string>((r) => (release = r)));
    await expect(breaker.execute(async () => 'second')).rejects.toBeInstanceOf(CircuitOpenError);
    release('done');
    await expect(probe).resolves.toBe('done');
    expect(breaker.state).toBe('closed');
  });
});

describe('deadline', () => {
  it('tracks the remaining budget with an injected clock', () => {
    let t = 0;
    const d = createDeadline(1500, () => t);
    expect(d.remainingMs()).toBe(1500);
    t = 1000;
    expect(d.remainingMs()).toBe(500);
    t = 5000;
    expect(d.remainingMs()).toBe(0);
  });

  it('runWithTimeout aborts the signal and rejects with TimeoutError', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = runWithTimeout(100, (signal) => {
      seen = signal;
      return new Promise<string>(() => undefined);
    });
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(seen?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('runWithTimeout resolves normally and clears the timer', async () => {
    await expect(runWithTimeout(100, async () => 'ok')).resolves.toBe('ok');
  });

  it('runWithTimeout rejects immediately when the timeout is not positive', async () => {
    await expect(runWithTimeout(0, async () => 'ok')).rejects.toBeInstanceOf(TimeoutError);
  });
});

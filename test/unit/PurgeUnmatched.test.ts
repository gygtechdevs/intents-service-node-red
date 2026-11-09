import { afterEach, describe, expect, it, vi } from 'vitest';
import { PurgeUnmatchedUseCase } from '../../src/application/use-cases/PurgeUnmatchedUseCase';
import { startUnmatchedPurge } from '../../src/application/services/UnmatchedPurgeScheduler';
import { parseUnmatchedRetentionDays } from '../../src/infrastructure/config/env';
import { InMemoryUnmatchedMessageRepository } from '../fakes/InMemoryUnmatchedMessageRepository';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe('PurgeUnmatchedUseCase', () => {
  it('deletes only rows older than the retention window and is idempotent', async () => {
    const repo = new InMemoryUnmatchedMessageRepository();
    repo.seed({ maskedText: 'old', lastSeenAt: daysAgo(31) });
    repo.seed({ maskedText: 'recent', lastSeenAt: daysAgo(10) });
    const purge = new PurgeUnmatchedUseCase(repo, { retentionDays: 30, now: () => NOW });

    expect(await purge.execute()).toBe(1);
    expect(repo.rows.map((r) => r.maskedText)).toEqual(['recent']);
    expect(await purge.execute()).toBe(0);
    expect(repo.rows).toHaveLength(1);
  });

  it('purges every status (approved and rejected too)', async () => {
    const repo = new InMemoryUnmatchedMessageRepository();
    repo.seed({ maskedText: 'a', status: 'approved', lastSeenAt: daysAgo(40) });
    repo.seed({ maskedText: 'r', status: 'rejected', lastSeenAt: daysAgo(40) });
    expect(await new PurgeUnmatchedUseCase(repo, { retentionDays: 30, now: () => NOW }).execute()).toBe(2);
  });

  it('loops in batches until a short batch', async () => {
    const repo = new InMemoryUnmatchedMessageRepository();
    for (let i = 0; i < 5; i += 1) repo.seed({ maskedText: `m${i}`, lastSeenAt: daysAgo(60) });
    const spy = vi.spyOn(repo, 'purgeOlderThan');
    const purge = new PurgeUnmatchedUseCase(repo, { retentionDays: 30, now: () => NOW, batchSize: 2 });
    expect(await purge.execute()).toBe(5);
    expect(spy).toHaveBeenCalledTimes(3); // 2, 2, 1
    expect(spy.mock.calls[0]?.[0]).toEqual(daysAgo(30));
  });
});

describe('startUnmatchedPurge', () => {
  afterEach(() => vi.useRealTimers());

  it('runs once at start, then on every interval, and stops on demand', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue(0);
    const stop = startUnmatchedPurge({ execute }, { intervalMs: DAY });
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(execute).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(DAY * 2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('never throws when a purge fails and keeps going', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const execute = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(0);
    const stop = startUnmatchedPurge({ execute }, { intervalMs: DAY });
    await vi.advanceTimersByTimeAsync(DAY);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalled();
    stop();
    spy.mockRestore();
  });

  it('does not keep the process alive (timer is unref-ed)', () => {
    const unref = vi.fn();
    const fakeSetInterval = vi.fn().mockReturnValue({ unref });
    startUnmatchedPurge({ execute: vi.fn().mockResolvedValue(0) }, { intervalMs: DAY, setIntervalFn: fakeSetInterval });
    expect(unref).toHaveBeenCalled();
  });
});

describe('parseUnmatchedRetentionDays', () => {
  it('defaults to 30 and falls back on invalid values', () => {
    expect(parseUnmatchedRetentionDays(undefined)).toBe(30);
    expect(parseUnmatchedRetentionDays('')).toBe(30);
    expect(parseUnmatchedRetentionDays('abc')).toBe(30);
    expect(parseUnmatchedRetentionDays('0')).toBe(30);
    expect(parseUnmatchedRetentionDays('-5')).toBe(30);
    expect(parseUnmatchedRetentionDays('1.5')).toBe(30);
    expect(parseUnmatchedRetentionDays('7')).toBe(7);
  });
});

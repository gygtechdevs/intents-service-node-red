import { describe, it, expect, vi } from 'vitest';
import type { Intent } from '../../src/domain/entities/Intent';
import type { IntentRepository } from '../../src/domain/repositories/IntentRepository';
import { CachedIntentRepository } from '../../src/infrastructure/repositories/CachedIntentRepository';

const make = (name: string, extra: Partial<Intent> = {}): Intent => ({
  id: name,
  name,
  keywords: ['k'],
  tags: ['t'],
  initialStep: '/s',
  steps: { initialStep: '/s' },
  active: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...extra,
});

function setup(ttlMs = 1000) {
  let current = 0;
  const inner = {
    findActive: vi.fn(async () => [make('a')]),
    findByName: vi.fn(async (n: string) => make(n)),
    create: vi.fn(async () => make('new')),
    save: vi.fn(async (i: Intent) => i),
  } satisfies IntentRepository;
  const warn = vi.fn();
  const repo = new CachedIntentRepository(inner, {
    ttlMs,
    now: () => current,
    logger: { warn },
  });
  return { inner, repo, warn, advance: (ms: number) => (current += ms) };
}

describe('CachedIntentRepository', () => {
  it('serves hits from memory without touching the repository', async () => {
    const { inner, repo } = setup();
    await repo.findActive();
    await repo.findActive();
    await repo.findActive();
    expect(inner.findActive).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the TTL expires', async () => {
    const { inner, repo, advance } = setup(1000);
    await repo.findActive();
    advance(999);
    await repo.findActive();
    expect(inner.findActive).toHaveBeenCalledTimes(1);
    advance(1);
    await repo.findActive();
    expect(inner.findActive).toHaveBeenCalledTimes(2);
  });

  it('ttl=0 is a plain passthrough', async () => {
    const { inner, repo } = setup(0);
    await repo.findActive();
    await repo.findActive();
    expect(inner.findActive).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['create', (r: CachedIntentRepository) => r.create({ name: 'x', keywords: [], tags: [], steps: {} })],
    ['save', (r: CachedIntentRepository) => r.save(make('a'))],
    ['save (deactivate)', (r: CachedIntentRepository) => r.save(make('a', { active: false }))],
  ])('invalidates on %s', async (_label, write) => {
    const { inner, repo } = setup();
    await repo.findActive();
    await write(repo);
    await repo.findActive();
    expect(inner.findActive).toHaveBeenCalledTimes(2);
  });

  it('invalidates even when the write fails', async () => {
    const { inner, repo } = setup();
    inner.save.mockRejectedValueOnce(new Error('boom'));
    await repo.findActive();
    await expect(repo.save(make('a'))).rejects.toThrow('boom');
    await repo.findActive();
    expect(inner.findActive).toHaveBeenCalledTimes(2);
  });

  it('does not cache a snapshot whose refresh raced with a write', async () => {
    const { inner, repo } = setup();
    let release!: (v: Intent[]) => void;
    inner.findActive.mockImplementationOnce(() => new Promise<Intent[]>((r) => (release = r)));
    const pending = repo.findActive();
    await repo.save(make('a'));
    release([make('old')]);
    await pending;
    inner.findActive.mockResolvedValueOnce([make('fresh')]);
    const next = await repo.findActive();
    expect(next.map((i) => i.name)).toEqual(['fresh']);
  });

  it('shares one query between concurrent misses (single-flight)', async () => {
    const { inner, repo } = setup();
    const results = await Promise.all([repo.findActive(), repo.findActive(), repo.findActive()]);
    expect(inner.findActive).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
  });

  it('serves the stale snapshot and warns when a refresh fails', async () => {
    const { inner, repo, warn, advance } = setup(1000);
    const first = await repo.findActive();
    advance(1000);
    inner.findActive.mockRejectedValueOnce(new Error('db down'));
    const stale = await repo.findActive();
    expect(stale).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not cache errors and rethrows when there is no snapshot', async () => {
    const { inner, repo } = setup();
    inner.findActive.mockRejectedValueOnce(new Error('db down'));
    await expect(repo.findActive()).rejects.toThrow('db down');
    await expect(repo.findActive()).resolves.toHaveLength(1);
    expect(inner.findActive).toHaveBeenCalledTimes(2);
  });

  it('does not serve pre-write data when the refresh after a write fails', async () => {
    const { inner, repo } = setup();
    await repo.findActive();
    await repo.save(make('a'));
    inner.findActive.mockRejectedValueOnce(new Error('db down'));
    await expect(repo.findActive()).rejects.toThrow('db down');
  });

  it('returns an immutable snapshot', async () => {
    const { repo } = setup();
    const snap = await repo.findActive();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => (snap as Intent[]).push(make('z'))).toThrow();
    expect(() => (snap[0]!.keywords as string[]).push('z')).toThrow();
    expect(() => (snap[0]!.tags as string[]).push('z')).toThrow();
  });

  it('delegates findByName untouched', async () => {
    const { inner, repo } = setup();
    await repo.findByName('a');
    await repo.findByName('a');
    expect(inner.findByName).toHaveBeenCalledTimes(2);
  });
});

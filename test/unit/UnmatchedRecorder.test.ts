import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Intent } from '../../src/domain/entities/Intent';
import { UnmatchedRecorder } from '../../src/application/services/UnmatchedRecorder';
import { DetectIntentUseCase } from '../../src/application/use-cases/DetectIntentUseCase';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';
import { InMemoryUnmatchedMessageRepository } from '../fakes/InMemoryUnmatchedMessageRepository';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('UnmatchedRecorder', () => {
  it('stores masked text with a sha256 of the normalized masked text', async () => {
    const repo = new InMemoryUnmatchedMessageRepository();
    await new UnmatchedRecorder(repo, { maxLength: 500 }).record('Mi DNI es 12.345.678 y mail a@b.com');
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.maskedText).toBe('Mi DNI es [DNI] y mail [EMAIL]');
    expect(repo.rows[0]?.textHash).toBe(sha('mi dni es [dni] y mail [email]'));
    expect(JSON.stringify(repo.rows)).not.toContain('12.345.678');
  });

  it('dedups the same message in different case/whitespace/diacritics', async () => {
    const repo = new InMemoryUnmatchedMessageRepository();
    const recorder = new UnmatchedRecorder(repo);
    await recorder.record('Quiero  una Cuenta');
    await recorder.record(' quiero una cuenta ');
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.occurrences).toBe(2);
  });

  it('caps stored text after masking', async () => {
    const repo = new InMemoryUnmatchedMessageRepository();
    await new UnmatchedRecorder(repo, { maxLength: 500 }).record(`${'a'.repeat(495)} 12345678 ${'b'.repeat(2000)}`);
    expect(repo.rows[0]?.maskedText.length).toBeLessThanOrEqual(500);
    expect(repo.rows[0]?.maskedText).not.toMatch(/\d/);
  });

  it('ignores blank text', async () => {
    const repo = new InMemoryUnmatchedMessageRepository();
    await new UnmatchedRecorder(repo).record('   ');
    expect(repo.rows).toHaveLength(0);
  });
});

describe('DetectIntentUseCase capture', () => {
  const intent: Intent = {
    id: '1', name: 'tarjeta', keywords: ['tarjeta'], tags: [], initialStep: '/t', steps: {},
    active: true, createdAt: new Date(0), updatedAt: new Date(0),
  };
  const catalog = () => {
    const repo = new InMemoryIntentRepository();
    repo.items.set(intent.name, intent);
    return repo;
  };
  const flush = () => new Promise((r) => setImmediate(r));

  it('captures a miss fire-and-forget: execute resolves before the recorder does', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const record = vi.fn().mockImplementation(() => gate);
    const useCase = new DetectIntentUseCase(catalog(), undefined, { record });

    const result = await useCase.execute('hola mundo');
    expect(result).toBeNull();
    expect(record).toHaveBeenCalledWith('hola mundo');
    release();
  });

  it('swallows recorder rejections without logging the raw text', async () => {
    const record = vi.fn().mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const useCase = new DetectIntentUseCase(catalog(), undefined, { record });

    await expect(useCase.execute('secreto 12345678')).resolves.toBeNull();
    await flush();
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('12345678');
    spy.mockRestore();
  });

  it('swallows synchronous recorder throws', async () => {
    const record = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new DetectIntentUseCase(catalog(), undefined, { record }).execute('hola')).resolves.toBeNull();
    spy.mockRestore();
  });

  it('never captures matched messages', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const result = await new DetectIntentUseCase(catalog(), undefined, { record }).execute('mi tarjeta');
    expect(result?.intent).toBe('tarjeta');
    expect(record).not.toHaveBeenCalled();
  });

  it('does nothing when no recorder is supplied (capture disabled)', async () => {
    await expect(new DetectIntentUseCase(catalog()).execute('hola')).resolves.toBeNull();
  });
});

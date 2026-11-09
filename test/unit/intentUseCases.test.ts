import { beforeEach, describe, expect, it } from 'vitest';
import { ApplicationError } from '../../src/application/errors/ApplicationError';
import { CreateIntentUseCase } from '../../src/application/use-cases/CreateIntentUseCase';
import { DeleteIntentUseCase } from '../../src/application/use-cases/DeleteIntentUseCase';
import { DetectIntentUseCase } from '../../src/application/use-cases/DetectIntentUseCase';
import { ListIntentsUseCase } from '../../src/application/use-cases/ListIntentsUseCase';
import { UpdateIntentUseCase } from '../../src/application/use-cases/UpdateIntentUseCase';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';

const input = { name: 'plazo fijo', keywords: ['plazo fijo'], initialStep: '/stepin/pf' };

async function rejection(promise: Promise<unknown>): Promise<ApplicationError> {
  try {
    await promise;
  } catch (err) {
    return err as ApplicationError;
  }
  throw new Error('expected rejection');
}

describe('intent use cases', () => {
  let repo: InMemoryIntentRepository;
  beforeEach(() => {
    repo = new InMemoryIntentRepository();
  });

  describe('CreateIntentUseCase', () => {
    it('creates an intent storing initialStep and description inside steps', async () => {
      const created = await new CreateIntentUseCase(repo).execute({ ...input, description: 'PF' });
      expect(created).toMatchObject({
        name: 'plazo fijo',
        initialStep: '/stepin/pf',
        description: 'PF',
        active: true,
        keywords: ['plazo fijo'],
      });
      expect(repo.items.get('plazo fijo')?.steps).toEqual({ initialStep: '/stepin/pf', description: 'PF' });
    });

    it('trims keywords and drops blanks', async () => {
      const created = await new CreateIntentUseCase(repo).execute({ ...input, keywords: [' a ', '', '  '] });
      expect(created.keywords).toEqual(['a']);
    });

    it.each([
      ['empty name', { ...input, name: '  ' }],
      ['name with special characters', { ...input, name: 'plazo/fijo!' }],
      ['name longer than 120 chars', { ...input, name: 'a'.repeat(121) }],
      ['missing initialStep', { ...input, initialStep: '' }],
      ['no keywords', { ...input, keywords: [] }],
      ['keywords only blanks', { ...input, keywords: [' '] }],
    ])('rejects %s with 400', async (_label, body) => {
      const error = await rejection(new CreateIntentUseCase(repo).execute(body));
      expect(error.statusCode).toBe(400);
    });

    it('rejects a duplicate active name with 409', async () => {
      const useCase = new CreateIntentUseCase(repo);
      await useCase.execute(input);
      const error = await rejection(useCase.execute(input));
      expect(error.statusCode).toBe(409);
    });

    it('reactivates a soft-deleted intent keeping its id', async () => {
      const create = new CreateIntentUseCase(repo);
      const first = await create.execute(input);
      await new DeleteIntentUseCase(repo).execute(input.name);
      const again = await create.execute({ ...input, keywords: ['nuevo'], initialStep: '/stepin/new' });
      expect(again.id).toBe(first.id);
      expect(again).toMatchObject({ active: true, keywords: ['nuevo'], initialStep: '/stepin/new' });
    });
  });

  describe('UpdateIntentUseCase', () => {
    it('merges changes into steps and keeps the name immutable', async () => {
      await new CreateIntentUseCase(repo).execute({ ...input, description: 'PF' });
      const updated = await new UpdateIntentUseCase(repo).execute(input.name, { initialStep: '/stepin/v2' });
      expect(updated).toMatchObject({ name: 'plazo fijo', initialStep: '/stepin/v2', description: 'PF' });
      expect(updated.keywords).toEqual(['plazo fijo']);
    });

    it('preserves unknown keys already stored in steps', async () => {
      const created = await new CreateIntentUseCase(repo).execute(input);
      await repo.save({ ...created, steps: { ...created.steps, nodes: [1, 2] } });
      const updated = await new UpdateIntentUseCase(repo).execute(input.name, { keywords: ['x'] });
      expect(updated.steps).toMatchObject({ nodes: [1, 2], initialStep: '/stepin/pf' });
      expect(updated.keywords).toEqual(['x']);
    });

    it('returns 404 for unknown or soft-deleted intents', async () => {
      const useCase = new UpdateIntentUseCase(repo);
      expect((await rejection(useCase.execute('nope', { keywords: ['x'] }))).statusCode).toBe(404);
      await new CreateIntentUseCase(repo).execute(input);
      await new DeleteIntentUseCase(repo).execute(input.name);
      expect((await rejection(useCase.execute(input.name, { keywords: ['x'] }))).statusCode).toBe(404);
    });

    it('rejects blank initialStep and empty keyword lists with 400', async () => {
      await new CreateIntentUseCase(repo).execute(input);
      const useCase = new UpdateIntentUseCase(repo);
      expect((await rejection(useCase.execute(input.name, { initialStep: ' ' }))).statusCode).toBe(400);
      expect((await rejection(useCase.execute(input.name, { keywords: [] }))).statusCode).toBe(400);
    });
  });

  describe('DeleteIntentUseCase', () => {
    it('soft-deletes (active=false) and keeps the row', async () => {
      await new CreateIntentUseCase(repo).execute(input);
      await new DeleteIntentUseCase(repo).execute(input.name);
      expect(repo.items.get(input.name)?.active).toBe(false);
      expect(await new ListIntentsUseCase(repo).execute()).toEqual([]);
    });

    it('returns 404 when missing or already deleted', async () => {
      const useCase = new DeleteIntentUseCase(repo);
      expect((await rejection(useCase.execute('nope'))).statusCode).toBe(404);
      await new CreateIntentUseCase(repo).execute(input);
      await useCase.execute(input.name);
      expect((await rejection(useCase.execute(input.name))).statusCode).toBe(404);
    });
  });

  describe('ListIntentsUseCase', () => {
    it('lists only active intents ordered by name', async () => {
      const create = new CreateIntentUseCase(repo);
      await create.execute({ ...input, name: 'b' });
      await create.execute({ ...input, name: 'a' });
      await create.execute({ ...input, name: 'c' });
      await new DeleteIntentUseCase(repo).execute('c');
      expect((await new ListIntentsUseCase(repo).execute()).map((i) => i.name)).toEqual(['a', 'b']);
    });
  });

  describe('DetectIntentUseCase', () => {
    it('detects against the active catalog only', async () => {
      const create = new CreateIntentUseCase(repo);
      await create.execute({ name: 'pf', keywords: ['plazo fijo'], initialStep: '/s/pf' });
      await create.execute({ name: 'old', keywords: ['plazo fijo', 'inversion'], initialStep: '/s/old' });
      await new DeleteIntentUseCase(repo).execute('old');
      const result = await new DetectIntentUseCase(repo).execute('quiero un plazo fijo');
      expect(result).toEqual({
        intent: 'pf',
        initialStep: '/s/pf',
        confidence: 1 / 3,
        matchedKeywords: ['plazo fijo'],
        tags: [],
      });
    });

    it('returns null when nothing matches', async () => {
      expect(await new DetectIntentUseCase(repo).execute('hola')).toBeNull();
    });
  });
  describe('tags', () => {
    it('defaults to an empty list', async () => {
      const created = await new CreateIntentUseCase(repo).execute(input);
      expect(created.tags).toEqual([]);
    });

    it('trims tags, drops case-insensitive duplicates and keeps the first casing', async () => {
      const created = await new CreateIntentUseCase(repo).execute({
        ...input,
        tags: [' Ventas ', 'ventas', 'VENTAS', 'soporte-1'],
      });
      expect(created.tags).toEqual(['Ventas', 'soporte-1']);
    });

    it.each([
      ['blank tag', ['ok', '  ']],
      ['tag longer than 40 chars', ['a'.repeat(41)]],
      ['tag with special characters', ['ventas!']],
      ['more than 10 tags', Array.from({ length: 11 }, (_v, i) => `t${i}`)],
    ])('rejects %s with 400', async (_label, tags) => {
      const error = await rejection(new CreateIntentUseCase(repo).execute({ ...input, tags }));
      expect(error.statusCode).toBe(400);
    });

    it('accepts exactly 10 tags of 40 chars', async () => {
      const tags = Array.from({ length: 10 }, (_v, i) => `${i}`.repeat(40));
      const created = await new CreateIntentUseCase(repo).execute({ ...input, tags });
      expect(created.tags).toHaveLength(10);
    });

    it('update replaces tags, and keeps them when omitted', async () => {
      await new CreateIntentUseCase(repo).execute({ ...input, tags: ['a'] });
      const update = new UpdateIntentUseCase(repo);
      expect((await update.execute(input.name, { keywords: ['x'] })).tags).toEqual(['a']);
      expect((await update.execute(input.name, { tags: ['b', 'c'] })).tags).toEqual(['b', 'c']);
      expect((await update.execute(input.name, { tags: [] })).tags).toEqual([]);
      expect((await rejection(update.execute(input.name, { tags: ['bad!'] }))).statusCode).toBe(400);
    });

    it('reactivating a soft-deleted intent replaces its tags', async () => {
      const create = new CreateIntentUseCase(repo);
      await create.execute({ ...input, tags: ['old'] });
      await new DeleteIntentUseCase(repo).execute(input.name);
      expect((await create.execute({ ...input, tags: ['new'] })).tags).toEqual(['new']);
    });

    it('list filters by tag case-insensitively', async () => {
      const create = new CreateIntentUseCase(repo);
      await create.execute({ ...input, name: 'a', tags: ['Ventas'] });
      await create.execute({ ...input, name: 'b', tags: ['soporte'] });
      await create.execute({ ...input, name: 'c' });
      const list = new ListIntentsUseCase(repo);
      expect((await list.execute({ tag: 'ventas' })).map((i) => i.name)).toEqual(['a']);
      expect((await list.execute({ tag: ' ' })).map((i) => i.name)).toEqual(['a', 'b', 'c']);
      expect(await list.execute({ tag: 'nope' })).toEqual([]);
    });

    it('detect returns the tags of the winning intent', async () => {
      await new CreateIntentUseCase(repo).execute({ ...input, tags: ['ventas'] });
      const result = await new DetectIntentUseCase(repo).execute('quiero un plazo fijo');
      expect(result?.tags).toEqual(['ventas']);
    });
  });
});

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { UnmatchedRecorder } from '../../src/application/services/UnmatchedRecorder';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';
import { InMemoryUnmatchedMessageRepository } from '../fakes/InMemoryUnmatchedMessageRepository';

const config = { jwtSecret: 'j', internalSecret: 'i' };
const detect = (app: ReturnType<typeof createApp>, text: string) =>
  request(app).post('/intents/detect').set('X-Internal-Secret', 'i').send({ text });

describe('POST /intents/detect unmatched capture', () => {
  it('stores only the masked text of a miss when a recorder is wired', async () => {
    const unmatched = new InMemoryUnmatchedMessageRepository();
    const app = createApp({
      repository: new InMemoryIntentRepository(),
      config,
      unmatchedRecorder: new UnmatchedRecorder(unmatched),
    });
    const res = await detect(app, 'mi dni 12.345.678');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(unmatched.rows.map((r) => r.maskedText)).toEqual(['mi [DNI]']);
  });

  it('stores nothing when no recorder is wired (capture disabled)', async () => {
    const app = createApp({ repository: new InMemoryIntentRepository(), config });
    expect((await detect(app, 'hola')).status).toBe(200);
  });

  it('keeps responding 200 when the repository throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = { upsert: vi.fn().mockRejectedValue(new Error('db down')) };
    const app = createApp({
      repository: new InMemoryIntentRepository(),
      config,
      unmatchedRecorder: new UnmatchedRecorder(failing),
    });
    const res = await detect(app, 'hola 12345678');
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(JSON.stringify(spy.mock.calls)).not.toContain('12345678');
    spy.mockRestore();
  });
});

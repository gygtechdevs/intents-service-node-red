import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { FakeIntentClassifier } from '../fakes/FakeIntentClassifier';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';

const config = { jwtSecret: 'j', internalSecret: 'i' };
const token = jwt.sign({ sub: 'u1', permissions: ['ADMIN'] }, 'j');

describe('semantic wiring in createApp', () => {
  it('uses the injected classifier for /intents/detect', async () => {
    const classifier = new FakeIntentClassifier({
      intent: 'saldo',
      initialStep: 's',
      confidence: 0.9,
      matchedKeywords: [],
      tags: [],
      source: 'semantic',
    });
    const app = createApp({ repository: new InMemoryIntentRepository(), config, classifier });
    const res = await request(app).post('/intents/detect').set('X-Internal-Secret', 'i').send({ text: 'hola' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: 'saldo', source: 'semantic' });
  });

  it('syncs examples when an intent is created through the API, without affecting the response', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('embed down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({ repository: new InMemoryIntentRepository(), config, examplesSync: { sync } });
    const res = await request(app)
      .post('/intents')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'saldo', keywords: ['saldo'], initialStep: 's' });
    expect(res.status).toBe(201);
    await new Promise((r) => setImmediate(r));
    expect(sync).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

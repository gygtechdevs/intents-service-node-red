import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { parseOrigins } from '../../src/interfaces/http/security';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';

const ALLOWED = 'https://app.example.com';

const makeApp = (corsAllowedOrigins: string[]) =>
  createApp({
    repository: new InMemoryIntentRepository(),
    config: { jwtSecret: 'test-jwt-secret', internalSecret: 'test-internal-secret' },
    security: { corsAllowedOrigins },
  });

describe('helmet', () => {
  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(makeApp([])).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('allows a listed origin with credentials', async () => {
    const res = await request(makeApp([ALLOWED])).get('/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not emit CORS headers for an unlisted origin', async () => {
    const res = await request(makeApp([ALLOWED])).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('handles preflight only for listed origins', async () => {
    const app = makeApp([ALLOWED]);
    const ok = await request(app)
      .options('/intents')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED);
    const denied = await request(app)
      .options('/intents')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies every origin when the allow-list is empty', async () => {
    const res = await request(makeApp([])).get('/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never combines a wildcard with credentials', async () => {
    const res = await request(makeApp(['*'])).get('/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('parses CORS_ALLOWED_ORIGINS', () => {
    expect(parseOrigins(' https://a.com ,https://b.com,, ')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseOrigins(undefined)).toEqual([]);
  });
});

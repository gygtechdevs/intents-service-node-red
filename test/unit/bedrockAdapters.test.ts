import { afterEach, describe, expect, it, vi } from 'vitest';
import { TitanEmbedder } from '../../src/infrastructure/bedrock/TitanEmbedder';
import { NovaDisambiguator } from '../../src/infrastructure/bedrock/NovaDisambiguator';
import { CircuitBreaker, CircuitOpenError } from '../../src/infrastructure/resilience/CircuitBreaker';
import { TimeoutError } from '../../src/infrastructure/resilience/deadline';

afterEach(() => vi.useRealTimers());

const breaker = () => new CircuitBreaker({ failureThreshold: 2, cooldownMs: 30000 });
const vec = (n: number) => Array.from({ length: n }, (_, i) => i / n);
const titanResponse = (embedding: unknown) => ({
  body: new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: 3 })),
});
const novaResponse = (text: string | undefined) => ({
  output: { message: { role: 'assistant', content: text === undefined ? [] : [{ text }] } },
});

describe('TitanEmbedder', () => {
  const make = (send: any, timeoutMs = 800) =>
    new TitanEmbedder({ client: { send: send as any }, modelId: 'amazon.titan-embed-text-v2:0', timeoutMs, breaker: breaker() });

  it('requests 512 dims with normalize=true and returns the vector', async () => {
    const send = vi.fn().mockResolvedValue(titanResponse(vec(512)));
    const out = await make(send).embed('hola [DNI]');
    expect(out).toHaveLength(512);
    const cmd = send.mock.calls[0]![0];
    expect(cmd.input.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(cmd.input.contentType).toBe('application/json');
    expect(JSON.parse(cmd.input.body)).toEqual({ inputText: 'hola [DNI]', dimensions: 512, normalize: true });
  });

  it('passes an abort signal to the client', async () => {
    const send = vi.fn().mockResolvedValue(titanResponse(vec(512)));
    await make(send).embed('x');
    expect(send.mock.calls[0]![1].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a vector whose length is not 512', async () => {
    const send = vi.fn().mockResolvedValue(titanResponse(vec(1024)));
    await expect(make(send).embed('x')).rejects.toThrow(/512/);
  });

  it('rejects a malformed response', async () => {
    await expect(make(vi.fn().mockResolvedValue(titanResponse('nope'))).embed('x')).rejects.toThrow();
    await expect(make(vi.fn().mockResolvedValue({ body: new TextEncoder().encode('not json') })).embed('x')).rejects.toThrow();
  });

  it('rejects and aborts on timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const send = vi.fn((_cmd: unknown, opts: { abortSignal: AbortSignal }) => {
      signal = opts.abortSignal;
      return new Promise(() => undefined);
    });
    const p = make(send as never, 800).embed('x');
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(800);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });

  it('honours a caller signal that is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const send = vi.fn().mockResolvedValue(titanResponse(vec(512)));
    await expect(make(send).embed('x', ctrl.signal)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('opens the breaker after repeated failures and stops calling the client', async () => {
    const send = vi.fn().mockRejectedValue(new Error('throttled'));
    const embedder = make(send);
    await expect(embedder.embed('x')).rejects.toThrow('throttled');
    await expect(embedder.embed('x')).rejects.toThrow('throttled');
    await expect(embedder.embed('x')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('NovaDisambiguator', () => {
  const candidates = [
    { name: 'check_balance', description: 'Balance inquiry' },
    { name: 'block_card' },
  ];
  const make = (send: any, timeoutMs = 1000) =>
    new NovaDisambiguator({ client: { send: send as any }, modelId: 'amazon.nova-micro-v1:0', timeoutMs, breaker: breaker() });

  it('uses temperature 0, a small token cap and sends only candidate names', async () => {
    const send = vi.fn().mockResolvedValue(novaResponse('{"intent":"block_card"}'));
    await make(send).choose('perdi mi tarjeta', candidates);
    const input = send.mock.calls[0]![0].input;
    expect(input.modelId).toBe('amazon.nova-micro-v1:0');
    expect(input.inferenceConfig).toEqual({ temperature: 0, maxTokens: 32 });
    const system = input.system[0].text as string;
    expect(system).toContain('check_balance');
    expect(system).toContain('block_card');
    expect(system).not.toContain('Balance inquiry');
    const user = input.messages[0].content[0].text as string;
    expect(user).toContain('perdi mi tarjeta');
    expect(send.mock.calls[0]![1].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('returns the chosen candidate', async () => {
    const send = vi.fn().mockResolvedValue(novaResponse('{"intent":"check_balance"}'));
    await expect(make(send).choose('saldo', candidates)).resolves.toBe('check_balance');
  });

  it('tolerates a markdown fenced JSON answer', async () => {
    const send = vi.fn().mockResolvedValue(novaResponse('```json\n{"intent":"block_card"}\n```'));
    await expect(make(send).choose('x', candidates)).resolves.toBe('block_card');
  });

  it('returns null for "none", out-of-set names, invalid JSON and empty output', async () => {
    for (const text of ['{"intent":"none"}', '{"intent":"transfer_money"}', 'block_card', '{"intent":5}', '{}', undefined]) {
      const send = vi.fn().mockResolvedValue(novaResponse(text));
      await expect(make(send).choose('x', candidates)).resolves.toBeNull();
    }
  });

  it('returns null without calling Bedrock when there are no candidates', async () => {
    const send = vi.fn();
    await expect(make(send).choose('x', [])).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects and aborts on timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const send = vi.fn((_cmd: unknown, opts: { abortSignal: AbortSignal }) => {
      signal = opts.abortSignal;
      return new Promise(() => undefined);
    });
    const p = make(send as never, 1000).choose('x', candidates);
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });

  it('propagates client errors and opens its breaker', async () => {
    const send = vi.fn().mockRejectedValue(new Error('denied'));
    const d = make(send);
    await expect(d.choose('x', candidates)).rejects.toThrow('denied');
    await expect(d.choose('x', candidates)).rejects.toThrow('denied');
    await expect(d.choose('x', candidates)).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

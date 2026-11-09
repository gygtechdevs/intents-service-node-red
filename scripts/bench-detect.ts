/**
 * Benchmark for POST /intents/detect.
 *
 * In-process mode (default, no database): compares
 *   A) BEFORE: repository.findActive() on every call + the legacy algorithm
 *      (keywords re-normalized per message), and
 *   B) AFTER:  CachedIntentRepository + DetectIntentUseCase (compiled catalog).
 * A simulated repository latency models a Postgres round trip.
 *
 * HTTP mode (`--http http://host:port`): fires requests at a running service and
 * reports client-side percentiles. The secret is read from INTENTS_INTERNAL_SECRET
 * and is never printed.
 *
 * Usage: npm run bench:detect -- [flags]   (see HELP below)
 */
import { parseArgs } from 'node:util';
import { deepStrictEqual } from 'node:assert';
import type { DetectableIntent, DetectedIntent, Intent } from '../src/domain/entities/Intent';
import type { IntentRepository } from '../src/domain/repositories/IntentRepository';
import { CachedIntentRepository } from '../src/infrastructure/repositories/CachedIntentRepository';
import { DetectIntentUseCase } from '../src/application/use-cases/DetectIntentUseCase';

const HELP = `bench-detect flags (env fallbacks in parentheses)
  --catalog 50,500       catalog sizes, comma separated        (BENCH_CATALOG, default 50)
  --latency 2,0          simulated repo latency in ms          (BENCH_LATENCY_MS, default 2)
  --sweep                shorthand: --catalog 50,500,5000 --latency 2,0 (unless given explicitly)
  --keywords 5           keywords per intent                   (BENCH_KEYWORDS)
  --iterations 20000     measured calls per scenario           (BENCH_ITERATIONS)
  --warmup 2000          warmup calls per scenario             (BENCH_WARMUP)
  --seed 1337            PRNG seed                             (BENCH_SEED)
  --ttl 30000            cache TTL in ms for scenario B        (BENCH_TTL_MS)
  --http URL             HTTP mode against a running service (uses --iterations/--warmup)
  --concurrency 10       HTTP concurrent requests
  --help`;

const { values } = parseArgs({
  options: {
    catalog: { type: 'string' },
    latency: { type: 'string' },
    sweep: { type: 'boolean', default: false },
    keywords: { type: 'string' },
    iterations: { type: 'string' },
    warmup: { type: 'string' },
    seed: { type: 'string' },
    ttl: { type: 'string' },
    http: { type: 'string' },
    concurrency: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

function intList(raw: string | undefined, fallback: string, name: string): number[] {
  const list = (raw ?? fallback).split(',').map((s) => Number(s.trim()));
  if (list.length === 0 || list.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Invalid --${name}: "${raw ?? fallback}"`);
  }
  return list;
}
function intOpt(flag: string | undefined, envName: string, fallback: number, name: string): number {
  const raw = flag ?? process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid --${name}: "${raw}"`);
  return n;
}

const sweepSizes = '50,500,5000';
const sweepLatencies = '2,0';
const catalogSizes = intList(
  values.catalog ?? process.env.BENCH_CATALOG ?? (values.sweep ? sweepSizes : undefined),
  '50',
  'catalog',
);
const latencies = intList(
  values.latency ?? process.env.BENCH_LATENCY_MS ?? (values.sweep ? sweepLatencies : undefined),
  '2',
  'latency',
);
const keywordsPerIntent = intOpt(values.keywords, 'BENCH_KEYWORDS', 5, 'keywords');
const iterations = intOpt(values.iterations, 'BENCH_ITERATIONS', 20000, 'iterations');
const warmup = intOpt(values.warmup, 'BENCH_WARMUP', 2000, 'warmup');
const seed = intOpt(values.seed, 'BENCH_SEED', 1337, 'seed');
const ttlMs = intOpt(values.ttl, 'BENCH_TTL_MS', 30000, 'ttl');
const concurrency = Math.max(1, intOpt(values.concurrency, 'BENCH_CONCURRENCY', 10, 'concurrency'));

// ---------------------------------------------------------------- seeded data

/** mulberry32: small deterministic PRNG. */
function createRng(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ca', 're', 'mi', 'to', 'pla', 'zo', 'fi', 'jo', 'ta', 'sa', 'cu', 'ne', 'bo', 'li', 'dor', 'ven', 'mar', 'pen'];
const ACCENTED = ['á', 'é', 'í', 'ó', 'ú', 'ñ', 'ü'];

function makeWord(rng: () => number, accented: boolean): string {
  const n = 2 + Math.floor(rng() * 3);
  let w = '';
  for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
  if (accented) {
    const at = Math.floor(rng() * w.length);
    w = w.slice(0, at) + ACCENTED[Math.floor(rng() * ACCENTED.length)] + w.slice(at + 1);
  }
  return w;
}

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;

function buildCatalog(size: number, perIntent: number, rng: () => number): Intent[] {
  const vocabSize = Math.max(200, size * perIntent);
  const vocab: string[] = [];
  for (let i = 0; i < vocabSize; i++) vocab.push(makeWord(rng, rng() < 0.3) + String(i)); // suffix keeps words distinct
  const epoch = new Date(0);
  const out: Intent[] = [];
  for (let i = 0; i < size; i++) {
    const keywords: string[] = [];
    for (let k = 0; k < perIntent; k++) {
      let kw = pick(rng, vocab);
      if (rng() < 0.25) kw = `${kw} ${pick(rng, vocab)}`; // multi-word phrase
      if (rng() < 0.2) kw = kw.toUpperCase();
      keywords.push(kw);
    }
    out.push({
      id: `id-${i}`,
      name: `intent_${String(i).padStart(5, '0')}`,
      keywords,
      tags: rng() < 0.5 ? [`tag${i % 7}`] : [],
      initialStep: `/step/${i}`,
      steps: { initialStep: `/step/${i}` },
      active: true,
      createdAt: epoch,
      updatedAt: epoch,
    });
  }
  return out;
}

/** Mix: ~50% matching (keywords, decorated), ~30% non-matching, ~20% diacritics/whitespace noise. */
function buildMessages(catalog: readonly Intent[], count: number, rng: () => number): string[] {
  const filler = ['hola', 'quiero', 'necesito', 'por favor', 'informacion', 'sobre', 'mi', 'cuenta', 'ayuda'];
  const msgs: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng();
    const parts: string[] = [pick(rng, filler)];
    if (r < 0.5) {
      const it = pick(rng, catalog);
      const n = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < n; k++) parts.push(pick(rng, it.keywords));
      parts.push(pick(rng, filler));
    } else if (r < 0.8) {
      for (let k = 0; k < 6; k++) parts.push(makeWord(rng, false) + 'x');
    } else {
      const it = pick(rng, catalog);
      parts.push(pick(rng, it.keywords).replace(/[aeiou]/g, (c) => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' })[c] ?? c));
      parts.push(makeWord(rng, true));
    }
    let msg = parts.join(rng() < 0.2 ? '   ' : ' ');
    if (rng() < 0.2) msg = msg.toUpperCase();
    msgs.push(msg);
  }
  return msgs;
}

// ------------------------------------------------- legacy (BEFORE) algorithm
// Verbatim copy of the pre-optimization algorithm (see
// test/unit/intentDetector.equivalence.test.ts): keywords are re-normalized on every message.

function normalize(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function legacyDetect(messageText: string, catalog: DetectableIntent[]): DetectedIntent | null {
  const message = normalize(messageText);
  if (!message) return null;
  const scored = catalog
    .map((item) => {
      const keywords = Array.isArray(item.keywords) ? item.keywords : [];
      const normalizedKeywords = keywords.map((k) => normalize(k)).filter(Boolean);
      const matchedKeywords = normalizedKeywords.filter((k) => message.includes(k));
      return {
        intent: item.name,
        initialStep: item.initialStep,
        tags: Array.isArray(item.tags) ? item.tags : [],
        matchedKeywords,
        score: matchedKeywords.length,
      };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
  const w = scored[0];
  if (!w) return null;
  return {
    intent: w.intent,
    initialStep: w.initialStep,
    confidence: Math.min(1, w.score / 3),
    matchedKeywords: w.matchedKeywords,
    tags: w.tags,
  };
}

class LegacyDetectIntentUseCase {
  constructor(private readonly repository: IntentRepository) {}
  async execute(text: string): Promise<DetectedIntent | null> {
    return legacyDetect(text, await this.repository.findActive());
  }
}

// ------------------------------------------------------------- repo + metrics

/** Fake repository: returns a fresh copy per call (like a DB read) after a simulated delay. */
class SimulatedRepository implements IntentRepository {
  calls = 0;
  constructor(
    private readonly rows: readonly Intent[],
    private readonly latencyMs: number,
  ) {}
  async findActive(): Promise<Intent[]> {
    this.calls += 1;
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    return this.rows.map((r) => ({ ...r, keywords: [...r.keywords], tags: [...r.tags] }));
  }
  findByName(): Promise<Intent | null> {
    throw new Error('not used');
  }
  create(): Promise<Intent> {
    throw new Error('not used');
  }
  save(): Promise<Intent> {
    throw new Error('not used');
  }
}

interface Stats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  throughput: number;
}

function summarize(samplesNs: Float64Array, wallNs: number): Stats {
  const sorted = Float64Array.from(samplesNs).sort();
  const at = (q: number) => (sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0) / 1e6;
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: (sorted[sorted.length - 1] ?? 0) / 1e6,
    throughput: sorted.length / (wallNs / 1e9),
  };
}

const fmt = (n: number) => (n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(4));
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

function row(label: string, s: Stats, extra = ''): string {
  return `| ${label} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} | ${fmtInt(s.throughput)} | ${extra} |`;
}
const TABLE_HEAD = [
  '| scenario | p50 ms | p95 ms | p99 ms | max ms | calls/s | notes |',
  '|---|---:|---:|---:|---:|---:|---|',
];

// ------------------------------------------------------------ in-process mode

async function runScenario(
  useCase: { execute(text: string): Promise<DetectedIntent | null> },
  messages: string[],
): Promise<{ stats: Stats; results: (DetectedIntent | null)[] }> {
  for (let i = 0; i < warmup; i++) await useCase.execute(messages[i % messages.length] as string);

  const samples = new Float64Array(iterations);
  const results: (DetectedIntent | null)[] = new Array(iterations);
  const wallStart = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    results[i] = await useCase.execute(messages[i % messages.length] as string);
    samples[i] = Number(process.hrtime.bigint() - t0);
  }
  const wallNs = Number(process.hrtime.bigint() - wallStart);
  return { stats: summarize(samples, wallNs), results };
}

async function runInProcess(): Promise<void> {
  console.log(
    `bench:detect in-process | node ${process.version} | iterations=${iterations} warmup=${warmup} ` +
      `keywords/intent=${keywordsPerIntent} seed=${seed} ttl=${ttlMs}ms\n`,
  );
  for (const size of catalogSizes) {
    for (const latencyMs of latencies) {
      const rng = createRng(seed + size);
      const rows = buildCatalog(size, keywordsPerIntent, rng);
      const messages = buildMessages(rows, 256, rng);

      const repoA = new SimulatedRepository(rows, latencyMs);
      const a = await runScenario(new LegacyDetectIntentUseCase(repoA), messages);

      const repoB = new SimulatedRepository(rows, latencyMs);
      const cached = new CachedIntentRepository(repoB, { ttlMs });
      const b = await runScenario(new DetectIntentUseCase(cached), messages);

      // Correctness gate: identical results for every call (checked outside the timed region).
      let matches = 0;
      for (let i = 0; i < iterations; i++) {
        try {
          deepStrictEqual(b.results[i], a.results[i]);
        } catch {
          throw new Error(
            `RESULT MISMATCH at call ${i} (catalog=${size}) for message ${JSON.stringify(messages[i % messages.length])}:\n` +
              `  A: ${JSON.stringify(a.results[i])}\n  B: ${JSON.stringify(b.results[i])}`,
          );
        }
        if (a.results[i]) matches += 1;
      }

      const totalCalls = warmup + iterations;
      const hitRate = totalCalls > 0 ? 1 - repoB.calls / totalCalls : 0;
      console.log(`### catalog=${size}, simulated repo latency=${latencyMs} ms`);
      console.log([...TABLE_HEAD, row('A before (no cache, legacy)', a.stats, `repo calls ${repoA.calls}`),
        row('B after (cache + compiled)', b.stats, `repo calls ${repoB.calls}, cache hit rate ${(hitRate * 100).toFixed(2)}%`)].join('\n'));
      const speedup = b.stats.p50 > 0 ? a.stats.p50 / b.stats.p50 : Infinity;
      console.log(
        `\nidentical results: ${iterations}/${iterations} calls (${((matches / iterations) * 100).toFixed(0)}% matched an intent) | ` +
          `p50 speedup x${speedup.toFixed(1)} | throughput x${(b.stats.throughput / a.stats.throughput).toFixed(1)}\n`,
      );
    }
  }
}

// ------------------------------------------------------------------ HTTP mode

async function runHttp(baseUrl: string): Promise<void> {
  const secret = process.env.INTENTS_INTERNAL_SECRET;
  if (!secret) throw new Error('INTENTS_INTERNAL_SECRET must be set for --http mode');
  const url = new URL('/intents/detect', baseUrl).toString();

  const rng = createRng(seed);
  const messages = buildMessages(buildCatalog(catalogSizes[0] ?? 50, keywordsPerIntent, rng), 256, rng);
  let failures = 0;

  const fire = async (i: number): Promise<number> => {
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({ text: messages[i % messages.length] }),
      });
      await res.arrayBuffer();
      if (res.status !== 200) failures += 1;
    } catch {
      failures += 1;
    }
    return Number(process.hrtime.bigint() - t0);
  };

  const runPhase = async (n: number): Promise<{ samples: Float64Array; wallNs: number }> => {
    const samples = new Float64Array(n);
    let next = 0;
    const start = process.hrtime.bigint();
    await Promise.all(
      Array.from({ length: Math.min(concurrency, n) }, async () => {
        while (next < n) {
          const i = next++;
          samples[i] = await fire(i);
        }
      }),
    );
    return { samples, wallNs: Number(process.hrtime.bigint() - start) };
  };

  console.log(`bench:detect HTTP | target=${new URL(url).origin} | requests=${iterations} warmup=${warmup} concurrency=${concurrency}\n`);
  await runPhase(warmup);
  failures = 0;
  const { samples, wallNs } = await runPhase(iterations);
  console.log([...TABLE_HEAD, row(`HTTP detect (c=${concurrency})`, summarize(samples, wallNs), `non-200/errors: ${failures}`)].join('\n'));
  if (failures > 0) {
    console.error(`\n${failures} requests failed (non-200 or network error); numbers are not trustworthy.`);
    process.exitCode = 1;
  }
}

(values.http ? runHttp(values.http) : runInProcess()).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

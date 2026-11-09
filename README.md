# node-red-intents

Intents-service: owns the intent catalog (CRUD) and the intent **detection** that used to live in the api-gateway. Express 5 + TypeScript, hexagonal. One deployment = one company (D10): no tenant, no RLS.

```
api-gateway ──POST /intents/detect (X-Internal-Secret)──►  intents-service :4002 ──► Postgres (table intents)
SPA / admin ──/api/admin/intents (JWT forwarded by the gateway)──►
```

## Configuration

Copy `.env.example` to `.env`.

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `4002` |
| `DATABASE_URL` | Same Postgres instance as auth-service (local: `postgresql://postgres:postgres@localhost:5434/platform_db`). **Required.** | - |
| `AUTH_JWT_SECRET` | HS256 secret shared with auth-service; JWTs are verified locally. **Required.** | - |
| `INTERNAL_SECRET` | Expected in `X-Internal-Secret` (the gateway's `INTENTS_INTERNAL_SECRET`). **Required.** | - |
| `PG_SSL` | `true` to connect with TLS | `false` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated browser origins allowed (with credentials). Empty = none (the gateway is a non-browser client and is unaffected). `*` is served without credentials | empty |
| `INTENTS_CATALOG_CACHE_TTL_MS` | In-memory TTL (ms) for the active-intent catalog read by `POST /intents/detect` and `GET /intents`. `0` disables caching. Invalid values fall back to the default | `15000` |
| `UNMATCHED_CAPTURE_ENABLED` | `true` stores the PII-masked text of messages that matched no intent, for human review. **Opt-in** (see [Privacy](#privacy-and-unmatched-message-storage)) | `false` |
| `UNMATCHED_MAX_LENGTH` | Max stored characters (1-500; masking runs before the cut) | `500` |
| `UNMATCHED_RETENTION_DAYS` | Days an unmatched message is kept after it was last seen. Positive integer; invalid falls back to the default | `30` |
| `SEMANTIC_ENABLED` | `true` enables embedding-based matching on keyword misses (AWS Bedrock). **Opt-in** | `false` |
| `AWS_REGION` | Bedrock region. **Required when `SEMANTIC_ENABLED=true`** (startup fails otherwise). Credentials come from the default AWS provider chain | - |
| `BEDROCK_EMBED_MODEL_ID` / `BEDROCK_DISAMBIGUATOR_MODEL_ID` | Titan Text Embeddings V2 (512 dims) / Nova Micro | `amazon.titan-embed-text-v2:0` / `amazon.nova-micro-v1:0` |
| `DISAMBIGUATION_ENABLED` | Ask the LLM to choose when the best matches are too close. `false` disables it | `true` |
| `SEMANTIC_MIN_SIMILARITY` | Cosine similarity (0-1] the best intent needs to count as a match. **Untuned guess**, see [Tuning](#tuning-the-semantic-thresholds) | `0.80` |
| `SEMANTIC_AMBIGUITY_MARGIN` | Best vs runner-up gap [0-1) below which the LLM decides. **Untuned guess** | `0.05` |
| `SEMANTIC_TOP_K` | Nearest examples fetched per message | `5` |
| `SEMANTIC_BUDGET_MS` | Total time budget of the semantic path per message (fail-open to "no intent") | `1500` |
| `BEDROCK_EMBED_TIMEOUT_MS` / `BEDROCK_LLM_TIMEOUT_MS` | Per-call Bedrock timeouts | `800` / `1000` |
| `BREAKER_FAILURE_THRESHOLD` / `BREAKER_COOLDOWN_MS` | Circuit breaker per Bedrock adapter: consecutive failures to open / ms before a probe | `5` / `30000` |

Catalog cache: writes through this process (create, update, deactivate, tag changes) invalidate it immediately, so the admin list never shows stale data after a write on the same instance. Concurrent misses share one DB query, and if a refresh fails the previous snapshot is served with a warning. **Multi-instance caveat:** invalidation is local to each process, so other replicas only see changes after their TTL expires (at most `INTENTS_CATALOG_CACHE_TTL_MS`).

`helmet` default headers are always on. CI (`.github/workflows/ci.yml`) runs `npm run typecheck`, `npm test` and `npm run build`.

## Scripts

```bash
npm run dev            # tsx watch
npm run typecheck      # tsc --noEmit (src + tests + scripts)
npm test               # vitest: unit (detector, use cases) + e2e with supertest
npm run build          # tsc -p tsconfig.build.json -> dist/
npm start
npm run migrate:up     # apply sql/migrations/*.sql
npm run migrate:down   # revert the last migration (-- N for N)
npm run migrate:status
```

## Benchmark (`POST /intents/detect`)

`scripts/bench-detect.ts` (run with `tsx`, already a devDependency) compares **A: before** (no cache, `findActive()` on every call, keywords re-normalized per message) with **B: after** (`CachedIntentRepository` + compiled catalog). Data is generated from a seeded PRNG, and the script fails loudly if A and B ever return different results.

```bash
npm run bench:detect                                   # catalog 50, 2 ms simulated repo latency, 20000 calls after 2000 warmup
npm run bench:detect -- --sweep                        # catalogs 50/500/5000 x latency 2/0 ms (slow: A sleeps 2 ms per call)
npm run bench:detect -- --catalog 500 --latency 0 --iterations 5000 --warmup 500
INTENTS_INTERNAL_SECRET=... npm run bench:detect -- --http http://localhost:3000 --concurrency 10
```

Other flags: `--keywords`, `--seed`, `--ttl` (see `--help`; env fallbacks `BENCH_*`).

Reading the output: one markdown table per (catalog, latency) with p50/p95/p99/max per call in ms and calls/s; B also reports the cache hit rate (`1 - repo calls / total calls`). Compare A and B rows in the same table only.

What it does and does not prove:
- In-process numbers cover repository + detection only. They exclude the network, Express, auth middleware and JSON parsing.
- The simulated DB latency (`--latency`, default 2 ms) is an assumption, not a measurement. The real saving depends on your actual Postgres round trip; use `--latency 0` to isolate the CPU-only gain from the compiled catalog. `setTimeout` granularity makes the simulated delay longer than requested (on Windows a 2 ms request measured ~15 ms; Linux is close to 2-3 ms), so compare A/B on the same OS only and prefer the `--latency 0` rows for CPU-only conclusions.
- For real numbers, run `--http` against a service backed by a real Postgres, once on the old build and once on the new one. Never put the secret on the command line; it is read from `INTENTS_INTERNAL_SECRET` and not printed.
- Run on an idle machine, with the same Node version and flags for both runs; ignore the first run after a cold start.

## Database

`sql/migrations/001_intents_baseline.sql` creates `intents` (`id`, `key` UNIQUE global, `keywords text[]` with a gin index, `steps jsonb`, `active`, timestamps). There is **no `tenant_id`**. The runner (`scripts/migrate.ts`) keeps its own control table, `schema_migrations_intents`, so it coexists with `schema_migrations_auth` / `schema_migrations_platform` in the same database (D1). The service refuses to start if `intents` is missing; it never creates tables from code.

Later migrations (run `npm run migrate:up` before deploying the version that needs them):
- `004_unmatched_messages.sql`: `unmatched_messages` (masked text, hash, occurrences, status, review metadata). Plain Postgres. Changes the privacy posture, see [Privacy](#privacy-and-unmatched-message-storage).
- `005_intent_examples.sql`: `CREATE EXTENSION IF NOT EXISTS vector` and `intent_examples` (`vector(512)` embeddings, HNSW cosine index). **pgvector prerequisite:** the Postgres server needs the `pgvector` extension available (locally use the `pgvector/pgvector:pg16` image). On RDS an admin must run `CREATE EXTENSION vector;` once (as `rds_superuser`) *before* this migration, so the migration role does not need superuser rights. `intent_examples` is only checked at startup when `SEMANTIC_ENABLED=true`; `migrate:down` of 005 drops the table but not the extension. Migration 003 is checksum-immutable and was not edited.

`steps` is free-form jsonb. The API exposes `initialStep` and `description`, stored as `steps.initialStep` / `steps.description`; any other key (flow graph nodes) is preserved on update.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/intents` | JWT |
| POST | `/intents` | JWT + `WRITE` (or `ADMIN`) |
| PUT | `/intents/:name` | JWT + `WRITE` (or `ADMIN`); `name` is immutable |
| DELETE | `/intents/:name` | JWT + `ADMIN`; soft delete (`active=false`) |
| POST | `/intents/detect` | `X-Internal-Secret` |
| GET | `/internal/intents` | `X-Internal-Secret` (active catalog, used by the gateway) |
| POST | `/internal/events` | `X-Internal-Secret` (gateway analytics ingest, `{ events: [...] }`, max 50) |
| GET | `/analytics/summary` `/analytics/by-channel` `/analytics/top-tags` `/analytics/daily` `/analytics/top-intents` | JWT (any valid token) |
| GET | `/admin/unmatched` | JWT + `ADMIN`; only when `UNMATCHED_CAPTURE_ENABLED=true` |
| POST | `/admin/unmatched/:id/approve` | JWT + `ADMIN`; also needs `SEMANTIC_ENABLED=true` |
| POST | `/admin/unmatched/:id/approve-new` | JWT + `ADMIN`; also needs `SEMANTIC_ENABLED=true` |
| POST | `/admin/unmatched/:id/reject` | JWT + `ADMIN` |
| POST | `/admin/intent-examples/reembed` | JWT + `ADMIN`; also needs `SEMANTIC_ENABLED=true` |
| GET | `/admin/unmatched/clusters` | JWT + `ADMIN`; semantic grouping with `SEMANTIC_ENABLED=true`, lexical fallback otherwise |
| POST | `/admin/unmatched/clusters/simulate` | JWT + `ADMIN`; needs `SEMANTIC_ENABLED=true`; dry run, writes nothing |
| POST | `/admin/unmatched/bulk/approve` | JWT + `ADMIN`; needs `SEMANTIC_ENABLED=true` |
| POST | `/admin/unmatched/bulk/reject` | JWT + `ADMIN` |
| GET | `/health` | - |

The JWT is read from `Authorization: Bearer` or the `access_token` cookie and must be HS256 with `permissions[]`.

Intent shape: `{ id, name, keywords, tags, initialStep, description?, active, updatedAt }`. `tags` is always an array (`[]` when none); migration `002_intents_tags.sql` adds the column (run `npm run migrate:up` before deploying this version).

- `POST /intents` body: `{ name, keywords[>=1], initialStep, description?, tags? }`. `tags`: up to 10, each 1-40 chars (letters, digits, spaces, `_`, `-`), trimmed, deduplicated case-insensitively. `name`: 1-120 chars of letters, digits, spaces, `_`, `-`. `409` if an active intent has that name; creating a soft-deleted name **reactivates** it (same `id`, so flows keep working).
- `PUT /intents/:name` body: any of `{ keywords, tags, initialStep, description }` (`tags` replaces the whole list). `GET /intents?tag=x` filters by tag (case-insensitive). A body `name` different from the path is `400`. `404` for unknown or soft-deleted intents.
- `DELETE /intents/:name` answers `{ deleted: true, name }`.

### `POST /intents/detect`

Request `{ "text": "quiero un plazo fijo" }`. Response:

```json
{ "intent": "plazo fijo", "confidence": 0.33, "matchedKeywords": ["plazo fijo"], "initialStep": "/stepin/pf" }
```

No match: `{ "intent": null, "confidence": 0, "matchedKeywords": [], "initialStep": null }`. Missing or non-string `text`: `400`.

Algorithm (moved unchanged from the gateway): lowercase, strip diacritics, collapse whitespace; each active intent scores the number of its keywords contained in the message; the highest score wins (catalog order, by name, on ties); `confidence = min(1, score / 3)`. Only active intents take part.

## Analytics (`message_events`)

Migration `003_message_events.sql` (run `npm run migrate:up` **before** deploying: the service refuses to start without the table). The gateway writes one row per routed message through `POST /internal/events`; this service aggregates in SQL (UTC days).

**Privacy (`message_events`).** No message text and no phone numbers are stored in this table (message text can be stored elsewhere, only when opted in: see [Privacy](#privacy-and-unmatched-message-storage)). `conversationId` must be a 64-char lowercase hex digest (salted SHA-256 computed by the gateway with `ANALYTICS_HASH_SALT`); anything else is rejected with `400`, so a raw phone number cannot be ingested by mistake. Unknown fields in the payload are dropped. `tags` is a snapshot at routing time.

Event: `{ occurredAt?, channel, channelName?, conversationId, intent?, matched, tags[], routedStep?, outcome: "ok"|"no_intent"|"error", nodeRedStatus?, durationMs? }`. A batch is all-or-nothing (`202 { accepted }`).

Read endpoints take `from`/`to` (`YYYY-MM-DD`, UTC, inclusive; default last 30 days; max 366 days) and `channel`; `top-tags`/`top-intents` take `limit` (1-50; default 3 / 10). `by-channel` ignores `channel`. Rates are fractions (0-1); `previousPeriod` is the same-length window right before `from` (`deltaPct` is `null` when it had no messages). `top-tags[].pct` is the share of all messages in range that carry the tag.

**Retention (suggested, not built).** Daily scheduled job: `DELETE FROM message_events WHERE occurred_at < now() - interval '13 months'` in bounded batches, or monthly range partitions dropped when expired.

## Semantic detection and unmatched-message review

Opt-in, both off by default. With `SEMANTIC_ENABLED=false` the service is keyword-only and makes no AI or vector calls.

Detection order: keyword match (unchanged, returned immediately) -> on a miss, the message is PII-masked, embedded (Titan V2, 512 dims) and compared with the stored examples (pgvector, top-k) -> a clear winner above `SEMANTIC_MIN_SIMILARITY` is returned (`source: "semantic"`, `confidence` = similarity) -> if the best intents are within `SEMANTIC_AMBIGUITY_MARGIN` the LLM picks among those candidate names only (`source: "llm"`). Any failure, timeout or open circuit breaker falls back to "no intent" (HTTP 200, never 500).

Learning loop: with capture on, misses are stored masked and an admin reviews them:
- `GET /admin/unmatched?status=pending|approved|rejected&limit=1-100&cursor=<opaque>`: `{ items: [...], nextCursor }`, ordered by occurrences, then most recently seen, then id (a total order, so paging never skips or repeats rows). Pass the previous response's `nextCursor` as `cursor` to get the next page; `nextCursor` is `null` on the last page. A malformed `cursor` answers 400.
- `POST /admin/unmatched/:id/approve` `{ intent }`: adds the masked text as an example of an existing active intent. `POST /admin/unmatched/:id/approve-new` `{ name, initialStep, keywords?, tags?, description? }`: creates the intent (same validation as `POST /intents`) and the example. Both answer `{ id, status: "approved", intent, embedded }`. The next detection uses the example immediately. If embedding fails, the approval still succeeds with `embedded: false` and the example is excluded from search until re-embedded.
- `POST /admin/unmatched/:id/reject`: marks it rejected (no example).
- `POST /admin/intent-examples/reembed`: embeds examples whose embedding is still NULL, answers `{ embedded, failed }`.
- `GET /admin/unmatched/clusters`: groups the PENDING messages (up to the 200 most frequent) by similarity. Embeddings are computed at read time (the store keeps no vectors) and cached in memory; with no embedder, or if any embedding fails, the whole run falls back to token-set (Jaccard) grouping. Answers `{ method: "semantic"|"lexical", analyzed, truncated, clusters: [{ id, representativeText, size, memberIds, members: [{ id, maskedText, occurrences }], nearestIntent: { intent, similarity }|null, firstSeenAt, lastSeenAt }] }`, largest first. `size` is the sum of the members' occurrences.
- `POST /admin/unmatched/clusters/simulate` `{ intent, ids (1-200), days? (1-365, default 30) }`: ESTIMATE of approving `ids` as examples of `intent` (never exact: `scope.exact` is false). Replays the pending messages seen in the last `days` days plus the stored examples of the other intents against "current examples + the selected texts", with the live classifier's similarity rule; keyword matches and the LLM step are not simulated. Answers `{ intent, days, selected, scope, newlyMatched: { count, selected, others, occurrences, samples }, ambiguous, regressions: { count, samples } }` (samples capped at 10, masked text only).
- `POST /admin/unmatched/bulk/approve` `{ intent, ids (1-200) }` and `POST /admin/unmatched/bulk/reject` `{ ids }`: apply the single-message logic to each id and answer `{ intent?, succeeded, failed, results: [{ id, ok: true, embedded? } | { id, ok: false, status, error }] }`. Items are independent (partial results, no all-or-nothing transaction).
- Errors: `401` no/invalid token, `403` without `ADMIN`, `404` unknown id or intent, `409` item already resolved (approvals are claimed with a conditional update, so concurrent reviewers cannot both win), `400` invalid input, `503` approve/reembed when semantic matching is disabled. If saving the example fails, the approval is reverted so the item can be reviewed again.
- Responses only ever contain masked text.

Rollout order: `npm run migrate:up` (004, 005; pgvector first) -> `npm run backfill:examples` (embeds the keywords/descriptions of the active intents; idempotent) -> set `SEMANTIC_ENABLED=true` and `AWS_REGION`. Rollback: set the flags back to `false`. The gateway's `INTENTS_TIMEOUT_MS` (default 5000) leaves room for the semantic budget; keep it above keyword time + `SEMANTIC_BUDGET_MS`. Gateway proxy routes for the admin endpoints are not part of this service.

### Tuning the semantic thresholds

`SEMANTIC_MIN_SIMILARITY=0.80` and `SEMANTIC_AMBIGUITY_MARGIN=0.05` are **untuned starting guesses**, not measured values. Tune them against your own catalog before relying on semantic results:

1. In staging set `SEMANTIC_MIN_SIMILARITY=0.5` (permissive) and `DISAMBIGUATION_ENABLED=false` so every semantic candidate is visible.
2. Build a labelled set of real (masked) phrasings: messages that should match an intent (with the expected intent) and messages that must not match anything. The reviewed `/admin/unmatched` items are a good source.
3. Send each one to `POST /intents/detect` and record `intent` and `confidence` (for `source: "semantic"` the confidence is the cosine similarity).
4. For candidate thresholds (e.g. 0.60 to 0.90 in steps of 0.05) compute precision (correct among returned) and recall (matched among should-match). Pick the lowest threshold whose false-positive rate you accept; a wrong routing is usually worse than "no intent" (which falls to the default flow).
5. For the margin, look at the cases where the top two intents differ by little: a larger margin sends more messages to the LLM (more latency and cost, better on near-ties); `0` never asks it.
6. Set the values via env, redeploy, re-run the set, and repeat when the catalog or its examples change materially. Do not rely on the defaults.

## Privacy and unmatched-message storage

This supersedes the older statement that no message text is stored by this service. What is stored, and when:

| Data | Where | When |
|---|---|---|
| Analytics events: no text, hashed conversation id | `message_events` | always (gateway ingest) |
| **Masked text** of messages that matched no intent | `unmatched_messages` | **only if `UNMATCHED_CAPTURE_ENABLED=true`** |
| **Masked text** of messages an admin approved | `intent_examples` | only after an explicit approval |

Masking happens before anything is persisted or sent to AWS, and before the length cap (so a cut cannot leave half an identifier): emails -> `[EMAIL]`, URLs -> `[URL]`, CBU (22 digits) -> `[CBU]`, card numbers (13-19 digits) -> `[CARD]`, CUIT/CUIL -> `[CUIT]`, phone numbers (AR formats) -> `[PHONE]`, DNI -> `[DNI]`, any other run of 6+ digits -> `[NUM]`. Then whitespace is collapsed and the text is capped at `UNMATCHED_MAX_LENGTH` (500). Identical texts are deduplicated by the SHA-256 of the normalized masked text (`occurrences` counts repeats). Raw text is never stored and never logged; capture failures log only the error message. The semantic path sends only the masked text to AWS Bedrock.

**Residual risk: personal names are NOT masked.** Free text such as "soy Juan Perez y quiero..." keeps the name, as do other free-form details that match none of the patterns above (addresses, short numbers, company names). Treat `unmatched_messages` as personal data: restrict database and `ADMIN` access accordingly, and consider whether the opt-in is acceptable for your data-protection obligations before enabling it.

Retention: the service purges `unmatched_messages` rows (any status) not seen for `UNMATCHED_RETENTION_DAYS` (default 30). The purge runs once at startup and then daily in-process, in batches of 1000, is idempotent and safe with several replicas; it only runs when capture is enabled. Approved examples live in `intent_examples`, independent of that purge, until their intent row is removed from the database or an admin deletes them; review what you approve, since it persists.

Opt-in flags: `UNMATCHED_CAPTURE_ENABLED` (store misses), `SEMANTIC_ENABLED` (send masked text to Bedrock). Turning a flag off stops the behaviour immediately; already stored rows remain until the retention purge (unmatched) or manual deletion (examples).

## Layout

```
src/domain/            entities/Intent, ports (classifier, embedder, disambiguator), repositories (ports), services (IntentDetector, PiiMasker)
src/application/       use-cases (intents, detect, unmatched review/purge, examples backfill), services (classifiers, recorder, purge scheduler), errors
src/infrastructure/    config/env, db/pool, repositories/PgIntentRepository
src/interfaces/http/   controllers, routes, middlewares (jwt, permission, internal secret, errors)
src/app.ts             composition root: createApp({ repository, config })
scripts/migrate.ts     migration runner
```

## Docker

`docker compose up --build` starts only this service; it expects the shared Postgres (start `node-red-auth`'s `postgres` first) and the migrations applied once with `npm run migrate:up`.

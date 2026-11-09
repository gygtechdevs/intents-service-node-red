-- 001_intents_baseline.sql — baseline of the intents-service.
--
-- The intents-service is the exclusive owner of `intents`. It shares the
-- Postgres instance with auth-service and platform (D1) but uses its own
-- control table: `schema_migrations_intents`.
--
-- One deployment = one company (D10): no tenant_id, no RLS. `key` is UNIQUE
-- globally. `steps` is free-form jsonb (initialStep, description, flow graph).
-- Deletion is soft (`active = false`) because flows reference the row id.
--
-- Requirements: PostgreSQL 13+ (`gen_random_uuid()` in core).

-- migrate:up

CREATE TABLE intents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        varchar(120) NOT NULL UNIQUE,
  keywords   text[] NOT NULL DEFAULT '{}',
  steps      jsonb NOT NULL DEFAULT '{}'::jsonb,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX intents_keywords_idx ON intents USING gin (keywords);

-- migrate:down

DROP INDEX IF EXISTS intents_keywords_idx;
DROP TABLE IF EXISTS intents;

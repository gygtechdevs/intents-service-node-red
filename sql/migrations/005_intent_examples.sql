-- 005_intent_examples.sql — few-shot examples per intent with pgvector embeddings (semantic intent detection).
--
-- REQUIRES the pgvector extension. On managed Postgres (RDS) an admin should run
-- `CREATE EXTENSION vector;` once beforehand so this migration needs no superuser rights.
-- Embeddings come from Titan Text Embeddings V2 with 512 dimensions; a NULL embedding means "pending"
-- (the backfill / re-embed sweeps retry those rows). `source = 'approved'` rows come from human review
-- and are never touched by keyword/description syncing.

-- migrate:up

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE intent_examples (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_key      text        NOT NULL REFERENCES intents(key) ON DELETE CASCADE,
  text            text        NOT NULL,
  text_hash       char(64)    NOT NULL,
  source          text        NOT NULL CHECK (source IN ('keyword', 'description', 'approved')),
  embedding       vector(512),
  embedding_model text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_key, text_hash)
);

CREATE INDEX intent_examples_embedding_hnsw_idx ON intent_examples
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- migrate:down

DROP INDEX IF EXISTS intent_examples_embedding_hnsw_idx;
DROP TABLE IF EXISTS intent_examples;
-- The vector extension is intentionally NOT dropped: it may be shared with other schemas/databases.

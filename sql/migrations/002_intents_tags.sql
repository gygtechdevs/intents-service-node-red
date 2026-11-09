-- 002_intents_tags.sql — free-form tags to group intents in the dashboard.
--
-- Additive and backwards compatible: existing rows get an empty array through
-- the column default. Validation (trim, charset, length, uniqueness, max count)
-- lives in the application layer, mirroring `keywords`.

-- migrate:up

ALTER TABLE intents ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

CREATE INDEX intents_tags_idx ON intents USING gin (tags);

-- migrate:down

DROP INDEX IF EXISTS intents_tags_idx;
ALTER TABLE intents DROP COLUMN IF EXISTS tags;

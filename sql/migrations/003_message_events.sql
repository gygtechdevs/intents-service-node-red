-- 003_message_events.sql — one row per message routed by the api-gateway (analytics).
--
-- Privacy: no message text and no phone numbers are stored. `conversation_id` is a SALTED
-- SHA-256 hash computed by the gateway (ANALYTICS_HASH_SALT); it only allows counting distinct
-- conversations. `tags` is a snapshot of the matched intent's tags at routing time, so later
-- catalog edits do not rewrite history.
--
-- Retention (not built, suggested): run daily from a scheduler (pg_cron / cron job)
--   DELETE FROM message_events WHERE occurred_at < now() - interval '13 months';
-- Deleting in bounded batches (e.g. WHERE id IN (SELECT id ... LIMIT 10000)) avoids long locks.
-- A monthly range partition on occurred_at would let you DROP old partitions instead.

-- migrate:up

CREATE TABLE message_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  channel        text        NOT NULL,
  channel_name   text,
  conversation_id text       NOT NULL,
  intent         text,
  matched        boolean     NOT NULL,
  tags           text[]      NOT NULL DEFAULT '{}',
  routed_step    text,
  outcome        text        NOT NULL CHECK (outcome IN ('ok', 'no_intent', 'error')),
  node_red_status integer,
  duration_ms    integer     CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX message_events_occurred_at_idx ON message_events (occurred_at);
CREATE INDEX message_events_channel_occurred_at_idx ON message_events (channel, occurred_at);
CREATE INDEX message_events_tags_idx ON message_events USING gin (tags);

-- migrate:down

DROP INDEX IF EXISTS message_events_tags_idx;
DROP INDEX IF EXISTS message_events_channel_occurred_at_idx;
DROP INDEX IF EXISTS message_events_occurred_at_idx;
DROP TABLE IF EXISTS message_events;

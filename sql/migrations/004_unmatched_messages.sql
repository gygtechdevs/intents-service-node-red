-- 004_unmatched_messages.sql — messages the intent classifier could not match, kept for human review.
--
-- PRIVACY CHANGE (supersedes the "no message text is stored" note in 003 and the README):
-- when UNMATCHED_CAPTURE_ENABLED=true the service stores the TEXT of unmatched messages. Before
-- persisting, the text is PII-masked (email, URL, CBU, card, CUIT/CUIL, phone, DNI, long digit
-- runs), whitespace-collapsed and capped to UNMATCHED_MAX_LENGTH (500) characters - masking runs
-- BEFORE the cap. Free-text names are NOT masked (residual risk). `text_hash` is the sha256 of the
-- normalized masked text and only deduplicates repeats (occurrences++). Rows are purged after
-- UNMATCHED_RETENTION_DAYS (30) by `last_seen_at`. Capture is OFF by default.
-- Migration 003 is checksum-immutable and intentionally left untouched.

-- migrate:up

CREATE TABLE unmatched_messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  masked_text     text        NOT NULL CHECK (char_length(masked_text) <= 500),
  text_hash       char(64)    NOT NULL UNIQUE,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  occurrences     integer     NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  resolved_intent text,
  resolved_by     text,
  resolved_at     timestamptz
);

CREATE INDEX unmatched_messages_status_last_seen_idx ON unmatched_messages (status, last_seen_at DESC);
CREATE INDEX unmatched_messages_last_seen_idx ON unmatched_messages (last_seen_at);

-- migrate:down

DROP INDEX IF EXISTS unmatched_messages_last_seen_idx;
DROP INDEX IF EXISTS unmatched_messages_status_last_seen_idx;
DROP TABLE IF EXISTS unmatched_messages;

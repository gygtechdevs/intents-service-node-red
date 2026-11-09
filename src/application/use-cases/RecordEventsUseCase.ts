import { ApplicationError } from '../errors/ApplicationError';
import type {
  EventOutcome,
  MessageEventRepository,
  NewMessageEvent,
} from '../../domain/repositories/MessageEventRepository';

export const MAX_BATCH = 50;
export const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Salted SHA-256 hex digest. Anything else (e.g. a raw phone number) is refused. */
const CONVERSATION_HASH = /^[a-f0-9]{64}$/;
const OUTCOMES: readonly EventOutcome[] = ['ok', 'no_intent', 'error'];
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

const invalid = (index: number, message: string): never => {
  throw new ApplicationError(`events[${index}]: ${message}`, 400);
};

const nullableString = (value: unknown, index: number, field: string, max: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return invalid(index, `${field} must be a string of 1-${max} chars or null`);
  }
  return value;
};

const nullableInt = (value: unknown, index: number, field: string, min: number, max: number): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return invalid(index, `${field} must be an integer between ${min} and ${max} or null`);
  }
  return value;
};

const parseEvent = (raw: unknown, index: number, now: Date): NewMessageEvent => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalid(index, 'must be an object');
  const e = raw as Record<string, unknown>;

  let occurredAt = now;
  if (e.occurredAt !== undefined && e.occurredAt !== null) {
    const parsed = typeof e.occurredAt === 'string' ? new Date(e.occurredAt) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime())) return invalid(index, 'occurredAt must be an ISO-8601 date');
    occurredAt = parsed;
  }

  if (typeof e.channel !== 'string' || !CHANNEL_PATTERN.test(e.channel)) {
    return invalid(index, 'channel must match [a-z0-9_-], 1-32 chars');
  }
  if (typeof e.conversationId !== 'string' || !CONVERSATION_HASH.test(e.conversationId)) {
    return invalid(index, 'conversationId must be a 64-char lowercase hex hash');
  }
  if (typeof e.matched !== 'boolean') return invalid(index, 'matched must be a boolean');
  if (typeof e.outcome !== 'string' || !OUTCOMES.includes(e.outcome as EventOutcome)) {
    return invalid(index, `outcome must be one of ${OUTCOMES.join(', ')}`);
  }

  const rawTags = e.tags ?? [];
  if (
    !Array.isArray(rawTags) ||
    rawTags.length > MAX_TAGS ||
    rawTags.some((t) => typeof t !== 'string' || t.length === 0 || t.length > MAX_TAG_LENGTH)
  ) {
    return invalid(index, `tags must be an array of up to ${MAX_TAGS} strings (1-${MAX_TAG_LENGTH} chars)`);
  }

  return {
    occurredAt,
    channel: e.channel,
    channelName: nullableString(e.channelName, index, 'channelName', 80),
    conversationId: e.conversationId,
    intent: nullableString(e.intent, index, 'intent', 120),
    matched: e.matched,
    tags: rawTags as string[],
    routedStep: nullableString(e.routedStep, index, 'routedStep', 200),
    outcome: e.outcome as EventOutcome,
    nodeRedStatus: nullableInt(e.nodeRedStatus, index, 'nodeRedStatus', 100, 599),
    durationMs: nullableInt(e.durationMs, index, 'durationMs', 0, 3_600_000),
  };
};

/** Validates the whole batch first: either every event is stored or none is. */
export class RecordEventsUseCase {
  constructor(
    private readonly repository: MessageEventRepository,
    private readonly now: () => Date,
  ) {}

  async execute(body: unknown): Promise<number> {
    const events = (body as { events?: unknown } | null)?.events;
    if (!Array.isArray(events) || events.length === 0) {
      throw new ApplicationError('events must be a non-empty array', 400);
    }
    if (events.length > MAX_BATCH) {
      throw new ApplicationError(`events accepts at most ${MAX_BATCH} items per request`, 400);
    }
    const now = this.now();
    const parsed = events.map((raw, index) => parseEvent(raw, index, now));
    return this.repository.insertMany(parsed);
  }
}

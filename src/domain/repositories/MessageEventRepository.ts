export type EventOutcome = 'ok' | 'no_intent' | 'error';

/**
 * One routed message. Privacy: there is no message text and no phone number. `conversationId`
 * is a salted SHA-256 hash computed by the gateway, so it can only be used to count distinct
 * conversations.
 */
export interface NewMessageEvent {
  occurredAt: Date;
  channel: string;
  channelName: string | null;
  conversationId: string;
  intent: string | null;
  matched: boolean;
  tags: string[];
  routedStep: string | null;
  outcome: EventOutcome;
  nodeRedStatus: number | null;
  durationMs: number | null;
}

/** `from` inclusive, `to` exclusive (UTC instants). */
export interface EventRange {
  from: Date;
  to: Date;
  channel?: string | undefined;
}

export interface EventTotals {
  totalMessages: number;
  uniqueConversations: number;
  matchedMessages: number;
  errorMessages: number;
}

export interface ChannelRow {
  channel: string;
  channelName: string | null;
  messages: number;
  conversations: number;
}

export interface DailyRow {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  channel: string;
  count: number;
}

export interface MessageEventRepository {
  insertMany(events: NewMessageEvent[]): Promise<number>;
  totals(range: EventRange): Promise<EventTotals>;
  byChannel(range: EventRange): Promise<ChannelRow[]>;
  topTags(range: EventRange, limit: number): Promise<{ tag: string; count: number }[]>;
  daily(range: EventRange): Promise<DailyRow[]>;
  topIntents(range: EventRange, limit: number): Promise<{ intent: string; count: number }[]>;
}

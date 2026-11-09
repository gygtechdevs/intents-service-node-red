import type { Pool } from 'pg';
import type {
  ChannelRow,
  DailyRow,
  EventRange,
  EventTotals,
  MessageEventRepository,
  NewMessageEvent,
} from '../../domain/repositories/MessageEventRepository';

const COLUMNS = [
  'occurred_at',
  'channel',
  'channel_name',
  'conversation_id',
  'intent',
  'matched',
  'tags',
  'routed_step',
  'outcome',
  'node_red_status',
  'duration_ms',
] as const;

/** `$1`/`$2` = half-open UTC range, `$3` = optional channel (NULL = all). */
const WHERE = `occurred_at >= $1 AND occurred_at < $2 AND ($3::text IS NULL OR channel = $3)`;
const params = (range: EventRange): unknown[] => [range.from, range.to, range.channel ?? null];

export class PgMessageEventRepository implements MessageEventRepository {
  constructor(private readonly pool: Pool) {}

  async insertMany(events: NewMessageEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const values: unknown[] = [];
    const rows = events.map((e, row) => {
      values.push(
        e.occurredAt,
        e.channel,
        e.channelName,
        e.conversationId,
        e.intent,
        e.matched,
        e.tags,
        e.routedStep,
        e.outcome,
        e.nodeRedStatus,
        e.durationMs,
      );
      return `(${COLUMNS.map((_, col) => `$${row * COLUMNS.length + col + 1}`).join(', ')})`;
    });
    await this.pool.query(`INSERT INTO message_events (${COLUMNS.join(', ')}) VALUES ${rows.join(', ')}`, values);
    return events.length;
  }

  async totals(range: EventRange): Promise<EventTotals> {
    const result = await this.pool.query<{ total: number; conversations: number; matched: number; errors: number }>(
      `SELECT count(*)::int AS total,
              count(DISTINCT conversation_id)::int AS conversations,
              (count(*) FILTER (WHERE matched))::int AS matched,
              (count(*) FILTER (WHERE outcome = 'error'))::int AS errors
         FROM message_events
        WHERE ${WHERE}`,
      params(range),
    );
    const row = result.rows[0];
    return {
      totalMessages: row?.total ?? 0,
      uniqueConversations: row?.conversations ?? 0,
      matchedMessages: row?.matched ?? 0,
      errorMessages: row?.errors ?? 0,
    };
  }

  /** The channel filter is deliberately not applied: the breakdown always compares all channels. */
  async byChannel(range: EventRange): Promise<ChannelRow[]> {
    const result = await this.pool.query<{
      channel: string;
      channel_name: string | null;
      messages: number;
      conversations: number;
    }>(
      `SELECT channel,
              (array_agg(channel_name ORDER BY occurred_at DESC) FILTER (WHERE channel_name IS NOT NULL))[1] AS channel_name,
              count(*)::int AS messages,
              count(DISTINCT conversation_id)::int AS conversations
         FROM message_events
        WHERE occurred_at >= $1 AND occurred_at < $2
        GROUP BY channel
        ORDER BY messages DESC, channel ASC`,
      [range.from, range.to],
    );
    return result.rows.map((r) => ({
      channel: r.channel,
      channelName: r.channel_name,
      messages: r.messages,
      conversations: r.conversations,
    }));
  }

  async topTags(range: EventRange, limit: number): Promise<{ tag: string; count: number }[]> {
    const result = await this.pool.query<{ tag: string; count: number }>(
      `SELECT tag, count(*)::int AS count
         FROM message_events, unnest(tags) AS tag
        WHERE ${WHERE}
        GROUP BY tag
        ORDER BY count DESC, tag ASC
        LIMIT $4`,
      [...params(range), limit],
    );
    return result.rows.map((r) => ({ tag: r.tag, count: r.count }));
  }

  async daily(range: EventRange): Promise<DailyRow[]> {
    const result = await this.pool.query<{ day: string; channel: string; count: number }>(
      `SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              channel,
              count(*)::int AS count
         FROM message_events
        WHERE ${WHERE}
        GROUP BY day, channel
        ORDER BY day ASC, channel ASC`,
      params(range),
    );
    return result.rows.map((r) => ({ date: r.day, channel: r.channel, count: r.count }));
  }

  async topIntents(range: EventRange, limit: number): Promise<{ intent: string; count: number }[]> {
    const result = await this.pool.query<{ intent: string; count: number }>(
      `SELECT intent, count(*)::int AS count
         FROM message_events
        WHERE ${WHERE} AND intent IS NOT NULL
        GROUP BY intent
        ORDER BY count DESC, intent ASC
        LIMIT $4`,
      [...params(range), limit],
    );
    return result.rows.map((r) => ({ intent: r.intent, count: r.count }));
  }
}

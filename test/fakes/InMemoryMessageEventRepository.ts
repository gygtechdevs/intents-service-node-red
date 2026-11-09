import type {
  ChannelRow,
  DailyRow,
  EventRange,
  EventTotals,
  MessageEventRepository,
  NewMessageEvent,
} from '../../src/domain/repositories/MessageEventRepository';

const inRange = (event: NewMessageEvent, range: EventRange, useChannel = true): boolean =>
  event.occurredAt >= range.from &&
  event.occurredAt < range.to &&
  (!useChannel || !range.channel || event.channel === range.channel);

const countBy = <T>(items: T[], key: (item: T) => string): [string, number][] => {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return [...map.entries()];
};

/** Mirrors the SQL semantics of PgMessageEventRepository for tests without a database. */
export class InMemoryMessageEventRepository implements MessageEventRepository {
  readonly events: NewMessageEvent[] = [];

  async insertMany(events: NewMessageEvent[]): Promise<number> {
    this.events.push(...events);
    return events.length;
  }

  async totals(range: EventRange): Promise<EventTotals> {
    const rows = this.events.filter((e) => inRange(e, range));
    return {
      totalMessages: rows.length,
      uniqueConversations: new Set(rows.map((e) => e.conversationId)).size,
      matchedMessages: rows.filter((e) => e.matched).length,
      errorMessages: rows.filter((e) => e.outcome === 'error').length,
    };
  }

  async byChannel(range: EventRange): Promise<ChannelRow[]> {
    const rows = this.events.filter((e) => inRange(e, range, false));
    const channels = [...new Set(rows.map((e) => e.channel))];
    return channels
      .map((channel) => {
        const own = rows.filter((e) => e.channel === channel);
        const named = [...own].reverse().find((e) => e.channelName);
        return {
          channel,
          channelName: named?.channelName ?? null,
          messages: own.length,
          conversations: new Set(own.map((e) => e.conversationId)).size,
        };
      })
      .sort((a, b) => b.messages - a.messages || a.channel.localeCompare(b.channel));
  }

  async topTags(range: EventRange, limit: number): Promise<{ tag: string; count: number }[]> {
    const tags = this.events.filter((e) => inRange(e, range)).flatMap((e) => e.tags);
    return countBy(tags, (t) => t)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, limit);
  }

  async daily(range: EventRange): Promise<DailyRow[]> {
    const rows = this.events.filter((e) => inRange(e, range));
    return countBy(rows, (e) => `${e.occurredAt.toISOString().slice(0, 10)}|${e.channel}`).map(([k, count]) => {
      const [date, channel] = k.split('|') as [string, string];
      return { date, channel, count };
    });
  }

  async topIntents(range: EventRange, limit: number): Promise<{ intent: string; count: number }[]> {
    const intents = this.events
      .filter((e) => inRange(e, range) && e.intent !== null)
      .map((e) => e.intent as string);
    return countBy(intents, (i) => i)
      .map(([intent, count]) => ({ intent, count }))
      .sort((a, b) => b.count - a.count || a.intent.localeCompare(b.intent))
      .slice(0, limit);
  }
}

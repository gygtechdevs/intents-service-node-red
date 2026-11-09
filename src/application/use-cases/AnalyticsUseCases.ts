import { ApplicationError } from '../errors/ApplicationError';
import type { EventRange, MessageEventRepository } from '../../domain/repositories/MessageEventRepository';
import { CHANNEL_PATTERN } from './RecordEventsUseCase';

const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_LIMIT = 50;

export interface RawQuery {
  from?: unknown;
  to?: unknown;
  channel?: unknown;
  limit?: unknown;
}

interface Window {
  /** First UTC day (00:00Z). */
  start: Date;
  /** Day after the last UTC day (exclusive). */
  end: Date;
  days: number;
  channel?: string | undefined;
}

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

const parseDay = (value: unknown, field: string): Date => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApplicationError(`${field} must be a date in YYYY-MM-DD format`, 400);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ApplicationError(`${field} is not a valid date`, 400);
  }
  return date;
};

const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export class AnalyticsUseCases {
  constructor(
    private readonly repository: MessageEventRepository,
    private readonly now: () => Date,
  ) {}

  private window(query: RawQuery): Window {
    const today = startOfUtcDay(this.now());
    const hasFrom = query.from !== undefined && query.from !== '';
    const hasTo = query.to !== undefined && query.to !== '';
    const lastDay = hasTo ? parseDay(query.to, 'to') : today;
    const firstDay = hasFrom ? parseDay(query.from, 'from') : new Date(lastDay.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
    if (firstDay > lastDay) throw new ApplicationError('from must not be after to', 400);
    const days = Math.round((lastDay.getTime() - firstDay.getTime()) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) throw new ApplicationError(`date range must not exceed ${MAX_RANGE_DAYS} days`, 400);

    let channel: string | undefined;
    if (query.channel !== undefined && query.channel !== '') {
      if (typeof query.channel !== 'string' || !CHANNEL_PATTERN.test(query.channel)) {
        throw new ApplicationError('channel is invalid', 400);
      }
      channel = query.channel;
    }
    return { start: firstDay, end: new Date(lastDay.getTime() + DAY_MS), days, channel };
  }

  private limit(query: RawQuery, fallback: number): number {
    if (query.limit === undefined || query.limit === '') return fallback;
    const n = typeof query.limit === 'string' && /^\d+$/.test(query.limit) ? Number.parseInt(query.limit, 10) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw new ApplicationError(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
    }
    return n;
  }

  private range(w: Window): EventRange {
    return { from: w.start, to: w.end, channel: w.channel };
  }

  async summary(query: RawQuery) {
    const w = this.window(query);
    const previous: EventRange = {
      from: new Date(w.start.getTime() - w.days * DAY_MS),
      to: w.start,
      channel: w.channel,
    };
    const [current, prev] = await Promise.all([this.repository.totals(this.range(w)), this.repository.totals(previous)]);
    const total = current.totalMessages;
    return {
      totalMessages: total,
      uniqueConversations: current.uniqueConversations,
      matchedRate: total === 0 ? 0 : round(current.matchedMessages / total, 4),
      errorRate: total === 0 ? 0 : round(current.errorMessages / total, 4),
      previousPeriod: {
        totalMessages: prev.totalMessages,
        deltaPct: prev.totalMessages === 0 ? null : round(((total - prev.totalMessages) / prev.totalMessages) * 100, 1),
      },
    };
  }

  byChannel(query: RawQuery) {
    return this.repository.byChannel(this.range(this.window(query)));
  }

  async topTags(query: RawQuery) {
    const w = this.window(query);
    const limit = this.limit(query, 3);
    const [rows, totals] = await Promise.all([
      this.repository.topTags(this.range(w), limit),
      this.repository.totals(this.range(w)),
    ]);
    return rows.map((r) => ({
      tag: r.tag,
      count: r.count,
      pct: totals.totalMessages === 0 ? 0 : round((r.count / totals.totalMessages) * 100, 1),
    }));
  }

  async daily(query: RawQuery) {
    const w = this.window(query);
    const rows = await this.repository.daily(this.range(w));
    const channels = new Set<string>(['whatsapp', 'web', ...rows.map((r) => r.channel)]);
    const days = new Map<string, Record<string, number>>();
    for (let i = 0; i < w.days; i += 1) {
      const date = new Date(w.start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
      days.set(date, Object.fromEntries([...channels].map((c) => [c, 0])));
    }
    for (const r of rows) {
      const bucket = days.get(r.date);
      if (bucket) bucket[r.channel] = (bucket[r.channel] ?? 0) + r.count;
    }
    return [...days.entries()].map(([date, byChannel]) => ({
      date,
      byChannel,
      total: Object.values(byChannel).reduce((sum, n) => sum + n, 0),
    }));
  }

  topIntents(query: RawQuery) {
    const w = this.window(query);
    return this.repository.topIntents(this.range(w), this.limit(query, 10));
  }
}

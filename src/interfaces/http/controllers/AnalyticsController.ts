import type { Request, Response } from 'express';
import type { AnalyticsUseCases, RawQuery } from '../../../application/use-cases/AnalyticsUseCases';
import type { RecordEventsUseCase } from '../../../application/use-cases/RecordEventsUseCase';

const query = (req: Request): RawQuery => ({
  from: req.query.from,
  to: req.query.to,
  channel: req.query.channel,
  limit: req.query.limit,
});

export class AnalyticsController {
  constructor(
    private readonly recordEvents: RecordEventsUseCase,
    private readonly analytics: AnalyticsUseCases,
  ) {}

  ingest = async (req: Request, res: Response): Promise<void> => {
    const accepted = await this.recordEvents.execute(req.body);
    res.status(202).json({ accepted });
  };

  summary = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await this.analytics.summary(query(req)));
  };

  byChannel = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await this.analytics.byChannel(query(req)));
  };

  topTags = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await this.analytics.topTags(query(req)));
  };

  daily = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await this.analytics.daily(query(req)));
  };

  topIntents = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await this.analytics.topIntents(query(req)));
  };
}

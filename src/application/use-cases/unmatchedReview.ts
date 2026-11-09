import type { Unmatched, UnmatchedMessageRepository } from '../../domain/repositories/UnmatchedMessageRepository';
import { ApplicationError } from '../errors/ApplicationError';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loads a review item that must exist (404) and still be pending (409). Malformed ids are 404. */
export async function loadPending(
  repository: Pick<UnmatchedMessageRepository, 'findById'>,
  id: string,
): Promise<Unmatched> {
  if (!UUID.test(id)) throw new ApplicationError('Unmatched message not found', 404);
  const item = await repository.findById(id);
  if (!item) throw new ApplicationError('Unmatched message not found', 404);
  if (item.status !== 'pending') throw new ApplicationError('Unmatched message was already resolved', 409);
  return item;
}

export const ALREADY_RESOLVED = (): ApplicationError =>
  new ApplicationError('Unmatched message was already resolved', 409);

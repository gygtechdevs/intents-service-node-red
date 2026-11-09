import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { EMBEDDING_DIMENSIONS, type Embedder } from '../../domain/ports/Embedder';
import type { CircuitBreaker } from '../resilience/CircuitBreaker';
import { runWithTimeout } from '../resilience/deadline';
import type { BedrockSender } from './bedrockClient';

export interface TitanEmbedderOptions {
  client: BedrockSender;
  modelId: string;
  timeoutMs: number;
  breaker: CircuitBreaker;
}

export class TitanEmbedder implements Embedder {
  constructor(private readonly options: TitanEmbedderOptions) {}

  embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const { client, modelId, timeoutMs, breaker } = this.options;
    return breaker.execute(() =>
      runWithTimeout(
        timeoutMs,
        async (abortSignal) => {
          const command = new InvokeModelCommand({
            modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
          });
          const response = await client.send(command, { abortSignal });
          return parseEmbedding(response?.body);
        },
        signal,
      ),
    );
  }
}

const parseEmbedding = (body: unknown): number[] => {
  if (!(body instanceof Uint8Array)) throw new Error('Titan response has no body');
  const parsed = JSON.parse(new TextDecoder().decode(body)) as { embedding?: unknown };
  const embedding = parsed?.embedding;
  if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === 'number')) {
    throw new Error('Titan response has no numeric embedding');
  }
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding length ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`);
  }
  return embedding as number[];
};

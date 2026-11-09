import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

/** Minimal client surface the adapters need; easy to fake in tests. */
export interface BedrockSender {
  send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any>;
}

/**
 * maxAttempts: 1 -> no SDK retries (they would blow the latency budget; the breaker and
 * the fail-open path handle failures). Credentials come from the default provider chain.
 */
export const createBedrockClient = (region?: string): BedrockSender =>
  new BedrockRuntimeClient({ ...(region ? { region } : {}), maxAttempts: 1 });

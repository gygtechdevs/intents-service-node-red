/**
 * Free-form jsonb stored in `intents.steps`. `initialStep` and `description`
 * are the keys the public API knows about; the rest (flow graph nodes, ...) is
 * opaque to this service and must be preserved on update.
 */
export type IntentSteps = Record<string, unknown> & {
  initialStep?: string;
  description?: string;
};

export interface Intent {
  id: string;
  /** Maps to `intents.key`. Globally unique (D10) and immutable. */
  name: string;
  keywords: string[];
  /** Free-form labels (validated, unique case-insensitively). Empty when none. */
  tags: string[];
  /** Derived from `steps.initialStep`. */
  initialStep: string;
  /** Derived from `steps.description`. */
  description?: string;
  steps: IntentSteps;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** What the detector needs from an intent. */
export type DetectableIntent = Pick<Intent, 'name' | 'initialStep' | 'keywords'> & { tags?: string[] };

export interface DetectedIntent {
  intent: string;
  initialStep: string;
  confidence: number;
  matchedKeywords: string[];
  tags: string[];
  /** Which classifier produced the match. Absent for plain keyword matches. */
  source?: 'keyword' | 'semantic' | 'llm';
}

/** Builds the `steps` jsonb from the fields the API exposes, keeping unknown keys. */
export function buildSteps(
  base: IntentSteps,
  changes: { initialStep?: string; description?: string },
): IntentSteps {
  const steps: IntentSteps = { ...base };
  if (changes.initialStep !== undefined) steps.initialStep = changes.initialStep;
  if (changes.description !== undefined) steps.description = changes.description;
  return steps;
}

/** Derives the exposed fields from a persisted `steps` document. */
export function readSteps(steps: IntentSteps): { initialStep: string; description?: string } {
  return {
    initialStep: typeof steps.initialStep === 'string' ? steps.initialStep : '',
    ...(typeof steps.description === 'string' ? { description: steps.description } : {}),
  };
}

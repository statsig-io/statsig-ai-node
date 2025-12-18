import { EvalDataRecord } from './EvalData';

export type ScorerFunctionArgs<Input, Output, Expected> = EvalDataRecord<
  Input,
  Expected
> & { output: Output };

export type SimpleScore = number | boolean;
export interface ScoreWithMetadata {
  score: SimpleScore;
  metadata?: Record<string, unknown>;
}

export type Score = SimpleScore | ScoreWithMetadata;

export type ScorerFunction<Input, Output, Expected> = (
  args: ScorerFunctionArgs<Input, Output, Expected>,
) => Score | Promise<Score>;

// Multiple named scorers
export type EvalScorers<Input, Output, Expected> = Record<
  string,
  ScorerFunction<Input, Output, Expected>
>;

export function isScoreWithMetadata(
  value: unknown,
): value is ScoreWithMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    'score' in value &&
    (typeof (value as ScoreWithMetadata).score === 'number' ||
      typeof (value as ScoreWithMetadata).score === 'boolean')
  );
}

export function validateScoreDict(scorerName: string, value: object): void {
  if (!('score' in value)) {
    throw new Error(
      `Scorer '${scorerName}' returned a dict without a 'score' key. ` +
        `Expected dict with {score: number, metadata?: object} or a numeric value (number/boolean).`,
    );
  }

  const validKeys = new Set(['score', 'metadata']);
  const invalidKeys = Object.keys(value).filter((key) => !validKeys.has(key));

  if (invalidKeys.length > 0) {
    throw new Error(
      `Scorer '${scorerName}' returned a dict with invalid keys: [${invalidKeys.join(', ')}]. ` +
        `Only 'score' and 'metadata' keys are allowed.`,
    );
  }
}

/**
 * Normalizes a score value to a number (0.0 to 1.0 or any float).
 * - Boolean true -> 1.0, false -> 0.0
 * - Numbers are returned as-is
 * - ScoreWithMetadata extracts the score value
 */
export function normalizeScoreValue(value: Score): number {
  if (isScoreWithMetadata(value)) {
    return normalizeScoreValue(value.score);
  }
  if (typeof value === 'boolean') {
    return value ? 1.0 : 0.0;
  }
  if (typeof value === 'number') {
    return value;
  }
  console.warn(`[Statsig] Invalid score type: ${typeof value}`);
  try {
    return Number(value);
  } catch {
    return 0.0;
  }
}

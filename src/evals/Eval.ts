import {
  AttributeValue,
  context,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import {
  STATSIG_ATTR_EVAL_NAME,
  STATSIG_ATTR_EVAL_RECORD_INDEX,
  STATSIG_ATTR_EVAL_RUN_NAME,
  STATSIG_ATTR_EVAL_SCORER_NAME,
} from '../otel/conventions';
import { withStatsigEnvironment } from '../otel/environment-context';
import { OtelSingleton } from '../otel/singleton';
import { startWorkflow, wrap } from '../wrappers/wrap-call';
import {
  EvalParameters,
  InferParameters,
  parseParameters,
} from './EvalParameters';
import { EvalHooks } from './EvalHooks';
import { EvalData, EvalDataRecord } from './EvalData';
import {
  EvalScorers,
  Score,
  ScorerFunction,
  ScorerFunctionArgs,
  normalizeScoreValue,
  validateScoreDict,
} from './EvalScorer';

const STATSIG_POST_EVAL_ENDPOINT =
  'https://api.statsig.com/console/v1/evals/send_results';

export type EvalTask<Input, Output, Parameters extends EvalParameters> =
  | ((input: Input, hooks: EvalHooks<Parameters>) => Promise<Output>)
  | ((input: Input, hooks: EvalHooks<Parameters>) => Output);

export interface EvalOptions<
  Input,
  Output,
  Expected,
  Parameters extends EvalParameters,
> {
  /** Dataset of input/expected pairs or data set */
  data: EvalData<Input, Expected>;

  /** Function that generates an output given the input */
  task: EvalTask<Input, Output, Parameters>;

  /** Object of named scorer functions, or a single scorer function (will be named "Grader" by default) */
  scorer:
    | EvalScorers<Input, Output, Expected>
    | ScorerFunction<Input, Output, Expected>;

  /** Parameters for the eval */
  parameters?: Parameters;

  /** Optional name to identify the run of the eval */
  evalRunName?: string;

  /** A function that receives the results and produces optional summary scores. */
  summaryScoresFn?: (
    results: EvalResultRecord<Input, Output, Expected>[],
  ) => Record<string, number>;
}

interface ScoreWithMetadataInternal {
  score: number;
  metadata?: Record<string, unknown>;
}

interface RecordTraceIDs {
  /** Trace and root span of the record's run. Set when tracing is initialized. */
  traceID?: string;
  spanID?: string;
}

interface EvalResultRecordBase<Input, Output> extends RecordTraceIDs {
  input: Input;
  output: Output;
  category?: string[] | string;
  error?: boolean;
}

interface EvalResultRecordWithMetadata<Input, Output, Expected>
  extends EvalResultRecordBase<Input, Output> {
  scores: Record<string, ScoreWithMetadataInternal>;
  expected?: Expected;
}

export interface EvalResultRecord<Input, Output, Expected>
  extends EvalResultRecordBase<Input, Output> {
  scores: Record<string, number>;
  expected?: Expected;
}

export interface EvalMetadata {
  error: boolean;
}

export interface EvalResult<Input, Output, Expected> {
  results: EvalResultRecord<Input, Output, Expected>[];
  metadata: EvalMetadata;
  summaryScores?: Record<string, number>;
}

function normalizeScorer<Input, Output, Expected>(
  scorer:
    | EvalScorers<Input, Output, Expected>
    | ScorerFunction<Input, Output, Expected>,
): Record<
  string,
  (args: ScorerFunctionArgs<Input, Output, Expected>) => Score | Promise<Score>
> {
  if (typeof scorer === 'function') {
    return {
      Grader: scorer,
    };
  }

  if (typeof scorer === 'object' && scorer !== null) {
    const normalizedScorers: Record<
      string,
      (
        args: ScorerFunctionArgs<Input, Output, Expected>,
      ) => Score | Promise<Score>
    > = {};
    for (const [scorerName, scorerValue] of Object.entries(scorer)) {
      if (typeof scorerValue !== 'function') {
        throw new Error(
          `[Statsig] Invalid scorer type for '${scorerName}'. Scorer must be a function.`,
        );
      }
      normalizedScorers[scorerName] = scorerValue;
    }
    return normalizedScorers;
  }

  throw new Error('[Statsig] Invalid scorer provided.');
}

async function runScorer<Input, Output, Expected>(
  scorerName: string,
  scorerFn: (
    args: ScorerFunctionArgs<Input, Output, Expected>,
  ) => Score | Promise<Score>,
  args: ScorerFunctionArgs<Input, Output, Expected>,
): Promise<ScoreWithMetadataInternal> {
  try {
    const rawScore = await scorerFn(args);

    if (typeof rawScore === 'number' || typeof rawScore === 'boolean') {
      return {
        score: normalizeScoreValue(rawScore),
        metadata: undefined,
      };
    }

    if (typeof rawScore === 'object' && rawScore !== null) {
      validateScoreDict(scorerName, rawScore);
      const dictScore = rawScore as {
        score: Score;
        metadata?: Record<string, unknown>;
      };
      return {
        score: normalizeScoreValue(dictScore.score),
        metadata: dictScore.metadata,
      };
    }

    // Invalid type
    throw new TypeError(
      `Scorer '${scorerName}' returned invalid type: ${typeof rawScore}. ` +
        `Expected one of: number, boolean, dict with 'score' key, or ScoreWithMetadata object.`,
    );
  } catch (err) {
    console.warn(`[Statsig] Scorer '${scorerName}' failed:`, args.input, err);
    return { score: 0, metadata: undefined };
  }
}

function convertToNumScores<Input, Output, Expected>(
  results: EvalResultRecordWithMetadata<Input, Output, Expected>[],
): EvalResultRecord<Input, Output, Expected>[] {
  return results.map(({ scores, ...rest }) => {
    const simpleScores = Object.fromEntries(
      Object.entries(scores).map(([k, { score }]) => [k, score]),
    );

    return { ...rest, scores: simpleScores };
  });
}

/**
 * Runs the summary scorer function with error handling.
 */
function runSummaryScorer<Input, Output, Expected>(
  summaryScoresFn:
    | ((
        results: EvalResultRecord<Input, Output, Expected>[],
      ) => Record<string, number>)
    | undefined,
  results: EvalResultRecord<Input, Output, Expected>[],
): Record<string, number> | undefined {
  if (!summaryScoresFn) {
    return undefined;
  }

  try {
    return summaryScoresFn(results);
  } catch (err) {
    console.warn('[Statsig] Summary scorer failed:', err);
    return undefined;
  }
}

/**
 * Runs `fn` in a new root workflow span, so every record gets its own trace
 * even when Eval() is called inside another span.
 */
function startRecordTrace<R>(
  name: string,
  attributes: Record<string, AttributeValue>,
  fn: (ids: RecordTraceIDs) => R,
): R {
  return context.with(trace.deleteSpan(context.active()), () =>
    startWorkflow({ name, attributes }, () => fn(getActiveSpanIDs())),
  );
}

function startScorerSpan<R>(scorerName: string, fn: () => R): R {
  return wrap(
    {
      type: 'workflow',
      name: scorerName,
      attributes: { [STATSIG_ATTR_EVAL_SCORER_NAME]: scorerName },
    },
    fn,
  )();
}

function getActiveSpanIDs(): RecordTraceIDs {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) {
    return {};
  }
  return { traceID: spanContext.traceId, spanID: spanContext.spanId };
}

export async function Eval<
  Input,
  Output,
  Expected = void,
  Parameters extends EvalParameters = {},
>(
  name: string,
  options: EvalOptions<Input, Output, Expected, Parameters>,
): Promise<EvalResult<Input, Output, Expected>> {
  const { data, task, scorer, parameters, evalRunName, summaryScoresFn } =
    options;
  const apiKey = process.env.STATSIG_API_KEY;

  if (!apiKey) {
    throw new Error(
      '[Statsig] Missing Statsig Console API key. Please set the STATSIG_API_KEY environment variable with your Statsig console API key.',
    );
  }

  const normalizedData = await normalizeEvalData(data);
  const parsedParameters = parameters
    ? parseParameters(parameters)
    : ({} as InferParameters<Parameters>);

  const normalizedScorers = normalizeScorer(scorer);
  const scorerEntries = Object.entries(normalizedScorers);
  // Without initializeTracing() there is no exporter, so records aren't traced.
  const traceRecords = OtelSingleton.isInitialized();

  const resultsWithMetadata: EvalResultRecordWithMetadata<
    Input,
    Output,
    Expected
  >[] = await Promise.all(
    normalizedData.map(async (record, recordIndex) => {
      let output: Output | undefined;
      let scores: Record<string, ScoreWithMetadataInternal> = {};
      let error = false;
      let traceIDs: RecordTraceIDs = {};

      const runTaskAndScorers = async () => {
        output = await task(record.input, {
          parameters: parsedParameters,
          category: record.category ?? '',
        });

        const scorerArgs: ScorerFunctionArgs<Input, Output, Expected> = {
          ...record,
          output: output as Output,
        };

        const scoreResults = await Promise.all(
          scorerEntries.map(([scorerName, scorerFn]) => {
            const score = () => runScorer(scorerName, scorerFn, scorerArgs);
            return traceRecords ? startScorerSpan(scorerName, score) : score();
          }),
        );

        scorerEntries.forEach(([scorerName], index) => {
          scores[scorerName] = scoreResults[index];
        });
      };

      try {
        await withStatsigEnvironment('eval', () =>
          traceRecords
            ? startRecordTrace(
                name,
                {
                  [STATSIG_ATTR_EVAL_NAME]: name,
                  [STATSIG_ATTR_EVAL_RECORD_INDEX]: recordIndex,
                  ...(evalRunName !== undefined
                    ? { [STATSIG_ATTR_EVAL_RUN_NAME]: evalRunName }
                    : {}),
                },
                (ids) => {
                  traceIDs = ids;
                  return runTaskAndScorers();
                },
              )
            : runTaskAndScorers(),
        );
      } catch (err) {
        console.warn('[Statsig] Eval failed:', record.input, err);
        if (output === undefined) {
          output = '[Error]' as unknown as Output;
        }
        error = true;
        for (const scorerName of Object.keys(normalizedScorers)) {
          scores[scorerName] = { score: 0, metadata: undefined };
        }
      }

      return {
        ...record,
        ...traceIDs,
        output,
        scores,
        error,
      } as EvalResultRecordWithMetadata<Input, Output, Expected>;
    }),
  );

  const results = convertToNumScores(resultsWithMetadata);
  const computedSummaryScores = runSummaryScorer(summaryScoresFn, results);

  if (traceRecords) {
    // Export the record spans before returning, so they aren't lost if the
    // process exits right after the eval.
    await OtelSingleton.flushInstance().catch((err) =>
      console.warn('[Statsig] Failed to flush eval spans:', err),
    );
  }

  await sendEvalResults(
    name,
    resultsWithMetadata,
    apiKey,
    evalRunName,
    computedSummaryScores,
    parameters,
  );

  return {
    results,
    metadata: { error: results.some((result) => result.error) },
    summaryScores: computedSummaryScores,
  };
}

async function normalizeEvalData<Input, Expected>(
  data: EvalData<Input, Expected>,
): Promise<EvalDataRecord<Input, Expected>[]> {
  if (typeof data === 'string') {
    throw new Error(
      '[Statsig] Invalid type provided to data parameter. String is not supported.',
    );
  }

  let dataOrAsyncData = typeof data === 'function' ? data() : data;

  if (dataOrAsyncData instanceof Promise) {
    return await dataOrAsyncData;
  }

  if (Symbol.asyncIterator in Object(dataOrAsyncData)) {
    const collected: EvalDataRecord<Input, Expected>[] = [];
    for await (const data of dataOrAsyncData) {
      collected.push(data);
    }
    return collected;
  }

  if (Array.isArray(dataOrAsyncData)) {
    return dataOrAsyncData;
  }

  throw new Error('[Statsig] Invalid type provided to data parameter.');
}

interface EvalResultsPayload {
  results: EvalResultRecordWithMetadata<string, string, string>[];
  name?: string;
  summaryScores?: Record<string, number>;
  parameters?: Record<string, string>;
}

function validateSummary(summary: Record<string, number>): void {
  for (const [key, value] of Object.entries(summary)) {
    if (typeof key !== 'string') {
      throw new Error('[Statsig] summary keys must be strings');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `[Statsig] summary values must be finite numbers. Invalid value for key "${key}": ${value}`,
      );
    }
  }
}

/**
 * Serializes parameters for the API payload.
 * String values are kept as-is, non-string values are JSON stringified.
 */
function serializeParameters<Parameters extends EvalParameters>(
  parameters: Parameters | undefined,
): Record<string, string> | undefined {
  if (!parameters || Object.keys(parameters).length === 0) {
    return undefined;
  }

  const serialized: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === 'string') {
      serialized[key] = value;
    } else {
      // For Zod schemas, try to get the default value
      if (value && typeof value === 'object' && '_def' in value) {
        // It's a Zod schema - parse to get default value
        try {
          const parsed = (value as { parse: (val: unknown) => unknown }).parse(
            undefined,
          );
          serialized[key] =
            typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        } catch {
          serialized[key] = JSON.stringify(value);
        }
      } else {
        serialized[key] = JSON.stringify(value);
      }
    }
  }
  return serialized;
}

/**
 * Serializes a record for the API payload. The API only accepts strings for
 * the input, output, expected value and score metadata values, so other
 * values (such as an object input or a numeric confidence) are JSON
 * stringified.
 */
function serializeRecord<Input, Output, Expected>(
  record: EvalResultRecordWithMetadata<Input, Output, Expected>,
): EvalResultRecordWithMetadata<string, string, string> {
  return {
    ...record,
    input: stringifyPayloadValue(record.input) ?? '',
    output: stringifyPayloadValue(record.output) ?? '',
    expected:
      record.expected === undefined
        ? undefined
        : stringifyPayloadValue(record.expected),
    scores: serializeScores(record.scores),
  };
}

function serializeScores(
  scores: Record<string, ScoreWithMetadataInternal>,
): Record<string, ScoreWithMetadataInternal> {
  return Object.fromEntries(
    Object.entries(scores).map(([scorerName, { score, metadata }]) => [
      scorerName,
      {
        score,
        metadata:
          metadata &&
          Object.fromEntries(
            Object.entries(metadata).map(([key, value]) => [
              key,
              stringifyPayloadValue(value),
            ]),
          ),
      },
    ]),
  );
}

function stringifyPayloadValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function sendEvalResults<
  Input,
  Output,
  Expected,
  Parameters extends EvalParameters,
>(
  name: string,
  records: EvalResultRecordWithMetadata<Input, Output, Expected>[],
  apiKey: string,
  evalRunName?: string,
  computedSummaryScores?: Record<string, number>,
  parameters?: Parameters,
): Promise<void> {
  try {
    // Validate summary if provided
    if (computedSummaryScores) {
      validateSummary(computedSummaryScores);
    }

    const fetchImpl: typeof fetch =
      (globalThis as any).fetch ??
      (((await import('node-fetch')) as any).default as typeof fetch);

    const serializedParameters = serializeParameters(parameters);

    const requestBody: EvalResultsPayload = {
      results: records.map(serializeRecord),
      ...(evalRunName !== undefined && { name: evalRunName }),
      ...(computedSummaryScores !== undefined && {
        summaryScores: computedSummaryScores,
      }),
      ...(serializedParameters !== undefined && {
        parameters: serializedParameters,
      }),
    };

    const response = await fetchImpl(
      `${STATSIG_POST_EVAL_ENDPOINT}/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'STATSIG-API-KEY': apiKey,
        },
        body: JSON.stringify(requestBody),
      },
    );

    if (!response.ok) {
      console.warn(
        `[Statsig] Failed to send eval results: ${response.status} ${response.statusText}`,
      );
    } else {
      console.info(
        `[Statsig] Sent eval results (${records.length} records): ${response.statusText}`,
      );
    }
  } catch (error) {
    console.error(`[Statsig] Error sending eval results:`, error);
  }
}

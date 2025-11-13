import {
  EvalParameters,
  InferParameters,
  parseParameters,
} from './EvalParameters';
import { EvalHooks } from './EvalHooks';
import { EvalData, EvalDataRecord } from './EvalData';
import { EvalScorers, ScorerFunction, ScorerFunctionArgs } from './EvalScorer';

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

export type EvalResultRecord<Input, Output, Expected> = {
  input: Input;
  output: Output;
  scores: Record<string, number>;
  category?: string[] | string;
  error?: boolean;
} & (Expected extends void ? {} : { expected: Expected });

export interface EvalMetadata {
  error: boolean;
}

export interface EvalResult<Input, Output, Expected> {
  results: EvalResultRecord<Input, Output, Expected>[];
  metadata: EvalMetadata;
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
  const {
    data,
    task,
    scorer,
    parameters,
    evalRunName,
    summaryScoresFn: summaryScores,
  } = options;
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

  const normalizedScorer =
    typeof scorer === 'function'
      ? { Grader: scorer }
      : typeof scorer === 'object' && scorer !== null
        ? scorer
        : null;

  if (!normalizedScorer) {
    throw new Error('[Statsig] Invalid scorer provided.');
  }

  const results: EvalResultRecord<Input, Output, Expected>[] =
    await Promise.all(
      normalizedData.map(async (record) => {
        let output: Output | undefined;
        let scores: Record<string, number> = {};
        let error = false;

        try {
          output = await task(record.input, {
            parameters: parsedParameters,
            category: record.category ?? '',
          });

          const scorerArgs: ScorerFunctionArgs<Input, Output, Expected> = {
            ...record,
            output,
          };

          await Promise.all(
            Object.entries(normalizedScorer).map(async ([name, scorerFn]) => {
              try {
                const rawScore = await scorerFn(scorerArgs);
                const normalizedScore =
                  typeof rawScore === 'boolean' ? (rawScore ? 1 : 0) : rawScore;
                scores[name] = normalizedScore;
              } catch (err) {
                console.warn(
                  `[Statsig] Scorer '${name}' failed:`,
                  record.input,
                  err,
                );
                scores[name] = 0;
              }
            }),
          );
        } catch (err) {
          console.warn('[Statsig] Eval failed:', record.input, err);
          if (output === undefined) {
            output = '[Error]' as unknown as Output;
          }
          error = true;
          scores = {};
        }

        return {
          ...record,
          output,
          scores,
          ...(error ? { error: true } : {}),
        } as EvalResultRecord<Input, Output, Expected>;
      }),
    );

  let computedSummaryScores: Record<string, number> | undefined;
  if (summaryScores) {
    if (typeof summaryScores === 'function') {
      computedSummaryScores = summaryScores(results);
    }
  }

  await sendEvalResults(
    name,
    results,
    apiKey,
    evalRunName,
    computedSummaryScores,
  );
  return {
    results,
    metadata: { error: results.some((result) => result.error) },
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

interface EvalResultsPayload<Input, Output, Expected> {
  results: EvalResultRecord<Input, Output, Expected>[];
  name?: string;
  summaryScores?: Record<string, number>;
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

async function sendEvalResults<Input, Output, Expected>(
  name: string,
  records: EvalResultRecord<Input, Output, Expected>[],
  apiKey: string,
  evalRunName?: string,
  computedSummaryScores?: Record<string, number>,
): Promise<void> {
  try {
    // Validate summary if provided
    if (computedSummaryScores) {
      validateSummary(computedSummaryScores);
    }

    const fetchImpl: typeof fetch =
      (globalThis as any).fetch ??
      (((await import('node-fetch')) as any).default as typeof fetch);

    const requestBody: EvalResultsPayload<Input, Output, Expected> = {
      results: records,
      ...(evalRunName !== undefined && { name: evalRunName }),
      ...(computedSummaryScores !== undefined && {
        summaryScores: computedSummaryScores,
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

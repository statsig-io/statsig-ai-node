const STATSIG_POST_EVAL_ENDPOINT =
  'http://api.statsig.com/console/v1/evals/send_results';

export interface EvalDataRecord<Input, Expected> {
  input: Input;
  expected: Expected;
}

export type EvalData<Input, Expected> =
  | EvalDataRecord<Input, Expected>[]
  | (() => EvalDataRecord<Input, Expected>[])
  | Promise<EvalDataRecord<Input, Expected>[]>
  | (() => Promise<EvalDataRecord<Input, Expected>[]>)
  | AsyncGenerator<EvalDataRecord<Input, Expected>>
  | AsyncIterable<EvalDataRecord<Input, Expected>>;

export type EvalTask<Input, Output> = (
  input: Input,
) => Output | Promise<Output>;

export type EvalScorerArgs<Input, Output, Expected> = EvalDataRecord<
  Input,
  Expected
> & { output: Output };
export type Score = number | boolean;
export type EvalScorer<Input, Output, Expected> = (
  args: EvalScorerArgs<Input, Output, Expected>,
) => Score;

export interface EvalOptions<Input, Output, Expected> {
  /** Dataset of input/expected pairs or data set */
  data: EvalData<Input, Expected>;

  /** Function that generates an output given the input */
  task: EvalTask<Input, Output>;

  /** Function that scores model output against expected output */
  scorer: EvalScorer<Input, Output, Expected>;
}

export interface EvalResult<Input, Output, Expected> {
  input: Input;
  expected: Expected;
  output: Output;
  score: number;
}

export async function Eval<Input, Output, Expected>(
  name: string,
  options: EvalOptions<Input, Output, Expected>,
): Promise<EvalResult<Input, Output, Expected>[]> {
  const { data, task, scorer } = options;
  const apiKey = process.env.STATSIG_API_KEY;

  if (!apiKey) {
    throw new Error(
      '[Statsig] Missing Statsig Console API key. Please set the STATSIG_API_KEY environment variable with your Statsig console API key.',
    );
  }

  const normalizedData = await normalizeEvalData(data);

  const results = await Promise.all(
    normalizedData.map(async (record) => {
      let output: Output | undefined;
      let score = 0;
      let error = false;

      try {
        output = await task(record.input);
        const rawScore = await scorer({
          input: record.input,
          expected: record.expected,
          output,
        });
        score = typeof rawScore === 'boolean' ? (rawScore ? 1 : 0) : rawScore;
      } catch (err) {
        error = true;
        console.warn('[Statsig] Eval failed:', record.input, err);
        output = '[Error]' as unknown as Output;
        score = 0;
      }

      return {
        input: record.input,
        expected: record.expected,
        output,
        score,
        ...(error ? { error: true } : {}),
      };
    }),
  );

  await sendEvalResults(name, results, apiKey);
  return results;
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

async function sendEvalResults<Input, Output, Expected>(
  name: string,
  results: EvalResult<Input, Output, Expected>[],
  apiKey: string,
): Promise<void> {
  try {
    const response = await fetch(
      `${STATSIG_POST_EVAL_ENDPOINT}/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'STATSIG-API-KEY': apiKey,
        },
        body: JSON.stringify({ dataset: results }),
      },
    );

    if (!response.ok) {
      console.warn(
        `[Statsig] Failed to send eval results: ${response.status} ${response.statusText}`,
      );
    } else {
      console.info(
        `[Statsig] Sent eval results (${results.length} records): ${response.statusText}`,
      );
    }
  } catch (error) {
    console.error(`[Statsig] Error sending eval results:`, error);
  }
}

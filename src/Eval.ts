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

export type EvalScorer<Input, Output, Expected> = (
  args: EvalScorerArgs<Input, Output, Expected>,
) => number;

export interface EvalOptions<Input, Output, Expected> {
  /** Dataset of input/expected pairs or data set */
  data: EvalData<Input, Expected>;

  /** Function that generates an output given the input */
  task: EvalTask<Input, Output>;

  /** Function that scores model output against expected output */
  scorer: EvalScorer<Input, Output, Expected>;

  /** Optional override for API endpoint */
  endpoint?: string;

  /** Optional override for API key */
  apiKey?: string;
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
  const { data, task, scorer, endpoint, apiKey } = options;

  const dataset = typeof data === 'function' ? data() : data;
  const results: EvalResult<Input, Output, Expected>[] = [];

  for (const record of dataset) {
    try {
      const output = await task(record.input);
      const rawScore = scorer(output, record.expected);
      const score =
        typeof rawScore === 'boolean' ? (rawScore ? 1 : 0) : rawScore;

      results.push({
        input: record.input,
        expected: record.expected,
        output,
        score,
      });
    } catch (err) {
      console.warn(`[Statsig] Eval task failed for input:`, record.input, err);
      results.push({
        input: record.input,
        expected: record.expected,
        output: '[Error]',
        score: 0,
      });
    }
  }

  try {
    const response = await fetch(`${endpoint}/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'STATSIG-API-KEY': apiKey,
      },
      body: JSON.stringify({ dataset: results }),
    });

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

  return results;
}

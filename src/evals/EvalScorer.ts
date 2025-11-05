import { EvalDataRecord } from './EvalData';

export type ScorerFunctionArgs<Input, Output, Expected> = EvalDataRecord<
  Input,
  Expected
> & { output: Output };

export type Score = number | boolean;

// Single scorer function type - works for both single and multiple scorer cases
export type ScorerFunction<Input, Output, Expected> = (
  args: ScorerFunctionArgs<Input, Output, Expected>,
) => Score | Promise<Score>;

// Multiple named scorers
export type EvalScorers<Input, Output, Expected> = Record<
  string,
  ScorerFunction<Input, Output, Expected>
>;

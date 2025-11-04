export interface EvalDataRecord<Input, Expected> {
  input: Input;
  expected: Expected;
  category?: string[] | string;
}

export type EvalData<Input, Expected> =
  | EvalDataRecord<Input, Expected>[]
  | (() => EvalDataRecord<Input, Expected>[])
  | Promise<EvalDataRecord<Input, Expected>[]>
  | (() => Promise<EvalDataRecord<Input, Expected>[]>)
  | AsyncGenerator<EvalDataRecord<Input, Expected>>
  | AsyncIterable<EvalDataRecord<Input, Expected>>;

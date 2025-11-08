export type EvalDataRecord<Input, Expected> = {
  input: Input;
  category?: string[] | string;
} & (Expected extends void ? {} : { expected: Expected });

export type EvalData<Input, Expected> =
  | EvalDataRecord<Input, Expected>[]
  | (() => EvalDataRecord<Input, Expected>[])
  | Promise<EvalDataRecord<Input, Expected>[]>
  | (() => Promise<EvalDataRecord<Input, Expected>[]>)
  | AsyncGenerator<EvalDataRecord<Input, Expected>>
  | AsyncIterable<EvalDataRecord<Input, Expected>>;

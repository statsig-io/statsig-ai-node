import { z } from 'zod';

export const parametersSchema = z.record(z.string(), z.instanceof(z.ZodType));

export type EvalParameters = z.infer<typeof parametersSchema>;

type InferParameterValue<T> = T extends z.ZodType ? z.infer<T> : never;

export type InferParameters<T extends EvalParameters> = {
  [K in keyof T]: InferParameterValue<T[K]>;
};

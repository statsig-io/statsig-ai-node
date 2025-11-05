import { z } from 'zod';

export const parametersSchema = z.record(z.string(), z.instanceof(z.ZodType));

export type EvalParameters = z.infer<typeof parametersSchema>;

type InferParameterValue<T> = T extends z.ZodType ? z.infer<T> : never;

export function parseParameters<Parameters extends EvalParameters>(
  parameters: Parameters,
): InferParameters<Parameters> {
  const parsed: any = {};
  for (const key in parameters) {
    if (parameters.hasOwnProperty(key)) {
      // Parse with undefined to trigger default values
      parsed[key] = parameters[key].parse(undefined);
    }
  }
  return parsed as InferParameters<Parameters>;
}

export type InferParameters<T extends EvalParameters> = {
  [K in keyof T]: InferParameterValue<T[K]>;
};

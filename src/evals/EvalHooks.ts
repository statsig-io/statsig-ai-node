import { EvalParameters, InferParameters } from './EvalParameters';

export interface EvalHooks<Parameters extends EvalParameters> {
  parameters: InferParameters<Parameters>;
}

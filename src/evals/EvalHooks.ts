import { EvalParameters, InferParameters } from './EvalParameters';

/** Token counts a task reports with `reportTokens` */
export interface EvalTokenUsage {
  /** Tokens sent to the model, such as the prompt */
  inputTokens: number;
  /** Tokens the model generated */
  outputTokens: number;
}

export interface EvalHooks<Parameters extends EvalParameters> {
  parameters: InferParameters<Parameters>;
  category: string[] | string;

  /**
   * Reports the tokens the task used to produce its output. Each call adds to
   * the record's totals, so a multi-step task can call it once per model call
   * or once with its total. The totals are sent with the record's result. A
   * record whose task never calls this, or throws, sends no tokens.
   *
   * Counts must be finite numbers of at least 0. A call with any other count
   * is ignored with a warning.
   */
  reportTokens: (usage: EvalTokenUsage) => void;
}

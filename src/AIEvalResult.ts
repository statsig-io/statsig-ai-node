import { PromptVersion } from './PromptVersion';

// probably could have a better name for this
export interface AIEvalResult {
  score: number;
  session_id: string;
  version: PromptVersion;
}

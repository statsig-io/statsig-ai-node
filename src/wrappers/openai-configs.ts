import { AttributeValue } from '@opentelemetry/api';

interface ChatLike {
  completions: any;
}

export interface OpenAILike {
  chat: ChatLike;
  embeddings: any;
  moderations: any;
  responses?: any;
  completions?: any;
  images?: any;
}

export interface GenAICaptureOptions {
  capture_all?: boolean;
  capture_input_messages?: boolean;
  capture_output_messages?: boolean;
  capture_system_instructions?: boolean;
  capture_tool_definitions?: boolean;
}

export interface StatsigOpenAIProxyConfig {
  customAttributes?: Record<string, AttributeValue>;

  captureOptions?: GenAICaptureOptions;

  maxJSONChars?: number; // default to 40,000
}

export function isOpenAILike(obj: any): obj is OpenAILike {
  return !!(
    obj &&
    typeof obj === 'object' &&
    'chat' in obj &&
    typeof obj.chat === 'object' &&
    'completions' in obj.chat &&
    typeof obj.chat.completions === 'object' &&
    'create' in obj.chat.completions
  );
}

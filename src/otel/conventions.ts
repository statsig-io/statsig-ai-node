export const STATSIG_ATTR_SPAN_TYPE = 'statsig.span.type';
export const StatsigSpanType = {
  gen_ai: 'gen_ai',
} as const;

export const STATSIG_ATTR_GEN_AI_SPAN_TYPE = 'statsig.span.gen_ai.type';
export const StatsigGenAISpanType = {
  workflow: 'workflow',
  tool: 'tool',
  chat: 'chat',
  generate_content: 'generate_content',
} as const;

export const STATSIG_ATTR_SPAN_LLM_ROOT = 'statsig.span.llm_root';
export const STATSIG_SPAN_LLM_ROOT_VALUE = '1';

export const STATSIG_ATTR_LLM_PROMPT_NAME = 'statsig.llm.prompt_name';
export const STATSIG_ATTR_LLM_PROMPT_VERSION = 'statsig.llm.prompt_version';
export const STATSIG_ATTR_USER_ID = 'statsig.user_id';
export const STATSIG_ATTR_CUSTOM_IDS = 'statsig.custom_ids';
export const STATSIG_ATTR_ACTIVITY_ID = 'statsig.activity_id';

export const STATSIG_CTX_KEY_ACTIVE_PROMPT = Symbol(
  'STATSIG_CTX_KEY_ACTIVE_PROMPT',
);
export const STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION = Symbol(
  'STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION',
);
export const STATSIG_CTX_KEY_ACTIVE_USER = Symbol(
  'STATSIG_CTX_KEY_ACTIVE_USER',
);
export const STATSIG_CTX_KEY_ACTIVE_CONTEXT = Symbol(
  'STATSIG_CTX_KEY_ACTIVE_CONTEXT',
);

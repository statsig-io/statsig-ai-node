import { AttributeValue, context, Context } from '@opentelemetry/api';
import { jsonAttribute } from '../wrappers/gen-ai-messages';
import {
  STATSIG_ATTR_LLM_PROMPT_NAME,
  STATSIG_ATTR_LLM_PROMPT_TEMPLATE_VARIABLES,
  STATSIG_ATTR_LLM_PROMPT_VERSION,
  STATSIG_ATTR_LLM_PROMPT_VERSION_ID,
  STATSIG_CTX_KEY_ACTIVE_PROMPT,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_TEMPLATE,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION_ID,
} from './conventions';

// The template variables aren't known when a version scope starts; they arrive
// later when getPromptMessages() renders the prompt inside it. Contexts are
// immutable, so the scope holds this object and rendering fills it in.
type ActivePromptTemplate = {
  versionID: string;
  variables?: Record<string, unknown>;
};

export function setPromptVersionToContext(
  ctx: Context,
  promptName: string,
  versionName: string,
  versionID: string,
): Context {
  const template: ActivePromptTemplate = { versionID };
  return ctx
    .setValue(STATSIG_CTX_KEY_ACTIVE_PROMPT, promptName)
    .setValue(STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION, versionName)
    .setValue(STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION_ID, versionID)
    .setValue(STATSIG_CTX_KEY_ACTIVE_PROMPT_TEMPLATE, template);
}

// Called when a version renders its prompt. Only records the variables if that
// version is the one the active scope is for, so rendering a different version
// inside the scope doesn't mislabel its spans.
export function recordPromptTemplateVariables(
  versionID: string,
  variables: Record<string, unknown>,
): void {
  const template = getActivePromptTemplate(context.active());
  if (template && template.versionID === versionID) {
    template.variables = { ...variables };
  }
}

export function getPromptSpanAttrsFromContext(
  ctx: Context,
  options: { includeTemplateVariables: boolean },
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  const contextValues: [symbol, string][] = [
    [STATSIG_CTX_KEY_ACTIVE_PROMPT, STATSIG_ATTR_LLM_PROMPT_NAME],
    [STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION, STATSIG_ATTR_LLM_PROMPT_VERSION],
    [
      STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION_ID,
      STATSIG_ATTR_LLM_PROMPT_VERSION_ID,
    ],
  ];
  for (const [ctxKey, attr] of contextValues) {
    const value = ctx.getValue(ctxKey);
    if (value && typeof value === 'string') {
      attrs[attr] = value;
    }
  }

  const variables = getActivePromptTemplate(ctx)?.variables;
  if (options.includeTemplateVariables && variables) {
    attrs[STATSIG_ATTR_LLM_PROMPT_TEMPLATE_VARIABLES] =
      jsonAttribute(variables);
  }

  return attrs;
}

function getActivePromptTemplate(ctx: Context): ActivePromptTemplate | null {
  const template = ctx.getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT_TEMPLATE);
  if (template == null || typeof template !== 'object') {
    return null;
  }
  return template as ActivePromptTemplate;
}

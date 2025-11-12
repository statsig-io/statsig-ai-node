import { AttributeValue } from '@opentelemetry/api';
import { GenAICaptureOptions } from './openai-configs';

export function extractUsageAttributes(
  usage: Record<string, any>,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  attrs['gen_ai.usage.input_tokens'] = usage.prompt_tokens;
  attrs['gen_ai.usage.output_tokens'] = usage.completion_tokens;
  return attrs;
}

export function extractBaseAttributes(
  operationName: string,
  params: Record<string, any>,
  options: GenAICaptureOptions,
): Record<string, AttributeValue> {
  const model = params.model;
  const attrs: Record<string, AttributeValue> = {
    'gen_ai.operation.name': operationName,
    'gen_ai.request.model': model,
  };
  attrs['gen_ai.request.max_tokens'] =
    params.max_tokens ?? params.max_completion_tokens;
  attrs['gen_ai.request.temperature'] = params.temperature;
  attrs['gen_ai.request.top_p'] = params.top_p;
  attrs['gen_ai.request.top_k'] = params.top_k;
  attrs['gen_ai.request.frequency_penalty'] = params.frequency_penalty;
  attrs['gen_ai.request.presence_penalty'] = params.presence_penalty;
  attrs['gen_ai.request.stop_sequences'] = params.stop ?? params.stop_sequences;
  if (params.n && params.n !== 1)
    attrs['gen_ai.request.choice.count'] = params.n;
  attrs['gen_ai.request.seed'] = params.seed;
  attrs['gen_ai.conversation.id'] = params.conversation_id;
  attrs['gen_ai.output.type'] = params.response_format?.type;
  const msgs = params.messages ?? [];
  if (options.capture_all || options.capture_input_messages) {
    attrs['gen_ai.input.messages'] = msgs;
  }
  if (options.capture_all || options.capture_system_instructions) {
    attrs['gen_ai.system.instructions'] = msgs.filter(
      (m: any) => m.role === 'system',
    );
  }
  if (options.capture_all || options.capture_tool_definitions) {
    attrs['gen_ai.tool.definitions'] = params.tools;
  }
  if (operationName === 'embeddings') {
    Object.assign(attrs, extractEmbeddingsAttributes(params));
  }
  return attrs;
}

export function extractResponseAttributes(
  response: any,
  options: GenAICaptureOptions,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  const res = response ?? {};
  attrs['gen_ai.response.id'] = res.id;
  attrs['gen_ai.response.model'] = res.model;
  const finishReasons = (res.choices ?? []).map((c: any) => c.finish_reason);
  if (finishReasons.length)
    attrs['gen_ai.response.finish_reasons'] = finishReasons;
  if (options.capture_all || options.capture_output_messages) {
    attrs['gen_ai.output.messages'] = res.choices;
  }
  return attrs;
}

function extractEmbeddingsAttributes(
  params: Record<string, any>,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  attrs['gen_ai.embeddings.dimension.count'] = params.dimensions;
  attrs['gen_ai.request.encoding_formats'] = [params.encoding_format];
  return attrs;
}

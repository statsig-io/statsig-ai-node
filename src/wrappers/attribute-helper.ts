import { AttributeValue } from '@opentelemetry/api';
import { GenAICaptureOptions } from './openai-configs';

export function extractBaseAttributes(
  operationName: string,
  params: Record<string, any>,
  options: GenAICaptureOptions,
): Record<string, AttributeValue> {
  const model = params.model;
  const attrs: Record<string, AttributeValue> = {
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
  attrs['gen_ai.output.type'] = params.response_format?.type;

  const msgs = params.messages ?? params.input ?? [];
  if (options.capture_all || options.capture_input_messages) {
    attrs['gen_ai.input.messages'] = msgs;
  }
  if (options.capture_all || options.capture_system_instructions) {
    attrs['gen_ai.system_instructions'] = msgs.filter(
      (m: any) => m.role === 'system',
    );
  }
  if (options.capture_all || options.capture_tool_definitions) {
    attrs['gen_ai.tool.definitions'] = params.tools;
  }

  Object.assign(attrs, extractEmbeddingsAttributes(params));
  Object.assign(attrs, extractImageAttributes(params));

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
  attrs['gen_ai.conversation.id'] = res.conversation_id;
  const outputMessages = res.choices ?? res.output;
  const finishReasons = (outputMessages ?? []).map((c: any) => c.finish_reason);
  if (finishReasons.length)
    attrs['gen_ai.response.finish_reasons'] = finishReasons;
  if (options.capture_all || options.capture_output_messages) {
    attrs['gen_ai.output.messages'] = outputMessages;
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

function extractImageAttributes(
  params: Record<string, any>,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  attrs['statsig.gen_ai.images.output_compression'] = params.output_compression;
  attrs['statsig.gen_ai.images.output_format'] = params.output_format;
  attrs['statsig.gen_ai.images.quality'] = params.quality;
  attrs['statsig.gen_ai.images.size'] = params.size;
  return attrs;
}

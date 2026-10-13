import { AttributeValue } from '@opentelemetry/api';

// OpenTelemetry GenAI message format, written to gen_ai.input.messages,
// gen_ai.output.messages and gen_ai.system_instructions so traces from every
// provider share one shape.
// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/

export type GenAIMessagePart =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id?: string; name: string; arguments?: unknown }
  | { type: 'tool_call_response'; id?: string; response: unknown }
  | { type: 'blob'; modality: string; mime_type?: string }
  | { type: 'uri'; modality: string; uri: string; mime_type?: string };

export type GenAIRole = 'system' | 'user' | 'assistant' | 'tool';

export type GenAIInputMessage = {
  role: GenAIRole;
  parts: GenAIMessagePart[];
};

export type GenAIOutputMessage = {
  role: 'assistant';
  parts: GenAIMessagePart[];
  finish_reason: string;
};

export function textPart(content: string): GenAIMessagePart {
  return { type: 'text', content };
}

export function parseToolArguments(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

// SpanTelemetry serializes object attributes to JSON, so structured messages
// can be passed where OpenTelemetry expects a primitive attribute value.
export function jsonAttribute(value: unknown): AttributeValue {
  return value as AttributeValue;
}

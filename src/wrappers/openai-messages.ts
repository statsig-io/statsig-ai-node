import {
  GenAIInputMessage,
  GenAIMessagePart,
  GenAIOutputMessage,
  parseToolArguments,
  textPart,
} from './gen-ai-messages';

type OpenAIItem = Record<string, any>;

const SYSTEM_ROLES = new Set(['system', 'developer']);

// Converts a Chat Completions, Responses, completions or embeddings request
// into OpenTelemetry messages. System and developer messages (and Responses
// `instructions`) become system instructions instead of input messages.
export function toOpenAIRequestMessages(params: Record<string, any>): {
  input: GenAIInputMessage[];
  systemInstructions: GenAIMessagePart[];
} {
  const systemInstructions: GenAIMessagePart[] =
    typeof params.instructions === 'string'
      ? [textPart(params.instructions)]
      : [];
  const input: GenAIInputMessage[] = [];

  const items = params.messages ?? params.input ?? params.prompt ?? [];
  for (const item of Array.isArray(items) ? items : [items]) {
    if (typeof item === 'string') {
      input.push({ role: 'user', parts: [textPart(item)] });
      continue;
    }
    if (SYSTEM_ROLES.has(item?.role)) {
      systemInstructions.push(...toContentParts(item.content));
      continue;
    }
    const message = toInputMessage(item);
    if (message) {
      input.push(message);
    }
  }
  return { input, systemInstructions };
}

function toInputMessage(item: OpenAIItem): GenAIInputMessage | null {
  switch (item?.type) {
    case 'function_call':
      return { role: 'assistant', parts: [toFunctionCallPart(item)] };
    case 'function_call_output':
      return {
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: item.call_id,
            response: item.output,
          },
        ],
      };
    case 'reasoning':
      return { role: 'assistant', parts: toReasoningParts(item) };
  }

  if (item?.role === 'tool' || item?.role === 'function') {
    return {
      role: 'tool',
      parts: [
        {
          type: 'tool_call_response',
          id: item.tool_call_id ?? item.name,
          response: item.content,
        },
      ],
    };
  }
  if (item?.role === 'assistant') {
    return {
      role: 'assistant',
      parts: [
        ...toContentParts(item.content),
        ...(item.tool_calls ?? []).map(toChatToolCallPart),
      ],
    };
  }
  if (item?.role === 'user') {
    return { role: 'user', parts: toContentParts(item.content) };
  }
  return null;
}

// Chat Completions `choices` (including text completions) or a Responses
// `output` list. Returns undefined for responses without messages, such as
// embeddings.
export function toOpenAIOutputMessages(
  response: Record<string, any>,
): GenAIOutputMessage[] | undefined {
  if (Array.isArray(response.choices)) {
    return response.choices.map((choice: OpenAIItem) => {
      const message = choice.message ?? {};
      const parts: GenAIMessagePart[] = [
        ...(typeof choice.text === 'string' ? [textPart(choice.text)] : []),
        ...toContentParts(message.content),
        ...(message.refusal ? [textPart(message.refusal)] : []),
        ...(message.tool_calls ?? []).map(toChatToolCallPart),
      ];
      return {
        role: 'assistant',
        parts,
        finish_reason: toFinishReason(choice.finish_reason),
      };
    });
  }

  if (Array.isArray(response.output)) {
    const parts = response.output.flatMap((item: OpenAIItem) => {
      switch (item?.type) {
        case 'message':
          return toContentParts(item.content);
        case 'function_call':
          return [toFunctionCallPart(item)];
        case 'reasoning':
          return toReasoningParts(item);
        default:
          return [];
      }
    });
    return [
      {
        role: 'assistant',
        parts,
        finish_reason: toResponsesFinishReason(response, parts),
      },
    ];
  }
  return undefined;
}

function toContentParts(content: unknown): GenAIMessagePart[] {
  if (typeof content === 'string') {
    return [textPart(content)];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part: OpenAIItem): GenAIMessagePart[] => {
    switch (part?.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        return [textPart(part.text)];
      case 'refusal':
        return [textPart(part.refusal)];
      case 'image_url':
        return [{ type: 'uri', modality: 'image', uri: part.image_url?.url }];
      case 'input_image':
        return part.image_url
          ? [{ type: 'uri', modality: 'image', uri: part.image_url }]
          : [{ type: 'blob', modality: 'image' }];
      case 'input_audio':
        return [
          {
            type: 'blob',
            modality: 'audio',
            mime_type: part.input_audio?.format,
          },
        ];
      case 'file':
      case 'input_file':
        return [{ type: 'blob', modality: 'file' }];
      default:
        return [];
    }
  });
}

function toChatToolCallPart(toolCall: OpenAIItem): GenAIMessagePart {
  return {
    type: 'tool_call',
    id: toolCall.id,
    name: toolCall.function?.name,
    arguments: parseToolArguments(toolCall.function?.arguments ?? ''),
  };
}

function toFunctionCallPart(item: OpenAIItem): GenAIMessagePart {
  return {
    type: 'tool_call',
    id: item.call_id,
    name: item.name,
    arguments: parseToolArguments(item.arguments ?? ''),
  };
}

function toReasoningParts(item: OpenAIItem): GenAIMessagePart[] {
  return (item.summary ?? []).map((summary: OpenAIItem) => ({
    type: 'reasoning',
    content: summary.text,
  }));
}

function toFinishReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    case null:
    case undefined:
      return 'stop';
    default:
      return finishReason;
  }
}

function toResponsesFinishReason(
  response: Record<string, any>,
  parts: GenAIMessagePart[],
): string {
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'content_filter'
      ? 'content_filter'
      : 'length';
  }
  return parts.some((part) => part.type === 'tool_call') ? 'tool_call' : 'stop';
}

import {
  AttributeValue,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from '@opentelemetry/api';

import { OtelSingleton } from '../otel/singleton';
import {
  GenAIInputMessage,
  GenAIMessagePart,
  GenAIOutputMessage,
  jsonAttribute,
  parseToolArguments,
  textPart,
} from './gen-ai-messages';
import {
  setAttributesSafely,
  startGenAISpan,
  traceGenAICall,
} from './gen-ai-span';
import { SpanTelemetry } from './span-telemetry';
import {
  GenAICaptureOptions,
  StatsigOpenAIProxyConfig,
} from './openai-configs';

type AnthropicBlock = Record<string, any>;
type AnthropicMessage = {
  id?: string;
  model?: string;
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  usage?: Record<string, number | null | undefined>;
};
type MessageStreamLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  aborted?: boolean;
};

export function wrapAnthropic<T extends object>(
  anthropic: T,
  config?: StatsigOpenAIProxyConfig,
): T {
  const messages = (anthropic as Record<string, any>).messages;
  if (typeof messages?.create !== 'function') {
    console.warn('Unsupported Anthropic-like object. Not wrapping.');
    return anthropic;
  }

  const tracer = OtelSingleton.getInstance()
    .getTracerProvider()
    .getTracer('statsig-anthropic-proxy');
  const options = config ?? {};

  const wrappedMessages = new Proxy(messages, {
    get(target, name, recv) {
      const original = Reflect.get(target, name, recv);
      if (name === 'create') {
        return (params: Record<string, any>, requestOptions?: unknown) =>
          traceCreate(tracer, options, params ?? {}, () =>
            original.call(target, params, requestOptions),
          );
      }
      if (name === 'stream' && typeof original === 'function') {
        return (params: Record<string, any>, requestOptions?: unknown) =>
          traceMessageStream(tracer, options, params ?? {}, () =>
            original.call(target, params, requestOptions),
          );
      }
      return original;
    },
  });

  return new Proxy(anthropic, {
    get(target, name, recv) {
      return name === 'messages'
        ? wrappedMessages
        : Reflect.get(target, name, recv);
    },
  });
}

function traceCreate(
  tracer: Tracer,
  config: StatsigOpenAIProxyConfig,
  params: Record<string, any>,
  call: () => unknown,
): Promise<unknown> {
  const captureOptions = config.captureOptions ?? {};
  const telemetry = startChatSpan(
    tracer,
    config,
    extractRequestAttributes(
      'anthropic.messages.create',
      params,
      captureOptions,
    ),
  );
  return traceGenAICall(telemetry, call, {
    onResult: (message) =>
      extractResponseAttributes(message as AnthropicMessage, captureOptions),
    onStream: (events) =>
      extractResponseAttributes(
        aggregateStreamEvents(events as AnthropicBlock[]),
        captureOptions,
      ),
  });
}

// messages.stream() returns a MessageStream that callers may iterate, listen
// to, or only await finalMessage() on, so the span ends on the stream's 'end'
// event rather than on iteration. No 'error' listener is added: one would stop
// the SDK from raising an unhandled rejection when the caller ignores errors.
function traceMessageStream(
  tracer: Tracer,
  config: StatsigOpenAIProxyConfig,
  params: Record<string, any>,
  call: () => unknown,
): unknown {
  const captureOptions = config.captureOptions ?? {};
  const telemetry = startChatSpan(
    tracer,
    config,
    extractRequestAttributes(
      'anthropic.messages.stream',
      { ...params, stream: true },
      captureOptions,
    ),
  );

  let stream: unknown;
  try {
    stream = context.with(
      trace.setSpan(context.active(), telemetry.span),
      call,
    );
  } catch (e) {
    telemetry.fail(e);
    telemetry.end();
    throw e;
  }
  if (typeof (stream as MessageStreamLike | undefined)?.on !== 'function') {
    telemetry.end();
    return stream;
  }

  const messageStream = stream as MessageStreamLike;
  let firstEvent = true;
  let finalMessage: AnthropicMessage | undefined;
  messageStream.on('streamEvent', () => {
    if (firstEvent) {
      firstEvent = false;
      telemetry.recordTimeToFirstToken();
    }
  });
  messageStream.on('finalMessage', (message: AnthropicMessage) => {
    finalMessage = message;
  });
  messageStream.on('end', () => {
    if (finalMessage) {
      telemetry.setStatus({ code: SpanStatusCode.OK });
      setAttributesSafely(telemetry, () =>
        extractResponseAttributes(finalMessage!, captureOptions),
      );
    } else {
      telemetry.fail(
        new Error(
          messageStream.aborted
            ? 'Request was aborted.'
            : 'Stream ended without a final message.',
        ),
      );
    }
    telemetry.end();
  });
  return stream;
}

function startChatSpan(
  tracer: Tracer,
  config: StatsigOpenAIProxyConfig,
  requestAttributes: Record<string, AttributeValue>,
): SpanTelemetry {
  return startGenAISpan(
    tracer,
    `chat ${requestAttributes['gen_ai.request.model'] ?? 'unknown'}`,
    requestAttributes,
    config.customAttributes,
    config.maxJSONChars ?? 40_000,
    config.captureOptions ?? {},
  );
}

function extractRequestAttributes(
  sourceName: string,
  params: Record<string, any>,
  options: GenAICaptureOptions,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.operation.source_name': sourceName,
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.request.model': params.model,
    'gen_ai.request.max_tokens': params.max_tokens,
    'gen_ai.request.temperature': params.temperature,
    'gen_ai.request.top_p': params.top_p,
    'gen_ai.request.top_k': params.top_k,
    'gen_ai.request.stop_sequences': params.stop_sequences,
  };
  if (params.stream) {
    attrs['gen_ai.request.stream'] = true;
  }
  if (options.capture_all || options.capture_input_messages) {
    attrs['gen_ai.input.messages'] = jsonAttribute(
      toInputMessages(params.messages ?? []),
    );
  }
  if (
    (options.capture_all || options.capture_system_instructions) &&
    params.system != null
  ) {
    attrs['gen_ai.system_instructions'] = jsonAttribute(toParts(params.system));
  }
  if (options.capture_all || options.capture_tool_definitions) {
    attrs['gen_ai.tool.definitions'] = params.tools;
  }
  return attrs;
}

function extractResponseAttributes(
  message: AnthropicMessage,
  options: GenAICaptureOptions,
): Record<string, AttributeValue | undefined> {
  const attrs: Record<string, AttributeValue | undefined> = {
    'gen_ai.response.id': message.id,
    'gen_ai.response.model': message.model,
    ...extractUsageAttributes(message.usage ?? {}),
  };
  if (message.stop_reason) {
    attrs['gen_ai.response.finish_reasons'] = [message.stop_reason];
  }
  if (options.capture_all || options.capture_output_messages) {
    const output: GenAIOutputMessage[] = [
      {
        role: 'assistant',
        parts: toParts(message.content ?? []),
        finish_reason: toFinishReason(message.stop_reason),
      },
    ];
    attrs['gen_ai.output.messages'] = jsonAttribute(output);
  }
  return attrs;
}

function extractUsageAttributes(
  usage: Record<string, number | null | undefined>,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  const cachedTokens = usage.cache_read_input_tokens ?? 0;
  // Anthropic reports cache reads and writes separately from input_tokens.
  const inputTokens =
    (usage.input_tokens ?? 0) +
    cachedTokens +
    (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  if (inputTokens > 0) {
    attrs['gen_ai.usage.input_tokens'] = inputTokens;
  }
  if (outputTokens > 0) {
    attrs['gen_ai.usage.output_tokens'] = outputTokens;
  }
  if (inputTokens + outputTokens > 0) {
    attrs['statsig.gen_ai.usage.total_tokens'] = inputTokens + outputTokens;
  }
  if (cachedTokens > 0) {
    attrs['statsig.gen_ai.usage.input_cached_tokens'] = cachedTokens;
  }
  return attrs;
}

function toInputMessages(
  messages: { role: string; content: string | AnthropicBlock[] }[],
): GenAIInputMessage[] {
  return messages.map((message) => {
    const parts = toParts(message.content);
    const isToolResults =
      parts.length > 0 &&
      parts.every((part) => part.type === 'tool_call_response');
    if (isToolResults) {
      return { role: 'tool', parts };
    }
    return { role: message.role === 'assistant' ? 'assistant' : 'user', parts };
  });
}

function toParts(content: string | AnthropicBlock[]): GenAIMessagePart[] {
  if (typeof content === 'string') {
    return [textPart(content)];
  }
  return content.flatMap((block): GenAIMessagePart[] => {
    switch (block?.type) {
      case 'text':
        return [textPart(block.text)];
      case 'thinking':
        return [{ type: 'reasoning', content: block.thinking }];
      case 'tool_use':
      case 'server_tool_use':
        return [
          {
            type: 'tool_call',
            id: block.id,
            name: block.name,
            arguments: block.input,
          },
        ];
      case 'tool_result':
        return [
          {
            type: 'tool_call_response',
            id: block.tool_use_id,
            response:
              typeof block.content === 'string'
                ? block.content
                : toParts(block.content ?? [])
                    .map((part) => ('content' in part ? part.content : ''))
                    .join(''),
          },
        ];
      case 'image':
      case 'document':
        return [
          block.source?.type === 'url'
            ? { type: 'uri', modality: block.type, uri: block.source.url }
            : {
                type: 'blob',
                modality: block.type,
                mime_type: block.source?.media_type,
              },
        ];
      default:
        return [];
    }
  });
}

function toFinishReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_call';
    case 'refusal':
      return 'content_filter';
    default:
      return stopReason ?? 'stop';
  }
}

// Rebuilds the final message from messages.create({ stream: true }) events.
function aggregateStreamEvents(events: AnthropicBlock[]): AnthropicMessage {
  const message: AnthropicMessage = { content: [], usage: {} };
  const toolInputJSON: Record<number, string> = {};

  for (const event of events) {
    switch (event?.type) {
      case 'message_start':
        message.id = event.message?.id;
        message.model = event.message?.model;
        message.usage = { ...(event.message?.usage ?? {}) };
        break;
      case 'content_block_start':
        message.content![event.index] = { ...event.content_block };
        break;
      case 'content_block_delta': {
        const block = message.content![event.index];
        const delta = event.delta ?? {};
        if (!block) {
          break;
        }
        if (delta.type === 'text_delta') {
          block.text = (block.text ?? '') + delta.text;
        } else if (delta.type === 'thinking_delta') {
          block.thinking = (block.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'input_json_delta') {
          toolInputJSON[event.index] =
            (toolInputJSON[event.index] ?? '') + delta.partial_json;
        }
        break;
      }
      case 'message_delta':
        message.stop_reason = event.delta?.stop_reason ?? message.stop_reason;
        message.usage = { ...message.usage, ...(event.usage ?? {}) };
        break;
    }
  }

  for (const [index, json] of Object.entries(toolInputJSON)) {
    const block = message.content![Number(index)];
    if (block) {
      block.input = parseToolArguments(json);
    }
  }
  message.content = message.content!.filter(Boolean);
  return message;
}

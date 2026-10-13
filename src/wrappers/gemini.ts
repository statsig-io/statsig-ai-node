import { AttributeValue, Tracer } from '@opentelemetry/api';

import { OtelSingleton } from '../otel/singleton';
import {
  GenAIInputMessage,
  GenAIMessagePart,
  GenAIOutputMessage,
  jsonAttribute,
  textPart,
} from './gen-ai-messages';
import { startGenAISpan, traceGenAICall } from './gen-ai-span';
import {
  GenAICaptureOptions,
  StatsigOpenAIProxyConfig,
} from './openai-configs';

type GeminiPart = Record<string, any>;
type GeminiContent = { role?: string; parts?: GeminiPart[] };
type GeminiCandidate = { content?: GeminiContent; finishReason?: string };
type GeminiResponse = {
  responseId?: string;
  modelVersion?: string;
  candidates?: GeminiCandidate[];
  usageMetadata?: Record<string, number | undefined>;
};

const WRAPPED_METHODS: Record<string, string> = {
  generateContent: 'google.models.generate_content',
  generateContentStream: 'google.models.generate_content_stream',
};

// Wraps a @google/genai client (new GoogleGenAI(...)).
export function wrapGemini<T extends object>(
  gemini: T,
  config?: StatsigOpenAIProxyConfig,
): T {
  const models = (gemini as Record<string, any>).models;
  if (typeof models?.generateContent !== 'function') {
    console.warn('Unsupported Google GenAI-like object. Not wrapping.');
    return gemini;
  }

  const tracer = OtelSingleton.getInstance()
    .getTracerProvider()
    .getTracer('statsig-gemini-proxy');
  const options = config ?? {};

  const wrappedModels = new Proxy(models, {
    get(target, name, recv) {
      const original = Reflect.get(target, name, recv);
      const sourceName =
        typeof name === 'string' ? WRAPPED_METHODS[name] : undefined;
      if (!sourceName || typeof original !== 'function') {
        return original;
      }
      return (params: Record<string, any>) =>
        traceGenerateContent(tracer, options, sourceName, params ?? {}, () =>
          original.call(target, params),
        );
    },
  });

  return new Proxy(gemini, {
    get(target, name, recv) {
      return name === 'models'
        ? wrappedModels
        : Reflect.get(target, name, recv);
    },
  });
}

function traceGenerateContent(
  tracer: Tracer,
  config: StatsigOpenAIProxyConfig,
  sourceName: string,
  params: Record<string, any>,
  call: () => unknown,
): Promise<unknown> {
  const captureOptions = config.captureOptions ?? {};
  const telemetry = startGenAISpan(
    tracer,
    `generate_content ${params.model ?? 'unknown'}`,
    extractRequestAttributes(sourceName, params, captureOptions),
    config.customAttributes,
    config.maxJSONChars ?? 40_000,
  );
  return traceGenAICall(telemetry, call, {
    onResult: (response) =>
      extractResponseAttributes(response as GeminiResponse, captureOptions),
    onStream: (chunks) =>
      extractResponseAttributes(
        aggregateStreamChunks(chunks as GeminiResponse[]),
        captureOptions,
      ),
  });
}

function extractRequestAttributes(
  sourceName: string,
  params: Record<string, any>,
  options: GenAICaptureOptions,
): Record<string, AttributeValue> {
  const requestConfig = params.config ?? {};
  const attrs: Record<string, AttributeValue> = {
    'gen_ai.operation.name': 'generate_content',
    'gen_ai.operation.source_name': sourceName,
    'gen_ai.provider.name': 'gcp.gen_ai',
    'gen_ai.request.model': params.model,
    'gen_ai.request.max_tokens': requestConfig.maxOutputTokens,
    'gen_ai.request.temperature': requestConfig.temperature,
    'gen_ai.request.top_p': requestConfig.topP,
    'gen_ai.request.top_k': requestConfig.topK,
    'gen_ai.request.stop_sequences': requestConfig.stopSequences,
    'gen_ai.request.seed': requestConfig.seed,
  };
  if (sourceName === WRAPPED_METHODS.generateContentStream) {
    attrs['gen_ai.request.stream'] = true;
  }
  if (options.capture_all || options.capture_input_messages) {
    attrs['gen_ai.input.messages'] = jsonAttribute(
      toInputMessages(params.contents),
    );
  }
  if (
    (options.capture_all || options.capture_system_instructions) &&
    requestConfig.systemInstruction != null
  ) {
    attrs['gen_ai.system_instructions'] = jsonAttribute(
      toInputMessages(requestConfig.systemInstruction).flatMap(
        (message) => message.parts,
      ),
    );
  }
  if (options.capture_all || options.capture_tool_definitions) {
    attrs['gen_ai.tool.definitions'] = requestConfig.tools;
  }
  return attrs;
}

function extractResponseAttributes(
  response: GeminiResponse,
  options: GenAICaptureOptions,
): Record<string, AttributeValue | undefined> {
  const candidates = response.candidates ?? [];
  const attrs: Record<string, AttributeValue | undefined> = {
    'gen_ai.response.id': response.responseId,
    'gen_ai.response.model': response.modelVersion,
    ...extractUsageAttributes(response.usageMetadata ?? {}),
  };
  const finishReasons = candidates.flatMap((candidate) =>
    candidate.finishReason ? [candidate.finishReason] : [],
  );
  if (finishReasons.length > 0) {
    attrs['gen_ai.response.finish_reasons'] = finishReasons;
  }
  if (options.capture_all || options.capture_output_messages) {
    const output: GenAIOutputMessage[] = candidates.map((candidate) => {
      const parts = toParts(candidate.content?.parts ?? []);
      return {
        role: 'assistant',
        parts,
        finish_reason: toFinishReason(candidate.finishReason, parts),
      };
    });
    attrs['gen_ai.output.messages'] = jsonAttribute(output);
  }
  return attrs;
}

function extractUsageAttributes(
  usage: Record<string, number | undefined>,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  const inputTokens = usage.promptTokenCount ?? 0;
  const reasoningTokens = usage.thoughtsTokenCount ?? 0;
  const outputTokens = (usage.candidatesTokenCount ?? 0) + reasoningTokens;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
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
  if (reasoningTokens > 0) {
    attrs['statsig.gen_ai.usage.output_reasoning_tokens'] = reasoningTokens;
  }
  return attrs;
}

// `contents` accepts a string, a part, a Content, or a list of either.
function toInputMessages(contents: unknown): GenAIInputMessage[] {
  const items = Array.isArray(contents) ? contents : [contents];
  const isContentList = items.some(
    (item) => item != null && typeof item === 'object' && 'parts' in item,
  );
  const contentList: GeminiContent[] = isContentList
    ? items
    : [{ role: 'user', parts: items.map(toGeminiPart) }];

  return contentList.map((content) => {
    const parts = toParts(content.parts ?? []);
    const isToolResults =
      parts.length > 0 &&
      parts.every((part) => part.type === 'tool_call_response');
    if (isToolResults) {
      return { role: 'tool', parts };
    }
    return { role: content.role === 'model' ? 'assistant' : 'user', parts };
  });
}

function toGeminiPart(item: unknown): GeminiPart {
  return typeof item === 'string' ? { text: item } : (item as GeminiPart);
}

function toParts(parts: GeminiPart[]): GenAIMessagePart[] {
  return parts.flatMap((part): GenAIMessagePart[] => {
    if (typeof part?.text === 'string') {
      return [
        part.thought
          ? { type: 'reasoning', content: part.text }
          : textPart(part.text),
      ];
    }
    if (part?.functionCall) {
      return [
        {
          type: 'tool_call',
          id: part.functionCall.id ?? part.functionCall.name,
          name: part.functionCall.name,
          arguments: part.functionCall.args,
        },
      ];
    }
    if (part?.functionResponse) {
      return [
        {
          type: 'tool_call_response',
          id: part.functionResponse.id ?? part.functionResponse.name,
          response: part.functionResponse.response,
        },
      ];
    }
    if (part?.inlineData) {
      return [
        {
          type: 'blob',
          modality: toModality(part.inlineData.mimeType),
          mime_type: part.inlineData.mimeType,
        },
      ];
    }
    if (part?.fileData) {
      return [
        {
          type: 'uri',
          modality: toModality(part.fileData.mimeType),
          uri: part.fileData.fileUri,
          mime_type: part.fileData.mimeType,
        },
      ];
    }
    return [];
  });
}

function toModality(mimeType: string | undefined): string {
  return mimeType?.split('/')[0] ?? 'unknown';
}

function toFinishReason(
  finishReason: string | undefined,
  parts: GenAIMessagePart[],
): string {
  if (parts.some((part) => part.type === 'tool_call')) {
    return 'tool_call';
  }
  switch (finishReason) {
    case undefined:
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return finishReason.toLowerCase();
  }
}

// Merges generateContentStream chunks into one response, joining text that
// arrives in pieces for each candidate.
function aggregateStreamChunks(chunks: GeminiResponse[]): GeminiResponse {
  const response: GeminiResponse = { candidates: [] };
  for (const chunk of chunks) {
    response.responseId ??= chunk.responseId;
    response.modelVersion ??= chunk.modelVersion;
    if (chunk.usageMetadata) {
      response.usageMetadata = chunk.usageMetadata;
    }
    (chunk.candidates ?? []).forEach((candidate, index) => {
      const merged = (response.candidates![index] ??= {
        content: { role: 'model', parts: [] },
      });
      if (candidate.finishReason) {
        merged.finishReason = candidate.finishReason;
      }
      for (const part of candidate.content?.parts ?? []) {
        const parts = merged.content!.parts!;
        const last = parts[parts.length - 1];
        if (
          typeof part.text === 'string' &&
          typeof last?.text === 'string' &&
          Boolean(last.thought) === Boolean(part.thought)
        ) {
          last.text += part.text;
        } else {
          parts.push({ ...part });
        }
      }
    });
  }
  return response;
}

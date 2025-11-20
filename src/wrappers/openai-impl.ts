import {
  AttributeValue,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from '@opentelemetry/api';
import { SpanTelemetry, TelemetryStream } from './span-telemetry';
import {
  GenAICaptureOptions,
  OpenAILike,
  StatsigOpenAIProxyConfig,
} from './openai-configs';
import {
  STATSIG_ATTR_LLM_PROMPT_NAME,
  STATSIG_ATTR_LLM_PROMPT_VERSION,
  STATSIG_ATTR_SPAN_LLM_ROOT,
  STATSIG_ATTR_SPAN_TYPE,
  STATSIG_CTX_KEY_ACTIVE_PROMPT,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION,
  STATSIG_SPAN_LLM_ROOT_VALUE,
  StatsigSpanType,
} from '../otel/conventions';
import { getStatsigSpanAttrsFromContext } from '../otel/statsig-context';
import { OtelSingleton } from '../otel/singleton';
import {
  extractBaseAttributes,
  extractResponseAttributes,
} from './attribute-helper';

const STATSIG_SPAN_LLM_ROOT_CTX_VAL = Symbol('STATSIG_SPAN_LLM_ROOT_CTX_VAL');
const OP_TO_OTEL_SEMANTIC_MAP: Record<string, string> = {
  'openai.chat.completions.create': 'chat',
  'openai.completions.create': 'text_completion',
  'openai.embeddings.create': 'embeddings',
  'openai.images.generate': 'generate_content',
  'openai.responses.create': 'generate_content',
  'openai.responses.stream': 'generate_content',
  'openai.responses.parse': 'generate_content',
};

type ResponseWithData<T> = {
  response?: Response;
  data: T;
};

type APIPromise<T> = Promise<T> & {
  withResponse?: () => Promise<ResponseWithData<T>>;
};

type NonStreamingResult = any;
type StreamingResult = AsyncIterable<any>;

export class StatsigOpenAIProxy {
  public openai: OpenAILike;
  public tracer: Tracer;
  private _maxJSONChars: number;
  private _customAttributes?: Record<string, AttributeValue>;
  private _captureOptions: GenAICaptureOptions;

  constructor(openai: OpenAILike, config: StatsigOpenAIProxyConfig) {
    this.openai = openai;
    this.tracer = OtelSingleton.getInstance()
      .getTracerProvider()
      .getTracer('statsig-openai-proxy');
    this._maxJSONChars = config.maxJSONChars ?? 40_000;
    this._customAttributes = config.customAttributes;
    this._captureOptions = config.captureOptions ?? {};
  }

  get client(): OpenAILike {
    const self = this;

    const createCompletionsProxy = (target: any, opName: string) => {
      return new Proxy(target, {
        get(innerTarget, innerName, innerRecv) {
          const original = Reflect.get(innerTarget, innerName, innerRecv);
          if (innerName === 'create') {
            return self.wrapMaybeStreamMethod(
              original.bind(innerTarget),
              opName,
              true,
            );
          }
          return original;
        },
      });
    };

    const chat = new Proxy(this.openai.chat, {
      get(target, name, recv) {
        if (name === 'completions') {
          const completionsTarget = Reflect.get(target, name, recv);
          return createCompletionsProxy(
            completionsTarget,
            'openai.chat.completions.create',
          );
        }

        return Reflect.get(target, name, recv);
      },
    });

    const completions = createCompletionsProxy(
      this.openai.completions,
      'openai.completions.create',
    );

    const embeddings = new Proxy(this.openai.embeddings, {
      get(target, name, recv) {
        const original = Reflect.get(target, name, recv);
        if (name === 'create') {
          return self.wrapMethod(
            original.bind(target),
            'openai.embeddings.create',
          );
        }
        return original;
      },
    });

    const images = new Proxy(this.openai.images, {
      get(target, name, recv) {
        const original = Reflect.get(target, name, recv);
        if (name === 'generate') {
          return self.wrapMethod(
            original.bind(target),
            'openai.images.generate',
          );
        }
        return original;
      },
    });

    const responses = new Proxy(this.openai.responses, {
      get(target, name, recv) {
        const original = Reflect.get(target, name, recv);
        switch (name) {
          case 'create':
            return self.wrapMaybeStreamMethod(
              original.bind(target),
              'openai.responses.create',
            );
          case 'stream':
            return self.wrapMaybeStreamMethod(
              original.bind(target),
              'openai.responses.stream',
            );
          case 'parse':
            return self.wrapMethod(
              original.bind(target),
              'openai.responses.parse',
            );
          default:
            return original;
        }
      },
    });

    return new Proxy(this.openai, {
      get: (target, name, recv) => {
        switch (name) {
          case 'chat':
            return chat;
          case 'completions':
            return completions;
          case 'embeddings':
            return embeddings;
          case 'images':
            return images;
          case 'responses':
            return responses;
          default:
            return Reflect.get(target, name, recv);
        }
      },
    });
  }

  private async wrapMaybeStream<Params extends Record<string, unknown>, Result>(
    callFn: (params: Params, options?: unknown) => APIPromise<Result>,
    params: Params,
    options: unknown,
    opName: string,
  ): Promise<ResponseWithData<Result>> {
    const spanName = `${OP_TO_OTEL_SEMANTIC_MAP[opName]} ${params.model ?? 'unknown'}`;
    const telemetry = this.startSpan(
      spanName,
      opName,
      params as Record<string, any>,
    );

    const maybeStream = callFn(params, options);

    if (params.stream) {
      const maybeStream = await callFn(params, options);
      if (isAsyncIterable(maybeStream)) {
        telemetry.setAttributes({ 'gen_ai.request.stream': true });
        const wrappedStream = this.wrapStream(
          maybeStream,
          telemetry,
          this._captureOptions,
        );
        return { data: wrappedStream as Result };
      }
    }

    const wrappedNonStreamMethod = this.wrapMethod(callFn, opName);
    const data = await wrappedNonStreamMethod(params, options);
    return { data };
  }

  private lazyWrapPromise<Result>(
    executor: () => Promise<ResponseWithData<Result>>,
  ): APIPromise<Result> {
    let taskPromise: Promise<ResponseWithData<Result>> | null = null;
    let dataPromise: Promise<Result> | null = null;

    const ensureTaskRun = (): Promise<ResponseWithData<Result>> => {
      if (!taskPromise) {
        taskPromise = executor();
      }
      return taskPromise;
    };

    return new Proxy({} as APIPromise<Result>, {
      get(target, prop, recv) {
        if (prop === 'withResponse') {
          return () => ensureTaskRun();
        }

        if (
          prop === 'then' ||
          prop === 'catch' ||
          prop === 'finally' ||
          prop in Promise.prototype
        ) {
          if (!dataPromise) {
            dataPromise = ensureTaskRun().then((r) => r.data);
          }
          const res = Reflect.get(dataPromise, prop, recv);
          return typeof res === 'function' ? res.bind(dataPromise) : res;
        }

        return Reflect.get(target, prop, recv);
      },
    });
  }

  private wrapMaybeStreamMethod<
    Params extends Record<string, unknown>,
    Result extends NonStreamingResult | StreamingResult,
  >(
    callFn: (params: Params, options?: unknown) => APIPromise<Result>,
    opName: string,
    lazy: boolean = false,
  ): (params: Params, options?: unknown) => APIPromise<Result> {
    return (params: Params, options?: unknown) => {
      params = params ?? ({} as Params);

      const executor = () =>
        this.wrapMaybeStream(callFn, params, options, opName);

      return lazy
        ? this.lazyWrapPromise<Result>(executor)
        : (executor().then((r) => r.data as Result) as APIPromise<Result>);
    };
  }

  private wrapMethod<Params extends Record<string, unknown>, Result>(
    originalCall: (params: Params, options?: unknown) => APIPromise<Result>,
    opName: string,
  ): (params: Params, options?: unknown) => Promise<any> {
    return async (params: Params, options?: unknown) => {
      const spanName = `${OP_TO_OTEL_SEMANTIC_MAP[opName]} ${params.model ?? 'unknown'}`;
      const telemetry = this.startSpan(
        spanName,
        opName,
        params as Record<string, any>,
      );
      return context.with(
        trace.setSpan(context.active(), telemetry.span),
        async () => {
          try {
            const data = await originalCall(params, options);
            telemetry.recordTimeToFirstToken();
            telemetry.setStatus({ code: SpanStatusCode.OK });
            telemetry.setAttributes(
              extractSingleOAIResponseAttributes(
                data ?? {},
                this._captureOptions,
              ),
            );
            return data;
          } catch (e: any) {
            telemetry.fail(e);
            throw e;
          } finally {
            telemetry.end();
          }
        },
      );
    };
  }

  private wrapStream<T>(
    stream: AsyncIterable<T>,
    telemetry: SpanTelemetry,
    captureOptions: GenAICaptureOptions,
  ) {
    const wrapped = new Proxy(stream as any, {
      get(target, prop, recv) {
        if (prop === Symbol.asyncIterator) {
          return () =>
            new TelemetryStream(stream, telemetry, (telemetry, items) => {
              telemetry.setAttributes(
                parseOAIStreamingResponseIntoAttributes(items, captureOptions),
              );
            })[Symbol.asyncIterator]();
        }
        return Reflect.get(target, prop, recv);
      },
    });

    return wrapped as AsyncIterable<T>;
  }

  private startSpan(
    spanName: string,
    opName: string,
    params: Record<string, any>,
  ): SpanTelemetry {
    let ctx = context.active();
    const baseAttrs = extractOAIBaseAttributes(
      opName,
      params as Record<string, any>,
      this._captureOptions,
    );
    const maybeRootSpan = ctx.getValue(STATSIG_SPAN_LLM_ROOT_CTX_VAL);
    const statsigAttrs: Record<string, AttributeValue> = {
      [STATSIG_ATTR_SPAN_TYPE]: StatsigSpanType.gen_ai,
    };
    if (
      typeof maybeRootSpan === 'undefined' ||
      (typeof maybeRootSpan === 'string' && maybeRootSpan.length === 0)
    ) {
      ctx = ctx.setValue(STATSIG_SPAN_LLM_ROOT_CTX_VAL, spanName);
      statsigAttrs[STATSIG_ATTR_SPAN_LLM_ROOT] = STATSIG_SPAN_LLM_ROOT_VALUE;
    }

    const maybeContextPrompt = ctx.getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT);
    const maybeContextPromptVersion = ctx.getValue(
      STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION,
    );
    if (maybeContextPrompt && typeof maybeContextPrompt === 'string') {
      statsigAttrs[STATSIG_ATTR_LLM_PROMPT_NAME] = maybeContextPrompt;
    }
    if (
      maybeContextPromptVersion &&
      typeof maybeContextPromptVersion === 'string'
    ) {
      statsigAttrs[STATSIG_ATTR_LLM_PROMPT_VERSION] = maybeContextPromptVersion;
    }

    const maybeStatsigContextAttrs = getStatsigSpanAttrsFromContext(ctx);
    if (maybeStatsigContextAttrs) {
      Object.assign(statsigAttrs, maybeStatsigContextAttrs);
    }

    const attributes: Record<string, AttributeValue | undefined> = {
      ...(this._customAttributes ?? {}),
      ...(baseAttrs ?? {}),
      ...statsigAttrs,
    };

    const span = this.tracer.startSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes,
      },
      ctx,
    );

    const telemetry = new SpanTelemetry(span, spanName, this._maxJSONChars);

    telemetry.setAttributes(attributes);
    return telemetry;
  }
}

function isAsyncIterable<T = any>(x: any): x is AsyncIterable<T> {
  return x && typeof x[Symbol.asyncIterator] === 'function';
}

function extractSingleOAIResponseAttributes(
  response: Record<string, any>,
  options: GenAICaptureOptions,
): Record<string, AttributeValue> {
  return {
    ...extractResponseAttributes(response, options),
    ...extractOAIUsageAttributes(response?.usage ?? {}),
  };
}

function parseOAIStreamingResponseIntoAttributes(
  chunks: any[],
  options: GenAICaptureOptions,
): Record<string, any> {
  if (!chunks.length) {
    return {};
  }
  const attrs: Record<string, any> = {};
  const { id, model, choices, aggregatedAttrs } =
    aggregateStreamedChoices(chunks);

  attrs['gen_ai.response.id'] = id;
  attrs['gen_ai.response.model'] = model;

  Object.assign(attrs, aggregatedAttrs);

  attrs['gen_ai.response.finish_reasons'] = choices.map(
    (c: any) => c.finish_reason,
  );
  if (options.capture_all || options.capture_output_messages) {
    attrs['gen_ai.output.messages'] = choices;
  }
  return attrs;
}

function aggregateStreamedChoices(chunks: any[]) {
  const choicesMap: Record<
    number,
    {
      index: number;
      message: {
        role?: string;
        content?: string;
      };
      finish_reason?: string;
    }
  > = {};

  const aggregatedAttrs: Record<string, AttributeValue> = {};

  let id = undefined;
  let model = undefined;

  for (let chunk of chunks) {
    if (chunk.response) {
      // for response streams the metadata lives in chunk.response
      chunk = chunk.response;
    }

    if (chunk.id && !id) {
      id = chunk.id;
    }
    if (chunk.model && !model) {
      model = chunk.model;
    }

    const usage = chunk.usage;
    if (usage) {
      const chunkAttrs = extractOAIUsageAttributes(usage);

      for (const [key, value] of Object.entries(chunkAttrs)) {
        if (typeof value === 'number') {
          aggregatedAttrs[key] =
            ((aggregatedAttrs[key] as number) || 0) + value;
        }
      }
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    const { index, delta, finish_reason } = choice;

    if (!choicesMap[index]) {
      choicesMap[index] = {
        index,
        message: {
          role: undefined,
          content: '',
        },
      };
    }

    const agg = choicesMap[index];

    if (delta?.role) {
      agg.message.role = delta.role;
    }
    if (typeof delta?.content === 'string')
      agg.message.content += delta.content;

    if (finish_reason) {
      agg.finish_reason = finish_reason;
    }
  }

  return {
    id,
    model,
    choices: Object.values(choicesMap),
    aggregatedAttrs,
  };
}

function extractOAIBaseAttributes(
  operationName: string,
  params: Record<string, any>,
  options: GenAICaptureOptions,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {
    ...extractBaseAttributes(operationName, params, options),
  };
  attrs['gen_ai.operation.name'] = OP_TO_OTEL_SEMANTIC_MAP[operationName];
  attrs['gen_ai.operation.source_name'] = operationName;
  attrs['gen_ai.provider.name'] = 'openai';
  attrs['gen_ai.request.model'] = params.model;
  const requestTier = params.service_tier ?? 'auto';
  if (requestTier !== 'auto') {
    attrs['openai.request.service_tier'] = requestTier;
  }
  return attrs;
}

function extractOAIUsageAttributes(
  usage: Record<string, any>,
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};

  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  if (typeof inputTokens === 'number') {
    attrs['gen_ai.usage.input_tokens'] = inputTokens;
  }

  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  if (typeof outputTokens === 'number') {
    attrs['gen_ai.usage.output_tokens'] = outputTokens;
  }

  if (typeof inputTokens === 'number' || typeof outputTokens === 'number') {
    attrs['statsig.gen_ai.usage.total_tokens'] =
      (inputTokens || 0) + (outputTokens || 0);
  }

  const inputDetails =
    usage.input_tokens_details ?? usage.prompt_tokens_details;
  if (inputDetails) {
    if (typeof inputDetails.cached_tokens === 'number') {
      attrs['statsig.gen_ai.usage.input_cached_tokens'] =
        inputDetails.cached_tokens;
    }

    if (typeof inputDetails.audio_tokens === 'number') {
      attrs['statsig.gen_ai.usage.input_audio_tokens'] =
        inputDetails.audio_tokens;
    }
  }

  const outputDetails =
    usage.output_tokens_details ?? usage.completion_tokens_details;
  if (outputDetails) {
    if (typeof outputDetails.reasoning_tokens === 'number') {
      attrs['statsig.gen_ai.usage.output_reasoning_tokens'] =
        outputDetails.reasoning_tokens;
    }
  }

  // delete any token usage that is 0
  for (const key in attrs) {
    if (attrs[key] === 0) {
      delete attrs[key];
    }
  }
  return attrs;
}

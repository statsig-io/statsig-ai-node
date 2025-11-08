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
import { OtelSingleton } from '../otel/singleton';
import {
  extractBaseAttributes,
  extractResponseAttributes,
} from './attribute-helper';

const STATSIG_SPAN_LLM_ROOT_CTX_VAL = Symbol('STATSIG_SPAN_LLM_ROOT_CTX_VAL');

type ResponseWithData = {
  response?: Response;
  data: any;
};

type APIPromise<T> = Promise<T> & {
  withResponse?: () => Promise<ResponseWithData>;
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

    const chat = new Proxy(this.openai.chat, {
      get(target, name, recv) {
        if (name === 'completions') {
          const completionsTarget = Reflect.get(target, name, recv);

          return new Proxy(completionsTarget, {
            get(innerTarget, innerName, innerRecv) {
              const original = Reflect.get(innerTarget, innerName, innerRecv);
              if (innerName === 'create') {
                return self.wrapMaybeStreamMethod(
                  original.bind(innerTarget),
                  'chat',
                  true,
                );
              }
              return original;
            },
          });
        }

        return Reflect.get(target, name, recv);
      },
    });

    const completion = new Proxy(this.openai.completions, {
      get(target, name, recv) {
        const original = Reflect.get(target, name, recv);
        if (name === 'create') {
          return self.wrapMaybeStreamMethod(
            original.bind(target),
            'text_completion',
            true,
          );
        }
        return original;
      },
    });

    const embeddings = new Proxy(this.openai.embeddings, {
      get(target, name, recv) {
        const original = Reflect.get(target, name, recv);
        if (name === 'create') {
          return self.wrapMethod(original.bind(target), 'embeddings');
        }
        return original;
      },
    });

    const images = new Proxy(this.openai.images, {
      get(target, name, recv) {
        const original = Reflect.get(target, name, recv);
        if (name === 'generate') {
          return self.wrapMethod(original.bind(target), 'images.generate');
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
              'responses.create',
            );
          case 'stream':
            return self.wrapMaybeStreamMethod(
              original.bind(target),
              'responses.stream',
            );
          case 'parse':
            return self.wrapMethod(original.bind(target), 'responses.parse');
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
            return completion;
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
  ): Promise<ResponseWithData> {
    const spanName = `${opName} ${params.model ?? 'unknown'}`;
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
        return { data: wrappedStream };
      }
    }

    const wrappedNonStreamMethod = this.wrapMethod(callFn, opName);
    const data = await wrappedNonStreamMethod(params, options);
    return { data };
  }

  private lazyWrapPromise<Result>(
    executor: () => Promise<ResponseWithData>,
  ): APIPromise<Result> {
    let taskPromise: Promise<ResponseWithData> | null = null;
    let dataPromise: Promise<Result> | null = null;

    const ensureTaskRun = (): Promise<ResponseWithData> => {
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
      const spanName = `${opName} ${params.model ?? 'unknown'}`;
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
            telemetry.setStatus({ code: SpanStatusCode.OK });
            telemetry.recordTimeToFirstToken();
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

function extractOAIUsageAttributes(
  usage: Record<string, any>,
): Record<string, AttributeValue> {
  return {
    'gen_ai.usage.input_tokens': usage.prompt_tokens,
    'gen_ai.usage.output_tokens': usage.completion_tokens,
  };
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
  const { choices, totalInputTokens, totalOutputTokens } =
    aggregateStreamedChoices(chunks);

  attrs['gen_ai.response.id'] = chunks[0]['id'];
  attrs['gen_ai.response.model'] = chunks[0]['model'];
  attrs['gen_ai.usage.input_tokens'] = totalInputTokens;
  attrs['gen_ai.usage.output_tokens'] = totalOutputTokens;
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

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const chunk of chunks) {
    const usage = chunk.usage;
    if (usage?.prompt_tokens && typeof usage.prompt_tokens === 'number') {
      totalInputTokens += usage.prompt_tokens;
    }
    if (
      usage?.completion_tokens &&
      typeof usage.completion_tokens === 'number'
    ) {
      totalOutputTokens += usage.completion_tokens;
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
    choices: Object.values(choicesMap),
    totalInputTokens,
    totalOutputTokens,
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
  attrs['gen_ai.provider.name'] = 'openai';
  attrs['gen_ai.request.model'] = params.model;
  const requestTier = params.service_tier ?? 'auto';
  if (requestTier !== 'auto') {
    attrs['openai.request.service_tier'] = requestTier;
  }
  return attrs;
}

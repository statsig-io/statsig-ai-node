import {
  AttributeValue,
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from '@opentelemetry/api';
import { OpenAILike, StatsigOpenAIProxyConfig } from './openai-configs';
import {
  STATSIG_ATTR_CUSTOM_IDS,
  STATSIG_ATTR_LLM_PROMPT_NAME,
  STATSIG_ATTR_LLM_PROMPT_VERSION,
  STATSIG_ATTR_SPAN_LLM_ROOT,
  STATSIG_ATTR_SPAN_TYPE,
  STATSIG_ATTR_USER_ID,
  STATSIG_CTX_KEY_ACTIVE_PROMPT,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION,
  STATSIG_SPAN_LLM_ROOT_VALUE,
  StatsigSpanType,
} from '../otel/conventions';
import { OtelSingleton } from '../otel/singleton';
import { getUserFromContext } from '../otel/user-context';

const STATSIG_SPAN_LLM_ROOT_CTX_VAL = Symbol('STATSIG_SPAN_LLM_ROOT_CTX_VAL');

type APIPromise<T> = Promise<T> & {
  withResponse?: () => Promise<{ data: T; response: Response }>;
};

export class StatsigOpenAIProxy {
  public openai: OpenAILike;
  public tracer: Tracer;
  private _redact?: (obj: any) => any;
  private _ensureStreamUsage: boolean;
  private _maxJSONChars: number;
  private _customAttributes?: Record<string, AttributeValue>;

  constructor(openai: OpenAILike, config: StatsigOpenAIProxyConfig) {
    this.openai = openai;
    this.tracer = OtelSingleton.getInstance()
      .getTracerProvider()
      .getTracer('statsig-openai-proxy');
    this._redact = config.redact;
    this._ensureStreamUsage = config.ensureStreamUsage ?? true;
    this._maxJSONChars = config.maxJSONChars ?? 40_000;
    this._customAttributes = config.customAttributes;
  }

  get client(): OpenAILike {
    const self = this;

    const chat = proxifyNamespace(this.openai.chat, () => {
      return {
        completions: proxifyNamespace(
          this.openai.chat?.completions,
          (original) => {
            return {
              create: function (this: any, params: any, options?: any) {
                return self.wrapChatCreate(original, params, options);
              },
            };
          },
        ),
      };
    });

    const completions = proxifyNamespace(
      this.openai.completions,
      (original) => ({
        create: function (this: any, params: any, options?: any) {
          return self.wrapTextCreate(original, params, options);
        },
      }),
    );

    const embeddings = proxifyNamespace(this.openai.embeddings, (original) => ({
      create: function (this: any, params: any, options?: any) {
        return self.wrapEmbeddingsCreate(original, params, options);
      },
    }));

    const images = proxifyNamespace(this.openai.images, (original) => ({
      generate: function (this: any, params: any, options?: any) {
        return self.wrapImagesGenerate(original, params, options);
      },
    }));

    const responses =
      this.openai.responses &&
      proxifyNamespace(this.openai.responses, (original) => ({
        create: function (this: any, params: any, options?: any) {
          return self.wrapResponsesCreate(original, params, options);
        },
        stream: function (this: any, params: any, options?: any) {
          return self.wrapResponsesStream(original, params, options);
        },
        parse: function (this: any, params: any, options?: any) {
          return self.wrapResponsesParse(original, params, options);
        },
      }));

    return new Proxy(this.openai, {
      get: (target, prop, recv) => {
        if (prop === 'chat') return chat ?? Reflect.get(target, prop, recv);
        if (prop === 'completions')
          return completions ?? Reflect.get(target, prop, recv);
        if (prop === 'embeddings')
          return embeddings ?? Reflect.get(target, prop, recv);
        if (prop === 'images') return images ?? Reflect.get(target, prop, recv);
        if (prop === 'responses')
          return responses ?? Reflect.get(target, prop, recv);
        return Reflect.get(target, prop, recv);
      },
    });
  }

  // chat.completions.create
  private wrapChatCreate(selfObj: any, params: any, options?: any) {
    const spanName = 'openai.chat.completions.create';
    const opName = 'chat.completions.create';

    const callParams =
      this._ensureStreamUsage &&
      params?.stream &&
      !params?.stream_options?.include_usage
        ? {
            ...params,
            stream_options: {
              ...(params.stream_options ?? {}),
              include_usage: true,
            },
          }
        : params;

    return this.wrapMaybeStreamingCall(
      (p: any, o: any) => selfObj(p, o),
      spanName,
      opName,
      callParams,
      options,
      {
        onData: (span, data, t0) => {
          const first = data?.choices?.[0];
          const outText = first?.message?.content ?? '';
          setAttrs(span, {
            'gen_ai.response.id': data?.id,
            'gen_ai.response.model': data?.model,
            'gen_ai.response.created': data?.created,
            'gen_ai.completion.choices_count': data?.choices?.length,
            'gen_ai.response.finish_reason': first?.finish_reason,
            'gen_ai.completion': outText,
            ...usageAttrs(data?.usage),
            'gen_ai.metrics.time_to_first_token_ms': Date.now() - t0,
          });

          setJSON(
            span,
            'gen_ai.input',
            this._redact?.(params?.messages) ?? params?.messages,
            this._maxJSONChars,
          );
          if (first?.message?.tool_calls) {
            setJSON(
              span,
              'gen_ai.output.tool_calls_json',
              this._redact?.(first.message.tool_calls) ??
                first.message.tool_calls,
              this._maxJSONChars,
            );
          }
        },

        postprocessStream: (span, all) => {
          const { text, tool_calls, usage } = postprocessChatStream(all);
          if (text) {
            setJSON(
              span,
              'gen_ai.output.messages_json',
              [{ role: 'assistant', content: text }],
              this._maxJSONChars,
            );
            span.setAttribute('gen_ai.completion', text);
          }
          if (tool_calls) {
            setJSON(
              span,
              'gen_ai.output.tool_calls_json',
              tool_calls,
              this._maxJSONChars,
            );
          }
          setUsage(span, usage);
        },
        baseAttrs: {
          'gen_ai.system': 'openai',
          'gen_ai.operation.name': opName,
          'gen_ai.request.model': params?.model,
          'gen_ai.request.temperature': params?.temperature,
          'gen_ai.request.max_tokens': params?.max_tokens,
          'gen_ai.request.top_p': params?.top_p,
          'gen_ai.request.frequency_penalty': params?.frequency_penalty,
          'gen_ai.request.presence_penalty': params?.presence_penalty,
          'gen_ai.request.stream': !!params?.stream,
          'gen_ai.request.n': params?.n,
        },
        inputJSONKey: 'gen_ai.input',
        inputJSONValue: this._redact?.(params?.messages) ?? params?.messages,
      },
    );
  }

  // completions.create (legacy)
  private wrapTextCreate(originalCall: any, params: any, options?: any) {
    const spanName = 'openai.completions.create';
    const opName = 'completions.create';

    return this.wrapMaybeStreamingCall(
      (p: any, o: any) => originalCall(p, o),
      spanName,
      opName,
      params,
      options,
      {
        onData: (span, data, t0) => {
          const first = data?.choices?.[0];
          setAttrs(span, {
            'gen_ai.completion': first?.text ?? '',
            'gen_ai.response.finish_reason': first?.finish_reason,
            ...usageAttrs(data?.usage),
            'gen_ai.metrics.time_to_first_token_ms': Date.now() - t0,
          });

          if (typeof params?.prompt === 'string') {
            span.setAttribute('gen_ai.prompt', params.prompt);
          } else if (Array.isArray(params?.prompt)) {
            setJSON(
              span,
              'gen_ai.prompt_json',
              params.prompt,
              this._maxJSONChars,
            );
          }
        },
        postprocessStream: (span, all) => {
          const { text, usage } = postprocessChatStream(all);
          if (text) span.setAttribute('gen_ai.completion', text);
          setUsage(span, usage);
        },
        baseAttrs: {
          'gen_ai.system': 'openai',
          'gen_ai.operation.name': opName,
          'gen_ai.request.model': params?.model,
          'gen_ai.request.stream': !!params?.stream,
          'gen_ai.request.max_tokens': params?.max_tokens,
          'gen_ai.request.temperature': params?.temperature,
        },
        inputJSONKey:
          typeof params?.prompt === 'string' ? undefined : 'gen_ai.prompt_json',
        inputJSONValue:
          typeof params?.prompt === 'string' ? undefined : params?.prompt,
      },
    );
  }

  // embeddings.create
  private async wrapEmbeddingsCreate(
    originalCall: any,
    params: any,
    options?: any,
  ) {
    const span = this.startSpan(
      'openai.embeddings.create',
      'embeddings.create',
      {
        'gen_ai.request.model': params?.model,
        'gen_ai.request.encoding_format': params?.encoding_format ?? 'float',
      },
      'gen_ai.input',
      this._redact?.(params?.input) ?? params?.input,
    );

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const res = await originalCall(params, options);
        setAttrs(span, {
          'gen_ai.response.model': res?.model,
          'gen_ai.embeddings.count': res?.data?.length,
          'gen_ai.embeddings.dimension': res?.data?.[0]?.embedding?.length,
          ...usageAttrs(res?.usage),
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return res;
      } catch (e: any) {
        fail(span, e);
        throw e;
      } finally {
        span.end();
      }
    });
  }

  // images.generate
  private async wrapImagesGenerate(
    originalCall: any,
    params: any,
    options?: any,
  ) {
    const span = this.startSpan(
      'openai.images.generate',
      'images.generate',
      {
        'gen_ai.request.model': params?.model,
      },
      'gen_ai.input',
      this._redact?.(params) ?? params,
    );

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const res = await originalCall(params, options);
        setAttrs(span, {
          'gen_ai.response.created': res?.created,
          'gen_ai.images.count': res?.data?.length,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return res;
      } catch (e: any) {
        fail(span, e);
        throw e;
      } finally {
        span.end();
      }
    });
  }

  // responses.create / responses.stream / responses.parse (optional)
  private wrapResponsesCreate(originalCall: any, params: any, options?: any) {
    const spanName = 'openai.responses.create';
    const opName = 'responses.create';

    return this.wrapMaybeStreamingCall(
      (p: any, o: any) => originalCall(p, o),
      spanName,
      opName,
      params,
      options,
      {
        onData: (span, data, t0) => {
          const text =
            data?.output_text ??
            data?.choices?.[0]?.message?.content ??
            data?.content?.[0]?.text ??
            '';
          setAttrs(span, {
            'gen_ai.completion': text,
            ...usageAttrs(data?.usage),
            'gen_ai.metrics.time_to_first_token_ms': Date.now() - t0,
          });
          setJSON(
            span,
            'gen_ai.input',
            this._redact?.(params?.input) ?? params?.input,
            this._maxJSONChars,
          );
        },
        postprocessStream: (span, all) => {
          const { text, usage } = postprocessChatStream(all);
          if (text) span.setAttribute('gen_ai.completion', text);
          setUsage(span, usage);
        },
        baseAttrs: {
          'gen_ai.system': 'openai',
          'gen_ai.operation.name': opName,
          'gen_ai.request.model': params?.model,
          'gen_ai.request.stream': !!params?.stream,
        },
        inputJSONKey: 'gen_ai.input',
        inputJSONValue: this._redact?.(params?.input) ?? params?.input,
      },
    );
  }

  private wrapResponsesStream(originalCall: any, params: any, options?: any) {
    const span = this.startSpan(
      'openai.responses.stream',
      'responses.stream',
      {
        'gen_ai.request.model': params?.model,
        'gen_ai.request.stream': true,
      },
      'gen_ai.input',
      this._redact?.(params?.input) ?? params?.input,
    );

    const t0 = Date.now();
    const stream = originalCall(params, options);
    return this.wrapStreamAndFinish(stream, span, t0);
  }

  private wrapResponsesParse(originalCall: any, params: any, options?: any) {
    const span = this.startSpan(
      'openai.responses.parse',
      'responses.parse',
      {},
      undefined,
      undefined,
    );
    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const res = await originalCall(params, options);
        span.setStatus({ code: SpanStatusCode.OK });
        return res;
      } catch (e: any) {
        fail(span, e);
        throw e;
      } finally {
        span.end();
      }
    });
  }

  // Core wrappers
  private startSpan(
    spanName: string,
    operationName: string,
    baseAttrs?: Record<string, AttributeValue>,
    inputJSONKey?: string,
    inputJSON?: any,
  ) {
    let ctx = context.active();
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

    const span = this.tracer.startSpan(
      sanitizeSpanName(spanName),
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.system': 'openai',
          'gen_ai.operation.name': operationName,
          ...(this._customAttributes ?? {}),
          ...(baseAttrs ?? {}),
          ...statsigAttrs,
        },
      },
      ctx,
    );
    if (inputJSONKey && inputJSON !== undefined) {
      setJSON(span, inputJSONKey, inputJSON, this._maxJSONChars);
    }
    return span;
  }

  private wrapMaybeStreamingCall(
    callFn: (
      params: any,
      options?: any,
    ) => APIPromise<any> | AsyncIterable<any>,
    spanName: string,
    operationName: string,
    params: any,
    options: any,
    opts: {
      baseAttrs?: Record<string, AttributeValue>;
      onData: (span: Span, data: any, t0: number) => void;
      postprocessStream: (span: Span, allChunks: any[]) => void;
      inputJSONKey?: string;
      inputJSONValue?: any;
    },
  ) {
    let exec: Promise<{ data: any; response?: Response }> | null = null;
    let dataP: Promise<any> | null = null;

    const ensure = () => {
      if (!exec) {
        exec = (async () => {
          const span = this.startSpan(
            spanName,
            operationName,
            opts.baseAttrs,
            opts.inputJSONKey,
            opts.inputJSONValue,
          );
          const t0 = Date.now();

          try {
            const maybe = callFn(params, options);

            if (isAsyncIterable(maybe)) {
              span.setAttribute('gen_ai.response.stream', true);
              const wrapped = this.wrapStreamAndFinish(
                maybe,
                span,
                t0,
                opts.postprocessStream,
              );
              return { data: wrapped };
            }

            const apip = maybe;
            if (typeof apip.withResponse === 'function') {
              const { data, response } = await apip.withResponse();
              opts.onData(span, data, t0);
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return { data, response };
            } else {
              const data = await apip;
              opts.onData(span, data, t0);
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return { data };
            }
          } catch (e: any) {
            const span = trace.getActiveSpan();
            if (span) {
              fail(span, e);
            }
            throw e;
          } finally {
            span.end();
          }
        })();
      }
      return exec;
    };

    return new Proxy({} as APIPromise<any>, {
      get: (_t, prop, _r) => {
        if (prop === 'withResponse') {
          return async () => {
            const r = await ensure();
            return { data: r.data, response: r.response as any };
          };
        }
        if (
          prop === 'then' ||
          prop === 'catch' ||
          prop === 'finally' ||
          prop in Promise.prototype
        ) {
          if (!dataP) dataP = ensure().then((r) => r.data);
          // @ts-ignore
          return dataP[prop].bind(dataP);
        }
        return undefined;
      },
    });
  }

  private wrapStreamAndFinish<T>(
    stream: AsyncIterable<T>,
    span: Span,
    t0: number,
    postprocess?: (span: Span, allChunks: T[]) => void,
  ) {
    const origIter = (stream as any)[Symbol.asyncIterator]?.bind(stream);
    if (!origIter) return stream;

    let first = true;
    const all: T[] = [];

    const wrapped = new Proxy(stream as any, {
      get(target, prop, recv) {
        if (prop === Symbol.asyncIterator) {
          return async function* () {
            try {
              for await (const chunk of origIter()) {
                if (first) {
                  span.setAttribute(
                    'gen_ai.metrics.time_to_first_token_ms',
                    Date.now() - t0,
                  );
                  first = false;
                }
                all.push(chunk);
                yield chunk;
              }
              if (postprocess) postprocess(span, all);
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (e: any) {
              fail(span, e);
              throw e;
            } finally {
              span.end();
            }
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });

    return wrapped as typeof stream;
  }
}

// Helpers (attributes, serialization, usage, headers)
function proxifyNamespace(
  orig: any,
  overridesFn:
    | ((baseVal: any) => Record<string, any>)
    | Record<string, any>
    | undefined,
) {
  if (!orig || !overridesFn) return orig;
  return new Proxy(orig, {
    get: (target, prop, recv) => {
      const baseVal = Reflect.get(target, prop, recv);
      const overrides =
        typeof overridesFn === 'function'
          ? overridesFn(
              typeof baseVal === 'function' ? baseVal.bind(target) : baseVal,
            )
          : overridesFn;

      if (prop in overrides) {
        return overrides[prop as keyof typeof overrides];
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

function setAttrs(span: Span, kv: Record<string, AttributeValue | undefined>) {
  for (const [k, v] of Object.entries(kv)) {
    if (v !== undefined) span.setAttribute(k, v);
  }
}

function setJSON(span: Span, key: string, value: any, maxChars = 40_000) {
  try {
    const json = JSON.stringify(value ?? null);
    const truncated =
      json.length > maxChars ? json.slice(0, maxChars) + '…(truncated)' : json;
    span.setAttribute(key, truncated);
    if (json.length > maxChars) {
      span.setAttribute(`${key}_truncated`, true);
      span.setAttribute(`${key}_len`, json.length);
    }
  } catch {
    span.setAttribute(key, '[[unserializable]]');
  }
}

function usageAttrs(usage: any) {
  return usage
    ? {
        'gen_ai.usage.prompt_tokens': usage?.prompt_tokens,
        'gen_ai.usage.completion_tokens': usage?.completion_tokens,
        'gen_ai.usage.total_tokens': usage?.total_tokens,
      }
    : {};
}

function setUsage(span: Span, usage: any) {
  if (!usage) return;
  setAttrs(span, usageAttrs(usage));
}

function postprocessChatStream(all: any[]) {
  let text = '';
  let tool_calls: any[] | undefined;
  let usage: any | undefined;

  for (const item of all) {
    if (item?.usage) usage = item.usage;
    const delta = item?.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.content === 'string') text += delta.content;

    if (delta.tool_calls) {
      const [tc] = delta.tool_calls;
      if (
        !tool_calls ||
        (tc?.id && tool_calls[tool_calls.length - 1]?.id !== tc.id)
      ) {
        tool_calls = [
          ...(tool_calls ?? []),
          { id: tc?.id, type: tc?.type, function: tc?.function },
        ];
      } else {
        tool_calls[tool_calls.length - 1].function.arguments +=
          tc.function?.arguments ?? '';
      }
    }
  }

  return { text, tool_calls, usage };
}

function fail(span: Span, e: any) {
  span.recordException(e);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: e?.message ?? String(e),
  });
}

function isAsyncIterable<T = any>(x: any): x is AsyncIterable<T> {
  return x && typeof x[Symbol.asyncIterator] === 'function';
}

function sanitizeSpanName(value: string, maxLength: number = 128): string {
  if (!value) {
    return 'unknown_span';
  }

  // Lowercase for consistency
  let spanName = value.toLowerCase();

  // Replace unsafe characters with underscores
  spanName = spanName.replace(/[^a-z0-9._-]+/g, '_');

  // Collapse multiple underscores
  spanName = spanName.replace(/_+/g, '_');

  // Trim leading/trailing underscores or dashes
  spanName = spanName.replace(/^[_-]+|[_-]+$/g, '');

  // Enforce max length
  spanName = spanName.slice(0, maxLength);

  return spanName || 'unknown_span';
}

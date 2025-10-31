import {
  AttributeValue,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from '@opentelemetry/api';
import { SpanTelemetry } from './span-telemetry';
import { OpenAILike, StatsigOpenAIProxyConfig } from './openai-configs';

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
    this.tracer = trace.getTracer('statsig-openai-proxy');
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
        onData: (telemetry, data, t0) => {
          const first = data?.choices?.[0];
          const outText = first?.message?.content ?? '';
          telemetry.setAttributes({
            'gen_ai.response.id': data?.id,
            'gen_ai.response.model': data?.model,
            'gen_ai.response.created': data?.created,
            'gen_ai.completion.choices_count': data?.choices?.length,
            'gen_ai.response.finish_reason': first?.finish_reason,
            'gen_ai.completion': outText,
            'gen_ai.metrics.time_to_first_token_ms': Date.now() - t0,
          });
          telemetry.setUsage(data?.usage);

          telemetry.setJSON(
            'gen_ai.input',
            this._redact?.(params?.messages) ?? params?.messages,
          );
          if (first?.message?.tool_calls) {
            telemetry.setJSON(
              'gen_ai.output.tool_calls_json',
              this._redact?.(first.message.tool_calls) ??
                first.message.tool_calls,
            );
          }
        },

        postprocessStream: (telemetry, all) => {
          const { text, tool_calls, usage } = postprocessChatStream(all);
          if (text) {
            telemetry.setJSON('gen_ai.output.messages_json', [
              { role: 'assistant', content: text },
            ]);
            telemetry.setAttributes({ 'gen_ai.completion': text });
          }
          if (tool_calls) {
            telemetry.setJSON('gen_ai.output.tool_calls_json', tool_calls);
          }
          telemetry.setUsage(usage);
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
        onData: (telemetry, data, t0) => {
          const first = data?.choices?.[0];
          telemetry.setAttributes({
            'gen_ai.completion': first?.text ?? '',
            'gen_ai.response.finish_reason': first?.finish_reason,
            'gen_ai.metrics.time_to_first_token_ms': Date.now() - t0,
          });
          telemetry.setUsage(data?.usage);

          if (typeof params?.prompt === 'string') {
            telemetry.setAttributes({ 'gen_ai.prompt': params.prompt });
          } else if (Array.isArray(params?.prompt)) {
            telemetry.setJSON('gen_ai.prompt_json', params.prompt);
          }
        },
        postprocessStream: (telemetry, all) => {
          const { text, usage } = postprocessChatStream(all);
          if (text) telemetry.setAttributes({ 'gen_ai.completion': text });
          telemetry.setUsage(usage);
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
    const telemetry = this.startSpan(
      'openai.embeddings.create',
      'embeddings.create',
      {
        'gen_ai.request.model': params?.model,
        'gen_ai.request.encoding_format': params?.encoding_format ?? 'float',
      },
      'gen_ai.input',
      this._redact?.(params?.input) ?? params?.input,
    );

    return context.with(
      trace.setSpan(context.active(), telemetry.span),
      async () => {
        try {
          const res = await originalCall(params, options);
          telemetry.setAttributes({
            'gen_ai.response.model': res?.model,
            'gen_ai.embeddings.count': res?.data?.length,
            'gen_ai.embeddings.dimension': res?.data?.[0]?.embedding?.length,
          });
          telemetry.setUsage(res?.usage);
          telemetry.setStatus({ code: SpanStatusCode.OK });
          return res;
        } catch (e: any) {
          telemetry.fail(e);
          throw e;
        } finally {
          telemetry.end();
        }
      },
    );
  }

  // images.generate
  private async wrapImagesGenerate(
    originalCall: any,
    params: any,
    options?: any,
  ) {
    const telemetry = this.startSpan(
      'openai.images.generate',
      'images.generate',
      {
        'gen_ai.request.model': params?.model,
      },
      'gen_ai.input',
      this._redact?.(params) ?? params,
    );

    return context.with(
      trace.setSpan(context.active(), telemetry.span),
      async () => {
        try {
          const res = await originalCall(params, options);
          telemetry.setAttributes({
            'gen_ai.response.created': res?.created,
            'gen_ai.images.count': res?.data?.length,
          });
          telemetry.setStatus({ code: SpanStatusCode.OK });
          return res;
        } catch (e: any) {
          telemetry.fail(e);
          throw e;
        } finally {
          telemetry.end();
        }
      },
    );
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
        onData: (telemetry, data, t0) => {
          const text =
            data?.output_text ??
            data?.choices?.[0]?.message?.content ??
            data?.content?.[0]?.text ??
            '';
          telemetry.setAttributes({
            'gen_ai.completion': text,
            'gen_ai.metrics.time_to_first_token_ms': Date.now() - t0,
          });
          telemetry.setUsage(data?.usage);
          telemetry.setJSON(
            'gen_ai.input',
            this._redact?.(params?.input) ?? params?.input,
          );
        },
        postprocessStream: (telemetry, all) => {
          const { text, usage } = postprocessChatStream(all);
          if (text) telemetry.setAttributes({ 'gen_ai.completion': text });
          telemetry.setUsage(usage);
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
    const telemetry = this.startSpan(
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
    return this.wrapStreamAndFinish(stream, telemetry, t0);
  }

  private wrapResponsesParse(originalCall: any, params: any, options?: any) {
    const telemetry = this.startSpan(
      'openai.responses.parse',
      'responses.parse',
      {},
      undefined,
      undefined,
    );
    return context.with(
      trace.setSpan(context.active(), telemetry.span),
      async () => {
        try {
          const res = await originalCall(params, options);
          telemetry.setStatus({ code: SpanStatusCode.OK });
          return res;
        } catch (e: any) {
          telemetry.fail(e);
          throw e;
        } finally {
          telemetry.end();
        }
      },
    );
  }

  // Core wrappers
  private startSpan(
    spanName: string,
    operationName: string,
    baseAttrs?: Record<string, AttributeValue>,
    inputJSONKey?: string,
    inputJSON?: any,
  ): SpanTelemetry {
    const attributes = {
      'gen_ai.system': 'openai',
      'gen_ai.operation.name': operationName,
      ...(this._customAttributes ?? {}),
      ...(baseAttrs ?? {}),
    } as Record<string, AttributeValue | undefined>;

    const span = this.tracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes,
    });

    const telemetry = new SpanTelemetry(span, spanName, this._maxJSONChars);

    telemetry.setAttributes(attributes);

    telemetry.setAttributes({ 'span.kind': 'client' });

    if (inputJSONKey && inputJSON !== undefined) {
      telemetry.setJSON(inputJSONKey, inputJSON);
    }
    return telemetry;
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
      onData: (telemetry: SpanTelemetry, data: any, t0: number) => void;
      postprocessStream: (telemetry: SpanTelemetry, allChunks: any[]) => void;
      inputJSONKey?: string;
      inputJSONValue?: any;
    },
  ) {
    let exec: Promise<{ data: any; response?: Response }> | null = null;
    let dataP: Promise<any> | null = null;

    const ensure = () => {
      if (!exec) {
        exec = (async () => {
          const telemetry = this.startSpan(
            spanName,
            operationName,
            opts.baseAttrs,
            opts.inputJSONKey,
            opts.inputJSONValue,
          );
          const t0 = Date.now();
          let endedByStream = false;

          try {
            const maybe = callFn(params, options);

            if (isAsyncIterable(maybe)) {
              telemetry.setAttributes({ 'gen_ai.response.stream': true });
              const wrapped = this.wrapStreamAndFinish(
                maybe,
                telemetry,
                t0,
                opts.postprocessStream,
              );
              endedByStream = true;
              return { data: wrapped };
            }

            const apip = maybe;
            if (typeof apip.withResponse === 'function') {
              const { data, response } = await apip.withResponse();
              opts.onData(telemetry, data, t0);
              telemetry.setStatus({ code: SpanStatusCode.OK });
              telemetry.end();
              return { data, response };
            } else {
              const data = await apip;
              opts.onData(telemetry, data, t0);
              telemetry.setStatus({ code: SpanStatusCode.OK });
              telemetry.end();
              return { data };
            }
          } catch (e: any) {
            telemetry.fail(e);
            throw e;
          } finally {
            if (!endedByStream) {
              telemetry.end();
            }
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
    telemetry: SpanTelemetry,
    t0: number,
    postprocess?: (telemetry: SpanTelemetry, allChunks: T[]) => void,
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
                  telemetry.setAttributes({
                    'gen_ai.metrics.time_to_first_token_ms': Date.now() - t0,
                  });
                  first = false;
                }
                all.push(chunk);
                yield chunk;
              }
              if (postprocess) postprocess(telemetry, all);
              telemetry.setStatus({ code: SpanStatusCode.OK });
            } catch (e: any) {
              telemetry.fail(e);
              throw e;
            } finally {
              telemetry.end();
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

function isAsyncIterable<T = any>(x: any): x is AsyncIterable<T> {
  return x && typeof x[Symbol.asyncIterator] === 'function';
}

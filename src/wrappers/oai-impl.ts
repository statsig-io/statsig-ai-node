import {
  AttributeValue,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from '@opentelemetry/api';
import { SpanTelemetry } from './span-telemetry';
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
import { extractBaseAttributes } from './attribute-helper';

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
  private _captureOptions?: GenAICaptureOptions;

  constructor(openai: OpenAILike, config: StatsigOpenAIProxyConfig) {
    this.openai = openai;
    this.tracer = OtelSingleton.getInstance()
      .getTracerProvider()
      .getTracer('statsig-openai-proxy');
    this._maxJSONChars = config.maxJSONChars ?? 40_000;
    this._customAttributes = config.customAttributes;
    this._captureOptions = config.captureOptions;
  }

  get client(): OpenAILike {
    const self = this;

    const completion = new Proxy(this.openai.completions, {
      get(target, name, recv) {
        const original = Reflect.get(target, name, recv);
        if (name === 'create') {
          return self.wrapMaybeStreamMethod(
            original.bind(target),
            'text_completion',
          );
        }
        return original;
      },
    });

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
                );
              }
              return original;
            },
          });
        }

        return Reflect.get(target, name, recv);
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

  private wrapMaybeStreamMethod<
    Params extends Record<string, unknown>,
    Result extends NonStreamingResult | StreamingResult,
  >(
    callFn: (params: Params, options?: unknown) => APIPromise<Result>,
    opName: string,
  ): (params: Params, options?: unknown) => APIPromise<Result> {
    return (params: Params, options?: unknown) => {
      let taskPromise: Promise<ResponseWithData> | null = null;
      let dataPromise: Promise<Result> | null = null;
      params = params ?? ({} as Params);

      const spanName = `${opName} ${params.model ?? 'unknown'}`;

      console.log('spanName', spanName);

      const ensureTaskRun: () => Promise<ResponseWithData> = () => {
        if (!taskPromise) {
          taskPromise = (async () => {
            const t0 = Date.now();
            const telemetry = this.startSpan(
              spanName,
              opName,
              params as Record<string, any>,
            );
            const maybeStream = callFn(params, options);

            if (isAsyncIterable(maybeStream)) {
              telemetry.setAttributes({ 'gen_ai.request.stream': true });
              const wrappedStream = this.wrapStreamAndFinish(
                maybeStream,
                telemetry,
                t0,
              );
              return { data: wrappedStream };
            }

            try {
              const promise = maybeStream;
              if (typeof promise.withResponse === 'function') {
                const { data, response } = await promise.withResponse();
                telemetry.setStatus({ code: SpanStatusCode.OK });
                telemetry.setUsage(data?.usage ?? {});
                telemetry.setResponseAttributes(response);
                return { data };
              }

              const data = await promise;
              telemetry.setStatus({ code: SpanStatusCode.OK });
              return { data };
            } catch (e) {
              telemetry.fail(e);
              throw e;
            } finally {
              telemetry.end();
            }
          })();
        }

        return taskPromise as Promise<ResponseWithData>;
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
            const apip = originalCall(params, options);
            let data: any;
            let response: Response | undefined;
            if (typeof apip.withResponse === 'function') {
              const r = await apip.withResponse();
              data = r.data;
              response = r.response;
            } else {
              data = await apip;
            }
            telemetry.setStatus({ code: SpanStatusCode.OK });
            telemetry.setUsage((data as any)?.usage ?? {});
            if (response) telemetry.setResponseAttributes(response);
            return data as Result;
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

  private wrapStreamAndFinish<T>(
    stream: AsyncIterable<T>,
    telemetry: SpanTelemetry,
    t0: number,
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

  private startSpan(
    spanName: string,
    opName: string,
    params: Record<string, any>,
  ): SpanTelemetry {
    let ctx = context.active();
    const baseAttrs = extractBaseAttributes(
      'openai',
      opName,
      params as Record<string, any>,
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
    console.log('telemetry attributes', attributes);

    telemetry.setAttributes(attributes);
    return telemetry;
  }
}

function isAsyncIterable<T = any>(x: any): x is AsyncIterable<T> {
  return x && typeof x[Symbol.asyncIterator] === 'function';
}

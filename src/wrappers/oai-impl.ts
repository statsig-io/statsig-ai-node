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
import {
  extractBaseAttributes,
  extractUsageAttributes,
} from './attribute-helper';

const STATSIG_SPAN_LLM_ROOT_CTX_VAL = Symbol('STATSIG_SPAN_LLM_ROOT_CTX_VAL');

type ResponseWithData = {
  response: Response;
  data: any;
};

type APIPromise<T> = Promise<T> & {
  withResponse: () => Promise<ResponseWithData>;
};

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
          return self.wrapPotentialStreamMethod(
            original.bind(target),
            'text_completion',
          );
        }
        return original;
      },
    });

    const chat = new Proxy(this.openai.chat, {
      get(target, name, recv) {
        console.log('name in proxy', name);
        const original = Reflect.get(target, name, recv);
        console.log('original', original);
        if (name === 'completions') {
          return self.wrapPotentialStreamMethod(original.bind(target), 'chat');
        }
        return original;
      },
    });

    const embeddings = {};

    const images = {};

    const responses = {};

    return new Proxy(this.openai, {
      get: (target, name, recv) => {
        switch (name) {
          case 'chat':
            return chat;
          case 'completion':
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

  private wrapPotentialStreamMethod<
    Params extends Record<string, unknown>,
    Result,
  >(
    originalCall: (params: Params, options?: unknown) => APIPromise<Result>,
    opName: string,
  ): (params: Params, options?: unknown) => APIPromise<Result> {
    return (params: Params, options?: unknown) => {
      let taskPromise: Promise<ResponseWithData> | null = null;
      let dataPromise: Promise<Result> | null = null;
      params = params ?? ({} as Params);

      const spanName = `${opName} ${params.model ?? 'unknown'}`;

      const ensureTaskRun: () => Promise<ResponseWithData> = () => {
        if (!taskPromise) {
          taskPromise = (async () => {
            const baseAttrs = extractBaseAttributes(
              'openai',
              opName,
              params as Record<string, any>,
            );
            const t0 = Date.now();
            const telemetry = this.startSpan(spanName, baseAttrs);
            try {
              if (params.stream) {
                telemetry.setAttributes({ 'gen_ai.request.stream': true });
                const { data, response } = await originalCall(
                  params,
                  options,
                ).withResponse();
                telemetry.setStatus({ code: SpanStatusCode.OK });
                telemetry.setUsage(data?.usage ?? {});
                telemetry.setResponseAttributes(response);
                return { data: data as Result, response };
              } else {
                const { data, response } = await originalCall(
                  params,
                  options,
                ).withResponse();
                telemetry.setStatus({ code: SpanStatusCode.OK });
                telemetry.setUsage(data?.usage ?? {});
                telemetry.setResponseAttributes(response);
                return { data: data as Result, response };
              }
            } catch (e: any) {
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

  private startSpan(
    spanName: string,
    baseAttrs?: Record<string, AttributeValue>,
  ): SpanTelemetry {
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

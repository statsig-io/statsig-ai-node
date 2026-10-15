import {
  AttributeValue,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from '@opentelemetry/api';
import {
  STATSIG_ATTR_SPAN_LLM_ROOT,
  STATSIG_ATTR_SPAN_TYPE,
  STATSIG_SPAN_LLM_ROOT_VALUE,
  StatsigSpanType,
} from '../otel/conventions';
import { getEnvironmentSpanAttrsFromContext } from '../otel/environment-context';
import { getPromptSpanAttrsFromContext } from '../otel/prompt-context';
import {
  createResourceAttributes,
  StatsigResourceAttributes,
} from '../otel/resources';
import { OtelSingleton } from '../otel/singleton';
import { getStatsigSpanAttrsFromContext } from '../otel/statsig-context';
import { GenAICaptureOptions } from './openai-configs';
import { SpanTelemetry, TelemetryStream } from './span-telemetry';

const STATSIG_SPAN_LLM_ROOT_CTX_VAL = Symbol('STATSIG_SPAN_LLM_ROOT_CTX_VAL');

// Starts a client span for one model call, tagged with the active Statsig
// prompt, prompt version and context so it can be graded and attributed.
// Template variables usually hold user input, so they follow the same capture
// option as the input messages.
export function startGenAISpan(
  tracer: Tracer,
  spanName: string,
  baseAttrs: Record<string, AttributeValue>,
  customAttributes: Record<string, AttributeValue> | undefined,
  maxJSONChars: number,
  captureOptions: GenAICaptureOptions,
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

  Object.assign(
    statsigAttrs,
    getPromptSpanAttrsFromContext(ctx, {
      includeTemplateVariables: Boolean(
        captureOptions.capture_all || captureOptions.capture_input_messages,
      ),
    }),
  );

  const maybeStatsigContextAttrs = getStatsigSpanAttrsFromContext(ctx);
  if (maybeStatsigContextAttrs) {
    Object.assign(statsigAttrs, maybeStatsigContextAttrs);
  }
  Object.assign(statsigAttrs, getEnvironmentSpanAttrsFromContext(ctx));

  const attributes: Record<string, AttributeValue | undefined> = {
    ...(customAttributes ?? {}),
    ...baseAttrs,
    ...statsigAttrs,
  };

  const span = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes,
    },
    ctx,
  );

  let resources: StatsigResourceAttributes;
  if (OtelSingleton.isInitialized()) {
    resources = OtelSingleton.getInstance().getResources();
  } else {
    resources = createResourceAttributes();
  }

  const telemetry = new SpanTelemetry(span, spanName, maxJSONChars, resources);
  telemetry.setAttributes(attributes);
  return telemetry;
}

type GenAICallHandlers<Result> = {
  onResult: (result: Result) => Record<string, AttributeValue | undefined>;
  onStream?: (items: unknown[]) => Record<string, AttributeValue | undefined>;
};

// Runs a provider call inside its span. A streamed result is returned as a
// stream that ends the span once the caller has consumed it. Promise helpers
// such as Anthropic's withResponse() are passed through to the original call.
export function traceGenAICall<Result>(
  telemetry: SpanTelemetry,
  call: () => Result | Promise<Result>,
  handlers: GenAICallHandlers<Result>,
): Promise<Result> {
  let pending: Result | Promise<Result>;
  try {
    pending = context.with(
      trace.setSpan(context.active(), telemetry.span),
      call,
    );
  } catch (e) {
    telemetry.fail(e);
    telemetry.end();
    throw e;
  }

  const traced = Promise.resolve(pending).then(
    (result) => {
      const { onStream } = handlers;
      if (onStream && isAsyncIterable(result)) {
        return wrapStream(result, telemetry, (items) =>
          setAttributesSafely(telemetry, () => onStream(items)),
        ) as Result;
      }
      telemetry.recordTimeToFirstToken();
      telemetry.setStatus({ code: SpanStatusCode.OK });
      setAttributesSafely(telemetry, () => handlers.onResult(result));
      telemetry.end();
      return result;
    },
    (e) => {
      telemetry.fail(e);
      telemetry.end();
      throw e;
    },
  );

  for (const helper of ['withResponse', 'asResponse']) {
    const fn = (pending as Record<string, unknown> | undefined)?.[helper];
    if (typeof fn === 'function') {
      Object.assign(traced, { [helper]: fn.bind(pending) });
    }
  }
  return traced;
}

export function setAttributesSafely(
  telemetry: SpanTelemetry,
  getAttributes: () => Record<string, AttributeValue | undefined>,
): void {
  try {
    telemetry.setAttributes(getAttributes());
  } catch (e) {
    console.warn('[Statsig] Failed to record Gen AI response attributes.', e);
  }
}

function isAsyncIterable(x: unknown): x is AsyncIterable<unknown> {
  return (
    x != null &&
    typeof (x as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function'
  );
}

function wrapStream<T>(
  stream: AsyncIterable<T>,
  telemetry: SpanTelemetry,
  onData: (items: T[]) => void,
): AsyncIterable<T> {
  return new Proxy(stream, {
    get(target, prop, recv) {
      if (prop === Symbol.asyncIterator) {
        return () =>
          new TelemetryStream(stream, telemetry, (_telemetry, items) =>
            onData(items),
          )[Symbol.asyncIterator]();
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

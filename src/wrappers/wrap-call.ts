import {
  AttributeValue,
  context,
  Span,
  SpanStatusCode,
} from '@opentelemetry/api';
import { StatsigUser } from '@statsig/statsig-node-core';
import {
  STATSIG_ATTR_GEN_AI_SPAN_TYPE,
  STATSIG_ATTR_SPAN_LLM_ROOT,
  STATSIG_ATTR_SPAN_TYPE,
  STATSIG_SPAN_LLM_ROOT_VALUE,
  StatsigGenAISpanType,
  StatsigSpanType,
} from '../otel/conventions';
import { OtelSingleton } from '../otel/singleton';
import {
  setStatsigContextToContext,
  setStatsigSpanAttrsFromContext,
} from '../otel/statsig-context';
import { setUserSpanAttrsFromContext } from '../otel/user-context';

type ToolInput = {
  type: 'tool';
  name: string;
  toolType?: string;
};

type NamedInput = {
  type: 'workflow';
  name: string;
};

type WrapCallInput = (NamedInput | ToolInput) & {
  attributes?: Record<string, AttributeValue>;
  user?: StatsigUser;
  activityID?: string;
};

const NAME_PREFIX = 'gen_ai.';
const OpNameByType: Record<WrapCallInput['type'], string> = {
  workflow: 'invoke_workflow',
  tool: 'execute_tool',
} as const;

export function wrap<TFun extends (...args: any[]) => any>(
  input: WrapCallInput,
  fn: TFun,
): TFun {
  const tracer = OtelSingleton.getTracerProvider().getTracer('wrap-call');

  function wrappedFunction(...args: Parameters<TFun>): ReturnType<TFun> {
    const opName = OpNameByType[input.type];
    let ctx = context.active();

    if (input.user || input.activityID) {
      ctx = setStatsigContextToContext(ctx, {
        user: input.user,
        activityID: input.activityID,
      });
    }

    const result = tracer.startActiveSpan(opName, {}, ctx, (span) => {
      try {
        span.setAttributes(input.attributes || {});
        span.setAttribute(STATSIG_ATTR_SPAN_TYPE, StatsigSpanType.gen_ai);

        setUserSpanAttrsFromContext(context.active(), span);
        setStatsigSpanAttrsFromContext(context.active(), span);
        assignAttributesForInputType(input, span);

        span.setStatus({ code: SpanStatusCode.OK });
        const result = fn(...args);
        if (isThenable(result)) {
          return result
            .then((res) => {
              span.end();
              span.setStatus({ code: SpanStatusCode.OK });
              return res;
            })
            .catch((e: unknown) => {
              span.recordException(e as Error);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (e as Error).message,
              });
              span.end();
              throw e;
            }) as ReturnType<TFun>;
        }
        span.end();
        return result;
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (e as Error).message,
        });
        span.end();
        throw e;
      }
    });
    return result;
  }

  return wrappedFunction as TFun;
}

export function startWorkflow<R>(
  args: {
    name: string;
    user?: StatsigUser;
    attributes?: Record<string, unknown>;
  },
  fn: () => R,
): R {
  return wrap(
    {
      type: 'workflow',
      name: args.name,
      user: args.user,
      attributes: {
        ...args.attributes,
        [STATSIG_ATTR_SPAN_LLM_ROOT]: STATSIG_SPAN_LLM_ROOT_VALUE,
      },
    },
    fn,
  )();
}

function assignAttributesForInputType(input: WrapCallInput, span: Span) {
  if ('name' in input) {
    span.setAttribute(
      'statsig.' + NAME_PREFIX + input.type + '.name',
      input.name,
    );
    if (input.type === 'tool' && input.toolType) {
      span.setAttribute(NAME_PREFIX + 'tool.type', input.toolType);
    }
  }

  switch (input.type) {
    case 'tool':
      span.setAttribute(
        STATSIG_ATTR_GEN_AI_SPAN_TYPE,
        StatsigGenAISpanType.tool,
      );
      break;
    case 'workflow':
      span.setAttribute(
        STATSIG_ATTR_GEN_AI_SPAN_TYPE,
        StatsigGenAISpanType.workflow,
      );
      break;
  }
}

export interface Thenable<T = any> {
  then: (
    onfulfilled?: (value: T) => any,
    onrejected?: (reason: any) => any,
  ) => any;
}

export function isThenable<T = any>(value: unknown): value is Thenable<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as any).then === 'function'
  );
}

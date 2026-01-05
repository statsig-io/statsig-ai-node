import {
  AttributeValue,
  context,
  Span,
  SpanStatusCode,
} from '@opentelemetry/api';
import { StatsigUser } from '@statsig/statsig-node-core';
import { SpanTelemetry } from './span-telemetry';
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
  getStatsigSpanAttrsFromContext,
  setStatsigContextToContext,
  setStatsigSpanAttrsFromContext,
} from '../otel/statsig-context';
import {
  getUserSpanAttrsFromContext,
  setUserSpanAttrsFromContext,
} from '../otel/user-context';

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
      const telemetry = new SpanTelemetry(span, opName);
      try {
        telemetry.setAttributes(input.attributes || {});
        telemetry.setAttributes({
          [STATSIG_ATTR_SPAN_TYPE]: StatsigSpanType.gen_ai,
        });

        const contextAttributes = {
          ...getUserSpanAttrsFromContext(context.active()),
          ...getStatsigSpanAttrsFromContext(context.active()),
        };
        telemetry.setAttributes(contextAttributes);
        telemetry.setAttributes(getAttributesForInputType(input));

        telemetry.setStatus({ code: SpanStatusCode.OK });
        const result = fn(...args);
        if (isThenable(result)) {
          return result
            .then((res) => {
              telemetry.end();
              telemetry.setStatus({ code: SpanStatusCode.OK });
              return res;
            })
            .catch((e: unknown) => {
              telemetry.recordException(e as Error);
              telemetry.setStatus({
                code: SpanStatusCode.ERROR,
                message: (e as Error).message,
              });
              telemetry.end();
              throw e;
            }) as ReturnType<TFun>;
        }
        telemetry.end();
        return result;
      } catch (e) {
        telemetry.recordException(e as Error);
        telemetry.setStatus({
          code: SpanStatusCode.ERROR,
          message: (e as Error).message,
        });
        telemetry.end();
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

function getAttributesForInputType(
  input: WrapCallInput,
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};

  if ('name' in input) {
    attributes['statsig.' + NAME_PREFIX + input.type + '.name'] = input.name;
    if (input.type === 'tool' && input.toolType) {
      attributes[NAME_PREFIX + 'tool.type'] = input.toolType;
    }
  }

  switch (input.type) {
    case 'tool':
      attributes[STATSIG_ATTR_GEN_AI_SPAN_TYPE] = StatsigGenAISpanType.tool;
      break;
    case 'workflow':
      attributes[STATSIG_ATTR_GEN_AI_SPAN_TYPE] = StatsigGenAISpanType.workflow;
      break;
  }

  return attributes;
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

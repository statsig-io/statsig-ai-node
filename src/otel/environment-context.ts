import { AttributeValue, context, Context } from '@opentelemetry/api';
import {
  STATSIG_ATTR_ENVIRONMENT,
  STATSIG_CTX_KEY_ACTIVE_ENVIRONMENT,
} from './conventions';

/**
 * `production` for live traffic. `eval` and `online_eval_judge` are reserved
 * for spans Statsig generates (`Eval()` runs and online eval judges).
 */
export type StatsigEnvironment =
  | 'production'
  | 'eval'
  | 'online_eval_judge'
  | (string & {});

export function getEnvironmentSpanAttrsFromContext(
  ctx: Context,
): Record<string, AttributeValue> | null {
  const environment = ctx.getValue(STATSIG_CTX_KEY_ACTIVE_ENVIRONMENT);
  if (typeof environment !== 'string' || environment.length === 0) {
    return null;
  }
  return { [STATSIG_ATTR_ENVIRONMENT]: environment };
}

/**
 * Tags every span started inside `fn` with `statsig.environment`, overriding
 * the tracer's `environment` resource for those spans only.
 */
export function withStatsigEnvironment<
  A extends unknown[],
  F extends (...args: A) => ReturnType<F>,
>(
  environment: StatsigEnvironment,
  fn: F,
  thisArg?: ThisParameterType<F>,
  ...args: A
): ReturnType<F> {
  const ctx = context
    .active()
    .setValue(STATSIG_CTX_KEY_ACTIVE_ENVIRONMENT, environment);
  return context.with(ctx, fn, thisArg, ...args);
}

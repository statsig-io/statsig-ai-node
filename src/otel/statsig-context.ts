import { AttributeValue, context, Context, Span } from '@opentelemetry/api';
import { StatsigUser } from '@statsig/statsig-node-core';
import {
  STATSIG_ATTR_CUSTOM_IDS,
  STATSIG_ATTR_USER_ID,
  STATSIG_CTX_KEY_ACTIVE_CONTEXT,
} from './conventions';
import { UserContextItem } from './user-context';

export type StatsigContext = {
  user?: StatsigUser;
  activityID?: string;
};

export type StatsigContextItem = {
  user?: UserContextItem;
  activityID?: string;
};

export function setStatsigContextToContext(
  ctx: Context,
  statsigContext: StatsigContext,
): Context {
  const contextItem: StatsigContextItem = {};

  if (statsigContext.user) {
    contextItem.user = {
      userID: statsigContext.user?.userID || 'unknown',
      customIDs: statsigContext.user.customIDs ?? {},
    };
  }

  if (statsigContext.activityID) {
    contextItem.activityID = statsigContext.activityID;
  }
  return ctx.setValue(STATSIG_CTX_KEY_ACTIVE_CONTEXT, contextItem);
}

export function getStatsigContextFromContext(
  ctx: Context,
): StatsigContextItem | null {
  const statsigContext = ctx.getValue(STATSIG_CTX_KEY_ACTIVE_CONTEXT);
  if (statsigContext == null || typeof statsigContext !== 'object') {
    return null;
  }

  return statsigContext as StatsigContextItem;
}

export function getStatsigSpanAttrsFromContext(
  ctx: Context,
): Record<string, AttributeValue> | null {
  const attrs: Record<string, AttributeValue> = {};
  const maybeContext = getStatsigContextFromContext(ctx);
  if (maybeContext == null) {
    return null;
  }

  if (maybeContext.user) {
    attrs[STATSIG_ATTR_USER_ID] = maybeContext.user.userID ?? 'null';
    if (Object.keys(maybeContext.user.customIDs).length > 0) {
      attrs[STATSIG_ATTR_CUSTOM_IDS] = JSON.stringify(
        maybeContext.user.customIDs,
      );
    }
  }

  return Object.keys(attrs).length > 0 ? attrs : null;
}

export function setStatsigSpanAttrsFromContext(ctx: Context, span: Span): void {
  const attrs = getStatsigSpanAttrsFromContext(ctx);
  if (attrs == null) {
    return;
  }

  span.setAttributes(attrs);
}

export function withStatsigContext<
  A extends unknown[],
  F extends (...args: A) => ReturnType<F>,
>(
  statsigContext: StatsigContext,
  fn: F,
  thisArg?: ThisParameterType<F>,
  ...args: A
): ReturnType<F> {
  let ctx = context.active();
  ctx = setStatsigContextToContext(ctx, statsigContext);
  return context.with(ctx, fn, thisArg, ...args);
}

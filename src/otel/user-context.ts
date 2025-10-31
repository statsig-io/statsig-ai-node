import { AttributeValue, context, Context, Span } from '@opentelemetry/api';
import { StatsigUser } from '@statsig/statsig-node-core';
import {
  STATSIG_ATTR_CUSTOM_IDS,
  STATSIG_ATTR_USER_ID,
  STATSIG_CTX_KEY_ACTIVE_USER,
} from './conventions';

export type UserContextItem = {
  userID: string;
  customIDs: Record<string, string>;
};

export function setUserToContext(ctx: Context, user: StatsigUser): Context {
  const ids: UserContextItem = {
    userID: user.userID || 'unknown',
    customIDs: user.customIDs ?? {},
  };

  return ctx.setValue(STATSIG_CTX_KEY_ACTIVE_USER, ids);
}

export function getUserFromContext(ctx: Context): UserContextItem | null {
  const user = ctx.getValue(STATSIG_CTX_KEY_ACTIVE_USER);
  if (user == null || typeof user !== 'object') {
    return null;
  }

  return user as UserContextItem;
}

export function getUserSpanAttrsFromContext(
  ctx: Context,
): Record<string, AttributeValue> | null {
  const attrs: Record<string, AttributeValue> = {};
  const maybeContextUser = getUserFromContext(ctx);
  if (maybeContextUser == null) {
    return null;
  }

  attrs[STATSIG_ATTR_USER_ID] = maybeContextUser.userID ?? 'null';
  if (Object.keys(maybeContextUser.customIDs).length > 0) {
    attrs[STATSIG_ATTR_CUSTOM_IDS] = JSON.stringify(maybeContextUser.customIDs);
  }
  return attrs;
}

export function setUserSpanAttrsFromContext(ctx: Context, span: Span): void {
  const attrs = getUserSpanAttrsFromContext(ctx);
  if (attrs == null) {
    return;
  }

  span.setAttributes(attrs);
}

export function withStatsigUserContext<
  A extends unknown[],
  F extends (...args: A) => ReturnType<F>,
>(
  user: StatsigUser,
  fn: F,
  thisArg?: ThisParameterType<F>,
  ...args: A
): ReturnType<F> {
  let ctx = context.active();
  ctx = setUserToContext(ctx, user);
  return context.with(ctx, fn, thisArg, ...args);
}

import {
  context,
  Context,
  defaultTextMapGetter,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import {
  TRACE_PARENT_HEADER,
  TRACE_STATE_HEADER,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';

type HeadersObject = { get(name: string): string | null | undefined };

/** Node `IncomingHttpHeaders`-style records or a Fetch `Headers` object. */
export type IncomingHeaders =
  | Record<string, string | string[] | undefined>
  | HeadersObject;

const propagator = new W3CTraceContextPropagator();

function isHeadersObject(headers: IncomingHeaders): headers is HeadersObject {
  return typeof headers.get === 'function';
}

function readHeader(
  headers: IncomingHeaders,
  name: string,
): string | string[] | undefined {
  if (isHeadersObject(headers)) {
    return headers.get(name) ?? undefined;
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key == null ? undefined : headers[key];
}

export function setIncomingTraceToContext(
  ctx: Context,
  headers: IncomingHeaders,
): Context {
  const carrier: Record<string, string | string[]> = {};
  for (const name of [TRACE_PARENT_HEADER, TRACE_STATE_HEADER]) {
    const value = readHeader(headers, name);
    if (value != null) {
      carrier[name] = value;
    }
  }

  const incoming = trace.getSpanContext(
    propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter),
  );
  // OTel HTTP instrumentation may already have started a span in this trace.
  if (
    incoming == null ||
    trace.getSpanContext(ctx)?.traceId === incoming.traceId
  ) {
    return ctx;
  }
  return trace.setSpanContext(ctx, incoming);
}

/**
 * Runs `fn` in the trace named by the request's W3C `traceparent` and
 * `tracestate` headers, so spans started inside it become children of the
 * caller's span. Without a valid `traceparent`, `fn` runs unchanged.
 */
export function withIncomingTraceContext<
  A extends unknown[],
  F extends (...args: A) => ReturnType<F>,
>(
  headers: IncomingHeaders,
  fn: F,
  thisArg?: ThisParameterType<F>,
  ...args: A
): ReturnType<F> {
  const ctx = setIncomingTraceToContext(context.active(), headers);
  return context.with(ctx, fn, thisArg, ...args);
}

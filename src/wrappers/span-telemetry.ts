import { AttributeValue, Span, SpanStatusCode } from '@opentelemetry/api';
import { StatsigUser, type Statsig } from '@statsig/statsig-node-core';

const GEN_AI_EVENT_NAME = 'statsig::gen_ai';
const PLACEHOLDER_STATSIG_USER = new StatsigUser({
  userID: 'statsig-ai-openai-wrapper',
});

export class SpanTelemetry {
  private readonly metadata: Record<string, string> = {};
  private ended = false;

  constructor(
    public readonly span: Span,
    private readonly spanName: string,
    private readonly maxJSONChars: number,
  ) {
    this.metadata['span.name'] = spanName;
    this.metadata['span_name'] = sanitizeSpanName(spanName);
    const ctx = span.spanContext();
    this.metadata['span.trace_id'] = ctx.traceId;
    this.metadata['span.span_id'] = ctx.spanId;
  }

  public setAttributes(kv: Record<string, AttributeValue | undefined>): void {
    for (const [key, value] of Object.entries(kv)) {
      if (value === undefined) {
        continue;
      }
      this.span.setAttribute(key, value);
      this.metadata[key] = attributeValueToMetadata(value);
    }
  }

  public setJSON(key: string, value: any): void {
    try {
      const json = JSON.stringify(value ?? null);
      const truncated =
        json.length > this.maxJSONChars
          ? json.slice(0, this.maxJSONChars) + '…(truncated)'
          : json;
      this.setAttributes({ [key]: truncated });
      if (json.length > this.maxJSONChars) {
        this.setAttributes({ [`${key}_truncated`]: true });
        this.setAttributes({ [`${key}_len`]: json.length });
      }
    } catch {
      this.setAttributes({ [key]: '[[unserializable]]' });
    }
  }

  public setUsage(usage: any): void {
    if (!usage) {
      return;
    }
    this.setAttributes(usageAttrs(usage));
  }

  public setStatus(status: { code: SpanStatusCode; message?: string }): void {
    this.span.setStatus(status);
    const codeName = SpanStatusCode[status.code];
    this.metadata['span.status_code'] =
      typeof codeName === 'string' ? codeName : String(status.code);
    this.metadata['span.status_code_value'] = String(status.code);
    if (status.message) {
      this.metadata['span.status_message'] = String(status.message);
    }
  }

  public recordException(error: any): void {
    this.span.recordException(error);
    const type = error?.name ?? error?.constructor?.name ?? undefined;
    const message =
      error?.message ?? (typeof error === 'string' ? error : undefined);
    if (type) {
      this.metadata['exception.type'] = String(type);
    }
    if (message) {
      this.metadata['exception.message'] = String(message);
    }
  }

  public fail(error: any): void {
    this.recordException(error);
    this.setStatus({
      code: SpanStatusCode.ERROR,
      message: error?.message ?? String(error),
    });
  }

  public end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.span.end();
    this.logSpanEvent(this.spanName, { ...this.metadata });
  }

  private logSpanEvent(
    spanName: string,
    metadata: Record<string, string>,
  ): void {
    const statsig = getStatsigInstanceForLogging();
    if (!statsig) {
      console.warn(
        '[Statsig] No shared global StatsigAI instance found. Call StatsigAI.newShared() before invoking OpenAI methods to capture Gen AI telemetry.',
      );
      return;
    }

    try {
      statsig.logEvent(
        PLACEHOLDER_STATSIG_USER,
        GEN_AI_EVENT_NAME,
        sanitizeSpanName(spanName),
        metadata,
      );
    } catch (err: any) {
      console.warn(
        '[Statsig] Failed to log span event.',
        err?.message ?? String(err),
      );
    }
  }
}

function sanitizeSpanName(value: string, maxLength: number = 128): string {
  if (!value) {
    return 'unknown_span';
  }

  // Lowercase for consistency
  let spanName = value.toLowerCase();

  // Replace unsafe characters with underscores
  spanName = spanName.replace(/[^a-z0-9._-]+/g, '_');

  // Collapse multiple underscores
  spanName = spanName.replace(/_+/g, '_');

  // Trim leading/trailing underscores or dashes
  spanName = spanName.replace(/^[_-]+|[_-]+$/g, '');

  // Enforce max length
  spanName = spanName.slice(0, maxLength);

  return spanName || 'unknown_span';
}

function attributeValueToMetadata(value: AttributeValue): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return safeStringify(value);
  }

  if (typeof value === 'object') {
    return safeStringify(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return String(value);
}

function safeStringify(value: any): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function usageAttrs(usage: any) {
  return usage
    ? {
        'gen_ai.usage.prompt_tokens': usage?.prompt_tokens,
        'gen_ai.usage.completion_tokens': usage?.completion_tokens,
        'gen_ai.usage.total_tokens': usage?.total_tokens,
      }
    : {};
}

// Internal: logs span event to Statsig if available
// Avoids static import to prevent circular deps with index.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getStatsigInstanceForLogging(): Statsig | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('..');
    const StatsigAI = module?.StatsigAI;
    if (StatsigAI?.hasShared?.()) {
      const statsigInstance = StatsigAI.shared();
      return statsigInstance.getStatsig();
    }
  } catch (err) {
    console.warn(
      '[Statsig] Unable to retrieve Statsig instance for span logging.',
      err instanceof Error ? err.message : err,
    );
  }

  return null;
}

import { AttributeValue, Span, SpanStatusCode } from '@opentelemetry/api';
import { StatsigUser, type Statsig } from '@statsig/statsig-node-core';
import {
  extractResponseAttributes,
  extractUsageAttributes,
} from './attribute-helper';

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
    const ctx = span.spanContext();
    this.metadata['span.trace_id'] = ctx.traceId;
    this.metadata['span.span_id'] = ctx.spanId;
  }

  public setAttributes(kv: Record<string, AttributeValue | undefined>): void {
    for (const [key, value] of Object.entries(kv)) {
      if (value === undefined) {
        continue;
      }
      if (typeof value === 'object' && value !== null) {
        this.setJSON(key, value);
        continue;
      }
      this.setAttributeOnSpanAndMetadata(key, value);
    }
  }

  public setJSON(key: string, value: any): void {
    try {
      const json = JSON.stringify(value ?? null);
      const isTruncated = json.length > this.maxJSONChars;

      this.setAttributeOnSpanAndMetadata(
        key,
        isTruncated ? json.slice(0, this.maxJSONChars) + '…(truncated)' : json,
      );
      if (isTruncated) {
        this.setAttributeOnSpanAndMetadata(`${key}_len`, json.length);
      }
    } catch {
      this.setAttributeOnSpanAndMetadata(key, '[[unserializable]]');
    }
  }

  private setAttributeOnSpanAndMetadata(
    key: string,
    value: AttributeValue,
  ): void {
    this.span.setAttribute(key, value);
    this.metadata[key] = attributeValueToMetadata(value);
  }

  public setUsage(usage: Record<string, any>): void {
    this.setAttributes(extractUsageAttributes(usage));
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

  public setResponseAttributes(response: any): void {
    this.setAttributes(extractResponseAttributes(response));
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

    statsig.logEvent(
      PLACEHOLDER_STATSIG_USER,
      GEN_AI_EVENT_NAME,
      spanName,
      metadata,
    );
  }
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

import { context as otelContext, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { IncomingHttpHeaders } from 'http';

import { STATSIG_ATTR_ENVIRONMENT } from '../../otel/conventions';
import { withStatsigEnvironment } from '../../otel/environment-context';
import {
  IncomingHeaders,
  withIncomingTraceContext,
} from '../../otel/incoming-trace-context';
import { OtelSingleton } from '../../otel/singleton';
import { wrapAnthropic } from '../../wrappers/anthropic';
import { wrap } from '../../wrappers/wrap-call';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

function spanNamed(spans: ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((s) => s.name === name);
  if (span == null) {
    throw new Error(`no span named ${name}`);
  }
  return span;
}

describe('withIncomingTraceContext', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    try {
      otelContext.setGlobalContextManager(contextManager);
    } catch (err) {
      // ignore if already set
    }
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    otelContext.disable();
    contextManager.disable();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    OtelSingleton.__reset();
    OtelSingleton.instantiate({ tracerProvider: provider });
  });

  afterEach(async () => {
    await provider.shutdown();
    OtelSingleton.__reset();
  });

  function runTool(headers: IncomingHeaders): Promise<string> {
    const tool = wrap({ type: 'tool', name: 'lookup' }, async () => 'ok');
    return withIncomingTraceContext(headers, tool);
  }

  it('nests workflow, tool and model call spans under the incoming span', async () => {
    const create = jest.fn((_params: unknown) =>
      Object.assign(
        Promise.resolve({
          id: 'msg_1',
          model: 'claude-test',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { withResponse: jest.fn() },
      ),
    );
    const anthropic = wrapAnthropic({ messages: { create } });
    const lookup = wrap({ type: 'tool', name: 'lookup' }, async () => 'facts');
    const agent = wrap({ type: 'workflow', name: 'agent' }, async () => {
      const facts = await lookup();
      return anthropic.messages.create({
        model: 'claude-test',
        max_tokens: 16,
        messages: [{ role: 'user', content: facts }],
      });
    });

    const headers: IncomingHttpHeaders = {
      traceparent: TRACEPARENT,
      tracestate: 'statsig=eval',
    };
    const result = await withIncomingTraceContext(headers, agent);
    expect(result.id).toBe('msg_1');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(TRACE_ID);
    }

    const workflow = spanNamed(spans, 'invoke_workflow');
    expect(workflow.parentSpanContext?.spanId).toBe(SPAN_ID);
    expect(workflow.parentSpanContext?.isRemote).toBe(true);
    expect(workflow.spanContext().traceState?.serialize()).toBe('statsig=eval');

    const workflowSpanId = workflow.spanContext().spanId;
    expect(spanNamed(spans, 'execute_tool').parentSpanContext?.spanId).toBe(
      workflowSpanId,
    );
    expect(spanNamed(spans, 'chat claude-test').parentSpanContext?.spanId).toBe(
      workflowSpanId,
    );
  });

  it('reads a Fetch Headers object', async () => {
    await runTool(new Headers({ traceparent: TRACEPARENT }));

    const [span] = exporter.getFinishedSpans();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(SPAN_ID);
  });

  it('reads mixed-case keys and array values', async () => {
    await runTool({
      Traceparent: [TRACEPARENT, `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`],
      TraceState: ['a=1', 'b=2'],
    });

    const [span] = exporter.getFinishedSpans();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(SPAN_ID);
    expect(span.spanContext().traceState?.serialize()).toBe('a=1,b=2');
  });

  it.each<[string, IncomingHeaders]>([
    ['no trace headers', { 'content-type': 'application/json' }],
    ['an empty Headers object', new Headers()],
    ['a malformed traceparent', { traceparent: 'not-a-traceparent' }],
    [
      'an all-zero trace ID',
      { traceparent: `00-${'0'.repeat(32)}-${SPAN_ID}-01` },
    ],
    ['an unsupported version', { traceparent: `ff-${TRACE_ID}-${SPAN_ID}-01` }],
  ])('runs fn in the current context given %s', async (_, headers) => {
    await expect(runTool(headers)).resolves.toBe('ok');

    const [span] = exporter.getFinishedSpans();
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
  });

  it('keeps an active span that is already in the incoming trace', async () => {
    const tracer = provider.getTracer('http');
    const incomingCtx = trace.setSpanContext(otelContext.active(), {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
      isRemote: true,
    });
    const server = tracer.startSpan('POST /agent', {}, incomingCtx);

    await otelContext.with(trace.setSpan(incomingCtx, server), () =>
      runTool({ traceparent: TRACEPARENT }),
    );
    server.end();

    const tool = spanNamed(exporter.getFinishedSpans(), 'execute_tool');
    expect(tool.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
  });

  it('replaces an active span from another trace and keeps other context values', async () => {
    const tracer = provider.getTracer('test');
    await withStatsigEnvironment('eval', () =>
      tracer.startActiveSpan('unrelated', async (unrelated) => {
        await runTool({ traceparent: TRACEPARENT });
        unrelated.end();
      }),
    );

    const tool = spanNamed(exporter.getFinishedSpans(), 'execute_tool');
    expect(tool.spanContext().traceId).toBe(TRACE_ID);
    expect(tool.parentSpanContext?.spanId).toBe(SPAN_ID);
    expect(tool.attributes[STATSIG_ATTR_ENVIRONMENT]).toBe('eval');
  });
});

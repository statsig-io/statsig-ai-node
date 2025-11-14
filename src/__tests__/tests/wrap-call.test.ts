import { context as otelContext, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { StatsigUser } from '@statsig/statsig-node-core';

import {
  STATSIG_ATTR_CUSTOM_IDS,
  STATSIG_ATTR_SPAN_LLM_ROOT,
  STATSIG_ATTR_SPAN_TYPE,
  STATSIG_ATTR_USER_ID,
  STATSIG_SPAN_LLM_ROOT_VALUE,
  STATSIG_ATTR_GEN_AI_SPAN_TYPE,
  StatsigGenAISpanType,
  StatsigSpanType,
} from '../../otel/conventions';
import { OtelSingleton } from '../../otel/singleton';
import { startWorkflow, wrap } from '../../wrappers/wrap-call';

describe('wrap-call', () => {
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
  });

  afterAll(() => {
    otelContext.disable();
    contextManager.disable();
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
    await provider.forceFlush();
    await provider.shutdown();
    exporter.reset();
    OtelSingleton.__reset();
  });

  it('records tool metadata and user attributes for synchronous functions', async () => {
    const user = new StatsigUser({
      userID: 'user-123',
      customIDs: { team: 'infra' },
    });

    const wrapped = wrap(
      {
        type: 'tool',
        name: 'search',
        toolType: 'retrieval',
        user,
        attributes: { 'custom.attr': 'provided' },
      },
      () => 'ok',
    );

    expect(wrapped()).toBe('ok');

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.name).toBe('gen_ai.execute_tool');
    expect(span.status.code).toBe(SpanStatusCode.OK);

    const attributes = span.attributes as Record<string, unknown>;
    expect(attributes[STATSIG_ATTR_SPAN_TYPE]).toBe(StatsigSpanType.gen_ai);
    expect(attributes[STATSIG_ATTR_GEN_AI_SPAN_TYPE]).toBe(
      StatsigGenAISpanType.tool,
    );
    expect(attributes['gen_ai.tool.name']).toBe('search');
    expect(attributes['gen_ai.tool.type']).toBe('retrieval');
    expect(attributes['custom.attr']).toBe('provided');
    expect(attributes[STATSIG_ATTR_USER_ID]).toBe('user-123');
    expect(attributes[STATSIG_ATTR_CUSTOM_IDS]).toBe(
      JSON.stringify({ team: 'infra' }),
    );
  });

  it('marks spans as errors when wrapped async functions reject', async () => {
    const wrapped = wrap(
      {
        type: 'workflow',
        name: 'embedding',
      },
      async () => {
        throw new Error('bad news');
      },
    );

    await expect(wrapped()).rejects.toThrow('bad news');

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.name).toBe('gen_ai.workflow');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);

    const attributes = span.attributes as Record<string, unknown>;
    expect(attributes['gen_ai.workflow.name']).toBe('embedding');
    expect(attributes[STATSIG_ATTR_GEN_AI_SPAN_TYPE]).toBe(
      StatsigGenAISpanType.workflow,
    );

    const exceptionEvent = span.events.find(
      (event) => event.name === 'exception',
    );
    expect(exceptionEvent).toBeDefined();
  });

  it('startWorkflow adds llm root attribute and forwards custom attributes', async () => {
    const result = startWorkflow(
      {
        name: 'outer-workflow',
        attributes: { 'env.stage': 'staging' },
      },
      () => 'done',
    );

    expect(result).toBe('done');

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.name).toBe('gen_ai.workflow');

    const attributes = span.attributes as Record<string, unknown>;
    expect(attributes['env.stage']).toBe('staging');
    expect(attributes[STATSIG_ATTR_SPAN_LLM_ROOT]).toBe(
      STATSIG_SPAN_LLM_ROOT_VALUE,
    );
    expect(attributes[STATSIG_ATTR_GEN_AI_SPAN_TYPE]).toBe(
      StatsigGenAISpanType.workflow,
    );
  });
});

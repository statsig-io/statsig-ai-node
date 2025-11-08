import {
  context as otelContext,
  Context,
  trace as otelTrace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { StatsigUser } from '@statsig/statsig-node-core';

import {
  getUserFromContext,
  getUserSpanAttrsFromContext,
  setUserToContext,
  withStatsigUserContext,
} from '../../otel/user-context';
import { StatsigSpanProcessor } from '../../otel/processor';
import {
  STATSIG_ATTR_CUSTOM_IDS,
  STATSIG_ATTR_USER_ID,
} from '../../otel/conventions';

describe('withStatsigUserContext', () => {
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    try {
      otelContext.setGlobalContextManager(contextManager);
    } catch (err) {
      // If a global manager already exists we can safely ignore this.
    }
  });

  afterAll(() => {
    otelContext.disable();
    contextManager.disable();
  });

  it('sets the user context during execution and restores it afterwards', async () => {
    const user = new StatsigUser({
      userID: 'user-context-test',
      customIDs: { team: 'red' },
    });

    expect(getUserFromContext(otelContext.active())).toBeNull();

    const result = await withStatsigUserContext(user, async () => {
      const activeCtx = otelContext.active();
      const contextUser = getUserFromContext(activeCtx);
      expect(contextUser).toEqual({
        userID: 'user-context-test',
        customIDs: { team: 'red' },
      });

      const spanAttrs = getUserSpanAttrsFromContext(activeCtx);
      expect(spanAttrs).toEqual({
        [STATSIG_ATTR_USER_ID]: 'user-context-test',
        [STATSIG_ATTR_CUSTOM_IDS]: JSON.stringify({ team: 'red' }),
      });

      return 'success';
    });

    expect(result).toBe('success');
    expect(getUserFromContext(otelContext.active())).toBeNull();
  });
});

describe('StatsigSpanProcessor', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let exporter: InMemorySpanExporter;
  let processor: StatsigSpanProcessor;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    try {
      otelContext.setGlobalContextManager(contextManager);
    } catch (err) {
      // already set, ignore
    }

    exporter = new InMemorySpanExporter();
    processor = new StatsigSpanProcessor(exporter);
    provider = new BasicTracerProvider({
      spanProcessors: [processor],
    });
  });

  afterAll(async () => {
    await provider.shutdown();
    otelTrace.disable();
    otelContext.disable();
    contextManager.disable();
  });

  afterEach(() => {
    exporter.reset();
  });

  it('adds statsig user metadata from the parent context to spans', async () => {
    const user = new StatsigUser({
      userID: 'span-user',
      customIDs: { org: 'acme' },
    });

    let parentContext: Context = otelContext.active();
    parentContext = setUserToContext(parentContext, user);

    otelContext.with(parentContext, () => {
      const tracer = provider.getTracer('statsig-test');
      const span = tracer.startSpan('test-span');
      span.end();
    });

    await processor.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const span = spans[0];

    expect(span.attributes[STATSIG_ATTR_USER_ID]).toBe('span-user');
    expect(span.attributes[STATSIG_ATTR_CUSTOM_IDS]).toBe(
      JSON.stringify({ org: 'acme' }),
    );
  });

  it('does not set metadata when no user context is provided', async () => {
    const tracer = provider.getTracer('statsig-test-missing-user');
    const span = tracer.startSpan('test-span-no-user');
    span.end();

    await processor.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const recorded = spans.find((sp) => sp.name === 'test-span-no-user');
    expect(recorded).toBeDefined();

    expect(recorded?.attributes[STATSIG_ATTR_USER_ID]).toBeUndefined();
    expect(recorded?.attributes[STATSIG_ATTR_CUSTOM_IDS]).toBeUndefined();
  });
});

import { context as otelContext, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { StatsigOptions, StatsigUser } from '@statsig/statsig-node-core';
import fs from 'fs';

import { StatsigAI } from '../..';
import {
  STATSIG_ATTR_ACTIVITY_ID,
  STATSIG_ATTR_CUSTOM_IDS,
  STATSIG_ATTR_GEN_AI_SPAN_TYPE,
  STATSIG_ATTR_SPAN_LLM_ROOT,
  STATSIG_ATTR_SPAN_TYPE,
  STATSIG_ATTR_USER_ID,
  STATSIG_SPAN_LLM_ROOT_VALUE,
  StatsigGenAISpanType,
  StatsigSpanType,
} from '../../otel/conventions';
import { OtelSingleton } from '../../otel/singleton';
import { startWorkflow, wrap } from '../../wrappers/wrap-call';
import { MockScrapi } from '../shared/MockScrapi';
import { getDCSFilePath } from '../shared/utils';

describe('wrap-call', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let scrapi: MockScrapi;
  let options: StatsigOptions;
  const sdkKey = 'secret-test-key';

  beforeAll(async () => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    try {
      otelContext.setGlobalContextManager(contextManager);
    } catch (err) {
      // ignore if already set
    }

    scrapi = await MockScrapi.create();
    const dcs = fs.readFileSync(getDCSFilePath('eval_proj_dcs.json'), 'utf8');
    scrapi.mock('/v2/download_config_specs', dcs, {
      status: 200,
      method: 'GET',
    });
    scrapi.mock('/v1/log_event', '{"success": true}', {
      status: 202,
      method: 'POST',
    });
    options = {
      specsUrl: scrapi.getUrlForPath('/v2/download_config_specs'),
      logEventUrl: scrapi.getUrlForPath('/v1/log_event'),
    };
  });

  afterAll(() => {
    otelContext.disable();
    contextManager.disable();
    scrapi.close();
  });

  beforeEach(async () => {
    scrapi.clearRequests();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    OtelSingleton.__reset();
    OtelSingleton.instantiate({ tracerProvider: provider });

    StatsigAI.newShared({
      sdkKey,
      statsigOptions: options,
    });
    await StatsigAI.shared().initialize();
  });

  afterEach(async () => {
    await provider.forceFlush();
    await provider.shutdown();
    exporter.reset();
    OtelSingleton.__reset();

    if (StatsigAI.hasShared()) {
      await StatsigAI.shared().shutdown();
      StatsigAI.removeSharedInstance();
    }
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
    expect(span.name).toBe('execute_tool');
    expect(span.status.code).toBe(SpanStatusCode.OK);

    const attributes = span.attributes as Record<string, unknown>;
    expect(attributes[STATSIG_ATTR_SPAN_TYPE]).toBe(StatsigSpanType.gen_ai);
    expect(attributes[STATSIG_ATTR_GEN_AI_SPAN_TYPE]).toBe(
      StatsigGenAISpanType.tool,
    );
    expect(attributes['statsig.gen_ai.tool.name']).toBe('search');
    expect(attributes['gen_ai.tool.type']).toBe('retrieval');
    expect(attributes['custom.attr']).toBe('provided');
    expect(attributes[STATSIG_ATTR_USER_ID]).toBe('user-123');
    expect(attributes[STATSIG_ATTR_CUSTOM_IDS]).toBe(
      JSON.stringify({ team: 'infra' }),
    );

    await StatsigAI.shared().flushEvents();
    const genAIEvents = scrapi.getLoggedEvents('statsig::gen_ai');
    expect(genAIEvents.length).toBeGreaterThanOrEqual(1);

    const event = genAIEvents[0];
    expect(event.eventName).toBe('statsig::gen_ai');
    expect(event.value).toBe('execute_tool');
    expect(event.metadata['statsig.gen_ai.tool.name']).toBe('search');
    expect(event.metadata['gen_ai.tool.type']).toBe('retrieval');
    expect(event.metadata['custom.attr']).toBe('provided');
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
    expect(span.name).toBe('invoke_workflow');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);

    const attributes = span.attributes as Record<string, unknown>;
    expect(attributes['statsig.gen_ai.workflow.name']).toBe('embedding');
    expect(attributes[STATSIG_ATTR_GEN_AI_SPAN_TYPE]).toBe(
      StatsigGenAISpanType.workflow,
    );

    const exceptionEvent = span.events.find(
      (event) => event.name === 'exception',
    );
    expect(exceptionEvent).toBeDefined();

    await StatsigAI.shared().flushEvents();
    const genAIEvents = scrapi.getLoggedEvents('statsig::gen_ai');
    expect(genAIEvents.length).toBeGreaterThanOrEqual(1);

    const event = genAIEvents[0];
    expect(event.eventName).toBe('statsig::gen_ai');
    expect(event.value).toBe('invoke_workflow');
    expect(event.metadata['statsig.gen_ai.workflow.name']).toBe('embedding');
    expect(event.metadata['span.status_code']).toBe('ERROR');
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
    expect(span.name).toBe('invoke_workflow');

    const attributes = span.attributes as Record<string, unknown>;
    expect(attributes['env.stage']).toBe('staging');
    expect(attributes[STATSIG_ATTR_SPAN_LLM_ROOT]).toBe(
      STATSIG_SPAN_LLM_ROOT_VALUE,
    );
    expect(attributes[STATSIG_ATTR_GEN_AI_SPAN_TYPE]).toBe(
      StatsigGenAISpanType.workflow,
    );

    await StatsigAI.shared().flushEvents();
    const genAIEvents = scrapi.getLoggedEvents('statsig::gen_ai');
    expect(genAIEvents.length).toBeGreaterThanOrEqual(1);

    const event = genAIEvents[0];
    expect(event.eventName).toBe('statsig::gen_ai');
    expect(event.value).toBe('invoke_workflow');
    expect(event.metadata['statsig.gen_ai.workflow.name']).toBe(
      'outer-workflow',
    );
    expect(event.metadata['env.stage']).toBe('staging');
  });

  describe('Statsig context propagation', () => {
    it('sets statsig context with user and activityID', async () => {
      const user = new StatsigUser({
        userID: 'test-user-123',
        customIDs: { sessionID: 'session-456' },
      });
      const activityID = 'activity-789';

      const wrapped = wrap(
        {
          type: 'tool',
          name: 'test-tool',
          user,
          activityID,
        },
        () => 'success',
      );

      expect(wrapped()).toBe('success');

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.name).toBe('execute_tool');
      expect(span.status.code).toBe(SpanStatusCode.OK);

      const attributes = span.attributes as Record<string, unknown>;
      expect(attributes[STATSIG_ATTR_USER_ID]).toBe('test-user-123');
      expect(attributes[STATSIG_ATTR_CUSTOM_IDS]).toBe(
        JSON.stringify({
          sessionID: 'session-456',
          [STATSIG_ATTR_ACTIVITY_ID]: activityID,
        }),
      );
    });

    it('sets statsig context with only activityID when user is not provided', async () => {
      const activityID = 'activity-only-123';

      const wrapped = wrap(
        {
          type: 'workflow',
          name: 'test-workflow',
          activityID,
        },
        () => 'done',
      );

      expect(wrapped()).toBe('done');

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.name).toBe('invoke_workflow');
      expect(span.status.code).toBe(SpanStatusCode.OK);

      const attributes = span.attributes as Record<string, unknown>;

      expect(attributes[STATSIG_ATTR_USER_ID]).toBeUndefined();
      expect(attributes[STATSIG_ATTR_CUSTOM_IDS]).toBeDefined();

      expect(attributes[STATSIG_ATTR_CUSTOM_IDS]).toBe(
        JSON.stringify({ [STATSIG_ATTR_ACTIVITY_ID]: activityID }),
      );
    });

    it('sets statsig context with only user when activityID is not provided', async () => {
      const user = new StatsigUser({
        userID: 'user-only-456',
      });

      const wrapped = wrap(
        {
          type: 'tool',
          name: 'test-tool',
          user,
        },
        () => 'result',
      );

      expect(wrapped()).toBe('result');

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.name).toBe('execute_tool');
      expect(span.status.code).toBe(SpanStatusCode.OK);

      const attributes = span.attributes as Record<string, unknown>;
      expect(attributes[STATSIG_ATTR_USER_ID]).toBe('user-only-456');
      expect(attributes[STATSIG_ATTR_ACTIVITY_ID]).toBeUndefined();
    });

    it('propagates statsig context in async wrapped functions', async () => {
      const user = new StatsigUser({
        userID: 'async-user-789',
      });
      const activityID = 'async-activity-999';

      const wrapped = wrap(
        {
          type: 'workflow',
          name: 'async-workflow',
          user,
          activityID,
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 'async-result';
        },
      );

      const result = await wrapped();
      expect(result).toBe('async-result');

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0];

      expect(span.name).toBe('invoke_workflow');
      expect(span.status.code).toBe(SpanStatusCode.OK);

      const attributes = span.attributes as Record<string, unknown>;
      expect(attributes[STATSIG_ATTR_USER_ID]).toBe('async-user-789');

      expect(attributes[STATSIG_ATTR_CUSTOM_IDS]).toBe(
        JSON.stringify({ [STATSIG_ATTR_ACTIVITY_ID]: 'async-activity-999' }),
      );
    });
  });
});

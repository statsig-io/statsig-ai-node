import { context as otelContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { StatsigOptions, StatsigUser } from '@statsig/statsig-node-core';
import fs from 'fs';
import { StatsigAI } from '../..';
import { STATSIG_ATTR_ACTIVITY_ID } from '../../otel/conventions';
import { OtelSingleton } from '../../otel/singleton';
import { startWorkflow } from '../../wrappers/wrap-call';
import { MockScrapi } from '../shared/MockScrapi';
import { getDCSFilePath } from '../shared/utils';

describe('Logging', () => {
  let statsigAI: StatsigAI;
  let scrapi: MockScrapi;
  let options: StatsigOptions;
  const sdkKey = 'secret-test-key';

  beforeAll(async () => {
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

  beforeEach(async () => {
    scrapi.clearRequests();
    statsigAI = new StatsigAI({
      sdkKey: sdkKey,
      statsigOptions: options,
    });
    await statsigAI.initialize();
  });

  afterEach(async () => {
    await statsigAI.shutdown();
  });

  afterAll(() => {
    scrapi.close();
  });

  describe('logAIGradingResult', () => {
    it('should log a grading result', async () => {
      const user = new StatsigUser({ userID: 'test-user' });
      const prompt = statsigAI.getPrompt(user, 'test_prompt');
      const promptVersion = prompt.getLive();
      statsigAI.logEvalGrade(user, promptVersion, 0.5, 'test-grader-name', {
        sessionId: 'test-session-id',
        activityId: 'test-activity-id',
        metadata: {
          test: 'test',
        },
      });
      await statsigAI.flushEvents();
      const logEventRequests = scrapi
        .getLoggedEvents()
        .filter((event) => event.eventName === 'statsig::eval_result');
      const event = logEventRequests[0];

      expect(event.metadata.version_name).toBe('Version 1');
      expect(event.metadata.version_id).toBe('6KGzeo8TR9JTL7CZl7vccd');
      expect(event.metadata.score).toBe('0.5');
      expect(event.metadata.session_id).toBe('test-session-id');
      expect(event.metadata.ai_config_name).toBe('test_prompt');
      expect(event.metadata.grader_name).toBe('test-grader-name');
      expect(event.metadata.test).toBe('test');
      expect(event.metadata.is_live).toBe('true');
      expect(event.metadata.source).toBe('sdk');
      expect(event.metadata.trace_id).toBeUndefined();
      expect(event.metadata.span_id).toBeUndefined();
      expect(event.metadata.reasoning).toBeUndefined();
      expect(event.user.customIDs).toMatchObject({
        [STATSIG_ATTR_ACTIVITY_ID]: 'test-activity-id',
      });
    });

    describe('trace and span IDs', () => {
      let contextManager: AsyncLocalStorageContextManager;
      let exporter: InMemorySpanExporter;
      let provider: BasicTracerProvider;

      beforeAll(() => {
        contextManager = new AsyncLocalStorageContextManager();
        contextManager.enable();
        otelContext.setGlobalContextManager(contextManager);
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
        await provider.shutdown();
        OtelSingleton.__reset();
      });

      it('uses the active span by default and explicit IDs when given', async () => {
        const user = new StatsigUser({ userID: 'test-user' });
        const promptVersion = statsigAI
          .getPrompt(user, 'test_prompt')
          .getLive();

        startWorkflow({ name: 'graded-call' }, () => {
          statsigAI.logEvalGrade(user, promptVersion, 1, 'in-span', {});
          statsigAI.logEvalGrade(user, promptVersion, 1, 'in-span-override', {
            traceId: 'explicit-trace',
          });
        });
        statsigAI.logEvalGrade(user, promptVersion, 0, 'later', {
          traceId: 'later-trace',
          spanId: 'later-span',
          reasoning: 'user thumbs down',
        });
        await statsigAI.flushEvents();

        const [workflowSpan] = exporter.getFinishedSpans();
        const { traceId, spanId } = workflowSpan.spanContext();
        const metadataByGrader = Object.fromEntries(
          scrapi
            .getLoggedEvents('statsig::eval_result')
            .map((event) => [event.metadata.grader_name, event.metadata]),
        );

        expect(metadataByGrader['in-span']).toMatchObject({
          trace_id: traceId,
          span_id: spanId,
          source: 'sdk',
        });
        expect(metadataByGrader['in-span-override'].trace_id).toBe(
          'explicit-trace',
        );
        expect(metadataByGrader['in-span-override'].span_id).toBeUndefined();
        expect(metadataByGrader['later']).toMatchObject({
          trace_id: 'later-trace',
          span_id: 'later-span',
          reasoning: 'user thumbs down',
          source: 'sdk',
        });
      });
    });
  });
});

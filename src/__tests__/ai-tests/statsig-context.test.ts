import fs from 'fs';
import OpenAI from 'openai';
import { initializeTracing, StatsigAI } from '../../index';
import { StatsigOptions, StatsigUser } from '@statsig/statsig-node-core';
import { wrapOpenAI } from '../../wrappers/openai';
import { MockScrapi } from '../shared/MockScrapi';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  getDCSFilePath,
  validateOtelClientSpanBasics,
  getSpanAttributesMap,
} from '../shared/utils';
import { withStatsigContext } from '../../otel/statsig-context';
import { OPENAI_TEST_MODEL, OPENAI_TEST_EMBEDDING_MODEL } from './models';

describe('Statsig Context with Activity ID', () => {
  let scrapi: MockScrapi;
  let options: StatsigOptions;
  let provider: BasicTracerProvider;
  let openai: OpenAI;
  let client: any;

  beforeAll(async () => {
    scrapi = await MockScrapi.create();
    const dcs = fs.readFileSync(getDCSFilePath('eval_proj_dcs.json'), 'utf8');
    scrapi.mock('/otlp/v1/traces', '{"success": true}', {
      status: 202,
      method: 'POST',
    });
    scrapi.mock('/v2/download_config_specs', dcs, {
      status: 200,
      method: 'GET',
    });

    scrapi.mock('/v1/log_event', '{"success": true}', {
      status: 202,
      method: 'POST',
    });

    const { provider: resultingProvider } = initializeTracing({
      exporterOptions: {
        dsn: scrapi.getUrlForPath('/otlp'),
        sdkKey: 'secret-test-key',
      },
      serviceName: 'statsig-context-test',
      version: '1.0.0-test',
      environment: 'test',
    });
    provider = resultingProvider;
    options = {
      specsUrl: scrapi.getUrlForPath('/v2/download_config_specs'),
      logEventUrl: scrapi.getUrlForPath('/v1/log_event'),
    };

    openai = new OpenAI();
    client = wrapOpenAI(openai);
  });

  beforeEach(async () => {
    StatsigAI.newShared({
      sdkKey: 'secret-test-key',
      statsigOptions: options,
    });
    await StatsigAI.shared().initialize();
  });

  afterAll(async () => {
    scrapi.close();
    await provider.shutdown();
  });

  afterEach(async () => {
    scrapi.clearRequests();
    if (StatsigAI.hasShared()) {
      await StatsigAI.shared().shutdown();
      StatsigAI.removeSharedInstance();
    }
  });

  describe('Activity ID propagation', () => {
    it('should attach activity ID to chat completion span and event', async () => {
      const activityID = 'test-activity-123';
      const user = new StatsigUser({
        userID: 'test-user-456',
        customIDs: { orgID: 'test-org-789' },
      });

      await withStatsigContext({ activityID, user }, async () => {
        await chatCompletionMethod(client);
      });

      await validateActivityIDInTraceAndEvent({
        scrapi,
        expectedActivityID: activityID,
        expectedUserID: 'test-user-456',
        expectedCustomIDs: { orgID: 'test-org-789' },
        spanName: `chat ${OPENAI_TEST_MODEL}`,
      });
    });

    it('should attach activity ID to embedding span and event', async () => {
      const activityID = 'test-activity-embedding-456';
      const user = new StatsigUser({
        userID: 'embedding-user-123',
        customIDs: { sessionID: 'session-abc' },
      });

      await withStatsigContext({ activityID, user }, async () => {
        await embeddingMethod(client);
      });

      await validateActivityIDInTraceAndEvent({
        scrapi,
        expectedActivityID: activityID,
        expectedUserID: 'embedding-user-123',
        expectedCustomIDs: { sessionID: 'session-abc' },
        spanName: `embeddings ${OPENAI_TEST_EMBEDDING_MODEL}`,
      });
    });

    it('should attach only activity ID when user is not provided', async () => {
      const activityID = 'test-activity-only-789';

      await withStatsigContext({ activityID }, async () => {
        await chatCompletionMethod(client);
      });

      await StatsigAI.shared().flushEvents();

      const traceRequests = scrapi.getOtelRequests();
      expect(traceRequests.length).toBeGreaterThan(0);
      const span = validateOtelClientSpanBasics(
        traceRequests,
        `chat ${OPENAI_TEST_MODEL}`,
      );
      const attrs = getSpanAttributesMap(span);

      expect(attrs['statsig.activity_id']).toBeDefined();
      expect(attrs['statsig.activity_id'].stringValue).toBe(activityID);

      expect(attrs['statsig.user_id']).toBeUndefined();
      expect(attrs['statsig.custom_ids']).toBeUndefined();

      const events = scrapi.getLoggedEvents('statsig::gen_ai');
      expect(events.length).toBeGreaterThan(0);
      const meta = events[0].metadata;

      expect(meta['statsig.activity_id']).toBe(activityID);
      expect(meta['statsig.user_id']).toBeUndefined();
      expect(meta['statsig.custom_ids']).toBeUndefined();
    });

    it('should handle multiple operations in separate contexts with same activity ID', async () => {
      const activityID = 'multi-op-activity-999';
      const user = new StatsigUser({
        userID: 'multi-op-user',
      });

      await withStatsigContext({ activityID, user }, async () => {
        await chatCompletionMethod(client);
      });

      await withStatsigContext({ activityID, user }, async () => {
        await embeddingMethod(client);
      });

      await StatsigAI.shared().flushEvents();

      const traceRequests = scrapi.getOtelRequests();
      expect(traceRequests.length).toBeGreaterThan(0);

      // Collect all spans across all trace requests
      const allSpans: any[] = [];
      traceRequests.forEach((req: any) => {
        const resourceSpans = req.body?.resourceSpans || [];
        resourceSpans.forEach((rs: any) => {
          const scopeSpans = rs?.scopeSpans || [];
          scopeSpans.forEach((ss: any) => {
            const spans = ss?.spans || [];
            allSpans.push(...spans);
          });
        });
      });

      expect(allSpans.length).toBeGreaterThanOrEqual(2);

      allSpans.forEach((span: any) => {
        const attrs = getSpanAttributesMap(span);
        expect(attrs['statsig.activity_id']).toBeDefined();
        expect(attrs['statsig.activity_id'].stringValue).toBe(activityID);
        expect(attrs['statsig.user_id']).toBeDefined();
        expect(attrs['statsig.user_id'].stringValue).toBe('multi-op-user');
      });

      const events = scrapi.getLoggedEvents('statsig::gen_ai');
      expect(events.length).toBeGreaterThanOrEqual(2);
      events.forEach((event: any) => {
        expect(event.metadata['statsig.activity_id']).toBe(activityID);
        expect(event.metadata['statsig.user_id']).toBe('multi-op-user');
      });
    });
  });
});

async function chatCompletionMethod(client: any): Promise<any> {
  return await client.chat.completions.create({
    model: OPENAI_TEST_MODEL,
    messages: [{ role: 'user', content: 'Test message for activity tracking' }],
    temperature: 0.7,
    max_tokens: 50,
  });
}

async function embeddingMethod(client: any): Promise<any> {
  return await client.embeddings.create({
    model: OPENAI_TEST_EMBEDDING_MODEL,
    input: 'Test embedding for activity tracking',
    encoding_format: 'float',
    dimensions: 1536,
  });
}

async function validateActivityIDInTraceAndEvent({
  scrapi,
  expectedActivityID,
  expectedUserID,
  expectedCustomIDs,
  spanName,
}: {
  scrapi: MockScrapi;
  expectedActivityID: string;
  expectedUserID: string;
  expectedCustomIDs: Record<string, string>;
  spanName: string;
}) {
  await StatsigAI.shared().flushEvents();

  const traceRequests = scrapi.getOtelRequests();
  expect(traceRequests.length).toBeGreaterThan(0);
  const span = validateOtelClientSpanBasics(traceRequests, spanName);
  const attrs = getSpanAttributesMap(span);

  expect(attrs['statsig.activity_id']).toBeDefined();
  expect(attrs['statsig.activity_id'].stringValue).toBe(expectedActivityID);

  expect(attrs['statsig.user_id']).toBeDefined();
  expect(attrs['statsig.user_id'].stringValue).toBe(expectedUserID);

  expect(attrs['statsig.custom_ids']).toBeDefined();
  expect(attrs['statsig.custom_ids'].stringValue).toBe(
    JSON.stringify(expectedCustomIDs),
  );

  const events = scrapi.getLoggedEvents('statsig::gen_ai');
  expect(events.length).toBeGreaterThan(0);
  const meta = events[0].metadata;

  expect(meta['statsig.activity_id']).toBe(expectedActivityID);
  expect(meta['statsig.user_id']).toBe(expectedUserID);
  expect(meta['statsig.custom_ids']).toBe(JSON.stringify(expectedCustomIDs));
}

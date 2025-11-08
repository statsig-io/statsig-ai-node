import fs from 'fs';
import OpenAI from 'openai';
import { initializeTracing, StatsigAI } from '../../index';
import { StatsigOptions } from '@statsig/statsig-node-core';
import { wrapOpenAI } from '../../wrappers/openai';
import { OpenAILike } from '../../wrappers/openai-configs';
import { MockScrapi } from '../shared/MockScrapi';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { STATSIG_ATTR_SPAN_TYPE } from '../../otel/conventions';
import { getDCSFilePath } from '../shared/utils';

const TEST_MODEL = 'gpt-4.1-nano';

describe('OpenAI Wrapper with Statsig Tracing', () => {
  let scrapi: MockScrapi;
  let options: StatsigOptions;
  let provider: BasicTracerProvider;

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
      serviceName: 'statsig-ai-test',
      version: '1.0.0-test',
      environment: 'test',
    });
    provider = resultingProvider;
    options = {
      specsUrl: scrapi.getUrlForPath('/v2/download_config_specs'),
      logEventUrl: scrapi.getUrlForPath('/v1/log_event'),
    };
  });

  afterAll(() => {
    scrapi.close();
  });

  afterEach(async () => {
    scrapi.clearRequests();
    if (StatsigAI.hasShared()) {
      await StatsigAI.shared().shutdown();
      StatsigAI.removeSharedInstance();
    }
  });

  it('openai.chat.completions.create', async () => {
    const openai = new OpenAI();
    StatsigAI.newShared({
      sdkKey: 'secret-test-key',
      statsigOptions: options,
    });
    await StatsigAI.shared().initialize();
    const client = wrapOpenAI(openai, {
      captureOptions: {
        capture_input_messages: true,
      },
    });
    const spanName = `chat ${TEST_MODEL}`;

    const start = Date.now();
    const response = await client.chat.completions.create({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'What is a feature flag?' }],
      temperature: 0.7,
      max_tokens: 100,
    });
    const expectedDuration = Date.now() - start;

    expect(response).toBeDefined();

    await provider.forceFlush();
    await StatsigAI.shared().flushEvents();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const traceRequests = scrapi.getOtelRequests();
    expect(traceRequests.length).toBeGreaterThan(0);

    const genAiEvents = scrapi.getLoggedEvents('statsig::gen_ai');
    expect(genAiEvents.length).toBeGreaterThan(0);

    const genAIEvent = genAiEvents[0];
    expect(genAIEvent.value).toBe(spanName);

    const genAIEventMetadata = genAIEvent?.metadata;

    const resourceSpans = traceRequests[0].body?.resourceSpans || [];
    expect(resourceSpans.length).toBeGreaterThan(0);

    const resourceSpan = resourceSpans[0];

    // Validate Resource structure
    expect(resourceSpan.resource).toBeDefined();
    expect(resourceSpan.resource.attributes).toBeDefined();
    expect(Array.isArray(resourceSpan.resource.attributes)).toBe(true);

    // Check for required resource attributes
    const resourceAttrs = resourceSpan.resource.attributes;
    const resourceAttrKeys = resourceAttrs.map((attr: any) => attr.key);

    // Check for required resource attributes
    const expectedResourceAttrs = [
      'service.name',
      'service.version',
      'environment',
    ];

    expectedResourceAttrs.forEach((attrName) => {
      expect(resourceAttrKeys).toContain(attrName);
    });

    // Validate ScopeSpans structure
    expect(resourceSpan.scopeSpans).toBeDefined();
    expect(Array.isArray(resourceSpan.scopeSpans)).toBe(true);
    expect(resourceSpan.scopeSpans.length).toBeGreaterThan(0);

    const scopeSpan = resourceSpan.scopeSpans[0];
    expect(scopeSpan.scope).toBeDefined();
    expect(scopeSpan.scope.name).toBe('statsig-openai-proxy');

    // Validate Spans array
    expect(scopeSpan.spans).toBeDefined();
    expect(Array.isArray(scopeSpan.spans)).toBe(true);
    expect(scopeSpan.spans.length).toBeGreaterThan(0);

    const span = scopeSpan.spans[0];

    // Validate span metadata
    expect(span.traceId).toBeDefined();
    expect(span.spanId).toBeDefined();
    expect(span.name).toBe(spanName);
    expect(span.kind).toBe(3); // SPAN_KIND_CLIENT
    expect(span.startTimeUnixNano).toBeDefined();
    expect(span.endTimeUnixNano).toBeDefined();
    expect(span.status).toBeDefined();
    expect(span.status.code).toBe(1); // STATUS_CODE_OK

    const spanAttrs = span.attributes;
    const spanAttrMap = spanAttrs.reduce((acc: any, attr: any) => {
      acc[attr.key] = attr.value;
      return acc;
    }, {});

    // -- Base & Request attributes --
    expect(genAIEventMetadata['gen_ai.provider.name']).toEqual('openai');
    expect(spanAttrMap['gen_ai.provider.name'].stringValue).toBe('openai');

    expect(genAIEventMetadata['gen_ai.operation.name']).toEqual('chat');
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe('chat');

    expect(genAIEventMetadata['gen_ai.request.model']).toEqual(TEST_MODEL);
    expect(spanAttrMap['gen_ai.request.model'].stringValue).toBe(TEST_MODEL);

    expect(genAIEventMetadata['gen_ai.request.temperature']).toEqual('0.7');
    expect(spanAttrMap['gen_ai.request.temperature'].doubleValue).toBe(0.7);

    expect(genAIEventMetadata['gen_ai.request.max_tokens']).toEqual('100');
    expect(spanAttrMap['gen_ai.request.max_tokens'].intValue).toBe(100);

    expect(genAIEventMetadata['gen_ai.input.messages']).toEqual(
      JSON.stringify([{ role: 'user', content: 'What is a feature flag?' }]),
    );
    expect(spanAttrMap['gen_ai.input.messages'].stringValue).toEqual(
      JSON.stringify([{ role: 'user', content: 'What is a feature flag?' }]),
    );

    // -- Response attributes --
    expect(genAIEventMetadata['gen_ai.response.model']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.model']).toBeDefined();
    expect(genAIEventMetadata['gen_ai.response.id']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.id']).toBeDefined();
    expect(genAIEventMetadata['gen_ai.response.finish_reasons']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.finish_reasons']).toBeDefined();

    // -- Usage attributes --
    expect(genAIEventMetadata['gen_ai.usage.input_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.input_tokens']).toBeDefined();
    expect(genAIEventMetadata['gen_ai.usage.output_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.output_tokens']).toBeDefined();

    expectBeWithin(
      parseInt(genAIEventMetadata['gen_ai.server.time_to_first_token']),
      expectedDuration - 10,
      expectedDuration + 10,
    );
    expectBeWithin(
      spanAttrMap['gen_ai.server.time_to_first_token'].intValue,
      expectedDuration - 10,
      expectedDuration + 10,
    );

    // Span metadata also appears on event metadata
    expect(genAIEventMetadata['span.name']).toBe(spanName);
    expect(genAIEventMetadata['span.span_id']).toBeDefined();
    expect(genAIEventMetadata['span.trace_id']).toBeDefined();
    expect(genAIEventMetadata['span.status_code']).toBeDefined();
  });
  //   StatsigAI.removeSharedInstance();
  //   const openai = new MockOpenAI();
  //   const wrappedOpenAI = wrapOpenAI(openai as OpenAILike);
  //   const consoleWarnSpy = jest
  //     .spyOn(console, 'warn')
  //     .mockImplementation(() => {});
  //   await wrappedOpenAI.chat.completions.create({
  //     model: 'gpt-4',
  //     messages: [{ role: 'user', content: 'Hello, world!' }],
  //     temperature: 0.7,
  //     max_tokens: 100,
  //   });
  //   expect(consoleWarnSpy).toHaveBeenCalledWith(
  //     expect.stringContaining(
  //       '[Statsig] No shared global StatsigAI instance found. Call StatsigAI.newShared() before invoking OpenAI methods to capture Gen AI telemetry.',
  //     ),
  //   );
  //   consoleWarnSpy.mockRestore();
  //   expect(scrapi.getLoggedEvents().length).toBe(0);

  //   StatsigAI.newShared({
  //     sdkKey: 'secret-test-key',
  //     statsigOptions: options,
  //   });
  //   await StatsigAI.shared().initialize();
  //   await wrappedOpenAI.chat.completions.create({
  //     model: 'gpt-4',
  //     messages: [{ role: 'user', content: 'Hello, world!' }],
  //     temperature: 0.7,
  //     max_tokens: 100,
  //   });
  //   await StatsigAI.shared().flushEvents();
  //   const loggedEvents = scrapi.getLoggedEvents();
  //   const genAiEvents = loggedEvents.filter(
  //     (event) => event.eventName === 'statsig::gen_ai',
  //   );
  //   expect(genAiEvents.length).toBeGreaterThan(0);
  //   const genAIEvent = genAiEvents[0];
  //   expect(genAIEvent.value).toBe('openai.chat.completions.create');
  // });
});

function expectBeWithin(value: number, min: number, max: number) {
  expect(value).toBeGreaterThanOrEqual(min);
  expect(value).toBeLessThanOrEqual(max);
}

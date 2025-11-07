import { DefaultMockResponses, MockOpenAI } from './MockOpenAI';

import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { initializeTracing, StatsigAI } from '../index';
import { StatsigOptions } from '@statsig/statsig-node-core';
import { wrapOpenAI } from '../wrappers/openai';
import { OpenAILike } from '../wrappers/openai-configs';
import { MockScrapi } from './MockScrapi';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { STATSIG_ATTR_SPAN_TYPE } from '../otel/conventions';

describe('OpenAI Wrapper with Statsig Tracing', () => {
  let scrapi: MockScrapi;
  let options: StatsigOptions;
  let provider: BasicTracerProvider;

  beforeAll(async () => {
    scrapi = await MockScrapi.create();
    const dcs = fs.readFileSync(
      path.join(__dirname, 'eval_proj_dcs.json'),
      'utf8',
    );
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

  xit('should wrap OpenAI instance successfully', () => {
    const openai = new MockOpenAI();
    wrapOpenAI(openai as OpenAILike);
    expect(openai).toBeDefined();
    expect(openai.chat).toBeDefined();
    expect(openai.chat?.completions).toBeDefined();
    expect(openai.chat?.completions?.create).toBeDefined();
  });

  it('should send traces and events when calling chat.completions.create', async () => {
    const openai = new MockOpenAI();
    // const openai = new OpenAI();
    StatsigAI.newShared({
      sdkKey: 'secret-test-key',
      statsigOptions: options,
    });
    await StatsigAI.shared().initialize();
    const wrappedOpenAI = wrapOpenAI(openai as OpenAILike);

    const response = await wrappedOpenAI.responses.stream({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hello, world!' }],
      temperature: 0.7,
      max_tokens: 100,
    });

    expect(response).toBeDefined();
    expect(response.choices[0].message.content).toBe(
      DefaultMockResponses.chatCompletion.choices[0].message.content,
    );

    await provider.forceFlush();
    await StatsigAI.shared().flushEvents();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const traceRequests = scrapi.getOtelRequests();
    expect(traceRequests.length).toBeGreaterThan(0);

    const loggedEvents = scrapi.getLoggedEvents();
    const genAiEvents = loggedEvents.filter(
      (event) => event.eventName === 'statsig::gen_ai',
    );
    expect(genAiEvents.length).toBeGreaterThan(0);
    const genAIEvent = genAiEvents[0];
    const genAIEventMetadata = genAIEvent.metadata;

    const traceRequest = traceRequests[0];
    expect(traceRequest.body).toBeDefined();

    const resourceSpans = traceRequest.body?.resourceSpans || [];
    expect(resourceSpans.length).toBeGreaterThan(0);

    const resourceSpan = resourceSpans[0];

    // Validate Resource structure
    expect(resourceSpan.resource).toBeDefined();
    expect(resourceSpan.resource.attributes).toBeDefined();
    expect(Array.isArray(resourceSpan.resource.attributes)).toBe(true);

    // Check for required resource attributes
    const resourceAttrs = resourceSpan.resource.attributes;
    const resourceAttrKeys = resourceAttrs.map((attr: any) => attr.key);

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
    expect(span.name).toBe('openai.chat.completions.create');
    expect(span.kind).toBe(3); // SPAN_KIND_CLIENT
    expect(span.startTimeUnixNano).toBeDefined();
    expect(span.endTimeUnixNano).toBeDefined();
    expect(span.status).toBeDefined();
    expect(span.status.code).toBe(1); // STATUS_CODE_OK

    // Validate span attributes
    expect(span.attributes).toBeDefined();
    expect(Array.isArray(span.attributes)).toBe(true);

    const spanAttrs = span.attributes;
    const spanAttrMap = spanAttrs.reduce((acc: any, attr: any) => {
      acc[attr.key] = attr.value;
      return acc;
    }, {});

    // Required request attributes (present on both event metadata and span)
    expect(genAIEventMetadata['gen_ai.system']).toEqual('openai');
    expect(spanAttrMap['gen_ai.system']).toBeDefined();
    expect(spanAttrMap['gen_ai.system'].stringValue).toBe('openai');

    expect(genAIEventMetadata['gen_ai.operation.name']).toEqual(
      'chat.completions.create',
    );
    expect(spanAttrMap['gen_ai.operation.name']).toBeDefined();
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'chat.completions.create',
    );

    expect(genAIEventMetadata['gen_ai.request.model']).toEqual('gpt-4');

    expect(spanAttrMap[STATSIG_ATTR_SPAN_TYPE]).toBeDefined();
    expect(spanAttrMap[STATSIG_ATTR_SPAN_TYPE].stringValue).toBe('gen_ai');

    expect(spanAttrMap['gen_ai.request.model']).toBeDefined();
    expect(spanAttrMap['gen_ai.request.model'].stringValue).toBe('gpt-4');

    expect(genAIEventMetadata['gen_ai.request.temperature']).toEqual('0.7');
    expect(spanAttrMap['gen_ai.request.temperature']).toBeDefined();
    expect(spanAttrMap['gen_ai.request.temperature'].doubleValue).toBe(0.7);

    expect(genAIEventMetadata['gen_ai.request.max_tokens']).toEqual('100');
    expect(spanAttrMap['gen_ai.request.max_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.request.max_tokens'].intValue).toBe(100);

    expect(genAIEventMetadata['gen_ai.request.stream']).toEqual('false');
    expect(spanAttrMap['gen_ai.request.stream']).toBeDefined();
    expect(spanAttrMap['gen_ai.request.stream'].boolValue).toBe(false);

    expect(genAIEventMetadata['gen_ai.input']).toBeDefined();
    expect(spanAttrMap['gen_ai.input']).toBeDefined();
    expect(spanAttrMap['gen_ai.input'].stringValue).toBeDefined();

    // Required response attributes
    expect(genAIEventMetadata['gen_ai.response.id']).toEqual(
      DefaultMockResponses.chatCompletion.id,
    );
    expect(spanAttrMap['gen_ai.response.id']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.id'].stringValue).toEqual(
      DefaultMockResponses.chatCompletion.id,
    );

    expect(genAIEventMetadata['gen_ai.response.model']).toEqual(
      DefaultMockResponses.chatCompletion.model,
    );
    expect(spanAttrMap['gen_ai.response.model']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.model'].stringValue).toBe(
      DefaultMockResponses.chatCompletion.model,
    );

    expect(genAIEventMetadata['gen_ai.response.created']).toEqual(
      String(DefaultMockResponses.chatCompletion.created),
    );
    expect(spanAttrMap['gen_ai.response.created']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.created'].intValue).toBe(
      DefaultMockResponses.chatCompletion.created,
    );

    expect(genAIEventMetadata['gen_ai.completion.choices_count']).toEqual(
      String(DefaultMockResponses.chatCompletion.choices.length),
    );
    expect(spanAttrMap['gen_ai.completion.choices_count']).toBeDefined();
    expect(spanAttrMap['gen_ai.completion.choices_count'].intValue).toBe(
      DefaultMockResponses.chatCompletion.choices.length,
    );

    expect(genAIEventMetadata['gen_ai.response.finish_reason']).toEqual(
      DefaultMockResponses.chatCompletion.choices[0].finish_reason,
    );
    expect(spanAttrMap['gen_ai.response.finish_reason']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.finish_reason'].stringValue).toEqual(
      DefaultMockResponses.chatCompletion.choices[0].finish_reason,
    );

    expect(genAIEventMetadata['gen_ai.completion']).toEqual(
      DefaultMockResponses.chatCompletion.choices[0].message.content,
    );
    expect(spanAttrMap['gen_ai.completion']).toBeDefined();
    expect(spanAttrMap['gen_ai.completion'].stringValue).toEqual(
      DefaultMockResponses.chatCompletion.choices[0].message.content,
    );

    // Required usage attributes
    expect(genAIEventMetadata['gen_ai.usage.prompt_tokens']).toEqual(
      String(DefaultMockResponses.chatCompletion.usage.prompt_tokens),
    );
    expect(spanAttrMap['gen_ai.usage.prompt_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.prompt_tokens'].intValue).toBe(
      DefaultMockResponses.chatCompletion.usage.prompt_tokens,
    );

    expect(genAIEventMetadata['gen_ai.usage.completion_tokens']).toEqual(
      String(DefaultMockResponses.chatCompletion.usage.completion_tokens),
    );
    expect(spanAttrMap['gen_ai.usage.completion_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.completion_tokens'].intValue).toBe(
      DefaultMockResponses.chatCompletion.usage.completion_tokens,
    );

    expect(genAIEventMetadata['gen_ai.usage.total_tokens']).toEqual(
      String(DefaultMockResponses.chatCompletion.usage.total_tokens),
    );
    expect(spanAttrMap['gen_ai.usage.total_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.total_tokens'].intValue).toBe(
      DefaultMockResponses.chatCompletion.usage.total_tokens,
    );

    expect(
      parseInt(genAIEventMetadata['gen_ai.metrics.time_to_first_token_ms']),
    ).toBeGreaterThan(0);
    expect(spanAttrMap['gen_ai.metrics.time_to_first_token_ms']).toBeDefined();
    expect(
      spanAttrMap['gen_ai.metrics.time_to_first_token_ms'].intValue,
    ).toBeGreaterThan(0);

    // Span metadata also appears on event metadata
    expect(genAIEventMetadata['span.name']).toBe(
      'openai.chat.completions.create',
    );
    expect(genAIEventMetadata['span.span_id']).toBeDefined();
    expect(genAIEventMetadata['span.trace_id']).toBeDefined();
    expect(genAIEventMetadata['span.status_code']).toBeDefined();

    // Event value is the sanitized span name
    expect(genAIEvent.value).toBe('openai.chat.completions.create');
  });

  xit('sends events when global statsig is created after the wrapper is created', async () => {
    StatsigAI.removeSharedInstance();
    const openai = new MockOpenAI();
    const wrappedOpenAI = wrapOpenAI(openai as OpenAILike);
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    await wrappedOpenAI.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello, world!' }],
      temperature: 0.7,
      max_tokens: 100,
    });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[Statsig] No shared global StatsigAI instance found. Call StatsigAI.newShared() before invoking OpenAI methods to capture Gen AI telemetry.',
      ),
    );
    consoleWarnSpy.mockRestore();
    expect(scrapi.getLoggedEvents().length).toBe(0);

    StatsigAI.newShared({
      sdkKey: 'secret-test-key',
      statsigOptions: options,
    });
    await StatsigAI.shared().initialize();
    await wrappedOpenAI.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello, world!' }],
      temperature: 0.7,
      max_tokens: 100,
    });
    await StatsigAI.shared().flushEvents();
    const loggedEvents = scrapi.getLoggedEvents();
    const genAiEvents = loggedEvents.filter(
      (event) => event.eventName === 'statsig::gen_ai',
    );
    expect(genAiEvents.length).toBeGreaterThan(0);
    const genAIEvent = genAiEvents[0];
    expect(genAIEvent.value).toBe('openai.chat.completions.create');
  });
});

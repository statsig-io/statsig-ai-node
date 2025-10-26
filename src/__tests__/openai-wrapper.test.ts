import * as otelModule from '../otel/otel';

import { DefaultMockResponses, MockOpenAI } from './MockOpenAI';

import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { StatsigAI } from '..';
import { StatsigOptions } from '@statsig/statsig-node-core';
import { wrapOpenAI } from '../wrappers/openai';
import { OpenAILike } from '../wrappers/openai-configs';
import { MockScrapi } from './MockScrapi';

describe('OpenAI Wrapper with Statsig Tracing', () => {
  let statsigAI: StatsigAI;
  let scrapi: MockScrapi;
  let openai: Partial<OpenAI>;
  let wrappedOpenAI: OpenAILike;
  let options: StatsigOptions;

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

    openai = new MockOpenAI();
    wrappedOpenAI = wrapOpenAI(openai as OpenAILike);
    jest
      .spyOn(otelModule, 'createExporterOptions')
      .mockImplementation((endpoint: string, sdkKey: string) => ({
        url: scrapi.getUrlForPath('/otlp' + endpoint),
        headers: { 'statsig-api-key': sdkKey },
      }));
    options = {
      specsUrl: scrapi.getUrlForPath('/v2/download_config_specs'),
      logEventUrl: scrapi.getUrlForPath('/v1/log_event'),
    };
  });

  afterAll(() => {
    scrapi.close();
  });

  afterEach(async () => {
    if (statsigAI) {
      await statsigAI.shutdown();
    }
  });

  it('should wrap OpenAI instance successfully', () => {
    expect(openai).toBeDefined();
    expect(openai.chat).toBeDefined();
    expect(openai.chat?.completions).toBeDefined();
    expect(openai.chat?.completions?.create).toBeDefined();
  });

  it('should send traces when calling chat.completions.create', async () => {
    statsigAI = new StatsigAI(
      {
        sdkKey: 'secret-test-key',
        statsigOptions: options,
      },
      {
        enableDefaultOtel: true,
      },
    );
    await statsigAI.initialize();

    const response = await wrappedOpenAI.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello, world!' }],
      temperature: 0.7,
      max_tokens: 100,
    });

    expect(response).toBeDefined();
    expect(response.choices[0].message.content).toBe(
      DefaultMockResponses.chatCompletion.choices[0].message.content,
    );

    await statsigAI.flushEvents();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const traceRequests = scrapi.getOtelRequests();
    expect(traceRequests.length).toBeGreaterThan(0);

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

    // These are standard OpenTelemetry resource attributes
    const expectedResourceAttrs = [
      'service.name',
      'process.runtime.name',
      'process.runtime.version',
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

    // Required request attributes
    expect(spanAttrMap['gen_ai.system']).toBeDefined();
    expect(spanAttrMap['gen_ai.system'].stringValue).toBe('openai');

    expect(spanAttrMap['gen_ai.operation.name']).toBeDefined();
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'chat.completions.create',
    );

    expect(spanAttrMap['gen_ai.request.model']).toBeDefined();
    expect(spanAttrMap['gen_ai.request.model'].stringValue).toBe('gpt-4');

    expect(spanAttrMap['gen_ai.request.temperature']).toBeDefined();
    expect(spanAttrMap['gen_ai.request.temperature'].doubleValue).toBe(0.7);

    expect(spanAttrMap['gen_ai.request.max_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.request.max_tokens'].intValue).toBe(100);

    expect(spanAttrMap['gen_ai.request.stream']).toBeDefined();
    expect(spanAttrMap['gen_ai.request.stream'].boolValue).toBe(false);

    expect(spanAttrMap['gen_ai.input']).toBeDefined();
    expect(spanAttrMap['gen_ai.input'].stringValue).toBeDefined();

    // Required response attributes
    expect(spanAttrMap['gen_ai.response.id']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.id'].stringValue).toBeDefined();

    expect(spanAttrMap['gen_ai.response.model']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.model'].stringValue).toBe('gpt-4');

    expect(spanAttrMap['gen_ai.response.created']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.created'].intValue).toBeDefined();

    expect(spanAttrMap['gen_ai.completion.choices_count']).toBeDefined();
    expect(spanAttrMap['gen_ai.completion.choices_count'].intValue).toBe(1);

    expect(spanAttrMap['gen_ai.response.finish_reason']).toBeDefined();
    expect(
      spanAttrMap['gen_ai.response.finish_reason'].stringValue,
    ).toBeDefined();

    expect(spanAttrMap['gen_ai.completion']).toBeDefined();
    expect(spanAttrMap['gen_ai.completion'].stringValue).toBeDefined();

    // Required usage attributes
    expect(spanAttrMap['gen_ai.usage.prompt_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.prompt_tokens'].intValue).toBeGreaterThan(
      0,
    );

    expect(spanAttrMap['gen_ai.usage.completion_tokens']).toBeDefined();
    expect(
      spanAttrMap['gen_ai.usage.completion_tokens'].intValue,
    ).toBeGreaterThan(0);

    expect(spanAttrMap['gen_ai.usage.total_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.total_tokens'].intValue).toBeGreaterThan(
      0,
    );

    // Required metrics attributes
    expect(spanAttrMap['gen_ai.metrics.time_to_first_token_ms']).toBeDefined();
    expect(
      spanAttrMap['gen_ai.metrics.time_to_first_token_ms'].intValue,
    ).toBeGreaterThanOrEqual(0);
  });
});

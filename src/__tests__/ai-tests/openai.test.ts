import fs from 'fs';
import OpenAI from 'openai';
import { initializeTracing, StatsigAI } from '../../index';
import { StatsigOptions } from '@statsig/statsig-node-core';
import { wrapOpenAI } from '../../wrappers/openai';
import { MockScrapi } from '../shared/MockScrapi';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  getDCSFilePath,
  validateOtelClientSpanBasics,
  getSpanAttributesMap,
} from '../shared/utils';
import {
  OPENAI_TEST_MODEL,
  OPENAI_TEST_IMAGE_MODEL,
  OPENAI_TEST_EMBEDDING_MODEL,
} from './models';

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

  it('openai.chat.completions.create', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai, {
      captureOptions: {
        capture_input_messages: true,
      },
    });
    const spanName = `chat ${OPENAI_TEST_MODEL}`;

    const start = Date.now();
    const response = await client.chat.completions.create({
      model: OPENAI_TEST_MODEL,
      messages: [{ role: 'user', content: 'What is a feature flag?' }],
      temperature: 0.7,
      max_tokens: 100,
    });

    const expectedDuration = Date.now() - start;

    expect(response).toBeDefined();

    await StatsigAI.shared().flushEvents();

    const traceRequests = scrapi.getOtelRequests();
    expect(traceRequests.length).toBeGreaterThan(0);

    const genAiEvents = scrapi.getLoggedEvents('statsig::gen_ai');
    expect(genAiEvents.length).toBeGreaterThan(0);

    const genAIEvent = genAiEvents[0];
    expect(genAIEvent.value).toBe(spanName);

    const genAIEventMetadata = genAIEvent?.metadata;

    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);

    // -- Base & Request attributes --
    expect(genAIEventMetadata['gen_ai.provider.name']).toEqual('openai');
    expect(spanAttrMap['gen_ai.provider.name'].stringValue).toBe('openai');

    expect(genAIEventMetadata['gen_ai.operation.name']).toEqual('chat');
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe('chat');

    expect(genAIEventMetadata['gen_ai.request.model']).toEqual(
      OPENAI_TEST_MODEL,
    );
    expect(spanAttrMap['gen_ai.request.model'].stringValue).toBe(
      OPENAI_TEST_MODEL,
    );

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
    expect(spanAttrMap['gen_ai.usage.input_tokens'].intValue).toBeGreaterThan(
      0,
    );
    expect(genAIEventMetadata['gen_ai.usage.output_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.output_tokens'].intValue).toBeGreaterThan(
      0,
    );

    expect(
      Math.abs(
        parseInt(genAIEventMetadata['gen_ai.server.time_to_first_token']) -
          expectedDuration,
      ),
    ).toBeLessThan(100);

    expect(
      Math.abs(
        spanAttrMap['gen_ai.server.time_to_first_token'].intValue -
          expectedDuration,
      ),
    ).toBeLessThan(100);

    // Span metadata also appears on event metadata
    expect(genAIEventMetadata['span.name']).toBe(spanName);
    expect(genAIEventMetadata['span.span_id']).toBeDefined();
    expect(genAIEventMetadata['span.trace_id']).toBeDefined();
    expect(genAIEventMetadata['span.status_code']).toBeDefined();
  });

  it('openai.chat.completions.create stream=true', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai, {
      captureOptions: {
        capture_output_messages: true,
      },
    });
    const start = Date.now();
    let firstTokenTime = 0;
    const _r = await client.chat.completions.create({
      model: OPENAI_TEST_MODEL,
      messages: [{ role: 'user', content: 'What is a feature flag?' }],
      stream: true,
      max_tokens: 100,
      stream_options: { include_usage: true },
    });
    const chunks: any[] = [];
    let first = true;
    for await (const _ of _r) {
      if (first) {
        first = false;
        firstTokenTime = Date.now();
      }
      // just iterate through the stream
    }
    await StatsigAI.shared().flushEvents();
    const spanName = `chat ${OPENAI_TEST_MODEL}`;
    const traceRequests = scrapi.getOtelRequests();
    expect(traceRequests.length).toBeGreaterThan(0);

    const genAiEvents = scrapi.getLoggedEvents('statsig::gen_ai');
    expect(genAiEvents.length).toBeGreaterThan(0);

    const genAIEvent = genAiEvents[0];
    expect(genAIEvent.value).toBe(spanName);

    const genAIEventMetadata = genAIEvent?.metadata;

    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    // -- Base & Request attributes --
    expect(genAIEventMetadata['gen_ai.request.stream']).toEqual('true');
    expect(spanAttrMap['gen_ai.request.stream'].boolValue).toBe(true);

    expect(genAIEventMetadata['gen_ai.provider.name']).toEqual('openai');
    expect(spanAttrMap['gen_ai.provider.name'].stringValue).toBe('openai');

    expect(genAIEventMetadata['gen_ai.operation.name']).toEqual('chat');
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe('chat');

    expect(genAIEventMetadata['gen_ai.request.model']).toEqual(
      OPENAI_TEST_MODEL,
    );
    expect(spanAttrMap['gen_ai.request.model'].stringValue).toBe(
      OPENAI_TEST_MODEL,
    );

    expect(genAIEventMetadata['gen_ai.request.max_tokens']).toEqual('100');
    expect(spanAttrMap['gen_ai.request.max_tokens'].intValue).toBe(100);

    // -- Response attributes --
    expect(genAIEventMetadata['gen_ai.response.model']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.model']).toBeDefined();
    expect(genAIEventMetadata['gen_ai.response.id']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.id']).toBeDefined();
    expect(genAIEventMetadata['gen_ai.response.finish_reasons']).toBeDefined();
    expect(spanAttrMap['gen_ai.response.finish_reasons']).toBeDefined();
    expect(genAIEventMetadata['gen_ai.output.messages']).toBeDefined();
    expect(spanAttrMap['gen_ai.output.messages']).toBeDefined();

    // -- Usage attributes --
    expect(genAIEventMetadata['gen_ai.usage.input_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.input_tokens'].intValue).toBeGreaterThan(
      0,
    );
    expect(genAIEventMetadata['gen_ai.usage.output_tokens']).toBeDefined();
    expect(spanAttrMap['gen_ai.usage.output_tokens'].intValue).toBeGreaterThan(
      0,
    );

    const expectedDuration = firstTokenTime - start;
    expect(
      Math.abs(
        parseInt(genAIEventMetadata['gen_ai.server.time_to_first_token']) -
          expectedDuration,
      ),
    ).toBeLessThan(100);

    expect(
      Math.abs(
        spanAttrMap['gen_ai.server.time_to_first_token'].intValue -
          expectedDuration,
      ),
    ).toBeLessThan(100);

    // Span metadata also appears on event metadata
    expect(genAIEventMetadata['span.name']).toBe(spanName);
    expect(genAIEventMetadata['span.span_id']).toBeDefined();
    expect(genAIEventMetadata['span.trace_id']).toBeDefined();
    expect(genAIEventMetadata['span.status_code']).toBeDefined();
  });

  it('openai.completions.create', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai);
    const spanName = `text_completion ${OPENAI_TEST_MODEL}`;
    await client.completions.create({
      model: OPENAI_TEST_MODEL,
      prompt: 'Say hello',
    });
    await StatsigAI.shared().flushEvents();
    const traceRequests = scrapi.getOtelRequests();
    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    expect(spanAttrMap['gen_ai.provider.name'].stringValue).toBe('openai');
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'text_completion',
    );
    expect(spanAttrMap['gen_ai.request.model'].stringValue).toBe(
      OPENAI_TEST_MODEL,
    );
  });

  it('openai.completions.create stream=true', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai);
    const start = Date.now();
    const spanName = `text_completion ${OPENAI_TEST_MODEL}`;
    const r = await client.completions.create({
      model: OPENAI_TEST_MODEL,
      prompt: 'Say hello',
      stream: true,
    });
    let firstTokenTime = 0;
    let first = true;
    for await (const _ of r as any) {
      if (first) {
        first = false;
        firstTokenTime = Date.now();
      }
    }
    await StatsigAI.shared().flushEvents();
    const traceRequests = scrapi.getOtelRequests();
    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'text_completion',
    );
    expect(spanAttrMap['gen_ai.request.stream'].boolValue).toBe(true);
    const expectedDuration = firstTokenTime - start;
    expect(
      Math.abs(
        spanAttrMap['gen_ai.server.time_to_first_token'].intValue -
          expectedDuration,
      ),
    ).toBeLessThan(200);
  });

  it('openai.embeddings.create', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai);
    const spanName = `embeddings ${OPENAI_TEST_EMBEDDING_MODEL}`;
    await client.embeddings.create({
      model: OPENAI_TEST_EMBEDDING_MODEL,
      input: 'Hello',
    });
    await StatsigAI.shared().flushEvents();
    const traceRequests = scrapi.getOtelRequests();
    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe('embeddings');
    expect(spanAttrMap['gen_ai.request.model'].stringValue).toBe(
      OPENAI_TEST_EMBEDDING_MODEL,
    );
  });

  it('openai.images.generate', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai);
    const spanName = `images.generate ${OPENAI_TEST_IMAGE_MODEL}`;
    await client.images.generate({
      model: OPENAI_TEST_IMAGE_MODEL,
      prompt: 'A cat',
    });
    await StatsigAI.shared().flushEvents();
    const traceRequests = scrapi.getOtelRequests();
    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'images.generate',
    );
  });

  it('openai.responses.create', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai);
    const spanName = `responses.create ${OPENAI_TEST_MODEL}`;
    await client.responses.create({
      model: OPENAI_TEST_MODEL,
      input: 'Hello',
    } as any);
    await StatsigAI.shared().flushEvents();
    const traceRequests = scrapi.getOtelRequests();
    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'responses.create',
    );
  });

  it('openai.responses.create stream=true', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai);
    const start = Date.now();
    const spanName = `responses.create ${OPENAI_TEST_MODEL}`;
    const r = await client.responses.create({
      model: OPENAI_TEST_MODEL,
      input: 'Hello',
      stream: true,
    } as any);
    let firstTokenTime = 0;
    let first = true;
    for await (const _ of r as any) {
      if (first) {
        first = false;
        firstTokenTime = Date.now();
      }
    }
    await StatsigAI.shared().flushEvents();
    const traceRequests = scrapi.getOtelRequests();
    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'responses.create',
    );
    expect(spanAttrMap['gen_ai.request.stream'].boolValue).toBe(true);
    const expectedDuration = firstTokenTime - start;
    expect(
      Math.abs(
        spanAttrMap['gen_ai.server.time_to_first_token'].intValue -
          expectedDuration,
      ),
    ).toBeLessThan(200);
  });

  it('openai.responses.stream', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai);
    const start = Date.now();
    const spanName = `responses.stream ${OPENAI_TEST_MODEL}`;
    const r = await client.responses.stream({
      model: OPENAI_TEST_MODEL,
      input: 'Stream me',
      stream: true,
    } as any);
    let firstTokenTime = 0;
    let first = true;
    for await (const _ of r as any) {
      if (first) {
        first = false;
        firstTokenTime = Date.now();
      }
    }
    await StatsigAI.shared().flushEvents();
    const traceRequests = scrapi.getOtelRequests();
    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'responses.stream',
    );
    expect(spanAttrMap['gen_ai.request.stream'].boolValue).toBe(true);
    const expectedDuration = firstTokenTime - start;
    expect(
      Math.abs(
        spanAttrMap['gen_ai.server.time_to_first_token'].intValue -
          expectedDuration,
      ),
    ).toBeLessThan(200);
  });

  it('openai.responses.parse', async () => {
    const openai = new OpenAI();
    const client = wrapOpenAI(openai);
    const spanName = `responses.parse ${OPENAI_TEST_MODEL}`;
    await client.responses.parse({
      model: OPENAI_TEST_MODEL,
      input: 'Parse this',
    } as any);
    await StatsigAI.shared().flushEvents();
    const traceRequests = scrapi.getOtelRequests();
    const span = validateOtelClientSpanBasics(traceRequests, spanName);
    const spanAttrMap = getSpanAttributesMap(span);
    expect(spanAttrMap['gen_ai.operation.name'].stringValue).toBe(
      'responses.parse',
    );
  });
});

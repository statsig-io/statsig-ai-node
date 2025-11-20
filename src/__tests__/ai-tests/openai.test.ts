import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { StatsigOptions } from '@statsig/statsig-node-core';
import fs from 'fs';
import OpenAI from 'openai';
import { initializeTracing, StatsigAI } from '../../index';
import { wrapOpenAI } from '../../wrappers/openai';
import { GenAICaptureOptions } from '../../wrappers/openai-configs';
import { MockScrapi } from '../shared/MockScrapi';
import {
  getDCSFilePath,
  getSpanAttributesMap,
  validateOtelClientSpanBasics,
} from '../shared/utils';
import { OPENAI_TEST_EMBEDDING_MODEL, OPENAI_TEST_MODEL } from './models';

type OperationRequiredAttributes = {
  id: boolean;
  finish_reasons: boolean;
  output_tokens: boolean;
  otel_semantic_name: string;
};
const OPERATION_REQUIRED_ATTRIBUTES_MAP: Record<
  string,
  OperationRequiredAttributes
> = {
  'openai.chat.completions.create': {
    id: true,
    finish_reasons: true,
    output_tokens: true,
    otel_semantic_name: 'chat',
  },
  'openai.completions.create': {
    id: true,
    finish_reasons: true,
    output_tokens: true,
    otel_semantic_name: 'text_completion',
  },
  'openai.embeddings.create': {
    id: false,
    finish_reasons: false,
    output_tokens: false,
    otel_semantic_name: 'embeddings',
  },
  'openai.images.generate': {
    id: false,
    finish_reasons: false,
    output_tokens: true,
    otel_semantic_name: 'images.generate',
  },
  'openai.responses.create': {
    id: true,
    finish_reasons: false,
    output_tokens: true,
    otel_semantic_name: 'responses.create',
  },
};

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

  const TEST_CASES = [
    {
      name: 'openai.chat.completions.create',
      operationName: 'openai.chat.completions.create',
      op: (c: any) => c.chat.completions.create,
      args: {
        model: OPENAI_TEST_MODEL,
        messages: [{ role: 'user', content: 'What is a feature flag?' }],
        temperature: 0.7,
        max_tokens: 128,
      },
      options: {
        capture_input_messages: true,
      },
    },
    {
      name: 'openai.chat.completions.create with stream',
      operationName: 'openai.chat.completions.create',
      op: (c: any) => c.chat.completions.create,
      args: {
        model: OPENAI_TEST_MODEL,
        messages: [{ role: 'user', content: 'Explain feature flags' }],
        stream: true,
        temperature: 0.5,
        max_tokens: 100,
        stream_options: { include_usage: true },
      },
      options: {
        capture_output_messages: true,
      },
    },
    {
      name: 'openai.completions.create',
      operationName: 'openai.completions.create',
      op: (c: any) => c.completions.create,
      args: {
        model: OPENAI_TEST_MODEL,
        prompt: 'Say hello world',
        max_tokens: 32,
        temperature: 0.3,
      },
    },
    {
      name: 'openai.completions.create with stream',
      operationName: 'openai.completions.create',
      op: (c: any) => c.completions.create,
      args: {
        model: OPENAI_TEST_MODEL,
        prompt: 'Say hello world',
        stream: true,
        temperature: 0.5,
        max_tokens: 100,
        stream_options: { include_usage: true },
      },
      options: {
        capture_output_messages: true,
      },
    },
    {
      name: 'openai.embeddings.create',
      operationName: 'openai.embeddings.create',
      op: (c: any) => c.embeddings.create,
      args: {
        model: OPENAI_TEST_EMBEDDING_MODEL,
        input: 'Embedding this text',
        encoding_format: 'float',
        dimensions: 1536,
      },
    },
    {
      name: 'openai.responses.create',
      operationName: 'openai.responses.create',
      op: (c: any) => c.responses.create,
      args: { model: OPENAI_TEST_MODEL, input: 'Regular response test' },
    },
    {
      name: 'openai.responses.create with capture options',
      operationName: 'openai.responses.create',
      op: (c: any) => c.responses.create,
      args: {
        model: OPENAI_TEST_MODEL,
        input: [
          {
            role: 'user',
            content: 'Test message with capture',
            type: 'message',
          },
        ],
      },
      options: {
        capture_input_messages: true,
        capture_output_messages: true,
      },
    },
    {
      name: 'openai.responses.create with stream',
      operationName: 'openai.responses.create',
      op: (c: any) => c.responses.create,
      args: {
        model: OPENAI_TEST_MODEL,
        input: 'Stream response test',
        stream: true,
      },
    },
  ];

  type TestCase = {
    name: string;
    operationName: string;
    op: (c: any) => any;
    args: Record<string, any>;
    options?: GenAICaptureOptions;
  };

  test.each(TEST_CASES)('$name', async (t: TestCase) => {
    const { op, args, operationName: opName, options: testOptions = {} } = t;
    const openai = new OpenAI();
    const client = wrapOpenAI(openai, {
      captureOptions: testOptions,
    });
    const start = Date.now();
    const method = await op(client);
    const result = await method(args);
    let expectedDuration = Math.round(Date.now() - start);

    if (args.stream) {
      let first = true;
      for await (const _ of result as any) {
        if (first) {
          first = false;
          expectedDuration = Math.round(Date.now() - start);
        }
      }
    }

    await validateTraceAndEvent({
      scrapi,
      opName,
      args,
      expectedDuration,
      options: testOptions,
    });
  });
});

async function validateTraceAndEvent({
  scrapi,
  opName,
  args,
  expectedDuration,
  options,
}: {
  scrapi: MockScrapi;
  opName: string;
  args: any;
  expectedDuration: number;
  options: GenAICaptureOptions;
}) {
  await StatsigAI.shared().flushEvents();
  const otelSemanticName =
    OPERATION_REQUIRED_ATTRIBUTES_MAP[opName].otel_semantic_name;
  const spanName = `${otelSemanticName} ${args.model}`;

  const traceRequests = scrapi.getOtelRequests();
  expect(traceRequests.length).toBeGreaterThan(0);
  const span = validateOtelClientSpanBasics(traceRequests, spanName);
  const attrs = getSpanAttributesMap(span);

  const events = scrapi.getLoggedEvents('statsig::gen_ai');
  expect(events.length).toBeGreaterThan(0);
  const meta = events[0].metadata;

  // -- Base/Request
  expect(meta['gen_ai.provider.name']).toBe('openai');
  expect(attrs['gen_ai.provider.name'].stringValue).toBe('openai');
  expect(meta['gen_ai.request.model']).toBe(args.model);
  expect(attrs['gen_ai.request.model'].stringValue).toBe(args.model);
  expect(meta['gen_ai.operation.name']).toBe(otelSemanticName);
  expect(attrs['gen_ai.operation.name'].stringValue).toBe(otelSemanticName);
  expect(meta['gen_ai.operation.source_name']).toBe(opName);
  expect(attrs['gen_ai.operation.source_name'].stringValue).toBe(opName);

  // -- Response
  if (OPERATION_REQUIRED_ATTRIBUTES_MAP[opName].id) {
    expect(meta['gen_ai.response.id']).toBeDefined();
    expect(attrs['gen_ai.response.id'].stringValue).toBeDefined();
  }
  if (OPERATION_REQUIRED_ATTRIBUTES_MAP[opName].finish_reasons) {
    expect(meta['gen_ai.response.finish_reasons']).toBeDefined();
    expect(attrs['gen_ai.response.finish_reasons'].stringValue).toBeDefined();
  }
  expect(meta['gen_ai.response.model']).toBeDefined();
  expect(attrs['gen_ai.response.model'].stringValue).toBeDefined();

  // -- Usage
  expect(meta['gen_ai.usage.input_tokens']).toBeDefined();
  expect(attrs['gen_ai.usage.input_tokens'].intValue).toBeGreaterThan(0);
  if (OPERATION_REQUIRED_ATTRIBUTES_MAP[opName].output_tokens) {
    expect(meta['gen_ai.usage.output_tokens']).toBeDefined();
    expect(attrs['gen_ai.usage.output_tokens'].intValue).toBeGreaterThan(0);
  }

  // -- Streaming
  if (args.stream) {
    expect(attrs['gen_ai.request.stream'].boolValue).toBe(true);
    expect(meta['gen_ai.request.stream']).toBe('true');
  }

  if (options.capture_output_messages) {
    expect(meta['gen_ai.output.messages']).toBeDefined();
    expect(attrs['gen_ai.output.messages']).toBeDefined();
  }

  if (options.capture_input_messages) {
    expect(meta['gen_ai.input.messages']).toBeDefined();
    expect(attrs['gen_ai.input.messages']).toBeDefined();
  }

  // -- Embedding
  if (args.model === OPENAI_TEST_EMBEDDING_MODEL) {
    expect(meta['gen_ai.embeddings.dimension.count']).toBeDefined();
    expect(attrs['gen_ai.embeddings.dimension.count'].intValue).toBe(
      args.dimensions,
    );
    expect(meta['gen_ai.request.encoding_formats']).toBeDefined();
    expect(attrs['gen_ai.request.encoding_formats'].stringValue).toBe(
      JSON.stringify([args.encoding_format]),
    );
  }

  if (expectedDuration) {
    const msElapsed = attrs['gen_ai.server.time_to_first_token_ms'].intValue;
    expect(Math.abs(msElapsed - expectedDuration)).toBeLessThan(200);
    const secondsElapsed =
      attrs['gen_ai.server.time_to_first_token'].doubleValue;
    expect(Math.abs(secondsElapsed - expectedDuration / 1000)).toBeLessThan(2);
  }

  // -- Span/event consistency
  expect(meta['span.name']).toBe(spanName);
  expect(meta['span.trace_id']).toBeDefined();
  expect(meta['span.span_id']).toBeDefined();
  expect(meta['span.status_code']).toBeDefined();
}

// takes too long for the request to complete
// const imageTestCase = {
//   name: 'openai.images.generate',
//   op: (c: any) => c.images.generate,
//   operationName: 'images.generate',
//   args: {
//     model: OPENAI_TEST_IMAGE_MODEL,
//     prompt: 'A cat riding a skateboard',
//     quality: 'low',
//     size: '1024x1024',
//     n: 1,
//   },
// };

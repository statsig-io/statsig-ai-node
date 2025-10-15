import * as otelModule from '../otel/otel';

import { DefaultMockResponses, MockOpenAI } from './MockOpenAI';

import { MockScrapi } from './MockScrapi';
import OpenAI from 'openai';
import { OpenAILike } from '../wrappers/openai-configs';
import { Statsig } from '..';
import { StatsigOptions } from '../StatsigOptions';
import fs from 'fs';
import path from 'path';
import { wrapOpenAI } from '../wrappers/openai';

describe('OpenAI Wrapper with Statsig Tracing', () => {
  let statsig: Statsig;
  let scrapi: MockScrapi;
  let openai: Partial<OpenAI>;
  let wrappedOpenAI: OpenAILike;
  let options: StatsigOptions;
  const sdkKey = 'secret-test-key';

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
    if (statsig) {
      await statsig.shutdown();
    }
  });

  it('should wrap OpenAI instance successfully', () => {
    expect(openai).toBeDefined();
    expect(openai.chat).toBeDefined();
    expect(openai.chat?.completions).toBeDefined();
    expect(openai.chat?.completions?.create).toBeDefined();
  });

  it('should send traces when calling chat.completions.create', async () => {
    statsig = new Statsig('secret-test-key', options);
    await statsig.initialize();

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

    await statsig.flushEvents();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const traceRequests = scrapi.getOtelRequests();
    console.log(traceRequests);
    expect(traceRequests.length).toBeGreaterThan(0);

    const traceRequest = traceRequests[0];
    expect(traceRequest.body.headers['statsig-api-key']).toBe(
      'secret-test-key',
    );
    expect(traceRequest.body).toBeDefined();

    const resourceSpans = traceRequest.body?.resourceSpans || [];
    expect(resourceSpans.length).toBeGreaterThan(0);
  });

  //   test('should include custom attributes in traces', async () => {
  //     // Wrap with custom attributes
  //     const customWrappedOpenAI = wrapOpenAI(openai, {
  //       customAttributes: {
  //         'custom.attribute.1': 'value1',
  //         'custom.attribute.2': 'value2',
  //       },
  //     });

  //     await statsig.initialize();

  //     await customWrappedOpenAI.chat.completions.create({
  //       model: 'gpt-4',
  //       messages: [{ role: 'user', content: 'Test' }],
  //     });

  //     // Wait for traces
  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should send traces for embeddings.create', async () => {
  //     await statsig.initialize();

  //     const response = await wrappedOpenAI.embeddings.create({
  //       model: 'text-embedding-ada-002',
  //       input: 'Test input',
  //     });

  //     expect(response).toBeDefined();
  //     expect(response.data).toBeDefined();
  //     expect(response.data[0].embedding).toBeDefined();

  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should send traces for completions.create (legacy)', async () => {
  //     await statsig.initialize();

  //     const response = await wrappedOpenAI.completions!.create({
  //       model: 'gpt-3.5-turbo-instruct',
  //       prompt: 'Tell me a joke',
  //       max_tokens: 50,
  //     });

  //     expect(response).toBeDefined();
  //     expect(response.choices[0].text).toBe('This is a completion');

  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should send traces for images.generate', async () => {
  //     await statsig.initialize();

  //     const response = await wrappedOpenAI.images!.generate({
  //       model: 'dall-e-3',
  //       prompt: 'A beautiful sunset',
  //       n: 1,
  //     });

  //     expect(response).toBeDefined();
  //     expect(response.data).toBeDefined();
  //     expect(response.data[0].url).toBeDefined();

  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should handle streaming chat completions', async () => {
  //     // Create a mock streaming response
  //     const mockStream = {
  //       async *[Symbol.asyncIterator]() {
  //         yield {
  //           id: 'chatcmpl-stream',
  //           object: 'chat.completion.chunk',
  //           created: Date.now(),
  //           model: 'gpt-4',
  //           choices: [
  //             {
  //               index: 0,
  //               delta: { role: 'assistant', content: 'Hello' },
  //               finish_reason: null,
  //             },
  //           ],
  //         };
  //         yield {
  //           id: 'chatcmpl-stream',
  //           object: 'chat.completion.chunk',
  //           created: Date.now(),
  //           model: 'gpt-4',
  //           choices: [
  //             {
  //               index: 0,
  //               delta: { content: ' there!' },
  //               finish_reason: null,
  //             },
  //           ],
  //         };
  //         yield {
  //           id: 'chatcmpl-stream',
  //           object: 'chat.completion.chunk',
  //           created: Date.now(),
  //           model: 'gpt-4',
  //           choices: [
  //             {
  //               index: 0,
  //               delta: {},
  //               finish_reason: 'stop',
  //             },
  //           ],
  //           usage: {
  //             prompt_tokens: 5,
  //             completion_tokens: 10,
  //             total_tokens: 15,
  //           },
  //         };
  //       },
  //     };

  //     (mockOpenAI.chat.completions.create as jest.Mock).mockReturnValue(
  //       mockStream,
  //     );

  //     await statsig.initialize();

  //     const stream = (await wrappedOpenAI.chat.completions.create({
  //       model: 'gpt-4',
  //       messages: [{ role: 'user', content: 'Hello' }],
  //       stream: true,
  //     })) as any;

  //     // Consume the stream
  //     const chunks = [];
  //     for await (const chunk of stream) {
  //       chunks.push(chunk);
  //     }

  //     expect(chunks.length).toBe(3);

  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should handle errors and send error traces', async () => {
  //     // Mock an error
  //     const testError = new Error('OpenAI API error');
  //     (mockOpenAI.chat.completions.create as jest.Mock).mockRejectedValue(
  //       testError,
  //     );

  //     await statsig.initialize();

  //     await expect(
  //       wrappedOpenAI.chat.completions.create({
  //         model: 'gpt-4',
  //         messages: [{ role: 'user', content: 'Test' }],
  //       }),
  //     ).rejects.toThrow('OpenAI API error');

  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should redact sensitive information when configured', async () => {
  //     const redactWrappedOpenAI = wrapOpenAI(mockOpenAI, {
  //       redact: (obj: any) => {
  //         if (Array.isArray(obj)) {
  //           return obj.map((item) => ({
  //             ...item,
  //             content: '***REDACTED***',
  //           }));
  //         }
  //         return obj;
  //       },
  //     });

  //     await statsig.initialize();

  //     await redactWrappedOpenAI.chat.completions.create({
  //       model: 'gpt-4',
  //       messages: [{ role: 'user', content: 'This is sensitive information' }],
  //     });

  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should respect maxJSONChars configuration', async () => {
  //     const smallMaxCharsOpenAI = wrapOpenAI(mockOpenAI, {
  //       maxJSONChars: 100, // Very small to trigger truncation
  //     });

  //     await statsig.initialize();

  //     await smallMaxCharsOpenAI.chat.completions.create({
  //       model: 'gpt-4',
  //       messages: [
  //         {
  //           role: 'user',
  //           content: 'A'.repeat(1000), // Long content to trigger truncation
  //         },
  //       ],
  //     });

  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should handle array prompts for legacy completions', async () => {
  //     await statsig.initialize();

  //     await wrappedOpenAI.completions!.create({
  //       model: 'gpt-3.5-turbo-instruct',
  //       prompt: ['First prompt', 'Second prompt'],
  //       max_tokens: 50,
  //     });

  //     await new Promise((resolve) => setTimeout(resolve, 100));

  //     const traceRequests = traceCalls.filter((call) =>
  //       call.url.includes('api.statsig.com/otlp/v1/traces'),
  //     );

  //     expect(traceRequests.length).toBeGreaterThan(0);
  //   });

  //   test('should work without initializing Statsig (should still wrap but not trace)', async () => {
  //     // Don't initialize Statsig, just wrap and call
  //     const response = await wrappedOpenAI.chat.completions.create({
  //       model: 'gpt-4',
  //       messages: [{ role: 'user', content: 'Test' }],
  //     });

  //     expect(response).toBeDefined();
  //     expect(response.choices[0].message.content).toBe('This is a test response');
  //   });

  //   test('should not wrap invalid OpenAI-like objects', () => {
  //     const invalidOpenAI = {
  //       // Missing required chat.completions structure
  //       someOtherMethod: () => {},
  //     };

  //     const wrapped = wrapOpenAI(invalidOpenAI as any);

  //     // Should return the original object
  //     expect(wrapped).toBe(invalidOpenAI);
  //   });
});

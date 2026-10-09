import { context as otelContext, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { StatsigUser } from '@statsig/statsig-node-core';

import Anthropic from '@anthropic-ai/sdk';

import { OtelSingleton } from '../../otel/singleton';
import { Prompt } from '../../prompts/Prompt';
import { PromptVersion } from '../../prompts/PromptVersion';
import { wrapAnthropic } from '../../wrappers/anthropic';
import { wrapGemini } from '../../wrappers/gemini';

async function* yieldAll<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

function json(span: ReadableSpan, key: string): unknown {
  return JSON.parse(String(span.attributes[key]));
}

describe('provider wrappers', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let exporter: InMemorySpanExporter;
  let prompt: Prompt;
  const captureOptions = { capture_all: true };

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    try {
      otelContext.setGlobalContextManager(contextManager);
    } catch (err) {
      // ignore if already set
    }
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    otelContext.disable();
    contextManager.disable();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    OtelSingleton.__reset();
    OtelSingleton.instantiate({
      tracerProvider: new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      }),
    });
    const liveVersion = {
      getName: () => 'v2',
      getID: () => 'version-2',
    } as unknown as PromptVersion;
    prompt = new Prompt(
      new StatsigUser({ userID: 'user-1' }),
      'support_agent',
      liveVersion,
      [],
    );
  });

  describe('wrapAnthropic', () => {
    it('records a tool-using turn in the OpenTelemetry message format with prompt attributes', async () => {
      const response = {
        id: 'msg_1',
        model: 'claude-test',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Check the gate.' },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'get_gate',
            input: { id: 'checkout' },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 4,
          output_tokens: 6,
        },
      };
      const apiPromise = Object.assign(Promise.resolve(response), {
        withResponse: jest.fn(),
      });
      const create = jest.fn((_params: unknown) => apiPromise);
      const client = wrapAnthropic(
        { messages: { create } },
        { captureOptions },
      );

      const result = prompt.withLive(() => {
        const call = client.messages.create({
          model: 'claude-test',
          max_tokens: 256,
          temperature: 0.2,
          system: 'You are helpful.',
          tools: [{ name: 'get_gate' }],
          messages: [
            { role: 'user', content: 'Is checkout on?' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_1',
                  name: 'list_gates',
                  input: {},
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_1',
                  content: [{ type: 'text', text: '["checkout"]' }],
                },
              ],
            },
          ],
        });
        expect(typeof call.withResponse).toBe('function');
        return call;
      });

      await expect(result).resolves.toBe(response);
      const [span] = exporter.getFinishedSpans();
      expect(span.name).toBe('chat claude-test');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes).toMatchObject({
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-test',
        'gen_ai.request.max_tokens': 256,
        'gen_ai.request.temperature': 0.2,
        'gen_ai.response.id': 'msg_1',
        'gen_ai.usage.input_tokens': 14,
        'gen_ai.usage.output_tokens': 6,
        'statsig.gen_ai.usage.input_cached_tokens': 4,
        'statsig.llm.prompt_name': 'support_agent',
        'statsig.llm.prompt_version': 'v2',
        'statsig.llm.prompt_version_id': 'version-2',
      });
      expect(json(span, 'gen_ai.system_instructions')).toEqual([
        { type: 'text', content: 'You are helpful.' },
      ]);
      expect(json(span, 'gen_ai.input.messages')).toEqual([
        {
          role: 'user',
          parts: [{ type: 'text', content: 'Is checkout on?' }],
        },
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              id: 'toolu_1',
              name: 'list_gates',
              arguments: {},
            },
          ],
        },
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_call_response',
              id: 'toolu_1',
              response: '["checkout"]',
            },
          ],
        },
      ]);
      expect(json(span, 'gen_ai.output.messages')).toEqual([
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', content: 'Check the gate.' },
            {
              type: 'tool_call',
              id: 'toolu_2',
              name: 'get_gate',
              arguments: { id: 'checkout' },
            },
          ],
          finish_reason: 'tool_call',
        },
      ]);
    });

    it('rebuilds a streamed message and ends the span after the stream is consumed', async () => {
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_2',
            model: 'claude-test',
            usage: { input_tokens: 8 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Checking ' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'now.' },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_3',
            name: 'get_gate',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"id":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"checkout"}' },
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 12 },
        },
        { type: 'message_stop' },
      ];
      const client = wrapAnthropic(
        {
          messages: {
            create: jest.fn(async (_params: unknown) => yieldAll(events)),
          },
        },
        { captureOptions },
      );

      const stream = (await client.messages.create({
        model: 'claude-test',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Is checkout on?' }],
      })) as AsyncIterable<unknown>;
      expect(exporter.getFinishedSpans()).toHaveLength(0);

      const received: unknown[] = [];
      for await (const event of stream) {
        received.push(event);
      }

      expect(received).toHaveLength(events.length);
      const [span] = exporter.getFinishedSpans();
      expect(span.attributes).toMatchObject({
        'gen_ai.request.stream': true,
        'gen_ai.response.id': 'msg_2',
        'gen_ai.usage.input_tokens': 8,
        'gen_ai.usage.output_tokens': 12,
      });
      expect(json(span, 'gen_ai.output.messages')).toEqual([
        {
          role: 'assistant',
          parts: [
            { type: 'text', content: 'Checking now.' },
            {
              type: 'tool_call',
              id: 'toolu_3',
              name: 'get_gate',
              arguments: { id: 'checkout' },
            },
          ],
          finish_reason: 'tool_call',
        },
      ]);
    });

    it('marks the span as failed when the call rejects, and skips unsupported clients', async () => {
      const client = wrapAnthropic({
        messages: {
          create: jest.fn((_params: unknown) =>
            Promise.reject(new Error('overloaded')),
          ),
        },
      });

      await expect(
        client.messages.create({ model: 'claude-test', messages: [] }),
      ).rejects.toThrow('overloaded');
      const [span] = exporter.getFinishedSpans();
      expect(span.status).toMatchObject({
        code: SpanStatusCode.ERROR,
        message: 'overloaded',
      });

      const notAClient = { chat: {} };
      expect(wrapAnthropic(notAClient)).toBe(notAClient);
    });
  });

  describe('wrapAnthropic messages.stream()', () => {
    const sseEvents = [
      {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Checkout ' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'is on.' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ];

    function makeClient(response: () => Response): Anthropic {
      return wrapAnthropic(
        new Anthropic({
          apiKey: 'test-key',
          maxRetries: 0,
          fetch: async () => response(),
        }),
        { captureOptions },
      );
    }

    function sseResponse(): Response {
      const body = sseEvents
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join('');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    const params = {
      model: 'claude-test',
      max_tokens: 64,
      messages: [{ role: 'user' as const, content: 'Is checkout on?' }],
    };

    it('ends the span when the caller only awaits finalMessage()', async () => {
      const client = makeClient(sseResponse);

      const message = await prompt.withLive(() =>
        client.messages.stream(params).finalMessage(),
      );

      expect(message.content).toMatchObject([
        { type: 'text', text: 'Checkout is on.' },
      ]);
      const [span] = exporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes).toMatchObject({
        'gen_ai.operation.source_name': 'anthropic.messages.stream',
        'gen_ai.request.stream': true,
        'gen_ai.response.id': 'msg_stream',
        'gen_ai.usage.input_tokens': 7,
        'gen_ai.usage.output_tokens': 4,
        'statsig.llm.prompt_version_id': 'version-2',
      });
      expect(json(span, 'gen_ai.output.messages')).toEqual([
        {
          role: 'assistant',
          parts: [{ type: 'text', content: 'Checkout is on.' }],
          finish_reason: 'stop',
        },
      ]);
    });

    it('ends the span when the caller iterates the stream', async () => {
      const client = makeClient(sseResponse);

      const stream = client.messages.stream(params);
      let text = '';
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          text += event.delta.text;
        }
      }
      await stream.done();

      expect(text).toBe('Checkout is on.');
      const [span] = exporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(json(span, 'gen_ai.output.messages')).toEqual([
        {
          role: 'assistant',
          parts: [{ type: 'text', content: 'Checkout is on.' }],
          finish_reason: 'stop',
        },
      ]);
    });

    it('marks the span as failed when the request fails', async () => {
      const client = makeClient(
        () =>
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'invalid_request_error', message: 'bad model' },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      );

      await expect(
        client.messages.stream(params).finalMessage(),
      ).rejects.toThrow('bad model');

      const [span] = exporter.getFinishedSpans();
      expect(span.status).toMatchObject({
        code: SpanStatusCode.ERROR,
        message: 'Stream ended without a final message.',
      });
    });
  });

  describe('wrapGemini', () => {
    it('records a function-calling response in the OpenTelemetry message format', async () => {
      const response = {
        responseId: 'resp_1',
        modelVersion: 'gemini-test-001',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'get_gate', args: { id: 'checkout' } },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 2,
        },
      };
      const client = wrapGemini(
        {
          models: {
            generateContent: jest.fn(async (_params: unknown) => response),
          },
        },
        { captureOptions },
      );

      await expect(
        prompt.withLive(() =>
          client.models.generateContent({
            model: 'gemini-test',
            contents: [
              { role: 'user', parts: [{ text: 'Is checkout on?' }] },
              {
                role: 'model',
                parts: [{ functionCall: { name: 'list_gates', args: {} } }],
              },
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      name: 'list_gates',
                      response: { gates: ['checkout'] },
                    },
                  },
                ],
              },
            ],
            config: { systemInstruction: 'Be brief.', temperature: 0.1 },
          }),
        ),
      ).resolves.toBe(response);

      const [span] = exporter.getFinishedSpans();
      expect(span.name).toBe('generate_content gemini-test');
      expect(span.attributes).toMatchObject({
        'gen_ai.provider.name': 'gcp.gen_ai',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.request.temperature': 0.1,
        'gen_ai.response.model': 'gemini-test-001',
        'gen_ai.usage.input_tokens': 9,
        'gen_ai.usage.output_tokens': 5,
        'statsig.gen_ai.usage.output_reasoning_tokens': 2,
        'statsig.llm.prompt_version_id': 'version-2',
      });
      expect(json(span, 'gen_ai.system_instructions')).toEqual([
        { type: 'text', content: 'Be brief.' },
      ]);
      expect(json(span, 'gen_ai.input.messages')).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'Is checkout on?' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              id: 'list_gates',
              name: 'list_gates',
              arguments: {},
            },
          ],
        },
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_call_response',
              id: 'list_gates',
              response: { gates: ['checkout'] },
            },
          ],
        },
      ]);
      expect(json(span, 'gen_ai.output.messages')).toEqual([
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              id: 'get_gate',
              name: 'get_gate',
              arguments: { id: 'checkout' },
            },
          ],
          finish_reason: 'tool_call',
        },
      ]);
    });

    it('merges streamed chunks into one output message', async () => {
      const chunks = [
        {
          responseId: 'resp_2',
          modelVersion: 'gemini-test-001',
          candidates: [
            { content: { role: 'model', parts: [{ text: 'Checkout ' }] } },
          ],
        },
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'is on.' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 },
        },
      ];
      const client = wrapGemini(
        {
          models: {
            generateContent: jest.fn(),
            generateContentStream: jest.fn(async (_params: unknown) =>
              yieldAll(chunks),
            ),
          },
        },
        { captureOptions },
      );

      const stream = (await client.models.generateContentStream({
        model: 'gemini-test',
        contents: 'Is checkout on?',
      })) as AsyncIterable<unknown>;
      for await (const _chunk of stream) {
        // consume
      }

      const [span] = exporter.getFinishedSpans();
      expect(span.attributes).toMatchObject({
        'gen_ai.request.stream': true,
        'gen_ai.response.id': 'resp_2',
        'gen_ai.usage.input_tokens': 4,
        'gen_ai.usage.output_tokens': 3,
      });
      expect(json(span, 'gen_ai.input.messages')).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'Is checkout on?' }] },
      ]);
      expect(json(span, 'gen_ai.output.messages')).toEqual([
        {
          role: 'assistant',
          parts: [{ type: 'text', content: 'Checkout is on.' }],
          finish_reason: 'stop',
        },
      ]);
    });
  });
});

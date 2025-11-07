import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { StatsigUser } from '@statsig/statsig-node-core';

import { Prompt } from '../prompts/Prompt';
import { PromptVersion } from '../prompts/PromptVersion';
import {
  STATSIG_ATTR_CUSTOM_IDS,
  STATSIG_ATTR_LLM_PROMPT_NAME,
  STATSIG_ATTR_LLM_PROMPT_VERSION,
  STATSIG_ATTR_USER_ID,
} from '../otel/conventions';
import { StatsigSpanProcessor } from '../otel/processor';
import { wrapOpenAI } from '../wrappers/openai';
import { MockOpenAI } from '../__tests__/MockOpenAI';

describe('Span metadata propagation', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let exporter: InMemorySpanExporter;
  let processor: StatsigSpanProcessor;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    try {
      otelContext.setGlobalContextManager(contextManager);
    } catch (err) {
      // ignore if already set
    }

    exporter = new InMemorySpanExporter();
    processor = new StatsigSpanProcessor(exporter);
    provider = new BasicTracerProvider({
      spanProcessors: [processor],
    });
    otelTrace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await processor.forceFlush();
    await provider.shutdown();
    otelTrace.disable();
    otelContext.disable();
    contextManager.disable();
  });

  afterEach(() => {
    exporter.reset();
  });

  it('attaches prompt and user metadata to OpenAI spans created within prompt.withLive', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const openai = new MockOpenAI();
    const wrappedOpenAI = wrapOpenAI(openai as any);

    const promptVersion = {
      getName: jest.fn(() => 'Version 42'),
    } as unknown as PromptVersion;
    const user = new StatsigUser({
      userID: 'trace-user',
      customIDs: { project: 'apollo' },
    });
    const prompt = new Prompt(user, 'trace_prompt', promptVersion, []);

    await prompt.withLive(async () => {
      await wrappedOpenAI.chat?.completions?.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello from prompt context' }],
      });
    });

    await processor.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    const completionSpan = spans.find(
      (span: ReadableSpan) => span.name === 'openai.chat.completions.create',
    );
    expect(completionSpan).toBeDefined();

    const attributes = (completionSpan as any).attributes as Record<
      string,
      unknown
    >;

    expect(attributes[STATSIG_ATTR_LLM_PROMPT_NAME]).toBe('trace_prompt');
    expect(attributes[STATSIG_ATTR_LLM_PROMPT_VERSION]).toBe('Version 42');
    expect(attributes[STATSIG_ATTR_USER_ID]).toBe('trace-user');
    expect(attributes[STATSIG_ATTR_CUSTOM_IDS]).toBe(
      JSON.stringify({ project: 'apollo' }),
    );

    warnSpy.mockRestore();
  });
});

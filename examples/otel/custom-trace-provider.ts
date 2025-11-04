import {
  initializeTracing,
  wrapOpenAI,
  StatsigSpanProcessor,
  StatsigOTLPTraceExporter,
} from '../../src';

import { OpenAI } from 'openai';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Statsig } from '@statsig/statsig-node-core';
import { trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'statsig-ai',
  }),
  spanProcessors: [
    // needed to export spans to Statsig
    new StatsigSpanProcessor(
      new StatsigOTLPTraceExporter({
        sdkKey: process.env.STATSIG_SDK_KEY!,
      }),
    ),
  ],
});

provider.register();

initializeTracing({
  globalTraceProvider: provider,
});

const openai = wrapOpenAI(new OpenAI());
const statsig = new Statsig(process.env.STATSIG_SDK_KEY!);

const tracer = trace.getTracer('basic-example-tracer');

function waitFor(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await statsig.initialize();

  await tracer.startActiveSpan('example-span', async (span) => {
    span.setAttribute('example-attribute', 'example-value');
    await waitFor(2000);
    span.end();
  });

  // openai calls are automatically traced when wraped with wrapOpenAI
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello! Can you tell me a joke?' },
    ],
  });

  console.log(response.choices[0].message?.content);

  await statsig.shutdown();
  await provider.shutdown();
}

main().catch((error) => {
  console.error('Error in main execution:', error);
});

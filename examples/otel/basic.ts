import { trace } from '@opentelemetry/api';
import { initializeOtel } from '../../src';
import { wrapOpenAI } from '../../src';

import { Statsig } from '@statsig/statsig-node-core';

import { OpenAI } from 'openai';

// initialize basic OpenTelemetry instrumentation
// if you don't have your own otel setup, this will get you started
// with a trace provider and Statsig OTLP exporter
// it also sets up a global trace provider
const { provider } = initializeOtel({
  serviceName: 'statsig-ai',
  enableGlobalTraceProviderRegistration: true,
  exporterOptions: {
    sdkKey: process.env.STATSIG_SDK_KEY!,
  },
});

const openai = wrapOpenAI(new OpenAI());

const statsig = new Statsig(process.env.STATSIG_SDK_KEY!);

const tracer = trace.getTracer('basic-example-tracer');

function waitFor(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await statsig.initialize();

  // initializeOtel setups a global trace provider by default
  // allowing you to get tracers from anywhere in your app
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

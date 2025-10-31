import { trace } from '@opentelemetry/api';
import { initializeOtel } from '../../src';
import { wrapOpenAI } from '../../src';

import { Statsig } from '@statsig/statsig-node-core';

import { OpenAI } from 'openai';

const { provider } = initializeOtel({
  serviceName: 'statsig-ai',
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

  // this will not be traced since we did not enable global registration
  await tracer.startActiveSpan('example-span', async (span) => {
    span.setAttribute('example-attribute', 'example-value');
    await waitFor(2000);
    span.end();
  });

  // openai calls will still be traced though since they are created
  // within statsig-ai's context when using wrapOpenAI
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

import { OpenAI } from 'openai';

import {
  initializeTracing,
  wrapOpenAI,
  withStatsigUserContext,
  StatsigUser,
} from '../../src/';
import { trace } from '@opentelemetry/api';

const { provider } = initializeTracing({
  serviceName: 'statsig-ai-user-context',
  exporterOptions: {
    sdkKey: process.env.STATSIG_SDK_KEY!,
  },
});

const tracer = trace.getTracer('user-context-example-tracer');
const openai = wrapOpenAI(new OpenAI());

async function generateSomeResponses(input: string) {
  // the traces automatically created by openai calls within this function
  // will include the Statsig user context set by withStatsigUserContext
  const joke = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: `Hello! ${input}` },
    ],
  });

  const response = joke.choices[0].message?.content;

  // both the trace created here and the trace created by the openai call
  // will include the Statsig user context
  const result = await tracer.startActiveSpan(
    'summarize-joke-span',
    async (span) => {
      const result = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: `Can you summarize this joke? ${response}` },
        ],
      });
      span.end();
      return result;
    },
  );
  return result.choices[0].message?.content;
}

async function main() {
  const user = new StatsigUser({
    userID: 'user_123',
    customIDs: { orgID: 'org_123' },
  });
  // all traces created within this callback
  // will include the Statsig user context
  await withStatsigUserContext(user, async () => {
    const response = await generateSomeResponses('Can you tell me a joke?');
    console.log('Response with user context:', response);
  });
  await provider.shutdown();
}

main();

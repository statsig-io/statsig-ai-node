import { OpenAI } from 'openai';

import {
  initializeTracing,
  wrapOpenAI,
  withStatsigUserContext,
  StatsigUser,
  StatsigAI,
  Statsig,
} from '../../src/';
import { trace } from '@opentelemetry/api';

const { provider } = initializeTracing({
  serviceName: 'statsig-ai-user-context',
  exporterOptions: {
    sdkKey: process.env.STATSIG_SDK_KEY!,
  },
});

const statsig = new Statsig(process.env.STATSIG_SDK_KEY!);
const ai = new StatsigAI({ sdkKey: process.env.STATSIG_SDK_KEY! });

const tracer = trace.getTracer('user-context-example-tracer');
const openai = wrapOpenAI(new OpenAI());

async function generateSomeResponses(user: StatsigUser, input: string) {
  const prompt = ai.getPrompt(user, 'another_prompt');
  // the traces automatically created by openai calls within this function
  // will include now include the prompt name and the prompt version name (e.g. Version 1)
  const joke = await prompt.withLive(async (config) => {
    return await openai.chat.completions.create({
      model: config.getModel() || 'gpt-3.5-turbo',
      messages: config.getPromptMessages({ input }).map((msg) => ({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      })),
    });
  });

  const firstCandidate = prompt.getCandidates()[0];
  // you can also use withContext to create a custom prompt context without
  // going through withLive BUT the span will not include prompt version
  const anotherResponse = await prompt.withContext(async () => {
    return await openai.chat.completions.create({
      model: firstCandidate.getModel() || 'gpt-3.5-turbo',
      messages: firstCandidate.getPromptMessages({ input }).map((msg) => ({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      })),
    });
  });

  console.log('another response:', anotherResponse.choices[0].message?.content);

  const response = joke.choices[0].message?.content;

  // these traces will NOT include the prompt context since they are outside of prompt.withLive
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
  await statsig.initialize();
  const user = new StatsigUser({
    userID: 'user_123',
    customIDs: { orgID: 'org_123' },
  });

  await withStatsigUserContext(user, async () => {
    const response = await generateSomeResponses(
      user,
      'Can you tell me a joke?',
    );
    console.log('Response with user context:', response);
  });
  await provider.shutdown();
}

main();

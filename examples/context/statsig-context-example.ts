import {
  initializeTracing,
  wrapOpenAI,
  withStatsigContext,
  StatsigUser,
  StatsigAI,
} from '../../src/';
import OpenAI from 'openai';

async function runConversationActivity() {
  // Create new shared instance of StatsigAI and initialize tracing
  initializeTracing({
    serviceName: 'statsig-ai-context-example',
    exporterOptions: {
      sdkKey: process.env.STATSIG_SDK_KEY!,
    },
  });
  StatsigAI.newShared({
    sdkKey: process.env.STATSIG_SDK_KEY || 'YOUR_STATSIG_SDK_KEY',
  });

  const openAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  const client = wrapOpenAI(openAI);

  const user = new StatsigUser({
    userID: 'user_123',
    customIDs: { orgID: 'org_456', sessionID: 'session_789' },
  });
  const activityID = `activity_${Date.now()}`;

  await withStatsigContext({ activityID, user }, async () => {
    // Step 1: Initial question
    console.log('\n--- Step 1: Asking for help with a task ---');
    const response1 = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content:
            'Can you help me write a function to calculate fibonacci numbers?',
        },
      ],
    });
    console.log('AI Response 1:', response1.choices[0].message.content);

    // Step 2: Follow-up question
    console.log('\n--- Step 2: Follow-up question ---');
    const response2 = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content:
            'Can you help me write a function to calculate fibonacci numbers?',
        },
        {
          role: 'assistant',
          content: response1.choices[0].message.content || '',
        },
        {
          role: 'user',
          content: 'Can you optimize it for memoization?',
        },
      ],
    });
    console.log('AI Response 2:', response2.choices[0].message.content);

    // Step 3: Final clarification
    console.log('\n--- Step 3: Final clarification ---');
    const response3 = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content: 'Thanks! Can you add TypeScript types to this function?',
        },
      ],
    });
    console.log('AI Response 3:', response3.choices[0].message.content);
  });

  // ... some user interaction ...

  const userRating = 5; // Scale of 1-5
  // Log rating-specific event
  StatsigAI.shared()
    .getStatsig()
    .logEvent(user, 'ai_activity_rated', userRating, {
      activityID: activityID,
      feedback_type: userRating >= 4 ? 'positive' : 'negative',
    });

  await StatsigAI.shared().shutdown();
}

// Run the example
runConversationActivity().catch(console.error);

import { OpenAI } from 'openai';

import { wrapOpenAI } from '../../wrappers/openai';

describe('wrapOpenAI', () => {
  it('sends one request per call and leaves no unhandled rejection when it times out', async () => {
    let fetches = 0;
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const client = wrapOpenAI(
        new OpenAI({
          apiKey: 'test',
          maxRetries: 0,
          timeout: 20,
          fetch: (_url: unknown, init?: { signal?: AbortSignal | null }) => {
            fetches++;
            return new Promise<never>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(
                  Object.assign(new Error('aborted'), { name: 'AbortError' }),
                ),
              );
            });
          },
        }),
      );

      await expect(
        client.responses.create({ model: 'gpt-4o-mini', input: 'hi' }),
      ).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
      await expect(
        client.responses.create({
          model: 'gpt-4o-mini',
          input: 'hi',
          stream: true,
        }),
      ).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);

      // Unhandled-rejection detection runs on a later macrotask turn.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fetches).toBe(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', listener);
    }
  });
});

import { context as otelContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { StatsigUser } from '@statsig/statsig-node-core';

import { Prompt } from '../prompts/Prompt';
import { PromptVersion } from '../prompts/PromptVersion';
import {
  STATSIG_CTX_KEY_ACTIVE_PROMPT,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION,
} from '../otel/conventions';
import { getUserFromContext } from '../otel/user-context';

describe('Prompt context helpers', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let user: StatsigUser;
  let liveVersion: PromptVersion;
  let prompt: Prompt;

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    try {
      otelContext.setGlobalContextManager(contextManager);
    } catch (err) {
      // ignore if one already exists
    }
  });

  afterAll(() => {
    otelContext.disable();
    contextManager.disable();
  });

  beforeEach(() => {
    user = new StatsigUser({
      userID: 'prompt-user',
      customIDs: { cohort: 'beta' },
    });
    liveVersion = {
      getName: jest.fn(() => 'VersionA'),
    } as unknown as PromptVersion;
    prompt = new Prompt(user, 'example-prompt', liveVersion, []);
  });

  it('prompt.withLive sets prompt and user metadata in context during execution', async () => {
    expect(
      otelContext.active().getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT),
    ).toBeUndefined();

    const result = await prompt.withLive(async (config) => {
      expect(config).toBe(liveVersion);
      const activeCtx = otelContext.active();

      expect(activeCtx.getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT)).toBe(
        'example-prompt',
      );
      expect(activeCtx.getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION)).toBe(
        'VersionA',
      );
      expect(getUserFromContext(activeCtx)).toEqual({
        userID: 'prompt-user',
        customIDs: { cohort: 'beta' },
      });

      return 'live-result';
    });

    expect(result).toBe('live-result');
    expect(
      otelContext.active().getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT),
    ).toBeUndefined();
    expect(getUserFromContext(otelContext.active())).toBeNull();
  });

  it('prompt.withContext sets prompt metadata without adding a prompt version', () => {
    const result = prompt.withContext(() => {
      const activeCtx = otelContext.active();

      expect(activeCtx.getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT)).toBe(
        'example-prompt',
      );
      expect(
        activeCtx.getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION),
      ).toBeUndefined();
      expect(getUserFromContext(activeCtx)).toEqual({
        userID: 'prompt-user',
        customIDs: { cohort: 'beta' },
      });

      return 'context-result';
    });

    expect(result).toBe('context-result');
    expect(
      otelContext.active().getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT),
    ).toBeUndefined();
    expect(getUserFromContext(otelContext.active())).toBeNull();
  });
});

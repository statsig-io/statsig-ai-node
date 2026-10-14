import { context as otelContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { StatsigUser } from '@statsig/statsig-node-core';

import { Prompt } from '../../prompts/Prompt';
import { PromptVersion } from '../../prompts/PromptVersion';
import {
  STATSIG_CTX_KEY_ACTIVE_PROMPT,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION_ID,
} from '../../otel/conventions';
import { getPromptSpanAttrsFromContext } from '../../otel/prompt-context';
import { getUserFromContext } from '../../otel/user-context';

function makeVersion(id: string, name: string): PromptVersion {
  const values: Record<string, unknown> = {
    name,
    prompts: [{ role: 'user', content: 'Answer: {{input}}' }],
  };
  const config = {
    name: `prompt_config:${id}`,
    getValue: (key: string, fallback: unknown) => values[key] ?? fallback,
  };
  return new PromptVersion(config as never, false);
}

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
      getID: jest.fn(() => 'version-a'),
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
      expect(activeCtx.getValue(STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION_ID)).toBe(
        'version-a',
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

  it('prompt.withVersion tags the given version and records its template variables', async () => {
    const candidate = makeVersion('version-b', 'VersionB');
    const other = makeVersion('version-c', 'VersionC');

    await prompt.withVersion(candidate, async (version) => {
      expect(version).toBe(candidate);
      expect(
        getPromptSpanAttrsFromContext(otelContext.active(), {
          includeTemplateVariables: true,
        }),
      ).toEqual({
        'statsig.llm.prompt_name': 'example-prompt',
        'statsig.llm.prompt_version': 'VersionB',
        'statsig.llm.prompt_version_id': 'version-b',
      });

      candidate.getPromptMessages({ input: 'hello' });
      // Rendering a version the scope isn't for leaves the variables alone.
      other.getPromptMessages({ input: 'ignored' });

      const attrs = getPromptSpanAttrsFromContext(otelContext.active(), {
        includeTemplateVariables: true,
      });
      expect(attrs['statsig.llm.prompt_template_variables']).toEqual({
        input: 'hello',
      });
      expect(
        getPromptSpanAttrsFromContext(otelContext.active(), {
          includeTemplateVariables: false,
        }),
      ).not.toHaveProperty('statsig.llm.prompt_template_variables');
    });
  });

  it('getPromptMessages outside a version scope renders without recording anything', () => {
    const version = makeVersion('version-b', 'VersionB');
    expect(version.getPromptMessages({ input: 'hi' })).toEqual([
      { role: 'user', content: 'Answer: hi' },
    ]);
    expect(
      getPromptSpanAttrsFromContext(otelContext.active(), {
        includeTemplateVariables: true,
      }),
    ).toEqual({});
  });
});

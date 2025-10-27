import { MockScrapi } from './MockScrapi';
import { Statsig, StatsigOptions } from '@statsig/statsig-node-core';
import { StatsigAI } from '..';
import { StatsigUser } from '@statsig/statsig-node-core';
import fs from 'fs';
import path from 'path';

describe('Prompt Targeting', () => {
  let statsigAI: StatsigAI;
  let scrapi: MockScrapi;
  let options: StatsigOptions;
  const sdkKey = 'secret-test-key';

  beforeAll(async () => {
    scrapi = await MockScrapi.create();
    const dcs = fs.readFileSync(
      path.join(__dirname, 'eval_proj_dcs_targeting.json'),
      'utf8',
    );
    scrapi.mock('/v2/download_config_specs', dcs, {
      status: 200,
      method: 'GET',
    });

    scrapi.mock('/v1/log_event', '{"success": true}', {
      status: 202,
      method: 'POST',
    });
    options = {
      specsUrl: scrapi.getUrlForPath('/v2/download_config_specs'),
      logEventUrl: scrapi.getUrlForPath('/v1/log_event'),
    };
  });

  afterEach(async () => {
    if (statsigAI) {
      await statsigAI.shutdown();
    }
  });

  afterAll(() => {
    scrapi.close();
  });

  it('should support targeting rules', async () => {
    statsigAI = new StatsigAI({
      sdkKey: sdkKey,
      statsigOptions: options,
    });
    await statsigAI.initialize();
    const user = new StatsigUser({
      userID: 'test-user',
    });
    const prompt = statsigAI.getPrompt(user, 'test-prompt-1');
    const liveVersion = prompt.getLive();
    expect(liveVersion).toBeDefined();
    expect(liveVersion.getID()).toBe('2QGncLi0YSYj9zavJ825qB');
    expect(liveVersion.getName()).toBe('Version 1');
    expect(liveVersion.getTemperature()).toBe(0);
    expect(liveVersion.getMaxTokens()).toBe(1000);
    expect(liveVersion.getTopP()).toBe(1);
    expect(liveVersion.getFrequencyPenalty()).toBe(0);
    expect(liveVersion.getPresencePenalty()).toBe(0);
    expect(liveVersion.getProvider()).toBe('openai');
    expect(liveVersion.getModel()).toBe('gpt-4o');
    expect(liveVersion.getWorkflowBody()).toBeDefined();
    expect(liveVersion.getEvalModel()).toBe('gpt-5');
    expect(liveVersion.getType()).toBe('Live');
    expect(liveVersion.getPromptName()).toBe('test-prompt-2');
  });

  it('should support nested targeting rules', async () => {
    statsigAI = new StatsigAI({
      sdkKey: sdkKey,
      statsigOptions: options,
    });
    await statsigAI.initialize();
    const user = new StatsigUser({
      userID: 'test-user-1',
    });
    const prompt = statsigAI.getPrompt(user, 'test-prompt-1');
    const liveVersion = prompt.getLive();
    expect(liveVersion).toBeDefined();
    expect(liveVersion.getID()).toBe('36qqmfh8wHcKzjmX2My2RQ');
    expect(liveVersion.getName()).toBe('Version 1');
    expect(liveVersion.getTemperature()).toBe(2);
    expect(liveVersion.getMaxTokens()).toBe(1000);
    expect(liveVersion.getTopP()).toBe(1);
    expect(liveVersion.getFrequencyPenalty()).toBe(0);
    expect(liveVersion.getPresencePenalty()).toBe(0);
    expect(liveVersion.getProvider()).toBe('openai');
    expect(liveVersion.getModel()).toBe('gpt-4.1');
    expect(liveVersion.getWorkflowBody()).toBeDefined();
    expect(liveVersion.getEvalModel()).toBe('gpt-5');
    expect(liveVersion.getType()).toBe('Live');
    expect(liveVersion.getPromptName()).toBe('test-prompt-3');
  });

  it('should handle circular targeting rules gracefully without crashing', async () => {
    statsigAI = new StatsigAI({ sdkKey: sdkKey, statsigOptions: options });
    await statsigAI.initialize();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const user = new StatsigUser({
      userID: 'test-user-circular',
    });

    // This should not crash despite circular targeting rules
    // circular-a -> circular-b -> circular-a (circular reference)
    const prompt = statsigAI.getPrompt(user, 'test-prompt-circular-a');

    // Should return a valid prompt object
    expect(prompt).toBeDefined();
    expect(prompt.getLive).toBeDefined();

    const liveVersion = prompt.getLive();

    // Should fall back to the base prompt when circular reference is detected
    expect(liveVersion).toBeDefined();
    expect(liveVersion.getName()).toBe('Circular A Version');
    expect(liveVersion.getTemperature()).toBe(1);
    expect(liveVersion.getMaxTokens()).toBe(500);
    expect(liveVersion.getProvider()).toBe('openai');
    expect(liveVersion.getModel()).toBe('gpt-4');
    expect(liveVersion.getPromptName()).toBe('test-prompt-circular-a');

    // Verify that a warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Statsig] Max targeting depth'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('test-prompt-circular-a'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Possible circular reference'),
    );

    // Clean up spy
    warnSpy.mockRestore();
  });
});

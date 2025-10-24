import { MockScrapi } from './MockScrapi';
import { Statsig, StatsigOptions } from '@statsig/statsig-node-core';
import { StatsigAI } from '..';
import { StatsigUser } from '@statsig/statsig-node-core';
import fs from 'fs';
import path from 'path';

describe('Prompt Serving', () => {
  let statsig: Statsig;
  let statsigAI: StatsigAI;
  let scrapi: MockScrapi;
  let options: StatsigOptions;
  const sdkKey = 'secret-test-key';

  beforeAll(async () => {
    scrapi = await MockScrapi.create();
    const dcs = fs.readFileSync(
      path.join(__dirname, 'eval_proj_dcs.json'),
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
    if (statsig) {
      await statsig.shutdown();
    }
    if (statsigAI) {
      await statsigAI.shutdown();
    }
  });

  afterAll(() => {
    scrapi.close();
  });

  it('should get the correct config for a prompt', async () => {
    statsig = new Statsig(sdkKey, options);
    await statsig.initialize();
    statsigAI = new StatsigAI(sdkKey, statsig);
    await statsigAI.initialize();
    const user = new StatsigUser({
      userID: 'test-user-1234',
    });
    const prompt = statsigAI.getPrompt(user, 'test-prompt-1');
    expect(prompt).toBeDefined();
    expect(prompt.getName()).toBe('test-prompt-1');
  });

  it('should get the correct live prompt version', async () => {
    statsig = new Statsig(sdkKey, options);
    await statsig.initialize();
    statsigAI = new StatsigAI(sdkKey, statsig);
    await statsigAI.initialize();
    const user = new StatsigUser({
      userID: 'test-user-1234',
    });
    const prompt = statsigAI.getPrompt(user, 'test-prompt-1');
    const liveVersion = prompt.getLive();
    expect(liveVersion).toBeDefined();
    expect(liveVersion.getID()).toBe('2zMuUzehqVugoL5CaS08xh');
    expect(liveVersion.getName()).toBe('Version 1');
    expect(liveVersion.getTemperature()).toBe(1);
    expect(liveVersion.getMaxTokens()).toBe(1000);
    expect(liveVersion.getTopP()).toBe(1);
    expect(liveVersion.getFrequencyPenalty()).toBe(0);
    expect(liveVersion.getPresencePenalty()).toBe(0);
    expect(liveVersion.getProvider()).toBe('openai');
    expect(liveVersion.getModel()).toBe('gpt-5');
    expect(liveVersion.getWorkflowBody()).toBeDefined();
    expect(liveVersion.getEvalModel()).toBe('gpt-5');
    expect(liveVersion.getType()).toBe('Live');
    expect(liveVersion.getAIConfigName()).toBe('test-prompt-1');
  });

  it('should support targeting rules', async () => {
    statsig = new Statsig(sdkKey, options);
    await statsig.initialize();
    statsigAI = new StatsigAI(sdkKey, statsig);
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
    expect(liveVersion.getAIConfigName()).toBe('test-prompt-2');
  });

  it('should support nested targeting rules', async () => {
    statsig = new Statsig(sdkKey, options);
    await statsig.initialize();
    statsigAI = new StatsigAI(sdkKey, statsig);
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
    expect(liveVersion.getAIConfigName()).toBe('test-prompt-3');
  });

  it('should get the correct candidate prompt versions', async () => {
    statsig = new Statsig(sdkKey, options);
    await statsig.initialize();
    statsigAI = new StatsigAI(sdkKey, statsig);
    await statsigAI.initialize();
    const user = new StatsigUser({
      userID: 'test-user-1234',
    });
    const prompt = statsigAI.getPrompt(user, 'test-prompt-1');
    const candidateVersions = prompt.getCandidates();
    expect(candidateVersions).toBeDefined();
    expect(candidateVersions.length).toBe(2);

    expect(candidateVersions[0].getID()).toBe('6p8nIvJsfMW7Awnum7aZk5');
    expect(candidateVersions[0].getName()).toBe('Version 2');

    expect(candidateVersions[1].getID()).toBe('6tNdowtW2qiWkaUhK1H8UU');
    expect(candidateVersions[1].getName()).toBe('Version 3');
  });
});

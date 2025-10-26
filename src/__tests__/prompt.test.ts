import { MockScrapi } from './MockScrapi';
import { Statsig, StatsigOptions } from '@statsig/statsig-node-core';
import { StatsigAI } from '..';
import { StatsigUser } from '@statsig/statsig-node-core';
import fs from 'fs';
import path from 'path';

describe('Prompt Serving', () => {
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
    if (statsigAI) {
      await statsigAI.shutdown();
    }
  });

  afterAll(() => {
    scrapi.close();
  });

  it('should get the correct config for a prompt', async () => {
    statsigAI = new StatsigAI({
      sdkKey: sdkKey,
      statsigOptions: options,
    });
    await statsigAI.initialize();
    const user = new StatsigUser({
      userID: 'test-user',
    });
    const prompt = statsigAI.getPrompt(user, 'test_prompt');
    expect(prompt).toBeDefined();
    expect(prompt.getName()).toBe('test_prompt');
  });

  it('should get the correct live prompt version', async () => {
    statsigAI = new StatsigAI({
      sdkKey: sdkKey,
      statsigOptions: options,
    });
    await statsigAI.initialize();
    const user = new StatsigUser({
      userID: 'test-user',
    });
    const prompt = statsigAI.getPrompt(user, 'test_prompt');
    const liveVersion = prompt.getLive();
    expect(liveVersion).toBeDefined();
    expect(liveVersion.getID()).toBe('6KGzeo8TR9JTL7CZl7vccd');
    expect(liveVersion.getName()).toBe('Version 1');
    expect(liveVersion.getTemperature()).toBe(1);
    expect(liveVersion.getMaxTokens()).toBe(1000);
    expect(liveVersion.getTopP()).toBe(1);
    expect(liveVersion.getFrequencyPenalty()).toBe(0);
    expect(liveVersion.getPresencePenalty()).toBe(0);
    expect(liveVersion.getProvider()).toBe('openai');
    expect(liveVersion.getModel()).toBe('gpt-5');
    expect(liveVersion.getWorkflowBody()).toBeDefined();
    expect(liveVersion.getEvalModel()).toBe('gpt-4o-mini');
    expect(liveVersion.getType()).toBe('Live');
    expect(liveVersion.getAIConfigName()).toBe('test_prompt');
  });

  it('should get the correct candidate prompt versions', async () => {
    statsigAI = new StatsigAI({
      sdkKey: sdkKey,
      statsigOptions: options,
    });
    await statsigAI.initialize();
    const user = new StatsigUser({
      userID: 'test-user',
    });
    const prompt = statsigAI.getPrompt(user, 'test_prompt');
    const candidateVersions = prompt.getCandidates();
    expect(candidateVersions).toBeDefined();
    expect(candidateVersions.length).toBe(2);

    expect(candidateVersions[0].getID()).toBe('7jszgFEAi1KRA2Tot6qikg');
    expect(candidateVersions[0].getName()).toBe('Version 2');

    expect(candidateVersions[1].getID()).toBe('7CKLvQvOwjj2vjx12gFO0Z');
    expect(candidateVersions[1].getName()).toBe('Version 3');
  });
});

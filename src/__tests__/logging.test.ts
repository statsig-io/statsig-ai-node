import { MockScrapi } from './MockScrapi';
import { StatsigAI } from '..';
import { StatsigOptions, StatsigUser } from '@statsig/statsig-node-core';
import fs from 'fs';
import path from 'path';

describe('Logging', () => {
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

  beforeEach(async () => {
    scrapi.clearRequests();
    statsigAI = new StatsigAI({
      sdkKey: sdkKey,
      statsigOptions: options,
    });
    await statsigAI.initialize();
  });

  afterEach(async () => {
    await statsigAI.shutdown();
  });

  afterAll(() => {
    scrapi.close();
  });

  describe('logAIGradingResult', () => {
    it('should log a grading result', async () => {
      const user = new StatsigUser({ userID: 'test-user' });
      const prompt = statsigAI.getPrompt(user, 'test_prompt');
      const promptVersion = prompt.getLive();
      statsigAI.logEvalGrade(user, promptVersion, 0.5, 'test-grader-name', {
        sessionId: 'test-session-id',
      });
      await statsigAI.flushEvents();
      const logEventRequests = scrapi
        .getLoggedEvents()
        .filter((event) => event.eventName === 'statsig::eval_result');
      const event = logEventRequests[0];
      expect(event.metadata.version_name).toBe('Version 1');
      expect(event.metadata.version_id).toBe('6KGzeo8TR9JTL7CZl7vccd');
      expect(event.metadata.score).toBe('0.5');
      expect(event.metadata.session_id).toBe('test-session-id');
      expect(event.metadata.ai_config_name).toBe('test_prompt');
      expect(event.metadata.grader_id).toBe('test-grader-name');
    });
  });
});

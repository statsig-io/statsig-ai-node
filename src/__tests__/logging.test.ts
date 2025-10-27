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
      statsigAI.logEvalGrade(user, promptVersion, 0.5, {
        sessionId: 'test-session-id',
        usePrimaryGrader: true,
      });
      await statsigAI.flushEvents();
      const logEventRequests = scrapi
        .getLoggedEvents()
        .filter((event) => event.eventName === 'statsig::eval_result');
      expect(logEventRequests.length).toBe(1);
      const event = logEventRequests[0];
      expect(logEventRequests[0].metadata.version_name).toBe('Version 1');
      expect(event.metadata.version_id).toBe('6KGzeo8TR9JTL7CZl7vccd');
      expect(event.metadata.score).toBe('0.5');
      expect(event.metadata.session_id).toBe('test-session-id');
      expect(event.metadata.use_primary_grader).toBe('true');
      expect(event.metadata.ai_config_name).toBe('test_prompt');
    });

    it('should log a grading result with a primary grader flag set to true', async () => {
      const user = new StatsigUser({ userID: 'test-user' });
      const prompt = statsigAI.getPrompt(user, 'test_prompt');
      const promptVersion = prompt.getLive();
      statsigAI.logEvalGrade(user, promptVersion, 0.75, {
        sessionId: 'test-session-id',
        usePrimaryGrader: true,
      });
      await statsigAI.flushEvents();
      const logEventRequests = scrapi
        .getLoggedEvents()
        .filter((event) => event.eventName === 'statsig::eval_result');
      console.log(logEventRequests);
      const event = logEventRequests[0];
      expect(event.metadata.version_name).toBe('Version 1');
      expect(event.metadata.version_id).toBe('6KGzeo8TR9JTL7CZl7vccd');
      expect(event.metadata.score).toBe('0.75');
      expect(event.metadata.session_id).toBe('test-session-id');
      expect(event.metadata.ai_config_name).toBe('test_prompt');

      expect(event.metadata.use_primary_grader).toBe('true');
    });

    it('should log a grading result with a grader name', async () => {
      const user = new StatsigUser({ userID: 'test-user' });
      const prompt = statsigAI.getPrompt(user, 'test_prompt');
      const promptVersion = prompt.getLive();
      statsigAI.logEvalGrade(user, promptVersion, 0.5, {
        sessionId: 'test-session-id',
        usePrimaryGrader: false,
        graderName: 'test-grader-name',
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
      expect(event.metadata.use_primary_grader).toBe('false');
      expect(event.metadata.ai_config_name).toBe('test_prompt');
      expect(event.metadata.grader_name).toBe('test-grader-name');
    });

    it('should log a grading result with a primary grader flag set to true and a grader name', async () => {
      const user = new StatsigUser({ userID: 'test-user' });
      const prompt = statsigAI.getPrompt(user, 'test_prompt');
      const promptVersion = prompt.getLive();
      // @ts-expect-error — intentionally testing edge case for untyped usage
      statsigAI.logEvalGrade(user, promptVersion, 0.75, {
        sessionId: 'test-session-id',
        usePrimaryGrader: true,
        graderName: 'test-grader-name',
      });
      await statsigAI.flushEvents();
      const logEventRequests = scrapi
        .getLoggedEvents()
        .filter((event) => event.eventName === 'statsig::eval_result');
      const event = logEventRequests[0];
      expect(event.metadata.version_name).toBe('Version 1');
      expect(event.metadata.version_id).toBe('6KGzeo8TR9JTL7CZl7vccd');
      expect(event.metadata.score).toBe('0.75');
      expect(event.metadata.session_id).toBe('test-session-id');
      expect(event.metadata.use_primary_grader).toBe('false'); // grader name takes precedence over primary grader flag
      expect(event.metadata.ai_config_name).toBe('test_prompt');
      expect(event.metadata.grader_name).toBe('test-grader-name');
    });

    it('should log a grading result when neither usePrimaryGrader nor graderName are provided', async () => {
      const user = new StatsigUser({ userID: 'test-user' });
      const prompt = statsigAI.getPrompt(user, 'test_prompt');
      const promptVersion = prompt.getLive();
      // @ts-expect-error — intentionally testing edge case for untyped usage
      statsigAI.logEvalGrade(user, promptVersion, 0.5, {
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
      expect(event.metadata.use_primary_grader).toBe('true'); // defaulting to use_primary_grader
      expect(event.metadata.ai_config_name).toBe('test_prompt');
    });
  });
});

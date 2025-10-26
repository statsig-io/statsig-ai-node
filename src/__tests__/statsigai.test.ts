import { MockScrapi } from './MockScrapi';
import { StatsigOptions, StatsigUser } from '@statsig/statsig-node-core';
import { StatsigAI } from '..';
import fs from 'fs';
import path from 'path';

describe('StatsigAI', () => {
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
    // Clean up shared instance after each test
    if (statsigAI) {
      await statsigAI.shutdown();
    }
    StatsigAI.removeSharedInstance();
  });

  afterAll(() => {
    scrapi.close();
  });

  describe('global singleton', () => {
    it('should create a new shared instance', async () => {
      const sharedInstance = StatsigAI.newShared({
        sdkKey: sdkKey,
        statsigOptions: options,
      });

      expect(sharedInstance).toBeDefined();
      expect(sharedInstance).toBeInstanceOf(StatsigAI);
      expect(StatsigAI.hasShared()).toBe(true);
    });

    it('should return the same instance when calling shared()', async () => {
      const sharedInstance = StatsigAI.newShared({
        sdkKey: sdkKey,
        statsigOptions: options,
      });
      const retrievedInstance = StatsigAI.shared();

      expect(retrievedInstance).toBe(sharedInstance);
    });

    it('should warn and return error instance when called multiple times', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const firstInstance = StatsigAI.newShared({
        sdkKey: sdkKey,
        statsigOptions: options,
      });
      const secondInstance = StatsigAI.newShared({
        sdkKey: sdkKey,
        statsigOptions: options,
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Shared instance has been created'),
      );
      expect(secondInstance).not.toBe(firstInstance);
      expect(StatsigAI.shared()).toBe(firstInstance);

      consoleWarnSpy.mockRestore();
    });

    it('should allow creating new shared instance after removal', async () => {
      const firstInstance = StatsigAI.newShared({
        sdkKey: sdkKey,
        statsigOptions: options,
      });
      await firstInstance.shutdown();
      StatsigAI.removeSharedInstance();

      expect(StatsigAI.hasShared()).toBe(false);

      const secondInstance = StatsigAI.newShared({
        sdkKey: sdkKey,
        statsigOptions: options,
      });

      expect(secondInstance).toBeDefined();
      expect(secondInstance).not.toBe(firstInstance);
      expect(StatsigAI.hasShared()).toBe(true);
    });
  });

  describe('StatsigAI instance', () => {
    it('should be able to use statsig ai instance methods', async () => {
      statsigAI = new StatsigAI({
        sdkKey: sdkKey,
        statsigOptions: options,
      });
      await statsigAI.initialize();
      const user = new StatsigUser({ userID: 'test-user' });
      const prompt = statsigAI.getPrompt(user, 'test_prompt');

      expect(prompt).toBeDefined();
      expect(prompt.getName()).toBe('test_prompt');
    });

    it('should be able to use statsig instance methods', async () => {
      statsigAI = new StatsigAI({
        sdkKey: sdkKey,
        statsigOptions: options,
      });
      await statsigAI.initialize();
      const user = new StatsigUser({ userID: 'test-user' });
      expect(statsigAI.getStatsig().checkGate(user, 'test_public')).toBe(true);
    });
  });
});

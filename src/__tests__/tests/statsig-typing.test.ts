import {
  Statsig as StatsigStd,
  StatsigUser as StatsigUserStd,
} from '@statsig/statsig-node-core';
import {
  Statsig as StatsigRC,
  StatsigUser as StatsigUserRC,
} from '@statsig/statsig-node-core-rc';
import { StatsigAI } from '../..';

describe('Statsig Wrapper', () => {
  describe('Create Statsig instance', () => {
    it('Expect no ts error on valid StatsigUser', async () => {
      const statsigAI = StatsigAI.newShared({ sdkKey: 'secret-test-key' });
      await statsigAI.initialize();
      const user = new StatsigUserStd({ userID: 'test-user' });
      statsigAI.getPrompt(user, 'test_prompt');
    });

    it('Expect ts error on conflicting StatsigUser', async () => {
      const statsigAI = StatsigAI.newShared({ sdkKey: 'secret-test-key' });
      await statsigAI.initialize();
      const user = new StatsigUserRC({ userID: 'test-user' });
      expect(
        // @ts-expect-error - Conflicting StatsigUser type
        () => statsigAI.getPrompt(user, 'test_prompt'),
      ).toThrow('Unexpected use of conflicting Statsig library versions');
    });

    it('Expect no runtime error on valid StatsigUser', async () => {
      StatsigAI.newShared({ sdkKey: 'secret-test-key' });
      await StatsigAI.shared().initialize();
      const user = new StatsigUserStd({ userID: 'test-user' });
      StatsigAI.shared().getPrompt(user, 'test_prompt');
    });

    it('Expect runtime error on conflicting StatsigUser', async () => {
      StatsigAI.newShared({ sdkKey: 'secret-test-key' });
      await StatsigAI.shared().initialize();
      const user = new StatsigUserRC({ userID: 'test-user' });
      expect(() => StatsigAI.shared().getPrompt(user, 'test_prompt')).toThrow(
        'Unexpected use of conflicting Statsig library versions',
      );
    });
  });

  describe('Attach Statsig instance', () => {
    it('Expect no ts error on valid StatsigUser', async () => {
      const statsig = new StatsigStd('secret-test-key');
      const statsigAI = StatsigAI.newShared({ statsig: statsig });
      await statsigAI.initialize();
      const user = new StatsigUserStd({ userID: 'test-user' });
      statsigAI.getPrompt(user, 'test_prompt');
    });

    it('Expect ts error on conflicting StatsigUser', async () => {
      const statsig = new StatsigStd('secret-test-key');
      const statsigAI = StatsigAI.newShared({ statsig: statsig });
      await statsigAI.initialize();
      const user = new StatsigUserRC({ userID: 'test-user' });
      expect(
        // @ts-expect-error - Conflicting StatsigUser type
        () => statsigAI.getPrompt(user, 'test_prompt'),
      ).toThrow('Unexpected use of conflicting Statsig library versions');
    });

    it('Expect no runtime error on valid StatsigUser', async () => {
      const statsig = new StatsigStd('secret-test-key');
      StatsigAI.newShared({ statsig: statsig });
      await StatsigAI.shared().initialize();
      const user = new StatsigUserStd({ userID: 'test-user' });
      StatsigAI.shared().getPrompt(user, 'test_prompt');
    });

    it('Expect runtime error on conflicting StatsigUser', async () => {
      const statsig = new StatsigStd('secret-test-key');
      StatsigAI.newShared({ statsig: statsig });
      await StatsigAI.shared().initialize();
      const user = new StatsigUserRC({ userID: 'test-user' });
      expect(() => StatsigAI.shared().getPrompt(user, 'test_prompt')).toThrow(
        'Unexpected use of conflicting Statsig library versions',
      );
    });
  });

  afterEach(async () => {
    await StatsigAI.shared().shutdown();
    StatsigAI.removeSharedInstance();
  });
});

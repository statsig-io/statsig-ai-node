import { MockScrapi } from '../shared/MockScrapi';
import {
  Statsig,
  StatsigOptions,
  StatsigUser,
} from '@statsig/statsig-node-core';
import { StatsigAI } from '../..';
import fs from 'fs';
import { getDCSFilePath } from '../shared/utils';

// Simulates installs where the optional rc peer is missing, as it is for
// anyone installing from public npm.
jest.mock('@statsig/statsig-node-core-rc', () => {
  throw Object.assign(
    new Error("Cannot find module '@statsig/statsig-node-core-rc'"),
    { code: 'MODULE_NOT_FOUND' },
  );
});

describe('Without @statsig/statsig-node-core-rc installed', () => {
  let scrapi: MockScrapi;
  let options: StatsigOptions;
  const sdkKey = 'secret-test-key';

  beforeAll(async () => {
    scrapi = await MockScrapi.create();
    const dcs = fs.readFileSync(getDCSFilePath('eval_proj_dcs.json'), 'utf8');
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
    await StatsigAI.shared().shutdown();
    StatsigAI.removeSharedInstance();
  });

  afterAll(() => {
    scrapi.close();
  });

  it('loads the SDK', () => {
    expect(() => require('@statsig/statsig-node-core-rc')).toThrow(
      "Cannot find module '@statsig/statsig-node-core-rc'",
    );
    expect(() => require('../..')).not.toThrow();
  });

  it('serves prompts and logs grades with a std Statsig instance', async () => {
    const statsig = new Statsig(sdkKey, options);
    await statsig.initialize();
    const statsigAI = StatsigAI.newShared({ statsig });
    const user = new StatsigUser({ userID: 'test-user' });

    const liveVersion = statsigAI.getPrompt(user, 'test_prompt').getLive();
    expect(liveVersion.getID()).toBe('6KGzeo8TR9JTL7CZl7vccd');
    expect(() =>
      statsigAI.logEvalGrade(user, liveVersion, 1, 'grader', {}),
    ).not.toThrow();

    await statsig.shutdown();
  });

  it('still throws on a user that is not a std StatsigUser', async () => {
    StatsigAI.newShared({ sdkKey, statsigOptions: options });
    await StatsigAI.shared().initialize();
    const user = {
      userID: 'test-user',
      customIDs: null,
    } as unknown as StatsigUser;
    expect(() => StatsigAI.shared().getPrompt(user, 'test_prompt')).toThrow(
      'Unexpected use of conflicting Statsig library versions',
    );
  });
});

import { DynamicConfig, StatsigUser } from '@statsig/statsig-node-core';

import { PromptVersion } from '../prompts/PromptVersion';

export class AgentVersion {
  private _rootPrompt: PromptVersion;

  constructor(rootConfig: DynamicConfig, isLiveForUser: boolean) {
    this._rootPrompt = new PromptVersion(rootConfig, isLiveForUser);
  }

  getRoot(): PromptVersion {
    return this._rootPrompt;
  }
}

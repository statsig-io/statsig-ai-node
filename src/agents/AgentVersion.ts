import { DynamicConfig, StatsigUser } from '@statsig/statsig-node-core';

import { PromptVersion } from '../prompts/PromptVersion';

export class AgentVersion {
  private _rootPrompt: PromptVersion;

  constructor(rootConfig: DynamicConfig) {
    this._rootPrompt = new PromptVersion(rootConfig);
  }

  getRoot(): PromptVersion {
    return this._rootPrompt;
  }
}

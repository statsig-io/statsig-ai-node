import { DynamicConfig } from '@statsig/statsig-node-core';
import { DynamicConfigRC } from '../wrappers/statsig';
import { PromptVersion } from '../prompts/PromptVersion';

export class AgentVersion {
  private _rootPrompt: PromptVersion;

  constructor(
    rootConfig: DynamicConfig | DynamicConfigRC,
    isLiveForUser: boolean,
  ) {
    this._rootPrompt = new PromptVersion(rootConfig, isLiveForUser);
  }

  getRoot(): PromptVersion {
    return this._rootPrompt;
  }
}

import {
  DynamicConfig,
  ParameterStore,
  StatsigUser,
} from '@statsig/statsig-node-core';

import { PromptVersion } from './PromptVersion';
import { StatsigServer } from '../StatsigServer';

export function makePrompt(
  statsig: StatsigServer,
  name: string,
  paramStore: ParameterStore,
  user: StatsigUser,
): Prompt {
  const liveConfigId = paramStore.getValue('live', '');
  const candidateConfigIds = paramStore.getValue('candidates', []);
  const liveConfig = statsig.getDynamicConfig(user, liveConfigId);
  const candidateConfigs = candidateConfigIds.map((id) =>
    statsig.getDynamicConfig(user, id),
  );

  return new Prompt(
    name,
    new PromptVersion(liveConfig),
    candidateConfigs.map((config) => new PromptVersion(config)),
  );
}
export class Prompt {
  public name: string;
  private _liveConfig: PromptVersion;
  private _candidateConfigs: PromptVersion[];
  constructor(
    name: string,
    liveConfig: PromptVersion,
    candidateConfigs: PromptVersion[],
  ) {
    this.name = name;
    this._liveConfig = liveConfig;
    this._candidateConfigs = candidateConfigs;
  }

  getName(): string {
    return this.name;
  }

  getLiveConfig(): PromptVersion {
    return this._liveConfig;
  }

  getCandidateConfigs(): PromptVersion[] {
    return this._candidateConfigs;
  }
}

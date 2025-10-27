import { ParameterStore, StatsigUser } from '@statsig/statsig-node-core';

import { PromptVersion } from './PromptVersion';
import { Statsig } from '@statsig/statsig-node-core';

export function makePrompt(
  statsig: Statsig,
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
  public readonly name: string;
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

  getLive(): PromptVersion {
    return this._liveConfig;
  }

  getCandidates(): PromptVersion[] {
    return this._candidateConfigs;
  }
}

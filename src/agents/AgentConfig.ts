import {
  DynamicConfig,
  ParameterStore,
  StatsigUser,
} from '@statsig/statsig-node-core';

import { AgentVersion } from './AgentVersion';
import { Statsig } from '@statsig/statsig-node-core';

export function makeAgentConfig(
  statsig: Statsig,
  user: StatsigUser,
  name: string,
  paramStore: ParameterStore,
): AgentConfig {
  const liveDAGConfigId = paramStore.getValue('live', '');
  const candidateDAGConfigIds = paramStore.getValue('candidates', []);

  const liveDAGConfig = statsig.getDynamicConfig(user, liveDAGConfigId);
  const liveRootConfig = statsig.getDynamicConfig(
    user,
    liveDAGConfig.getValue('root', ''),
  );

  const candidateRootAgents = candidateDAGConfigIds.map((id) => {
    const config = statsig.getDynamicConfig(user, id);
    const rootConfig = statsig.getDynamicConfig(
      user,
      config.getValue('root', ''),
    );
    return new AgentVersion(rootConfig);
  });

  return new AgentConfig(
    name,
    new AgentVersion(liveRootConfig),
    candidateRootAgents,
  );
}

export class AgentConfig {
  public name: string;
  private _liveDAGConfig: AgentVersion;
  private _candidateDAGConfigs: AgentVersion[];

  constructor(
    name: string,
    liveDAGConfig: AgentVersion,
    candidateDAGConfigs: AgentVersion[],
  ) {
    this.name = name;
    this._liveDAGConfig = liveDAGConfig;
    this._candidateDAGConfigs = candidateDAGConfigs;
  }

  getLive(): AgentVersion {
    return this._liveDAGConfig;
  }

  getCandidates(): AgentVersion[] {
    return this._candidateDAGConfigs;
  }
}

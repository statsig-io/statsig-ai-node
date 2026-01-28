import { AgentVersion } from './AgentVersion';

import Statsig, { StatsigSelector } from '../wrappers/statsig';

export function makeAgentConfig<T extends StatsigSelector>(
  statsig: T['statsig'],
  user: T['user'],
  name: string,
  paramStore: T['paramStore'],
): AgentConfig {
  const liveDAGConfigId = paramStore.getValue('live', '');
  const candidateDAGConfigIds = paramStore.getValue('candidates', []);

  const liveDAGConfig = Statsig.getDynamicConfig(
    statsig,
    user,
    liveDAGConfigId,
  );
  const liveRootConfig = Statsig.getDynamicConfig(
    statsig,
    user,
    liveDAGConfig.getValue('root', ''),
  );

  const candidateRootAgents = candidateDAGConfigIds.map((id) => {
    const config = Statsig.getDynamicConfig(statsig, user, id);
    const rootConfig = Statsig.getDynamicConfig(
      statsig,
      user,
      config.getValue('root', ''),
    );
    return new AgentVersion(rootConfig, false);
  });

  return new AgentConfig(
    name,
    new AgentVersion(liveRootConfig, true),
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

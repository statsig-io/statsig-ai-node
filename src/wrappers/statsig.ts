import {
  Statsig as StatsigStd,
  StatsigOptions as StatsigOptionsStd,
  StatsigUser as StatsigUserStd,
  ParameterStore as ParameterStoreStd,
  DynamicConfig as DynamicConfigStd,
} from '@statsig/statsig-node-core';
import {
  Statsig as StatsigRC,
  StatsigUser as StatsigUserRC,
  StatsigOptions as StatsigOptionsRC,
  ParameterStore as ParameterStoreRC,
  DynamicConfig as DynamicConfigRC,
} from '@statsig/statsig-node-core-rc';
import { ExhaustSwitchError } from '../utils/ExhaustSwitchError';

export type STD = {
  type: 'std';
  statsig: StatsigStd;
  options: StatsigOptionsStd;
  user: StatsigUserStd;
  dynamicConfig: DynamicConfigStd;
  paramStore: ParameterStoreStd;
};

export type RC = {
  type: 'rc';
  statsig: StatsigRC;
  options: StatsigOptionsRC;
  user: StatsigUserRC;
  dynamicConfig: DynamicConfigRC;
  paramStore: ParameterStoreRC;
};

export type StatsigSelector = STD | RC;

export default class Statsig {
  private static getCorrelatedUnion(
    statsig: StatsigSelector['statsig'],
    user: StatsigSelector['user'],
  ):
    | Pick<STD, 'type' | 'statsig' | 'user'>
    | Pick<RC, 'type' | 'statsig' | 'user'> {
    if (statsig instanceof StatsigStd && user instanceof StatsigUserStd) {
      return { type: 'std', statsig, user };
    }
    if (statsig instanceof StatsigRC && user instanceof StatsigUserRC) {
      return { type: 'rc', statsig, user };
    }
    throw new Error('Unexpected use of conflicting Statsig library versions');
  }

  static getDynamicConfig<T extends StatsigSelector>(
    statsig: T['statsig'],
    user: T['user'],
    configName: string,
  ): T['dynamicConfig'] {
    const {
      type,
      statsig: statsigTyped,
      user: userTyped,
    } = this.getCorrelatedUnion(statsig, user);
    switch (type) {
      case 'std':
        return statsigTyped.getDynamicConfig(userTyped, configName);
      case 'rc':
        return statsigTyped.getDynamicConfig(userTyped, configName);
      default:
        throw new ExhaustSwitchError(type);
    }
  }

  static getParameterStore<T extends StatsigSelector>(
    statsig: T['statsig'],
    user: T['user'],
    paramStoreName: string,
  ): T['paramStore'] {
    const {
      type,
      statsig: statsigTyped,
      user: userTyped,
    } = this.getCorrelatedUnion(statsig, user);
    switch (type) {
      case 'std':
        return statsigTyped.getParameterStore(userTyped, paramStoreName);
      case 'rc':
        return statsigTyped.getParameterStore(userTyped, paramStoreName);
      default:
        throw new ExhaustSwitchError(type);
    }
  }

  static logEvent(
    statsig: StatsigSelector['statsig'],
    user: StatsigSelector['user'],
    eventName: string,
    value: string,
    metadata: Record<string, string> | null | undefined,
  ): void {
    const {
      type,
      statsig: statsigTyped,
      user: userTyped,
    } = this.getCorrelatedUnion(statsig, user);
    switch (type) {
      case 'std':
        return statsigTyped.logEvent(userTyped, eventName, value, metadata);
      case 'rc':
        return statsigTyped.logEvent(userTyped, eventName, value, metadata);
      default:
        throw new ExhaustSwitchError(type);
    }
  }
}

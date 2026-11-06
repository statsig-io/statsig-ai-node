import {
  Statsig as StatsigStd,
  StatsigOptions as StatsigOptionsStd,
  StatsigUser as StatsigUserStd,
  ParameterStore as ParameterStoreStd,
  DynamicConfig as DynamicConfigStd,
} from '@statsig/statsig-node-core';
import { ExhaustSwitchError } from '../utils/ExhaustSwitchError';

// @statsig/statsig-node-core-rc is an optional peer that isn't on public npm,
// so the published types can't import it. These describe its classes by the
// members this SDK uses.
export type StatsigUserRC = {
  userID: string | null;
  customIDs: Record<string, string> | null;
};

export type DynamicConfigRC = {
  readonly name: string;
  getValue(
    key: string,
    fallback?: boolean | number | string | object | Array<any> | null,
  ): unknown;
};

export type ParameterStoreRC = {
  getValue<T>(paramName: string, fallback?: T): T;
};

export type StatsigRC = {
  initialize(): Promise<unknown>;
  flushEvents(): Promise<unknown>;
  shutdown(): Promise<unknown>;
  getDynamicConfig(user: StatsigUserRC, configName: string): DynamicConfigRC;
  getParameterStore(
    user: StatsigUserRC,
    parameterStoreName: string,
  ): ParameterStoreRC;
  logEvent(
    user: StatsigUserRC,
    eventName: string,
    value?: string | number | null,
    metadata?: Record<string, string> | null,
  ): void;
};

type StatsigRCModule = {
  Statsig: new (...args: never[]) => StatsigRC;
  StatsigUser: new (...args: never[]) => StatsigUserRC;
};

let statsigRCModule: StatsigRCModule | null | undefined;

// Loaded on first use so the SDK still loads when the rc package isn't
// installed.
function loadStatsigRC(): StatsigRCModule | null {
  if (statsigRCModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      statsigRCModule = require('@statsig/statsig-node-core-rc');
    } catch {
      statsigRCModule = null;
    }
  }
  return statsigRCModule ?? null;
}

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
    const statsigRC = loadStatsigRC();
    if (
      statsigRC &&
      statsig instanceof statsigRC.Statsig &&
      user instanceof statsigRC.StatsigUser
    ) {
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

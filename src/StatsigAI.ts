import {
  StatsigCreateConfig,
  StatsigAttachConfig,
  StatsigSourceConfig,
  StatsigAIInstance,
} from './StatsigAIInstance';
import { RC, StatsigSelector, STD } from './wrappers/statsig';

export class StatsigAI extends StatsigAIInstance {
  public static _sharedAIStatsigInstance: StatsigAIInstance<StatsigSelector> | null;

  public static shared(): StatsigAIInstance<StatsigSelector> {
    if (!StatsigAI.hasShared()) {
      console.warn(
        '[Statsig] No shared instance has been created yet. Call newShared() before using it. Returning an invalid instance',
      );
      return StatsigAI._createErrorStatsigAIInstance();
    }
    return StatsigAI._sharedAIStatsigInstance!;
  }

  public static hasShared(): boolean {
    return StatsigAI._sharedAIStatsigInstance != null;
  }

  public static newShared(
    statsigInitConfig: StatsigCreateConfig,
  ): StatsigAIInstance<STD>;

  public static newShared(
    statsigInstanceConfig: StatsigAttachConfig<STD>,
  ): StatsigAIInstance<STD>;

  public static newShared(
    statsigInstanceConfig: StatsigAttachConfig<RC>,
  ): StatsigAIInstance<RC>;

  public static newShared<T extends StatsigSelector>(
    statsigSource: StatsigSourceConfig<T>,
  ): StatsigAIInstance<T> {
    if (StatsigAI.hasShared()) {
      console.warn(
        '[Statsig] Shared instance has been created, call removeSharedInstance() if you want to create another one. ' +
          'Returning an invalid instance',
      );
      return StatsigAI._createErrorStatsigAIInstance() as StatsigAIInstance<T>;
    }

    const newInstance = new StatsigAIInstance<T>(statsigSource);
    StatsigAI._sharedAIStatsigInstance = newInstance;

    return newInstance;
  }

  public static removeSharedInstance() {
    StatsigAI._sharedAIStatsigInstance = null;
  }

  private static _createErrorStatsigAIInstance(): StatsigAIInstance {
    const dummyInstance = new StatsigAIInstance({ sdkKey: 'INVALID-KEY' });
    dummyInstance.shutdown();
    return dummyInstance;
  }
}

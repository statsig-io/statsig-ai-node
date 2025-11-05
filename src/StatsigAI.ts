import {
  StatsigAIInstance,
  StatsigCreateConfig,
  StatsigAttachConfig,
  StatsigSourceConfig,
} from './StatsigAIInstance';

export class StatsigAI extends StatsigAIInstance {
  private static _sharedAIStatsigInstance: StatsigAI | null = null;

  public static shared(): StatsigAI {
    if (!StatsigAI.hasShared()) {
      console.warn(
        '[Statsig] No shared instance has been created yet. Call newShared() before using it. Returning an invalid instance',
      );
      return StatsigAI._createErrorStatsigAIInstance();
    }
    return StatsigAI._sharedAIStatsigInstance!;
  }

  public static hasShared(): boolean {
    return StatsigAI._sharedAIStatsigInstance !== null;
  }

  public static newShared(statsigInitConfig: StatsigCreateConfig): StatsigAI;

  public static newShared(
    statsigInstanceConfig: StatsigAttachConfig,
  ): StatsigAI;

  public static newShared(statsigSource: StatsigSourceConfig): StatsigAI {
    if (StatsigAI.hasShared()) {
      console.warn(
        '[Statsig] Shared instance has been created, call removeSharedInstance() if you want to create another one. ' +
          'Returning an invalid instance',
      );
      return StatsigAI._createErrorStatsigAIInstance();
    }

    StatsigAI._sharedAIStatsigInstance = new StatsigAI(statsigSource);

    return StatsigAI._sharedAIStatsigInstance;
  }

  public static removeSharedInstance() {
    StatsigAI._sharedAIStatsigInstance = null;
  }

  private static _createErrorStatsigAIInstance(): StatsigAI {
    const dummyInstance = new StatsigAI({ sdkKey: 'INVALID-KEY' });
    dummyInstance.shutdown();
    return dummyInstance;
  }
}

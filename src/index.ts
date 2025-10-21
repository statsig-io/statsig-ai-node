export * from '@statsig/statsig-node-core';
import { StatsigOptions } from '@statsig/statsig-node-core';
import { StatsigServer } from './StatsigServer';
import { Prompt } from './prompts/Prompt';
import { PromptVersion } from './prompts/PromptVersion';
import { AgentVersion } from './agents/AgentVersion';
import { AIEvalResult } from './AIEvalResult';
import { AgentConfig } from './agents/AgentConfig';
import { PromptEvaluationOptions } from './prompts/PromptEvalOptions';
import { wrapOpenAI } from './wrappers/openai';

export {
  Prompt,
  PromptVersion,
  AgentVersion,
  AIEvalResult,
  AgentConfig,
  PromptEvaluationOptions,
  wrapOpenAI,
};
// @ts-expect-error - StatsigServer extends StatsigCore, which has a different return type for getPrompt
export class Statsig extends StatsigServer {
  private static _sharedAIStatsigInstance: Statsig | null = null;

  public static shared(): Statsig {
    if (!Statsig.hasShared()) {
      console.warn(
        '[Statsig] No shared instance has been created yet. Call newShared() before using it. Returning an invalid instance',
      );
      return Statsig._createErrorStatsigAIInstance();
    }
    return Statsig._sharedAIStatsigInstance!;
  }

  public static hasShared(): boolean {
    return Statsig._sharedAIStatsigInstance !== null;
  }

  public static newShared(sdkKey: string, options?: StatsigOptions): Statsig {
    if (Statsig.hasShared()) {
      console.warn(
        '[Statsig] Shared instance has been created, call removeSharedInstance() if you want to create another one. ' +
          'Returning an invalid instance',
      );
      return Statsig._createErrorStatsigAIInstance();
    }

    Statsig._sharedAIStatsigInstance = new Statsig(sdkKey, options);
    return Statsig._sharedAIStatsigInstance;
  }

  public static removeSharedInstance() {
    Statsig._sharedAIStatsigInstance = null;
  }

  private static _createErrorStatsigAIInstance(): Statsig {
    const dummyInstance = new Statsig('INVALID-KEY');
    dummyInstance.shutdown();
    return dummyInstance;
  }
}

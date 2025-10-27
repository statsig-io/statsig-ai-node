export * from '@statsig/statsig-node-core';
import {
  StatsigAIInstance,
  StatsigCreateConfig,
  StatsigAttachConfig,
  StatsigSourceConfig,
} from './StatsigAI';
import { Prompt } from './prompts/Prompt';
import { PromptVersion } from './prompts/PromptVersion';
import { AgentVersion } from './agents/AgentVersion';
import { AIEvalGradeData } from './AIGradingData';
import { AgentConfig } from './agents/AgentConfig';
import { PromptEvaluationOptions } from './prompts/PromptEvalOptions';
import { wrapOpenAI } from './wrappers/openai';
import { StatsigAIOptions } from './StatsigAIOptions';
import { initializeTracing } from './otel/otel-v2';
import { StatsigSpanProcessor } from './otel/processor';
import { StatsigOTLPTraceExporter } from './otel/exporter';
import { withStatsigUserContext } from './otel/user-context';

export {
  Prompt,
  PromptVersion,
  AgentVersion,
  AIEvalGradeData,
  AgentConfig,
  PromptEvaluationOptions,
  wrapOpenAI,
  initializeTracing,
  withStatsigUserContext,
  StatsigSpanProcessor,
  StatsigOTLPTraceExporter,
};
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

  public static newShared(
    statsigInitConfig: StatsigCreateConfig,
    aiOptions?: StatsigAIOptions,
  ): StatsigAI;

  public static newShared(
    statsigInstanceConfig: StatsigAttachConfig,
    aiOptions?: StatsigAIOptions,
  ): StatsigAI;

  public static newShared(
    statsigSource: StatsigSourceConfig,
    aiOptions?: StatsigAIOptions,
  ): StatsigAI {
    if (StatsigAI.hasShared()) {
      console.warn(
        '[Statsig] Shared instance has been created, call removeSharedInstance() if you want to create another one. ' +
          'Returning an invalid instance',
      );
      return StatsigAI._createErrorStatsigAIInstance();
    }

    StatsigAI._sharedAIStatsigInstance = new StatsigAI(
      statsigSource,
      aiOptions,
    );

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

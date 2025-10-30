import {
  Statsig,
  StatsigOptions,
  StatsigUser,
} from '@statsig/statsig-node-core';

import { AgentConfig, makeAgentConfig } from './agents/AgentConfig';
import { AIEvalGradeData } from './AIGradingData';
import { Otel } from './otel/otel';
import { makePrompt, Prompt } from './prompts/Prompt';
import { PromptEvaluationOptions } from './prompts/PromptEvalOptions';
import { StatsigAIOptions } from './StatsigAIOptions';
import { IOtelClient } from './otel/IOtelClient';
import { PromptVersion } from './prompts/PromptVersion';

export interface StatsigCreateConfig {
  sdkKey: string;
  statsigOptions?: StatsigOptions;
  statsig?: never;
}

export interface StatsigAttachConfig {
  sdkKey: string;
  statsig: Statsig;
  statsigOptions?: never;
}

export type StatsigSourceConfig = StatsigCreateConfig | StatsigAttachConfig;

export class StatsigAIInstance {
  private _otel: IOtelClient | null = null;
  private _statsig: Statsig;
  private _ownsStatsigInstance: boolean = false;

  constructor(
    statsigSource: StatsigSourceConfig,
    aiOptions?: StatsigAIOptions,
  ) {
    if ('statsig' in statsigSource && statsigSource.statsig) {
      const { sdkKey, statsig } = statsigSource;
      this._statsig = statsig;
      this._ownsStatsigInstance = false;
      this._setUpOtel(sdkKey, aiOptions);
    } else {
      const { sdkKey, statsigOptions } = statsigSource;
      this._statsig = new Statsig(sdkKey, statsigOptions);
      this._ownsStatsigInstance = true;
      this._setUpOtel(sdkKey, aiOptions);
    }
  }

  async initialize(): Promise<void> {
    if (this._ownsStatsigInstance) {
      await this._statsig.initialize();
    }
    await this._otel?.initialize();
  }

  async flushEvents(): Promise<void> {
    if (this._ownsStatsigInstance) {
      await this._statsig.flushEvents();
    }
    await this._otel?.flush();
  }

  async shutdown(): Promise<void> {
    if (this._ownsStatsigInstance) {
      await this._statsig.shutdown();
    }
    await this._otel?.shutdown();
  }

  getStatsig(): Statsig {
    return this._statsig;
  }

  getPrompt(
    user: StatsigUser,
    promptName: string,
    _options?: PromptEvaluationOptions,
  ): Prompt {
    const MAX_DEPTH = 300;
    let depth = 0;

    const baseParamStoreName = `prompt:${promptName}`;
    let currentParamStoreName = baseParamStoreName;

    let nextParamStoreName = this._statsig
      .getParameterStore(user, currentParamStoreName)
      .getValue('prompt_targeting_rules', '');

    while (
      nextParamStoreName !== '' &&
      nextParamStoreName !== currentParamStoreName &&
      depth < MAX_DEPTH
    ) {
      const nextParamStore = this._statsig.getParameterStore(
        user,
        nextParamStoreName,
      );
      const possibleNextParamStoreName = nextParamStore.getValue(
        'prompt_targeting_rules',
        '',
      );

      if (
        possibleNextParamStoreName === '' ||
        possibleNextParamStoreName === nextParamStoreName
      ) {
        currentParamStoreName = nextParamStoreName;
        break;
      }

      currentParamStoreName = nextParamStoreName;
      nextParamStoreName = possibleNextParamStoreName;

      depth++;
    }

    if (depth >= MAX_DEPTH) {
      currentParamStoreName = baseParamStoreName;
      console.warn(
        `[Statsig] Max targeting depth (${MAX_DEPTH}) reached while resolving prompt: ${promptName}. ` +
          `Possible circular reference starting from "${baseParamStoreName}".`,
      );
    }

    const finalParamStore = this._statsig.getParameterStore(
      user,
      currentParamStoreName,
    );

    const currentPromptName = currentParamStoreName.split(':')[1];

    return makePrompt(this._statsig, currentPromptName, finalParamStore, user);
  }

  getAgentConfig(user: StatsigUser, agentConfigName: string): AgentConfig {
    const agentParameterStore = this._statsig.getParameterStore(
      user,
      `agent:${agentConfigName}`,
    );

    return makeAgentConfig(
      this._statsig,
      user,
      agentConfigName,
      agentParameterStore,
    );
  }

  logEvalGrade(
    user: StatsigUser,
    promptVersion: PromptVersion,
    score: number,
    graderName: string,
    evalData: AIEvalGradeData,
  ): void {
    const { sessionId } = evalData;
    if (score < 0 || score > 1) {
      console.warn(
        `[Statsig] AI eval result score is out of bounds: ${score} is not between 0 and 1, skipping log event`,
      );
      return;
    }

    this._statsig.logEvent(
      user,
      'statsig::eval_result',
      promptVersion.getPromptName(),
      {
        score: score.toString(),
        session_id: sessionId ?? '',
        version_name: promptVersion.getName(),
        version_id: promptVersion.getID(),
        grader_id: graderName,
        ai_config_name: promptVersion.getPromptName(),
      },
    );
  }

  private _setUpOtel(sdkKey: string, options?: StatsigAIOptions): void {
    if (!options?.enableDefaultOtel) {
      return;
    }

    this._otel = new Otel(
      sdkKey,
      options.statsigTracingConfig?.serviceName ?? '',
      options.statsigTracingConfig?.enableAutoInstrumentation ?? false,
    );
  }
}

import {
  Statsig as StatsigStd,
  StatsigOptions as StatsigOptionsStd,
} from '@statsig/statsig-node-core';

import { AgentConfig, makeAgentConfig } from './agents/AgentConfig';
import { AIEvalGradeData } from './AIGradingData';
import { STATSIG_ATTR_ACTIVITY_ID } from './otel/conventions';
import { OtelSingleton } from './otel/singleton';
import { makePrompt, Prompt } from './prompts/Prompt';
import { PromptEvaluationOptions } from './prompts/PromptEvalOptions';
import { PromptVersion } from './prompts/PromptVersion';
import Statsig, { StatsigSelector, STD } from './wrappers/statsig';

export type StatsigCreateConfig = {
  sdkKey: string;
  statsigOptions?: StatsigOptionsStd;
};

export type StatsigAttachConfig<T extends StatsigSelector> = {
  statsig: T['statsig'];
};

export type StatsigSourceConfig<T extends StatsigSelector> =
  | StatsigCreateConfig
  | StatsigAttachConfig<T>;

export class StatsigAIInstance<T extends StatsigSelector = STD> {
  private _statsig: T['statsig'];
  private _ownsStatsigInstance: boolean = false;

  constructor(statsigSource: StatsigSourceConfig<T>) {
    if ('statsig' in statsigSource) {
      const { statsig } = statsigSource;
      this._statsig = statsig;
      this._ownsStatsigInstance = false;
    } else {
      const { sdkKey, statsigOptions } = statsigSource;
      this._statsig = new StatsigStd(sdkKey, statsigOptions);
      this._ownsStatsigInstance = true;
    }
  }

  async initialize(): Promise<void> {
    if (this._ownsStatsigInstance) {
      await this._statsig.initialize();
    }
  }

  async flushEvents(): Promise<void> {
    if (this._ownsStatsigInstance) {
      await this._statsig.flushEvents();
    }
    await OtelSingleton.flushInstance();
  }

  async shutdown(): Promise<void> {
    if (this._ownsStatsigInstance) {
      await this._statsig.shutdown();
    }
    await this.flushEvents();
  }

  getStatsig(): T['statsig'] {
    return this._statsig;
  }

  getPrompt(
    user: T['user'],
    promptName: string,
    _options?: PromptEvaluationOptions,
  ): Prompt {
    const MAX_DEPTH = 300;
    let depth = 0;

    const baseParamStoreName = `prompt:${promptName}`;
    let currentParamStoreName = baseParamStoreName;

    let nextParamStoreName = Statsig.getParameterStore(
      this._statsig,
      user,
      currentParamStoreName,
    ).getValue('prompt_targeting_rules', '');

    while (
      nextParamStoreName !== '' &&
      nextParamStoreName !== currentParamStoreName &&
      depth < MAX_DEPTH
    ) {
      const nextParamStore = Statsig.getParameterStore(
        this._statsig,
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

    const finalParamStore = Statsig.getParameterStore(
      this._statsig,
      user,
      currentParamStoreName,
    );

    const currentPromptName = currentParamStoreName.split(':')[1];

    return makePrompt(this._statsig, currentPromptName, finalParamStore, user);
  }

  getAgentConfig(user: T['user'], agentConfigName: string): AgentConfig {
    const agentParameterStore = Statsig.getParameterStore(
      this._statsig,
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
    user: T['user'],
    promptVersion: PromptVersion,
    score: number,
    graderName: string,
    evalData: AIEvalGradeData,
  ): void {
    const { sessionId, activityId } = evalData;
    if (score < 0 || score > 1) {
      console.warn(
        `[Statsig] AI eval result score is out of bounds: ${score} is not between 0 and 1, skipping log event`,
      );
      return;
    }

    if (activityId) {
      user.customIDs = {
        ...user.customIDs,
        [STATSIG_ATTR_ACTIVITY_ID]: activityId,
      };
    }

    Statsig.logEvent(
      this._statsig,
      user,
      'statsig::eval_result',
      promptVersion.getPromptName(),
      {
        score: score.toString(),
        session_id: sessionId ?? '',
        version_name: promptVersion.getName(),
        version_id: promptVersion.getID(),
        grader_name: graderName,
        ai_config_name: promptVersion.getPromptName(),
        is_live: promptVersion.isLiveForUser.toString(),
        ...(evalData.metadata ? evalData.metadata : {}),
      },
    );
  }
}

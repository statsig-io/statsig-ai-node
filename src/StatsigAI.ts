import { Statsig, StatsigUser } from '@statsig/statsig-node-core';

import { AgentConfig, makeAgentConfig } from './agents/AgentConfig';
import { AIEvalResult } from './AIEvalResult';
import { Otel } from './otel/otel';
import { makePrompt, Prompt } from './prompts/Prompt';
import { PromptEvaluationOptions } from './prompts/PromptEvalOptions';
import { StatsigAIOptions } from './StatsigAIOptions';

export class StatsigAIInstance {
  private _otel: Otel;
  private _statsig: Statsig;

  constructor(sdkKey: string, statsig: Statsig, options?: StatsigAIOptions) {
    this._statsig = statsig;
    this._otel = new Otel(
      sdkKey,
      options?.statsigTracingConfig?.serviceName ?? '',
      options?.statsigTracingConfig?.enableAutoInstrumentation ?? false,
    );
  }

  async initialize(): Promise<void> {
    this._otel.start();
  }

  async flushEvents(): Promise<void> {
    await this._otel.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this._otel.shutdown();
  }

  getStatsig(): Statsig {
    return this._statsig;
  }

  getPrompt(user: StatsigUser, promptName: string): Prompt {
    return this.getPromptWithOptions(user, promptName, {});
  }

  getPromptWithOptions(
    user: StatsigUser,
    promptName: string,
    _options: PromptEvaluationOptions,
  ): Prompt {
    const promptParameterStore = this._statsig.getParameterStore(
      user,
      `prompt:${promptName}`,
    );

    const targetingRulesParamStoreName = promptParameterStore.getValue(
      'prompt_targeting_rules',
      '',
    );

    if (!targetingRulesParamStoreName) {
      return makePrompt(this._statsig, promptName, promptParameterStore, user);
    } else {
      const targetingRulesParameterStore = this._statsig.getParameterStore(
        user,
        targetingRulesParamStoreName,
      );

      return makePrompt(
        this._statsig,
        targetingRulesParamStoreName,
        targetingRulesParameterStore,
        user,
      );
    }
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

  logEvalResult(
    user: StatsigUser,
    graderName: string,
    evalResult: AIEvalResult,
  ): void {
    const { version, score, session_id } = evalResult;
    if (score < 0 || score > 1) {
      console.warn(
        `[Statsig] AI eval result score is out of bounds: ${score} is not between 0 and 1, skipping log event`,
      );
      return;
    }

    this._statsig.logEvent(
      user,
      'statsig::eval_result',
      version.getAIConfigName(),
      {
        score: score.toString(),
        session_id: session_id,
        version_name: version.getName() ?? '',
        version_id: version.getID() ?? '',
        grader_name: graderName ?? '',
        ai_config_name: version.getAIConfigName() ?? '',
      },
    );
  }
}

import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  Layer,
  Statsig as StatsigCore,
  StatsigResult,
  StatsigUser,
} from '@statsig/statsig-node-core';

import { AgentConfig, makeAgentConfig } from './agents/AgentConfig';
import { AIEvalResult } from './AIEvalResult';
import { Otel } from './otel/otel';
import { makePrompt, Prompt } from './prompts/Prompt';
import { PromptEvaluationOptions } from './prompts/PromptEvalOptions';
import { StatsigOptions } from './StatsigOptions';

export class StatsigServer extends StatsigCore {
  private _otel: Otel;
  constructor(sdkKey: string, options?: StatsigOptions) {
    super(sdkKey, options);
    this._otel = new Otel(
      sdkKey,
      options?.serviceName ?? '',
      options?.statsigTracingConfig?.enableAutoInstrumentation ?? false,
    );
  }

  async initialize(): Promise<StatsigResult> {
    this._otel.start();
    return super.initialize();
  }

  async flushEvents(): Promise<StatsigResult> {
    await this._otel.forceFlush();
    return super.flushEvents();
  }

  async shutdown(): Promise<StatsigResult> {
    await this._otel.shutdown();
    return super.shutdown();
  }

  // @ts-expect-error - getPrompt has a different return type in the core library
  getPrompt(user: StatsigUser, promptName: string): Prompt {
    return this.getPromptWithOptions(user, promptName, {});
  }

  getPromptWithOptions(
    user: StatsigUser,
    promptName: string,
    _options: PromptEvaluationOptions,
  ): Prompt {
    const promptParameterStore = this.getParameterStore(
      user,
      `prompt:${promptName}`,
    );

    const targetingRulesParamStoreName = promptParameterStore.getValue(
      'prompt_targeting_rules',
      '',
    );

    if (!targetingRulesParamStoreName) {
      return makePrompt(this, promptName, promptParameterStore, user);
    } else {
      const targetingRulesParameterStore = this.getParameterStore(
        user,
        targetingRulesParamStoreName,
      );

      return makePrompt(
        this,
        targetingRulesParamStoreName,
        targetingRulesParameterStore,
        user,
      );
    }
  }

  getAgentConfig(user: StatsigUser, agentConfigName: string): AgentConfig {
    const agentParameterStore = this.getParameterStore(
      user,
      `agent:${agentConfigName}`,
    );

    return makeAgentConfig(this, user, agentConfigName, agentParameterStore);
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

    this.logEvent(user, 'statsig::eval_result', version.getAIConfigName(), {
      score: score.toString(),
      session_id: session_id,
      version_name: version.getName() ?? '',
      version_id: version.getID() ?? '',
      grader_name: graderName ?? '',
      ai_config_name: version.getAIConfigName() ?? '',
    });
  }
}

import { AgentConfig, makeAgentConfig } from './agents/AgentConfig';
import {
  Layer,
  Statsig as StatsigCore,
  StatsigResult,
  StatsigUser,
} from '@statsig/statsig-node-core';
import { Prompt, makePrompt } from './prompts/Prompt';

import { AIEvalResult } from './AIEvalResult';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PromptEvaluationOptions } from './prompts/PromptEvalOptions';
import { StatsigOptions } from './StatsigOptions';
import { setupOtel } from './otel/otel';

export class StatsigServer extends StatsigCore {
  private _otelSdk: NodeSDK | null = null;
  constructor(sdkKey: string, options?: StatsigOptions) {
    super(sdkKey, options);
    this._otelSdk = setupOtel(
      sdkKey,
      options?.serviceName ?? '',
      options?.statsigTracingConfig?.enableAutoInstrumentation ?? false,
    );
  }

  async initialize(): Promise<StatsigResult> {
    this._otelSdk?.start();
    return await super.initialize();
  }

  // TODO: need to remove this from base sdks since the return type should be the prompt class. (or have prompt class extend layer)
  getPrompt(user: StatsigUser, promptName: string): Layer {
    return super.getPrompt(user, promptName);
  }

  getPromptNew(user: StatsigUser, promptName: string): Prompt {
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
      console.error(
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

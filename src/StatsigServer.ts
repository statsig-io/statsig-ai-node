import {
  Layer,
  Statsig as StatsigCore,
  StatsigResult,
  StatsigUser,
} from '@statsig/statsig-node-core';
import { Prompt, makePrompt } from './prompts/Prompt';

import { AIEvalResult } from './AIEvalResult';
import { AgentConfig } from './AgentConfig';
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
    const parameterStore = this.getParameterStore(user, `prompt:${promptName}`);

    const targettedParamStoreName =
      (parameterStore.getValue('prompt_targeting_rules') as string) ?? '';

    const targettedParameterStore = this.getParameterStore(
      user,
      targettedParamStoreName,
    );

    return makePrompt(
      this,
      targettedParamStoreName,
      targettedParameterStore,
      user,
    );
  }

  getAgentConfig(user: StatsigUser, agentConfigName: string): AgentConfig {
    return new AgentConfig(agentConfigName, 'no-op');
  }

  logEvalResult(
    user: StatsigUser,
    graderName: string,
    evalResult: AIEvalResult,
  ): void {}
}

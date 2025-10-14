import {
  Layer,
  Statsig as StatsigCore,
  StatsigResult,
  StatsigUser,
} from '@statsig/statsig-node-core';

import { AIEvalResult } from './AIEvalResult';
import { AgentConfig } from './AgentConfig';
import { NodeSDK } from '@opentelemetry/sdk-node';
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

  getAgentConfig(user: StatsigUser, agentConfigName: string): AgentConfig {
    return new AgentConfig(agentConfigName, 'no-op');
  }

  logEvalResult(
    user: StatsigUser,
    graderName: string,
    evalResult: AIEvalResult,
  ): void {}
}

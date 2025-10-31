import { ParameterStore, StatsigUser } from '@statsig/statsig-node-core';

import { PromptVersion } from './PromptVersion';
import { Statsig } from '@statsig/statsig-node-core';
import { context } from '@opentelemetry/api';
import {
  STATSIG_CTX_KEY_ACTIVE_PROMPT,
  STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION,
} from '../otel/conventions';
import { setUserToContext } from '../otel/user-context';

export function makePrompt(
  statsig: Statsig,
  name: string,
  paramStore: ParameterStore,
  user: StatsigUser,
): Prompt {
  const liveConfigId = paramStore.getValue('live', '');
  const candidateConfigIds = paramStore.getValue('candidates', []);
  const liveConfig = statsig.getDynamicConfig(user, liveConfigId);
  const candidateConfigs = candidateConfigIds.map((id) =>
    statsig.getDynamicConfig(user, id),
  );

  return new Prompt(
    user,
    name,
    new PromptVersion(liveConfig),
    candidateConfigs.map((config) => new PromptVersion(config)),
  );
}
export class Prompt {
  public readonly name: string;
  private _liveConfig: PromptVersion;
  private _candidateConfigs: PromptVersion[];
  private _user: StatsigUser;

  constructor(
    user: StatsigUser,
    name: string,
    liveConfig: PromptVersion,
    candidateConfigs: PromptVersion[],
  ) {
    this.name = name;
    this._liveConfig = liveConfig;
    this._candidateConfigs = candidateConfigs;
    this._user = user;
  }

  getName(): string {
    return this.name;
  }

  getLive(): PromptVersion {
    return this._liveConfig;
  }

  getCandidates(): PromptVersion[] {
    return this._candidateConfigs;
  }

  withLive<R>(fn: (liveConfig: PromptVersion) => R): Promise<R> {
    let ctx = context.active();
    ctx = ctx.setValue(STATSIG_CTX_KEY_ACTIVE_PROMPT, this.name);
    ctx = ctx.setValue(
      STATSIG_CTX_KEY_ACTIVE_PROMPT_VERSION,
      this._liveConfig.getName(),
    );
    ctx = setUserToContext(ctx, this._user);

    const config = this._liveConfig;
    return context.with(ctx, async () => await fn(config));
  }

  withContext<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    let ctx = context.active();
    ctx = ctx.setValue(STATSIG_CTX_KEY_ACTIVE_PROMPT, this.name);
    ctx = setUserToContext(ctx, this._user);
    return context.with(ctx, fn, thisArg, ...args);
  }
}

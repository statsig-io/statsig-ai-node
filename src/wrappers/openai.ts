import { StatsigOpenAIProxyConfig, isOpenAILike } from './openai-configs';

import { StatsigOpenAIProxy } from './oai-impl';

export function wrapOpenAI<T extends object>(
  openai: T,
  config?: StatsigOpenAIProxyConfig,
): T {
  if (!isOpenAILike(openai)) {
    console.warn('Unsupported OpenAI-like object. Not wrapping.');
    return openai;
  }

  const proxy = new StatsigOpenAIProxy(openai, config ?? {});
  return proxy.client as T;
}

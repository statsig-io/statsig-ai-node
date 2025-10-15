import {
  OpenAILike,
  StatsigOpenAIProxyConfig,
  isOpenAILike,
} from './openai-configs';

import { StatsigOpenAIProxy } from './openai-impl';

export function wrapOpenAI(
  openai: OpenAILike,
  config?: StatsigOpenAIProxyConfig,
): OpenAILike {
  if (!isOpenAILike(openai)) {
    console.warn('Unsupported OpenAI-like object. Not wrapping.');
    return openai;
  }

  const proxy = new StatsigOpenAIProxy(openai, config ?? {});
  return proxy.client;
}

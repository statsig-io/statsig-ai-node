import { StatsigOptions as StatsigOptionsCore } from '@statsig/statsig-node-core';

export interface StatsigTracingConfig {
  enableAutoInstrumentation: boolean;
}

export interface StatsigOptions extends StatsigOptionsCore {
  statsigTracingConfig?: StatsigTracingConfig;
}

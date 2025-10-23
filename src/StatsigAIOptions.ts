export interface StatsigTracingConfig {
  serviceName: string;
  enableAutoInstrumentation: boolean;
}

export interface StatsigAIOptions {
  statsigTracingConfig?: StatsigTracingConfig;
}

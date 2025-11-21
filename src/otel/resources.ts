export type StatsigResourceAttributes = {
  service?: string;
  version?: string;
  environment?: string;
};

export function createResourceAttributes(options?: {
  serviceName?: string;
  version?: string;
  environment?: string;
}): StatsigResourceAttributes {
  return {
    service:
      options?.serviceName ||
      process.env.OTEL_SERVICE_NAME ||
      process.env.SERVICE_NAME,
    version: options?.version,
    environment: options?.environment || process.env.NODE_ENV,
  };
}

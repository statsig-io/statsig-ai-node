import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export type StatsigOTLPTraceExporterOptions = {
  /**
   * Optional statsig SDK Key for authentication.
   * If not provided, the exporter will attempt to use
   * from the STATSIG_SDK_KEY environment variable.
   */
  sdkKey?: string;
  /**
   * Optional DSN for custom endpoint configuration.
   * will be appended with /v1/traces
   */
  dsn?: string;
};

export class StatsigOTLPTraceExporter extends OTLPTraceExporter {
  constructor(options: StatsigOTLPTraceExporterOptions) {
    const sdkKey = options.sdkKey || process.env.STATSIG_SDK_KEY;
    if (!sdkKey) {
      throw new Error(
        'Statsig SDK Key is required for StatsigOTLPTraceExporter',
      );
    }
    const dsn = options.dsn ?? 'https://api.statsig.com/otlp';
    super({
      url: `${dsn}/v1/traces`,
      headers: {
        'statsig-api-key': sdkKey,
      },
    });
  }
}

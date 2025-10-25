import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { trace } from '@opentelemetry/api';
import { IOtelClient } from './IOtelClient';

export const createExporterOptions = (endpoint: string, sdkKey: string) => ({
  url: 'https://api.statsig.com/otlp' + endpoint,
  headers: {
    'statsig-api-key': sdkKey,
  },
});

export class Otel implements IOtelClient {
  private sdkKey: string;
  private serviceName: string;
  private enableAutoInstrumentation: boolean;
  private traceExporter: OTLPTraceExporter | null = null;
  private sdk: NodeSDK | null = null;

  constructor(
    sdkKey: string,
    serviceName: string,
    enableAutoInstrumentation: boolean,
  ) {
    this.sdkKey = sdkKey;
    this.serviceName = serviceName;
    this.enableAutoInstrumentation = enableAutoInstrumentation;
    this.setup();
  }

  setup(): NodeSDK {
    const traceExporter = new OTLPTraceExporter(
      createExporterOptions('/v1/traces', this.sdkKey),
    );

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: this.serviceName,
      }),
      instrumentations: this.enableAutoInstrumentation
        ? [getNodeAutoInstrumentations()]
        : [],
      traceExporter,
    });

    this.traceExporter = traceExporter;
    this.sdk = sdk;

    return sdk;
  }

  addStatsigTraceExporter(): void {
    // no-op for default OpenTelemetry client
  }

  async initialize(): Promise<void> {
    this.sdk?.start();
  }

  async shutdown(): Promise<void> {
    await this.sdk?.shutdown();
  }

  async flush(): Promise<void> {
    if ((this.sdk as any)?._tracerProvider?.forceFlush) {
      await (this.sdk as any)._tracerProvider.forceFlush();
    }
  }
}

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { trace } from '@opentelemetry/api';

export const createExporterOptions = (endpoint: string, sdkKey: string) => ({
  url: 'https://api.statsig.com/otlp' + endpoint,
  headers: {
    'statsig-api-key': sdkKey,
  },
});

export class Otel {
  private static readonly ATTR_SERVICE_NAME = 'service.name';

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
    console.log(
      'setting up otel',
      createExporterOptions('/v1/traces', this.sdkKey),
    );
    const traceExporter = new OTLPTraceExporter(
      createExporterOptions('/v1/traces', this.sdkKey),
    );

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [Otel.ATTR_SERVICE_NAME]: this.serviceName,
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

  start() {
    this.sdk?.start();
  }

  async shutdown() {
    await this.sdk?.shutdown();
  }

  async forceFlush() {
    console.log('[Otel] Starting forceFlush...');
    const tracerProvider = trace.getTracerProvider() as any;
    if (tracerProvider?.forceFlush) {
      console.log('[Otel] Flushing tracer provider...');
      await tracerProvider.forceFlush();
      console.log('[Otel] Tracer provider flushed');
    }
    // Also explicitly flush the exporter to ensure HTTP requests complete
    if (this.traceExporter?.forceFlush) {
      console.log('[Otel] Flushing trace exporter...');
      await this.traceExporter.forceFlush();
      console.log('[Otel] Trace exporter flushed');
    }
    console.log('[Otel] forceFlush complete');
  }
}

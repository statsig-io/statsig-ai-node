import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';

const ATTR_SERVICE_NAME = 'service.name';

const createExporterOptions = (endpoint: string, sdkKey: string) => ({
  url: 'https://api.statsig.com/otlp' + endpoint,
  headers: {
    'statsig-api-key': sdkKey,
  },
});

export function setupOtel(
  sdkKey: string,
  serviceName: string,
  enableAutoInstrumentation: boolean,
): NodeSDK {
  const traceExporter = new OTLPTraceExporter(
    createExporterOptions('/v1/traces', sdkKey),
  );

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    instrumentations: enableAutoInstrumentation
      ? [getNodeAutoInstrumentations()]
      : [],
    traceExporter,
  });

  return sdk;
}

import { NodeSDK } from '@opentelemetry/sdk-node';

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
} from '@opentelemetry/sdk-metrics';

import { resourceFromAttributes } from '@opentelemetry/resources';

import { initializeTracing } from '../../src';

// when you have your own otel setup and don't want to use the global trace provider
// you can disable it with the options below
const { processor, exporter } = initializeTracing({
  // prevents creating a global context manager
  skipGlobalContextManagerSetup: true,
  serviceName: 'statsig-ai',
  exporterOptions: {
    sdkKey: process.env.STATSIG_SDK_KEY!,
  },
});

const sdk = new NodeSDK({
  // IMPORTANT: use the processor created by initializeTracing
  // to make sure that spans are exported to Statsig
  spanProcessors: [processor],
  // you can optionally use the exporter created by initializeTracing
  // to export traces to other backends instead
  // traceExporter: exporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: new ConsoleMetricExporter(),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  resource: resourceFromAttributes({
    'service.name': 'statsig-ai',
  }),
});

sdk.start();
export { sdk };

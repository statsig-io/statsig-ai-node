import {
  trace as otelTrace,
  context as otelContext,
  type TracerProvider,
  type ContextManager,
} from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
} from '@opentelemetry/sdk-trace-base';
import { StatsigSpanProcessor } from './processor';
import {
  StatsigOTLPTraceExporter,
  StatsigOTLPTraceExporterOptions,
} from './exporter';
import { OtelSingleton } from './singleton';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

type InitializeOptions = {
  // context manager options
  /** An optional global context manager to use. If not provided, one will be created and set as the global context manager unless `skipGlobalContextManagerSetup` is true. */
  globalContextManager?: ContextManager;
  /** If true, will not attempt to set up a global context manager automatically. */
  skipGlobalContextManagerSetup?: boolean;

  // trace provider options
  /** If true, will register the trace provider globally. */
  enableGlobalTraceProviderRegistration?: boolean;
  /** An optional global trace provider to use. If not provided, a new BasicTracerProvider will be created and optionally registered globally */
  globalTraceProvider?: TracerProvider;

  // exporter options
  /** Options to pass to the StatsigOTLPTraceExporter */
  exporterOptions?: StatsigOTLPTraceExporterOptions;

  // resource options
  serviceName?: string;
  version?: string;
  environment?: string;

  // TODO: probably add sampler options later
};

type InitializeTracingResult = {
  exporter: StatsigOTLPTraceExporter;
  processor: StatsigSpanProcessor;
  provider: BasicTracerProvider;
};

export function initializeTracing(
  options?: InitializeOptions,
): InitializeTracingResult {
  const {
    globalContextManager,
    skipGlobalContextManagerSetup,
    exporterOptions,

    globalTraceProvider,
    enableGlobalTraceProviderRegistration,
  } = options || {};

  // since we're using the basic trace provider we need to setup a context manager
  // ourselves if one is not already set
  if (!globalContextManager && !skipGlobalContextManagerSetup) {
    try {
      const contextManager = new AsyncHooksContextManager();
      contextManager.enable();
      otelContext.setGlobalContextManager(contextManager);
    } catch (e) {
      console.log(
        [
          `Could not automatically set up a global OTEL context manager.`,
          `This may be expected if you have (or another imported library has) already set a global context manager.`,
          `You can skip this message by passing "skipGlobalContextManagerSetup: true" into your initializeTracing call.`,
        ].join('\n'),
      );
    }
  }

  const traceComponents = createTraceComponents(exporterOptions ?? {}, {
    serviceName: options?.serviceName,
    version: options?.version,
    environment: options?.environment,
  });
  const tracerProvider = globalTraceProvider || traceComponents.provider;

  OtelSingleton.instantiate({ tracerProvider });
  if (enableGlobalTraceProviderRegistration) {
    otelTrace.setGlobalTracerProvider(tracerProvider);
  }

  return traceComponents;
}

function createTraceComponents(
  exporterOptions: StatsigOTLPTraceExporterOptions,
  resources: Record<string, string | undefined> = {},
) {
  const exporter = new StatsigOTLPTraceExporter(exporterOptions);
  const processor = new StatsigSpanProcessor(exporter);

  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
    sampler: new AlwaysOnSampler(),
    resource: resourceFromAttributes({
      ...resources,
      [ATTR_SERVICE_NAME]:
        resources.serviceName || process.env.OTEL_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: resources.version,
      env: resources.environment || process.env.NODE_ENV,
    }),
  });

  return {
    exporter,
    processor,
    provider,
  };
}

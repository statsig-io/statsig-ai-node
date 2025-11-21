import { trace, type TracerProvider } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { StatsigResourceAttributes } from './resources';

const globalForOtel = globalThis as typeof globalThis & {
  __statsig_ai_OtelSingleton?: OtelSingleton | null;
};

type InitializeOptions = {
  tracerProvider: TracerProvider;
};

export class OtelSingleton {
  protected constructor(
    private tracerProvider: TracerProvider,
    private resources: StatsigResourceAttributes,
  ) {}

  static isInitialized(): boolean {
    return globalForOtel.__statsig_ai_OtelSingleton != null;
  }

  static getInstance(): OtelSingleton {
    return (
      globalForOtel.__statsig_ai_OtelSingleton ??
      NoopOtelSingleton.getInstance()
    );
  }

  static instantiate(
    options: InitializeOptions,
    resources: StatsigResourceAttributes = {},
  ): OtelSingleton {
    const instance = globalForOtel.__statsig_ai_OtelSingleton;
    if (instance != null) {
      console.warn(
        'OtelSingleton instance has already been created. Returning the existing instance.',
      );
      return instance;
    }
    globalForOtel.__statsig_ai_OtelSingleton = new OtelSingleton(
      options.tracerProvider,
      resources,
    );
    return globalForOtel.__statsig_ai_OtelSingleton;
  }

  /** @internal -- sets the otel instance to null */
  static __reset(): void {
    globalForOtel.__statsig_ai_OtelSingleton = null;
  }

  public getTracerProvider(): TracerProvider {
    return this.tracerProvider;
  }

  public getResources(): StatsigResourceAttributes {
    return this.resources;
  }

  public static getTracerProvider(): TracerProvider {
    return OtelSingleton.getInstance().getTracerProvider();
  }

  static async flushInstance(): Promise<void> {
    const instance = OtelSingleton.getInstance();
    // if we know for sure the type of tracerProvider, we can call forceFlush directly
    if (instance.tracerProvider instanceof BasicTracerProvider) {
      await instance.tracerProvider.forceFlush();
    } else if (
      // otherwise, we can check if the method exists
      'forceFlush' in instance.tracerProvider &&
      typeof instance.tracerProvider.forceFlush === 'function'
    ) {
      await instance.tracerProvider.forceFlush();
    }
  }
}

class NoopOtelSingleton extends OtelSingleton {
  constructor() {
    super(trace.getTracerProvider(), {});
  }

  public static getInstance(): NoopOtelSingleton {
    console.warn(
      'NoopOtelSingleton instance is being used. OtelSingleton has not been properly instantiated.',
    );
    return new NoopOtelSingleton();
  }
}

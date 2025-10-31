import { trace, type TracerProvider } from '@opentelemetry/api';

type InitializeOptions = {
  tracerProvider: TracerProvider;
};

export class OtelSingleton {
  private static _instance: OtelSingleton | null;

  protected constructor(private tracerProvider: TracerProvider) {}

  static getInstance(): OtelSingleton {
    return OtelSingleton._instance ?? NoopOtelSingleton.getInstance();
  }

  static instantiate(options: InitializeOptions): OtelSingleton {
    if (OtelSingleton._instance != null) {
      console.warn(
        'OtelSingleton instance has already been created. Returning the existing instance.',
      );
      return OtelSingleton._instance;
    }
    OtelSingleton._instance = new OtelSingleton(options.tracerProvider);
    return OtelSingleton._instance;
  }

  /** @internal -- sets the otel instance to null */
  static __reset(): void {
    OtelSingleton._instance = null;
  }

  public getTracerProvider(): TracerProvider {
    return this.tracerProvider;
  }

  public static getTracerProvider(): TracerProvider {
    return OtelSingleton.getInstance().getTracerProvider();
  }
}

class NoopOtelSingleton extends OtelSingleton {
  constructor() {
    super(trace.getTracerProvider());
  }

  public static getInstance(): NoopOtelSingleton {
    console.warn(
      'NoopOtelSingleton instance is being used. OtelSingleton has not been properly instantiated.',
    );
    return new NoopOtelSingleton();
  }
}

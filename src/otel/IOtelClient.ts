export interface IOtelClient {
  /**
   * Called when the SDK starts up to initialize OpenTelemetry tracing.
   */
  addStatsigTraceExporter(): void;

  /**
   * Called when the SDK starts up to initialize OpenTelemetry tracing.
   */
  initialize(): Promise<void>;

  /**
   * Called by the SDK before shutdown or when explicitly requested to flush events.
   */
  flush(): Promise<void>;

  /**
   * Called when the SDK is shutting down to clean up resources.
   */
  shutdown(): Promise<void>;
}

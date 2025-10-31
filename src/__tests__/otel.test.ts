import { trace as otelTrace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { initializeTracing } from '../otel/otel-v2';
import { OtelSingleton } from '../otel/singleton';

describe('OTEL initialize', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env.STATSIG_SDK_KEY = 'test-sdk-key';
    OtelSingleton.__reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it('should initialize OTEL components', () => {
    const { exporter, processor, provider } = initializeTracing({
      serviceName: 'test-service',
      version: '1.0.0',
      environment: 'test',
      skipGlobalContextManagerSetup: true,
    });
    expect(exporter).toBeDefined();
    expect(processor).toBeDefined();
    expect(provider).toBeDefined();
  });

  it(' doest not registers the trace provider globally by default', () => {
    const setGlobalTracerProviderSpy = jest.spyOn(
      otelTrace,
      'setGlobalTracerProvider',
    );
    const { provider } = initializeTracing({
      serviceName: 'test-service',
      version: '1.0.0',
      environment: 'test',
      skipGlobalContextManagerSetup: true,
    });

    expect(setGlobalTracerProviderSpy).not.toHaveBeenCalledWith(provider);
  });

  it('can register global trace provider registration', () => {
    const setGlobalTracerProviderSpy = jest.spyOn(
      otelTrace,
      'setGlobalTracerProvider',
    );
    initializeTracing({
      skipGlobalContextManagerSetup: true,
      enableGlobalTraceProviderRegistration: true,
    });

    expect(setGlobalTracerProviderSpy).toHaveBeenCalled();
  });

  it('uses a provided global tracer provider for the singleton', () => {
    const customProvider = new BasicTracerProvider();
    const setGlobalTracerProviderSpy = jest.spyOn(
      otelTrace,
      'setGlobalTracerProvider',
    );

    const { provider } = initializeTracing({
      globalTraceProvider: customProvider,
      skipGlobalContextManagerSetup: true,
    });

    expect(provider).not.toBe(customProvider);
    expect(OtelSingleton.getTracerProvider()).toBe(customProvider);
    expect(setGlobalTracerProviderSpy).not.toHaveBeenCalled();
  });

  it('populates resource attributes from initialize options', () => {
    const { provider } = initializeTracing({
      serviceName: 'resource-service',
      version: '2.0.0',
      environment: 'staging',
      skipGlobalContextManagerSetup: true,
    });

    const resource = (
      provider as unknown as {
        _resource: { attributes: Record<string, unknown> };
      }
    )._resource;

    expect(resource.attributes[ATTR_SERVICE_NAME]).toBe('resource-service');
    expect(resource.attributes[ATTR_SERVICE_VERSION]).toBe('2.0.0');
    expect(resource.attributes.env).toBe('staging');
  });

  it('falls back to environment variables for resource attributes', () => {
    process.env = {
      ...process.env,
      OTEL_SERVICE_NAME: 'env-service-name',
      NODE_ENV: 'ci',
    };

    const { provider } = initializeTracing({
      skipGlobalContextManagerSetup: true,
    });

    const resource = (
      provider as unknown as {
        _resource: { attributes: Record<string, unknown> };
      }
    )._resource;

    expect(resource.attributes[ATTR_SERVICE_NAME]).toBe('env-service-name');
    expect(resource.attributes.env).toBe('ci');
  });
});

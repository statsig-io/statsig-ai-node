import path from 'path';

export function getDCSFilePath(filename: string) {
  return path.join(__dirname, filename);
}

export function validateOtelClientSpanBasics(
  traceRequests: any[],
  spanName: string,
) {
  const resourceSpans = traceRequests[0].body?.resourceSpans || [];
  expect(resourceSpans.length).toBeGreaterThan(0);

  const resourceSpan = resourceSpans[0];

  expect(resourceSpan.resource).toBeDefined();
  expect(resourceSpan.resource.attributes).toBeDefined();
  expect(Array.isArray(resourceSpan.resource.attributes)).toBe(true);

  const resourceAttrs = resourceSpan.resource.attributes;
  const resourceAttrKeys = resourceAttrs.map((attr: any) => attr.key);
  const expectedResourceAttrs = [
    'service.name',
    'service.version',
    'environment',
  ];
  expectedResourceAttrs.forEach((attrName) => {
    expect(resourceAttrKeys).toContain(attrName);
  });

  expect(resourceSpan.scopeSpans).toBeDefined();
  expect(Array.isArray(resourceSpan.scopeSpans)).toBe(true);
  expect(resourceSpan.scopeSpans.length).toBeGreaterThan(0);

  const scopeSpan = resourceSpan.scopeSpans[0];
  expect(scopeSpan.scope).toBeDefined();
  expect(scopeSpan.scope.name).toBe('statsig-openai-proxy');

  expect(scopeSpan.spans).toBeDefined();
  expect(Array.isArray(scopeSpan.spans)).toBe(true);
  expect(scopeSpan.spans.length).toBeGreaterThan(0);

  const span = scopeSpan.spans[0];

  expect(span.traceId).toBeDefined();
  expect(span.spanId).toBeDefined();
  expect(span.name).toBe(spanName);
  expect(span.kind).toBe(3);
  expect(span.startTimeUnixNano).toBeDefined();
  expect(span.endTimeUnixNano).toBeDefined();
  expect(span.status).toBeDefined();
  expect(span.status.code).toBe(1);

  return span;
}

export function getSpanAttributesMap(span: any) {
  const attributes = span?.attributes ?? [];
  return attributes.reduce((acc: any, attr: any) => {
    acc[attr.key] = attr.value;
    return acc;
  }, {});
}

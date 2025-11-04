import { Eval } from '../evals/Eval';
import { EvalHooks } from '../evals/EvalHooks';
import { EvalParameters } from '../evals/EvalParameters';
import { z } from 'zod';

describe('Eval', () => {
  const ORIGINAL_API_KEY = process.env.STATSIG_API_KEY;
  const originalFetch = global.fetch as any;
  let fetchMock: jest.Mock;

  beforeAll(() => {
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true }),
    }));
    (global as any).fetch = fetchMock;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  beforeEach(() => {
    process.env.STATSIG_API_KEY = 'test-console-api-key';
    (global.fetch as jest.Mock).mockClear();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env.STATSIG_API_KEY = ORIGINAL_API_KEY;
    (global as any).fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('evaluates data and sends results to Statsig', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: ({ output, expected }) => output === (expected as any),
      evalRunName: 'run-123',
    });

    const { results, metadata } = evalResult;

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      score: '0',
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      score: '1',
    });

    expect(metadata.error).toBe(false);

    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    expect(req?.method).toBe('POST');
    expect(req?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'STATSIG-API-KEY': 'test-console-api-key',
    });

    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-123');
    expect(Array.isArray(body.dataset)).toBe(true);
    expect(body.dataset).toEqual(results);
  });

  test('marks record as error when task throws and still sends', async () => {
    const dataset = [{ input: 'Boom', expected: 'Anything' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => {
        if (input === 'Boom') {
          throw new Error('Task failed');
        }
        return 'Hello ' + input;
      },
      scorer: () => 0,
      evalRunName: 'run-errors',
    });

    const { results, metadata } = evalResult;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      input: 'Boom',
      expected: 'Anything',
      output: '[Error]',
      score: '0',
      error: true,
    });
    expect(metadata.error).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-errors');
    expect(body.dataset).toEqual(results);
  });

  test('throws when STATSIG_API_KEY is missing', async () => {
    delete process.env.STATSIG_API_KEY;
    await expect(
      Eval('test task', {
        data: () => [{ input: 'x', expected: 'Hi x' }],
        task: (input: string) => 'Hello ' + input,
        scorer: ({ output, expected }) => output === (expected as any),
      }),
    ).rejects.toThrow(/Missing Statsig Console API key/);
  });

  test('throws when data is not a valid type', async () => {
    await expect(
      Eval('test task', {
        // @ts-expect-error - data is not a valid type
        data: 'not an array',
        task: (input: string) => 'Hello ' + input,
        scorer: ({ output, expected }) => output === (expected as any),
      }),
    ).rejects.toThrow(/Invalid type provided to data parameter/);
  });

  test('handles data provided as a Promise', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: Promise.resolve(dataset),
      task: (input: string) => 'Hello ' + input,
      scorer: ({ output, expected }) => output === (expected as any),
      evalRunName: 'run-promise',
    });

    const { results, metadata } = evalResult;

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      score: '0',
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      score: '1',
    });

    expect(metadata.error).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-promise');
    expect(body.dataset).toEqual(results);
  });

  test('handles data provided as an async function', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: async () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: ({ output, expected }) => output === (expected as any),
      evalRunName: 'run-async-data',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      score: '0',
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      score: '1',
    });
    expect(metadata.error).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-async-data');
    expect(body.dataset).toEqual(results);
  });

  test('handles async task function', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: async (input: string) => 'Hello ' + input,
      scorer: ({ output, expected }) => output === (expected as any),
      evalRunName: 'run-async-task',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      score: '0',
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      score: '1',
    });
    expect(metadata.error).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-async-task');
    expect(body.dataset).toEqual(results);
  });

  test('handles parameters in async task function', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar param' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: async (input: string, hooks: EvalHooks<EvalParameters>) =>
        'Hello ' + input + ' ' + hooks.parameters.name,
      scorer: ({ output, expected }) => output === (expected as any),
      evalRunName: 'run-async-task',
      parameters: {
        name: z.string().default('param'),
      },
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo param',
      score: '0',
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar param',
      output: 'Hello Bar param',
      score: '1',
    });
    expect(metadata.error).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-async-task');
    expect(body.dataset).toEqual(results);
  });

  test('handles async scorer function', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: async ({ output, expected }) => output === (expected as any),
      evalRunName: 'run-async-scorer',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      score: '0',
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      score: '1',
    });
    expect(metadata.error).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-async-scorer');
    expect(body.dataset).toEqual(results);
  });
});

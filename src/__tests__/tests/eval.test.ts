import { Eval } from '../../evals/Eval';
import { EvalHooks } from '../../evals/EvalHooks';
import { EvalParameters } from '../../evals/EvalParameters';
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
      scorer: {
        Grader: ({ output, expected }) => output === (expected as any),
      },
      evalRunName: 'run-123',
    });

    const { results, metadata } = evalResult;

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      scores: { Grader: '0' },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: '1' },
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
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toEqual(results);
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
      scorer: { Grader: () => 0 },
      evalRunName: 'run-errors',
    });

    const { results, metadata } = evalResult;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      input: 'Boom',
      expected: 'Anything',
      output: '[Error]',
      scores: {},
      error: true,
    });
    expect(metadata.error).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-errors');
    expect(body.results).toEqual(results);
  });

  test('throws when STATSIG_API_KEY is missing', async () => {
    delete process.env.STATSIG_API_KEY;
    await expect(
      Eval('test task', {
        data: () => [{ input: 'x', expected: 'Hi x' }],
        task: (input: string) => 'Hello ' + input,
        scorer: {
          Grader: ({ output, expected }) => output === (expected as any),
        },
      }),
    ).rejects.toThrow(/Missing Statsig Console API key/);
  });

  test('throws when data is not a valid type', async () => {
    await expect(
      Eval('test task', {
        // @ts-expect-error - data is not a valid type
        data: 'not an array',
        task: (input: string) => 'Hello ' + input,
        scorer: {
          Grader: ({ output }) => output === 'Hello Foo',
        },
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
      scorer: {
        Grader: ({ output, expected }) => output === (expected as any),
      },
      evalRunName: 'run-promise',
    });

    const { results, metadata } = evalResult;

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      scores: { Grader: '0' },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: '1' },
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
    expect(body.results).toEqual(results);
  });

  test('handles data provided as an async function', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: async () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        Grader: ({ output, expected }) => output === (expected as any),
      },
      evalRunName: 'run-async-data',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      scores: { Grader: '0' },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: '1' },
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
    expect(body.results).toEqual(results);
  });

  test('handles async task function', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: async (input: string) => 'Hello ' + input,
      scorer: {
        Grader: ({ output, expected }) => output === (expected as any),
      },
      evalRunName: 'run-async-task',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      scores: { Grader: '0' },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: '1' },
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
    expect(body.results).toEqual(results);
  });

  test('handles data without expected field', async () => {
    const dataset = [{ input: 'Foo' }, { input: 'Bar' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: async (input: string) => 'Hello ' + input,
      scorer: {
        Grader: ({ output }) => output === 'Hello Foo',
      },
      evalRunName: 'run-no-expected',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      output: 'Hello Foo',
      scores: { Grader: '1' },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      output: 'Hello Bar',
      scores: { Grader: '0' },
    });
    expect(metadata.error).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-no-expected');
    expect(body.results).toEqual(results);
  });

  test('handles scorer that accesses missing expected field gracefully', async () => {
    const dataset = [{ input: 'Foo' }, { input: 'Bar' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: async (input: string) => 'Hello ' + input,
      scorer: {
        Grader: ({ output, expected }: any) => {
          // This will throw because expected is undefined
          return expected.toLowerCase() === output;
        },
      },
      evalRunName: 'run-missing-expected',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);

    expect(results[0]).toMatchObject({
      input: 'Foo',
      output: 'Hello Foo',
      scores: { Grader: '0' },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      output: 'Hello Bar',
      scores: { Grader: '0' },
    });

    expect(metadata.error).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      "[Statsig] Scorer 'Grader' failed:",
      'Foo',
      expect.any(TypeError),
    );
    expect(console.warn).toHaveBeenCalledWith(
      "[Statsig] Scorer 'Grader' failed:",
      'Bar',
      expect.any(TypeError),
    );
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
      scorer: {
        Grader: ({ output, expected }) => output === (expected as any),
      },
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
      scores: { Grader: '0' },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar param',
      output: 'Hello Bar param',
      scores: { Grader: '1' },
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
    expect(body.results).toEqual(results);
  });

  test('handles async scorer function', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hi Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        Grader: async ({ output, expected }) => output === (expected as any),
      },
      evalRunName: 'run-async-scorer',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hi Foo',
      output: 'Hello Foo',
      scores: { Grader: '0' },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: '1' },
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
    expect(body.results).toEqual(results);
  });

  test('handles multiple named scorers', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hello Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
      { input: 'Baz', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        correctness: ({ output, expected }) => output === (expected as any),
        startsWithHello: ({ output }) => (output as string).startsWith('Hello'),
        lengthCheck: ({ output }) => (output as string).length > 5,
      },
      evalRunName: 'run-multiple-scorers',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(3);

    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hello Foo',
      output: 'Hello Foo',
      scores: {
        correctness: '1',
        startsWithHello: '1',
        lengthCheck: '1',
      },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: {
        correctness: '1',
        startsWithHello: '1',
        lengthCheck: '1',
      },
    });
    expect(results[2]).toMatchObject({
      input: 'Baz',
      expected: 'Hello Bar',
      output: 'Hello Baz',
      scores: {
        correctness: '0',
        startsWithHello: '1',
        lengthCheck: '1',
      },
    });
    expect(metadata.error).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-multiple-scorers');
    expect(body.results).toEqual(results);
  });

  test('handle category support', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hello Foo', category: 'category1' },
      { input: 'Bar', expected: 'Hello Bar', category: 'category1' },
      { input: 'Baz', expected: 'Hello Bar', category: 'category2' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        correctness: ({ output, expected }) => output === (expected as any),
      },
      evalRunName: 'run-category-support',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(3);

    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hello Foo',
      output: 'Hello Foo',
      scores: {
        correctness: '1',
      },
      category: 'category1',
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: {
        correctness: '1',
      },
      category: 'category1',
    });
    expect(results[2]).toMatchObject({
      input: 'Baz',
      expected: 'Hello Bar',
      output: 'Hello Baz',
      scores: {
        correctness: '0',
      },
      category: 'category2',
    });
    expect(metadata.error).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.statsig.com/console/v1/evals/send_results/' +
        encodeURIComponent('test task'),
    );
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-category-support');
    expect(body.results).toEqual(results);
  });

  test('handles scorer failure in multiple scorers gracefully', async () => {
    const dataset = [{ input: 'Test', expected: 'Hello Test' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        goodScorer: ({ output, expected }) => output === (expected as any),
        failingScorer: () => {
          throw new Error('Scorer failed');
        },
        anotherGoodScorer: () => true,
      },
      evalRunName: 'run-scorer-failure',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(1);

    // The failing scorer should have score '0', but others should work
    expect(results[0]).toMatchObject({
      input: 'Test',
      expected: 'Hello Test',
      output: 'Hello Test',
      scores: {
        goodScorer: '1',
        failingScorer: '0', // Failed scorer gets 0
        anotherGoodScorer: '1',
      },
    });

    expect(metadata.error).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      "[Statsig] Scorer 'failingScorer' failed:",
      'Test',
      expect.any(Error),
    );
  });

  test('handles boolean scores from multiple scorers', async () => {
    const dataset = [
      { input: 'Pass', expected: 'Hello Pass' },
      { input: 'Fail', expected: 'Hello Fail' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        booleanScorer: ({ input }) => (input as string) === 'Pass',
        numericScorer: ({ input }) =>
          (input as string) === 'Pass' ? 0.8 : 0.2,
      },
      evalRunName: 'run-boolean-scores',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);

    expect(results[0].scores).toEqual({
      booleanScorer: '1', // true -> 1
      numericScorer: '0.8',
    });

    expect(results[1].scores).toEqual({
      booleanScorer: '0', // false -> 0
      numericScorer: '0.2',
    });

    expect(metadata.error).toBe(false);
  });
});

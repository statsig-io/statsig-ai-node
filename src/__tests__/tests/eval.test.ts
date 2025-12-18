import { Eval, EvalResultRecord, EvalResult } from '../../evals/Eval';
import { EvalHooks } from '../../evals/EvalHooks';
import { EvalParameters } from '../../evals/EvalParameters';
import { ScorerFunctionArgs, ScoreWithMetadata } from '../../evals/EvalScorer';
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
      scores: { Grader: 0 },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: 1 },
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
    expect(body.results[0].scores).toEqual({ Grader: { score: 0 } });
    expect(body.results[1].scores).toEqual({ Grader: { score: 1 } });
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
      scores: {
        Grader: 0,
      },
      error: true,
    });
    expect(metadata.error).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.name).toBe('run-errors');
    expect(body.results[0].scores).toEqual({ Grader: { score: 0 } });
    expect(body.results[0].error).toBe(true);
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
      scores: { Grader: 0 },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: 1 },
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
    expect(body.results[0].scores).toEqual({ Grader: { score: 0 } });
    expect(body.results[1].scores).toEqual({ Grader: { score: 1 } });
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
      scores: { Grader: 0 },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: 1 },
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
    expect(body.results[0].scores).toEqual({ Grader: { score: 0 } });
    expect(body.results[1].scores).toEqual({ Grader: { score: 1 } });
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
      scores: { Grader: 0 },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: 1 },
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
    expect(body.results[0].scores).toEqual({ Grader: { score: 0 } });
    expect(body.results[1].scores).toEqual({ Grader: { score: 1 } });
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
      scores: { Grader: 1 },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      output: 'Hello Bar',
      scores: { Grader: 0 },
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
    expect(body.results[0].scores).toEqual({ Grader: { score: 1 } });
    expect(body.results[1].scores).toEqual({ Grader: { score: 0 } });
  });

  test('handles scorer that accesses missing expected field gracefully', async () => {
    const dataset = [{ input: 'Foo' }, { input: 'Bar' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: async (input: string) => 'Hello ' + input,
      scorer: {
        Grader: ({ output, expected }: any) => {
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
      scores: { Grader: 0 },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      output: 'Hello Bar',
      scores: { Grader: 0 },
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
      scores: { Grader: 0 },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar param',
      output: 'Hello Bar param',
      scores: { Grader: 1 },
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
    expect(body.results[0].scores).toEqual({ Grader: { score: 0 } });
    expect(body.results[1].scores).toEqual({ Grader: { score: 1 } });
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
      scores: { Grader: 0 },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: { Grader: 1 },
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
    expect(body.results[0].scores).toEqual({ Grader: { score: 0 } });
    expect(body.results[1].scores).toEqual({ Grader: { score: 1 } });
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
        correctness: 1,
        startsWithHello: 1,
        lengthCheck: 1,
      },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: {
        correctness: 1,
        startsWithHello: 1,
        lengthCheck: 1,
      },
    });
    expect(results[2]).toMatchObject({
      input: 'Baz',
      expected: 'Hello Bar',
      output: 'Hello Baz',
      scores: {
        correctness: 0,
        startsWithHello: 1,
        lengthCheck: 1,
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
    expect(body.results[0].scores).toEqual({
      correctness: { score: 1 },
      startsWithHello: { score: 1 },
      lengthCheck: { score: 1 },
    });
    expect(body.results[1].scores).toEqual({
      correctness: { score: 1 },
      startsWithHello: { score: 1 },
      lengthCheck: { score: 1 },
    });
    expect(body.results[2].scores).toEqual({
      correctness: { score: 0 },
      startsWithHello: { score: 1 },
      lengthCheck: { score: 1 },
    });
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
        correctness: 1,
      },
      category: 'category1',
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: {
        correctness: 1,
      },
      category: 'category1',
    });
    expect(results[2]).toMatchObject({
      input: 'Baz',
      expected: 'Hello Bar',
      output: 'Hello Baz',
      scores: {
        correctness: 0,
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
    expect(body.results[0].scores).toEqual({ correctness: { score: 1 } });
    expect(body.results[1].scores).toEqual({ correctness: { score: 1 } });
    expect(body.results[2].scores).toEqual({ correctness: { score: 0 } });
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
        goodScorer: 1,
        failingScorer: 0,
        anotherGoodScorer: 1,
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
      booleanScorer: 1,
      numericScorer: 0.8,
    });
    expect(results[1].scores).toEqual({
      booleanScorer: 0,
      numericScorer: 0.2,
    });
    expect(metadata.error).toBe(false);
  });

  test('handles scorer returning ScoreWithMetadata object', async () => {
    const dataset = [
      { input: 'world', expected: 'Hello world' },
      { input: 'test', expected: 'Goodbye test' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        Grader: ({ output, expected }): ScoreWithMetadata => {
          if (output === expected) {
            return {
              score: 1.0,
              metadata: { justification: 'exact match', confidence: 'high' },
            };
          }
          return {
            score: 0.0,
            metadata: { justification: 'no match' },
          };
        },
      },
      evalRunName: 'run-score-with-metadata',
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0].scores.Grader).toBe(1.0);
    expect(results[1].scores.Grader).toBe(0.0);
    expect(metadata.error).toBe(false);

    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.results[0].scores.Grader).toEqual({
      score: 1.0,
      metadata: { justification: 'exact match', confidence: 'high' },
    });
    expect(body.results[1].scores.Grader).toEqual({
      score: 0.0,
      metadata: { justification: 'no match' },
    });
  });

  test('handles scorer returning dict with score and metadata', async () => {
    const dataset = [{ input: 'world', expected: 'Hello world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        Grader: ({ output, expected }) => {
          return {
            score: output === expected ? 1.0 : 0.0,
            metadata: { reason: 'test metadata' },
          };
        },
      },
      evalRunName: 'run-dict-score',
    });

    const { results } = evalResult;
    expect(results[0].scores.Grader).toBe(1.0);

    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.results[0].scores.Grader.metadata).toEqual({
      reason: 'test metadata',
    });
  });

  test('handles scorer returning dict without metadata key', async () => {
    const dataset = [{ input: 'world', expected: 'Hello world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        Grader: ({ output, expected }) => ({ score: output === expected }),
      },
      evalRunName: 'run-dict-no-metadata',
    });

    const { results } = evalResult;
    expect(results[0].scores.Grader).toBe(1.0);
  });

  test('handles scorer returning dict without score key (should return 0)', async () => {
    const dataset = [{ input: 'world', expected: 'Hello world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        Grader: () => ({ metadata: { reason: 'missing score key' } }) as any,
      },
      evalRunName: 'run-invalid-dict-no-score',
    });

    const { results } = evalResult;
    expect(results[0].scores.Grader).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  test('handles scorer returning dict with invalid keys (should return 0)', async () => {
    const dataset = [{ input: 'world', expected: 'Hello world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        Grader: () => ({ score: 0.5, metadatwa: { reason: 'typo' } }) as any,
      },
      evalRunName: 'run-invalid-dict-typo',
    });

    const { results } = evalResult;
    expect(results[0].scores.Grader).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  test('handles scorer returning invalid type (string)', async () => {
    const dataset = [{ input: 'world', expected: 'Hello world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        Grader: () => 'invalid' as any,
      },
      evalRunName: 'run-invalid-type',
    });

    const { results } = evalResult;
    expect(results[0].scores.Grader).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  test('sends parameters in API payload', async () => {
    const dataset = [{ input: 'world', expected: 'Hi world!' }];

    await Eval('test task', {
      data: () => dataset,
      task: (input: string, hooks: EvalHooks<any>) =>
        `${hooks.parameters.prefix} ${input}${hooks.parameters.suffix}`,
      scorer: ({ output, expected }) => output === expected,
      evalRunName: 'run-with-params',
      parameters: {
        prefix: z.string().default('Hi'),
        suffix: z.string().default('!'),
        count: z.number().default(123),
        config: z.object({ nested: z.string() }).default({ nested: 'value' }),
      },
    });

    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.parameters).toEqual({
      prefix: 'Hi',
      suffix: '!',
      count: '123',
      config: '{"nested":"value"}',
    });
  });

  test('does not include parameters when not provided', async () => {
    const dataset = [{ input: 'world' }];

    await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: () => 1.0,
      evalRunName: 'run-no-params',
    });

    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.parameters).toBeUndefined();
  });

  test('returns summaryScores in EvalResult', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hello Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: ({ output, expected }) => output === expected,
      summaryScoresFn: (results) => ({
        passCount: results.filter((r) => r.scores.Grader === 1).length,
        average:
          results.reduce((sum, r) => sum + r.scores.Grader, 0) / results.length,
      }),
    });

    expect(evalResult.summaryScores).toBeDefined();
    expect(evalResult.summaryScores?.passCount).toBe(2);
    expect(evalResult.summaryScores?.average).toBe(1.0);
  });

  test('returns undefined summaryScores when no summaryScoresFn provided', async () => {
    const dataset = [{ input: 'world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: () => 1.0,
    });

    expect(evalResult.summaryScores).toBeUndefined();
  });

  test('returns undefined summaryScores when summaryScoresFn throws', async () => {
    const dataset = [{ input: 'world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: () => 1.0,
      summaryScoresFn: () => {
        throw new Error('Summary scorer failed');
      },
    });

    expect(evalResult.summaryScores).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      '[Statsig] Summary scorer failed:',
      expect.any(Error),
    );
  });

  test('handles task function with single input parameter', async () => {
    const dataset = [{ input: 'world', expected: 'Hello world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: ({ output, expected }) => output === expected,
      evalRunName: 'run-single-param-task',
    });

    const { results } = evalResult;
    expect(results[0].output).toBe('Hello world');
    expect(results[0].scores.Grader).toBe(1);
  });

  test('passes category to task via hooks', async () => {
    const dataset = [
      {
        input: 'world',
        expected: 'greeting: Hello world',
        category: 'greeting',
      },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string, hooks: EvalHooks<any>) =>
        `${hooks.category}: Hello ${input}`,
      scorer: ({ output, expected }) => output === expected,
      evalRunName: 'run-category-hooks',
    });

    const { results } = evalResult;
    expect(results[0].output).toBe('greeting: Hello world');
    expect(results[0].scores.Grader).toBe(1);
  });

  test('handles multiple scorers with mixed return types', async () => {
    const dataset = [{ input: 'world', expected: 'Hello world' }];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        booleanScorer: ({ output, expected }) => output === expected,
        numericScorer: () => 0.75,
        metadataScorer: () => ({
          score: 0.9,
          metadata: { reason: 'high confidence' },
        }),
      },
      evalRunName: 'run-mixed-scorers',
    });

    const { results } = evalResult;
    expect(results[0].scores.booleanScorer).toBe(1);
    expect(results[0].scores.numericScorer).toBe(0.75);
    expect(results[0].scores.metadataScorer).toBe(0.9);

    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.results[0].scores.metadataScorer.metadata).toEqual({
      reason: 'high confidence',
    });
  });

  test('includes error field in results', async () => {
    const dataset = [
      { input: 'success', expected: 'Hello success' },
      { input: 'fail', expected: 'Hello fail' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => {
        if (input === 'fail') throw new Error('Task failed');
        return 'Hello ' + input;
      },
      scorer: () => 1.0,
      evalRunName: 'run-error-field',
    });

    const { results } = evalResult;
    expect(results[0].error).toBe(false);
    expect(results[1].error).toBe(true);

    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req?.body as string);
    expect(body.results[0].error).toBe(false);
    expect(body.results[1].error).toBe(true);
  });

  test('handles async generator data', async () => {
    async function* dataGenerator() {
      yield { input: 'world', expected: 'Hello world' };
      yield { input: 'test', expected: 'Hello test' };
    }

    const evalResult = await Eval('test task', {
      data: dataGenerator(),
      task: (input: string) => 'Hello ' + input,
      scorer: ({ output, expected }) => output === expected,
      evalRunName: 'run-async-generator',
    });

    const { results } = evalResult;
    expect(results).toHaveLength(2);
    expect(results[0].output).toBe('Hello world');
    expect(results[1].output).toBe('Hello test');
  });

  test('handle summaryScores support with passing in results', async () => {
    const dataset = [
      { input: 'Foo', expected: 'Hello Foo' },
      { input: 'Bar', expected: 'Hello Bar' },
    ];

    const evalResult = await Eval('test task', {
      data: () => dataset,
      task: (input: string) => 'Hello ' + input,
      scorer: {
        correctness: ({ output, expected }) => output === (expected as any),
      },
      evalRunName: 'run-summary-scores-support-with-results',
      summaryScoresFn: (
        results: EvalResultRecord<string, string, string>[],
      ) => {
        return {
          correctness: results.filter((r) => r.scores.correctness === 1).length,
          length: results.reduce(
            (sum, r) => sum + (r.output as string).length,
            0,
          ),
        };
      },
    });

    const { results, metadata } = evalResult;
    expect(results).toHaveLength(2);

    expect(results[0]).toMatchObject({
      input: 'Foo',
      expected: 'Hello Foo',
      output: 'Hello Foo',
      scores: {
        correctness: 1,
      },
    });
    expect(results[1]).toMatchObject({
      input: 'Bar',
      expected: 'Hello Bar',
      output: 'Hello Bar',
      scores: {
        correctness: 1,
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
    expect(body.name).toBe('run-summary-scores-support-with-results');
    expect(body.summaryScores).toEqual({
      correctness: 2,
      length: 18,
    });
    expect(body.results[0].scores).toEqual({ correctness: { score: 1 } });
    expect(body.results[1].scores).toEqual({ correctness: { score: 1 } });
  });
});

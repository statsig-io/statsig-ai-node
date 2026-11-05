import { EvalDataRecord } from './EvalData';

const STATSIG_EVAL_DATASETS_ENDPOINT =
  'https://api.statsig.com/console/v1/eval_datasets';

export type StatsigDatasetRow = {
  rowID: string;
  /** Cell values by column name */
  columns: Record<string, string>;
  groups: string[];
};

type DatasetRowsResponse = {
  data?: {
    rowID: string;
    columns: { name: string; value: string }[];
    groups?: string[];
  }[];
};

/**
 * Eval data loaded from a Statsig eval dataset. Each record keeps its dataset
 * row id and the run names the dataset, so the console compares runs on the
 * dataset row by row.
 */
export class StatsigDataset<Input, Expected> {
  constructor(
    readonly name: string,
    private readonly toRecord: (
      row: StatsigDatasetRow,
    ) => EvalDataRecord<Input, Expected>,
  ) {}

  async load(apiKey: string): Promise<EvalDataRecord<Input, Expected>[]> {
    const fetchImpl: typeof fetch =
      (globalThis as any).fetch ??
      (((await import('node-fetch')) as any).default as typeof fetch);
    const limit = 100;
    const records: EvalDataRecord<Input, Expected>[] = [];
    for (let page = 1; ; page++) {
      const response = await fetchImpl(
        `${STATSIG_EVAL_DATASETS_ENDPOINT}/${encodeURIComponent(
          this.name,
        )}/rows?page=${page}&limit=${limit}`,
        { headers: { 'STATSIG-API-KEY': apiKey } },
      );
      if (!response.ok) {
        throw new Error(
          `[Statsig] Failed to load eval dataset '${this.name}': ${response.status} ${response.statusText}`,
        );
      }
      const rows = ((await response.json()) as DatasetRowsResponse).data ?? [];
      for (const row of rows) {
        records.push({
          ...this.toRecord({
            rowID: row.rowID,
            columns: Object.fromEntries(
              row.columns.map(({ name, value }) => [name, value]),
            ),
            groups: row.groups ?? [],
          }),
          rowID: row.rowID,
        });
      }
      if (rows.length < limit) {
        return records;
      }
    }
  }
}

/**
 * Loads a Statsig eval dataset as `Eval()` data. `toRecord` says which
 * columns hold the input and expected value, e.g.
 * `(row) => ({ input: row.columns.question, expected: row.columns.answer })`.
 */
export function statsigDataset<Input, Expected = void>(
  name: string,
  toRecord: (row: StatsigDatasetRow) => EvalDataRecord<Input, Expected>,
): StatsigDataset<Input, Expected> {
  return new StatsigDataset(name, toRecord);
}

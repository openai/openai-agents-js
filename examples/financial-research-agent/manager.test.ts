import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  FinancialReportData,
  FinancialSearchPlan,
  plannerAgent,
  VerificationResult,
} from './agents';
import { FinancialResearchManager } from './manager';

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('@openai/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openai/agents')>()),
  run: runMock,
}));

const initialReport: FinancialReportData = {
  short_summary: 'Initial summary',
  markdown_report: 'Initial report',
  follow_up_questions: [],
};

const revisedReport: FinancialReportData = {
  short_summary: 'Revised summary',
  markdown_report: 'Revised report',
  follow_up_questions: [],
};

class TestFinancialResearchManager extends FinancialResearchManager {
  searchResults = ['Primary source summary'];
  writeReportSearchResults: string[] | undefined;
  writeReportCalls = 0;
  verificationCalls = 0;
  revisionCalls = 0;
  verificationFailuresBeforePass = 0;

  async planSearches(): Promise<FinancialSearchPlan> {
    return { searches: [] };
  }

  async performSearches(): Promise<string[]> {
    return this.searchResults;
  }

  async writeReport(
    _query: string,
    searchResults: string[],
  ): Promise<FinancialReportData> {
    this.writeReportCalls++;
    this.writeReportSearchResults = searchResults;
    return initialReport;
  }

  async verifyReport(
    _report: FinancialReportData,
  ): Promise<VerificationResult> {
    this.verificationCalls++;
    if (this.verificationCalls <= this.verificationFailuresBeforePass) {
      return {
        verified: false,
        issues: `Resolve verification issue ${this.verificationCalls}.`,
      };
    }
    return { verified: true, issues: '' };
  }

  async reviseReport(
    _query: string,
    _report: FinancialReportData,
    _verification: VerificationResult,
    _searchResults: string[],
  ): Promise<FinancialReportData> {
    this.revisionCalls++;
    return {
      ...revisedReport,
      short_summary: `Revised summary ${this.revisionCalls}`,
    };
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  runMock.mockReset().mockRejectedValue(new Error('Unexpected model call.'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([
  [0, 0],
  [5, 5],
  [15, 15],
  [18, 15],
])(
  'plans and performs %i searches with a limit of %i',
  async (planned, expected) => {
    const manager = new FinancialResearchManager();
    const plan: FinancialSearchPlan = {
      searches: Array.from({ length: planned }, (_, index) => ({
        query: `query ${index}`,
        reason: `reason ${index}`,
      })),
    };
    runMock.mockResolvedValueOnce({ finalOutput: plan });
    const search = vi
      .spyOn(manager, 'search')
      .mockImplementation(async (item) => `Summary for ${item.query}`);

    const returnedPlan = await manager.planSearches('Research query');
    const results = await manager.performSearches(returnedPlan);

    expect(returnedPlan).toBe(plan);
    expect(plan.searches).toHaveLength(planned);
    expect(runMock).toHaveBeenCalledExactlyOnceWith(
      plannerAgent,
      'Query: Research query',
    );
    expect(search.mock.calls).toEqual(
      plan.searches.slice(0, expected).map((item) => [item]),
    );
    expect(results).toEqual(
      Array.from(
        { length: expected },
        (_, index) => `Summary for query ${index}`,
      ),
    );
    expect(console.log).toHaveBeenCalledWith(
      `[planning] Will perform ${expected} searches`,
    );
    expect(
      vi
        .mocked(console.log)
        .mock.calls.filter(([message]) =>
          String(message).endsWith(' completed'),
        ),
    ).toEqual(
      Array.from({ length: expected }, (_, index) => [
        `[searching] Searching... ${index + 1}/${expected} completed`,
      ]),
    );
  },
);

test('preserves plan order and counts failed searches without replacing them', async () => {
  const manager = new FinancialResearchManager();
  const plan: FinancialSearchPlan = {
    searches: Array.from({ length: 18 }, (_, index) => ({
      query: `query ${index}`,
      reason: `reason ${index}`,
    })),
  };
  // Control completion order at the search boundary without calling a model.
  const completions: ((result: string | null) => void)[] = [];
  const search = vi.spyOn(manager, 'search').mockImplementation(
    () =>
      new Promise<string | null>((resolve) => {
        completions.push(resolve);
      }),
  );

  const pendingResults = manager.performSearches(plan);
  expect(search).toHaveBeenCalledTimes(15);
  for (let index = 14; index >= 0; index--) {
    completions[index](index === 1 ? null : `Summary ${index}`);
  }

  expect(await pendingResults).toEqual([
    'Summary 0',
    ...Array.from({ length: 13 }, (_, index) => `Summary ${index + 2}`),
  ]);
  expect(search.mock.calls).toEqual(
    plan.searches.slice(0, 15).map((item) => [item]),
  );
  expect(
    vi
      .mocked(console.log)
      .mock.calls.filter(([message]) => String(message).endsWith(' completed')),
  ).toEqual(
    Array.from({ length: 15 }, (_, index) => [
      `[searching] Searching... ${index + 1}/15 completed`,
    ]),
  );
  expect(runMock).not.toHaveBeenCalled();
});

test('revises and re-verifies until the report passes verification', async () => {
  const manager = new TestFinancialResearchManager();
  manager.verificationFailuresBeforePass = 2;

  await manager.run('Research query');

  expect(manager.revisionCalls).toBe(2);
  expect(manager.verificationCalls).toBe(3);
});

test('does not revise a report that passes verification', async () => {
  const manager = new TestFinancialResearchManager();

  await manager.run('Research query');

  expect(manager.revisionCalls).toBe(0);
  expect(manager.verificationCalls).toBe(1);
});

test('fails before writing when no usable search summaries remain', async () => {
  const manager = new TestFinancialResearchManager();
  manager.searchResults = [];

  await expect(manager.run('Research query')).rejects.toThrow(
    'Financial research failed because no usable search summaries were returned.',
  );

  expect(manager.writeReportCalls).toBe(0);
  expect(manager.verificationCalls).toBe(0);
});

test('fails before writing when the search summary is blank', async () => {
  const manager = new TestFinancialResearchManager();
  manager.searchResults = [''];

  await expect(manager.run('Research query')).rejects.toThrow(
    'Financial research failed because no usable search summaries were returned.',
  );

  expect(manager.writeReportCalls).toBe(0);
  expect(manager.verificationCalls).toBe(0);
});

test('filters blank search summaries while preserving usable results', async () => {
  const manager = new TestFinancialResearchManager();
  manager.searchResults = [
    '',
    'Primary source summary',
    ' \n',
    'Secondary source summary',
  ];

  await manager.run('Research query');

  expect(manager.writeReportSearchResults).toEqual([
    'Primary source summary',
    'Secondary source summary',
  ]);
});

test('fails closed when the report remains unverified', async () => {
  const manager = new TestFinancialResearchManager();
  manager.verificationFailuresBeforePass = 3;

  await expect(manager.run('Research query')).rejects.toThrow(
    'Report failed verification after 2 revisions:\nResolve verification issue 3.',
  );

  expect(manager.revisionCalls).toBe(2);
  expect(manager.verificationCalls).toBe(3);
});

import { OpenAIProvider, Runner } from '@openai/agents';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  FinancialReportData,
  FinancialSearchPlan,
  plannerAgent,
  VerificationResult,
} from './agents';
import { FinancialResearchManager, type SearchResult } from './manager';

const evidence = (summary: string): SearchResult => ({
  summary,
  sources: [{ url: 'https://example.com/results', title: 'Results' }],
});

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('@openai/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openai/agents')>()),
  run: runMock,
}));

const initialReport: FinancialReportData = {
  short_summary: 'Initial summary',
  markdown_report: 'Initial report [Results](https://example.com/results)',
  follow_up_questions: [],
};

const revisedReport: FinancialReportData = {
  short_summary: 'Revised summary',
  markdown_report: 'Revised report [Results](https://example.com/results)',
  follow_up_questions: [],
};

class TestFinancialResearchManager extends FinancialResearchManager {
  searchResults = [evidence('Primary source summary')];
  writeReportSearchResults: SearchResult[] | undefined;
  writeReportCalls = 0;
  verificationCalls = 0;
  revisionCalls = 0;
  verificationFailuresBeforePass = 0;

  async planSearches(): Promise<FinancialSearchPlan> {
    return { searches: [] };
  }

  async performSearches(): Promise<SearchResult[]> {
    return this.searchResults;
  }

  async writeReport(
    _query: string,
    searchResults: SearchResult[],
  ): Promise<FinancialReportData> {
    this.writeReportCalls++;
    this.writeReportSearchResults = searchResults;
    return initialReport;
  }

  async verifyReport(
    _report: FinancialReportData,
    _searchResults: SearchResult[],
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
    _searchResults: SearchResult[],
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
      .mockImplementation(async (item) =>
        evidence(`Summary for ${item.query}`),
      );

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
      Array.from({ length: expected }, (_, index) =>
        evidence(`Summary for query ${index}`),
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
  const completions: ((result: SearchResult | null) => void)[] = [];
  const search = vi.spyOn(manager, 'search').mockImplementation(
    () =>
      new Promise<SearchResult | null>((resolve) => {
        completions.push(resolve);
      }),
  );

  const pendingResults = manager.performSearches(plan);
  expect(search).toHaveBeenCalledTimes(15);
  for (let index = 14; index >= 0; index--) {
    completions[index](index === 1 ? null : evidence(`Summary ${index}`));
  }

  expect(await pendingResults).toEqual([
    evidence('Summary 0'),
    ...Array.from({ length: 13 }, (_, index) =>
      evidence(`Summary ${index + 2}`),
    ),
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
  manager.searchResults = [evidence('')];

  await expect(manager.run('Research query')).rejects.toThrow(
    'Financial research failed because no usable search summaries were returned.',
  );

  expect(manager.writeReportCalls).toBe(0);
  expect(manager.verificationCalls).toBe(0);
});

test('filters blank search summaries while preserving usable results', async () => {
  const manager = new TestFinancialResearchManager();
  manager.searchResults = [
    evidence(''),
    evidence('Primary source summary'),
    evidence(' \n'),
    evidence('Secondary source summary'),
  ];

  await manager.run('Research query');

  expect(manager.writeReportSearchResults).toEqual([
    evidence('Primary source summary'),
    evidence('Secondary source summary'),
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

test('collects only service-returned search sources and citation annotations', async () => {
  const { collectSearchSources } = await import('./manager');
  expect(
    collectSearchSources([
      {
        rawItem: {
          type: 'hosted_tool_call',
          name: 'web_search_call',
          providerData: {
            action: {
              sources: [
                { url: 'https://example.com/results', title: 'Results' },
              ],
            },
          },
        },
      },
      {
        rawItem: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Invented https://invented.example/',
              providerData: {
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com/results',
                    title: 'Results',
                  },
                  {
                    type: 'url_citation',
                    url: 'https://example.com/filing',
                    title: 'Filing',
                  },
                ],
              },
            },
          ],
        },
      },
      {
        rawItem: {
          type: 'function_call',
          providerData: {
            action: { sources: [{ url: 'https://invented.example/' }] },
          },
        },
      },
    ]),
  ).toEqual([
    { url: 'https://example.com/results', title: 'Results' },
    { url: 'https://example.com/filing', title: 'Filing' },
  ]);
});

test('verifies the executive summary and follow-up questions with the report', async () => {
  const manager = new FinancialResearchManager();
  vi.spyOn(manager, 'auditReport').mockResolvedValue({
    verified: true,
    issues: '',
  });
  runMock.mockResolvedValueOnce({
    finalOutput: { verified: true, issues: '' },
  });
  await manager.verifyReport(initialReport, [evidence('Source evidence')]);
  const input = runMock.mock.calls[0][1];
  expect(input).toContain(JSON.stringify(initialReport, null, 2));
  expect(input).toContain('Source evidence');
});

test('keeps hosted search on Responses and passes actual source metadata onward', async () => {
  const selectedRunner = { run: vi.fn() };
  const manager = new FinancialResearchManager(selectedRunner);
  const searchRun = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
    finalOutput: 'Revenue rose [Results](https://example.com/results).',
    newItems: [
      {
        rawItem: {
          type: 'hosted_tool_call',
          name: 'web_search_call',
          providerData: {
            action: {
              sources: [
                { url: 'https://example.com/results', title: 'Results' },
              ],
            },
          },
        },
      },
    ],
  } as any);

  const output = await manager.search({
    query: 'Company earnings',
    reason: 'Reported results',
  });

  expect(output?.sources).toEqual([
    { url: 'https://example.com/results', title: 'Results' },
  ]);
  expect(output?.summary).toContain('Revenue rose');
  expect(
    (searchRun.mock.instances[0] as Runner).config.modelProvider,
  ).toBeInstanceOf(OpenAIProvider);
  expect(selectedRunner.run).not.toHaveBeenCalled();
});

test.each([
  '',
  'Summary with a prose-only URL https://example.com/unretrieved',
])(
  'rejects search output without service source metadata: %s',
  async (finalOutput) => {
    vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
      finalOutput,
      newItems: [],
    } as any);
    const manager = new FinancialResearchManager();
    expect(
      await manager.search({
        query: 'Company earnings',
        reason: 'Reported results',
      }),
    ).toBeNull();
  },
);

test.each([
  'Uncited report',
  '[Unretrieved](https://example.com/results/extra)',
  '[Unretrieved](https://example.com/results?invented=1)',
  '[Unretrieved](https://invented.example/) https://example.com/results',
])(
  'rejects a falsely approved report without an exact retrieved citation: %s',
  async (markdown_report) => {
    const manager = new TestFinancialResearchManager();
    const report = { ...initialReport, markdown_report };
    vi.spyOn(manager, 'writeReport').mockResolvedValue(report);
    vi.spyOn(manager, 'reviseReport').mockResolvedValue(report);

    await expect(manager.run('Research query')).rejects.toThrow(
      'The report must include an inline Markdown citation to an exact service-returned source URL.',
    );
    expect(manager.verificationCalls).toBe(3);
  },
);

test('rejects a verifier approval that still lists issues', async () => {
  const manager = new TestFinancialResearchManager();
  vi.spyOn(manager, 'verifyReport').mockResolvedValue({
    verified: true,
    issues: 'Revenue conflicts with the source.',
  });

  await expect(manager.run('Research query')).rejects.toThrow(
    'Revenue conflicts with the source.',
  );
  expect(manager.revisionCalls).toBe(2);
});

test('retains original service evidence when revising an uncited report', async () => {
  const manager = new TestFinancialResearchManager();
  const sources = [
    evidence(
      'Revenue rose; prose-only https://invented.example/ is not retrieved.',
    ),
  ];
  manager.searchResults = sources;
  vi.spyOn(manager, 'writeReport').mockResolvedValue({
    ...initialReport,
    markdown_report: '[Invented](https://invented.example/)',
  });
  const revise = vi.spyOn(manager, 'reviseReport');
  const verify = vi.spyOn(manager, 'verifyReport');

  await manager.run('Research query');

  expect(revise).toHaveBeenCalledTimes(1);
  expect(revise.mock.calls[0][3]).toEqual(sources);
  expect(revise.mock.calls[0][2].verified).toBe(false);
  expect(verify.mock.calls[1][1]).toEqual(sources);
  expect(console.log).toHaveBeenCalledWith(
    `Report:\n${revisedReport.markdown_report}`,
  );
});

test('renders source IDs to exact service URLs before verification and printing', async () => {
  const manager = new TestFinancialResearchManager();
  const url = 'https://images.example.com/earnings.pdf?utm_source=api_returned';
  manager.searchResults = [
    { summary: 'Reported revenue rose.', sources: [{ url }] },
  ];
  vi.spyOn(manager, 'writeReport').mockResolvedValue({
    short_summary: 'Revenue rose [source:S1]',
    markdown_report: 'Reported results [source:S1]',
    follow_up_questions: [],
  });
  const verify = vi.spyOn(manager, 'verifyReport');

  await manager.run('Research query');

  expect(verify.mock.calls[0][0]).toEqual({
    short_summary: `Revenue rose [S1](${url})`,
    markdown_report: `Reported results [S1](${url})`,
    follow_up_questions: [],
  });
  expect(console.log).toHaveBeenCalledWith(
    `Report:\nReported results [S1](${url})`,
  );
  expect(manager.revisionCalls).toBe(0);
});

test('rejects unknown IDs even when a valid citation also appears', async () => {
  const manager = new TestFinancialResearchManager();
  const report = {
    ...initialReport,
    markdown_report: '[source:S1] and [source:S999]',
  };
  vi.spyOn(manager, 'writeReport').mockResolvedValue(report);
  vi.spyOn(manager, 'reviseReport').mockResolvedValue(report);

  await expect(manager.run('Research query')).rejects.toThrow(
    'The report contains an unknown source reference.',
  );
});

test('keeps one source mapping through retries without repairing guessed tracking suffixes', async () => {
  const manager = new TestFinancialResearchManager();
  const url = 'https://images.example.com/results.pdf?utm_source=service';
  manager.searchResults = [
    { summary: 'First results.', sources: [{ url }] },
    {
      summary: 'Repeated source.',
      sources: [{ url }, { url: 'https://example.com/filing' }],
    },
  ];
  const guessed = {
    ...initialReport,
    markdown_report:
      '[Results](https://www.example.com/results.pdf?utm_source=openai)',
  };
  vi.spyOn(manager, 'writeReport').mockResolvedValue(guessed);
  vi.spyOn(manager, 'reviseReport').mockResolvedValue({
    ...initialReport,
    markdown_report: 'Results [source:S1]. Filing [source:S2].',
  });
  const verify = vi.spyOn(manager, 'verifyReport');

  await manager.run('Research query');

  expect(verify.mock.calls[0][0]).toEqual(guessed);
  expect(verify.mock.calls[1][0].markdown_report).toBe(
    `Results [S1](${url}). Filing [S2](https://example.com/filing).`,
  );
  expect(verify.mock.calls[1][1]).toEqual(manager.searchResults);
});

test('exposes deterministic deduplicated source IDs to the writer and reviser', async () => {
  const manager = new FinancialResearchManager();
  const sources = [evidence('First'), evidence('Second')];
  runMock.mockResolvedValue({ finalOutput: initialReport });

  await manager.writeReport('Query', sources);
  await manager.reviseReport(
    'Query',
    initialReport,
    { verified: false, issues: 'Cite the result.' },
    sources,
  );

  for (const [, input] of runMock.mock.calls) {
    expect(input).toContain('"id":"S1","url":"https://example.com/results"');
    expect(input).not.toContain('"id":"S2"');
  }
});

const primaryUrl = 'https://investor.example.com/FY26-financial-statements.pdf';
function auditResponse(supported: boolean, opened = true) {
  return {
    finalOutput: {
      verified: supported,
      issues: supported
        ? ''
        : 'FY26 Services revenue disagrees with the primary statement.',
      checks: [
        {
          claim: 'FY26 Services revenue',
          source_url: primaryUrl,
          supporting_extract: 'Services 123,301 (millions)',
          supported,
          explanation:
            'FY26 full-year Services revenue is $123.301B, not $105B.',
        },
      ],
    },
    newItems: opened
      ? [
          {
            rawItem: {
              type: 'hosted_tool_call',
              name: 'web_search_call',
              status: 'completed',
              providerData: { action: { type: 'open_page', url: primaryUrl } },
            },
          },
        ]
      : [
          {
            rawItem: {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  providerData: {
                    annotations: [{ type: 'url_citation', url: primaryUrl }],
                  },
                },
              ],
            },
          },
        ],
  } as any;
}

test('primary-document audit overrules a positive summary-based verifier', async () => {
  const manager = new FinancialResearchManager();
  runMock.mockResolvedValue({ finalOutput: { verified: true, issues: '' } });
  vi.spyOn(Runner.prototype, 'run').mockResolvedValue(auditResponse(false));
  const sources = [evidence('FY26 Services revenue was $105B.')];

  const verdict = await manager.verifyReport(
    {
      ...initialReport,
      markdown_report:
        'FY26 Services revenue was $105B [Results](https://example.com/results).',
    },
    sources,
  );

  expect(verdict.verified).toBe(false);
  expect(verdict.issues).toContain('$123.301B, not $105B');
  expect(sources[1].sources).toEqual([{ url: primaryUrl }]);
  expect(runMock.mock.calls[0][1]).toContain('Services 123,301 (millions)');
});

test('rejects audit approval without an actual open_page even with citation annotations', async () => {
  const manager = new FinancialResearchManager();
  vi.spyOn(Runner.prototype, 'run').mockResolvedValue(
    auditResponse(true, false),
  );
  const verdict = await manager.auditReport(initialReport, [
    evidence('Search summary'),
  ]);
  expect(verdict.verified).toBe(false);
  expect(verdict.issues).toContain('no opened primary-source evidence');
});

test('revises a wrong financial figure using newly opened primary evidence and re-audits it', async () => {
  const manager = new FinancialResearchManager();
  vi.spyOn(manager, 'planSearches').mockResolvedValue({ searches: [] });
  vi.spyOn(manager, 'performSearches').mockResolvedValue([
    evidence('FY26 Services revenue was $105B.'),
  ]);
  vi.spyOn(manager, 'writeReport').mockResolvedValue({
    ...initialReport,
    markdown_report: 'FY26 Services revenue was $105B [source:S1].',
  });
  const revise = vi.spyOn(manager, 'reviseReport').mockResolvedValue({
    ...initialReport,
    markdown_report: 'FY26 Services revenue was $123.301B [source:S2].',
  });
  runMock.mockResolvedValue({ finalOutput: { verified: true, issues: '' } });
  const audit = vi
    .spyOn(Runner.prototype, 'run')
    .mockResolvedValueOnce(auditResponse(false))
    .mockResolvedValueOnce(auditResponse(true));

  await manager.run('Analyze FY26 Services revenue.');

  expect(revise).toHaveBeenCalledTimes(1);
  expect(revise.mock.calls[0][2].issues).toContain('$123.301B, not $105B');
  expect(audit.mock.calls[1][1]).toContain(`$123.301B [S2](${primaryUrl})`);
  expect(console.log).toHaveBeenCalledWith(
    `Report:\nFY26 Services revenue was $123.301B [S2](${primaryUrl}).`,
  );
});

test('rejects an audit relying on a failed open_page receipt', async () => {
  const manager = new FinancialResearchManager();
  const response = auditResponse(true);
  response.newItems[0].rawItem.status = 'failed';
  vi.spyOn(Runner.prototype, 'run').mockResolvedValue(response);
  const verdict = await manager.auditReport(initialReport, [
    evidence('Search summary'),
  ]);
  expect(verdict.verified).toBe(false);
  expect(verdict.issues).toContain('no opened primary-source evidence');
});

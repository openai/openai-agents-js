import { Agent, OpenAIProvider, run, Runner, RunResult } from '@openai/agents';
import { financialsAgent } from './agents.ts';
import {
  plannerAgent,
  FinancialSearchItem,
  FinancialSearchPlan,
  MAX_SEARCHES,
} from './agents.ts';
import { riskAgent } from './agents.ts';
import { searchAgent } from './agents.ts';
import { verifierAgent, VerificationResult } from './agents.ts';
import { writerAgent, FinancialReportData } from './agents.ts';

const MAX_REPORT_REVISIONS = 2;

function enforceVerification(
  report: FinancialReportData,
  searchResults: SearchResult[],
  verification: VerificationResult,
): VerificationResult {
  const reportText = `${report.short_summary}\n${report.markdown_report}`;
  const hasCitation = searchResults.some(({ sources }) =>
    sources.some(
      ({ url }) =>
        reportText.includes(`](${url})`) || reportText.includes(`](<${url}>)`),
    ),
  );
  const issues = [verification.issues.trim()];
  if (/\[source:[^\]]*\]/.test(JSON.stringify(report))) {
    issues.push(
      'The report contains an unknown source reference. Use only the supplied source IDs.',
    );
  }
  if (!hasCitation) {
    issues.push(
      'The report must include an inline Markdown citation to an exact service-returned source URL.',
    );
  }
  return {
    verified: verification.verified && issues.every((issue) => !issue),
    issues: issues.filter(Boolean).join('\n'),
  };
}

export type SearchResult = { summary: string; sources: Source[] };

function sourceReferences(searchResults: SearchResult[]): Map<string, Source> {
  const unique = new Map(
    searchResults.flatMap(({ sources }) =>
      sources.map((source) => [source.url, source] as const),
    ),
  );
  return new Map(
    [...unique.values()].map((source, index) => [`S${index + 1}`, source]),
  );
}

function renderSourceReferences(
  report: FinancialReportData,
  references: Map<string, Source>,
): FinancialReportData {
  const render = (text: string) =>
    text.replace(/\[source:([^\]\s]+)\]/g, (reference, id: string) => {
      const source = references.get(id);
      return source ? `[${id}](${source.url})` : reference;
    });
  return {
    short_summary: render(report.short_summary),
    markdown_report: render(report.markdown_report),
    follow_up_questions: report.follow_up_questions.map(render),
  };
}

function formatSearchResults(searchResults: SearchResult[]): string {
  const references = sourceReferences(searchResults);
  const ids = new Map([...references].map(([id, source]) => [source.url, id]));
  return searchResults
    .map(
      (result, index) =>
        `Source summary ${index + 1}:\n${result.summary}\n\nService-returned sources (cite an exact source ID such as [source:S1]):\n${JSON.stringify(result.sources.map((source) => ({ id: ids.get(source.url), ...source })))}`,
    )
    .join('\n\n');
}

type Source = { url: string; title?: string };

export function collectSearchSources(
  items: ReadonlyArray<{ rawItem?: unknown }>,
): Source[] {
  const sources = new Map<string, Source>();
  function add(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const source = value as Record<string, unknown>;
    if (typeof source.url !== 'string' || !/^https?:\/\//.test(source.url))
      return;
    sources.set(source.url, {
      url: source.url,
      ...(typeof source.title === 'string' ? { title: source.title } : {}),
    });
  }
  for (const { rawItem } of items) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, any>;
    if (item.type === 'hosted_tool_call' && item.name === 'web_search_call') {
      for (const source of item.providerData?.action?.sources ?? [])
        add(source);
    }
    if (item.type === 'message' && item.role === 'assistant') {
      for (const part of item.content ?? []) {
        for (const annotation of part.providerData?.annotations ?? []) {
          if (annotation.type === 'url_citation') add(annotation);
        }
      }
    }
  }
  return [...sources.values()];
}

// Custom output extractor for sub-agents that return an AnalysisSummary
async function summaryExtractor(
  runResult: RunResult<unknown, Agent<unknown, any>>,
): Promise<string> {
  return String(runResult.finalOutput.summary);
}

const reportWriterAgent = writerAgent.clone({
  tools: [
    financialsAgent.asTool({
      toolName: 'fundamentals_analysis',
      toolDescription: 'Use to get a short write-up of key financial metrics',
      customOutputExtractor: summaryExtractor,
    }),
    riskAgent.asTool({
      toolName: 'risk_analysis',
      toolDescription: 'Use to get a short write-up of potential red flags',
      customOutputExtractor: summaryExtractor,
    }),
  ],
});

export class FinancialResearchManager {
  // Hosted search supplies citation metadata that stock Codex does not expose.
  // Only this research boundary uses Responses; all other agents use the caller's runner.
  private readonly searchRunner = new Runner({
    modelProvider: new OpenAIProvider({
      useResponses: true,
      useResponsesWebSocket: false,
    }),
    model: 'gpt-5.4',
  });

  private readonly runner: Pick<Runner, 'run'>;

  constructor(runner: Pick<Runner, 'run'> = { run }) {
    this.runner = runner;
  }

  async run(query: string): Promise<void> {
    console.log(`[start] Starting financial research...`);
    const searchPlan = await this.planSearches(query);
    const searchResults = (await this.performSearches(searchPlan)).filter(
      (result) => result.summary.trim().length > 0 && result.sources.length > 0,
    );
    if (searchResults.length === 0) {
      throw new Error(
        'Financial research failed because no usable search summaries were returned.',
      );
    }
    const references = sourceReferences(searchResults);
    let report = renderSourceReferences(
      await this.writeReport(query, searchResults),
      references,
    );
    let verification = enforceVerification(
      report,
      searchResults,
      await this.verifyReport(report, searchResults),
    );
    let revisions = 0;
    while (!verification.verified && revisions < MAX_REPORT_REVISIONS) {
      report = renderSourceReferences(
        await this.reviseReport(query, report, verification, searchResults),
        references,
      );
      verification = enforceVerification(
        report,
        searchResults,
        await this.verifyReport(report, searchResults),
      );
      revisions++;
    }
    if (!verification.verified) {
      throw new Error(
        `Report failed verification after ${MAX_REPORT_REVISIONS} revisions:\n${verification.issues}`,
      );
    }
    const finalReport = `Report summary\n\n${report.short_summary}`;
    console.log(finalReport);
    console.log('\n\n=====REPORT=====\n\n');
    console.log(`Report:\n${report.markdown_report}`);
    console.log('\n\n=====FOLLOW UP QUESTIONS=====\n\n');
    console.log(report.follow_up_questions.join('\n'));
    console.log('\n\n=====VERIFICATION=====\n\n');
    console.log(verification);
  }

  async planSearches(query: string): Promise<FinancialSearchPlan> {
    console.log(`[planning] Planning searches...`);
    const result = await this.runner.run(plannerAgent, `Query: ${query}`);
    console.log(
      `[planning] Will perform ${Math.min(result.finalOutput!.searches.length, MAX_SEARCHES)} searches`,
    );
    return result.finalOutput!;
  }

  async performSearches(
    searchPlan: FinancialSearchPlan,
  ): Promise<SearchResult[]> {
    // Enforce the host's search budget before allocating or scheduling work.
    const searches = searchPlan.searches.slice(0, MAX_SEARCHES);
    // Run selected searches in parallel and log progress as each completes.
    console.log(`[searching] Searching...`);
    let numCompleted = 0;
    const results: (SearchResult | null)[] = new Array(searches.length);
    await Promise.all(
      searches.map(async (item, i) => {
        const result = await this.search(item);
        results[i] = result;
        numCompleted++;
        console.log(
          `[searching] Searching... ${numCompleted}/${searches.length} completed`,
        );
      }),
    );
    console.log(`[searching] Done searching.`);
    // Filter out nulls and preserve order
    return results.filter((r): r is SearchResult => r !== null);
  }

  async search(item: FinancialSearchItem): Promise<SearchResult | null> {
    const inputData = `Search term: ${item.query}\nReason: ${item.reason}`;
    try {
      const result = await this.searchRunner.run(searchAgent, inputData);
      const sources = collectSearchSources(result.newItems);
      if (!result.finalOutput?.trim() || sources.length === 0) {
        return null;
      }
      return { summary: result.finalOutput, sources };
    } catch {
      return null;
    }
  }

  async writeReport(
    query: string,
    searchResults: SearchResult[],
  ): Promise<FinancialReportData> {
    console.log(`[writing] Thinking about report...`);
    const inputData = `Original query: ${query}\n\n${formatSearchResults(searchResults)}`;
    const result = await this.runner.run(reportWriterAgent, inputData);
    console.log(`[writing] Done writing report.`);
    return result.finalOutput!;
  }

  async verifyReport(
    report: FinancialReportData,
    searchResults: SearchResult[],
  ): Promise<VerificationResult> {
    console.log(`[verifying] Verifying report...`);
    const inputData = `Complete report:\n${JSON.stringify(report, null, 2)}\n\nSource summaries:\n${formatSearchResults(searchResults)}`;
    const result = await this.runner.run(verifierAgent, inputData);
    console.log(`[verifying] Done verifying report.`);
    return result.finalOutput!;
  }

  async reviseReport(
    query: string,
    report: FinancialReportData,
    verification: VerificationResult,
    searchResults: SearchResult[],
  ): Promise<FinancialReportData> {
    console.log(`[revising] Revising report from verifier feedback...`);
    const inputData = `Original query: ${query}

The current report failed verification. Resolve every issue in all report fields, including the executive summary. Remove the entire unsupported claim instead of merely rephrasing or caveating it. When sources conflict, omit the disputed figure or attribution unless a supplied source directly resolves the conflict. Do not introduce new facts. Cite the claims you keep. Use the matching source ID, for example [source:S1], so the host inserts the exact retrieved URL. Do not copy, shorten, or repair URLs. If you cannot substantiate a claim with those sources, delete it.

Verifier feedback:
${verification.issues}

Current report:
${JSON.stringify(report, null, 2)}

Source summaries:
${formatSearchResults(searchResults)}`;
    const result = await this.runner.run(reportWriterAgent, inputData);
    console.log(`[revising] Done revising report.`);
    return result.finalOutput!;
  }
}

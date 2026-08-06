import { withCustomSpan, withTrace } from '@openai/agents';
import {
  plannerAgent,
  webSearchPlan,
  searchAgent,
  writerAgent,
  reportData,
  WebSearchPlan,
  WebSearchItem,
  ReportData,
} from './agents';
import { Runner } from '@openai/agents';

export class ResearchManager {
  runner: Runner;
  constructor(runner: Runner = new Runner()) {
    this.runner = runner;
  }

  async run(query: string): Promise<void> {
    await withTrace('Research workflow', async (trace) => {
      console.log(
        `[trace_id] View trace: https://platform.openai.com/logs/trace?trace_id=${trace.traceId}`,
      );
      console.log(`[starting] Starting research...`);
      const searchPlan = await this._planSearches(query);
      const searchResults = await this._performSearches(searchPlan);
      const report = await this._writeReport(query, searchResults);

      const finalReport = `Report summary\n\n${report.shortSummary}`;
      console.log(`[final_report] ${finalReport}`);
      console.log('Research complete.');

      console.log('\n\n=====REPORT=====\n\n');
      console.log(`Report: ${report.markdownReport}`);
      console.log('\n\n=====FOLLOW UP QUESTIONS=====\n\n');
      const followUpQuestions = report.followUpQuestions.join('\n');
      console.log(`Follow up questions: ${followUpQuestions}`);
    });
  }

  async _planSearches(query: string) {
    console.log('[planning] Planning searches...');
    const result = await this.runner.run(plannerAgent, `Query: ${query}`);
    const parsed = webSearchPlan.parse(result.finalOutput);
    console.log(`[planning] Will perform ${parsed.searches.length} searches`);
    return parsed;
  }

  async _performSearches(searchPlan: WebSearchPlan): Promise<string[]> {
    return await withCustomSpan(
      async (_span) => {
        console.log('[searching] Searching...');
        let numCompleted = 0;
        const tasks = searchPlan.searches.map((item: WebSearchItem) =>
          this._search(item),
        );
        const results: string[] = [];
        for await (const result of tasks) {
          if (result != null) results.push(result);
          numCompleted++;
          console.log(
            `[searching] Searching... ${numCompleted}/${tasks.length} completed`,
          );
        }
        console.log('[searching] done');
        return results;
      },
      { data: { name: 'Search the web' } },
    );
  }

  async _search(item: WebSearchItem): Promise<string | null> {
    const input = `Search term: ${item.query}\nReason for searching: ${item.reason}`;
    try {
      const result = await this.runner.run(searchAgent, input);
      return String(result.finalOutput);
    } catch {
      return null;
    }
  }

  async _writeReport(
    query: string,
    searchResults: string[],
  ): Promise<ReportData> {
    console.log('[writing] Thinking about report...');
    const input = `Original query: ${query}\nSummarized search results: ${searchResults}`;
    const result = await this.runner.run(writerAgent, input);
    // Simulate streaming updates (could be implemented with events if needed)
    console.log('[writing] done');
    return reportData.parse(result.finalOutput);
  }
}

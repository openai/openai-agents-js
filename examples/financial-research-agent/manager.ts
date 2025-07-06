import { Agent, run, RunResult } from '@openai/agents';
import { financialsAgent } from './agents';
import {
  plannerAgent,
  FinancialSearchItem,
  FinancialSearchPlan,
} from './agents';
import { riskAgent } from './agents';
import { searchAgent } from './agents';
import { verifierAgent, VerificationResult } from './agents';
import { writerAgent, FinancialReportData } from './agents';

// Custom output extractor for sub-agents that return an AnalysisSummary
async function summaryExtractor(
  runResult: RunResult<unknown, Agent<unknown, any>>,
): Promise<string> {
  return String(runResult.finalOutput.summary);
}

export class FinancialResearchManager {
  async run(query: string): Promise<void> {
    console.log(`[start] Starting financial research...`);
    const searchPlan = await this.planSearches(query);
    const searchResults = await this.performSearches(searchPlan);
    const report = await this.writeReport(query, searchResults);
    const verification = await this.verifyReport(report);
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
    const result = await run(plannerAgent, `Query: ${query}`);
    console.log(
      `[planning] Will perform ${result.finalOutput?.searches.length} searches`,
    );
    return result.finalOutput!;
  }

  async performSearches(searchPlan: FinancialSearchPlan): Promise<string[]> {
    // Run all searches in parallel and log progress as each completes
    console.log(`[searching] Searching...`);
    let numCompleted = 0;
    const results: (string | null)[] = new Array(searchPlan.searches.length);
    await Promise.all(
      searchPlan.searches.map(async (item, i) => {
        const result = await this.search(item);
        results[i] = result;
        numCompleted++;
        console.log(
          `[searching] Searching... ${numCompleted}/${searchPlan.searches.length} completed`,
        );
      }),
    );
    console.log(`[searching] Done searching.`);
    // Filter out nulls and preserve order
    return results.filter((r): r is string => r !== null);
  }

  async search(item: FinancialSearchItem): Promise<string | null> {
    const inputData = `Search term: ${item.query}\nReason: ${item.reason}`;
    console.log(`[searching] Input data:`, inputData);
    try {
      const result = await run(searchAgent, inputData);
      return String(result.finalOutput);
    } catch {
      return null;
    }
  }

  async writeReport(
    query: string,
    searchResults: string[],
  ): Promise<FinancialReportData> {
    // Expose the specialist analysts as tools
    const fundamentalsTool = financialsAgent.asTool({
      toolName: 'fundamentals_analysis',
      toolDescription: 'Use to get a short write-up of key financial metrics',
      customOutputExtractor: summaryExtractor,
    });
    const riskTool = riskAgent.asTool({
      toolName: 'risk_analysis',
      toolDescription: 'Use to get a short write-up of potential red flags',
      customOutputExtractor: summaryExtractor,
    });
    const writerWithTools = writerAgent.clone({
      tools: [fundamentalsTool, riskTool],
    });
    console.log(`[writing] Thinking about report...`);
    const inputData = `Original query: ${query}\nSummarized search results: ${searchResults}`;
    const result = await run(writerWithTools, inputData);
    console.log(`[writing] Done writing report.`);
    return result.finalOutput!;
  }

  async verifyReport(report: FinancialReportData): Promise<VerificationResult> {
    console.log(`[verifying] Verifying report...`);
    const result = await run(verifierAgent, report.markdown_report);
    console.log(`[verifying] Done verifying report.`);
    return result.finalOutput!;
  }
}

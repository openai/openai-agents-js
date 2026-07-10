import { Agent, webSearchTool } from '@openai/agents';
import { z } from 'zod';

// --- Fundamentals Analyst Agent ---
export const financialsPrompt = `You are a financial analyst focused on company fundamentals such as revenue, profit, margins and growth trajectory.
Given a collection of web (and optional file) search results about a company, write a concise analysis of its recent financial performance.
Pull out key metrics or quotes. Keep it under 2 paragraphs.`;

export const AnalysisSummary = z.object({
  summary: z
    .string()
    .describe('Short text summary for this aspect of the analysis.'),
});

export const financialsAgent = new Agent({
  name: 'FundamentalsAnalystAgent',
  instructions: financialsPrompt,
  outputType: AnalysisSummary,
});

// --- Financial Research Planner Agent ---
export const plannerPrompt = `You are a financial research planner.
Given a request for financial analysis, produce a set of web searches to gather the context needed.
Aim for recent headlines, earnings calls or 10-K snippets, analyst commentary, and industry background.
Prioritize official investor-relations releases and SEC filings for reported results.
Output between 5 and 15 search terms to query for.`;

export const FinancialSearchItem = z.object({
  reason: z
    .string()
    .describe('Your reasoning for why this search is relevant.'),
  query: z
    .string()
    .describe('The search term to feed into a web (or file) search.'),
});

export type FinancialSearchItem = z.infer<typeof FinancialSearchItem>;

export const FinancialSearchPlan = z.object({
  searches: z
    .array(FinancialSearchItem)
    .describe('A list of searches to perform.'),
});

export type FinancialSearchPlan = z.infer<typeof FinancialSearchPlan>;

export const plannerAgent = new Agent({
  name: 'FinancialPlannerAgent',
  instructions: plannerPrompt,
  model: 'gpt-5.4',
  outputType: FinancialSearchPlan,
});

// --- Risk Analyst Agent ---
export const riskPrompt = `You are a risk analyst looking for potential red flags in a company's outlook.
Given background research, produce a short analysis of risks such as competitive threats, regulatory issues, supply chain problems, or slowing growth.
Keep it under 2 paragraphs.`;

export const riskAgent = new Agent({
  name: 'RiskAnalystAgent',
  instructions: riskPrompt,
  outputType: AnalysisSummary,
});

// --- Financial Search Agent ---
export const searchAgentPrompt = `You are a research assistant specializing in financial topics.
Given a search term, use web search to retrieve up-to-date context and produce a short summary of at most 300 words.
Focus on key numbers, events, or quotes that will be useful to a financial analyst.
Prefer primary sources and include source names and URLs for the facts you summarize. Never fabricate a URL.`;

export const searchAgent = new Agent({
  name: 'FinancialSearchAgent',
  instructions: searchAgentPrompt,
  model: 'gpt-5.4',
  tools: [webSearchTool()],
});

// --- Verification Agent ---
export const verifierPrompt = `You are a meticulous auditor. You will receive a financial analysis report and the source summaries used to write it.
Verify the report against those source summaries rather than relying on prior knowledge.
Do not reject newer information merely because it is unfamiliar, but reject claims that are unsupported, internally inconsistent, or missing clear sourcing.
When the report is verified, return an empty issues string. Otherwise, point out the specific issues or uncertainties.`;

export const VerificationResult = z.object({
  verified: z
    .boolean()
    .describe('Whether the report seems coherent and plausible.'),
  issues: z
    .string()
    .describe('If not verified, describe the main issues or concerns.'),
});

export type VerificationResult = z.infer<typeof VerificationResult>;

export const verifierAgent = new Agent({
  name: 'VerificationAgent',
  instructions: verifierPrompt,
  model: 'gpt-5.4',
  outputType: VerificationResult,
});

// --- Financial Writer Agent ---
export const writerPrompt = `You are a senior financial analyst.
You will be provided with the original query and a set of raw search summaries.
Your task is to synthesize these into a long-form markdown report (at least several paragraphs) including a short executive summary and follow-up questions.
Use only facts supported by the supplied summaries, preserve their source URLs as inline Markdown citations, and clearly label uncertainty or conflicting information.
If needed, you can call the available analysis tools (e.g. fundamentals_analysis, risk_analysis) to get short specialist write-ups to incorporate.`;

export const FinancialReportData = z.object({
  short_summary: z.string().describe('A short 2-3 sentence executive summary.'),
  markdown_report: z.string().describe('The full markdown report.'),
  follow_up_questions: z
    .array(z.string())
    .describe('Suggested follow-up questions for further research.'),
});

export type FinancialReportData = z.infer<typeof FinancialReportData>;

export const writerAgent = new Agent({
  name: 'FinancialWriterAgent',
  instructions: writerPrompt,
  model: 'gpt-5.4',
  outputType: FinancialReportData,
});

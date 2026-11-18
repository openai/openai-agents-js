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
export const MAX_SEARCHES = 15;

export const plannerPrompt = `You are a financial research planner.
Given a request for financial analysis, produce a set of web searches to gather the context needed.
Aim for recent headlines, earnings calls or 10-K snippets, analyst commentary, and industry background.
Prioritize official investor-relations releases and SEC filings for reported results.
Output between 5 and ${MAX_SEARCHES} search terms to query for.`;

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
  modelSettings: {
    toolChoice: 'required',
    providerData: { include: ['web_search_call.action.sources'] },
  },
});

// --- Verification Agent ---
export const verifierPrompt = `You are a meticulous auditor. You will receive a financial analysis report and the source summaries used to write it.
Verify every report field, including the short_summary, against those source summaries rather than relying on prior knowledge.
The host provides a compact authoritative allowlist of exact URLs returned by the service or completed primary-document reads for this report. Use that allowlist to check citation membership, rather than inferring membership from a partial research summary. Each material factual claim must cite one of those URLs. A URL appearing only in generated prose is not evidence of retrieval. Check that the cited summary actually supports the claim and fiscal period; source-list membership alone does not prove a claim.
Set verified to false only when a material claim remains unsupported, internally inconsistent, misleadingly sourced, or unqualified despite conflicting sources.
Treat omitted optional context, accurately attributed single-source claims, and uncertainty that the report explicitly labels and handles conservatively as non-blocking.
Do not reject newer information merely because it is unfamiliar.
When no blocking issue remains, set verified to true and return an empty issues string. Otherwise, list only the specific blocking issues that the writer must resolve.`;

export const VerificationResult = z.object({
  verified: z
    .boolean()
    .describe('Whether the report has no blocking source-grounding issues.'),
  issues: z
    .string()
    .describe('If not verified, describe only the blocking issues to resolve.'),
});

export type VerificationResult = z.infer<typeof VerificationResult>;

export const verifierAgent = new Agent({
  name: 'VerificationAgent',
  instructions: verifierPrompt,
  model: 'gpt-5.4',
  outputType: VerificationResult,
});

export const PrimarySourceAudit = VerificationResult.extend({
  checks: z.array(
    z.object({
      claim: z.string(),
      source_url: z.string(),
      supporting_extract: z.string(),
      supported: z.boolean(),
      explanation: z.string(),
    }),
  ),
});

export type PrimaryAuditCheck = z.infer<
  typeof PrimarySourceAudit
>['checks'][number];

export const primarySourceAuditAgent = new Agent({
  name: 'PrimarySourceAuditAgent',
  model: 'gpt-5.4',
  instructions: `Independently audit every material numeric claim in the complete report against original primary sources.
Do not trust the report or generated research summaries. Use hosted web search, then explicitly OPEN and READ the issuer earnings release, financial-statement PDF, or regulatory filing. Search snippets, aggregator summaries, and remembered figures are insufficient.
Check the exact fiscal period, currency, scale, segment, and GAAP/non-GAAP basis. Read the relevant table, not a nearby quarter or fiscal year. For each material numeric claim return a check with the exact URL you opened, a short supporting extract, supported, and an explanation of period and units. Prefer self-contained issuer earnings-release prose for revenue, EPS and other headline findings when available. Copy complete narrative sentences with metric and period context rather than bare table rows with multiple unlabeled figures; the extracts may become the final scoped report. Open the report-cited primary URLs first; only search for additional primary documents when needed. If a figure disagrees, quote the actual source value in the explanation and reject the report. Reject incomplete coverage or unavailable primary evidence. Do not accept a claim merely because another generated summary agrees.
Set verified true only after all material numeric claims have supporting primary evidence; return an empty issues string only then. Include at least one check for the financial report.`,
  tools: [webSearchTool()],
  modelSettings: {
    toolChoice: 'required',
    providerData: {
      include: ['web_search_call.action.sources'],
      max_tool_calls: 8,
    },
  },
  outputType: PrimarySourceAudit,
});

// --- Financial Writer Agent ---
export const writerPrompt = `You are a senior financial analyst.
You will be provided with the original query and a set of raw search summaries.
Your task is to synthesize these into a long-form markdown report (at least several paragraphs) including a short executive summary and follow-up questions.
Use only facts supported by the supplied summaries, cite only URLs in their service-returned source lists, and clearly label uncertainty or conflicting information. Cite claims in both short_summary and markdown_report using the exact supplied source references, for example [source:S1]. The host replaces each known reference with an inline Markdown citation to its original retrieved URL before verification. Do not copy, invent, or repair URLs or source IDs. If evidence is sparse, write a shorter report explaining the gaps rather than filling them from memory.
Omit optional timeline, guidance, or claims about missing evidence unless the supplied evidence directly supports them. Do not infer that guidance is absent or sources disagree merely because summaries omit details.
When source summaries conflict on a fact, do not choose a version based on how often it appears. Omit the disputed fact from the executive summary and bottom-line conclusions unless a supplied source directly reconciles the conflict.
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

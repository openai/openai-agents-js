# Financial Research Agent

This example demonstrates a multi-agent workflow that produces a short financial analysis report.

The entrypoint in `main.ts` prompts for a query, then traces the run and hands control to `FinancialResearchManager`.

The manager orchestrates several specialized agents:

1. **Planner** – creates a list of search tasks for the query.
2. **Search** – runs each search in parallel and gathers summaries.
3. **Writer** – synthesizes the search results, optionally calling fundamentals and risk analyst tools.
4. **Verifier** – checks the final report for consistency and issues.

After running these steps the manager prints a short summary, the full markdown report, suggested follow-up questions, and verification results. If no search produces a usable summary, or if blocking source-grounding issues remain after two revisions, it exits with an error instead of presenting an ungrounded or unverified report as successful output.

Run the example with:

```bash
pnpm examples:financial-research-agent
```

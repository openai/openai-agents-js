# Write a financial report with source checks

Ask a financial question to see how an agent plans searches, consults specialists, and checks the resulting report. Both modes require an `OPENAI_API_KEY` with access to Responses API web search. Both incur model and search charges.

From the repository root, run the same question with either provider:

```bash
# Default provider
pnpm --filter financial-research-agent start "Summarize Apple's latest earnings."

# Stock Codex for planning, analysis, writing, and draft verification
pnpm --filter financial-research-agent start --codex "Summarize Apple's latest earnings."
```

Omit the question to type it at a prompt. For Codex mode, install the workspace dependencies and configure Codex authentication. Use `CODEX_MODEL` to choose the model for the Codex stages.

## Why both modes use the same search

A URL in a model's reply doesn't prove that a search took place. The example runs its search agent on the Responses API in both modes to get the URLs from the search itself. Stock Codex doesn't return the same source metadata.

The writer cites sources by ID, such as `[source:S1]`. The example replaces each known ID with the URL returned by search, so the writer doesn't have to copy it.

The verifier checks the executive summary, report, and follow-up questions against the collected evidence. A second check goes back to primary documents using hosted web search. That check matters when, for example, a search summary gives the wrong year's revenue. Both modes pay for these search calls.

The writer can revise a rejected draft twice. If no search yields usable sources, or if the verifier still rejects the draft, the example exits with an error instead of printing the report. A pass means the report cleared these checks against the retrieved evidence; the verifier can still make mistakes.

The `start` script runs TypeScript directly with Node.js. Use Node 22.18 or later in the 22.x line, Node 24.x, or Node 26 or later.

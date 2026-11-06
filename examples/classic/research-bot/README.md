# Research Bot

This example shows how to orchestrate several agents to produce a detailed research report.

## Files

- **main.ts** – CLI entrypoint that asks for a query and runs the workflow using `ResearchManager`.
- **manager.ts** – Coordinates the planning, web searching and report writing stages.
- **agents.ts** – Contains the agents: a planner that suggests search terms, a search agent that summarizes results and a writer that generates the final report.

## Usage

From the repository root run:

```bash
pnpm examples:research-bot
```

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The following commands execute TypeScript directly with Node.js: `start`.

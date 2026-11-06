# Agent Handoffs

`index.ts` sets up two English-speaking assistants and a Spanish-speaking assistant. The second assistant hands a Spanish request to the Spanish-speaking assistant.

The receiving agent gets the full history when `isGpt5Default()` identifies a GPT-5 reasoning model. For other defaults, the filter removes tool-related messages. Build the workspace packages with `pnpm build`, set `OPENAI_API_KEY`, and run the example from the repository root.

```bash
pnpm -F handoffs start
```

`types.ts` demonstrates typed outputs. A triage agent inspects the message and hands off to either `firstAgent` or `secondAgent`, each with their own Zod schema for structured output. The script logs which agent produced the final result.

```bash
pnpm -F handoffs start:types
```

`is-enabled.ts` demonstrates gating handoffs with feature-like preferences. Run it with:

```bash
pnpm -F handoffs start:is-enabled
```

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The following commands execute TypeScript directly with Node.js: `start`, `start:types`, `start:is-enabled`.

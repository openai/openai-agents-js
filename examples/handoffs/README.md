# Agent Handoffs

This example shows how one agent can transfer control to another. The `index.ts` script sets up two English speaking assistants and a Spanish assistant. The second agent is configured with a handoff so that if the user requests Spanish replies it hands off to the Spanish agent. A message filter strips out tool messages and the first two history items before the handoff occurs. Run it with:

```bash
pnpm -F handoffs start
```

`types.ts` demonstrates typed outputs. A triage agent inspects the message and hands off to either `firstAgent` or `secondAgent`, each with their own Zod schema for structured output. The script logs which agent produced the final result.

`is-enabled.ts` demonstrates gating handoffs with feature-like preferences. Run it with:

```bash
pnpm -F handoffs start:is-enabled
```

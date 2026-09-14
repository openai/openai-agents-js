# Customer Service Agent

This example demonstrates a multi-agent customer service workflow for an airline. The `index.ts` script sets up a triage agent that can delegate to specialized FAQ and seat booking agents. Tools are used to look up common questions and to update a passenger's seat. Interaction occurs through a simple CLI loop, showing how agents can hand off between each other and call tools.

Run the demo with:

```bash
pnpm examples:customer-service
```

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The following commands execute TypeScript directly with Node.js: `start`.

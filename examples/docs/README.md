# Documentation Snippets

This directory contains small scripts used throughout the documentation. The `docs-code` workspace does not define per-snippet `start:*` scripts, so run snippets directly from the repository root with `pnpm exec tsx <path-to-file>`.

- [`agents/agentWithTools.ts`](./agents/agentWithTools.ts) – Configure a weather agent with a tool and model.
  ```bash
  pnpm exec tsx examples/docs/agents/agentWithTools.ts
  ```
- [`agents/agentCloning.ts`](./agents/agentCloning.ts) – Clone an agent and reuse its configuration.
  ```bash
  pnpm exec tsx examples/docs/agents/agentCloning.ts
  ```
- [`agents/agentWithContext.ts`](./agents/agentWithContext.ts) – Access user context from tools during execution.
  ```bash
  pnpm exec tsx examples/docs/agents/agentWithContext.ts
  ```
- [`agents/agentWithDynamicInstructions.ts`](./agents/agentWithDynamicInstructions.ts) – Build instructions dynamically from context.
  ```bash
  pnpm exec tsx examples/docs/agents/agentWithDynamicInstructions.ts
  ```
- [`agents/agentForcingToolUse.ts`](./agents/agentForcingToolUse.ts) – Require specific tools before producing output.
  ```bash
  pnpm exec tsx examples/docs/agents/agentForcingToolUse.ts
  ```
- [`agents/agentWithHandoffs.ts`](./agents/agentWithHandoffs.ts) – Route requests to specialized agents using handoffs.
  ```bash
  pnpm exec tsx examples/docs/agents/agentWithHandoffs.ts
  ```
- [`agents/agentWithLifecycleHooks.ts`](./agents/agentWithLifecycleHooks.ts) – Log agent lifecycle events as they run.
  ```bash
  pnpm exec tsx examples/docs/agents/agentWithLifecycleHooks.ts
  ```
- [`agents/agentWithAodOutputType.ts`](./agents/agentWithAodOutputType.ts) – Return structured data using a Zod schema.
  ```bash
  pnpm exec tsx examples/docs/agents/agentWithAodOutputType.ts
  ```
- [`guardrails/guardrails-input.ts`](./guardrails/guardrails-input.ts) – Block unwanted requests using input guardrails.
  ```bash
  pnpm exec tsx examples/docs/guardrails/guardrails-input.ts
  ```
- [`guardrails/guardrails-output.ts`](./guardrails/guardrails-output.ts) – Check responses with output guardrails.
  ```bash
  pnpm exec tsx examples/docs/guardrails/guardrails-output.ts
  ```
- [`models/customProviders.ts`](./models/customProviders.ts) – Create and use a custom model provider.
  ```bash
  pnpm exec tsx examples/docs/models/customProviders.ts
  ```
- [`models/openaiProvider.ts`](./models/openaiProvider.ts) – Run agents with the OpenAI provider.
  ```bash
  pnpm exec tsx examples/docs/models/openaiProvider.ts
  ```
- [`quickstart/index.ts`](./quickstart/index.ts) – Simple triage agent that hands off questions to tutors.
  ```bash
  pnpm exec tsx examples/docs/quickstart/index.ts
  ```
- [`readme/readme-functions.ts`](./readme/readme-functions.ts) – README example showing how to call functions as tools.
  ```bash
  pnpm exec tsx examples/docs/readme/readme-functions.ts
  ```
- [`readme/readme-handoffs.ts`](./readme/readme-handoffs.ts) – README example that demonstrates handoffs.
  ```bash
  pnpm exec tsx examples/docs/readme/readme-handoffs.ts
  ```
- [`readme/readme-hello-world.ts`](./readme/readme-hello-world.ts) – The hello world snippet from the README.
  ```bash
  pnpm exec tsx examples/docs/readme/readme-hello-world.ts
  ```
- [`readme/readme-voice-agent.ts`](./readme/readme-voice-agent.ts) – Browser-based realtime voice agent example.
  ```bash
  pnpm exec tsx examples/docs/readme/readme-voice-agent.ts
  ```
- [`running-agents/exceptions1.ts`](./running-agents/exceptions1.ts) – Retry after a guardrail execution error.
  ```bash
  pnpm exec tsx examples/docs/running-agents/exceptions1.ts
  ```
- [`running-agents/exceptions2.ts`](./running-agents/exceptions2.ts) – Retry after a failed tool call.
  ```bash
  pnpm exec tsx examples/docs/running-agents/exceptions2.ts
  ```

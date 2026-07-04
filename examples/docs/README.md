# Documentation Snippets

This directory contains small scripts used throughout the documentation. Type-check all snippets with:

```bash
pnpm -F docs-code build-check
```

- `agents-basic-configuration.ts` – Configure a weather agent with a tool and model.
- `agents-cloning.ts` – Clone an agent and reuse its configuration.
- `agents-context.ts` – Access user context from tools during execution.
- `agents-dynamic-instructions.ts` – Build instructions dynamically from context.
- `agents-forcing-tool-use.ts` – Require specific tools before producing output.
- `agents-handoffs.ts` – Route requests to specialized agents using handoffs.
- `agents-lifecycle-hooks.ts` – Log agent lifecycle events as they run.
- `agents-output-types.ts` – Return structured data using a Zod schema.
- `guardrails-input.ts` – Block unwanted requests using input guardrails.
- `guardrails-output.ts` – Check responses with output guardrails.
- `models-custom-providers.ts` – Create and use a custom model provider.
- `models-openai-provider.ts` – Run agents with the OpenAI provider.
- `quickstart.ts` – Simple triage agent that hands off questions to tutors.
- `readme-functions.ts` – README example showing how to call functions as tools.
- `readme-handoffs.ts` – README example that demonstrates handoffs.
- `readme-hello-world.ts` – The hello world snippet from the README.
- `readme-voice-agent.ts` – Browser-based realtime voice agent example.
- `running-agents-exceptions1.ts` – Retry after a guardrail execution error.
- `running-agents-exceptions2.ts` – Retry after a failed tool call.

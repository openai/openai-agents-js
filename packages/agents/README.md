# OpenAI Agents SDK for TypeScript

`@openai/agents` provides the public SDK entry points. Its native Agent and Session APIs run through the embedded Codex runtime owned by `@openai/agents-codex`.

Applications continue to import from `@openai/agents` and its supported subpaths, including `@openai/agents/testing` and `@openai/agents/experimental/*`. The public package forwards those native imports to `@openai/agents-codex`.

- [Native SDK overview](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents-codex/README.md). Install the SDK and run your first Agent.
- [Native API guide](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents-codex/NATIVE.md). Find sessions, tools, output, and native interactions.
- [Examples](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/README.md). Run native workflows.
- [Migration guide](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/guides/migration.md). Prefer a direct move from v0 to native v1. Use classic only when the port must be staged.
- [Scripted native tests](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents-codex/TESTING.md). Exercise application behavior without model credentials.
- [Classic API](CLASSIC.md). Use the classic Agent, Runner, Realtime, and sandbox APIs through the `@openai/agents/classic` subpaths.

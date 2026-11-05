# OpenAI Agents SDK for TypeScript

`@openai/agents` provides the public SDK entry points. Its native Agent and Session APIs run through the embedded Codex runtime owned by `@openai/agents-codex`.

Applications continue to import from `@openai/agents` and its supported subpaths, including `@openai/agents/testing`, `@openai/agents/migration`, and `@openai/agents/experimental/*`. The public package forwards those imports to `@openai/agents-codex`.

- [Native SDK overview](../agents-codex/README.md). Install the SDK and run your first Agent.
- [Native API guide](../agents-codex/NATIVE.md). Find sessions, tools, output, and native interactions.
- [Examples](../agents-codex/examples/README.md). Run native and migration workflows.
- [Scripted native tests](../agents-codex/TESTING.md). Exercise application behavior without model credentials.
- [Classic API](CLASSIC.md). Use the classic Agent, Runner, Realtime, and sandbox APIs through the `@openai/agents/classic` subpaths.

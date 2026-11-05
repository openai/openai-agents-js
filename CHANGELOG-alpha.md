# Alpha changelog

Release notes for alpha versions of the OpenAI Agents SDK for JavaScript and TypeScript.

## 0.22.0-alpha.1

[GitHub prerelease and prebuilt bundles](https://github.com/openai/openai-agents-js/releases/tag/v0.22.0-alpha.1)

This alpha introduces the embedded Codex harness through `@openai/agents`. Use the examples and package guides from the same release as your installed SDK.

### Added

- Run agents with `Agent.run()` or open an `Agent.session()` for a conversation. The Codex harness manages model turns, tool execution, history, and compaction.
- Define TypeScript function tools with schema validation, application context, and typed output. Connect native MCP tools and manage remote executors through an `Environment`.
- Observe text and tool events, steer active work, queue independent submissions, and cancel a captured `Turn` with cleanup.
- Save and restore supported portable `SessionState` checkpoints, fork idle sessions, and compact conversation context. Use `LocalStorage` for local profiles with separate persistence rules.
- Handle manual tool requests and apply tool approval and result policies. Inspect live session capabilities before selecting features or saving a checkpoint.
- Test native sessions against local scripted responses through `@openai/agents/testing`, without a live model or API key.

### API changes

- Import the Codex harness API from `@openai/agents`. Use `@openai/agents/classic` for the classic Agent and Runner APIs, and `/classic/realtime` for the retained Realtime API.
- Keep classic and native session state separate. Converting an active classic `RunState` into native `SessionState` is unsupported.
- Use the experimental `@openai/agents/migration` adapter for supported classic declarations that run through the native engine. The [classic guide](packages/agents/CLASSIC.md) describes its supported features and limits.

### Documentation and examples

- Start from one platform bundle with the compiled native runtime, matching SDK packages, a lockfile, and `hello.mjs`. See [installation](packages/agents-codex/examples/guides/installation.md) for release availability and setup.
- Add the same matched package set to an existing application with local file dependencies and npm overrides.
- Follow the [native API guide](packages/agents-codex/NATIVE.md), [testing guide](packages/agents-codex/TESTING.md), and [examples](packages/agents-codex/examples/README.md) for supported workflows.

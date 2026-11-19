# Run the examples with either provider

The examples use the same Agents SDK `Runner` with the default OpenAI provider or the experimental `CodexProvider`. Start with [Codex provider setup, supported features, and limitations](../../docs/src/content/docs/guides/models.mdx#experimental-codex-provider).

These examples target the `feat/simple-codex` branch. From a clean repository checkout, switch to that branch, install dependencies, and build the workspace:

```sh
git switch feat/simple-codex
pnpm install
pnpm build
```

Use the Node.js and pnpm versions in [CONTRIBUTING.md](../../CONTRIBUTING.md#getting-started). Codex mode needs the stock 0.166.0 CLI, a writable `CODEX_HOME`, and a saved Codex login or an explicitly configured API key. Use the same `CODEX_HOME` when signing in and running the examples. The SDK package does not install a shell command. To sign in without installing a global CLI, run:

```sh
npx @openai/codex@0.166.0 login
```

For API-key login and other setup options, see the provider guide linked above. The default provider needs `OPENAI_API_KEY`. Both examples disable SDK tracing so Codex mode can use a saved CLI login without credentials for the OpenAI trace exporter.

## Create and read a file

```sh
pnpm -F tools exec tsx codex-provider.ts openai
pnpm -F tools exec tsx codex-provider.ts codex
```

Both commands create a temporary workspace, write `hello.txt`, and read its contents back. OpenAI mode uses two SDK function tools with access only to that file. Codex mode uses its native shell with `workspace-write`, `skipGitRepoCheck: true`, and `approvalPolicy: 'never'`. A successful run checks the actual file on disk and prints:

```text
Verified hello.txt: Hello from Codex
```

`OPENAI_MODEL` and `CODEX_MODEL` select a model for the corresponding mode. Without `CODEX_MODEL`, Codex uses its configured default. The example removes the workspace on success or failure and exits with a nonzero status when a check fails.

## Combine images, tools, handoffs, and streaming

```sh
pnpm -F tools exec tsx codex-provider-capabilities.ts openai
pnpm -F tools exec tsx codex-provider-capabilities.ts codex
```

The image-triage agent hands off to a wildlife specialist. The specialist inspects the bundled bison image, calls `lookup_animal_record`, and returns a report that matches a Zod schema. Both modes use the same SDK tool and handoff. The catalog record is synthetic.

The example streams text deltas and checks the handoff callback, tool callback, final specialist, and structured answer. The report contains `animal: "bison"`, `recordId: "synthetic-bison-001"`, and a description of visible features. Codex uses a read-only workspace. Delta counts vary by provider and model.

## Use a local alternative to a hosted feature

These commands select alternatives explicitly; they do not emulate hosted service IDs or event formats.

| Task | Example |
| --- | --- |
| Continue a conversation without a hosted response ID | [Local sessions](../basic/README.md#running-locally-with-codex) |
| Supply image bytes or extract PDF text in the app | [Media inputs](../basic/README.md#running-locally-with-codex) |
| Run a local computation | [Local code execution](./local-code-execution.md) |
| Connect the SDK to Calendar MCP | [Calendar setup](../connectors/README.md) |
| Read a prompt template owned by the application | [`prompt-id.ts --local --codex`](../basic/prompt-id.ts) |
| Query a self-hosted Responses-compatible model | [`hello-world-gpt-oss.ts --codex`](../basic/hello-world-gpt-oss.ts) |

For a custom backend, Codex needs a streaming Responses API. A Chat Completions endpoint alone is insufficient. Configure the server in `$CODEX_HOME/config.toml`, then set the agent's model name to one it serves:

```toml
model_provider = "local"

[model_providers.local]
name = "Local Responses server"
base_url = "http://127.0.0.1:8000/v1"
wire_api = "responses"
supports_websockets = false
```

A provider switch applies to model names. An explicitly constructed model object continues to use its own client.

## Diagnose a missing `hello.txt` on Linux

If the file check fails with `ENOENT`, first test native shell startup without a model call:

```sh
npx @openai/codex@0.166.0 sandbox -c 'sandbox_mode="workspace-write"' -- /bin/sh -c 'echo sandbox-ready'
```

- If the command prints `sandbox-ready`, inspect the model run's command output to see whether it wrote the file.
- If it reports `app-server socket directory must be a user-owned directory with mode 0700`, Codex stopped before starting the shell. An outer sandbox can mask `/tmp/codex-daemon-<uid>` with a read-only directory. Changing `CODEX_HOME` does not change that mount.

For the socket error, use a host where the shell check succeeds. Keep `workspace-write` enabled. The file example does not use an MCP workaround.

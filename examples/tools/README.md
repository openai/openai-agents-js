# Tool Integrations

These examples demonstrate the hosted tools provided by the Agents SDK.

## Examples

- `computer-use.ts` – Uses the computer tool with Playwright to automate a local browser.

  ```bash
  pnpm examples:tools-computer-use
  ```

- `file-search.ts` – Shows how to run a vector search with `fileSearchTool`.

  ```bash
  pnpm examples:tools-file-search
  ```

- `codex-tool.ts` – Wraps the Codex SDK as an agent tool and prints structured tracing output. Requires `OPENAI_API_KEY` and `CODEX_API_KEY` environment variables.

  ```bash
  pnpm examples:tools-codex
  ```

- `web-search.ts` – Demonstrates `webSearchTool` for general web queries.

  ```bash
  pnpm examples:tools-web-search
  ```

- `code-interpreter.ts` – Demonstrates `codeInterpreterTool` for code execution.

  ```bash
  pnpm examples:tools-code-interpreter
  ```

- `image-generation.ts` – Demonstrates `imageGenerationTool` for image generation.

  ```bash
  pnpm examples:tools-image-generation
  ```

# Standard Schema example

The weather agent uses a Valibot schema for its weather tool and structured report, and a Zod schema for its timezone tool. Zod 4.2 and later support Standard Schema JSON conversion directly. The example adapts Valibot with `toStandardJsonSchema()` from `@valibot/to-json-schema`.

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The example commands use native Node.js TypeScript execution.

## Run the weather agent

Set `OPENAI_API_KEY` in your environment. From the repository root, build the SDK and ask the agent for the weather in Tokyo.

```sh
pnpm build
pnpm -F standard-schema start
```

The example calls the model and prints a validated report with `city`, `temperature`, and `unit`. The weather tool returns a fixed reading of 22 °C or 71.6 °F. The time zone sample covers Tokyo.

## Check the schemas locally

From the same checkout, check TypeScript inference, schema conversion, and validation. These commands run without an API key.

```sh
pnpm -F standard-schema build-check
pnpm -F standard-schema test:smoke
```

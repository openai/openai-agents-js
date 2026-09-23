# Standard Schema example

This example uses Standard Schema as the common boundary for Zod and Valibot schemas. Zod 4.2 and later implement Standard Schema JSON conversion directly. Valibot schemas use `toStandardJsonSchema()` from `@valibot/to-json-schema`.

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The example commands use native Node.js TypeScript execution.

From the repository root, build the SDK and run the example:

    pnpm build
    pnpm -F standard-schema start

The example makes an OpenAI API request. To exercise only local schema conversion, validation, and type inference, run:

    pnpm -F standard-schema build-check
    pnpm -F standard-schema test:smoke

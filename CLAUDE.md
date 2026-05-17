# OpenAI Agents JS — Claude Code Guide

## Project overview

pnpm monorepo for the OpenAI Agents SDK (JavaScript/TypeScript). Packages live under `packages/`, examples under `examples/`.

Key packages:

- `packages/agents-core` — core abstractions and runtime
- `packages/agents-openai` — OpenAI SDK bindings
- `packages/agents` — convenience re-export bundle
- `packages/agents-realtime` — realtime/voice agent support
- `packages/agents-extensions` — additional workflow extensions

## Setup

```bash
pnpm install   # install all workspace dependencies
pnpm build     # compile TypeScript for all packages
```

## Common commands

| Task | Command |
| --- | --- |
| Run tests | `pnpm test` |
| Run single test file | `pnpm vitest run packages/agents-core/test/agent.test.ts` |
| Lint | `pnpm lint` |
| Lint fix | `pnpm lint:fix` |
| Format | `pnpm format` |
| Build | `pnpm build` |
| Build (CI) | `pnpm build:ci` |
| Type-check examples | `pnpm test:examples` |

## Testing

Tests use Vitest and live alongside source files in `packages/*/test/`.

```bash
CI=1 pnpm test                    # full suite
pnpm vitest run <path/to/test>    # single file
```

## Code style

- TypeScript throughout
- ESLint (`pnpm lint`) + Prettier (`pnpm format`) for style
- No new comments unless the WHY is non-obvious

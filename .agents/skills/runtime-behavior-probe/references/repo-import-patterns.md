# Repository Import Patterns

Use this reference when a temporary probe script outside the repository needs to load code from the current branch.

## Why This Exists

When you run `pnpm exec tsx /tmp/probe.ts` from the repository root, `tsx` itself comes from this repository, but the probe file still lives under `/tmp`. Bare workspace imports such as `@openai/agents-core` or `@openai/agents` therefore resolve as if the script were its own package. That is often not what you want for "what does the current branch do right now?" investigations.

The safe default is to build a `file://` import URL from `process.cwd()`, which should be the repository root, and a repository-relative path.

## Default Rule

- Use `src/` imports when the question is about current-branch behavior.
- Use `dist/` imports when the question is about packaged output after a build.
- Avoid bare workspace imports from `/tmp` unless the probe is explicitly testing published package resolution rather than branch-local source behavior.

## Quick Typecheck Loop

For disposable probes in `openai-agents-js`, the default loop should stay outside the repository and avoid a full workspace build:

1. Create a temporary directory with `mktemp -d`.
2. Write `probe.ts` there.
3. Write a sibling `tsconfig.json` that extends the repository's `tsconfig.examples.json`.
4. From the repository root, run `pnpm exec tsc --noEmit -p /tmp/.../tsconfig.json`.
5. If that passes, run `pnpm exec tsx /tmp/.../probe.ts`.

Example temporary `tsconfig.json`:

```json
{
  "extends": "/absolute/path/to/openai-agents-js/tsconfig.examples.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["./probe.ts"]
}
```

This keeps TypeScript module resolution and strictness close to the repository defaults while limiting the check surface to the disposable probe file.

Do not convert this default loop into a checked-in benchmark, example, or package script unless the user explicitly asks for a reusable repository artifact.

## Recommended Helper

The disposable TypeScript scaffold exposes:

    const module = await importRepoModule("packages/agents-core/src/index.ts");

Internally, the helper should be equivalent to:

    import { join } from "node:path";
    import { pathToFileURL } from "node:url";

    async function importRepoModule(repoRelativePath: string) {
      const absolutePath = join(process.cwd(), repoRelativePath);
      return import(pathToFileURL(absolutePath).href);
    }

This keeps the import anchored to the current checkout instead of the temporary script location.

## Choosing `src/` Versus `dist/`

Use `src/` when:

- You are validating a bug fix or regression on the current branch.
- You want to know how the repository behaves before packaging.
- The question is about implementation details or internal helper behavior.

Use `dist/` when:

- The question is specifically about what consumers load after `pnpm build`.
- You need to validate export maps or emitted `.mjs` and `.d.ts` output.
- The bug only reproduces in generated output.

If the probe uses `dist/`, record whether you ran a fresh build first. A stale `dist/` directory can create false positives or false negatives.

Do not run `pnpm build` only to typecheck or execute a `src/`-based disposable probe. The fast path is temp `tsconfig` plus `pnpm exec tsc --noEmit`, then `pnpm exec tsx`.

## Simple Smoke Targets

When you only need to prove the helper works, start with a simple target that has minimal side effects, for example:

- `packages/agents-core/src/index.ts`
- `packages/agents-openai/src/index.ts`
- another file with obvious exported symbols and no environment requirement

If a chosen file pulls in more of the repo than expected, switch to a simpler target rather than weakening the import guidance.

## What To Record

When a probe imports repo code, report:

- The repo-relative path you imported.
- Whether it came from `src/` or `dist/`.
- The repository root used by `process.cwd()`.
- Any prerequisite step such as `pnpm build`.

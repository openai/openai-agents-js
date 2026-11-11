# Build and preview the documentation

Astro Starlight builds the documentation site from the source in `src/content/docs/`.

## Preview a change

Complete the [contributor setup](../CONTRIBUTING.md), then start the preview from the repository root:

```bash
pnpm docs:dev
```

## Update a guide

Edit the authored English page. The translation workflow generates Japanese, Korean, and Chinese pages. See the [repository guidance](../AGENTS.md#repo-structure--important-files) for how to update docs and code snippets.

## Build the site

GitHub Actions builds and deploys the docs. To build them locally, run:

```bash
pnpm docs:build
```

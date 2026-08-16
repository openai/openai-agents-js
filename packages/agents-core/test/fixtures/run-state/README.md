# Historical RunState compatibility corpus

This directory is immutable compatibility evidence for released `RunState` writers. Ordinary tests only read these files. They never regenerate, normalize in place, or update snapshots.

`sources.json` accounts for every schema accepted by the production reader:

- `published_writer` means a released `@openai/agents-core` package actually emitted the schema and has checked-in writer output.
- `published_reader_only` means a released reader accepted the schema, but no published writer emitted it. Such a schema has an explicit policy entry and no fabricated historical fixture.
- `current_unreleased` means the schema exists on `main` but has not been published.

Each historical fixture records its package version, release tag, full source commit, npm integrity, scenario, path, and SHA-256 in `sources.json`. The published package and npm integrity identify the primary writer artifact; the tag and commit are supplementary source provenance. Minimal fixtures prove the writer format for every published schema. Feature and resume fixtures are intentionally limited to durable boundaries that need more than an empty state to exercise compatibility.

The released `1.17` sandbox format predates the mount-credential redaction boundary added by schema `1.18`. The `v0.16.0` writer fixtures establish the released `1.18` boundary, including canonical per-call approval identity. Schema `1.19` changes mixed sticky and exact approval decisions to resolve the exact call first. The prototype-key negative fixture uses the obvious non-secret sentinel `sentinel-not-a-secret`.

## Regeneration

Regeneration is an explicit maintainer action and does not make OpenAI API calls. Remove any ambient API credential and generate candidates outside the checked-in corpus:

```bash
env -u OPENAI_API_KEY pnpm tsx packages/agents-core/test/fixtures/run-state/generate-corpus.mts --all
```

Review candidates and provenance before promotion. Promotion is the only mode allowed to replace checked-in files:

```bash
env -u OPENAI_API_KEY pnpm tsx packages/agents-core/test/fixtures/run-state/generate-corpus.mts --all --promote
```

The generator verifies the local tag commit and registry metadata, downloads the exact published npm tarball, independently verifies its bytes against the recorded SRI, and runs the artifact's shipped entrypoint. It uses the exact source commit's checked-in lockfile and pinned pnpm version only to provide deterministic historical dependencies. All candidates are generated successfully before promotion begins. Fixture changes are durable compatibility-contract changes and should receive the same scrutiny as reader changes.

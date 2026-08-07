# Release Diff Review Checklist

Use the release-mode, Changesets, gate, documentation, and output policies in `../SKILL.md` as the normative rules. This checklist supplies operational discovery and evidence checks without redefining those policies.

## Contents

- [Establish the review inputs](#establish-the-review-inputs)
- [Resolve release type from Changesets](#resolve-release-type-from-changesets)
- [Audit runtime and package contracts](#audit-runtime-and-package-contracts)
- [Check high-signal change classes](#check-high-signal-change-classes)
- [Make every reported item actionable](#make-every-reported-item-actionable)
- [Audit documentation coverage](#audit-documentation-coverage)
- [Build the conditional Key Changes draft](#build-the-conditional-key-changes-draft)
- [Final evidence inventory](#final-evidence-inventory)

## Establish the review inputs

- Sync remote tags and resolve the latest matching release tag with `../scripts/find_latest_release_tag.sh origin 'v*'`.
- Refresh the requested target, defaulting to `origin/main`, peel annotated tags, and record the exact commit rather than a tag object.
- Resolve review mode before reading release type. Record the evidence for each decision separately.
- Generate `git diff --stat BASE...TARGET`, `git diff --dirstat=files,0 BASE...TARGET`, `git log --oneline --reverse BASE..TARGET`, and `git diff --name-status BASE...TARGET`.
- Inspect suspicious paths with `git diff --word-diff BASE...TARGET -- <path>`.
- Keep working-tree changes and open documentation PR diffs outside the release comparison.

## Resolve release type from Changesets

### Pre-release planning

1. List `.changeset/*.md` files that exist at TARGET, excluding `.changeset/README.md`.
2. Read the YAML frontmatter from TARGET, not from the working tree.
3. Record every package and bump declared by each active changeset.
4. Set the release-level type to the maximum valid bump across the release set: `minor` over `patch`.
5. Read `.changeset/config.json`. The core SDK packages are a fixed group, so a higher bump declared for one member can propagate to the group.

If TARGET changes packages but has no applicable changeset, or a changeset is malformed or names an unsupported bump, treat the release state as invalid rather than inferring a type from the code diff. If there are no releasable package changes, record `none`.

### Final candidate

1. Identify the Changesets-generated version commit from its package-version, changelog, and changeset-deletion diff. Do not trust the commit subject alone.
2. Read each deleted changeset from the version commit's first parent and record its package entries and bump.
3. Derive the release-level type from the consumed changesets with the same maximum-bump rule.
4. Compare the consumed set with generated `packages/*/package.json`, `packages/*/CHANGELOG.md`, and `packages/*/src/metadata.ts` changes.
5. Verify fixed-group propagation under `.changeset/config.json` and confirm every generated package version represents the declared release type.

When the original consumed frontmatter cannot be recovered, package version deltas and changelog entries may be used as a clearly labeled fallback because they are Changesets-generated outputs. Do not present that fallback as direct changeset evidence. A final candidate with no recoverable or generated Changesets evidence is invalid.

### Validation boundary

- `$changeset-validation` owns semantic judgment about whether a package diff deserves `patch`, `minor`, `major`, or `none`.
- `$final-release-review` consumes the validated declaration and checks release-wide consistency. It does not independently downgrade or upgrade valid changesets.
- If current changeset-validation evidence is unavailable, state the limitation. If CI reports a failure or the release diff proves a malformed, missing, stale, or inconsistent changeset, promote that concrete state to a release-preparation finding.
- Treat a `major` changeset as invalid under the current pre-1.0 policy unless repository policy and validation explicitly change.

Capture:

- review mode and its evidence;
- Changesets state: active, consumed, none, or invalid;
- source changeset paths or the generated version commit;
- authoritative release type: patch, minor, none, or invalid;
- candidate package version and consistency verdict when generated.

## Audit runtime and package contracts

### Stage 1: broad discovery

Scan the full diff for regressions, dependencies, package changes, persistence, error handling, concurrency, security, and release-polish signals. Read changed tests as behavioral evidence, including removed assertions, new skips, and uncovered failure paths.

### Stage 2: contract and invariant proof

For each candidate:

1. Compare the released BASE contract with TARGET.
2. Identify the owning boundary through `.agents/references/README.md`.
3. Trace the changed value, identity, state, or side effect through every required consumer.
4. Check only the relevant parity and failure axes.
5. Promote the candidate only when the trace proves concrete impact.

| Changed surface | BASE-versus-TARGET audit |
| --- | --- |
| Public API | Exports, import identity, TypeScript signatures, parameter order, defaults, enums, and documented behavior |
| Runner and run items | Provider output, result items, stream events, session history, replay, handoffs, and `RunState` |
| Tool execution | Planning, approvals, guardrails, invocation, hooks, output conversion, persistence, aborts, and cleanup |
| Conversation and sessions | First turn, follow-up, retry, filtering, handoff, compaction, interruption, and resume |
| Model and provider adapters | Settings resolution, request conversion, streaming terminals, provider data, errors, retries, and transport ownership |
| Persisted schemas and config | Serialized shape, supported versions, backward reads, usable migrations, defaults, environment variables, and wire compatibility |
| Package boundary | Node.js and TypeScript support, dependencies, peers, package exports, version metadata, published contents, and ESM/CJS/type behavior |

Relevant axes include streaming and non-streaming, fresh and resumed, client-managed and server-managed state, success and error and abort, sequential and concurrent execution, Node.js and browser and workerd, and normal and partial and repeated cleanup.

When static inspection is insufficient, run the smallest identical BASE and TARGET public-path or packed-artifact probe. Do not run broad unit slices merely to accumulate passing evidence.

## Check high-signal change classes

- Public API: removed or renamed exports, changed signatures or parameter order, default changes, new required values, or stricter validation.
- Protocol and config: request or response fields, enums, ID meaning, config flags, environment variables, or default behavior changes.
- Package and platform: Node.js or TypeScript support, dependency major changes, peers, exports, published contents, or import side effects.
- Persistence: durable schema, stored format, backward reads, migration capability, cache identity, or resume behavior.
- Runtime: concurrency, aborts, retries, timeouts, resource ownership, cleanup, swallowed errors, or changed exception types.
- Security: sensitive values in exceptions, logs, traces, telemetry, persisted state, or model-visible output.

Separate a released supported-path break with no usable migration, fallback, or compatibility path from a usable path that merely lacks documentation. Only the former is a compatibility blocker. The Changesets bump remains authoritative for release type after validation; this audit still determines whether the implementation itself is safe to ship.

## Make every reported item actionable

For every risk finding or verified release consideration, capture:

- `Evidence`: concrete BASE-versus-TARGET source, contract, artifact, test, or probe evidence.
- `Impact`: one user or runtime consequence.
- `Files`: the affected paths.
- `Action`: an exact task or validation plus its pass condition.

Changed tests, missing tests, large diffs, and risky patterns are discovery signals rather than findings. If no executable unblock action exists, do not manufacture one. For a safe **🟢 LOW** consideration, use a release-handoff action that preserves exact compatibility, migration, opt-out, default, or version-bound wording.

## Audit documentation coverage

### Build the obligation inventory

Derive one row per user-facing obligation:

`contract change | affected users | required migration/default/opt-out/version wording | expected docs surface`

Include breaking behavior, major features, public API additions, defaults, provider or dependency bounds, durable state, and changed workflows.

### Discover current open docs PRs

- Use approved read-only GitHub access; never use `gh` or mutate GitHub in this repository.
- Refresh current open PR state for each review. Historical local refs, cached task context, and prior reports are not evidence of current coverage.
- Search with the Changesets release type, likely version, feature names, implementation PR references, branch names, and changed docs paths.
- Inspect candidate file lists, the complete latest PR diff, and current review discussion when it materially affects a coverage claim. Titles and descriptions are discovery hints only.
- Record each relevant PR number or URL and exact head SHA. Review competing or complementary PRs together when necessary.
- Keep open docs PR diffs outside `BASE...TARGET`; report them as follow-up coverage rather than shipped content.
- If the search fails or is incomplete, record the failing source and scope. Do not convert an unavailable search into `none found`.

### Map evidence and follow-up work

For every obligation, record:

- the covering PR and exact file or section, if any;
- missing or incorrect qualifiers when coverage is partial or stale;
- an exact post-release file, section, example or claim, and migration wording whenever coverage is not demonstrably complete;
- whether a live-site docs PR should remain unmerged until the package is released.

If GitHub access is unavailable, make the follow-up suggestions provisional and state what still needs verification. Missing docs never enters the unblock checklist by itself.

## Build the conditional Key Changes draft

When `../SKILL.md` requires the minor-release draft:

- derive one to seven themes from verified user-visible contracts and changeset summaries rather than commits;
- use `## Key Changes`, then one `### <theme>` heading and a concise paragraph per theme;
- state breaking behavior explicitly and put migration or fallback guidance first;
- preserve exact identifiers, defaults, provider and model and dependency versions, opt-outs, and compatibility bounds;
- cover the major feature areas without reproducing the generated `## What's Changed` list;
- use only stable published documentation URLs and mention open docs PRs separately in Documentation coverage;
- keep the block copy-ready even if the release is blocked.

## Final evidence inventory

- BASE tag, TARGET commit, and confirmation that remote tags and target were refreshed.
- Review mode, Changesets state and sources, release type, and generated-version consistency verdict.
- High-level diff stats and key directories.
- Concrete findings and verified release considerations with Evidence, Impact, Files, and Action.
- Documentation-obligation inventory, current docs PR source and head SHA or search limitation, aggregate coverage, and exact post-release suggestions.
- Conditional copy-ready Key Changes draft for a Changesets-declared minor release.
- Explicit ship or block call and an unblock checklist only when blocked.

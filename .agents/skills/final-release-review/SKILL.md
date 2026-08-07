---
name: final-release-review
description: Perform pre-release planning or a final release-candidate review for openai-agents-js by comparing the target with the previous remote tag, deriving the release type from Changesets, auditing regressions and contract changes, reviewing open documentation PR coverage, drafting minor-release Key Changes, and calling the ship/block gate.
---

# Final Release Review

## Purpose

Audit `BASE_TAG...TARGET` in one of two modes:

- **Pre-release planning:** use when the user asks to plan the next release or reviews `origin/main` before the Changesets version PR exists. Derive the planned release type from the active changesets in TARGET. Do not treat unchanged package versions as a blocker.
- **Final candidate:** use when the user asks for a final candidate decision or TARGET contains a Changesets-generated version commit. Derive the candidate type from the consumed changesets, then verify the generated package versions and changelogs.

Treat Changesets as the source of truth for `patch` versus `minor`. Let `$changeset-validation` judge whether each changeset uses the correct bump for its package diff; do not independently replace a valid declared bump with a semantic-version judgment from this review. Independently audit runtime compatibility, regressions, packaging, and release risks. Keep documentation readiness separate from the release gate.

## Quick start

1. Ensure the repository root is `openai-agents-js`.
2. Sync remote tags and choose the previous release:
   ```bash
   BASE_TAG="$(.agents/skills/final-release-review/scripts/find_latest_release_tag.sh origin 'v*')"
   ```
3. Refresh and resolve the target, defaulting to `origin/main`:
   ```bash
   git fetch origin main --prune
   TARGET="$(git rev-parse origin/main)"
   ```
   Resolve an explicitly supplied tag or ref to its peeled commit with `git rev-parse "${TARGET_REF}^{commit}"`; use the commit SHA rather than an annotated tag object in the report and compare URL.
4. Resolve review mode independently from the release type:
   1. Honor an explicit user request for pre-release planning or final-candidate review.
   2. Otherwise, use final-candidate mode when TARGET contains a Changesets-generated version commit or package versions have been bumped beyond BASE.
   3. Otherwise, use pre-release planning mode.
5. Resolve the Changesets release state and type:
   1. In planning mode, inspect every active `.changeset/*.md` file at TARGET except `.changeset/README.md`.
   2. In final-candidate mode, identify the version commit and read each changeset it deleted from the commit's first parent. Also inspect generated `packages/*/package.json` and `packages/*/CHANGELOG.md` changes.
   3. Record every source changeset, package entry, and declared bump.
   4. Set the release-level type to the highest valid declared bump: `minor` over `patch`. Account for the fixed package group in `.changeset/config.json`; do not infer a lower type from an individual package version.
   5. Treat a `major` entry, malformed frontmatter, mixed active and consumed release sets, or package changes with no applicable changeset as an invalid release state. Do not coerce it to `patch` or `minor`.
6. Snapshot the release diff:
   ```bash
   git diff --stat "${BASE_TAG}"..."${TARGET}"
   git diff --dirstat=files,0 "${BASE_TAG}"..."${TARGET}"
   git log --oneline --reverse "${BASE_TAG}".."${TARGET}"
   git diff --name-status "${BASE_TAG}"..."${TARGET}"
   ```
7. Audit the diff with `references/review-checklist.md` and prove or dismiss each candidate against the released contract.
8. Discover and review relevant open documentation PRs using current read-only GitHub state. Do not infer coverage from local branches, titles, or historical context.
9. Report the Changesets release state, ship/block gate, risk assessment, documentation coverage, and conditional minor-release Key Changes draft.

## Changesets release policy

- Use active changeset frontmatter in pre-release planning and consumed changeset frontmatter in a generated final candidate as the authoritative release-type declaration.
- Assume required changeset validation passed in CI unless current evidence says otherwise. If its status is unavailable, say so; do not silently rerun the semantic bump classification inside this skill.
- When current evidence shows a missing, malformed, stale, or inconsistent changeset, report the release-preparation defect. In planning mode, give the exact correction without pretending a candidate exists. In final-candidate mode, block until the Changesets inputs and generated outputs agree.
- A target with no releasable package changes and no changesets has release type `none`. Do not invent a patch release.
- In planning mode, package versions may still match BASE. The Changesets workflow owns the later version bump.
- In final-candidate mode, verify that the consumed release type, generated package versions, fixed-group propagation, changelogs, and version commit agree. A mismatch is blocking.
- A user-supplied `patch` or `minor` label is context, not an override for repository Changesets state. Report disagreement and use the repository declaration.
- Distinguish an undocumented migration from the absence of a usable migration or compatibility path. Missing documentation is non-blocking; an actual supported-path break with no usable migration or fallback can block regardless of the declared bump.

## Deterministic gate policy

- Default to **🟢 GREEN LIGHT TO SHIP** unless at least one blocking trigger is proven.
- Use **🔴 BLOCKED** only with concrete release-blocking evidence and an actionable unblock condition.
- Blocking triggers:
  - A confirmed regression or bug introduced in `BASE_TAG...TARGET`.
  - In final-candidate mode, invalid Changesets state or a mismatch between consumed changesets and generated versions, changelogs, or fixed-group updates.
  - A confirmed breaking public API, protocol, config, or durable-state change with no usable migration, fallback, or compatibility path.
  - A concrete data-loss, corruption, or security-impacting change with unresolved mitigation.
  - A release-critical packaging, build, or runtime path broken by the diff.
- The following are never blocking by themselves:
  - Large diff size, broad refactoring, or many touched files.
  - Speculative "could regress" concerns without evidence.
  - Not rerunning CI checks locally.
  - Missing, incomplete, unmerged, stale, or post-release documentation.
  - Unchanged package version metadata in pre-release planning mode.
- A documentation review may reveal an underlying runtime or compatibility defect. Block only for that defect, not for the documentation state.
- A green gate must still explain important user-visible release surfaces.

## Workflow

### Prepare and map the diff

- Fetch current remote tags and the target ref. Keep working-tree changes out of the comparison.
- Prefer a user-specified base tag, but still refresh remote tags.
- Assume the target passed repository CI, including `$code-change-verification` and `$changeset-validation`, unless told otherwise. Do not rerun routine unit, lint, formatting, type, coverage, or changeset checks by default.
- Use diff stats, directory distribution, commit order, and name status to identify high-risk areas. Read changed tests as behavioral evidence, not as proof by themselves.

### Audit contracts and prove findings

- Compare BASE and TARGET rather than reviewing TARGET in isolation.
- For public APIs, compare exports, identity, TypeScript signatures, parameter order, defaults, enums, and documented behavior.
- For packages, compare supported Node.js and TypeScript versions, dependencies, peers, optional dependencies, package exports, published contents, version metadata, and ESM/CJS/type behavior.
- For persisted state, schemas, protocols, config, and environment variables, identify the released durable boundary and verify backward reads or a usable migration path.
- Route runtime changes through the owning reference in `.agents/references/README.md` and trace required consumers and symmetry axes.
- Promote a candidate only when the diff proves a contract violation, reachable supported-path regression, or concrete user-visible release consideration.
- Use the smallest identical BASE-versus-TARGET public-path or packed-artifact probe when static evidence cannot resolve a decision-relevant question.
- Assign **🟢 LOW** to verified safe considerations, **🟡 MODERATE** to concrete unresolved regression signals, and **🔴 HIGH** to confirmed blockers.
- Include `Evidence`, `Impact`, `Files`, and `Action` for every risk item. Do not manufacture test or code work for a safe release consideration.

### Review documentation coverage

- First derive a documentation-obligation inventory from the runtime audit: breaking changes, migrations, defaults, opt-ins or opt-outs, major features, public APIs, provider and dependency compatibility, durable schemas, and changed user workflows.
- Before reporting any obligation as uncovered, inspect current open PRs through approved read-only GitHub access. Never use `gh` in this repository and never mutate GitHub.
- Discover candidates using the Changesets release type, likely version, feature names, linked implementation PRs, branch names, and changed documentation paths. Do not rely on the PR title alone.
- For each candidate, record its PR number or URL and latest head SHA, then review its complete current diff and any discussion that materially affects a coverage claim. Several PRs may collectively cover the inventory.
- Keep the release target diff and documentation-PR diffs separate. Do not imply that an open docs PR is already part of the release target.
- Classify aggregate coverage as `covered`, `partially covered`, `not covered`, `stale/conflicting`, or `unverified`.
- If current read-only GitHub access is unavailable, use `unverified`, explain the search limitation, and do not claim that no docs PR exists.
- For every obligation that is not demonstrably covered, suggest the exact post-release file, section, example or claim, and required migration or compatibility wording. Mark suggestions provisional when coverage is unverified.
- Treat an unmerged docs PR as an acceptable post-release handoff. Note when it should remain unmerged until the SDK release is available.

### Draft minor-release Key Changes

- Include a copy-ready Key Changes draft whenever the authoritative Changesets release type is `minor`. Omit it for `patch` or `none` unless the user requests it.
- Derive the draft from verified user-facing contracts and changeset summaries, not raw commit counts or directory summaries.
- Follow the established JS release format:

  ```markdown
  ## Key Changes

  ### <User-facing theme>

  <A concise paragraph describing the behavior, exact public names, and migration or fallback when applicable.>
  ```

- Use one section when there is one major theme and normally two to seven sections for a broader minor release. Do not add a synthetic `Highlights` list.
- Put breaking behavior and the supported migration or fallback first. If the minor release has no breaking changes, say so in the relevant introductory section or first theme.
- Cover the major release themes without reproducing the generated `## What's Changed` list. Preserve exact public names, defaults, version bounds, opt-outs, and compatibility qualifiers.
- Use only stable published documentation URLs. Do not include open branch links; mention open docs PRs separately in Documentation coverage.
- Produce the draft even when the release is blocked, but do not let polished release copy hide the blocker.

## Form the recommendation

- State BASE_TAG, TARGET commit, review mode, Changesets state and source, authoritative release type, and generated candidate version when known.
- Summarize key directories and file counts without turning every commit into a report item.
- List only substantiated blockers and the most important verified release considerations, normally two to five grouped by user impact.
- Keep documentation coverage in its own non-blocking section.
- If blocked, include an exact unblock checklist and pass condition. If no concrete unblock action exists, do not block.
- Do not include routine command results, pass counts, skips, deselections, or a validation-status inventory.

## Output format (required)

Produce the report in English using this structure. Always use the fixed compare URL `https://github.com/openai/openai-agents-js/compare/<tag>...<target-commit>`. Do not use Markdown links in the report; keep URLs and repository paths plain.

```markdown
### Release readiness review (<tag> -> TARGET <ref>)

This is a release readiness report done by `$final-release-review` skill.

### Diff

https://github.com/openai/openai-agents-js/compare/<tag>...<target-commit>

### Release intent

- Review mode: <pre-release planning | final candidate>
- Changesets state: <active | consumed | none | invalid>
- Changesets source: <file paths or version commit; include validation limitation when material>
- Release type: <patch | minor | none | invalid>
- Candidate version: <version when generated, or not yet generated in planning mode>
- Versioning verdict: <declared plan | generated candidate consistent | correction required | invalid candidate>

### Release call

**<🟢 GREEN LIGHT TO SHIP | 🔴 BLOCKED>** <one-line rationale>

### Scope summary

- <N files changed (+A/-D); key areas touched: ...>

### Risk assessment (ordered by impact)

1. **<Finding or release consideration title>**
   - Risk: **<🟢 LOW | 🟡 MODERATE | 🔴 HIGH>**. <Impact statement.>
   - Evidence: <specific BASE-versus-TARGET evidence>
   - Files: <path(s)>
   - Action: <next step and pass condition>

### Documentation coverage (non-blocking)

- Coverage source: <PR URL or number and head SHA, multiple PRs, none found after a successful search, or search unavailable or partial>
- Status: <covered | partially covered | not covered | stale/conflicting | unverified>
- Covered obligations: <concise list or none>
- Gaps or post-release suggestions: <exact files, sections, claims, or none>
- Publication timing: <merge after release when docs describe unreleased behavior, or not applicable>

### Unblock checklist

1. [ ] <required only when blocked>
   - Exit criteria: <what must be true>

### Key Changes draft

<Include the copy-ready `## Key Changes` block only for a Changesets-declared minor release.>

### Notes

- <Material assumptions only>
```

- Omit `Unblock checklist` when the release is green.
- Omit `Key Changes draft` for `patch` or `none` unless requested.
- For a behavior-impacting green release, retain at least one **🟢 LOW** consideration; do not return only "No material risks identified".
- For a metadata-only release with no reportable user-facing contract, a concise empty-risk statement is acceptable.

## Resources

- `scripts/find_latest_release_tag.sh`: refresh remote tags and return the newest matching release tag.
- `references/review-checklist.md`: detailed Changesets resolution, discovery signals, docs-coverage review, and evidence requirements.

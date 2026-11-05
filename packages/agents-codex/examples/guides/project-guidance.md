# Prepare project guidance and skills

Use project guidance to supply workspace rules that apply to the files a native Turn accesses. Use capability directories to discover skill names and descriptions. Configure each capability explicitly in your application; neither selects an ambient host project or grants command execution.

These options require the current [source build](building.md). Provision the workspace on your selected [Environment](executors.md), with current credentials when using WSS.

## Prepare project rules

Create Markdown rules under the exact `Environment.cwd`:

```text
workspace/
  .claude/rules/general.md
  .claude/rules/amounts.md
  src/ledger.ts
```

Put a short unconditional rule in `general.md`, for example `Represent ledger amounts as integer cents.` To apply another rule only after access to a matching source path, use YAML frontmatter in `amounts.md`:

```md
---
paths: ['src/**']
---

Check that ledger arithmetic preserves integer cents.
```

Enable the capability when opening:

```ts
await using session = await agent.session({
  environment,
  projectGuidance: true,
});
```

The default is off. The SDK reads rules only beneath the chosen root, rather than searching ancestor projects. Rules without `paths` apply generally. `paths` must be a nonempty YAML list of relative globs; a scalar such as `paths: src/**` is invalid.

Scoped rules depend on actual supported native filesystem access. For example, a successful `read_text_file` or `view_image` read makes its matching rule available at the next model preparation. A path mentioned in a prompt, application tool metadata, or shell output does not establish that evidence. In particular, shell reads and listings do not activate scoped rules. The SDK refreshes the rule snapshot for each inference, including edits and removals.

`projectGuidance: true` requires an explicit Environment and admits `read_text_file` and `view_image` even when ordinary `tools` is empty. It grants no command tools. A submission with `tools: []` still selects none of those tools for that operation. Supply the current Environment and opt in again when restoring; saved guidance does not enable fresh reads.

### Run the prepared workspace example

With a WSS executor, create the tree above and a small `src/ledger.ts` before running the [project helper](../project-guidance.ts). Set `EXECUTOR_URL`, `EXECUTOR_CWD`, `EXECUTOR_TOKEN`, and `OPENAI_API_KEY`; optionally set `OPENAI_BASE_URL` and `AGENT_MODEL`. From the repository root, run:

```sh
pnpm exec tsx packages/agents-codex/examples/project-guidance.ts
```

This command makes live model calls. It asks for a read and a review, then prints the answer. To check behavior without a model key, run the existing native owner tests after the [test fixture setup](building.md#run-the-native-tests):

```sh
pnpm test:native packages/agents-codex/test/native/project-guidance.test.ts
```

Those tests inspect general guidance before a read and matching scoped guidance after it. They also cover failed access, empty tool selection, refreshed rules, and restored Sessions.

### Diagnose missing guidance

Check the exact cwd, `.claude/rules` spelling, and the matching source read before changing model instructions. Rule files must be regular UTF-8 text without NUL bytes. Linked rule files and directories are skipped. Each source is limited to 32,768 bytes, and the applicable labeled rule context is limited to 3,000 bytes. Discovery also bounds the tree to 1,024 entries, 256 directories, and 64 nested levels.

Malformed YAML/globs or exceeded limits withhold the rule snapshot; the Turn can still continue without that guidance. Start with one short unconditional rule, then add the scoped rule and a successful native read. Do not treat a completed answer as proof that the rule loaded.

## Prepare a skill catalog

A tested layout beneath a selected capability directory is:

```text
capabilities/
  skills/workspace_review/SKILL.md
```

Give `SKILL.md` a name, description, and body:

```md
---
name: workspace_review
description: Review the assigned workspace conventions.
---

Read only the application-selected inputs needed for the review.
```

Set `capabilityDirectories: ['/absolute/capabilities']` on the Environment. The paths refer to the selected executor, not the controller host. Discovery supplies the skill's name and description to the model. It does not expose arbitrary script, memory, input, or output file bodies, and it grants no command tools or workspace writes. Reading or executing skill resources requires separately admitted tools.

For the [workspace catalog example](../workspace-layout.ts), put the layout under `EXECUTOR_CWD` because that helper selects cwd as its capability directory. Set the same executor/model credentials as above and also set `AGENT_MODEL`, then run:

```sh
pnpm exec tsx packages/agents-codex/examples/workspace-layout.ts
```

The live answer should include `workspace_review` and its description. An empty catalog can be a successful discovery with no matching skill, so check the layout before diagnosing a connection failure. For a scripted check of the exact metadata and absence of unrelated file bodies or process execution, use:

```sh
pnpm test:native packages/agents-codex/test/native/workspace-layout-example.test.ts
```

Omitted roots and `[]` discover no skills. Restore with the destination's current capability directories; saved catalog text does not authorize discovery of old roots. See [remote skill directory permissions](executors.md#remote-skill-directories).

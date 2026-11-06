# Load instruction files and discover skills

Use `instructionFiles` to load trusted instruction files that your application selects. Use capability directories to discover skill names and descriptions for a workspace. Both features require the current [source build](building.md).

## Load trusted instruction files

Choose UTF-8 files and parent directories that untrusted actors cannot modify. Pass their paths in the `instructionFiles` option when opening a Session or starting a new `agent.run()`. The SDK reads the files during opening and appends their contents after the Agent instructions in the supplied order.

The [session configuration example](../session-configuration.ts) creates two private instruction files, opens a Session with both paths, and checks their order in the model request. It also checks the file identities in the recorded Turn receipt. Run it from the repository root after the [native build](building.md):

```sh
pnpm exec tsx packages/agents-codex/examples/session-configuration.ts
```

This example uses scripted model responses and needs no API key. Relative instruction paths resolve against the application's current working directory. A missing file, non-file path, or invalid UTF-8 rejects opening. See [instruction-file loading and restore behavior](session-configuration.md#load-trusted-instruction-files) before reopening saved work.

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

For the [workspace catalog example](../workspace-layout.ts), provision a [WSS executor](executors.md#remote-executor-tools) and put the layout under `EXECUTOR_CWD` because that helper selects cwd as its capability directory. Set `EXECUTOR_URL`, `EXECUTOR_CWD`, `EXECUTOR_TOKEN`, `OPENAI_API_KEY`, and `AGENT_MODEL`; optionally set `OPENAI_BASE_URL`. Then run:

```sh
pnpm exec tsx packages/agents-codex/examples/workspace-layout.ts
```

The live answer should include `workspace_review` and its description. An empty catalog can be a successful discovery with no matching skill, so check the layout before diagnosing a connection failure. For a scripted check of the exact metadata and absence of unrelated file bodies or process execution, use:

```sh
pnpm test:native packages/agents-codex/test/native/workspace-layout-example.test.ts
```

Omitted roots and `[]` discover no skills. Restore with the destination's current capability directories; saved catalog text does not authorize discovery of old roots. See [remote skill directory permissions](executors.md#remote-skill-directories).

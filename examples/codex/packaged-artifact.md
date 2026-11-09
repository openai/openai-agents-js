# Publish a checked JSON artifact

Use `jsonArtifactTool` from `@openai/agents/artifacts` to check JSON before writing a file. Your application chooses the file path and a Zod schema, which defines the required fields. The model supplies a JSON string. The packaged tool checks the string and returns errors to the same agent so it can try again.

## Run the example

Use Node.js 22 or later and [build the matching SDK and native runtime](guides/building.md). The checkout must include `@openai/agents/artifacts`. Run this command from the repository root:

```sh
pnpm exec tsx examples/codex/packaged-artifact.ts
```

The [complete example](packaged-artifact.ts) uses a local scripted Responses peer and needs no API key. It sends malformed JSON, then an empty title, then a valid title through one native Session. The tool returns syntax and schema errors before writing the corrected report. The script asserts the saved content and prints:

```text
Published checked report.
{
  "title": "Quarterly results"
}
```

The script uses a temporary directory and removes the report when it exits. The peer prescribes each model response; this example verifies native tool execution and feedback without testing live model reasoning.

## Choose the destination and schema

Pass `name`, `path`, and `schema` to `jsonArtifactTool`. The returned tool accepts one model argument, `json`, containing a string. Keep the destination under application control. Its parent directory must already exist and allow writes.

The tool parses the candidate and checks it with the supplied Zod schema. It returns at most five check errors in a message capped at 2,048 characters. A rejected candidate leaves an existing report unchanged. After validation succeeds, the tool writes UTF-8 JSON to a temporary file and replaces the destination in one file operation. This prevents readers from seeing a partially written report; it does not guarantee storage after a machine crash.

Filesystem errors and unexpected checker errors fail the turn. Successful concurrent calls use the last file replacement. Your application owns access to the output file and decides how long to keep it.

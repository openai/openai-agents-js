---
name: examples-run-analysis
description: Analyze the latest completed repository example run from its existing logs and source files. This skill is strictly read-only and never starts, reruns, stops, retries, escalates, or owns workflow processes.
---

# Examples Run Analysis

Use this skill only to analyze evidence produced by a completed manual example workflow. The repository workflow belongs to the contributor who invoked its pnpm command; this skill never owns execution or cleanup.

## Read-only boundary

- Use only read-only file listing, reading, and searching to inspect repository sources and existing evidence.
- Never invoke pnpm, Node.js, Bash, an example, a build, a test, or another workflow command.
- Never start, rerun, retry, stop, signal, or kill a process. Never create or own a background job.
- Never request elevated execution, broaden filesystem or network authority, source shell startup files, or alter credentials.
- Never create, modify, rename, or delete a log, rerun list, result file, source file, PID file, or other repository path.
- Do not treat this skill as authorization to perform a missing run. Ask the user to run the appropriate pnpm command manually and return after completed evidence exists.

## Evidence to inspect

1. Find the newest completed `.tmp/examples-start-logs/main_*.log`. A completed main log contains the final `Done.` line, validation summary, `All start results:` heading, table header, and one final table row for every discovered entry in that run. Treat a log without that complete footer as incomplete or still running.
2. For every final table row with `passed` and `exit 0`, resolve the full `package:script` name from the earlier start or skip lines when the fixed-width table abbreviated it. Read the matching `.tmp/examples-start-logs/<package>__<script>.log` and the example's `package.json` script target plus its relevant source files.
3. Read the runner sources `scripts/run-examples-workflow.sh` and `scripts/run-example-starts.mjs` when needed to interpret filters, auto-input, concurrency, serialized entries, configured exclusions, auto-skips, optional server/audio/external modes, and timeouts.

## Evidence freshness and completeness

Do not analyze a run as current when any of these conditions applies:

- no main log exists;
- the newest main log lacks its complete footer or indicates cancellation;
- its result table cannot be reconciled with the starts and skips recorded earlier in that same log;
- an exit-zero row has no matching non-empty per-example log or its full identity cannot be resolved;
- source files relevant to the requested validation changed after the run;
- the PID file or log evidence indicates that a workflow is still active;
- the available log predates the run or revision the user asked about.

When evidence is missing, stale, incomplete, or still running, stop the analysis and ask the user to run or finish `pnpm examples:workflow:start` manually. Mention optional flags such as `--filter`, `--include-server`, `--include-audio`, or `--include-external` only when they match the user's requested scope. Do not run the command yourself.

## Required analysis

Analyze every entry, not a sample.

- For every exit-zero example, compare its intended flow in source and comments with its log. Confirm the meaningful actions and results occurred, such as expected tool calls, approvals, handoffs, streamed output, generated artifacts, or final messages. Exit code zero alone is not behavioral validation.
- Classify non-zero entries as a repository failure, an expected example-level failure, an external dependency or credential restriction, a host/environment restriction, or incomplete evidence. Quote the concise untruncated log lines that justify the classification.
- Classify every skip by its recorded reason: interactive, server, audio, external service, default auto-skip, conditional missing environment, or runner exclusion. Distinguish an intentional skip from a failure and from an environment restriction.
- Report configured filters and optional modes so the user can see the exact scope that was and was not exercised.

## Output

Begin with whether the completed run is behaviorally valid for its recorded scope. Then provide one concise line per example with its classification and evidence. Include a separate list of failures, intentional skips, and environment restrictions when any exist. For a valid exit-zero entry, name what was checked rather than saying only `passed`.

Do not omit or ellipsize the log lines that establish a conclusion. Keep excerpts short, but include each relevant line in full.

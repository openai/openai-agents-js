# Sandbox Examples

These examples show the JavaScript sandbox APIs that are implemented in this branch: `Manifest`, `SandboxAgent`, local and Docker sandbox clients, filesystem and shell capabilities, lazy skills, host tools, handoffs, local and remote snapshots, external memory stores, and SDK conversation sessions.

Most examples call a model through `run`, so set `OPENAI_API_KEY` in your shell environment before running them.

## Small API Examples

| Example | Run | What it shows |
| --- | --- | --- |
| `basic.ts` | `pnpm -F sandbox start:basic` | Creates a sandbox session from a manifest and runs a `SandboxAgent`. |
| `handoffs.ts` | `pnpm -F sandbox start:handoffs` | Uses handoffs with sandbox-backed agents. |
| `sandbox-agent-capabilities.ts` | `pnpm -F sandbox start:sandbox-agent-capabilities` | Configures a sandbox agent with filesystem, shell, image, patch, compaction, and lazy skill capabilities. |
| `sandbox-agent-with-tools.ts` | `pnpm -F sandbox start:sandbox-agent-with-tools` | Combines sandbox capabilities with a host-defined function tool. |
| `sandbox-agents-as-tools.ts` | `pnpm -F sandbox start:sandbox-agents-as-tools` | Exposes sandbox agents as tools for another agent. |
| `resume.ts` | `pnpm -F sandbox start:resume` | Reuses a local sandbox snapshot across turns. |
| `memory.ts` | `pnpm -F sandbox start:memory` | Uses workspace memory files plus a local snapshot resume. |
| `memory-generation.ts` | `pnpm -F sandbox start:memory-generation` | Runs automatic Phase 1/Phase 2 sandbox memory generation when the session is flushed. |
| `memory-multi-agent-multiturn.ts` | `pnpm -F sandbox start:memory-multi-agent-multiturn` | Shows separate workspace memory layouts for two agents sharing one sandbox workspace. |
| `unix-local-pty.ts` | `pnpm -F sandbox start:unix-local-pty` | Exercises an interactive PTY in a Unix-local sandbox. |
| `unix-local-runner.ts` | `pnpm -F sandbox start:unix-local-runner` | Runs directly against the Unix-local sandbox backend. |
| `docker-runner.ts` | `pnpm -F sandbox start:docker-runner` | Runs directly against the Docker sandbox backend. |

## Notes

The JavaScript SDK now exposes generic remote snapshot and memory store interfaces. Cloud-specific convenience stores for S3, GCS, R2, or Azure are intentionally left to extension packages or application code so core does not pull in provider SDK dependencies.

The Python examples also include tax prep assets and tutorial/workflow scaffolds. Those assets do not exist in this repository, so they are not mirrored here yet.

# Keep engine selection explicit

The JavaScript SDK exposes separate entrypoints with separate execution owners:

| Entrypoint | Execution owner |
| --- | --- |
| `@openai/agents/classic` | The existing JavaScript `Agent`, `Runner`, and `run` loop. |
| `@openai/agents/classic/realtime` | The existing `RealtimeAgent`, `RealtimeSession`, and selected audio transport. |
| `@openai/agents/migration` | `SDKRunner.run` explicitly selects the native adapter for its supported classic Agent subset. |

Importing migration does not replace classic classes, a Runner already created by the application, or Realtime dispatch. Select the native adapter by calling it. The adapter supports trusted instruction callbacks with the original Agent and run context. The adapter rejects declarations outside its supported subset. The caller must choose the classic entrypoint explicitly.

JavaScript exposes Realtime audio through its existing session and transport APIs. It has no separate Voice API. Migration does not introduce an audio engine or translate Realtime sessions into native sessions.

## Source-checkout acceptance

Use Node.js 24. From the repository root, run `pnpm install` and `pnpm build`, then run the maintained acceptance case:

```sh
pnpm exec vitest run packages/agents-codex/test/classic/migration-engine-isolation.test.ts
```

A successful command reports a passing Vitest case and exits. It runs offline without an API key.

The case uses public package imports in one Node.js process. It retains module identity and existing instances across migration import, exercises classic dispatch, and runs an offline Realtime session with `ScriptedRealtimeTransport`. Audio bytes travel through `RealtimeSession.sendAudio` and its `audio` event. It also checks native-adapter refusal followed by an explicit successful classic run.

The fixture uses the repository's import guard to reject native addon loading and process starts. It needs no live API credentials, audio service, or native build. This README is source-checkout guidance, not an additional packaged API or a promise of native audio support.

## Finish an existing classic approval

Keep a paused classic call on its original Runner until it settles. The native adapter does not accept classic `RunState` or its serialized form. Import completed Session history only after the original runtime finishes the decision and records the function result.

Use Node.js 24 and [build the matching native runtime and workspace packages](../guides/building.md). The [handover example](../migration-classic-handover.ts) uses scripted Models and needs no API key. Run it from the repository root:

```sh
pnpm exec tsx examples/codex/migration-classic-handover.ts
```

The command asks `Approve record_approved (original-held-call)? [y/N]`. Enter `y` to approve. It prints `Native continuation complete. { effects: 1 }`. Run the command again and enter `n`, or press Enter, to reject. That run prints `Native continuation complete. { effects: 0 }`. Each invocation starts an independent demonstration.

The example restores the exact original Agent and tool graph with `RunState.fromString`, retrieves the original interruption, and applies the application's decision. It resumes through the original classic Runner, then passes the completed Session to a fresh `SDKRunner.run()` call. The native continuation reads that history without repeating the effect. Restoring callbacks or supporting state across SDK versions remains the application's responsibility.

If an effect or history write has an unknown outcome, reconcile it before continuing. Do not replay work to manufacture a completed call/result pair. See [completed Session history](../guides/migrate-sessions.md#completed-session-history) for storage ownership and append failures.

Run the focused acceptance check for both decisions:

```sh
pnpm test:native packages/agents-codex/test/native/migration-classic-handover.test.ts
```

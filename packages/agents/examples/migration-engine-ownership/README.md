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

After building the SDK, run the maintained acceptance case:

```sh
pnpm exec vitest run packages/agents/test/classic/migration-engine-isolation.test.ts
```

The case uses public package imports in one Node.js process. It retains module identity and existing instances across migration import, exercises classic dispatch, and runs an offline Realtime session with `ScriptedRealtimeTransport`. Audio bytes travel through `RealtimeSession.sendAudio` and its `audio` event. It also checks native-adapter refusal followed by an explicit successful classic run.

The fixture uses the repository's import guard to reject native addon loading and process starts. It needs no live API credentials, audio service, or native build. This README is source-checkout guidance, not an additional packaged API or a promise of native audio support.

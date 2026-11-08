# Released v0 baseline

This directory is a separate Node.js 24 application pinned to `@openai/agents@0.21.0`. Its root imports intentionally refer to that released SDK. Do not compile it against the surrounding workspace's native root import.

Follow the [parent example's copy and install commands](../README.md#run-the-released-v0-application-separately). Copy `../business.ts` too, keeping its relative location. Run `npm test -- /absolute/path/to/records` in the copied `v0/` directory. The application uses the public v0 ScriptedModel, checks permitted and denied notifications and two-turn history, and writes `classic-state.json` for the current classic checks.

Keep the resulting lockfile with the baseline. The command uses synthetic model responses and an in-memory notification receipt, so it needs no API key and sends no notification.

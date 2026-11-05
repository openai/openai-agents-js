# Observe account quota in a supervised worker

Use [`WorkerSignals`](signals.ts) when your supervisor already has a trusted account service. It lets [`waitForWorkerAttention`](supervision.ts) report a quota block while the worker waits for a root Turn. The [standard worker](README.md#wait-for-work-that-needs-attention) can run with just an API key.

## Attach a full quota response

In your supervisor, supply the current `accountId`, attachment `generation`, and full rate-limit `response` from your account service. Set `observedAt` and `expiresAt` in Unix seconds. Pass the resulting `signals` to `superviseArtifact` or `waitForWorkerAttention`.

```ts
import { WorkerSignals } from './signals.js';

const signals = new WorkerSignals({ accountId, generation });
signals.updateQuota({ generation, observedAt, expiresAt, response });
```

The response must identify the attached account. Keep the generation from when the read began. When the account changes or the supervisor reconnects, call `signals.attach({ accountId, generation })` with a higher generation. Attaching clears the previous observation.

## Refresh after a notification

A sparse `account/rateLimits/updated` notification prompts a full read. In the notification handler, pass the subscription's generation and your existing full-read function, `readAccountQuota`.

```ts
await signals.refreshQuota({
  generation,
  maxAgeSeconds: 30,
  read: readAccountQuota,
});
```

`refreshQuota` checks the generation before and after the read. The freshness interval starts when the read begins. The watcher orders observations by `observedAt`. For equal timestamps, it uses the arrival of a direct update or the start of a refresh. A slow older refresh therefore leaves a newer accepted observation in place.

## Decide when the worker needs attention

Read `signals.quotaResponse` for a copy of the full service response, including unknown fields. Read `signals.quota` for the selected bucket's windows, reset times, credit availability, and freshness. Missing fields appear as `null`.

A fresh observation for the current account can block the wait in either case.

- The service reports a recognized reached limit or spend control.
- The service disallows ordinary usage and confirms that no usable credits remain.

Use the service's credit flags to determine availability. A displayed balance, rounded percentage, elapsed reset time, or unrecognized reason cannot establish a block. A terminal provider quota stop still needs attention even if an earlier observation showed credits.

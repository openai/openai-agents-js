# Observe account quota in a supervised worker

Use [`WorkerSignals`](signals.ts) when your supervisor already has a trusted account service. It lets [`waitForWorkerAttention`](supervision.ts) report a quota block while the worker waits for a root Turn. The [standard worker](README.md#wait-for-work-that-needs-attention) can run with just an API key.

## Attach a full quota response

In your supervisor, supply the current `accountId`, attachment `generation`, and full rate-limit `response` from your account service. Set `observedAt` and `expiresAt` in Unix seconds. Pass the resulting `signals` to `superviseArtifact` or `waitForWorkerAttention`.

Create `WorkerSignals` with the attached `accountId` and `generation`, then pass an [`AccountQuotaObservation`](signals.ts) to `signals.updateQuota`. Supply these envelope fields:

| Field | Value from the trusted supervisor or account service |
| --- | --- |
| `generation` | The attachment generation captured when the read began. |
| `observedAt` | The read's observation time in Unix seconds. |
| `expiresAt` | The observation's expiration time in Unix seconds. |
| `response.accountId` | The account ID matching the attached account. |
| `response.ordinaryUsageAllowed` | The service's ordinary-usage permission, or an unknown value. |
| `response.rateLimitsByLimitId` | A map from bucket IDs, such as `codex` or `reports`, to their full rate-limit snapshots. |
| `response.rateLimits` | The service's single-bucket snapshot when a matching map entry is unavailable. |

Each bucket snapshot can include `limitId`, `primary` and `secondary` windows, `credits`, `spendControlReached`, and `rateLimitReachedType`. A window contains `usedPercent`, `windowDurationMins`, and `resetsAt` in Unix seconds. Credits contain the `hasCredits` and `unlimited` flags and the displayed `balance` string. Missing values remain unknown. `response.rateLimitUpsell` and unknown service fields remain available through `signals.quotaResponse`; they do not establish exhaustion.

For a runnable worker workflow, follow the [supervised-worker recovery example](README.md#run-the-example). Its [attention tests](../../../packages/agents-codex/test/native/supervised-worker-attention.test.ts) supply full account-service responses and exercise selected buckets, freshness, credit flags, and exhaustion.

The default bucket is `codex`. Pass `limitId` to select another bucket; exhaustion in an unselected bucket does not block this waiter. An entry in `rateLimitsByLimitId` takes precedence over `rateLimits`. The helper uses the single `rateLimits` value only when its `limitId` matches; an omitted ID there means `codex`.

For example, suppose a fresh response sets `ordinaryUsageAllowed: false`. Its `codex` bucket has `primary.usedPercent: 100` and `credits.hasCredits: true`. That bucket stays unblocked unless the service reports a reached limit or spend control. If the same response has `spendControlReached: true` for `reports`, selecting `reports` through `limitId` reports a quota block.

The response must identify the attached account. Keep the generation from when the read began. When the account changes or the supervisor reconnects, call `signals.attach({ accountId, generation })` with a higher generation. Attaching clears the previous observation.

## Refresh after a notification

A sparse `account/rateLimits/updated` notification prompts a full read. In the notification handler, await `signals.refreshQuota` with the subscription's `generation`, `maxAgeSeconds` set to `30`, and `read` set to your existing full-read callback, such as `readAccountQuota`.

`refreshQuota` checks the generation before and after the read. The freshness interval starts when the read begins. The watcher orders observations by `observedAt`. For equal timestamps, it uses the arrival of a direct update or the start of a refresh. A slow older refresh therefore leaves a newer accepted observation in place.

## Decide when the worker needs attention

Read `signals.quotaResponse` for a copy of the full service response, including unknown fields. Read `signals.quota` for the selected bucket's windows, reset times, credit availability, and freshness. Missing fields appear as `null`.

A fresh observation for the current account can block the wait in either case.

- The service reports a recognized reached limit or spend control.
- The service disallows ordinary usage and confirms that no usable credits remain.

The recognized `rateLimitReachedType` values are `rate_limit_reached`, `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached`, and `workspace_member_usage_limit_reached`. `spendControlReached: true` also establishes a block. `hasCredits: false` and `unlimited: false` together establish that no usable credits remain; either flag being `true` establishes usable credits. Missing flags leave availability unknown.

Use the service's credit flags to determine availability. A displayed balance, rounded percentage, elapsed reset time, or unrecognized reason cannot establish a block. A terminal provider quota stop still needs attention even if an earlier observation showed credits.

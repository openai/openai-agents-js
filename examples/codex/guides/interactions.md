# Native approvals, forms, and verification

Answer native approvals and forms, handle URL consent, or reply to a verification challenge. See [manual tool requests](tools.md#manual-tool-requests) for the application-owned reply flow.

## Native questions

Use `onInteraction` during `agent.run()` or when opening `agent.session()`. You can also read `session.interactions()` in an explicit Session. Match the request's type before preparing its reply.

| Request | Reply |
| --- | --- |
| Approval | `allow_once` or `deny`; approval grants no persistent permission. |
| Form | A JSON object matching the offered schema, or `null` to decline. |
| URL | Explicit consent through `replyUrlAccept()`, or `reply(null)` to decline. |
| `user_verification_request` | A proof from your configured backend, or `null`. See [verification setup](#explicit-verification-and-personal-apps). |

This handler denies approvals and declines forms and URLs:

```ts
const result = await agent.run('Use the selected tools.', {
  onInteraction(request) {
    if (request.type === 'action_requested')
      throw new Error('No manual-tool policy configured');
    if (request.type === 'approval_request') return request.reply('deny');
    return request.reply(null);
  },
});
```

An opening handler lives for the Session. It receives root and child requests, plus supported Session-scoped URL requests with null turn and submission IDs. It does not make startup questions available. Match the request type and return a reply constructed by that exact request. Use `session.respond(reply)` when the application owns delivery instead.

Handler failures belong to the request owner. A failure for a Session-scoped request fails the Session, including queued work. Cancellation and close abort the relevant handler signals and join entered handlers before cleanup finishes. A handler that ignores its signal can delay cleanup.

### Collect form answers

1. Narrow to `elicitation_request`. The form-only handler declines requests with `mode` set to `url`.
2. Read `description` and `schema` and collect input in the application.
3. Return `request.reply(values)` from the callback. In an explicit Session, deliver the prepared reply with `await session.respond(reply)`.

The SDK captures and checks the schema before exposing the form. `request.reply(values)` validates synchronously and only constructs the reply. Invalid values throw a fixed `TypeError` without private details. The request remains available for correction.

`session.respond()` rejects a reply if its owning native turn has expired. Successful delivery confirms neither the tool effect nor a durable receipt.

### Supported form schemas

Standard `form` requests support strings, booleans, integers, numbers, and enum-backed string multi-selects, including titled choices. Replies must use the offered field names and choice values. The SDK checks required fields, inclusive numeric and length bounds, and the supported email, URI, date, and date-time formats. Primitive forms reject unknown fields unless the schema sets `additionalProperties: true`. The SDK does not insert defaults or coerce values.

Standard forms, including requests with no mode, also support Draft 2020-12 object schemas. The supported subset includes nested objects, arrays, compositions, and single-hop references to root `$defs`. Constraints can appear at the root or in `allOf`. The `openai/form` and `openaiForm` modes use the same subset.

General schemas treat formats as annotations. Primitive standard forms use the strict checks above. The SDK rejects unknown or regex keywords, resource identifiers, dynamic references, remote or chained references, unsupported drafts, and `then`, `else`, `minContains`, and `maxContains`. It fetches no schema resources and issues no public grant for an unsupported schema.

Replies must contain finite JSON values. The SDK rejects cycles and values that JSON would omit or change.

Each schema read returns a detached copy. Changing that copy cannot relax validation. Keep descriptions, schemas, and answers private. They may contain credentials or other sensitive data. The wrapper omits descriptions and schemas from ordinary JSON and inspection; validation errors use fixed messages without retaining the validator's private error details.

### Request ownership and expiry

Root and child approvals and forms belong to the native turn that originally requested them. Their `turnId` and `submissionId` identify that owner; child requests also expose `subagentId`. The native turn's captured authority controls replies. An active server, a later turn, or matching request IDs cannot grant that authority. The request's `call` remains `null`. Do not infer a tool-call identity from the server name.

A child request belongs to that child's original running instance and turn. If the child stops, restarts, or moves to a later turn, its old request and any prepared reply expire.

Forms expire when their owning turn is cancelled. Approvals needed by work already in progress can remain usable during graceful cancellation.

Force cancellation, root completion, or Session close expires requests owned by that root. A delayed request or reply cannot authorize a later turn or another child, even when the server reuses its request ID.

### Read pending interactions

For requests with an owning turn, `turn.wait({ until: 'interaction' })` returns a pending batch with its original `turn` and current `requests`. Narrow by `type`. `action_requested` is a manual tool request. `approval_request` is a limited native approval. `elicitation_request` has a form or URL mode. `user_verification_request` carries a verification challenge. Exact-turn waits exclude Session-scoped requests. `turn.wait()` still waits for completion; `until: 'manual_tool'` returns manual tool requests only.

An observer's `signal` cancels only that observer. It does not answer questions, cancel the turn, or consume grants. Completion and terminal errors take precedence over a pending batch. An owned continuation can give a request its own submission ID while the batch retains the original public turn. A returned batch does not reserve its requests; another observer or callback can answer first.

`await session.pendingInteractions()` returns a frozen snapshot of issued requests. `session.interactions()` yields each live wrapper once per iterator. Close an iterator when you stop reading. These operations read live owners rather than replaying observations; old events, saved state, and copied JSON cannot issue replies. See [the question example](../native-questions.ts) for application-owned form collection, Session reading, and a safe deny/decline handler.

### Wait for a supervisory outcome

In `0.22.0-alpha.2`, `await turn.waitForAttention({ signal })` waits for the captured Turn's completed result, current owned interactions, or a known terminal stop that needs application action. The `0.22.0-alpha.1` bundles do not provide this method.

Narrow the returned value in this order:

| Check | Outcome and next action |
| --- | --- |
| `'requests' in outcome` | A `PendingRequests` batch. Handle the live requests as above, then wait again. The batch reserves no replies. |
| `'type' in outcome` | A terminal `TurnNeedsAttention` result with `type: 'needs_attention'`. Inspect `reason`, `error`, and `rateLimits` before deciding what to do next. |
| Otherwise | `Completed`. Read its validated `finalOutput`. |

The terminal reasons are `interrupted`, `connection_lost`, `rate_limited`, `quota_blocked`, and `budget_exceeded`. These describe a stopped Turn; waiting again does not restart it. The original `turn.wait()` still rejects for that failure. `waitForAttention()` converts only these recognized native failures into values. Unrelated provider errors, application callback errors, output-validation failures, and cleanup failures still reject. Treat `rateLimits` as a diagnostic snapshot, not permission or a schedule to retry uncertain work.

The optional signal aborts this waiter with its reason. It does not cancel the Turn, answer requests, or turn a deadline into an `interrupted` result. A settled public result takes precedence at the final scan. If the application stops supervising, [cancel the captured root or close its Session](sessions.md#choose-a-cancellation-lifetime) and join cleanup. Session-scoped requests remain outside this exact-Turn wait, as with `until: 'interaction'`.

The [supervised worker](../supervised-worker/README.md) combines this method with deadlines, explicit stop and cleanup, and application-owned status. Its account-level signals are additional application policy; `waitForAttention()` alone does not monitor an account or recover stopped work.

### Read saved Codex plan usage

With a [current source build](building.md), call `session.planUsage()` on an open Session that [uses a saved Codex login](session-configuration.md#use-a-saved-codex-login-on-a-headless-host). The method returns `null` for other authentication modes, including API keys and registered Sign in with ChatGPT. Pass a signal to limit the read. If the signal aborts, the read rejects with the signal's reason.

```ts
import type { Session } from '@openai/agents';

export async function readSavedPlanUsage(session: Session) {
  const usage = await session.planUsage({ signal: AbortSignal.timeout(5_000) });
  if (!usage?.identityVerified) return null;

  const codex = usage.rateLimitsByLimitId.codex;
  return {
    observedAt: new Date(usage.observedAt * 1_000).toISOString(),
    primaryUsedPercent: codex?.primary?.usedPercent ?? null,
    spendHeadroomPercent: codex?.individualLimit?.remainingPercent ?? null,
  };
}
```

The SDK sets `identityVerified` when the reported account and user match the saved login. The example returns `null` if it has no verified snapshot. Use `usage.observedAt`, the receipt time in Unix seconds, to decide how long to display a snapshot. If the provider omits the primary window or individual spend limit, the example returns `null` for that value. The provider decides whether to admit the next request.

### When requests are available

A Session-scoped URL request has null turn and submission IDs and stays outside exact-turn waits. Closing or retiring its issuing Session expires the wrapper and declines the unanswered request.

Idle forms and opening prompts before turn admission receive no application grant. During startup after admission, a turn-scoped stdio process can ask questions owned by that turn. Child approvals and forms require `NativeAgents({ interactions: true })`. Form extensions are unavailable with LocalStorage.

Root command and patch approvals require selected Environment tools. A child must also have interactions enabled and permission to request the operation. Core MCP approvals must match the original turn, call, and selected raw server and tool. These replies cannot change permission profiles, add network access, or approve other kinds of requests.

`HttpMCP` and `StdioMCP` with `approvalMode: 'preapproved'` approve automatically. Ordinary `native` mode follows Core policy and tool annotations. Without `onInteraction`, a native question fails an owned run with `InteractionRequired`. The same handler handles manual tool requests.

A native question during MCP setup fails Session opening. Opening waits for cleanup before reporting the failure, so retain that error and any reported cleanup failure before trying again.

### Explicit URL consent and completion

Use `request.mode` to distinguish a form from a URL request. Form answers use `request.reply(values)` or `request.reply(null)`. Decline a URL with `reply(null)`.

To accept a URL request from an application-owned Session reader:

1. Collect an explicit application decision to consent.
2. Construct `request.replyUrlAccept()` and deliver that exact reply with `await session.respond(reply)`. Constructing it alone sends nothing.
3. Await `request.waitForCompletion({ timeoutMs, signal })` on the same issued request.

`timeoutMs` must be positive and finite. A timeout or the waiter's signal stops only that observer. Other observers and the request remain live. Call `await request.expire()` to abandon that URL request and join its cancellation. Closing its owning Session also expires it.

Run this flow in an application-owned Session reader. In `onInteraction`, return the prepared reply for SDK delivery. Waiting for completion inside the callback would block consent delivery.

Peer-reported completion is separate from consent and does not prove authorization. A failed wait does not establish that no effect occurred. The SDK retains a matching completion even if the peer reports it before or during consent delivery.

Keep the issued wrapper tied to its original Session and any owning Turn or child instance. Copied IDs, saved state, and later child incarnations cannot recreate reply authority. Close and join the Session before disposing its provider.

The application owns any user interface or external account action. This flow does not navigate a browser, prove an external login succeeded, or cryptographically verify the URL. Keep the URL and server metadata private. Use the form-only handler when the application intends to decline every URL request; accepting URLs must be an explicit policy choice.

## Explicit verification and personal Apps

Use `HostedVerificationMCP` for your configured verification service, with its `url`, selected `tools` and optional `bearerToken`. Use `ChatGPTAppsMCP` for personal Apps and supply its account credentials through `NativeProviderOptions.chatGPT`. The personal Apps declaration uses its supported public service. It cannot register an arbitrary host. Registration is separate from consenting to a request, and neither a discovered server nor an observed challenge selects an account for the application.

### Personal Apps credentials

`NativeProviderOptions.chatGPT` supplies an explicit `accessToken` and `accountId` for the personal Apps connection. Your application supplies and renews these Apps credentials. Keep them out of checkpoints, logs and examples committed to source control. For model requests, see [Use a saved Codex login on a headless host](session-configuration.md#use-a-saved-codex-login-on-a-headless-host).

### Reply to a verification challenge

A `UserVerificationRequest` has type `user_verification_request`, a `title`, a `serverName`, and a defensive `Uint8Array` challenge copy. Obtain a `VerificationProof` with `credentialId` and `signature` only from the configured backend. Use the issued request's `reply(proof)`, or `reply(null)` to decline, then deliver it through the owning Session.

Report submission until the configured service confirms the outcome. A valid proof in the queue does not confirm acceptance. Challenge data, observed IDs, and copied requests grant no reply authority. Keep challenge and proof data private. Close the Session before disposing its provider.

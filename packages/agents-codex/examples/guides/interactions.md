# Native approvals, forms, and verification

Answer native approvals and forms, handle URL consent, or reply to a verification challenge. See [manual tool requests](tools.md#manual-tool-requests) for the application-owned reply flow.

## Native questions

Use `onNativeQuestion` during `agent.run()` or read `session.interactions()` in an explicit Session.

- Approvals accept `allow_once` or `deny`. They cannot grant persistent permission.
- Forms accept a JSON object or `null` to decline.
- URL requests require explicit consent. Use `reply(null)` to decline.
- A `user_verification_request` accepts a proof or `null`. See [verification setup](#explicit-verification-and-personal-apps).

This handler denies approvals and declines forms and URLs:

```ts
const result = await agent.run('Use the selected tools.', {
  onNativeQuestion(request) {
    if (request.type === 'approval_request') return request.reply('deny');
    return request.reply(null);
  },
});
```

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

A child request belongs to that child's original running instance and turn. If the child stops, restarts, or moves to a later turn, its old request and any prepared reply expire. Forms expire when their owning turn is cancelled. Approvals needed by work already in progress can remain usable during graceful cancellation. Force cancellation, root completion, or Session close expires requests owned by that root. A delayed request or reply cannot authorize a later turn or another child, even when the server reuses its request ID.

### Read pending interactions

For requests with an owning turn, `turn.wait({ until: 'interaction' })` returns a pending batch with its original `turn` and current `requests`. Narrow by `type`. `action_requested` is a manual tool request. `approval_request` is a limited native approval. `elicitation_request` has a form or URL mode. `user_verification_request` carries a verification challenge. Exact-turn waits exclude Session-scoped requests. `turn.wait()` still waits for completion; `until: 'request'` returns manual tool requests only.

An observer's `signal` cancels only that observer. It does not answer questions, cancel the turn, or consume grants. Completion and terminal errors take precedence over a pending batch. An owned continuation can give a request its own submission ID while the batch retains the original public turn. A returned batch does not reserve its requests; another observer or callback can answer first.

`await session.pendingInteractions()` returns a frozen snapshot of issued requests. `session.interactions()` yields each live wrapper once per iterator. Close an iterator when you stop reading. These operations read live owners rather than replaying observations; old events, saved state, and copied JSON cannot issue replies. See [the question example](../native-questions.ts) for application-owned form collection, Session reading, and a safe deny/decline handler.

### When requests are available

A Session-scoped URL request has null turn and submission IDs and stays outside exact-turn waits. Closing or retiring its issuing Session expires the wrapper and declines the unanswered request.

Idle forms and opening prompts before turn admission receive no application grant. During startup after admission, a turn-scoped stdio process can ask questions owned by that turn. Child approvals and forms require `NativeAgents({ interactions: true })`. Form extensions are unavailable with LocalStorage.

Root command and patch approvals require selected Environment tools. A child must also have interactions enabled and permission to request the operation. Core MCP approvals must match the original turn, call, and selected raw server and tool. These replies cannot change permission profiles, add network access, or approve other kinds of requests.

`HttpMCP` and `StdioMCP` with `approvalMode: 'approve'` approve automatically. Ordinary `auto` mode follows Core policy and tool annotations. Without `onNativeQuestion`, a native question fails an owned run with `InteractionRequired`. `onInteraction` handles manual tools.

Opening starts with an empty native MCP roster, starts the sole event reader, then publishes the captured current roster and policies. A native question during publication fails opening and joins cleanup. The cancellation evidence covers a native Thread that already exists before the public Session promise resolves; it does not establish cancellation of pre-Thread construction or same-Engine sibling isolation.

### Explicit URL consent and completion

Use the request's `mode` to distinguish a form from a URL request. Form answers still use `request.reply(values)` or `request.reply(null)`. URL decline also uses `reply(null)`. To consent to an issued URL request, collect an explicit application decision, prepare `request.replyUrlAccept()`, and deliver that exact reply with `await session.respond(reply)`. Constructing the reply alone sends nothing.

After delivering consent, await `waitForCompletion({ timeoutMs, signal })` on the same request. `timeoutMs` must be positive and finite. A timeout retires the request. A waiter's signal cancels that waiter alone.

Run this flow in an application-owned Session reader. In `onNativeQuestion`, return the prepared reply for SDK delivery. Waiting for completion inside the callback would block consent delivery.

Peer-reported completion is separate from consent and does not prove authorization. A failed wait does not establish that no effect occurred. The SDK retains a matching completion even if the peer reports it before or during consent delivery.

Keep the issued wrapper tied to its original Session and any owning Turn or child instance. Copied IDs, saved state, and later child incarnations cannot recreate reply authority. Close and join the Session before disposing its provider.

The application owns any user interface or external account action. This flow does not navigate a browser, prove an external login succeeded, or cryptographically verify the URL. Keep the URL and server metadata private. Use the form-only handler when the application intends to decline every URL request; accepting URLs must be an explicit policy choice.

## Explicit verification and personal Apps

Use `HostedVerificationMCP` for your configured verification service, with its `url`, selected `tools` and optional `bearerToken`. Use `ChatGPTAppsMCP` for personal Apps and supply its account credentials through `NativeProviderOptions.chatGPT`. The personal Apps declaration uses its supported public service. It cannot register an arbitrary host. Registration is separate from consenting to a request, and neither a discovered server nor an observed challenge selects an account for the application.

### Personal Apps credentials

`NativeProviderOptions.chatGPT` supplies an explicit `accessToken` and `accountId` for the personal Apps connection. These credentials are separate from model credentials and saved conversation configuration. Provision them explicitly before running the application. The SDK does not discover or refresh an existing ChatGPT login from the surrounding environment. Keep credentials out of checkpoints, logs and examples committed to source control.

### Reply to a verification challenge

A `UserVerificationRequest` has type `user_verification_request`, a `title`, a `serverName`, and a defensive `Uint8Array` challenge copy. Obtain a `VerificationProof` with `credentialId` and `signature` only from the configured backend. Use the issued request's `reply(proof)`, or `reply(null)` to decline, then deliver it through the owning Session.

Report submission until the configured service confirms the outcome. A valid proof in the queue does not confirm acceptance. Challenge data, observed IDs, and copied requests grant no reply authority. Keep challenge and proof data private. Close the Session before disposing its provider.

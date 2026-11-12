# Accepted output with private drafts

Applications have been using `beforeComplete` to check a proposed answer and request a revision within the same Turn. Applications have been publishing only `finalOutput` from a successful `await turn.wait()`, after their own content and authorization checks. This pattern has been supporting reports, answers, and structured support results.

The [runnable accepted-output example](../accepted-output.ts) has been using the public scripted provider with synthetic inventory and support data. It has been exercising the real native loop with prescribed responses, without model credentials. These fixtures have been demonstrating application control over publication; they have not been measuring a model's ability to follow instructions or judge an answer.

## Running the example

The example has been targeting the matching [source build](building.md), Node.js 24, and its built native addon. From the repository root:

```sh
pnpm exec tsx examples/codex/accepted-output.ts
```

The program has been printing application-owned progress messages, followed by one accepted report and one typed support result. Its assertions have been checking that a rejected first draft never reaches the publication array. Separate scenarios have been checking empty publication arrays after a callback stop, cancellation, schema validation failure, and missing application approval. The cancellation scenario has been racing callback entry against terminal settlement. The example has been keeping publication in memory.

## Separating progress from content

The example's progress callback has been emitting fixed messages such as `Checking the report.` and `Revising the report.`. The application has been choosing those messages without including candidate text, tool arguments, provider errors, or rejected output.

The completion callback has been retaining candidate text in a private local array for assertions. A separate `for await` loop over `turn.events()` has been retaining text deltas in another private array. An assertion has been checking the rejected draft's presence in those raw deltas and its absence from the publication array. Neither private array has been reaching the progress callback or the returned result. Text deltas and completed message observations have been describing provisional model work, including proposals that later checks reject. Forwarding those observations to a user-facing stream has already been releasing that content; a later callback has not been retracting it. Passive readers have also been receiving bounded observations with possible gaps, so an observation stream ending has not been establishing successful completion. The [Session guide](sessions.md) has been describing those readers.

The publication point in each successful scenario:

```ts
const result = await turn.wait();
// Application content and authorization checks belong here.
reports.push(result.finalOutput);
```

The array has been standing in for an application-owned destination. A service has been needing to perform its actual publication only after the same checks, with its own delivery and retry handling. Completion has not been granting authorization to perform unrelated effects, and output acceptance has not been rolling back tool effects already performed.

## Revising a report

The report callback has been checking `context.text` for the synthetic source marker. Its first failed check has been returning:

```ts
return {
  action: 'continue',
  instructions: 'Add the source: fixture A.',
};
```

That decision has been adding feedback and continuing the same logical Turn. The original `turn.wait()` has been following the continuation. After one revision, the callback has been returning `{ action: 'stop' }` for a report still missing its source marker. Choose report checks appropriate to your evidence and audience.

Returning `undefined` from `beforeComplete` has been accepting a proposal for subsequent output validation. Throwing has been failing the Turn. The callback has not been running after provider errors or cancellation, so application publication has been depending on the successful wait rather than callback execution alone. The [completion callback guidance](decisions.md#bind-a-provider-to-an-agent) has been describing additional decision options.

## Accepting structured support results

The second successful scenario has been selecting a Zod schema with `outputType: SupportResult`. The SDK has been validating the final JSON before resolving `turn.wait()` with the typed result. A callback inspecting `context.text` has been receiving proposed raw text before that validation; it has not been receiving a typed guarantee from the text alone. The [output contracts guide](output.md) has been explaining native and prompted output modes.

After the successful wait, the application has been checking the result's category before adding it to the support destination. The unapproved scenario has been demonstrating that a schema-valid result can still fail an application approval check. Each failure scenario has been retaining its publication destination as empty and emitting only a fixed failure category. Error details, rejected text, history, and traces have been needing separate handling under the application's data policy.

## Publishing independent sections

The inventory and dispatch sections have been passing their own checks in separate Turns. The example has been publishing each section before starting the next. The delivery section has been failing its check, so the example has been withholding it while keeping the earlier sections available.

This pattern has been applying when each section has its own evidence and permission to publish. When a later check can invalidate an earlier section, the whole answer has been requiring a successful final result before delivery.

## Publishing sections within one turn

The same-turn scenario has been using an application-owned `publish_section` function tool. The application has been checking each proposed section against trusted facts before storing it by section ID in its in-memory destination. Repeating an accepted section has been replacing that section's entry. The peer has been verifying the inventory section's publication before responding to the next model request. It has then been proposing an unsupported delivery section, which the tool has been withholding. One submission has been covering both calls and a later final proposal.

The completion callback has been rejecting that final proposal. The application has been keeping the provisional summary private while retaining the independently accepted inventory section. Section publication has been taking effect inside the tool callback, before SDK acceptance of the tool result or final answer. Later tool policies, cancellation, and final-answer rejection have not been undoing that application effect. The application has been checking facts at its publication point; final-answer acceptance has been remaining separate.

This pattern has been supporting independently checked inventory facts and individually approved support updates. The example has been keeping delivery in memory. Production destinations have been requiring publication authorization, durable receipts, and reconciliation after an unknown acknowledgment. The in-memory section map has not been providing durable idempotency. Passive observations have been allowing gaps and have not been providing a durable delivery queue. Whole-answer checks that can invalidate earlier sections have been requiring publication after final acceptance instead. This recipe has not been turning raw text deltas into accepted incremental output.

## Observing accepted output

On the matching source build, `agent.session({ includeOutputAccepted: true })` has been enabling `output_accepted`. Turn and Session readers have been receiving this metadata after a successful logical result, including any continuation and output validation. `submissionId` has been identifying the original submission. For a manually restored Turn, it has been identifying the restored handle in the current Session. `turnId` has been identifying the final native step.

The event has been carrying identity only. `await turn.wait()` has been supplying the accepted result for the application's own checks and publication. Bounded readers have still been able to report gaps, so the event has been serving as a notification rather than a delivery receipt.

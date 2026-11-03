# Public results for external jobs

Declare a deferred tool for a call that the application will answer. Pass that same object to `jobs.register` and to the agent's `tools` list. The [thumbnail example](examples/external-job.ts) uses an application-owned SQLite journal to authorize each order and save its checkpoint. A separate worker writes the image. The projector exposes only its byte count to the model.

```ts
import {
  DeferredTools,
  deferredTool,
} from '@openai/agents/experimental/deferred';

const render = deferredTool({
  name: 'render_thumbnail',
  description: 'Render one thumbnail.',
  schemas: (builder) => ({
    parameters: builder.strictObject({ color: builder.enum(['red', 'blue']) }),
    result: builder.strictObject({
      byteCount: builder.number().int().positive().max(65_536),
    }),
  }),
});

// journal, provider and publicSize belong to the host application.
const jobs = new DeferredTools({ journal, tenant, runId: order });
jobs.register(render, {
  providerId: 'sqlite-thumbnail-v1',
  provider,
  project: publicSize,
  maxOutputBytes: 64,
  requireReconciliation: true,
});
```

`jobs.register` returns `undefined`. Keep using the declared tool object. `maxOutputBytes` defaults to 16,384 UTF-8 bytes of public JSON.

The `schemas` callback receives the helper's pinned Zod builder. Use that builder for the entire declaration. Registration captures the declaration. Recovery reuses the same tool object. The provider receives validated input. Its methods retain their `this` receiver, so a class instance can keep its journal and private client in instance fields.

Declare every public result key as a required field on a strict, closed object. Use ordinary JSON values and ordered arrays. Choose public names and compute derived values in the projector. Keep images, credentials, database locations, business order IDs and provider receipts in application storage. The helper validates and bounds the projected JSON before saving and delivering it. The saved result contains only the approved projection. For custom serialization outside this contract, use a normal `manualTool` and answer its matched request directly.

## Declare stable inputs and public results

Use `builder.strictObject` for each object, including nested objects. Both inputs and results support JSON strings, booleans, finite numbers, nulls, arrays, and nested closed objects. Every result field is required. Use `.nullable()` when a required field can contain `null`. Results do not support enums, literals, general unions, optional fields, or defaults. Compute public values in `project` instead of using schema transforms.

Inputs also support enums, literals, and unions of supported schemas. To give an input field a scalar default, import `deferredDefault` from `@openai/agents/experimental/deferred` and call it inside `schemas`:

```ts
parameters: builder.strictObject({
  color: builder.enum(['red', 'blue']),
  attempts: deferredDefault(builder.number().int().positive(), 1),
}),
```

Use this fragment as the declaration's `parameters` value. Recovery does not support ordinary `.default(...)`, default factories, coercion, custom refinements, transforms, sets, or rich objects. Declaration construction can run application schema code before refusing an unsupported schema. Reuse the captured declaration for registration and recovery.

Supply generated request IDs in the original call as required fields. Do not generate them while validating or restoring input. Before sealing the Session, preparation checks every other registered pending call and refuses changed arguments. The journal receives bindings only for those registered calls. It does not receive bindings for unrelated manual tools in the same batch. Change the versioned `providerId` when the same input fields acquire a different meaning.

## Prepare and advance a job

From host code outside an interaction callback, call `jobs.start(session, request, options, use)` with the live root request matched by your deferred tool. The helper seals the original Session, saves the checkpoint through `journal.prepare`, reopens the original call, and advances it once. The `use` callback borrows the reopened Session. The helper closes that Session when the callback returns. Await any returned Turn and save settled state inside the callback.

For explicit control, `await jobs.prepare(session, request)` returns the prepared state without calling the provider. Restore it with a matching Agent, obtain a fresh matched request from the restored Session, then call `jobs.advance(restored, request)`. Restore with current provider credentials and application context. Keep the exact original prepared checkpoint while any other call in the batch remains pending. An uncertain journal write requires reconciliation before another operation.

An outcome with `status: 'continued'` contains the original restored Turn in `outcome.turn`. Await `outcome.turn.wait()` to obtain its completed result. Other statuses, including `pending`, `inputRequired`, `unknown`, and `busy`, describe external work for the host. They are not model results.

`waitMs` defaults to zero. A positive value permits one additional bounded observation after a pending creation. It does not start a polling loop. `timeoutMs` defaults to 10,000 and covers the helper operation, including journal calls and delivery. Both options use milliseconds. The timeout for preparation and advancement does not cover model continuation in the `start` callback. The application schedules later advances. On abort, the helper waits for cooperative work that has started. Abort does not cancel the remote job or undo its effects.

Preparation supports portable checkpoints at root manual-tool calls with plain text or supported prompted output. It refuses local profiles, an Environment, native children, pending native-schema output, and unsupported programmatic code state. For work that preparation cannot capture, reply to a live manual request. The `start` shortcut also refuses changed Session instructions or tool bindings. To replace them with current configuration, prepare and restore explicitly.

Automatic delivery refuses JSON containing the current model API key, journal key, or provider receipt, including an incidental substring match. A refusal does not authorize another start. After host review, a fresh live manual request can receive a safe reply directly. The application must record that completion itself.

## Run the process-restart example

Use Node.js 24 or later on a local POSIX filesystem. Build this checkout's packages and native runtime using [the source build guide](examples/guides/building.md) before running the example. Run the following commands from the repository root with `pnpm` using Node.js 24. The mock uses the public `@openai/agents/testing` fixture and the real native loop over loopback HTTP. It needs no API key or external model service.

Choose an absolute private directory outside every model-visible mount. Its parent must already exist and be trusted by the application. The example creates the directory with mode `0700`. Keep its database, SQLite sidecars, lock databases and private receipts outside those mounts for the entire job lifetime. The host trusts the parent directory and processes with the same effective UID.

```sh
# Choose a path under an existing trusted parent; do not put it in a model mount.
export THUMBNAIL_STATE_DIR=/absolute/private/thumbnail-state

pnpm exec tsx packages/agents/examples/external-job.ts run sample-01 --mock --directory "$THUMBNAIL_STATE_DIR"
# pending

pnpm exec tsx packages/agents/examples/external-job.ts worker sample-01 --directory "$THUMBNAIL_STATE_DIR"
# Rendered.

pnpm exec tsx packages/agents/examples/external-job.ts run sample-01 --mock --directory "$THUMBNAIL_STATE_DIR"
# completed
```

Each command starts a fresh process. The first host saves the exact prepared checkpoint before starting the provider job. The worker writes a 32 by 32 PPM image to the private database without connecting to a model. The second host restores the original checkpoint, observes the saved receipt and returns `{"byteCount":3085}` to the original tool call. The mock checks those exact tool-output bytes. It then finishes the model turn and conditionally saves the settled checkpoint as the order's completion marker.

Repeat the worker command to see `No queued thumbnail.` Repeat the host command after completion to see `completed` without another model request. Running the host again before the worker finishes prints `pending`. Reuse an order ID for retries. Choose a new order ID for a new image. The tenant and order come from the authorized host, never from model arguments.

To use a local Responses endpoint instead of the mock, replace `--mock` with `--model-port PORT` on both host commands. The example connects only to `127.0.0.1` and uses a synthetic `local-only` API key. The worker command stays the same.

## Try recovery with a normal manual tool

The separate [synthetic order example](examples/external-order-recovery.ts) shows application-managed recovery without `DeferredTools`. After the same native source setup, run it from the repository root with a trusted private directory:

```sh
pnpm exec tsx packages/agents/examples/external-order-recovery.ts /absolute/private/order-demo
```

The scripted run prints `The synthetic order is fulfilled.` It saves the original pending checkpoint, reconciles a synthetic effect in a separate application record, answers a newly issued live request, and records the final answer. Running it again returns that saved answer without another model request. No real order is placed and no model key is needed.

Use one owner and one synthetic order per directory. Run the owner's operations sequentially. This example has no multi-process lock or authorization service. Its atomic file replacement does not guarantee survival of power loss. A provider lookup failure records `unknown` and refuses automatic dispatch. Before the application repeats an external effect, a real provider must authoritatively reconcile its status and prevent duplicate effects at the target. A crash before the final completion marker can repeat model continuation.

## Recovery and ownership

`Journal.owner` holds a separate SQLite writer lock for one tenant and order, including while the host awaits other work. Process death releases that lock. Each new owner advances the generation. Journal operations and provider transactions check the current generation, permission and immutable binding. The worker uses short database transactions and does not need the host lock.

The journal stores the original checkpoint and its exact binding before issuing a start claim. `jobs.start` seals that session, persists the checkpoint and reopens the original tool call before calling the provider. Later processes restore that checkpoint and use `jobs.advance`. The journal chooses whether the helper creates, reconciles, observes, projects or delivers a saved public result. A timeout or uncertain acknowledgment does not grant permission to create another job.

Creation and reconciliation use the same SQLite transaction. The transaction inserts one immutable row containing the tenant, order, color, and receipt, or returns the existing receipt after checking the color. This provider can safely reconcile a crash between creation and receipt storage because it can check for absence and insert atomically. A remote provider needs an equivalent durable idempotency contract. A lookup followed by an independent create call does not provide that guarantee. When creation remains uncertain, preserve the reservation and report `unknown` until the provider can reconcile it.

If an uncertain outcome retains a known job receipt, the journal permits observing that same job again. Observation does not renew permission for a response or cancellation that has already been attempted. An unknown job without a receipt remains unresolved.

The journal saves the approved public JSON before delivery. If the host crashes afterward, the next host can deliver those saved bytes to the original pending call. The host calls `Journal.finish` only after the continued turn settles and `saveState` succeeds. A crash before that marker can repeat model continuation. This example does not promise exactly-once model generation or downstream effects from that continuation. It does prevent a retry from creating a second thumbnail under the same order, and the worker writes each completed image once.

The example supports one thumbnail and one prepared call per order. It does not implement distributed leases, network filesystems, Windows locking or a production authorization service. Keep the local POSIX state directory private and preserve the original checkpoint and binding. Before using the pattern in a service, enforce your application's current policy for the tenant and order.

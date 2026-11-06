# Local native web starter

Run a browser task through a real native Session, approve publication, and download the validated result. This single-process example uses scripted Responses and a trusted local HTTP MCP peer. It needs no API key and makes no billable model calls.

Use this starter to explore persistent receipts and application-owned task recovery locally. For a browser service that makes live model calls, use the [HTTP report service](../http-report-service.md). For terminal-only UI protocol frames, use the [native UI adapters](../native-ui/README.md).

## Before you start

Use Node.js 24 on Linux or macOS with a private local POSIX filesystem. Complete the [native source setup](../guides/building.md), including the matching addon, runtime helpers, and built workspace packages. The browser client uses plain JavaScript and needs no separate frontend build.

## Start the service

From the repository root, start the service with a new private directory:

```sh
pnpm exec tsx examples/codex/web-starter/server.ts --mode scripted --directory /tmp/agents-web-private --port 0
```

The command prints `Web starter: http://127.0.0.1:PORT`. Open that address and keep the server terminal running. Use a new application-owned state directory for an independent demo; stopping the server does not delete retained state.

Choose Alice or Bob, then send a task. The worker calls the selected `reports.report` MCP tool and reads a local audience note. It validates a JSON presentation and asks for publication approval. Approve to commit the download, or deny to finish without an artifact. The final summary appears only after typed output settles. The downloaded `presentation.json` contains exactly the validated, stored bytes.

When finished, press Ctrl+C in the server terminal or send `SIGTERM`. Shutdown joins worker cleanup before closing the peer and store. Stop the application before deleting its state directory; see [private state and restart](#private-state-and-restart).

## Identity and request recovery

Any local caller can choose either synthetic identity. The selector provides no production authentication. The service binds only `127.0.0.1`, checks its Host and Origin, and accepts only the two fixed identities.

A request key belongs to one identity. Retrying the same key and task recovers its receipt. Changing the task under that key fails.

Disconnecting, reloading, or switching users detaches a reader. Execution continues. Reconnect fetches a complete authorized snapshot. Stop sends a command to the exact Turn owner. The snapshot stays `stopping` until native and application cleanup finishes.

## Admission and deadlines

The application keeps one active worker and at most three queued tasks. Its 30-second deadline starts at admission, including queue and approval time. Cleanup may take longer. The slot remains held through cleanup.

Each HTTP body, reader count, connection count, model-visible result, and stored record is bounded.

## Private state and restart

The state directory must be owned by the current user with mode `0700`. The service creates it with that mode. Choose an application-trusted parent and a persistent path if receipts must survive restart.

State files must be private regular files with a single link. A SQLite writer lock permits one application process to own the directory.

Restart marks unfinished receipts `unknown`. It never retries their effects automatically. An artifact committed before a later failure remains available to its owner.

Receipts, artifacts, and checkpoint metadata expire after one hour. Report references expire with the MCP credential that created them. Expiry denies access but does not delete bytes. The store refuses more writes when it reaches 128 receipts or reports.

Stop the application before explicitly deleting or retiring its directory. Do not share the directory between processes or users.

## Approval and MCP authority

Approval tokens stay in worker memory and identify the exact issued manual request. They are scoped to one owner and receipt, expire at the deadline, and are consumed when a decision is enqueued.

The worker awaits native acceptance of that request's reply before committing publication. Browser JSON cannot create native reply authority. Pending requests and tokens are never saved.

MCP credentials stay on the server until joined cleanup revokes them. The peer separately enforces scope, rotation, expiry, and revocation. Approval cannot undo an earlier remote report effect or prevent prior tool discovery.

Full synthetic reports stay in SQLite. The model sees only a bounded summary and opaque reference. This uses ordinary MCP without the experimental Tasks adapter.

## Restore settled checkpoints

Only settled Session checkpoints are saved. The programmatic `worker.restore(owner, receipt)` demonstration opens a new Session with current context, current tools, and newly issued MCP credentials. It does not restore live requests or expose a generic restore endpoint.

## Recover and control work over HTTP

The page saves only the selected user's receipt and request key in local storage. It keeps approval tokens, artifacts, and results in memory.

After a reload, the page fetches a fresh snapshot for the saved receipt. If a submission lost its reply before saving a receipt, re-enter the exact original task and retry the same key.

The page resets the task field to its default on reload, so it cannot reconstruct a custom request for you. A new key starts new work.

Every application route below requires `?owner=alice` or `?owner=bob` to select the synthetic identity. This parameter is not an access credential.

| Request | Result |
| --- | --- |
| `POST /tasks` with `{ "requestKey": "example-1", "task": "Create my synthetic report" }` | Return 202 for new work, or 200 for the same owner's saved key and exact task. A changed task under that key returns 409. |
| `GET /tasks/:receipt` | Return the current snapshot for that owner. Unknown, foreign, or expired receipts return 404. |
| `GET /tasks/:receipt/events` | Stream complete application snapshots. Reconnect fetches current state; revisions discard older snapshots. |
| `POST /tasks/:receipt/approval` with `{ "token": "...", "approve": true }` | Consume the exact current token and enqueue the decision. A 202 reply does not itself establish publication. Read the artifact field in a later snapshot. |
| `POST /tasks/:receipt/stop` with `{}` | Request cancellation and return 202. Active work remains `stopping` until cleanup joins. |
| `GET /artifacts/:handle` | Download the owner's validated `presentation.json` bytes. |

### Handle refusals and uncertain replies

Foreign approval and Stop requests return 404. Spent, expired, or wrong-request approval tokens return 409.

After an uncertain approval response, refresh the snapshot instead of automatically replaying the decision. A full queue returns 429. The admission deadline is cooperative and does not enforce a hard token or cost ceiling.

## Run a local service or separate worker

Keep the service bound to loopback and send `SIGTERM` for shutdown. Shutdown stops admission, signals queued and active work, and joins worker cleanup before closing the MCP peer and SQLite store. A forced kill leaves unfinished receipts `unknown` on restart. For a supervised service, use the matching built SDK on a supported host and retain its private state directory.

### Use a separate external worker

For work completed in another process, follow the [external-job example](../../../packages/agents-codex/EXTERNAL_JOBS.md#run-the-process-restart-example). Its host saves the original checkpoint, a separate worker renders the thumbnail, and a later host resumes the matched call. That worker needs no model credential. Reuse the same authorized order and private directory for recovery. The browser starter does not launch that worker or transfer pending approvals to it.

## Verify the example

Run the focused native tests and type check from the repository root:

```sh
pnpm test:native packages/agents-codex/test/native/web-starter-example.test.ts
pnpm exec tsc -p packages/agents-codex/tsconfig.test.json --noEmit
```

The tests cover publication bytes, manual authority, owner separation, request recovery, validation refusal, finite admission, Stop, deadlines, passive reader disconnect, private storage, restart, and settled restore. Test execution and native qualification are separate from this source example.

### Check browser behavior

A full browser witness requires Node 24 and an existing Chromium installation whose normal sandbox works on the host:

```sh
CHROMIUM_PATH=/path/to/chromium node examples/codex/web-starter/browser-check.mjs --probe
CHROMIUM_PATH=/path/to/chromium node examples/codex/web-starter/browser-check.mjs http://127.0.0.1:PORT
```

A successful probe prints a JSON record for `sandboxed Chromium launch and CDP control`. Run the full witness against a fresh service started with a new state directory. It exercises Send, disconnect, reload, identity isolation, approval, exact download bytes, denial, and Stop.

If the probe reports `No usable sandbox`, use a host that supports Chromium's normal sandbox. API tests do not prove browser behavior. Do not disable Chromium's sandbox as a workaround.

## Example limits

Live model mode, distributed workers, automatic replay, production login, and durable restoration of pending approvals are outside this example.

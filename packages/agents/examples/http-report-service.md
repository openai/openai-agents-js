# Run a report worker with a browser client

This example connects a small Node.js service to a browser without a frontend framework. A worker owns each native Session and its original Turn. Disconnecting an HTTP reader stops observation. The worker continues. The separate Stop action cancels that Turn and waits for cleanup.

Use Node.js 24 and build the matching SDK and native addon as the [native build guide](../NATIVE.md#build-from-source) describes. This example makes live model calls. Set `OPENAI_API_KEY` in the server's environment, then choose a local demo token and start the service from the checkout root:

```sh
export REPORT_SERVICE_TOKEN="your-local-demo-token"
pnpm exec tsx packages/agents/examples/http-report-service.ts
```

The command prints `http://127.0.0.1:3000`. Open that address and enter the token. The server maps it to one demo user. The page keeps the token in memory and sends it in an Authorization header. It does not save the token in browser storage or put it in a URL. `OPENAI_BASE_URL` optionally selects the server's model endpoint. Model credentials remain in the server process.

## Try the ownership boundaries

1. Start a report and wait for the audience choice. The model decides when to call `choose_audience`. Live output can vary.
2. Disconnect the reader, then reconnect. The authorized snapshot shows the current job and pending choices. A disconnected reader cannot cancel the worker.
3. Choose an audience. The server answers the exact live manual request and waits for the original Turn's typed result.
4. Download the completed report. The server checks job ownership again and serves JSON built from the validated result.
5. Start another job and select Stop while it is pending. Stop waits for Session cleanup. A cleanup failure marks the job failed. It cannot undo effects that already happened.

Text in the provisional panel is an observation, not the result. The panel keeps its last 16,000 characters. If the SDK reports an observation gap, the page discards the draft and displays the current snapshot. A completed report remains available even when the model produced no text deltas. Failed output validation produces a sanitized failure category and no artifact.

Every snapshot carries a per-job revision. The browser ignores older revisions, so a delayed HTTP reply cannot replace a newer choice or completed result. Revisions order application snapshots. The `after` cursor remains the SDK's separate text-event sequence.

## Use the HTTP interface

Every `/jobs` route authenticates the request. The same principal must own the selected job. An unknown or foreign job returns 404. A client-selected job UUID is a correlation ID, not an access credential.

| Request | Behavior |
| --- | --- |
| `PUT /jobs/:id` with `{ "prompt": "..." }` | Start one job and return its snapshot. Reusing an ID returns 409. |
| `GET /jobs/:id` | Read current state, pending choices and any settled result. |
| `GET /jobs/:id/events?after=n` | Read SSE snapshots and provisional text after an SDK sequence. A gap produces a reset and fresh snapshot. |
| `POST /jobs/:id/replies/:replyId` with `{ "audience": "general" }` | Answer that live choice. `technical` is the other supported value. |
| `POST /jobs/:id/stop` | Revoke pending replies, cancel the original Turn and join cleanup. |
| `GET /jobs/:id/artifact` | Download `report.json` after successful settlement and cleanup. |

For example, start and inspect a job with curl:

```sh
JOB_ID=$(node -p "crypto.randomUUID()")
curl -X PUT "http://127.0.0.1:3000/jobs/$JOB_ID" \
  -H "Authorization: Bearer $REPORT_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Write a short report about reliable agents. Ask me to choose the audience first."}'
curl "http://127.0.0.1:3000/jobs/$JOB_ID" \
  -H "Authorization: Bearer $REPORT_SERVICE_TOKEN"
```

Use a reply ID from that snapshot to answer its current choice. Do not substitute a model call ID or an earlier reply ID. Invalid decisions return 400. Stale, duplicate, or wrong-job reply aliases return 409. The server claims a valid alias before awaiting delivery, so two concurrent replies cannot both use it. After an uncertain response, read the snapshot instead of retrying a reply blindly.

If a start response is lost, recover with `GET` using the same job ID. Do not create another ID to retry an uncertain start. Repeated Stop calls join the same work. A late Stop preserves an already completed result.

## Embed the service

The complete [TypeScript service](http-report-service.ts) exports `startReportService({ provider, authenticate, port })`. Supply a borrowed `NativeProvider` and an authentication function that resolves the request to a trusted principal. The helper binds to `127.0.0.1`. By default, the operating system chooses its port. It returns the listening `url` and an asynchronous `close()` method.

The application owns the provider. Await `service.close()` before closing it. Service shutdown detaches readers and joins all workers. The command entrypoint owns both resources and applies that order on shutdown. The adjacent [HTML client](http-report-service.html) and this recipe ship with the example.

The demonstration retains at most four jobs, two readers per job and four manual requests per job. It bounds request bodies and report fields. A slow stream disconnects instead of accumulating another event queue. The client can reconnect.

Restart the process to clear its retained jobs. Restart also invalidates reply aliases and artifacts. This example has no durable queue or checkpoint recovery. The page does not save the job ID, so a reload loses its current selection. Keep the ID to recover through the HTTP interface while the service remains running.

For receipt recovery across reloads and application restarts, see the [persistent local web starter](web-starter/README.md). For a separate process that completes an external effect, use the [external-job pattern](../EXTERNAL_JOBS.md).

Replace the single demo-token mapping with your application's authentication when adapting the code. Keep the principal separate from model arguments and client-supplied IDs. The audience choice selects report content. It grants no additional tool or file permissions. The artifact uses a fixed filename and in-memory JSON, so the model cannot select a filesystem path.

The focused tests use the real native runtime and local scripted model responses. They verify ownership, replies, cancellation, cleanup, and typed output. They do not measure live model quality.

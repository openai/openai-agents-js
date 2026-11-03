# GPT Live with an Agents SDK specialist

This local browser example connects GPT Live to an ordinary Agents SDK Agent through Responses delegation. GPT Live handles speech; its managed Responses backend calls `ask_order_agent`; the TypeScript server runs the order specialist with `Runner.run()` and returns a function result.

## When to use this pattern

This example uses the following path for specialist work:

`GPT Live → managed Responses model → ask_order_agent → Agents SDK Agent`

Choose this pattern when you want to reuse an existing Agent and let Live supply conversation context to a managed Responses model that decides when to call the specialist. The application executes the function and returns its result. The specialist keeps its instructions and tools in the Agents SDK.

The tradeoff is an additional model step: both the managed Responses model and the specialist's model do work, and the managed model continues after receiving the function result. That extra model work has its own usage cost and can increase response time. Compare useful spoken response time, task success, and cost on your workload when choosing a pattern.

### When client delegation is a better fit

With client delegation, the application can call the Agent directly:

`GPT Live → application delegation handler → Agents SDK Agent`

| Decision | This example's Responses delegation pattern | Client delegation |
| --- | --- | --- |
| Context | Live supplies context to the managed backend, which constructs the specialist request. | The application chooses the history, memory, and task state sent to the Agent. |
| Execution | The managed model selects the specialist function; the application runs it. | The application controls routing, execution, and which results return to Live. |
| Model work | Includes the managed model and the specialist's model calls. | Can omit the managed model and invoke the specialist directly. |

Choose client delegation when you need that direct control or want to avoid the intermediate model step. The application must collect conversation context, construct backend requests, track delegated work, and send results back to Live. A client delegation event contains metadata, not the user's request text, so it cannot simply be passed to `Runner.run()` as a complete prompt.

This example implements Responses delegation only. See the [Live delegation guide](https://developers.openai.com/api/docs/guides/live-delegation#choose-a-delegation-mode) for the comparison and client delegation flow. In either mode, application code remains responsible for permissions, confirmations, and business state.

## Run

Use Node.js 24, the repository's pinned pnpm version, a microphone, and a project API key with access to GPT Live. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
export OPENAI_API_KEY="your-project-api-key"
pnpm exec tsx packages/agents/examples/live/server.ts
```

The specialist imports the retained classic API from `@openai/agents/classic`. This example needs the built workspace packages and their dependencies; it does not load the native addon. The server keeps the API key out of the browser.

Open [http://localhost:8000](http://localhost:8000), select **Start conversation**, and grant microphone permission. Ask "What is the status of order A0042?" Then try "Actually, please check A0043." These are fictional records: A0042 is shipped with an expected September 15 delivery; A0043 is processing without a confirmed shipping date.

If autoplay is blocked, select play in the audio controls. **Mute microphone** controls local capture without stopping backend work. **End conversation** cancels application-owned work, requests Live finalization, and then releases the microphone and connections. If finalization does not arrive, the browser releases its resources and reports that final usage is unconfirmed.

GPT Live voice duration and both backend models can incur usage charges.

## How it works

1. The browser creates a WebRTC offer and sends it over an application WebSocket.
2. The server creates a Live session with Responses delegation and attaches a sideband before returning the SDP answer. Audio travels between the browser and OpenAI; the sideband carries server events and commands.
3. The managed Responses model turns the conversation into a self-contained `ask_order_agent(request)` function call.
4. The server collects completed function items from nested `response.output_item.done` events. It does not read pending calls from the empty terminal `response.output` snapshot.
5. A serial worker runs the specialist while the receiver continues processing Live events. The specialist uses a read-only `lookup_order` tool and stops after at most five model turns.
6. The worker submits every required `function_call_output` for a completed response before sending one `response.create` continuation.

The browser never executes functions. Transcript fragments are appended exactly as received, separately for each speaker; they are not authoritative completed turns. Specialist output appears in its own panel because result submission does not establish that GPT Live spoke it or that the listener heard it.

### What the specialist knows on each call

During the Live conversation, Live supplies context to the managed Responses backend. The backend's instructions ask it to include the relevant context, order ID, and latest corrections in each `ask_order_agent` request. The specialist receives that request string, not the full voice transcript or an automatically shared conversation history.

For example, after "Check order A0042" followed by "Actually, A0043," a complete specialist request could be "Check the status of order A0043. The user corrected the earlier order ID A0042." A request such as "Actually, A0043" alone leaves the specialist without the task it needs to perform.

Each `runner.run()` starts a separate specialist run. The specialist can use its model and tool exchanges within that run, but this example passes no session or previous run items into the next call. Reusing the same `Agent` object reuses its instructions and tools; it does not preserve conversation history between calls. If a request omits necessary information, the specialist is instructed to ask for clarification.

## Customize

Replace `createOrderAgent()` in `agent.ts` with your existing text Agent, and update the managed backend's function description and instructions. Choose the two backend models independently with the `agentModel` and `backendModel` options to `createLiveApp()`. Keep detailed business logic in the specialist and pass relevant conversation context through the outer function's arguments.

The sample does not implement tool approvals. An interrupted run returns an explicit refusal without executing the gated action. If you add approval-requiring tools, implement an approval and resume flow before treating an interrupted run as a completed operation. Specialist guardrails apply to that Agent's execution; they do not approve all output from the managed Responses backend or all speech from GPT Live.

Keep tool callbacks awaited, with no detached work or tool timeouts. Shutdown aborts the specialist and waits for its callbacks to settle before closing Live. A callback that ignores cancellation can delay shutdown. A timeout that returns before the callback settles would break that ownership rule.

## Boundaries and failures

This is a localhost demo. The server binds to `127.0.0.1:8000` and accepts the two documented localhost origins. An origin check is not authentication: add application authentication, authorization, and resource limits before hosting this for other users.

The example has no persistence, automatic reconnection, application-level retries, write operations, or client delegation. Duplicate function events are ignored within one connection. Agent errors become a short failure result; transport errors stop processing instead of rerunning work or blindly resending results. The normal SDK model retry policy still applies within a specialist run.

Corrections are handled through the managed Responses model's conversation context and subsequent function calls. Each lookup result includes its order ID, and each function result returns to the original call ID. The example does not infer cancellation from transcript fragments or claim that a spoken correction cancels work already running.

When setup fails after creation, the server attempts to attach only to close the created session. If a connection fails before `session.closed`, final voice usage is unconfirmed; the example reports this instead of claiming successful finalization. Canceling Agent work does not reverse an external operation. All tools in this demo are read-only.

## Offline checks

From the repository root, run:

```sh
pnpm exec vitest run --project @openai/agents \
  packages/agents/test/classic/live-agent.test.ts \
  packages/agents/test/classic/live-delegation.test.ts \
  packages/agents/test/classic/live-transport.test.ts \
  packages/agents/test/classic/live-example-ui.test.ts
```

These tests use the real classic Runner with scripted model responses, local HTTP and WebSocket servers, and controlled browser callbacks. They do not connect to the OpenAI API or verify microphone capture, remote speech, or model judgment.

## References

- [Live delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
- [Live WebRTC connections](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Live server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)

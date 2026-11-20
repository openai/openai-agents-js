# GPT-Live with an Agents SDK specialist

This local browser example uses GPT-Live 1.1, an Agents SDK order specialist, and hosted Web Search to demonstrate speech-triggered Standby, multilingual conversation, and Responses delegation. The managed Responses backend calls `ask_order_agent` for order questions. The Node.js server runs the specialist with `run()` and returns the result.

## When to use this pattern

This example uses the following path for specialist work:

`GPT Live → managed Responses model → ask_order_agent → Agents SDK Agent`

Choose this pattern when you want to reuse an existing Agent and let Live supply conversation context to a managed Responses model that decides when to call the specialist. The application executes the function and returns its result. This keeps the example's integration code small while leaving the specialist's instructions and tools in the Agents SDK.

The tradeoff is an additional model step: both the managed Responses model and the specialist's model do work, and the managed model continues after receiving the function result. That extra model work has its own usage cost and can increase end-to-end latency. Compare useful spoken response time, task success, and cost on your workload when choosing between the two patterns.

### When client delegation is a better fit

With client delegation, the application can call the Agent directly:

`GPT Live → application delegation handler → Agents SDK Agent`

| Decision | This example's Responses delegation pattern | Client delegation |
| --- | --- | --- |
| Context | Live supplies context to the managed backend, which constructs the specialist request. | The application chooses the history, memory, and task state sent to the Agent. |
| Execution | The managed model selects the specialist function; the application runs it. | The application controls routing, execution, and which results return to Live. |
| Model work | Includes the managed model and the specialist's model calls. | Can omit the managed model and invoke the specialist directly. |

Choose client delegation when you need that direct control or want to avoid the intermediate model step. The application must collect conversation context, construct backend requests, track delegated work, and send results back to Live. A client delegation event contains metadata, not the user's request text, so it cannot simply be passed to `run()` as a complete prompt.

This example implements Responses delegation only. See the [Live delegation guide](https://developers.openai.com/api/docs/guides/live-delegation#choose-a-delegation-mode) for the comparison and the client delegation flow. In either mode, application code remains responsible for permissions, confirmations, and business state.

## Run

Use Node.js 22.18 or later, `pnpm`, a microphone, and a project API key with access to GPT Live. From the repository root:

```bash
export OPENAI_API_KEY="your-project-api-key"
pnpm install
pnpm build
pnpm -F live start
```

Open [http://localhost:8000](http://localhost:8000), select **Connect**, and grant microphone permission. Try this sequence in one call.

1. When the demo is waiting for speech, ask "What's the status of order A zero zero four two?" To try a language switch, ask for the reply in Japanese. The fictional order A0042 has shipped and is expected September 15.
2. After the assistant finishes speaking, stay quiet until the inference panel shows **Standby**. Inference pauses after 20 seconds without an input or output transcript. The same call and conversation history stay available.
3. Say "Actually, the last digit is three. Could you tell me the status in English?" Speech resumes inference. The specialist checks order A0043, which is processing with no shipping date confirmed.

If the browser blocks autoplay, select **Play assistant audio**. The microphone button mutes local capture while backend work continues. **Disconnect** aborts application-owned Agent runs, requests Live finalization, and releases the microphone and connections.

To try hosted Web Search, say "Search the web for the latest OpenAI API news." When the backend cites sources, their links appear in the conversation timeline. Turn on **Debug events** to see the last call's event trace beside the timeline on wider screens and below it on smaller screens. The trace records browser and sideband timing and command identifiers without including raw event payloads.

The example uses the Live HTTP and WebSocket endpoints. Active and Standby time have [different rates](https://developers.openai.com/api/docs/models/gpt-live-1.1). The app shows their durations after disconnection when Live reports both. Both backend models can incur separate usage charges.

## How it works

1. The browser creates a WebRTC offer and sends it over an application WebSocket.
2. The server creates a Live session with speech wake and Responses delegation and attaches a sideband before returning the SDP answer. Audio travels between the browser and OpenAI. The sideband forwards `session.paused` and `session.resumed` so the browser can display the inference state.
3. The managed Responses model turns the conversation into a self-contained `ask_order_agent(request)` function call.
4. The server collects completed function items from nested `response.output_item.done` events. It does not read pending calls from the empty terminal `response.output` snapshot.
5. A promise queue runs the specialist while the receiver continues processing Live events. The specialist uses a read-only `lookup_order` tool.
6. The worker submits every required `function_call_output` for a completed response before sending one `response.create` continuation.

The server executes the specialist function. The managed Responses backend runs [hosted Web Search](https://developers.openai.com/api/docs/guides/live-delegation#add-hosted-tools) and the server extracts citations from completed backend message items. The browser timeline displays transcript fragments, specialist updates, and source links in arrival order. It preserves transcript fragments verbatim and groups adjacent updates from the same speaker or the specialist. Listen to the call for the assistant's spoken reply.

### What the specialist knows on each call

During the Live conversation, Live supplies context to the managed Responses backend. The backend's instructions ask it to include the relevant context, order ID, and latest corrections in each `ask_order_agent` request. The specialist receives that request string, not the full voice transcript or an automatically shared conversation history.

For example, after "Check order A0042" followed by "Actually, A0043," a self-contained specialist request could be "Check the status of order A0043. The user corrected the earlier order ID A0042." A request such as "Actually, A0043" alone leaves the specialist without the task it needs to perform.

Each `run()` starts a separate specialist run. The specialist can use its model and tool exchanges within that run, but this example passes no session or previous run items into the next call. Reusing the same `Agent` object reuses its instructions and tools; it does not preserve conversation history between calls. If a request omits necessary information, the specialist is instructed to ask for clarification.

## Customize

Replace `createOrderAgent()` in `agent.ts` with your existing text Agent, and update the managed backend's function description and instructions. The two backend models can be chosen independently in `createOrderAgent()` and `sessionConfig()`. Keep detailed business logic in the specialist and pass relevant conversation context through the outer function's arguments.

The sample does not implement tool approvals. If you add approval-requiring tools, implement an explicit approval and resume flow before treating an interrupted run as a completed operation. Specialist guardrails apply to that Agent's execution; they do not approve all output from the managed Responses backend or all speech from GPT Live.

## Boundaries and failures

This is a localhost demo. The server binds to `127.0.0.1:8000` and accepts the two documented localhost origins. An origin check is not authentication: add application authentication, authorization, and resource limits before hosting this for other users.

The example has no persistence, automatic reconnection, application-level retries, write operations, or client delegation. Duplicate function events are ignored within one connection. Agent errors become a short failure result; transport errors stop processing instead of rerunning work or blindly resending results. The configured SDK model retry policy still applies within a specialist run.

Corrections are handled through the managed Responses model's conversation context and subsequent function calls. Every result includes its order ID and returns to the original call ID. The example does not infer cancellation from transcript fragments or claim that a spoken correction cancels work already running.

If the initial browser offer or Live session creation fails, the browser and server terminal identify the failed stage. OpenAI HTTP failures include the status, fixed troubleshooting guidance, and request ID when available; network errors and timeouts have separate messages. Raw API error messages, response bodies, headers, and credentials are not logged. Keep the request ID when reporting a failure.

When setup or a connection fails after creation without confirmed finalization, the server attempts a cleanup-only attachment to close the created session. If a connection fails before `session.closed`, final voice usage is unconfirmed; the example reports this instead of claiming successful finalization. Canceling Agent work does not reverse an external operation. All tools in this demo are read-only.

## Offline checks

From the repository root, run `pnpm exec vitest run examples/live` for delegation, server lifecycle, and controlled browser callback tests. Run `pnpm -F live build-check` for the example type check. These checks do not connect to the OpenAI API.

## References

- [Live delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
- [Live Standby configuration](https://developers.openai.com/api/docs/guides/live-conversations#configure-standby)
- [Live WebRTC connections](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Live server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)

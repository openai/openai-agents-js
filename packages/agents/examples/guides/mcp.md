# MCP tools

Declare a native HTTP or stdio connection, or use `selectMcpTools` to borrow an application-owned SDK MCP server.

## MCP connections

Add `StdioMCP` or `HttpMCP` declarations to `tools`, naming the MCP tools the session may expose. Their optional `transformResult` callback runs before the result reaches the model and history. Codex owns the connection and sends calls to the selected server. That server performs the operation in its own process or service. A stdio server runs at its declared host or Environment location. An HTTP server runs at its configured service endpoint.

## Connect HTTP tools on demand

`HttpMCP` defaults to `activation: 'session'`, which connects and lists tools during opening. Set `activation: 'operation'` for a fresh ordinary root/direct HTTP Session to reserve its finite raw tool names without connecting. Opening and operations that omit that server perform no connection or discovery. A selected operation connects to the server, exposes only its admitted leaves and confirms the native generation before model submission. For example, a declaration named `records` with raw leaf `find-record` can select that leaf with `toolRef('find_record', 'mcp__records')`. Server discovery never adds authority beyond the opening declaration.

Omitted operation options use Session defaults. A first submission can activate tools selected by default. Use `tools: []` to leave them dormant. Omit a server from a later selection to make it dormant again.

Idle updates keep the reserved identities and can change their bindings. Operation selectors cannot change endpoints or credentials. If activation is canceled or publication remains unconfirmed, the SDK blocks further roots from using stale authority.

Use on-demand HTTP connections in a fresh plain Session with a direct root. The SDK rejects child agents, Code Mode, hosted registration, local storage, and restore before connecting. Activation is independent of schema discovery and stdio lifetime.

## Run a stdio server on the host or executor

`StdioMCP` defaults to `location: 'host'`. For example, construct a host declaration with `new StdioMCP({ name: 'records', tools: ['lookup'], command: 'node', args: ['/application/mcp-server.mjs'], envVars: ['RECORDS_TOKEN'] })`. Import `StdioMCP` from `@openai/agents`. Install the command and script on the controller host, and provide `RECORDS_TOKEN` in that host process's environment. `envVars` lists variable names rather than secret values.

For a remote declaration, set `location: 'environment'` and use the executor's command and script path, such as `args: ['/workspace/mcp-server.mjs']`. Open the Session with its current `Environment`. The executor supplies the selected variable values; the SDK does not forward controller-host secret values. The remote MCP process can start even when `Environment.tools` is empty. Those tools control model-visible executor operations, not MCP startup. Choose a process and executor the application trusts. Session-scoped connections start during opening, before invocation approval can run.

`Environment.writableRoots` and `Environment.network` govern executor command tools. A trusted stdio server runs with the permissions of its process on the selected machine.

## Choose a stdio process lifetime

`StdioMCP` keeps its process alive across root turns when `lifetime` is omitted or set to `'session'`. Set `lifetime: 'turn'` to start a separate process for each root turn and stop it before the next turn starts. Process state does not carry across those turns. Choose this option when a stdio server must ask the application for forms tied to the original root turn. Server prompts from a persistent process without a trusted original turn are refused. Core-generated root MCP tool approvals remain available with either lifetime.

## MCP call policy

- `before` receives the original arguments. Return `{ action: 'allow' }` to keep them, or `{ action: 'replaceArguments', arguments }` to replace them. Editing the supplied view has no effect.
- `approval` receives a separate view of the effective arguments. Return `true` to continue or `false` to deny. The callback can wait for application input.
- Either callback can return `{ action: 'stop' }` to deny the call and stop its owning Turn.

Both callbacks can return a value or Promise. They receive the original context, root or child submission, call metadata, and an AbortSignal. Raw server and tool names remain separate from model-visible names.

`before` has a 30-second deadline. Cancellation or timeout blocks publication and aborts its signal. Close still waits for callbacks that already started.

Application approval is separate from native `approvalMode`. Returning `true` neither answers native approval nor adds tools or Environment permissions. Connections and discovery can precede these callbacks, so a denial can still involve server traffic.

A callback failure denies the call and keeps the private error out of public output. Direct native denial fails that generation. Generated code can catch a local denial.

A stop decision denies the pending effect and stops only its owning Turn. Public settlement waits for native retirement and entered callbacks. A revoked callback cannot stop a successor, and stopping a child leaves its parent and siblings running. The public failure uses fixed text and excludes the optional private `reason`.

Earlier effects remain. `transformResult` runs after the effect. See [the MCP tool observation example](../mcp-observers.ts).

## Update MCP policy while idle

An idle Session can change MCP before and approval policies within its opening server and tool names, including when the Session admitted `NativeAgents`. The update requires no live native descendant runtimes or unreleased native policy callbacks. Root completion alone does not meet these conditions. Later children inherit the acknowledged tools and policies.

If policy publication may have happened before an update fails, the SDK retires the Session instead of restoring its prior authority. Preserve the error and close the Session. See [the MCP policy example](../mcp-policy.ts).

## MCP and executor timeouts

Timeout options use seconds:

| Option | Default | Scope |
| --- | --- | --- |
| MCP `startupTimeout` | `10` | Connection readiness during opening, replacement, or turn-scoped startup. |
| MCP `executionTimeout` | `60` | The selected remote tool call. A timeout does not undo an effect. |
| MCP `transformResultTimeout` | `30` when a transform exists | The result transform, after remote execution. Requires a transform and a value greater than zero, at most `3600`. |
| Environment `policyTimeout` | `30` | Argument/result transforms; greater than zero, at most `3600`. It does not limit an application approval wait. |

MCP startup and execution timeouts must be positive and finite. The MCP `before` callback has its separate 30-second deadline. Application approval can wait for input; cancellation revokes publication, but cleanup still joins entered callbacks. A result-transform timeout occurs after the remote effect and cannot establish that nothing happened.

## Materialize a borrowed SDK MCP namespace

The `selectMcpTools` helper authenticates and discovers one selected application-owned SDK MCP server before a Session opens. Omit `toolNames` until discovery, or provide an exact subset. The helper applies the server's static filter too. Callable classic filters require their real classic Agent and RunContext in `filterContext`; its application context must match `context`.

```ts
import { Agent, NativeProvider, selectMcpTools } from '@openai/agents';
import { MCPServerStreamableHttp } from '@openai/agents/classic';

const context = { tenant: 'example' };
const server = new MCPServerStreamableHttp({
  url: 'http://127.0.0.1:8000/mcp',
});
const provider = new NativeProvider();
try {
  await server.connect(); // The application owns this connection.
  const tools = await selectMcpTools(
    {
      name: 'crm',
      server,
      authenticate: async (captured) => {
        // Perform trusted application authentication for captured.tenant here.
        void captured.tenant;
      },
    },
    { context, toolNames: ['lookup'] },
  );
  const agent = new Agent<typeof context>({
    instructions: 'Use the selected CRM tool.',
    provider,
  });
  const session = await agent.session({ context, tools: [...tools] });
  try {
    await (await session.submit('Look up the record.')).wait();
  } finally {
    await session.close();
  }
} finally {
  try {
    await provider.close();
  } finally {
    await server.close();
  }
}
```

Call the helper again to refresh discovery for a future Session. It invalidates only the selected server's tool cache and returns a new complete snapshot. Existing snapshots keep their schemas and bound methods; the Session's normal exact opening ceiling still limits updates. A failed selection returns no partial catalog. Authentication and cache side effects on the borrowed client cannot be rolled back.

Binding a method does not freeze its receiver's credentials. Before unsafe reauthentication, stop all activity that uses a shared mutable client, or use separate clients for separate authentication scopes. The helper never connects or closes the server. Aborting selection waits for authentication and discovery already in progress and prevents tools from being returned. A server whose `listTools` has no cancellation support may take time to settle.

The bridge preserves raw input schemas and uses the existing managed function callback path. It forwards the per-call abort signal and calls the server once. The bridge preserves structured-content preference and peer error results. It does not add private result metadata to model text. Custom tool metadata resolvers, extractors, error handlers and guardrails are currently unsupported and fail before authentication. Existing classic MCP APIs remain available for those features.

For a [local native profile](./state.md#local-native-profiles), use `selectMcpTools` with an explicit `toolNames` list and your application's approval policy. Pass the returned tools alongside `storage` when you open the Session. When you reopen, select the tools again using the current client, allowlist, and policy. The profile records managed calls and their results. Denial fails the turn before the call reaches the client. A call without a recorded result follows the profile's recovery rules. Your application owns the client, including its credentials and cleanup.

### Await observations on borrowed MCP calls

Configure `onToolStart` and `onToolEnd` in the SDK `MCPServer` options before materializing tools. `selectMcpTools` captures one callback per phase and accepts a separate per-call `approval` callback. Approval must return `true` before start or invocation. Start observes detached arguments; end observes the normalized MCP envelope before projection or serialization. Returned values never replace arguments or results.

Callbacks must settle or cooperate with their signal. Joined cleanup can remain pending for an uncooperative callback; cancellation fences later dispatch/output after the callback settles. End failure cannot undo a completed effect and does not replay the call. Core-owned `HttpMCP`/`StdioMCP` policies and passive events retain their existing timing. See the [complete observer example](../mcp-observers.ts).

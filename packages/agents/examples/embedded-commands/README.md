# Discover and run embedded commands

Use the command catalog when your application needs to offer native operations. Reading it does not open a Session, acquire a provider or initialize a model:

```ts
import { embeddedCommands } from '@openai/agents';

for (const command of await embeddedCommands()) {
  console.log(
    command.name,
    command.description,
    command.supportsInlineArguments,
  );
}
```

The catalog keeps native order: `review`, `rename`, `compact`, `stop`. It excludes terminal UI commands and aliases such as `clean`. It describes supported forms, not what a particular Session can execute now. Native and Session checks still decide admission.

Pass a command to your existing Session. [The helper](../embedded-commands.ts) waits for compaction or review to finish, then returns its receipt and result. It assumes your application has already configured a Session; see [the basic example](../basic.ts) for Agent and provider setup:

```ts
import { runEmbeddedCommand } from '../embedded-commands';

const renamed = await runEmbeddedCommand(session, 'rename API migration');
const review = await runEmbeddedCommand(
  session,
  'review Check the current changes for incorrect error handling.',
);
if (review.receipt.command === 'review') {
  console.log(review.completed?.finalOutput);
}
```

Your application creates and closes `session` and its provider. Configure the same Environment, tools and permissions you want native review to use; this example grants none. Importing the example does not execute a command. Native review uses a NativeProvider-backed Session; a selected Model carrier cannot authorize its separate review agent.

| Form | Native behavior and receipt |
| --- | --- |
| `compact` | Starts native compaction on a settled Session. The receipt carries its original Turn; wait on that Turn for completion. Existing `Session.compact()` still waits for compaction directly. |
| `stop` | Enqueues cleanup of the Session's background terminals. The receipt carries the native operation ID. Acceptance does not mean every process has exited, and does not interrupt the foreground Turn. Use `Session.interrupt()` when you intend interruption. |
| `rename NAME` | Awaits the native thread-name update and returns the actual Session ID and normalized name. It leaves conversation history intact and can run during a Turn. |
| `review CUSTOM INSTRUCTIONS` | Starts native review on a settled Session. Its Turn yields Core's structured review output, including an explicit null when Core provides no report. It does not parse or repair that report as your Agent's application output. |

One leading slash is optional. `rename` and `review` require nonempty arguments; `compact` and `stop` accept none. Unsupported commands and aliases fail before native dispatch. Native refusals and model errors propagate to the caller.

For cancellation-sensitive work, call `executeCommand` directly so your application retains the Turn before waiting:

```ts
const receipt = await session.executeCommand('review Check error handling.');
if (receipt.command === 'review') {
  const turn = receipt.turn;
  // Retain turn in your application so its cancellation action can call turn.cancel().
  const result = await turn.wait();
  console.log(result.finalOutput);
}
```

Observe review through its returned Turn. `Session.wait()` and implicit steering keep the Agent's output type, so they refuse review's different result contract. A later ordinary submission restores their usual behavior.

The Turn controls belong to that original operation, and its wait retains the existing callback and cleanup behavior. An observer stopping its wait does not transfer ownership or authorize a new operation.

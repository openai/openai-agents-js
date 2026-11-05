# Discover and run embedded commands

Read the command catalog to discover supported forms, then execute a selected command on an application-owned Session.

## Read the catalog

Catalog access does not open a Session, acquire a provider, or initialize a model:

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

## Choose a command

| Form | Native behavior and receipt |
| --- | --- |
| `compact` | Starts native compaction on a settled Session. The receipt carries its original Turn; wait on that Turn for completion. Existing `Session.compact()` still waits for compaction directly. |
| `stop` | Enqueues cleanup of the Session's background terminals. The receipt carries the native operation ID. Acceptance does not mean every process has exited, and does not interrupt the foreground Turn. Use `Session.interrupt()` when you intend interruption. |
| `rename NAME` | Awaits the native thread-name update and returns the actual Session ID and normalized name. It leaves conversation history intact and can run during a Turn. |
| `review CUSTOM INSTRUCTIONS` | Starts native review on a settled Session. Its Turn yields Core's structured review output, including an explicit null when Core provides no report. It does not parse or repair that report as your Agent's application output. |

## Run a command on your Session

Copy [embedded-commands.ts](../embedded-commands.ts) beside the application file that will run commands. Compile both in the same TypeScript project so they use the same SDK types. The helper waits for compaction or review, then returns the receipt and result.

Pass an open Session to the helper. For Agent and provider setup, see [the basic example](../basic.ts).

```ts
import { runEmbeddedCommand } from './embedded-commands.js';

const renamed = await runEmbeddedCommand(session, 'rename API migration');
const review = await runEmbeddedCommand(
  session,
  'review Check the current changes for incorrect error handling.',
);
if (review.receipt.command === 'review') {
  console.log(review.completed?.finalOutput);
}
```

Your application creates and closes `session` and its provider. Configure the Environment, tools, and permissions you want native review to use. This example grants none. Importing the example does not execute a command. Native review uses a NativeProvider-backed Session; a selected Model carrier cannot authorize its separate review agent.

One leading slash is optional. `rename` and `review` require nonempty arguments. `compact` and `stop` accept none. Unsupported commands and aliases fail before native dispatch. Native refusals and model errors propagate to the caller.

## Keep the Turn for cancellation

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

The Turn controls belong to the original operation. Waiting on the Turn retains the existing callback and cleanup behavior. An observer stopping its wait does not transfer ownership or authorize a new operation.

# Memory examples

These examples keep conversation history between agent turns. Choose a session store, or try tool approvals and history compaction with that store.

Use Node.js 24. From the repository root, install the workspace dependencies and run `pnpm build`. Set `OPENAI_API_KEY` and start the in-memory example.

```bash
pnpm -F memory start:memory
```

When prompted, enter `y` to stream the response or `n` to wait for the complete response. The agent calls local tools and answers two related questions using the same session. The profile tool simulates one temporary failure so the agent can retry it.

## Choose an example

Run these commands from the repository root. Each example makes live model requests.

| Command | What it demonstrates |
| --- | --- |
| `pnpm -F memory start:memory` | Keeps two turns in a `MemorySession`. History lasts for the current process. |
| `pnpm -F memory start:memory-hitl` | Asks for approval before looking up a customer profile. Stores history in memory. Submit an empty message to exit. |
| `pnpm -F memory start:file` | Stores two turns, including image tool output, as JSON in `examples/memory/tmp/`. |
| `pnpm -F memory start:file-hitl` | Combines profile approvals with a file session in `examples/memory/tmp/`. Submit an empty message to exit. |
| `pnpm -F memory start:oai` | Stores two turns in an OpenAI Conversations session. |
| `pnpm -F memory start:oai-hitl` | Combines profile approvals with an OpenAI Conversations session. Submit an empty message to exit. |
| `pnpm -F memory start:oai-compact` | Streams five turns, compacts their history through `responses.compact`, and stores the result in `examples/memory/.agents-sessions/`. |
| `pnpm -F memory start:oai-compact-stateless` | Runs five turns with `store: false`, keeps history in memory, and sends that history to `responses.compact`. |
| `pnpm -F memory start:hitl-session-scenario` | Checks approval, rejection, and restoring file and OpenAI Conversations sessions. Prints the stored history and removes the sessions it creates. |
| `pnpm -F memory start:prisma` | Prepares a SQLite database, generates the Prisma client, and stores two turns in the database. Choose streaming or complete responses at the prompt. |

## Find the saved history

The file examples create a new session each time you start them and leave its JSON file on disk. The OpenAI Conversations examples keep their server-side conversations.

The approval scenario deletes its new conversation unless you set `KEEP_OPENAI_SESSION`. Set `OPENAI_SESSION_ID` to reuse and preserve an existing conversation.

The Prisma command uses `file:./dev.db` by default, relative to `examples/memory/prisma/`. Set `DATABASE_URL` to choose another SQLite file. The startup command runs `prisma db push` and `prisma generate` before starting the agent.

## Automate an approval example

Set `EXAMPLES_INTERACTIVE_MODE=auto` and `AUTO_APPROVE_HITL=1` to run one message with automatic approval in `start:memory-hitl`, `start:file-hitl`, or `start:oai-hitl`. Leave these variables unset to approve each profile lookup yourself.

## Runtime requirements

The direct Node.js commands also support Node.js 22.18 or later within the 22.x line, and Node.js 26 or later. The Prisma launcher uses `tsx`.

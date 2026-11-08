import { Agent, HttpMCP } from '@openai/agents';

// A prompt-only server grants no model-visible tools and connects on first access.
const prompts = new HttpMCP({
  name: 'documents',
  url: 'http://127.0.0.1:8000/mcp',
  tools: [],
});
const agent = new Agent({ instructions: 'Answer the user.', tools: [prompts] });
await using session = await agent.session();

// Core returns the complete ordered inventory or rejects without partial data.
// Its shared catalog bounds are 100 pages, 2,048 items, and 64 KiB per cursor.
// The configured execution timeout bounds collection, excluding activation/cleanup.
console.log(await session.listMcpPrompts('documents'));

// Arguments are optional string values. Omitted arguments and {} remain distinct.
const result = await session.getMcpPrompt('documents', 'review', {
  topic: 'changes',
});
console.log(result.messages); // Rich content and metadata remain caller-owned data.

// These calls require an idle Session and a currently selected ordinary server.
// Session-lifetime stdio also works. Idle turn-lifetime stdio is unavailable.
// Missing prompts capability returns [] for listing and rejects get.
// The SDK never inserts prompt messages into instructions, history, or model context.
// close() cancels and joins pending work; abandoning a Promise does not cancel it.

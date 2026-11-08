import { Agent, HttpMCP } from '@openai/agents';

// A resource-only server selects no model-visible tools.
const resources = new HttpMCP({
  name: 'documents',
  url: 'http://127.0.0.1:8000/mcp',
  tools: [],
});
const agent = new Agent({
  instructions: 'Answer the user.',
  tools: [resources],
});
await using session = await agent.session();

// These operations require an idle Session and a currently selected ordinary server.
// The first call activates this server without granting tools.
// Session-lifetime stdio also works. Turn-lifetime stdio has no idle connection.
const page = await session.listMcpResources('documents');
console.log(page.resources);
if (page.nextCursor !== undefined) {
  // Each call reads one page. The application chooses whether to continue.
  console.log(await session.listMcpResources('documents', page.nextCursor));
}
console.log(await session.listMcpResourceTemplates('documents'));
if (page.resources[0]) {
  const result = await session.readMcpResource(
    'documents',
    page.resources[0].uri,
  );
  console.log(result.contents); // Text, base64 blobs and metadata remain transport data.
}
// Missing resources capability returns empty resource/template lists.
// The SDK never adds resource contents to instructions or model context.
// NativeError preserves server errors. The Session cancels idle elicitation.

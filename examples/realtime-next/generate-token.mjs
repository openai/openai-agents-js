import { fileURLToPath } from 'node:url';

export async function generateToken() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable.');
  }

  const response = await fetch(
    'https://api.openai.com/v1/realtime/client_secrets',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: 'gpt-realtime-2.1',
          tools: [
            {
              type: 'mcp',
              server_label: 'deepwiki',
              server_url: 'https://mcp.deepwiki.com/mcp',
              require_approval: 'always',
            },
            {
              type: 'mcp',
              server_label: 'dnd',
              server_url: 'https://dmcp-server.deno.dev/mcp',
              require_approval: 'always',
            },
          ],
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to create ephemeral client secret: ${response.status} ${response.statusText}`,
    );
  }

  const clientSecret = await response.json();
  if (typeof clientSecret.value !== 'string' || !clientSecret.value) {
    throw new Error('OpenAI did not return an ephemeral client secret.');
  }
  return clientSecret.value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateToken()
    .then(console.log)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

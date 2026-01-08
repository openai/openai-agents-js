// examples/realtime-usage/dev-server.js
// Simple dev server to serve the examples and optionally return a mock ephemeral key.
// Usage: node dev-server.js

import express from 'express';
import path from 'path';

const app = express();
const port = process.env.PORT || 5173;
const root = path.resolve(process.cwd());

app.use(express.static(root));

// A mock ephemeral key endpoint. Replace with a real server-side call to create ephemeral keys.
app.get('/session-ephemeral-key', (req, res) => {
  // If an OPENAI_API_KEY is configured in the environment, proxy a request
  // to the OpenAI Realtime `client_secrets` endpoint and return the
  // ephemeral client secret value. Otherwise return a mock placeholder.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.type('text/plain');
    res.send('MOCK_EPHEMERAL_KEY');
    return;
  }

  // Create an ephemeral client secret via OpenAI Realtime API.
  (async () => {
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        res.status(500).send(`Failed to create ephemeral key: ${response.status} ${text}`);
        return;
      }

      const json = await response.json();
      if (!json?.value) {
        res.status(500).send('Unexpected response from OpenAI when creating ephemeral key');
        return;
      }

      res.type('text/plain');
      res.send(json.value);
    } catch (err) {
      console.error('Error creating ephemeral key', err);
      res.status(500).send('Error creating ephemeral key');
    }
  })();
});

app.listen(port, () => {
  console.log(`Dev server listening at http://localhost:${port}`);
  console.log('Serving repository root so examples are available under /examples/...');
});

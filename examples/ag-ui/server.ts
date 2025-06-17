import { createServer } from 'http';
import { z } from 'zod';
import { Agent, tool } from '@openai/agents';
import { agui } from '@openai/agents-extensions';

// Example tools
const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return `The weather in ${input.city} is sunny and 72°F`;
  },
});

const timeTool = tool({
  name: 'get_time',
  description: 'Get the current time',
  parameters: z.object({}),
  execute: async () => {
    return new Date().toISOString();
  },
});

// Create agents
const weatherAgent = new Agent({
  name: 'Weather Assistant',
  instructions: 'You are a weather assistant.',
  tools: [weatherTool],
});

const timeAgent = new Agent({
  name: 'Time Assistant',
  instructions: 'You are a time assistant.',
  tools: [timeTool],
});

// Multi-agent with handoffs
const mainAgent = Agent.create({
  name: 'Main Assistant',
  instructions:
    'You are a helpful assistant. Use handoffs for specialized tasks.',
  handoffs: [weatherAgent, timeAgent],
});

// HTTP Server that streams AG-UI events
const server = createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    // Parse request body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body);

        // Set SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Run agent with AG-UI streaming
        const result = await agui.runWithAGUI(mainAgent, message, {
          stream: true,
          agui: {
            thread_id: `thread-${Date.now()}`,
            run_id: `run-${Date.now()}`,
            includeRawEvents: true,
            includeStateSnapshots: true,
          },
        });

        // Stream AG-UI events as SSE
        for await (const event of result.toAGUIAsyncIterator()) {
          const data = JSON.stringify(event);
          res.write(`data: ${data}\n\n`);
        }

        // Wait for completion and close
        await result.completed;
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        console.error('Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/') {
    // Serve a simple HTML client
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
    <title>AG-UI Demo</title>
    <style>
        body { font-family: monospace; padding: 20px; }
        #messages { border: 1px solid #ccc; height: 400px; overflow-y: scroll; padding: 10px; margin: 10px 0; }
        .event { margin: 5px 0; padding: 5px; border-left: 3px solid #007acc; background: #f9f9f9; }
        .event-type { font-weight: bold; color: #007acc; }
        input[type="text"] { width: 60%; padding: 5px; }
        button { padding: 5px 10px; }
    </style>
</head>
<body>
    <h1>🌟 AG-UI Demo Server</h1>
    <div>
        <input type="text" id="messageInput" placeholder="Ask me something..." />
        <button onclick="sendMessage()">Send</button>
    </div>
    <div id="messages"></div>

    <script>
        function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            if (!message) return;

            const messagesDiv = document.getElementById('messages');
            messagesDiv.innerHTML += '<div class="event"><strong>User:</strong> ' + message + '</div>';
            input.value = '';

            fetch('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            }).then(response => {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                function readStream() {
                    reader.read().then(({ done, value }) => {
                        if (done) return;

                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\\n');

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') return;

                                try {
                                    const event = JSON.parse(data);
                                    messagesDiv.innerHTML += 
                                        '<div class="event">' +
                                        '<span class="event-type">' + event.type + ':</span> ' +
                                        '<pre>' + JSON.stringify(event, null, 2) + '</pre>' +
                                        '</div>';
                                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                                } catch (e) {
                                    console.error('Parse error:', e);
                                }
                            }
                        }

                        readStream();
                    });
                }

                readStream();
            });
        }

        document.getElementById('messageInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
    </script>
</body>
</html>
    `);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`AG-UI Demo Server running at http://localhost:${PORT}`);
  console.log('');
  console.log('Try these endpoints:');
  console.log(`  • http://localhost:${PORT}/ - Interactive demo`);
  console.log(`  • POST http://localhost:${PORT}/chat - Send messages`);
  console.log('');
  console.log(
    'The server streams AG-UI compatible events for real-time agent interactions!',
  );
});

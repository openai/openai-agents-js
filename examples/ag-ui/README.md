# AG-UI Protocol Example

A production-ready example demonstrating AG-UI protocol integration with OpenAI Agents JS SDK.

## Features

- ✅ **Full AG-UI Compliance** - Implements all 16+ event types
- 🔄 **Real-time Streaming** - Server-Sent Events with proper error handling
- 🏗️ **Clean Architecture** - Separated concerns and proper TypeScript interfaces
- 🎯 **Multi-Agent Support** - Weather and time agents with handoffs
- 🎨 **Professional UI** - Modern, responsive web interface
- 🛡️ **Error Handling** - Comprehensive validation and error recovery

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm run dev

# Open browser
open http://localhost:3001
```

## Architecture

### Core Files

- **`server-clean.ts`** - Main HTTP server with routing
- **`handlers.ts`** - Request handlers with proper error handling
- **`agents.ts`** - Agent definitions and tool implementations
- **`client.html`** - Professional web interface
- **`types.ts`** - TypeScript interfaces for API contracts

### API Endpoints

- **`GET /`** - Serves the interactive client
- **`POST /chat`** - Accepts chat messages and streams AG-UI events
- **`OPTIONS /*`** - CORS preflight handling

## AG-UI Events

The example demonstrates all AG-UI protocol events:

```typescript
// Lifecycle Events
RUN_STARTED, RUN_FINISHED, RUN_ERROR

// Agent Flow
STEP_STARTED, STEP_FINISHED

// Messages
TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END

// Tools
TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, TOOL_MESSAGE

// State Management
STATE_SNAPSHOT, STATE_DELTA (with JSON Patch)

// Raw Events
RAW, CUSTOM
```

## Usage Examples

### Basic Chat

```bash
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the weather in Tokyo?"}'
```

### Multi-Agent Handoffs

Try these messages to see agent handoffs:

- "What's the weather in Paris?" → Weather Agent
- "What time is it?" → Time Agent
- "Tell me about both weather and time" → Multiple handoffs

## Code Examples

### Basic AG-UI Streaming

```typescript
import { Agent, agui } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are helpful.',
});

// Run with AG-UI compatibility
const result = await agui.runWithAGUI(agent, 'Hello!', {
  stream: true,
  agui: {
    runId: 'my-run',
    includeRawEvents: true,
    includeStateSnapshots: true,
  },
});

// Consume AG-UI events
for await (const event of result.toAGUIAsyncIterator()) {
  console.log(event.type, event);
}
```

### HTTP SSE Endpoint

```typescript
import { agui } from '@openai/agents';

// In your HTTP handler
const result = await agui.runWithAGUI(agent, message, {
  stream: true,
  agui: { runId: `run-${Date.now()}` },
});

// Stream as Server-Sent Events
for await (const event of result.toAGUIAsyncIterator()) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
```

## Integration with Frontend

This implementation is compatible with:

- **CopilotKit**: React components for AG-UI
- **Custom WebSocket/SSE clients**
- **Any AG-UI compatible frontend framework**

The events follow the standard AG-UI protocol, ensuring interoperability across different agent frameworks and UI libraries.

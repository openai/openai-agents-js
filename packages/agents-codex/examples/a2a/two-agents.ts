import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { Agent, TraceContext, tool, type ToolContext } from '@openai/agents';
import { connectA2A, NativeA2AExecutor } from '@openai/agents/a2a';
import { withScriptedResponses, text, toolCall } from '@openai/agents/testing';
import { AgentCard, Message, Part, Role, TaskState } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import { ExampleA2AStore } from './store';

async function serve(agent: Agent) {
  const store = new ExampleA2AStore();
  const executor = new NativeA2AExecutor({
    store,
    agentFactory: async (_binding, callContext) => {
      const headers = callContext.state.get('headers') as Record<
        string,
        string | string[] | undefined
      >;
      const traceparent = headers.traceparent;
      const tracestate = headers.tracestate;
      const parentTrace =
        typeof traceparent === 'string'
          ? new TraceContext({
              traceparent,
              ...(typeof tracestate === 'string' ? { tracestate } : {}),
            })
          : undefined;
      return { agent, context: undefined, parentTrace };
    },
  });
  const server = createServer(async (request, response) => {
    if (request.url === '/card') {
      response.end(JSON.stringify(AgentCard.toJSON(card)));
      return;
    }
    // Synthetic loopback-only authentication. The application owns real authentication.
    if (request.headers.authorization !== 'Bearer local-example') {
      response.writeHead(401);
      response.end();
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 1_000_000) {
        response.writeHead(413);
        response.end();
        return;
      }
    }
    const context = new ServerCallContext({
      requestedVersion: '1.0',
      user: { isAuthenticated: true, userName: 'example' },
      state: new Map([['headers', request.headers]]),
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(await rpc.handle(body, context)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`;
  const endpoint = {
    name: agent.name ?? 'remote',
    cardUrl: `${base}/card`,
    rpcUrl: `${base}/rpc`,
  };
  const card = AgentCard.fromJSON({
    name: endpoint.name,
    version: '1',
    supportedInterfaces: [
      {
        url: endpoint.rpcUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
  });
  const rpc = new JsonRpcTransportHandler(
    new DefaultRequestHandler(card, store, executor),
  );
  return {
    endpoint,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** No API key is needed: three native agents use deterministic local model responses. */
export async function runA2AExample(): Promise<string> {
  return withScriptedResponses([[text('alpha result')]], (alphaModel) =>
    withScriptedResponses([[text('beta result')]], (betaModel) =>
      withScriptedResponses(
        [
          [toolCall('ask_alpha', {}, { callId: 'alpha-invocation' })],
          [toolCall('ask_beta', {}, { callId: 'beta-invocation' })],
          [text('Both remote agents replied.')],
        ],
        async (coordinatorModel) => {
          const targets = await Promise.all([
            serve(
              new Agent({
                name: 'alpha',
                instructions: 'Answer.',
                model: 'gpt-5.5',
                provider: alphaModel.provider,
              }),
            ),
            serve(
              new Agent({
                name: 'beta',
                instructions: 'Answer.',
                model: 'gpt-5.5',
                provider: betaModel.provider,
              }),
            ),
          ]);
          try {
            // This host-owned catalog stays outside model input. Only two selected tools are exposed.
            const registry = new Map(
              Array.from({ length: 500 }, (_, index) => [
                `agent_${index}`,
                targets[index % 2].endpoint,
              ]),
            );
            const selected = [
              registry.get('agent_0')!,
              registry.get('agent_1')!,
            ];
            const tools = selected.map((endpoint) =>
              tool({
                name: `ask_${endpoint.name}`,
                description: `Ask ${endpoint.name} for its result.`,
                parameters: z.strictObject({}),
                execute: async (_arguments, context: ToolContext) => {
                  const client = await connectA2A(endpoint, {
                    authorization: async () => 'local-example',
                    signal: context.signal,
                    parentTrace: context.traceContext,
                  });
                  let result = await client.sendMessage({
                    tenant: '',
                    metadata: undefined,
                    configuration: undefined,
                    message: {
                      ...Message.fromJSON({}),
                      messageId: context.callId,
                      role: Role.ROLE_USER,
                      parts: [Part.fromJSON({ text: 'Return your result.' })],
                    },
                  });
                  if (!('id' in result))
                    throw new Error('Expected a remote task');
                  const deadline = Date.now() + 10_000;
                  while (
                    result.status?.state === TaskState.TASK_STATE_WORKING &&
                    Date.now() < deadline
                  ) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    result = await client.getTask({
                      tenant: '',
                      id: result.id,
                    });
                  }
                  const value = result.artifacts[0]?.parts[0]?.content;
                  if (
                    result.status?.state !== TaskState.TASK_STATE_COMPLETED ||
                    value?.$case !== 'text'
                  )
                    throw new Error('Remote task did not complete');
                  return value.value;
                },
              }),
            );
            const coordinator = new Agent({
              instructions: 'Ask the two selected agents.',
              model: 'gpt-5.5',
              provider: coordinatorModel.provider,
              tools,
            });
            const result = await coordinator.run('Ask alpha and beta.');
            alphaModel.assertExhausted();
            betaModel.assertExhausted();
            coordinatorModel.assertExhausted();
            return result.finalOutput;
          } finally {
            await Promise.all(targets.map((target) => target.close()));
          }
        },
      ),
    ),
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  runA2AExample().then(console.log, () => {
    console.error('The remote agent example could not complete.');
    process.exitCode = 1;
  });
}

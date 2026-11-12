import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentCard, Message, Part, Role, TaskState } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import { Agent, TraceContext, telemetry, tool } from '../../src/index';
import { connectA2A, NativeA2AExecutor } from '../../src/a2a';
import { text, toolCall, withScriptedResponses } from '../../src/testing';
import { runA2AExample } from '../../../../examples/codex/a2a/two-agents';
import { ExampleA2AStore } from '../../../../examples/codex/a2a/store';

const PROMPT = 'PRIVATE_A2A_PROMPT_CANARY';
const ARGUMENT = 'PRIVATE_A2A_ARGUMENT_CANARY';
const RESULT = 'PRIVATE_A2A_RESULT_CANARY';
const CREDENTIAL = 'PRIVATE_A2A_CREDENTIAL_CANARY';

async function configurePrivate(endpoint: string, service: string) {
  await telemetry.configure({
    traces: { kind: 'otlp-http', endpoint, protocol: 'json' },
    logUserPrompt: false,
    logAgentResponses: false,
    toolResultMaxBytes: 0,
    spanAttributes: {
      'business.service': service,
      'business.specialist': 'approved-specialist',
    },
  });
}

async function receiver(endpoint: string) {
  await configurePrivate(endpoint, 'specialist');
  const receipt: Record<string, unknown> = { pid: process.pid };
  await withScriptedResponses(
    [
      [
        toolCall(
          'private_probe',
          { argument: ARGUMENT },
          { callId: 'remote-private-call' },
        ),
      ],
      [text(RESULT)],
    ],
    async (peer) => {
      const probe = tool({
        name: 'private_probe',
        parameters: z.strictObject({ argument: z.string() }),
        execute: async ({ argument }, context) => {
          assert.equal(argument, ARGUMENT);
          receipt.remoteTurn = context.turnId;
          await telemetry.withSpan(
            { name: 'receiver.policy', includeSensitiveData: false },
            async () => {
              await telemetry.withSpan(
                { name: 'receiver.child', includeSensitiveData: true },
                async (child) => {
                  receipt.childSensitive = child.context.includeSensitiveData;
                },
              );
            },
          );
          return RESULT;
        },
      });
      const agent = new Agent({
        instructions: 'Synthetic specialist',
        tools: [probe],
        provider: peer.provider,
      });
      const store = new ExampleA2AStore();
      const executor = new NativeA2AExecutor({
        store,
        agentFactory: async (binding, context) => {
          const carrier = context.state.get('parentTrace') as {
            traceparent: string;
            tracestate?: string;
          };
          receipt.received = carrier;
          receipt.principal = binding.principal;
          receipt.taskId = binding.taskId;
          return {
            agent,
            context: undefined,
            parentTrace: new TraceContext(carrier),
          };
        },
      });
      const server = createServer(async (request, response) => {
        if (request.url === '/card') {
          response.end(JSON.stringify(AgentCard.toJSON(card)));
          return;
        }
        if (request.headers.authorization !== `Bearer ${CREDENTIAL}`) {
          response.writeHead(401).end();
          return;
        }
        const carrier = {
          traceparent: String(request.headers.traceparent),
          ...(typeof request.headers.tracestate === 'string'
            ? { tracestate: request.headers.tracestate }
            : {}),
        };
        receipt.privateHeaderAbsent = request.headers.baggage === undefined;
        const context = new ServerCallContext({
          requestedVersion: '1.0',
          user: { isAuthenticated: true, userName: 'synthetic-principal' },
          state: new Map([['parentTrace', carrier]]),
        });
        let body = '';
        for await (const chunk of request) body += chunk;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(await rpc.handle(body, context)));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const target = {
        name: 'approved-specialist',
        cardUrl: `${base}/card`,
        rpcUrl: `${base}/rpc`,
      };
      const card = AgentCard.fromJSON({
        name: target.name,
        version: '1',
        supportedInterfaces: [
          {
            url: target.rpcUrl,
            protocolBinding: 'JSONRPC',
            protocolVersion: '1.0',
          },
        ],
      });
      const rpc = new JsonRpcTransportHandler(
        new DefaultRequestHandler(card, store, executor),
      );
      process.send!({ endpoint: target });
      try {
        await once(process, 'message');
        if (receipt.taskId) peer.assertExhausted();
        const task = await store.load(
          String(receipt.taskId),
          new ServerCallContext({
            user: { isAuthenticated: true, userName: 'synthetic-principal' },
            requestedVersion: '1.0',
          }),
        );
        receipt.privateApplicationState =
          !!task && JSON.stringify(task).includes(RESULT);
        receipt.flush = (await telemetry.forceFlush()).status;
        await telemetry.shutdown();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  process.send!({ receipt }, () => process.disconnect!());
}

async function privacyRoot(endpoint: string) {
  await configurePrivate(endpoint, 'coordinator');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), endpoint, 'receiver'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let errors = '';
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk);
  });
  const closed = once(child, 'close');
  const [ready] = (await once(child, 'message')) as [
    { endpoint: Parameters<typeof connectA2A>[0] },
  ];
  const registry = new Map([['approved-specialist', ready.endpoint]]);
  const receipt: Record<string, unknown> = { pid: process.pid };
  const remoteReceipt = Promise.race([
    once(child, 'message'),
    closed.then(() => {
      throw new Error('Receiver exited without receipt: ' + errors);
    }),
  ]);
  void remoteReceipt.catch(() => {});
  try {
    await withScriptedResponses(
      [
        [
          toolCall(
            'outgoing',
            { argument: ARGUMENT },
            { callId: 'outbound-private-call' },
          ),
        ],
        [text('public coordinator answer')],
      ],
      async (peer) => {
        const outgoing = tool({
          name: 'outgoing',
          parameters: z.strictObject({ argument: z.string() }),
          execute: async ({ argument }, context) => {
            assert.equal(argument, ARGUMENT);
            assert(context.traceContext);
            receipt.outgoing = context.traceContext.toHeaders();
            await telemetry.withSpan(
              { name: 'coordinator.child', includeSensitiveData: true },
              async (span) => {
                receipt.childSensitive = span.context.includeSensitiveData;
              },
            );
            const client = await connectA2A(
              registry.get('approved-specialist')!,
              {
                authorization: async () => CREDENTIAL,
                parentTrace: context.traceContext,
              },
            );
            let task = await client.sendMessage({
              tenant: '',
              metadata: undefined,
              configuration: undefined,
              message: {
                ...Message.fromJSON({}),
                messageId: 'private-invocation',
                role: Role.ROLE_USER,
                parts: [Part.fromJSON({ text: PROMPT })],
              },
            });
            assert('id' in task);
            const deadline = Date.now() + 10_000;
            while (
              task.status?.state === TaskState.TASK_STATE_WORKING &&
              Date.now() < deadline
            )
              task = await client.getTask({ tenant: '', id: task.id });
            assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
            assert.equal(task.artifacts[0].parts[0].content?.value, RESULT);
            return RESULT;
          },
        });
        const agent = new Agent({
          instructions: 'Synthetic coordinator',
          tools: [outgoing],
          provider: peer.provider,
        });
        await telemetry.withTrace(
          {
            name: 'private A2A workflow',
            includeSensitiveData: false,
            metadata: { 'business.route': 'standard' },
          },
          async () => {
            assert.equal(
              (await agent.run(PROMPT)).finalOutput,
              'public coordinator answer',
            );
          },
        );
        peer.assertExhausted();
      },
    );
  } finally {
    receipt.flush = (await telemetry.forceFlush()).status;
    await telemetry.shutdown();
    child.send('stop');
    const [message] = (await remoteReceipt) as [
      { receipt: Record<string, unknown> },
    ];
    receipt.receiver = message.receipt;
    const [code] = await closed;
    assert.equal(code, 0, errors);
  }
  console.log(JSON.stringify(receipt));
}

async function main() {
  if (process.argv[3] === 'receiver') return receiver(process.argv[2]!);
  if (process.argv[3] === 'privacy') return privacyRoot(process.argv[2]!);
  await telemetry.configure({
    traces: { kind: 'otlp-http', endpoint: process.argv[2]!, protocol: 'json' },
  });
  try {
    console.log(JSON.stringify({ result: await runA2AExample() }));
  } finally {
    await telemetry.shutdown();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

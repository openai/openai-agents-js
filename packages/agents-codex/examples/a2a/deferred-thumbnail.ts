/** Restart the coordinator while one local A2A peer retains a manual request. */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { z } from 'zod';
import {
  Agent,
  manualTool,
  NativeProvider,
  parseSessionState,
  tool,
  type Session,
} from '@openai/agents';
import {
  A2AJobProvider,
  NativeA2AExecutor,
  type A2AEndpoint,
  type A2AInputReply,
} from '@openai/agents/a2a';
import {
  DeferredTools,
  type AdvanceOutcome,
  type JobUpdate,
} from '@openai/agents/experimental/deferred';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { AgentCard, Part, Task } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import { ExampleA2AStore } from './store';
import { Journal } from '../external-job-journal';
import { ThumbnailStore } from '../external-job-store';
import { publicSize, render } from '../external-job';
import {
  ModelServer,
  call,
  message,
} from '../../test/native/fixtures/model-server';

const token = 'local-thumbnail-example';
const order = 'thumbnail-01';
const tenant = 'local-studio';
const resultSchema = z.strictObject({ byteCount: z.number().int().positive() });
const challengeSchema = z.object({
  challenge: z.string().min(1),
  generation: z.number().int().positive(),
  tool: z.literal('approve_render'),
  arguments: z.strictObject({}),
});

function endpoint(base: string): A2AEndpoint {
  const url = new URL(base);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/'
  )
    throw new Error('Use the loopback origin printed by this example peer.');
  return {
    name: 'thumbnail',
    cardUrl: `${url.origin}/card`,
    rpcUrl: `${url.origin}/rpc`,
  };
}

async function serve(hold = false): Promise<void> {
  const script = [
    [toolCall('approve_render', {}, { callId: 'remote-decision' })],
    [toolCall('record_render', {}, { callId: 'remote-effect' })],
    [text('{"byteCount":3085}')],
  ];
  await withScriptedResponses(
    hold ? script.slice(0, 1) : script,
    async (model) => {
      let effects = 0;
      const stats = { creates: 0, replies: 0, taskId: '', contextId: '' };
      const approval = manualTool({
        name: 'approve_render',
        description:
          'Ask the authorized coordinator to approve this synthetic render.',
        parameters: z.strictObject({}),
        result: z.boolean(),
      });
      const agent = new Agent({
        instructions:
          'Ask for approval, record the approved render, then return its byte count.',
        provider: model.provider,
        tools: [
          approval,
          tool({
            name: 'record_render',
            parameters: z.strictObject({}),
            execute: () => {
              // The fixture verifies the native manual result before recording its synthetic effect.
              if (model.toolOutput('remote-decision') !== 'true')
                throw new Error('No accepted approval.');
              effects++;
              return { byteCount: 3085 };
            },
          }),
        ],
        outputType: resultSchema,
      });
      const store = new ExampleA2AStore();
      const executor = new NativeA2AExecutor({
        store,
        agentFactory: async (binding) => {
          stats.taskId = binding.taskId;
          stats.contextId = binding.contextId;
          return { agent, context: undefined };
        },
      });
      const handlers = new Set<Promise<void>>();
      const server = createServer((request, response) => {
        const pending = (async () => {
          if (request.url === '/card') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(AgentCard.toJSON(card)));
            return;
          }
          if (request.headers.authorization !== `Bearer ${token}`) {
            response.writeHead(401).end();
            return;
          }
          if (request.url === '/stats') {
            response.end(JSON.stringify({ ...stats, effects }));
            return;
          }
          if (request.url !== '/rpc' || request.method !== 'POST') {
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 1_000_000) {
              response.writeHead(413).end();
              return;
            }
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString('utf8');
          const rpcRequest = JSON.parse(body);
          if (rpcRequest.method === 'SendMessage') {
            if (rpcRequest.params.message.taskId) stats.replies++;
            else stats.creates++;
          }
          const context = new ServerCallContext({
            requestedVersion: '1.0',
            user: { isAuthenticated: true, userName: 'example-coordinator' },
          });
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(await rpc.handle(body, context)));
        })().catch(() => {
          response.writeHead(500).end();
        });
        handlers.add(pending);
        void pending.finally(() => handlers.delete(pending));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing listener.');
      const base = `http://127.0.0.1:${address.port}`;
      const card = AgentCard.fromJSON({
        name: 'thumbnail',
        version: '1',
        supportedInterfaces: [
          {
            url: `${base}/rpc`,
            protocolVersion: '1.0',
            protocolBinding: 'JSONRPC',
          },
        ],
      });
      const rpc = new JsonRpcTransportHandler(
        new DefaultRequestHandler(card, store, executor),
      );
      console.log(`A2A peer: ${base}`);
      const stopped = Promise.withResolvers<void>();
      const stop = () => stopped.resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await stopped.promise;
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections();
        await Promise.allSettled(handlers);
        server.closeAllConnections();
        await closed;
      }
    },
  );
}

function update(journal: Journal): JobUpdate | undefined {
  return journal.store.transaction((db) => {
    const row = db
      .prepare(
        'SELECT receipt_update FROM orders WHERE tenant=? AND order_id=?',
      )
      .get(...journal.scope);
    return typeof row?.receipt_update === 'string'
      ? JSON.parse(row.receipt_update)
      : undefined;
  });
}

async function requestFrom(session: Session) {
  for await (const event of session.events()) {
    const request = render.match(event);
    if (request) return request;
    if (event.type === 'action_requested' || event.type === 'turn_finished')
      throw new Error('Expected the registered thumbnail request.');
  }
  throw new Error('The Session closed without its request.');
}

/** One local SQLite owner; the endpoint is trusted application configuration. */
async function runCoordinator(
  directory: string,
  base: string,
  decision?: 'approve',
  loss?: 'create' | 'reply',
) {
  const target = endpoint(base);
  const journal = new Journal(new ThumbnailStore(directory, tenant), order);
  return journal.owner(async () => {
    const saved = journal.load();
    if (saved.finished) return { status: 'completed' };
    const context = { signal: AbortSignal.timeout(20_000) };
    let discarded = false;
    const provider = new A2AJobProvider({
      endpoint: target,
      authorize: (claim, operation) =>
        journal.authorize(claim, operation, context),
      authorization: async () => token,
      reserve: async (claim, operation, actionId) => {
        if (operation === 'start') {
          journal.authorized(
            claim,
            (db) => {
              db.prepare(
                "INSERT INTO mutations VALUES (?,?,?,?,?,?,'spent')",
              ).run(
                ...journal.scope,
                operation,
                actionId,
                '',
                claim.generation,
              );
            },
            context,
          );
        } else {
          journal.reserveMutation(claim, operation, actionId, context);
          journal.spendMutation(claim, operation, actionId, context);
        }
      },
      encode: () => [
        Part.fromJSON({ text: 'Render one blue thumbnail after approval.' }),
      ],
      project: (task: Task) => {
        const part = task.artifacts[0]?.parts[0]?.content;
        if (part?.$case !== 'data')
          throw new Error('Expected the structured render result.');
        return resultSchema.parse(part.value.result);
      },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const body =
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (
          !discarded &&
          body?.method === 'SendMessage' &&
          ((loss === 'create' && !body.params.message.taskId) ||
            (loss === 'reply' && body.params.message.taskId))
        ) {
          discarded = true;
          await response.arrayBuffer();
          throw new Error('Synthetic lost mutation acknowledgment.');
        }
        return response;
      },
    });
    const jobs = new DeferredTools({ journal, tenant, runId: order });
    jobs.register(render, {
      providerId: provider.id,
      provider,
      project: publicSize,
      maxOutputBytes: 64,
      requireReconciliation: false,
    });
    // A restored command may only observe. The source-checkout fixture permits
    // zero or one final Model request instead of requiring a preplanned response.
    const model = new ModelServer([
      (request) => {
        if (saved.checkpoint === null)
          return [
            call(
              render.name,
              { color: 'blue' },
              { callId: 'coordinator-render' },
            ),
          ];
        const items = request.input as {
          type?: string;
          call_id?: string;
          output?: unknown;
        }[];
        if (
          !items.some(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'coordinator-render' &&
              item.output === '{"byteCount":3085}',
          )
        )
          throw new Error('Unexpected public result.');
        return [message('The thumbnail contains 3085 bytes.')];
      },
    ]);
    try {
      const config = await model.config();
      await using nativeProvider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'local-coordinator-fixture',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Request one thumbnail, then report its byte count.',
        tools: [render],
        provider: nativeProvider,
      });
      const session = await agent.session(
        saved.checkpoint === null
          ? {}
          : { state: parseSessionState(saved.checkpoint) },
      );
      try {
        if (saved.checkpoint === null)
          await session.submit('Render one blue thumbnail.');
        const request = await requestFrom(session);
        const finish = async (opened: Session, outcome: AdvanceOutcome) => {
          if (outcome.status === 'continued') {
            await outcome.turn.wait();
            model.assertExhausted();
            journal.finish(JSON.stringify(await opened.saveState()));
            return { status: 'completed' };
          }
          const current = update(journal);
          const receipt = current?.receipt
            ? JSON.parse(current.receipt)
            : undefined;
          return {
            status: outcome.status,
            ...(receipt
              ? {
                  remote: {
                    taskId: receipt.taskId,
                    contextId: receipt.contextId,
                  },
                }
              : {}),
          };
        };
        if (saved.checkpoint === null)
          return await jobs.start(
            session,
            request,
            {},
            ({ session: opened, outcome }) => finish(opened, outcome),
          );
        let outcome = await jobs.advance(session, request);
        if (decision === 'approve' && outcome.status === 'inputRequired') {
          const current = update(journal)!;
          const receipt = JSON.parse(current.receipt!);
          const challenge = challengeSchema.parse(current.value);
          const reply: A2AInputReply = {
            taskId: receipt.taskId,
            contextId: receipt.contextId,
            challenge: challenge.challenge,
            generation: challenge.generation,
            result: true,
          };
          outcome = await jobs.advance(session, request, {
            operation: 'respond',
            response: reply,
          });
        }
        return await finish(session, outcome);
      } finally {
        await session.close();
      }
    } finally {
      await ModelServer.closeAll();
    }
  });
}

async function main() {
  const [command, directory, base, decision, loss] = process.argv.slice(2);
  if (
    command === 'serve' &&
    (directory === undefined || directory === 'hold') &&
    base === undefined
  )
    return serve(directory === 'hold');
  if (
    command !== 'run' ||
    !directory ||
    !base ||
    (decision !== undefined &&
      decision !== 'approve' &&
      decision !== 'observe') ||
    (loss !== undefined && loss !== 'lose-create' && loss !== 'lose-reply')
  )
    throw new Error(
      'Use serve [hold], or run PRIVATE_DIRECTORY LOOPBACK_ORIGIN [observe|approve] [lose-create|lose-reply].',
    );
  console.log(
    JSON.stringify(
      await runCoordinator(
        directory,
        base,
        decision === 'approve' ? 'approve' : undefined,
        loss === 'lose-create'
          ? 'create'
          : loss === 'lose-reply'
            ? 'reply'
            : undefined,
      ),
    ),
  );
}
if (typeof require !== 'undefined' && require.main === module)
  main().catch(() => {
    console.error('The local A2A workflow could not advance.');
    process.exitCode = 1;
  });

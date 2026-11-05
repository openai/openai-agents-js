import { isDeepStrictEqual } from 'node:util';
/** Test-only public coordinator host with one trusted immutable form and mutation. */
import { Agent, NativeProvider, parseSessionState } from '@openai/agents';
import { DeferredTools } from '@openai/agents/experimental/deferred';
import {
  MCPInputReply,
  MCPTasksProvider,
} from '@openai/agents/experimental/mcp-tasks';
import { Journal } from '../../../examples/external-job-journal';
import { ThumbnailStore } from '../../../examples/external-job-store';
import { publicSize, render } from '../../../examples/external-job';

const REQUESTS = {
  approval: {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Approve this one blue thumbnail.',
      requestedSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
        required: ['approved'],
      },
    },
  },
};
const ANSWERS = {
  approval: { action: 'accept' as const, content: { approved: true } },
};
const [directory, order, mcpPort, modelPort, command] = process.argv.slice(2);
if (
  !directory ||
  !order ||
  (command !== 'observe' && command !== 'respond' && command !== 'cancel')
)
  throw new Error('Invalid mutation fixture arguments.');
const journal = new Journal(
  new ThumbnailStore(directory, 'local-mcp-studio'),
  order,
);
void journal
  .owner(async () => {
    const { checkpoint } = journal.load();
    if (checkpoint === null)
      throw new Error('Start this order before mutating it.');
    const provider = new MCPTasksProvider({
      endpoint: `http://127.0.0.1:${Number(mcpPort)}/mcp`,
      tool: render.name,
      fetch: globalThis.fetch,
      async authorize(claim, action, context) {
        await journal.authorize(claim, action, context);
        return 'local-only';
      },
      allowInputReplies: true,
      admitPending(_claim, taskId, requests) {
        if (!/^[0-9a-f-]{36}$/.test(taskId)) return false;
        if (requests === null) return true;
        const actual = JSON.parse(requests);
        return isDeepStrictEqual(actual, REQUESTS);
      },
      admitResult(_claim, result) {
        return publicSize(result.structuredContent);
      },
      async reserveMutation(claim, reply, context) {
        if (command === 'observe' || claim.action !== command) return false;
        if (command === 'respond') {
          const value = claim.update?.value as
            { challenge?: string } | undefined;
          if (
            !(reply instanceof MCPInputReply) ||
            reply.challenge !== value?.challenge ||
            JSON.stringify(reply.responses) !== JSON.stringify(ANSWERS)
          )
            return false;
        } else if (reply !== null) return false;
        // These real SQLite transactions are the only mutation reservation owner.
        journal.reserveMutation(
          claim,
          command,
          'one-trusted-mutation',
          context,
        );
        journal.spendMutation(claim, command, 'one-trusted-mutation', context);
        return true;
      },
    });
    const jobs = new DeferredTools({
      journal,
      tenant: journal.store.tenant,
      runId: order,
    });
    jobs.register(render, {
      providerId: 'local-mcp-thumbnail-v1',
      provider,
      project(value) {
        return publicSize(
          (value as { structuredContent: unknown }).structuredContent,
        );
      },
      maxOutputBytes: 64,
      requireReconciliation: false,
    });
    await using model = new NativeProvider({
      baseUrl: `http://127.0.0.1:${Number(modelPort)}/v1`,
      apiKey: 'local-only',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions:
        'Request one thumbnail. Then report its approved byte count.',
      provider: model,
      tools: [render],
    });
    await using session = await agent.session({
      state: parseSessionState(checkpoint),
    });
    let request;
    for await (const event of session.events()) {
      request = render.match(event);
      if (request) break;
    }
    if (!request) throw new Error('No restored original deferred call.');
    const update = journal.store.transaction((db) => {
      const row = db
        .prepare(
          'SELECT receipt_update FROM orders WHERE tenant=? AND order_id=?',
        )
        .get(...journal.scope);
      return row?.receipt_update
        ? (JSON.parse(row.receipt_update as string) as {
            value?: { challenge?: string };
          })
        : undefined;
    });
    const outcome = await jobs.advance(
      session,
      request,
      command === 'respond'
        ? {
            operation: 'respond',
            response: new MCPInputReply({
              challenge: update?.value?.challenge ?? '',
              responses: ANSWERS,
            }),
          }
        : command === 'cancel'
          ? { operation: 'cancel' }
          : {},
    );
    if (outcome.status === 'continued')
      throw new Error('Mutation fixture must not deliver a completed result.');
    console.log(outcome.status);
  })
  .catch(() => {
    console.error('MCP mutation fixture could not advance.');
    process.exitCode = 1;
  });

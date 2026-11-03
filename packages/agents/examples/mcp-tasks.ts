/** Resume one low-impact MCP thumbnail task from an application-owned journal. */
import { parseArgs } from 'node:util';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  type Session,
} from '@openai/agents';
import {
  DeferredTools,
  type AdvanceOutcome,
} from '@openai/agents/experimental/deferred';
import { MCPTasksProvider } from '@openai/agents/experimental/mcp-tasks';
import { Journal } from './external-job-journal';
import { Busy, ThumbnailStore } from './external-job-store';
import { publicSize, render } from './external-job';

function port(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new TypeError('Supply a local server port.');
  return value;
}

async function requestFrom(session: Session) {
  for await (const event of session.events()) {
    const request = render.match(event);
    if (request) return request;
    if (event.type === 'action_requested')
      throw new Error('The model requested an unexpected interaction.');
    if (event.type === 'turn_finished') {
      await session.wait();
      throw new Error('The model finished without requesting a thumbnail.');
    }
  }
  throw new Error('The Session closed before requesting a thumbnail.');
}

/** Each call owns one order, advances it once, and closes its local resources. */
export async function advanceMCPOrder(
  journal: Journal,
  options: { mcpPort: number; modelPort: number },
): Promise<string> {
  const endpoint = `http://127.0.0.1:${port(options.mcpPort)}/mcp`;
  const baseUrl = `http://127.0.0.1:${port(options.modelPort)}/v1`;
  return journal.owner(async () => {
    const { checkpoint, finished } = journal.load();
    if (finished) return 'completed';
    const provider = new MCPTasksProvider({
      endpoint,
      tool: render.name,
      fetch: globalThis.fetch,
      async authorize(claim, operation, context) {
        await journal.authorize(claim, operation, context);
        return 'local-only';
      },
      // This example trusts one local peer that issues UUID task IDs and no forms.
      admitPending: (_claim, taskId, requests) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          taskId,
        ) && requests === null,
      admitResult(_claim, result) {
        if (result.isError)
          throw new Error('The peer did not return a thumbnail.');
        return publicSize(result.structuredContent);
      },
    });
    const jobs = new DeferredTools({
      journal,
      tenant: journal.store.tenant,
      runId: journal.order,
    });
    jobs.register(render, {
      providerId: 'local-mcp-thumbnail-v1',
      provider,
      project(value) {
        if (
          !value ||
          typeof value !== 'object' ||
          !('structuredContent' in value)
        )
          throw new Error('No approved thumbnail size.');
        return publicSize(value.structuredContent);
      },
      maxOutputBytes: 64,
      // A lost creation reply stays unknown. It never permits another create.
      requireReconciliation: false,
    });
    await using model = new NativeProvider({
      baseUrl,
      apiKey: 'local-only',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions:
        'Request one thumbnail. Then report its approved byte count.',
      tools: [render],
      provider: model,
    });
    await using session = await agent.session({
      ...(checkpoint === null ? {} : { state: parseSessionState(checkpoint) }),
    });
    if (checkpoint === null) await session.submit('Render a blue thumbnail.');
    const request = await requestFrom(session);
    const finish = async (
      opened: Session<unknown>,
      outcome: AdvanceOutcome,
    ) => {
      if (outcome.status !== 'continued') return outcome.status;
      await outcome.turn.wait();
      journal.finish(JSON.stringify(await opened.saveState()));
      return 'completed';
    };
    return await (checkpoint === null
      ? jobs.start(session, request, {}, ({ session: opened, outcome }) =>
          finish(opened, outcome),
        )
      : finish(session, await jobs.advance(session, request)));
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      directory: { type: 'string' },
      'mcp-port': { type: 'string' },
      'model-port': { type: 'string' },
    },
  });
  const [command, order] = positionals;
  if (positionals.length !== 2 || command !== 'run' || !values.directory)
    throw new Error(
      'Usage: mcp-tasks.ts run ORDER --directory /private/state --mcp-port PORT --model-port PORT',
    );
  const store = new ThumbnailStore(values.directory, 'local-mcp-studio');
  try {
    console.log(
      await advanceMCPOrder(new Journal(store, order), {
        mcpPort: Number(values['mcp-port']),
        modelPort: Number(values['model-port']),
      }),
    );
  } catch (error) {
    if (error instanceof Busy) console.log(error.message);
    else throw error;
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch(() => {
    console.error('The MCP thumbnail order could not be advanced.');
    process.exitCode = 1;
  });
}

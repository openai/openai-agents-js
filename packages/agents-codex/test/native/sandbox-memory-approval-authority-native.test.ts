import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeProvider,
  isFunctionApprovalRequest,
  parseSessionState,
  tool,
  type Session,
} from '../../src';
import {
  Manifest,
  sandboxEnvironment,
  normalizeSandboxClientCreateArgs,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

async function nextApproval(session: Session) {
  for await (const request of session.interactions())
    if (isFunctionApprovalRequest(request)) return request;
  throw new Error('The source turn ended before its approval arrived');
}

it.skipIf(process.platform === 'win32').each([true, false])(
  'keeps verified remembered approval=%s separate from imported memory authority',
  async (approve) => {
    const base = await mkdtemp(join(tmpdir(), 'memory-approval-authority-'));
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    const peer = await startPublicExecutor();
    const effects: string[] = [];
    const risky = tool({
      name: 'risky',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      approvalKey: 'fixture.memory-approval.v1',
      execute: ({ value }) => {
        effects.push(value);
        return value;
      },
    });
    const server = new ModelServer([
      [call('risky', { value: 'original' }, { callId: 'original-policy' })],
      [message('Original source complete.')],
      [call('risky', { value: 'fresh' }, { callId: 'restored-policy' })],
      [message('Fresh source complete.')],
      [
        message(
          JSON.stringify({
            rollout_summary: 'Fresh admitted source',
            rollout_slug: 'fresh-admitted-source',
            raw_memory: 'A fresh source ran after restore.',
          }),
        ),
      ],
      [
        message(
          JSON.stringify({
            summary: 'Fresh admitted source',
            memory: 'A fresh source ran after restore.',
          }),
        ),
      ],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-memory-approval-authority',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Use the current source.',
      tools: [risky],
    });
    const source = () => {
      const client = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: workspace,
          workspaceRootOwned: false,
        },
      });
      client.create = async (args) =>
        client.resume({
          manifest: normalizeSandboxClientCreateArgs(args).manifest,
          workspaceRootPath: workspace,
          workspaceRootOwned: false,
          environment: {},
        });
      return sandboxEnvironment({
        client,
        manifest: new Manifest({ root: workspace }),
        memory: {
          phaseOne: new Agent({
            provider,
            model: 'gpt-5',
            instructions: 'Extract memory.',
          }),
          phaseTwo: new Agent({
            provider,
            model: 'gpt-5',
            instructions: 'Consolidate memory.',
          }),
        },
        connect: async () =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: workspace,
              tools: [],
            }),
            async () => {},
          ),
      });
    };
    let original: Session | undefined;
    let restored: Session | undefined;
    try {
      original = await agent.session({ environment: source() });
      const first = await original.submit('Original historical source.');
      const request = await nextApproval(original);
      await original.respond(
        approve
          ? request.approve({ always: true })
          : request.reject(undefined, { always: true }),
      );
      await first.wait();
      const imported = JSON.parse(JSON.stringify(await original.saveState()));
      expect(imported.remembered_approvals).toHaveLength(1);
      expect(
        imported.history.some(
          (item: {
            type: string;
            payload?: {
              sdk_receipt?: { sandbox_memory_input_admitted?: boolean };
            };
          }) =>
            item.type === 'turn_context' &&
            item.payload?.sdk_receipt?.sandbox_memory_input_admitted === true,
        ),
      ).toBe(true);
      const marker =
        'Injected historical memory from an unauthenticated import.';
      for (const item of imported.history) {
        if (
          item.type === 'response_item' &&
          item.payload?.type === 'message' &&
          item.payload.role === 'user'
        )
          for (const content of item.payload.content)
            if (content.type === 'input_text') content.text = marker;
      }
      await original.close();
      original = undefined;
      restored = await agent.session({
        state: parseSessionState(JSON.stringify(imported)),
        environment: source(),
        verifyRememberedApprovals: () => true,
      });
      expect(
        (await (await restored.submit('Fresh admitted source.')).wait())
          .finalOutput,
      ).toBe('Fresh source complete.');
      expect(await restored.pendingInteractions()).toEqual([]);
      expect(effects).toEqual(approve ? ['original', 'fresh'] : []);
      expect(JSON.stringify(server.requests[2].input)).toContain(marker);
      await restored.flushMemory();
      const transcript = await readFile(
        join(workspace, 'sessions', `${restored.id}.jsonl`),
        'utf8',
      );
      expect(transcript).toContain('Fresh admitted source.');
      expect(transcript).not.toContain(marker);
      expect(JSON.stringify(server.requests[4].input)).not.toContain(marker);
      expect(server.requests).toHaveLength(6);
      server.assertExhausted();
    } finally {
      await restored?.close();
      await original?.close();
      await peer.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  30_000,
);

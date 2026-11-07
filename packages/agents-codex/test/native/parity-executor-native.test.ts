import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  NativeError,
  type ExecutorContext,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// Approved strict execution requires a host that can run the native sandbox.
it.skipIf(
  process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
    process.env.GITHUB_ACTIONS !== 'true' &&
    process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1',
)(
  'denies before executor side effects and transforms approved arguments with exact turn context',
  async () => {
    const executor = await startPublicExecutor();
    const model = new ModelServer([
      [
        call(
          'exec_command',
          { cmd: 'printf original-private' },
          { callId: 'denied-command' },
        ),
      ],
      [
        call(
          'exec_command',
          { cmd: 'printf original-private' },
          { callId: 'approved-command' },
        ),
      ],
      (request) => {
        const outputs = (
          request.input as Array<Record<string, unknown>>
        ).filter(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'approved-command',
        );
        expect(JSON.stringify(outputs)).toContain('policy-approved');
        expect(JSON.stringify(outputs)).not.toContain('original-private');
        return [message('executed')];
      },
    ]);
    const config = await model.config();
    const provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
    });
    const context = { tenant: 'tenant-a' };
    let allowed = false;
    const approvals: ExecutorContext<typeof context>[] = [];
    const transforms: ExecutorContext<typeof context>[] = [];
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command'],
      approval(info: ExecutorContext<typeof context>, args) {
        approvals.push(info);
        expect(args).toMatchObject({ cmd: 'printf original-private' });
        return allowed;
      },
      async transformArguments(info: ExecutorContext<typeof context>, args) {
        transforms.push(info);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
          ...(args as Record<string, unknown>),
          cmd: 'printf policy-approved',
        };
      },
    });
    const agent = new Agent<typeof context>({
      instructions: 'Run the selected command.',
      provider,
      model: 'gpt-5',
      tools: [],
    });
    let session: Awaited<ReturnType<typeof agent.session>> | undefined;
    try {
      session = await agent.session({ context, environment });
      const denied = await session.submit('first command');
      await expect(denied.wait()).rejects.toBeInstanceOf(NativeError);
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
      expect(transforms).toHaveLength(0);
      expect(approvals[0]?.submission).toBe(denied);
      allowed = true;
      const approved = await session.submit('second command');
      expect((await approved.wait()).finalOutput).toBe('executed');
      expect(approvals).toHaveLength(2);
      expect(transforms).toHaveLength(1);
      expect(transforms[0]?.submission).toBe(approved);
      expect(transforms[0]?.context).toBe(context);
      const starts = executor.requests.filter(
        (request) => request.method === 'process/start',
      );
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts)).toContain('policy-approved');
      expect(JSON.stringify(starts)).not.toContain('original-private');
      model.assertExhausted();
    } finally {
      try {
        try {
          await session?.close();
        } finally {
          await provider.close();
        }
      } finally {
        await executor.close();
      }
    }
  },
  25_000,
);

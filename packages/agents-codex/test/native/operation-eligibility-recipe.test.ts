import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, ToolOutput } from '../../src';
import {
  createRecordRecipe,
  type RecordApplication,
} from '../../../../examples/codex/operation-selection';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-eligibility',
    supportsWebsockets: false,
  });
}
function names(request: { tools?: unknown; input?: unknown }) {
  const result: string[] = [];
  function visit(tools: unknown) {
    if (!Array.isArray(tools)) return;
    for (const entry of tools) {
      if (entry.type === 'namespace') visit(entry.tools);
      else if (entry.type === 'function') result.push(entry.name);
    }
  }
  visit(request.tools);
  if (Array.isArray(request.input))
    for (const item of request.input)
      if (item.type === 'additional_tools') visit(item.tools);
  return result;
}
function application(effects: string[]): RecordApplication {
  return {
    eligible: () => true,
    approve: async () => true,
    create: () => {
      effects.push('create');
      return 'created';
    },
    read: () => {
      effects.push('read');
      return 'record';
    },
  };
}

it('publishes B only after validated A success, once per preparation', async () => {
  const effects: string[] = [];
  const recipe = createRecordRecipe(application(effects));
  const server = new ModelServer([
    [call('create_record', {}, { callId: 'create' })],
    [call('read_record', {}, { callId: 'read' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the published record tools.',
    provider,
    tools: recipe.tools,
  }).session();
  const indices: number[] = [];
  const turn = await session.submit('Create then read.', {
    tools: recipe.tools,
    beforeStep({ stepIndex }) {
      indices.push(stepIndex);
      return recipe.beforeStep();
    },
  });
  expect((await turn.wait()).finalOutput).toBe('done');
  expect(effects).toEqual(['create', 'read']);
  expect(indices).toEqual([0, 1, 2]);
  expect(server.requests.map(names)).toEqual([
    ['create_record'],
    ['read_record'],
    ['read_record'],
  ]);
  server.assertExhausted();
});

it.each(['failure', 'denial'] as const)(
  'does not unlock B after A %s',
  async (outcome) => {
    const effects: string[] = [];
    const app = application(effects);
    app.approve = async () => outcome !== 'denial';
    app.create = () => {
      effects.push('failed create');
      return new ToolOutput(
        [{ type: 'inputText', text: 'not created' }],
        false,
      );
    };
    const recipe = createRecordRecipe(app);
    const server = new ModelServer([
      [call('create_record', {}, { callId: 'create' })],
      [message('not created')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use the published record tools.',
      provider,
      tools: recipe.tools,
    }).session();
    const turn = await session.submit('Try creating.', {
      tools: recipe.tools,
      beforeStep: recipe.beforeStep,
    });
    expect((await turn.wait()).finalOutput).toBe('not created');
    expect(effects).toEqual(outcome === 'failure' ? ['failed create'] : []);
    expect(server.requests.map(names)).toEqual([
      ['create_record'],
      ['create_record'],
    ]);
    server.assertExhausted();
  },
);

it('does not unlock B when A is cancelled before its result is validated', async () => {
  const effects: string[] = [];
  const entered = Promise.withResolvers<void>();
  const app = application(effects);
  app.create = async (signal) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    signal.throwIfAborted();
    effects.push('create');
    return 'created';
  };
  const recipe = createRecordRecipe(app);
  const server = new ModelServer([
    [call('create_record', {}, { callId: 'cancelled-create' })],
    [message('fresh turn')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the published record tools.',
    provider,
    tools: recipe.tools,
  }).session();
  const options = { tools: recipe.tools, beforeStep: recipe.beforeStep };
  const turn = await session.submit('Create.', options);
  const interrupted = turn.wait().catch((error: unknown) => error);
  await entered.promise;
  await turn.cancel();
  expect(await interrupted).toBeInstanceOf(Error);
  expect(effects).toEqual([]);
  expect(
    (await (await session.submit('Inspect next selection.', options)).wait())
      .finalOutput,
  ).toBe('fresh turn');
  expect(server.requests.map(names)).toEqual([
    ['create_record'],
    ['create_record'],
  ]);
  expect(effects).toEqual([]);
  server.assertExhausted();
});

it('refuses effects when eligibility is revoked while approval waits', async () => {
  const effects: string[] = [];
  const entered = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<boolean>();
  let eligible = true;
  const app = application(effects);
  app.eligible = () => eligible;
  app.approve = () => {
    entered.resolve();
    return approval.promise;
  };
  const recipe = createRecordRecipe(app);
  const server = new ModelServer([
    [call('create_record', {}, { callId: 'revoked-create' })],
    [message('revoked')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the published record tools.',
    provider,
    tools: recipe.tools,
  }).session();
  const turn = await session.submit('Create.', {
    tools: recipe.tools,
    beforeStep: recipe.beforeStep,
  });
  await entered.promise;
  eligible = false;
  approval.resolve(true);
  expect((await turn.wait()).finalOutput).toBe('revoked');
  expect(effects).toEqual([]);
  expect(server.requests.map(names)).toEqual([['create_record'], []]);
  server.assertExhausted();
});

it('checks eligibility synchronously at effect entry after before returns allow', async () => {
  const effects: string[] = [];
  let eligible = true;
  let approved = false;
  let queued = false;
  const observedAfterApproval: boolean[] = [];
  const app = application(effects);
  app.approve = async () => {
    approved = true;
    return true;
  };
  app.eligible = () => {
    const current = eligible;
    if (approved) {
      observedAfterApproval.push(current);
      if (!queued) {
        queued = true;
        // before returns allow, then this microtask revokes eligibility before execute.
        queueMicrotask(() => {
          eligible = false;
        });
      }
    }
    return current;
  };
  const recipe = createRecordRecipe(app);
  const server = new ModelServer([
    [call('create_record', {}, { callId: 'microtask-create' })],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the published record tools.',
    provider,
    tools: recipe.tools,
  }).session();
  const turn = await session.submit('Create.', {
    tools: recipe.tools,
    beforeStep: recipe.beforeStep,
  });
  await expect(turn.wait()).rejects.toThrow();
  expect(observedAfterApproval.slice(0, 2)).toEqual([true, false]);
  expect(effects).toEqual([]);
  expect(server.requests.map(names)).toEqual([['create_record']]);
});

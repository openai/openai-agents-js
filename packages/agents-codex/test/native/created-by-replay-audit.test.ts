import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([
  ['file_search_call', 'fs_external', { queries: ['a'], results: [] }],
  [
    'code_interpreter_call',
    'ci_external',
    { container_id: 'cntr_test', code: 'synthetic' },
  ],
  [
    'image_generation_call',
    'ig_external',
    { result: null, revised_prompt: null },
  ],
  ['mcp_list_tools', 'mcpl_external', { server_label: 'peer', tools: [] }],
  ['program', 'pgm_external', { call_id: 'prior_program', code: 'fixture()' }],
  [
    'program_output',
    'pgmo_external',
    { call_id: 'prior_program', result: 'settled' },
  ],
] as const)(
  'keeps %s created_by in history and strips it from Responses',
  async (kind, id, fields) => {
    const original = {
      type: kind,
      id,
      ...(kind === 'program' ? {} : { status: 'completed' }),
      created_by: 'sdk-private',
      ...fields,
    };
    const program = {
      type: 'program',
      id: 'pgm_external',
      call_id: 'prior_program',
      code: 'fixture()',
    };
    const result = {
      type: 'program_output',
      id: 'pgmo_external',
      call_id: 'prior_program',
      status: 'completed',
      result: 'settled',
    };
    const imported =
      kind === 'program'
        ? [original, result]
        : kind === 'program_output'
          ? [program, original]
          : [original];
    const server = new ModelServer([[message('continued')]]);
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:' + (await server.port()) + '/v1',
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const agent = new Agent({ instructions: 'Reply briefly.', provider });
    let state;
    let snapshot;
    {
      await using source = await agent.session();
      const initial = await source.historySnapshot();
      await source.transactHistory({
        expectedRevision: initial.revision,
        keep: 0,
        items: imported,
      });
      snapshot = await source.historySnapshot();
      expect(snapshot.items).toEqual(imported);
      state = await source.saveState();
    }
    await using restored = await agent.session({ state });
    expect(await restored.historySnapshot()).toEqual(snapshot);
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'continued',
    );
    const sent = (server.requests[0].input as Array<{ id?: string }>).find(
      (item) => item.id === id,
    );
    expect(sent).toMatchObject(fields);
    expect(sent).not.toHaveProperty('created_by');
    server.assertExhausted();
  },
);

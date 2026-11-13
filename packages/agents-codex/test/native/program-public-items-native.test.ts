import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, hostedTool, codeInterpreter } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
const program = {
  type: 'program',
  id: 'program_item',
  call_id: 'program-call',
  code: 'lookup()',
  fingerprint: 'synthetic-fingerprint',
  vendor: { enabled: false, number: 0 },
};
const output = {
  type: 'program_output',
  id: 'program_output_item',
  call_id: 'program-call',
  status: 'completed',
  result: 'synthetic program result',
  vendor: { detail: null },
};

it.each(['history', 'produced', 'observations'] as const)(
  'preserves provider programs in public %s items',
  async (view) => {
    const server = new ModelServer([[program, output, message('done')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-program',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use the provider program.',
      tools: [
        codeInterpreter({
          container: 'cntr_fixture',
          allowedCallers: ['programmatic'],
        }),
        hostedTool({ type: 'programmatic_tool_calling' }),
      ],
    });
    const items = [];
    if (view === 'produced') {
      const result = await agent.run('Run the program.', { returnItems: true });
      expect(result.finalOutput).toBe('done');
      expect(result.items).toBeDefined();
      items.push(...(result.items ?? []).map((entry) => entry.item));
    } else {
      await using session = await agent.session({
        includeModelOutputItems: true,
        observationRetention: 'all',
      });
      const turn = await session.submit('Run the program.');
      expect((await turn.wait()).finalOutput).toBe('done');
      if (view === 'history')
        items.push(...(await Array.fromAsync(session.items())));
      else
        for await (const event of turn.events({
          includeExecutionDetails: true,
        })) {
          if (event.type === 'hosted_tool_item_completed')
            items.push(event.item);
        }
    }
    const passive = items.filter(
      (item) => item.type === 'program' || item.type === 'program_output',
    );
    expect(passive).toMatchObject([
      {
        type: 'program',
        id: program.id,
        call_id: program.call_id,
        code: program.code,
        provider_data: program,
      },
      {
        type: 'program_output',
        id: output.id,
        call_id: output.call_id,
        status: 'completed',
        result: output.result,
        provider_data: output,
      },
    ]);
    const [call, result] = passive;
    if (call?.type !== 'program' || result?.type !== 'program_output')
      throw new Error('Missing typed provider program items');
    if (!('code' in call) || !('result' in result))
      throw new Error('Missing detailed provider program data');
    expect(call.code).toBe(program.code);
    expect(result.result).toBe(output.result);
    server.assertExhausted();
  },
  20_000,
);

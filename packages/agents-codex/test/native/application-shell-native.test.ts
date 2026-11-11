import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  shellTool,
  isFunctionApprovalRequest,
  parseSessionState,
  type FunctionApprovalRequest,
  type ShellCall,
  type ShellOutput,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';
import type { JsonObject } from '../../src/runtime/binding';

afterEach(() => ModelServer.closeAll());

const shellCall: JsonObject = {
  type: 'shell_call',
  call_id: 'call_application',
  action: {
    commands: ['printf application'],
    timeout_ms: 1000,
    max_output_length: 32,
  },
};
const output = {
  output: [
    {
      stdout: 'application',
      stderr: '',
      outcome: { type: 'exit', exit_code: 0 },
    },
  ],
} satisfies ShellOutput;

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-application-shell',
    supportsWebsockets: false,
  });
}
async function approvalFor(session: {
  interactions(): AsyncIterable<unknown>;
}): Promise<FunctionApprovalRequest> {
  for await (const event of session.interactions())
    if (isFunctionApprovalRequest(event)) return event;
  throw new Error('Missing shell approval');
}

it('executes a captured local shell with skills and replays structured output after cold restore', async () => {
  const effects: ShellCall[] = [];
  const application = { label: 'application-context' };
  const skills = [
    {
      description: 'Inspect a fixture',
      name: 'fixture',
      path: '/skills/fixture',
    },
  ];
  const local = shellTool<typeof application>({
    skills,
    execute(call, context) {
      expect(context.context).toBe(application);
      expect(context.callId).toBe('call_application');
      expect(context.originalArguments).toMatchObject(shellCall);
      effects.push(call);
      return output;
    },
  });
  skills[0].description = 'Changed after capture';
  const server = new ModelServer([
    [shellCall],
    [message('Executed.')],
    [message('Restored.')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'gpt-5',
    instructions: 'Use the local shell.',
    tools: [local],
  });
  const session = await agent.session({ context: application });
  let state;
  let retainedShell: unknown;
  try {
    expect((await (await session.submit('Execute.')).wait()).finalOutput).toBe(
      'Executed.',
    );
    expect(effects).toHaveLength(1);
    expect(effects[0].action.commands).toEqual(['printf application']);
    expect(server.requests[0].tools).toContainEqual({
      type: 'shell',
      environment: {
        type: 'local',
        skills: [
          {
            description: 'Inspect a fixture',
            name: 'fixture',
            path: '/skills/fixture',
          },
        ],
      },
    });
    expect(server.requests[1].input).toContainEqual(
      expect.objectContaining({
        type: 'shell_call_output',
        call_id: 'call_application',
        output: output.output,
      }),
    );
    const items = await Array.fromAsync(session.items());
    retainedShell = items.filter(
      (item) => item.type === 'shell_call' || item.type === 'shell_call_output',
    );
    expect(retainedShell).toEqual([
      expect.objectContaining({
        type: 'shell_call',
        call_id: 'call_application',
        status: 'unknown',
        action: shellCall.action,
      }),
      expect.objectContaining({
        type: 'shell_call_output',
        call_id: 'call_application',
        status: 'unknown',
        output: output.output,
      }),
    ]);
    state = parseSessionState(JSON.stringify(await session.saveState()));
  } finally {
    await session.close();
  }
  await using restored = await agent.session({ context: application, state });
  expect((await (await restored.submit('Continue.')).wait()).finalOutput).toBe(
    'Restored.',
  );
  expect(server.requests[2].input).toContainEqual(
    expect.objectContaining({
      type: 'shell_call_output',
      call_id: 'call_application',
      output: output.output,
    }),
  );
  expect(
    (await Array.fromAsync(restored.items())).filter(
      (item) => item.type === 'shell_call' || item.type === 'shell_call_output',
    ),
  ).toEqual(retainedShell);
  expect(effects).toHaveLength(1);
  server.assertExhausted();
});

it.each([true, false])(
  'keeps approval before local shell effects and replays the decision (approve=%s)',
  async (approve) => {
    const effects: ShellCall[] = [];
    const local = shellTool({
      needsApproval: true,
      execute(call) {
        effects.push(call);
        return output;
      },
    });
    const server = new ModelServer([[shellCall], [message('Settled.')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Use the local shell.',
      tools: [local],
    });
    await using session = await agent.session();
    await using foreign = await agent.session();
    const turn = await session.submit('Execute.');
    const request = await approvalFor(session);
    expect(request.callId).toBe('call_application');
    expect(effects).toEqual([]);
    expect(server.requests).toHaveLength(1);
    const decision = approve
      ? request.approve()
      : request.reject('Application denied execution');
    await expect(foreign.respond(decision)).rejects.toThrow();
    await session.respond(decision);
    await expect(session.respond(decision)).rejects.toThrow();
    expect((await turn.wait()).finalOutput).toBe('Settled.');
    expect(effects).toHaveLength(approve ? 1 : 0);
    expect(server.requests[1].input).toContainEqual(
      expect.objectContaining({
        type: 'shell_call_output',
        call_id: 'call_application',
        output: approve
          ? output.output
          : [
              expect.objectContaining({
                stderr: 'Application denied execution',
              }),
            ],
      }),
    );
    server.assertExhausted();
  },
);

it('retains an explicit provider-container shell pair without invoking the application executor', async () => {
  let effects = 0;
  const local = shellTool({
    execute() {
      effects++;
      return output;
    },
  });
  const hostedCall = {
    ...shellCall,
    created_by: 'provider-shell',
    environment: { type: 'container_reference', container_id: 'cntr_fixture' },
  };
  const hostedOutput = {
    type: 'shell_call_output',
    id: 'sho_hosted',
    call_id: 'call_application',
    status: 'completed',
    created_by: 'provider-shell',
    output: [{ ...output.output[0], created_by: 'provider-command' }],
  };
  const server = new ModelServer([
    [hostedCall, hostedOutput, message('Provider executed.')],
    [message('Retained.')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'gpt-5',
    instructions: 'Retain the provider result.',
    tools: [local],
  }).session();
  expect((await (await session.submit('Begin.')).wait()).finalOutput).toBe(
    'Provider executed.',
  );
  expect(effects).toBe(0);
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'Retained.',
  );
  expect(server.requests[1].input).toContainEqual(
    expect.objectContaining({
      type: 'shell_call_output',
      call_id: 'call_application',
      output: output.output,
    }),
  );
  expect(effects).toBe(0);
  server.assertExhausted();
});

it.each([false, true])(
  'rejects Shell argument replacement before approval or execution (approval=%s)',
  async (needsApproval) => {
    let effects = 0;
    let approvals = 0;
    const local = shellTool({
      // JavaScript callbacks have been exercising the deliberate runtime rejection too.
      // @ts-expect-error Shell policies only allow or deny the provider-owned action.
      before: () => ({ action: 'replaceArguments', arguments: shellCall }),
      runBeforeApproval: true,
      needsApproval: () => {
        approvals++;
        return needsApproval;
      },
      execute() {
        effects++;
        return output;
      },
    });
    const server = new ModelServer([[shellCall]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Use the shell.',
      tools: [local],
    }).session();
    await expect((await session.submit('Begin.')).wait()).rejects.toThrow(
      'Shell before policies only allow or deny execution',
    );
    expect(effects).toBe(0);
    expect(approvals).toBe(0);
    server.assertExhausted();
  },
);

it.each<{ label: string; marker: JsonObject }>([
  { label: 'empty environment', marker: { environment: {} } },
  { label: 'nonobject environment', marker: { environment: 'container_auto' } },
  {
    label: 'unknown environment',
    marker: { environment: { type: 'unknown' } },
  },
  { label: 'nonstring container ID', marker: { container_id: 7 } },
  { label: 'blank container ID', marker: { container_id: '   ' } },
])(
  'denies receipt authority for a malformed remote marker: $label',
  async ({ marker }) => {
    let effects = 0;
    const local = shellTool({
      execute() {
        effects++;
        return output;
      },
    });
    const server = new ModelServer([
      [
        { ...shellCall, ...marker },
        {
          type: 'shell_call_output',
          call_id: 'call_application',
          output: output.output,
        },
        message('Untrusted receipt.'),
      ],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Retain only authorized output.',
      tools: [local],
    }).session();
    await expect((await session.submit('Begin.')).wait()).rejects.toThrow();
    expect(effects).toBe(0);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
);

it.each<{ label: string; marker: JsonObject }>([
  {
    label: 'automatic container',
    marker: { environment: { type: 'container_auto' } },
  },
  {
    label: 'referenced container',
    marker: {
      environment: {
        type: 'container_reference',
        container_id: 'cntr_fixture',
      },
    },
  },
  { label: 'nonblank container ID', marker: { container_id: 'cntr_fixture' } },
])('retains a legitimate hosted pair with $label', async ({ marker }) => {
  let effects = 0;
  const local = shellTool({
    execute() {
      effects++;
      return output;
    },
  });
  const server = new ModelServer([
    [
      { ...shellCall, ...marker },
      {
        type: 'shell_call_output',
        call_id: 'call_application',
        output: output.output,
      },
      message('Hosted receipt retained.'),
    ],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    model: 'gpt-5',
    instructions: 'Retain authorized output.',
    tools: [local],
  }).session();
  expect((await (await session.submit('Begin.')).wait()).finalOutput).toBe(
    'Hosted receipt retained.',
  );
  expect(effects).toBe(0);
  server.assertExhausted();
});

import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  ComputerSafetyError,
  NativeError,
  computerTool,
  toolRef,
  type Computer,
  type ModelSettings,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
function device(calls: string[]): Computer {
  return {
    screenshot() {
      calls.push('screenshot');
      return 'aA==';
    },
    click() {
      calls.push('click');
    },
    doubleClick() {
      calls.push('double_click');
    },
    scroll() {
      calls.push('scroll');
    },
    type() {
      calls.push('type');
    },
    wait() {
      calls.push('wait');
    },
    move() {
      calls.push('move');
    },
    keypress() {
      calls.push('keypress');
    },
    drag() {
      calls.push('drag');
    },
  };
}
function computerCall(fields: JsonObject = {}): JsonObject {
  return {
    type: 'computer_call',
    id: 'cu_native',
    call_id: 'native-computer',
    status: 'completed',
    ...fields,
  };
}

for (const toolType of ['computer', 'computer_use_preview'] as const) {
  for (const choice of ['auto', 'required', toolRef('computer')] as const) {
    it(`keeps ${toolType} native through ${typeof choice === 'string' ? choice : 'named'} continuation`, async () => {
      const calls: string[] = [],
        computer = device(calls),
        create = vi.fn(() => computer),
        dispose = vi.fn();
      const checks = [
        JSON.parse(
          '{"id":"safety-1","code":"domain","message":"confirm","future":{"keep":true},"__proto__":{"preserve":true}}',
        ) as JsonObject,
      ];
      const action = { type: 'click', x: 1, y: 2, button: 'left' };
      const original = computerCall({
        ...(toolType === 'computer'
          ? { actions: [action, { type: 'screenshot' }] }
          : { action }),
        pending_safety_checks: checks,
        future_provider_field: 'preserved',
      });
      const server = new ModelServer([[original], [message('done')]]);
      const selected = await provider(server);
      const agent = new Agent({
        instructions: 'Use computer.',
        model: 'gpt-5',
        provider: selected,
        modelSettings: { toolChoice: choice },
        tools: [
          computerTool({
            computer: { create, dispose },
            toolType,
            dimensions: [800, 600],
            environment: 'browser',
            onSafetyCheck: () => true,
          }),
        ],
      });
      try {
        expect((await agent.run('click')).finalOutput).toBe('done');
      } finally {
        await selected.close();
      }
      const tools = server.requests[0].tools as JsonObject[];
      expect(
        tools.filter(
          ({ type }) => type === 'computer' || type === 'computer_use_preview',
        ),
      ).toEqual(
        toolType === 'computer'
          ? [{ type: 'computer' }]
          : [
              {
                type: 'computer_use_preview',
                display_width: 800,
                display_height: 600,
                environment: 'browser',
              },
            ],
      );
      expect(
        tools.some(
          ({ type, name }) => type === 'function' && name === 'computer',
        ),
      ).toBe(false);
      expect(server.requests[0].tool_choice).toBe(
        typeof choice === 'string' ? choice : 'required',
      );
      const input = server.requests[1].input as JsonObject[];
      expect(
        input.find(({ type }) => type === 'computer_call')
          ?.future_provider_field,
      ).toBe('preserved');
      expect(
        input.find(({ type }) => type === 'computer_call_output'),
      ).toMatchObject({
        call_id: 'native-computer',
        output: {
          type: 'computer_screenshot',
          image_url: 'data:image/png;base64,aA==',
        },
        acknowledged_safety_checks: checks,
      });
      expect(calls).toEqual(['click', 'screenshot']);
      expect(create).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledExactlyOnceWith(computer);
      server.assertExhausted();
    }, 30_000);
  }
}

it('fails pending safety before acquiring a native driver', async () => {
  const create = vi.fn(() => device([]));
  const server = new ModelServer([
    [
      computerCall({
        action: { type: 'wait' },
        pending_safety_checks: [{ id: 's1', message: 'confirm' }],
      }),
    ],
  ]);
  const selected = await provider(server);
  try {
    await expect(
      new Agent({
        instructions: 'Use computer.',
        provider: selected,
        tools: [computerTool({ computer: { create } })],
      }).run('wait'),
    ).rejects.toBeInstanceOf(ComputerSafetyError);
  } finally {
    await selected.close();
  }
  expect(create).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
}, 30_000);

it.each([toolRef('unavailable'), toolRef('computer', 'foreign')])(
  'rejects a computer choice absent from the final catalog',
  async (toolChoice: ModelSettings['toolChoice']) => {
    const create = vi.fn(() => device([])),
      server = new ModelServer([]),
      selected = await provider(server);
    try {
      await expect(
        new Agent({
          instructions: 'Use computer.',
          model: 'gpt-5',
          provider: selected,
          tools: [computerTool({ computer: { create } })],
          modelSettings: { toolChoice },
        }).run('wait'),
      ).rejects.toThrow(
        'named tool choice is outside the already admitted step catalog',
      );
    } finally {
      await selected.close();
    }
    expect(server.requests).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  },
  30_000,
);

it('joins native callback cancellation before disposing the acquired driver once', async () => {
  const calls: string[] = [],
    computer = device(calls),
    entered = Promise.withResolvers<void>(),
    cleanupEntered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    dispose = vi.fn();
  computer.wait = async (context) => {
    entered.resolve();
    try {
      await new Promise<void>((_resolve, reject) =>
        context.signal.addEventListener(
          'abort',
          () => reject(context.signal.reason),
          { once: true },
        ),
      );
    } finally {
      cleanupEntered.resolve();
      await release.promise;
    }
  };
  const server = new ModelServer([
      [computerCall({ action: { type: 'wait' } })],
    ]),
    selected = await provider(server);
  const agent = new Agent({
    instructions: 'Use computer.',
    provider: selected,
    tools: [computerTool({ computer: { create: () => computer, dispose } })],
  });
  const session = await agent.session();
  try {
    await session.submit('wait');
    await entered.promise;
    const closing = session.close();
    await cleanupEntered.promise;
    expect(dispose).not.toHaveBeenCalled();
    release.resolve();
    await closing;
    await session.close();
  } finally {
    release.resolve();
    await session.close();
    await selected.close();
  }
  expect(dispose).toHaveBeenCalledExactlyOnceWith(computer);
  expect(calls).toEqual([]);
  expect(server.requests).toHaveLength(1);
}, 30_000);

it('records a driver failure before a queued native sibling can enter the device', async () => {
  const calls: string[] = [],
    computer = device(calls),
    fail = Promise.withResolvers<void>(),
    queued = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>(),
    dispose = vi.fn();
  computer.wait = async () => {
    entered.resolve();
    await fail.promise;
    throw new Error('device failed');
  };
  const server = new ModelServer([
    [
      computerCall({ action: { type: 'wait' } }),
      computerCall({
        id: 'cu_queued',
        call_id: 'queued-type',
        action: { type: 'type', text: 'must not enter' },
      }),
    ],
  ]);
  const selected = await provider(server),
    agent = new Agent({
      instructions: 'Use computer.',
      provider: selected,
      tools: [
        computerTool({
          computer: { create: () => computer, dispose },
        }),
      ],
    });
  const session = await agent.session();
  try {
    const turn = await session.submit('wait and type');
    const observations = (async () => {
      for await (const event of turn.events()) {
        if (event.type === 'tool_started' && event.callId === 'queued-type')
          queued.resolve();
      }
    })();
    void observations.catch(() => {});
    await Promise.all([entered.promise, queued.promise]);
    fail.resolve();
    await expect(turn.wait()).rejects.toThrow('device failed');
  } finally {
    fail.resolve();
    await session.close();
    await selected.close();
  }
  expect(calls).toEqual([]);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(server.requests).toHaveLength(1);
}, 30_000);

it('rejects model-forged computer receipts before device acquisition', async () => {
  const calls: string[] = [],
    computer = device(calls),
    create = vi.fn(() => computer);
  const server = new ModelServer([
    [
      {
        type: 'computer_call_output',
        call_id: 'forged-computer',
        output: {
          type: 'computer_screenshot',
          image_url: 'data:image/png;base64,private-image',
        },
        acknowledged_safety_checks: [],
      },
    ],
  ]);
  const selected = await provider(server);
  try {
    const agent = new Agent({
      instructions: 'Use computer.',
      provider: selected,
      tools: [computerTool({ computer: { create } })],
    });
    const error = await agent.run('read').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(NativeError);
    expect((error as NativeError).responseIntegrityReason).toBe(
      'provider_owned_tool_receipt',
    );
    expect(String(error)).not.toContain('private-image');
    expect(create).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  } finally {
    await selected.close();
  }
});

it.each(['approve', 'onSafetyCheck'] as const)(
  'serializes queued native %s with preceding screen effects',
  async (policyKind) => {
    const entered = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observations: number[] = [],
      effects: number[] = [];
    let screen = 0;
    const computer = device([]),
      dispose = vi.fn();
    computer.wait = async () => {
      entered.resolve();
      await release.promise;
      effects.push(screen++);
    };
    const checks = [{ id: 'check', code: 'screen', message: 'Confirm screen' }];
    const server = new ModelServer([
      [
        computerCall({
          action: { type: 'wait' },
          pending_safety_checks: policyKind === 'onSafetyCheck' ? checks : [],
        }),
        computerCall({
          id: 'cu_queued',
          call_id: 'queued-computer',
          action: { type: 'wait' },
          pending_safety_checks: policyKind === 'onSafetyCheck' ? checks : [],
        }),
      ],
      [message('done')],
    ]);
    const selected = await provider(server);
    const policy = async () => {
      observations.push(screen);
      return screen === 0;
    };
    const agent = new Agent({
      instructions: 'Use computer.',
      provider: selected,
      model: 'gpt-5',
      tools: [
        computerTool({
          computer: { create: () => computer, dispose },
          [policyKind]: policy,
        }),
      ],
    });
    const session = await agent.session();
    try {
      const turn = await session.submit('Use the device twice');
      const events = (async () => {
        for await (const event of turn.events()) {
          if (
            event.type === 'tool_started' &&
            event.callId === 'queued-computer'
          )
            queued.resolve();
        }
      })();
      void events.catch(() => {});
      await Promise.all([entered.promise, queued.promise]);
      release.resolve();
      await expect(turn.wait()).rejects.toThrow(
        /not approved|require acknowledgment/,
      );
    } finally {
      release.resolve();
      await session.close();
      await selected.close();
    }
    expect(observations).toEqual([0, 1]);
    expect(effects).toEqual([0]);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(computer);
    expect(server.requests).toHaveLength(1);
  },
  30_000,
);

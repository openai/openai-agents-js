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
  const server = new ModelServer(
    [
      [
        computerCall({ action: { type: 'wait' } }),
        computerCall({
          id: 'cu_queued',
          call_id: 'queued-type',
          action: { type: 'type', text: 'must not enter' },
        }),
      ],
    ],
    [],
    async (_item, index) => {
      // Concurrent native callbacks need not enter the device in item order.
      if (index === 1) await entered.promise;
    },
  );
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

it('rejects orphan computer compaction before publishing a replacement', async () => {
  const calls: string[] = [];
  const server = new ModelServer([
    [computerCall({ action: { type: 'wait' } })],
    [message('done')],
  ]);
  const selected = await provider(server);
  const agent = new Agent({
    instructions: 'Use computer.',
    provider: selected,
    tools: [computerTool({ computer: device(calls) })],
  });
  const session = await agent.session();
  try {
    await (await session.submit('wait')).wait();
    let foundCall = false,
      foundOutput = false;
    for await (const item of session.items()) {
      if (item.type === 'function_call' && item.name === 'computer') {
        expect(item.arguments).toMatchObject({
          type: 'computer_call',
          action: { type: 'wait' },
        });
        foundCall = true;
      }
      if (item.type === 'function_call_output') {
        expect(item.output).toEqual({
          output: {
            type: 'computer_screenshot',
            image_url: 'data:image/png;base64,aA==',
          },
          acknowledged_safety_checks: [],
        });
        foundOutput = true;
      }
    }
    expect(foundCall && foundOutput).toBe(true);
    const snapshot = await session.modelContext();
    const call = snapshot.items.findIndex(
      (item) => item.type === 'computer_call',
    );
    const output = snapshot.items.findIndex(
      (item) => item.type === 'computer_call_output',
    );
    expect(call).toBeGreaterThanOrEqual(0);
    expect(output).toBeGreaterThan(call);
    for (const retain of [[call], [output]]) {
      await expect(
        session.compact({ summary: 'Keep the screen.', snapshot, retain }),
      ).rejects.toThrow(/retain both original tool call and result/);
      expect(await session.modelContext()).toEqual(snapshot);
    }
    await session.compact({
      summary: 'Keep the screen.',
      snapshot,
      retain: [call, output],
    });
    const retained = await session.modelContext();
    expect(
      retained.items.filter((item) => item.type === 'computer_call'),
    ).toHaveLength(1);
    expect(
      retained.items.filter((item) => item.type === 'computer_call_output'),
    ).toHaveLength(1);
    expect(calls).toEqual(['wait', 'screenshot']);
    expect(server.requests).toHaveLength(2);
  } finally {
    await session.close();
    await selected.close();
  }
}, 30_000);

it.each(
  [false, true].flatMap((sameDeclaration) =>
    ['approve', 'onSafetyCheck'].map(
      (policy) => [sameDeclaration, policy] as const,
    ),
  ),
)(
  'serializes a shared borrowed device across Sessions (same declaration=%s, policy=%s)',
  async (sameDeclaration, policyKind) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let screen = 0;
    const observations: number[] = [],
      effects: number[] = [];
    const driver = device([]);
    driver.wait = async () => {
      entered.resolve();
      await release.promise;
      effects.push(screen++);
    };
    const policy = async () => {
      observations.push(screen);
      return screen === 0;
    };
    const tool = computerTool({ computer: driver, [policyKind]: policy });
    const other = sameDeclaration
      ? tool
      : computerTool({ computer: driver, [policyKind]: policy });
    const server = new ModelServer([
      [
        computerCall({
          action: { type: 'wait' },
          pending_safety_checks:
            policyKind === 'onSafetyCheck'
              ? [{ id: 'screen', code: 'screen', message: 'Confirm' }]
              : [],
        }),
      ],
      [
        computerCall({
          action: { type: 'wait' },
          pending_safety_checks:
            policyKind === 'onSafetyCheck'
              ? [{ id: 'screen', code: 'screen', message: 'Confirm' }]
              : [],
        }),
      ],
      [message('done')],
    ]);
    const selected = await provider(server);
    const first = await new Agent({
      instructions: 'Use computer.',
      provider: selected,
      tools: [tool],
    }).session();
    const second = await new Agent({
      instructions: 'Use computer.',
      provider: selected,
      tools: [other],
    }).session();
    try {
      const one = await first.submit('first');
      await entered.promise;
      const two = await second.submit('second');
      for await (const event of two.events())
        if (event.type === 'tool_started') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(observations).toEqual([0]);
      release.resolve();
      await expect(two.wait()).rejects.toThrow(
        /not approved|require acknowledgment/,
      );
      expect((await one.wait()).finalOutput).toBe('done');
      expect(observations).toEqual([0, 1]);
      expect(effects).toEqual([0]);
    } finally {
      release.resolve();
      await first.close();
      await second.close();
      await selected.close();
    }
  },
  30_000,
);

it.each(
  ['factory', 'direct'].flatMap((secondSource) =>
    ['approve', 'onSafetyCheck'].map(
      (policyKind) => [secondSource, policyKind] as const,
    ),
  ),
)(
  'binds borrowed factory identity before effects (%s, %s)',
  async (secondSource, policyKind) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let screen = 0;
    const observed = { first: [] as number[], second: [] as number[] },
      effects: number[] = [];
    const driver = device([]);
    driver.wait = async () => {
      entered.resolve();
      await release.promise;
      effects.push(screen++);
    };
    const policy = (owner: 'first' | 'second') => () => {
      observed[owner].push(screen);
      return screen === 0;
    };
    const oneTool = computerTool({
      computer: { create: () => driver },
      [policyKind]: policy('first'),
    });
    const twoTool = computerTool({
      computer: secondSource === 'factory' ? { create: () => driver } : driver,
      [policyKind]: policy('second'),
    });
    const checks =
      policyKind === 'onSafetyCheck'
        ? [{ id: 'screen', code: 'screen', message: 'Confirm' }]
        : [];
    const server = new ModelServer([
      [
        computerCall({
          action: { type: 'wait' },
          pending_safety_checks: checks,
        }),
      ],
      [
        computerCall({
          action: { type: 'wait' },
          pending_safety_checks: checks,
        }),
      ],
      [message('done')],
      [message('done')],
    ]);
    const selected = await provider(server);
    const first = await new Agent({
      instructions: 'Use computer.',
      provider: selected,
      tools: [oneTool],
    }).session();
    const second = await new Agent({
      instructions: 'Use computer.',
      provider: selected,
      tools: [twoTool],
    }).session();
    try {
      const one = await first.submit('first');
      await entered.promise;
      const two = await second.submit('second');
      for await (const event of two.events())
        if (event.type === 'tool_started') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(effects).toEqual([]);
      release.resolve();
      await expect(two.wait()).rejects.toThrow(
        /not approved|require acknowledgment/,
      );
      expect((await one.wait()).finalOutput).toBe('done');
      expect(observed.first).toEqual([0, 0]);
      expect(observed.second).toEqual(
        secondSource === 'factory' ? [0, 1] : [1],
      );
      expect(effects).toEqual([0]);
    } finally {
      release.resolve();
      await first.close();
      await second.close();
      await selected.close();
    }
  },
  30_000,
);

it.each(
  ['approve', 'onSafetyCheck'].flatMap((policyKind) =>
    [false, true].map((firstAllowed) => [policyKind, firstAllowed] as const),
  ),
)(
  'requires both borrowed-factory authorizations (%s, initial=%s)',
  async (policyKind, firstAllowed) => {
    const calls: string[] = [],
      driver = device(calls),
      create = vi.fn(() => driver);
    let decisions = 0;
    const policy = () => firstAllowed && ++decisions === 1;
    const server = new ModelServer([
      [
        computerCall({
          action: { type: 'wait' },
          pending_safety_checks:
            policyKind === 'onSafetyCheck' ? [{ id: 'screen' }] : [],
        }),
      ],
    ]);
    const selected = await provider(server);
    try {
      const agent = new Agent({
        instructions: 'Use computer.',
        provider: selected,
        tools: [computerTool({ computer: { create }, [policyKind]: policy })],
      });
      await expect(agent.run('wait')).rejects.toThrow(
        /not approved|require acknowledgment/,
      );
      expect(create).toHaveBeenCalledTimes(firstAllowed ? 1 : 0);
      expect(calls).toEqual([]);
    } finally {
      await selected.close();
    }
  },
  30_000,
);

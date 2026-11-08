import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  fileSessionStore,
  type SessionStore,
} from '../../src';
import { ModelServer } from './fixtures/model-server';

const directories: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-seeds',
    supportsWebsockets: false,
  });
}
function messages(snapshot: { items: readonly any[] }) {
  return snapshot.items.filter(
    (item) =>
      item.type === 'message' && ['user', 'assistant'].includes(item.role),
  );
}
it('round-trips seed identities without a turn or provider request', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({ instructions: 'Keep the conversation.', provider });
  const session = await agent.session({
    initialMessages: [
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'duplicate' },
      { role: 'user', content: 'duplicate' },
    ],
  });
  let initial: any[];
  let state;
  try {
    initial = messages(await session.modelContext());
    expect(initial.map((item) => item.role)).toEqual([
      'assistant',
      'assistant',
      'user',
    ]);
    expect(initial.map((item) => item.content[0].text)).toEqual([
      '',
      'duplicate',
      'duplicate',
    ]);
    expect(new Set(initial.map((item) => item.id)).size).toBe(3);
    const turns = [];
    for await (const turn of session.turns()) turns.push(turn);
    expect(turns).toEqual([]);
    state = await session.saveState();
  } finally {
    await session.close();
  }
  const restored = await agent.session({ state });
  try {
    expect(messages(await restored.modelContext())).toEqual(initial);
  } finally {
    await restored.close();
  }
  expect(server.requests).toEqual([]);
});
it.each([false, true])(
  'holds fresh publication and cleanup through the real seed flush (abort=%s)',
  async (abort) => {
    const path = await mkdtemp(join(tmpdir(), 'seed-fence-'));
    directories.push(path);
    const durable = fileSessionStore(path);
    let armed = false;
    let seedId = '';
    let seedFence = '';
    let entered = false;
    let released = false;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const storage: SessionStore = {
      ...durable,
      commit: async (...args) => {
        await durable.commit(...args);
        if (args[4].includes('seed-barrier-sentinel')) {
          armed = true;
          seedId = args[0];
          seedFence = args[1];
        }
      },
      flush: async (...args) => {
        if (armed && !entered) {
          entered = true;
          await gate;
        }
        await durable.flush?.(...args);
      },
      release: async (...args) => {
        await durable.release(...args);
        if (args[0] === seedId && args[1] === seedFence) released = true;
      },
    };
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Keep the conversation.',
      provider,
    });
    const controller = new AbortController();
    let settled = false;
    const opening = agent.session({
      storage,
      signal: controller.signal,
      initialMessages: [{ role: 'user', content: 'seed-barrier-sentinel' }],
    });
    void opening.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      expect(settled).toBe(false);
      if (abort) {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);
        expect(released).toBe(false);
      }
      finish();
      if (abort) {
        await expect(opening).rejects.toThrow();
        expect(released).toBe(true);
      } else {
        const session = await opening;
        try {
          expect(
            messages(await session.modelContext())[0].content[0].text,
          ).toBe('seed-barrier-sentinel');
        } finally {
          await session.close();
        }
      }
      expect(server.requests).toEqual([]);
    } finally {
      finish();
      const session = await opening.catch(() => undefined);
      await session?.close();
    }
  },
);
it('keeps the accepted durable seed on explicit recovery after a failed flush', async () => {
  const path = await mkdtemp(join(tmpdir(), 'seed-fail-'));
  directories.push(path);
  const durable = fileSessionStore(path);
  let armed = false;
  let failed = false;
  let id = '';
  let seedFence = '';
  let released = false;
  const storage: SessionStore = {
    ...durable,
    commit: async (...args) => {
      await durable.commit(...args);
      if (args[4].includes('seed-barrier-sentinel')) {
        armed = true;
        id = args[0];
        seedFence = args[1];
      }
    },
    flush: async (...args) => {
      if (armed && !failed) {
        failed = true;
        throw new Error('injected seed flush failure');
      }
      await durable.flush?.(...args);
    },
    release: async (...args) => {
      await durable.release(...args);
      if (args[0] === id && args[1] === seedFence) released = true;
    },
  };
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({ instructions: 'Keep the conversation.', provider });
  await expect(
    agent.session({
      storage,
      initialMessages: [{ role: 'user', content: 'seed-barrier-sentinel' }],
    }),
  ).rejects.toThrow();
  expect(failed && released).toBe(true);
  const restored = await agent.session({ storage, resume: id });
  try {
    const seeds = messages(await restored.modelContext());
    expect(seeds).toHaveLength(1);
    expect(seeds[0].content[0].text).toBe('seed-barrier-sentinel');
  } finally {
    await restored.close();
  }
  expect(server.requests).toEqual([]);
});

it('uses Core canonical inline preparation and retains it on portable restore', async () => {
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Keep the conversation.',
    model: 'gpt-5.5',
    provider,
  });
  const session = await agent.session({
    initialMessages: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'before-image' },
          { type: 'input_image', image_url: image },
          { type: 'input_text', text: 'after-image' },
        ],
      },
    ],
  });
  let seed: any;
  let state;
  try {
    [seed] = messages(await session.modelContext());
    expect(seed.content[0]).toEqual({
      type: 'input_text',
      text: 'before-image',
    });
    expect(seed.content[2]).toEqual({
      type: 'input_text',
      text: 'after-image',
    });
    expect(seed.content[1]).toMatchObject({
      type: 'input_image',
      image_url: expect.stringMatching(/^data:image\//),
    });
    // Core keeps the omitted default; High is its effective detail, not a wire rewrite.
    expect(seed.content[1].detail).toBeUndefined();
    const turns = [];
    for await (const turn of session.turns()) turns.push(turn);
    expect(turns).toEqual([]);
    state = await session.saveState();
  } finally {
    await session.close();
  }
  const restored = await agent.session({ state });
  try {
    expect(messages(await restored.modelContext())).toEqual([seed]);
  } finally {
    await restored.close();
  }
  expect(server.requests).toEqual([]);
});
it.each([{ resume: 'existing' }, { state: {} }])(
  'rejects empty seeds with restore before storage (%j)',
  async (opening) => {
    const path = await mkdtemp(join(tmpdir(), 'seed-invalid-'));
    directories.push(path);
    const durable = fileSessionStore(path);
    let acquisitions = 0;
    const storage = {
      ...durable,
      acquire: async (id: string) => {
        acquisitions++;
        return durable.acquire(id);
      },
    };
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Keep the conversation.',
      provider,
    });
    await expect(
      agent.session({ storage, ...opening, initialMessages: [] } as any),
    ).rejects.toThrow(/fresh/);
    expect(acquisitions).toBe(0);
    expect(server.requests).toEqual([]);
  },
);

it.each([
  { file_id: 'file-seed', filename: 'report.pdf' },
  { file_data: 'data:text/plain;base64,YQ==', filename: 'note.txt' },
  { file_data: 'data:text/plain;base64,YQ==', filename: '' },
  { file_url: 'https://example.invalid/report.pdf', filename: 'report.pdf' },
])(
  'retains opaque file seed source %j across portable restore',
  async (source) => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Keep the conversation.',
      model: 'gpt-5.5',
      provider,
    });
    const part = { type: 'input_file', ...source } as const;
    const session = await agent.session({
      initialMessages: [{ role: 'user', content: [part] }],
    });
    let seed: any;
    let state;
    try {
      [seed] = messages(await session.modelContext());
      expect(seed.content).toEqual([part]);
      state = await session.saveState();
    } finally {
      await session.close();
    }
    const restored = await agent.session({ state });
    try {
      expect(messages(await restored.modelContext())).toEqual([seed]);
    } finally {
      await restored.close();
    }
    expect(server.requests).toEqual([]);
  },
);
it('rejects a file seed on Lite before thread acquisition', async () => {
  const path = await mkdtemp(join(tmpdir(), 'seed-lite-'));
  directories.push(path);
  const durable = fileSessionStore(path);
  let acquisitions = 0;
  const storage = {
    ...durable,
    acquire: async (id: string) => {
      acquisitions++;
      return durable.acquire(id);
    },
  };
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Keep the conversation.',
    model: 'gpt-6.1-sol',
    provider,
  });
  await expect(
    agent.session({
      storage,
      initialMessages: [
        {
          role: 'user',
          content: [{ type: 'input_file', file_id: 'file-seed' }],
        },
      ],
    }),
  ).rejects.toThrow(/qualified standard Responses/);
  expect(acquisitions).toBe(0);
  expect(server.requests).toEqual([]);
});
it('admits a fresh empty batch without creating a model turn', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const session = await new Agent({
    instructions: 'Keep the conversation.',
    provider,
  }).session({ initialMessages: [] });
  try {
    expect(messages(await session.modelContext())).toEqual([]);
    const turns = [];
    for await (const turn of session.turns()) turns.push(turn);
    expect(turns).toEqual([]);
  } finally {
    await session.close();
  }
  expect(server.requests).toEqual([]);
});

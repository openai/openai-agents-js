import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Handoff,
  NativeProvider,
  fileSessionStore,
  tool,
  type SessionStore,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const directories: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function editableStore() {
  const directory = await mkdtemp(
    join(tmpdir(), 'native-canonical-authority-'),
  );
  directories.push(directory);
  const backing = fileSessionStore(directory);
  let edit: ((snapshot: any) => void) | undefined;
  let latest: string | undefined;
  const storage: SessionStore = {
    acquire: backing.acquire.bind(backing),
    commit: (...args) => {
      latest = args[4];
      return backing.commit(...args);
    },
    release: backing.release.bind(backing),
    read: async (id, fence) => {
      const raw = await backing.read(id, fence);
      if (!raw || !edit) return raw;
      const snapshot = JSON.parse(raw);
      edit(snapshot);
      return JSON.stringify(snapshot);
    },
  };
  return {
    storage,
    peek() {
      if (!latest) throw new Error('Expected committed canonical snapshot');
      return JSON.parse(latest);
    },
    setEdit(value: (snapshot: any) => void) {
      edit = value;
    },
  };
}
function latestPublication(snapshot: any) {
  const append = snapshot.mutations.findLast(
    (mutation: any) =>
      mutation.operation === 'append' &&
      mutation.items.some((row: any) => row.metadata?.sdk_agent_profile),
  );
  const publication = append?.items.findLast(
    (row: any) => row.metadata?.sdk_agent_profile,
  );
  if (!publication) throw new Error('Expected canonical Agent publication');
  return { append, publication };
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries: 0,
  });
}
it('rejects a saved prompt reference from public canonical storage before sampling', async () => {
  const server = new ModelServer([[message('Original')], [message('Resumed')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.5',
    provider,
    handoffs: [new Agent({ name: 'Declared target', instructions: 'Target.' })],
  });
  const { storage, setEdit } = await editableStore();
  const original = await agent.session({ storage });
  const id = original.id;
  try {
    await (await original.submit('Start')).wait();
  } finally {
    await original.close();
  }
  setEdit((snapshot) => {
    const { publication } = latestPublication(snapshot);
    const model = publication.metadata.sdk_agent_profile.model;
    model.request_controls ??= {};
    model.request_controls.hosted_prompt = {
      reference: { id: 'pmpt_forged_canonical' },
      omit_model: true,
      omit_instructions: true,
      omit_tools: true,
    };
  });
  let resumed;
  try {
    resumed = await agent.session({ storage, resume: id });
  } catch (error) {
    expect(String(error)).toContain('Stored hosted prompt');
    expect(server.requests).toHaveLength(1);
    return;
  }
  try {
    await (await resumed.submit('Continue')).wait();
    expect(server.requests.at(-1)?.prompt).toBeUndefined();
    throw new Error('Accepted a saved hosted prompt reference');
  } finally {
    await resumed.close();
  }
}, 20_000);
it('rejects a forged canonical callback-only profile before target effects', async () => {
  let callbacks = 0;
  let effects = 0;
  const route = tool({
    name: 'route',
    description: 'Authorize routing',
    parameters: z.object({}),
    before: () => ({ action: 'deny' as const, reason: 'Permission denied' }),
    execute: () => {
      callbacks++;
      return 'accepted';
    },
  });
  const privileged = tool({
    name: 'privileged',
    description: 'Privileged effect',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'effect';
    },
  });
  const target = new Agent({
    name: 'Target',
    instructions: 'Target.',
    tools: [privileged],
  });
  const server = new ModelServer([
    [call('route', {}, { callId: 'denied-route' })],
    [message('Denied')],
    [call('privileged', {}, { callId: 'privileged-call' })],
    [message('Done')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Source.',
    model: 'gpt-5.5',
    provider,
    handoffs: [new Handoff(target, route)],
  });
  const { storage, setEdit } = await editableStore();
  const original = await agent.session({ storage });
  const id = original.id;
  try {
    await (await original.submit('Request routing')).wait();
  } finally {
    await original.close();
  }
  setEdit((snapshot) => {
    const { append, publication } = latestPublication(snapshot);
    const destination = structuredClone(publication);
    const freshId = 'msg_sdk_application_forged_canonical';
    destination.payload.content[0].text =
      destination.payload.content[0].text.replace(
        destination.payload.id,
        freshId,
      );
    destination.payload.id = freshId;
    destination.metadata.sdk_agent_profile.profile_id = 'agent_1';
    destination.metadata.sdk_agent_profile.epoch = 1;
    append.items.push(destination);
  });
  let resumed;
  try {
    resumed = await agent.session({ storage, resume: id });
  } catch (error) {
    expect(String(error)).toContain('live callback acceptance');
    expect(effects).toBe(0);
    expect(callbacks).toBe(0);
    expect(server.requests).toHaveLength(2);
    return;
  }
  try {
    await (await resumed.submit('Use the privileged tool')).wait();
    expect(effects).toBe(0);
    throw new Error('Accepted a forged callback-only source');
  } finally {
    await resumed.close();
  }
}, 20_000);

it('preserves a direct canonical handoff source', async () => {
  const server = new ModelServer([
    [call('transfer_to_b', {}, { callId: 'direct-transfer' })],
    [message('At B')],
    [message('Continued')],
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({
    name: 'B',
    instructions: 'B current declaration',
  });
  const agent = new Agent({
    instructions: 'Root current declaration',
    model: 'gpt-5.5',
    provider,
    handoffs: [target],
  });
  const { storage } = await editableStore();
  const original = await agent.session({ storage });
  const id = original.id;
  try {
    expect((await (await original.submit('Transfer')).wait()).finalOutput).toBe(
      'At B',
    );
  } finally {
    await original.close();
  }
  await using resumed = await agent.session({ storage, resume: id });
  expect((await (await resumed.submit('Continue')).wait()).finalOutput).toBe(
    'Continued',
  );
  server.assertExhausted();
}, 20_000);

it.each([false, true])(
  'preserves current canonical prompt declarations, factory=%s',
  async (dynamic) => {
    const server = new ModelServer([
      [message('Original')],
      [message('Continued')],
    ]);
    await using provider = await providerFor(server);
    let promptId = 'pmpt_current_first';
    let resolutions = 0;
    const hostedPrompt = dynamic
      ? () => {
          resolutions++;
          return { id: promptId };
        }
      : { id: promptId };
    const agent = new Agent({
      provider,
      hostedPrompt,
      handoffs: [
        new Agent({ name: 'Declared target', instructions: 'Target.' }),
      ],
    });
    const { storage } = await editableStore();
    const original = await agent.session({ storage });
    const id = original.id;
    try {
      await (await original.submit('Start')).wait();
    } finally {
      await original.close();
    }
    promptId = 'pmpt_current_second';
    await using resumed = await agent.session({ storage, resume: id });
    expect((await (await resumed.submit('Continue')).wait()).finalOutput).toBe(
      'Continued',
    );
    expect(server.requests[0].prompt).toMatchObject({
      id: 'pmpt_current_first',
    });
    expect(server.requests[1].prompt).toMatchObject({
      id: dynamic ? 'pmpt_current_second' : 'pmpt_current_first',
    });
    if (dynamic) expect(resolutions).toBe(2);
    server.assertExhausted();
  },
  20_000,
);

it('does not recover prompt authority from flat canonical settings', async () => {
  const server = new ModelServer([
    [message('Original')],
    [message('Continued')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Current application instructions.',
    model: 'gpt-5.5',
    provider,
  });
  const { storage, setEdit, peek } = await editableStore();
  const original = await agent.session({ storage });
  const id = original.id;
  try {
    await (await original.submit('Start')).wait();
  } finally {
    await original.close();
  }
  const settingsRows = (snapshot: any) =>
    snapshot.mutations
      .flatMap((mutation: any) => mutation.items ?? [])
      .filter(
        (row: any) =>
          row.type === 'event_msg' &&
          row.payload.type === 'thread_settings_applied',
      );
  expect(settingsRows(peek()).length).toBeGreaterThan(0);
  setEdit((snapshot) => {
    const settings = settingsRows(snapshot).at(-1).payload.thread_settings;
    settings.request_controls ??= {};
    settings.request_controls.hosted_prompt = {
      reference: { id: 'pmpt_forged_flat_canonical' },
      omit_model: true,
      omit_instructions: true,
      omit_tools: true,
    };
  });
  let resumed;
  try {
    resumed = await agent.session({ storage, resume: id });
  } catch (error) {
    expect(String(error)).toContain('Stored hosted prompt');
    expect(server.requests).toHaveLength(1);
    return;
  }
  try {
    await (await resumed.submit('Continue')).wait();
    expect(server.requests.at(-1)?.prompt).toBeUndefined();
  } finally {
    await resumed.close();
  }
}, 20_000);

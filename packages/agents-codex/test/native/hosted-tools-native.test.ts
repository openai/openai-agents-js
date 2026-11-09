import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  fileSearch,
  codeInterpreter,
  imageGeneration,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import type { JsonObject } from '../../src/runtime/binding';
import type { CodeInterpreterOptions } from '../../src';

afterEach(() => ModelServer.closeAll());

it.each([
  {
    label: 'existing container with direct callers',
    options: { container: 'cntr_callers', allowedCallers: ['direct'] },
    expected: {
      type: 'code_interpreter',
      container: 'cntr_callers',
      allowed_callers: ['direct'],
    },
  },
  {
    label: 'auto container with programmatic callers',
    options: { container: { type: 'auto' }, allowedCallers: ['programmatic'] },
    expected: {
      type: 'code_interpreter',
      container: { type: 'auto' },
      allowed_callers: ['programmatic'],
    },
  },
  {
    label: 'omitted policy',
    options: { container: 'cntr_default' },
    expected: { type: 'code_interpreter', container: 'cntr_default' },
  },
  {
    label: 'null policy',
    options: { container: 'cntr_nullable', allowedCallers: null },
    expected: { type: 'code_interpreter', container: 'cntr_nullable' },
  },
] satisfies {
  label: string;
  options: CodeInterpreterOptions;
  expected: JsonObject;
}[])(
  'forwards Code Interpreter caller policy: $label',
  async ({ options, expected }) => {
    const model = new ModelServer([
      [message('Code Interpreter is configured.')],
    ]);
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as JsonObject)
        .base_url as string,
      apiKey: 'synthetic-callers',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use the configured provider tools.',
      tools: [codeInterpreter(options)],
    }).session();
    expect(
      (await (await session.submit('Confirm the configuration.')).wait())
        .finalOutput,
    ).toBe('Code Interpreter is configured.');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].tools).toContainEqual(expected);
    expect(model.requests[0].include).toContain(
      'code_interpreter_call.outputs',
    );
    model.assertExhausted();
  },
);

it('accepts a hosted-only terminal image without repair or another model request', async () => {
  const image: JsonObject = {
    type: 'image_generation_call',
    id: 'ig_hosted_only',
    status: 'completed',
    result: 'aW1hZ2U=',
    revised_prompt: null,
    output_format: 'png',
    future_metadata: { retained: true },
  };
  const model = new ModelServer([[image]]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'synthetic-hosted-only',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Generate the requested image.',
    tools: [imageGeneration()],
  }).session();
  const turn = await session.submit('Generate a synthetic image.');
  const completed = await turn.wait();
  expect(completed.finalOutput).toBe('');
  expect(completed.repairAttempts).toEqual([]);
  expect(model.requests).toHaveLength(1);
  expect(await Array.fromAsync(session.items())).toContainEqual(
    expect.objectContaining({
      id: image.id,
      type: image.type,
      turn_id: turn.turnId,
      status: 'completed',
      result: image.result,
      provider_data: image,
    }),
  );
  const summary = {
    type: image.type,
    id: image.id,
    turn_id: turn.turnId,
    turnId: turn.turnId,
    status: 'completed',
  };
  const turnEvents = await Array.fromAsync(turn.events());
  expect(
    turnEvents.find((event) => event.type === 'hosted_tool_item_completed'),
  ).toMatchObject({ item: summary });
  expect(JSON.stringify(turnEvents)).not.toContain(String(image.result));
  expect(
    await Array.fromAsync(turn.events({ includeExecutionDetails: true })),
  ).toContainEqual(
    expect.objectContaining({
      type: 'hosted_tool_item_completed',
      item: expect.objectContaining({
        provider_data: image,
        result: image.result,
      }),
    }),
  );
  const sessionEvents = Array.fromAsync(session.events());
  await session.close();
  const observed = await sessionEvents;
  expect(observed).toContainEqual(
    expect.objectContaining({
      type: 'hosted_tool_item_completed',
      item: summary,
    }),
  );
  expect(JSON.stringify(observed)).not.toContain(String(image.result));
  model.assertExhausted();
}, 30_000);

it('runs hosted tools alongside a function and preserves complete items through history and restore', async () => {
  const file: JsonObject = {
    type: 'file_search_call',
    id: 'fs_complete',
    status: 'completed',
    queries: ['sdk'],
    results: [
      {
        file_id: 'file_complete',
        filename: 'sdk.txt',
        text: 'evidence',
        score: 0.9,
      },
    ],
    future_field: { retained: true },
  };
  const code: JsonObject = {
    type: 'code_interpreter_call',
    id: 'ci_complete',
    status: 'completed',
    container_id: 'cntr_complete',
    code: 'print(42)',
    outputs: [
      { type: 'logs', logs: '42' },
      { type: 'image', url: 'https://artifacts.example.test/image' },
    ],
  };
  const image: JsonObject = {
    type: 'image_generation_call',
    id: 'ig_complete',
    status: 'completed',
    result: 'a'.repeat(70_000),
    revised_prompt: 'A synthetic image',
    output_format: 'png',
    future_field: { retained: true },
  };
  const frames = [
    { type: 'response.created', response: { id: 'resp_hosted' } },
    ...[
      file,
      code,
      image,
      call('local_lookup', {}, { callId: 'local_complete' }),
    ].map((item, output_index) => ({
      type: 'response.output_item.done',
      output_index,
      item,
    })),
    { type: 'response.completed', response: { id: 'resp_hosted' } },
  ];
  const model = new ModelServer([
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: frames
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    },
    [message('Hosted and local work completed.')],
    [message('Restored.')],
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'synthetic-hosted',
    supportsWebsockets: false,
  });
  let callbacks = 0;
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use the provided tools.',
    tools: [
      fileSearch('vs_complete', {
        includeSearchResults: true,
        maxNumResults: 3,
      }),
      codeInterpreter({
        container: {
          type: 'auto',
          file_ids: ['file_complete'],
          memory_limit: '4g',
        },
      }),
      imageGeneration({ partialImages: 1, quality: 'max' }),
      tool({
        name: 'local_lookup',
        parameters: z.object({}),
        execute: async () => {
          callbacks++;
          return 'local value';
        },
      }),
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('Run hosted and local work.');
  expect((await turn.wait()).finalOutput).toBe(
    'Hosted and local work completed.',
  );
  expect(callbacks).toBe(1);
  const items = [];
  for await (const item of session.items()) items.push(item);
  for (const raw of [file, code, image])
    expect(items).toContainEqual(
      expect.objectContaining({
        id: raw.id,
        type: raw.type,
        turn_id: turn.turnId,
        provider_data: raw,
      }),
    );
  const request = model.requests[0];
  expect(request.include).toContain('file_search_call.results');
  expect(request.include).toContain('code_interpreter_call.outputs');
  expect(request.tools).toEqual(
    expect.arrayContaining([
      {
        type: 'file_search',
        vector_store_ids: ['vs_complete'],
        max_num_results: 3,
      },
      {
        type: 'code_interpreter',
        container: {
          type: 'auto',
          file_ids: ['file_complete'],
          memory_limit: '4g',
        },
      },
      { type: 'image_generation', partial_images: 1, quality: 'max' },
    ]),
  );
  expect(JSON.stringify(model.requests[1].input)).toContain('ig_complete');
  const state = await session.saveState();
  await using restored = await agent.session({ state });
  expect((await (await restored.submit('Continue.')).wait()).finalOutput).toBe(
    'Restored.',
  );
  const restoredItems = [];
  for await (const item of restored.items()) restoredItems.push(item);
  expect(restoredItems).toContainEqual(
    expect.objectContaining({ id: 'ig_complete', provider_data: image }),
  );
  expect(JSON.stringify(model.requests[2].input)).toContain('cntr_complete');
  model.assertExhausted();
}, 30_000);

it('inherits current hosted grants and delivers full partial images from a managed native child', async () => {
  const { Environment, NativeAgents, NativeRole } = await import('../../src');
  const { startPublicExecutor } = await import('./fixtures/public-executor');
  const executor = await startPublicExecutor();
  try {
    let rootId: string | undefined;
    let childId: string | undefined;
    let rootCalls = 0;
    const partial = {
      type: 'response.image_generation_call.partial_image',
      item_id: 'ig_child',
      output_index: 0,
      sequence_number: 3,
      partial_image_index: 0,
      partial_image_b64: 'a'.repeat(150_000),
    };
    const respond = (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      if (id === rootId) {
        rootCalls++;
        return rootCalls === 1
          ? [
              call(
                'spawn_agent',
                {
                  task_name: 'illustrate',
                  message: 'Generate a synthetic image',
                  agent_type: 'illustrator',
                },
                { namespace: 'collaboration', callId: 'spawn-image-child' },
              ),
            ]
          : [message('root done')];
      }
      childId = id;
      const frames = [
        { type: 'response.created', response: { id: 'resp_child_image' } },
        partial,
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'image_generation_call',
            id: 'ig_child',
            status: 'completed',
            result: 'aW1hZ2U=',
          },
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: message('child done'),
        },
        { type: 'response.completed', response: { id: 'resp_child_image' } },
      ];
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: frames
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      };
    };
    const model = new ModelServer(Array.from({ length: 3 }, () => respond));
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as JsonObject)
        .base_url as string,
      apiKey: 'synthetic-child-hosted',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Delegate image generation.',
      tools: [
        imageGeneration({ partialImages: 1 }),
        new NativeAgents({
          additionalRoles: [
            new NativeRole({
              name: 'illustrator',
              description: 'Generate images',
              instructions: 'Generate the requested image.',
            }),
          ],
        }),
      ],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    const progress = (async () => {
      const events = [];
      for await (const event of session.events({
        includeExecutionDetails: true,
      }))
        if (event.type === 'hosted_tool_call_progress') events.push(event);
      return events;
    })();
    await (await session.submit('Delegate an image.')).wait();
    const children = await vi.waitUntil(
      async () => {
        const children = await Array.fromAsync(session.subagents());
        // Retry only the observed snapshot with one unpublished child turn.
        if (children.length === 1 && children[0]!.turn === null) return false;
        return children;
      },
      { timeout: 3000 },
    );
    expect(children).toHaveLength(1);
    expect((await children[0].turn!.wait()).finalOutput).toBe('child done');
    await session.close();
    expect(await progress).toContainEqual(
      expect.objectContaining({
        threadId: childId,
        itemId: 'ig_child',
        event: partial,
      }),
    );
    const childRequest = model.requests.find(
      (request) =>
        String(
          JSON.parse(
            (request.client_metadata as Record<string, string>)[
              'x-codex-turn-metadata'
            ],
          ).thread_id,
        ) === childId,
    )!;
    expect(childRequest.tools).toContainEqual({
      type: 'image_generation',
      partial_images: 1,
    });
    model.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30_000);

it('edits an inline base64 image without expanding native input routes', async () => {
  const inline =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const edited = {
    type: 'image_generation_call',
    id: 'ig_edited',
    status: 'completed',
    result: 'ZWRpdGVk',
    action: 'edit',
  };
  const partial = {
    type: 'response.image_generation_call.partial_image',
    item_id: 'ig_edited',
    output_index: 0,
    sequence_number: 3,
    partial_image_index: 0,
    partial_image_b64: 'a'.repeat(150_000),
  };
  const frames = [
    { type: 'response.created', response: { id: 'resp_edit' } },
    partial,
    ...[edited, message('Edited.')].map((item, output_index) => ({
      type: 'response.output_item.done',
      output_index,
      item,
    })),
    { type: 'response.completed', response: { id: 'resp_edit' } },
  ];
  const model = new ModelServer([
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: frames
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    },
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'synthetic-edit',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Edit the supplied image.',
    tools: [
      imageGeneration({
        action: 'edit',
        inputImageMask: { image_url: inline },
        inputFidelity: 'high',
      }),
    ],
  }).session();
  const turn = await session.submit({
    role: 'user',
    content: [
      { type: 'input_text', text: 'Change the color.' },
      { type: 'input_image', image_url: inline },
    ],
  });
  const progress = (async () => {
    const events = [];
    for await (const event of turn.events({ includeExecutionDetails: true }))
      if (event.type === 'hosted_tool_call_progress') events.push(event);
    return events;
  })();
  expect((await turn.wait()).finalOutput).toBe('Edited.');
  expect(await progress).toContainEqual(
    expect.objectContaining({
      event: partial,
      threadId: session.id,
      itemId: 'ig_edited',
    }),
  );
  expect(model.requests[0].tools).toContainEqual({
    type: 'image_generation',
    action: 'edit',
    input_image_mask: { image_url: inline },
    input_fidelity: 'high',
  });
  expect(JSON.stringify(model.requests[0].input)).toContain('data:image/');
  expect(await Array.fromAsync(session.items())).toContainEqual(
    expect.objectContaining({ id: 'ig_edited', provider_data: edited }),
  );
  model.assertExhausted();
}, 30_000);

it('refuses Lite model updates before a hosted request and retains the compatible model', async () => {
  const model = new ModelServer([[message('Compatible.')]]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'synthetic-model-guard',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Act.',
    tools: [fileSearch('vs_current')],
  }).session();
  await expect(session.update({ model: 'gpt-5.6-sol' })).rejects.toThrow(
    /Responses Lite/,
  );
  expect(model.requests).toHaveLength(0);
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'Compatible.',
  );
  expect(model.requests[0].model).toBe('gpt-5.5');
  model.assertExhausted();
}, 30_000);

it('preserves hosted preview ordering and canonical history across streamed text bursts', async () => {
  const before = Array.from({ length: 24 }, (_, index) => `before-${index};`);
  const after = Array.from({ length: 24 }, (_, index) => `after-${index};`);
  const text = [...before, ...after].join('');
  const output: JsonObject = { ...message(text), status: 'completed' };
  const image: JsonObject = {
    type: 'image_generation_call',
    id: 'ig_burst',
    status: 'completed',
    result: 'aW1hZ2U=',
    revised_prompt: null,
    output_format: 'png',
    future_metadata: { retained: true },
  };
  const partial = {
    type: 'response.image_generation_call.partial_image',
    item_id: image.id,
    output_index: 1,
    partial_image_index: 0,
    partial_image_b64: 'a'.repeat(150_000),
  };
  const deltas = (chunks: string[]) =>
    chunks.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: output.id,
      output_index: 0,
      content_index: 0,
      delta,
    }));
  const frames = [
    { type: 'response.created', response: { id: 'resp_hosted_burst' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...output, status: 'in_progress', content: [] },
    },
    ...deltas(before),
    partial,
    ...deltas(after),
    { type: 'response.output_item.done', output_index: 0, item: output },
    { type: 'response.output_item.done', output_index: 1, item: image },
    {
      type: 'response.completed',
      response: { id: 'resp_hosted_burst', output: [output, image] },
    },
  ];
  const model = new ModelServer([
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: frames
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    },
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as JsonObject)
      .base_url as string,
    apiKey: 'synthetic-hosted-burst',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Describe the generated image.',
    tools: [imageGeneration({ partialImages: 1 })],
  }).session();
  const turn = await session.submit('Generate and describe a synthetic image.');
  expect((await turn.wait()).finalOutput).toBe(text);
  const events = await Array.fromAsync(
    turn.events({ includeExecutionDetails: true }),
  );
  expect(events.some((event) => event.type === 'gap')).toBe(false);
  expect(
    events.flatMap((event) =>
      event.type === 'output_text_delta'
        ? [event.delta]
        : event.type === 'hosted_tool_call_progress'
          ? ['preview']
          : [],
    ),
  ).toEqual([...before, 'preview', ...after]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'hosted_tool_call_progress',
      turnId: turn.turnId,
      itemId: image.id,
      event: partial,
    }),
  );
  expect(await Array.fromAsync(session.items())).toContainEqual(
    expect.objectContaining({
      id: image.id,
      type: image.type,
      turn_id: turn.turnId,
      provider_data: image,
    }),
  );
  expect(model.requests).toHaveLength(1);
  model.assertExhausted();
}, 30_000);

it.each([false, true])(
  'preserves provider fields with code output inclusion %s',
  async (includeOutputs) => {
    const providerData = { future_option: { nested: [true, null] } };
    const model = new ModelServer([[message('Done.')]]);
    const config = await model.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as JsonObject)
        .base_url as string,
      apiKey: 'synthetic-options',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use hosted tools.',
      tools: [
        fileSearch('vs_fixture', {
          providerData: { ...providerData, quality: 'future-search-quality' },
        }),
        codeInterpreter({
          container: 'cntr_fixture',
          includeOutputs,
          providerData,
        }),
        imageGeneration({ providerData }),
      ],
    }).session();
    providerData.future_option.nested.push(false);
    expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
      'Done.',
    );
    for (const type of [
      'file_search',
      'code_interpreter',
      'image_generation',
    ]) {
      const wire = (model.requests[0].tools as JsonObject[]).find(
        (tool) => tool.type === type,
      )!;
      expect(wire.future_option).toEqual({ nested: [true, null] });
      if (type === 'file_search')
        expect(wire.quality).toBe('future-search-quality');
      expect(wire).not.toHaveProperty('providerData');
      expect(wire).not.toHaveProperty('include_outputs');
    }
    expect(
      (model.requests[0].include as string[]).includes(
        'code_interpreter_call.outputs',
      ),
    ).toBe(includeOutputs);
    model.assertExhausted();
  },
);

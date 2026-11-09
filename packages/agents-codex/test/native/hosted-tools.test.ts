import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonObject } from '../../src/runtime/binding';
import { codeInterpreter, fileSearch, imageGeneration, tool } from '../../src';
import { hostedToolSpecs } from '../../src/runtime/hosted-tools';
import {
  projectHostedToolItem,
  repairItemFromWire,
  projectNativeHostedToolItem,
  projectHistory,
} from '../../src/runtime/history';
import { splitToolDeclarations } from '../../src/runtime/mcp';
import { Session as OwnedSession } from '../../src/runtime/session';
import { captureTools } from '../../src/runtime/tools';
import type {
  Engine,
  JsonObject,
  NativeThread,
} from '../../src/runtime/binding';
import { vi } from 'vitest';

describe('native provider-hosted declarations', () => {
  it('captures nested configuration separately from local callbacks', () => {
    const stores = ['vs_synthetic'];
    const callers: ('direct' | 'programmatic')[] = ['direct'];
    const container = {
      type: 'auto' as const,
      file_ids: ['file_synthetic'],
      memory_limit: '4g' as const,
      network_policy: {
        type: 'allowlist' as const,
        allowed_domains: ['example.test'],
        domain_secrets: [
          {
            domain: 'example.test',
            name: 'SYNTHETIC_KEY',
            value: 'synthetic-value',
          },
        ],
      },
    };
    const mask = { image_url: 'data:image/png;base64,bWFzaw==' };
    const callback = tool({
      name: 'local_lookup',
      parameters: z.object({}),
      execute: async () => 'local',
    });
    const declarations = splitToolDeclarations([
      fileSearch(stores, {
        includeSearchResults: true,
        filters: { type: 'eq', key: 'team', value: 'sdk' },
      }),
      codeInterpreter({ container, allowedCallers: callers }),
      imageGeneration({
        action: 'edit',
        inputImageMask: mask,
        partialImages: 2,
        quality: 'max',
        model: 'gpt-image-2.5-sunburst',
        size: '1536x864',
      }),
      callback,
    ]);
    stores.push('vs_other');
    callers.push('programmatic');
    container.file_ids.push('file_other');
    mask.image_url = 'changed';
    expect(declarations.tools).toEqual([callback]);
    expect(hostedToolSpecs(declarations.hostedTools)).toEqual([
      {
        type: 'file_search',
        vector_store_ids: ['vs_synthetic'],
        include_search_results: true,
        filters: { type: 'eq', key: 'team', value: 'sdk' },
      },
      {
        type: 'code_interpreter',
        allowed_callers: ['direct'],
        container: {
          type: 'auto',
          file_ids: ['file_synthetic'],
          memory_limit: '4g',
          network_policy: {
            type: 'allowlist',
            allowed_domains: ['example.test'],
            domain_secrets: [
              {
                domain: 'example.test',
                name: 'SYNTHETIC_KEY',
                value: 'synthetic-value',
              },
            ],
          },
        },
      },
      {
        type: 'image_generation',
        action: 'edit',
        input_image_mask: { image_url: 'data:image/png;base64,bWFzaw==' },
        partial_images: 2,
        quality: 'max',
        model: 'gpt-image-2.5-sunburst',
        size: '1536x864',
      },
    ]);
    expect(Object.isFrozen(declarations.hostedTools[1])).toBe(true);
    expect(
      Object.isFrozen(
        (declarations.hostedTools[1] as ReturnType<typeof codeInterpreter>)
          .container,
      ),
    ).toBe(true);
  });

  it('keeps omitted provider defaults omitted', () => {
    expect(
      hostedToolSpecs([
        fileSearch('vs_synthetic'),
        codeInterpreter({ container: 'cntr_synthetic' }),
        imageGeneration(),
      ]),
    ).toEqual([
      { type: 'file_search', vector_store_ids: ['vs_synthetic'] },
      { type: 'code_interpreter', container: 'cntr_synthetic' },
      { type: 'image_generation' },
    ]);
  });

  it.each([
    fileSearch('vs_synthetic'),
    codeInterpreter({ container: { type: 'auto' } }),
    imageGeneration(),
  ])('reserves $kind without local dispatch', (hosted) => {
    expect(() => splitToolDeclarations([hosted, hosted])).toThrow('only once');
    const callback = tool({
      name: hosted.kind,
      parameters: z.object({}),
      execute: async () => 'wrong',
    });
    expect(() => splitToolDeclarations([hosted, callback])).toThrow('reserves');
  });
});

describe('provider hosted result fidelity', () => {
  it.each([
    { type: 'file_search_call', queries: ['sdk'], results: null },
    {
      type: 'code_interpreter_call',
      container_id: 'cntr_synthetic',
      code: null,
      outputs: null,
    },
    { type: 'image_generation_call', result: null },
  ])(
    'excludes only reserved Core metadata from $type provider_data',
    (fields) => {
      const original = jsonObject.parse({
        ...fields,
        id: 'hosted_synthetic',
        status: 'completed',
        future_metadata: {
          retained: true,
          internal_chat_message_metadata_passthrough: 'provider nested value',
        },
      });
      const recorded = {
        ...original,
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_core' },
      };
      const envelope: JsonObject =
        fields.type === 'image_generation_call'
          ? {
              type: 'ImageGeneration',
              id: original.id,
              provider_data: recorded,
            }
          : {
              type: 'hosted_tool_call',
              id: original.id,
              item: recorded,
            };
      for (const item of [
        projectHostedToolItem(recorded, 'turn_synthetic'),
        projectNativeHostedToolItem(envelope, 'turn_synthetic'),
      ]) {
        expect(item!.provider_data).toEqual(original);
        expect(item!.turn_id).toBe('turn_synthetic');
        expect(repairItemFromWire(JSON.parse(JSON.stringify(item)))).toEqual(
          expect.objectContaining({ provider_data: original }),
        );
      }
      expect(recorded.internal_chat_message_metadata_passthrough).toEqual({
        turn_id: 'turn_core',
      });
    },
  );

  it.each([
    {
      type: 'file_search_call',
      id: 'fs_synthetic',
      status: 'searching',
      queries: ['sdk'],
      results: [{ file_id: 'file_synthetic', text: 'retained', score: 0.9 }],
    },
    {
      type: 'code_interpreter_call',
      id: 'ci_synthetic',
      status: 'failed',
      container_id: 'cntr_synthetic',
      code: 'print(1)',
      outputs: [{ type: 'logs', logs: '1' }],
    },
    {
      type: 'image_generation_call',
      id: 'ig_synthetic',
      status: 'generating',
      result: 'a'.repeat(70_000),
      revised_prompt: 'A test image',
      output_format: 'png',
      future_metadata: { retained: true },
    },
  ])('retains $type through repair and caller mutation', (raw) => {
    const original = structuredClone(raw);
    const item = projectHostedToolItem(
      jsonObject.parse(raw),
      'turn_synthetic',
    )!;
    expect(item.id).toBe(raw.id);
    expect(item.turn_id).toBe('turn_synthetic');
    expect(item.status).toBe(raw.status);
    expect(item.provider_data).toEqual(original);
    raw.status = 'completed';
    expect(item.provider_data).toEqual(original);
    const restored = repairItemFromWire(JSON.parse(JSON.stringify(item)));
    expect(restored).toEqual(item);
  });
});

it('prefers complete image provider_data and replays legacy image events', () => {
  const original = {
    type: 'image_generation_call',
    id: 'ig_original',
    status: 'completed',
    result: null,
    output_format: 'png',
    future: { kept: true },
  };
  expect(
    projectNativeHostedToolItem(
      {
        type: 'ImageGeneration',
        id: 'ig_original',
        status: 'completed',
        result: null,
        provider_data: original,
        saved_path: '/not/provider/data',
      },
      'turn',
    ),
  ).toEqual(expect.objectContaining({ provider_data: original }));
  const legacy = projectNativeHostedToolItem(
    {
      type: 'ImageGeneration',
      id: 'ig_legacy',
      status: 'completed',
      result: 'aW1hZ2U=',
      revised_prompt: 'Legacy',
      provider_data: null,
      saved_path: '/old/local/path',
    },
    'turn',
  )!;
  expect(legacy.provider_data).toEqual({
    type: 'image_generation_call',
    id: 'ig_legacy',
    status: 'completed',
    result: 'aW1hZ2U=',
    revised_prompt: 'Legacy',
  });
});

it('keeps provider-native hosted items in canonical history', () => {
  const original = {
    type: 'file_search_call',
    id: 'fs_history',
    status: 'completed',
    queries: ['retained'],
    results: null,
    future: { kept: true },
  };
  const projected = projectHistory(
    [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      { type: 'response_item', payload: original },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn',
          item: { type: 'hosted_tool_call', id: original.id, item: original },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn',
          last_agent_message: 'Done',
        },
      },
    ],
    'thread',
  );
  expect(
    projected.items.filter((item) => item.id === original.id),
  ).toHaveLength(1);
  expect(projected.items).toContainEqual(
    expect.objectContaining({
      type: original.type,
      provider_data: original,
      turn_id: 'turn',
    }),
  );
});

it('rejects additions, removals, and changed hosted configuration on tool updates', async () => {
  const replace = vi.fn(async (generation: string) => generation);
  const thread = {
    id: 'root',
    _replace_tools: replace,
    _configure_manual_tools: vi.fn(),
  } as unknown as NativeThread;
  const grant = fileSearch('vs_current', { includeSearchResults: true });
  const session = new OwnedSession(
    {} as Engine,
    thread,
    captureTools([]),
    { hostedTools: [grant] },
    {},
  );
  await expect(session.update({ tools: [] })).rejects.toThrow('retain');
  await expect(
    session.update({ tools: [fileSearch('vs_other')] }),
  ).rejects.toThrow('retain');
  expect(replace).not.toHaveBeenCalled();
  await session.update({ tools: [grant] });
  expect(replace).toHaveBeenCalledOnce();
  const ungranted = new OwnedSession(
    {} as Engine,
    thread,
    captureTools([]),
    {},
    {},
  );
  await expect(ungranted.update({ tools: [grant] })).rejects.toThrow('retain');
});

it('rejects provider fields that replace an admitted hosted identity', () => {
  expect(() =>
    hostedToolSpecs([imageGeneration({ providerData: { type: 'computer' } })]),
  ).toThrow('cannot replace declared fields');
});

it('preserves provider fields declared by a different hosted kind', () => {
  expect(
    hostedToolSpecs([
      fileSearch('vs_synthetic', {
        providerData: { quality: 'future-search-quality' },
      }),
    ]),
  ).toEqual([
    {
      type: 'file_search',
      vector_store_ids: ['vs_synthetic'],
      quality: 'future-search-quality',
    },
  ]);
});

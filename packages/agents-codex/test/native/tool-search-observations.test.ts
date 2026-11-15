import { expect, it } from 'vitest';
import { projectNativeHostedToolItem } from '../../src/runtime/history';
import { ObservationBuffer } from '../../src/runtime/observation';

it('preserves provider identity and summarizes search payloads by default', async () => {
  const raw = {
    type: 'tool_search_call',
    id: 'reused-provider-id',
    call_id: 'private-call',
    execution: 'client',
    status: 'completed',
    arguments: { query: 'private-query' },
    internal_chat_message_metadata_passthrough: { private: 'internal' },
  };
  const item = projectNativeHostedToolItem(
    { type: 'hosted_tool_call', id: 'native-1', item: raw },
    'turn',
  )!;
  expect(item.id).toBe('reused-provider-id');
  expect(item.provider_data.id).toBe('reused-provider-id');
  expect(item.provider_data).not.toHaveProperty(
    'internal_chat_message_metadata_passthrough',
  );
  const buffer = new ObservationBuffer('session');
  buffer.append({
    type: 'hosted_tool_item_completed',
    turnId: 'turn',
    submissionId: 'submit',
    item,
  });
  buffer.finish('closed');
  const ordinary = await Array.fromAsync(buffer.events());
  expect(ordinary).toContainEqual(
    expect.objectContaining({
      item: {
        type: 'tool_search_call',
        id: 'reused-provider-id',
        status: 'completed',
        turnId: 'turn',
        turn_id: 'turn',
      },
    }),
  );
  expect(JSON.stringify(ordinary)).not.toContain('private-');
  const details = await Array.fromAsync(
    buffer.events({ includeExecutionDetails: true }),
  );
  expect(details).toContainEqual(
    expect.objectContaining({
      item: expect.objectContaining({ arguments: { query: 'private-query' } }),
    }),
  );
  (item.provider_data.arguments as { query: string }).query = 'changed';
  expect(raw.arguments.query).toBe('private-query');
});

it('projects native-generated search outputs without inventing a provider identity', () => {
  const raw = {
    type: 'tool_search_output',
    call_id: 'search',
    execution: 'client',
    tools: [{ type: 'namespace', name: 'functions', tools: [] }],
  };
  const item = projectNativeHostedToolItem(
    { type: 'hosted_tool_call', id: 'native-output', item: raw },
    'turn',
  )!;
  expect(item).toMatchObject({
    type: 'tool_search_output',
    id: 'native-output',
    call_id: 'search',
    tools: raw.tools,
    status: 'completed',
  });
  expect(item.provider_data).not.toHaveProperty('id');
  expect(
    projectNativeHostedToolItem(
      { type: 'hosted_tool_call', item: raw },
      'turn',
    ),
  ).toBeUndefined();
});

it('keeps anonymous server search occurrences distinct', () => {
  const raw = {
    type: 'tool_search_call',
    call_id: null,
    execution: 'server',
    arguments: { paths: ['scope'] },
  };
  const first = projectNativeHostedToolItem(
    { type: 'hosted_tool_call', id: 'native-first', item: raw },
    'turn',
  );
  const second = projectNativeHostedToolItem(
    { type: 'hosted_tool_call', id: 'native-second', item: raw },
    'turn',
  );
  expect(first).toMatchObject({
    id: 'native-first',
    call_id: null,
    callId: null,
    provider_data: raw,
  });
  expect(first?.provider_data).not.toHaveProperty('id');
  expect(second).toMatchObject({ id: 'native-second' });
});

it('keeps wrapper identity fallback bounded to admitted semantic kinds', () => {
  expect(
    projectNativeHostedToolItem(
      {
        type: 'hosted_tool_call',
        id: 'wrapper',
        item: {
          type: 'image_generation_call',
          status: 'completed',
          result: 'private',
        },
      },
      'turn',
    ),
  ).toBeUndefined();
  expect(
    projectNativeHostedToolItem(
      {
        type: 'hosted_tool_call',
        id: 'wrapper',
        item: { type: 'future_unknown', status: 'completed' },
      },
      'turn',
    ),
  ).toBeUndefined();
  expect(
    projectNativeHostedToolItem(
      {
        type: 'hosted_tool_call',
        id: 'wrapper',
        item: {
          type: 'tool_search_output',
          call_id: 'search',
          execution: 'client',
          tools: 'malformed',
        },
      },
      'turn',
    ),
  ).toBeUndefined();
});

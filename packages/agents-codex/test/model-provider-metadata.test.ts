import { expect, it } from 'vitest';
import {
  bindModelProviderMetadata,
  captureModelProviderMetadata,
  replayModelProviderMetadata,
  retainModelProviderMetadata,
  retainModelProviderStreamFrame,
  captureModelProviderStreamFrame,
  mergeModelProviderMetadata,
} from '../src/runtime/model-provider-metadata';
const item = {
  type: 'function_call',
  call_id: 'same',
  name: 'lookup',
  arguments: '{}',
};
const value = (continuation: string) => ({ fixture: { continuation } });
const entry = (input_index: number, continuation: string) => ({
  input_index,
  item,
  metadata: {
    provider: 'fixture.metadata',
    model: 'fixture',
    value: value(continuation),
  },
});
it('keeps duplicate output occurrences distinct and snapshots mutable metadata', () => {
  const response = { output: [{ ...item }, { ...item }] };
  const first = value('first');
  retainModelProviderMetadata(response, 'fixture.metadata', 'fixture', [
    { outputIndex: 0, value: first },
    { outputIndex: 1, value: value('second') },
  ]);
  first.fixture.continuation = 'changed';
  const captured = captureModelProviderMetadata(response)!;
  expect(
    captured.map((entry: any) => entry.metadata.value.fixture.continuation),
  ).toEqual(['first', 'second']);
  expect(JSON.stringify(response)).not.toContain('continuation');
  expect(
    captureModelProviderMetadata({ output: [{ ...item }, { ...item }] }),
  ).toBeUndefined();
  response.output[0].arguments = '{"changed":true}';
  expect(() => captureModelProviderMetadata(response)).toThrow(
    'changed before settlement',
  );
});
it('replays only the exact current request occurrence and matching provider/model', () => {
  const request = {};
  const source = [entry(0, 'first'), entry(1, 'second')];
  bindModelProviderMetadata(request, source);
  source[0].metadata.value.fixture.continuation = 'changed';
  expect(
    replayModelProviderMetadata(
      request,
      0,
      item,
      'fixture.metadata',
      'fixture',
    ),
  ).toEqual(value('first'));
  expect(
    replayModelProviderMetadata(
      request,
      1,
      item,
      'fixture.metadata',
      'fixture',
    ),
  ).toEqual(value('second'));
  expect(
    replayModelProviderMetadata({}, 0, item, 'fixture.metadata', 'fixture'),
  ).toBeUndefined();
  expect(
    replayModelProviderMetadata(request, 0, item, 'other.metadata', 'fixture'),
  ).toBeUndefined();
  expect(
    replayModelProviderMetadata(request, 0, item, 'fixture.metadata', 'other'),
  ).toBeUndefined();
  expect(
    replayModelProviderMetadata(
      request,
      0,
      { ...item, arguments: '{"edited":true}' },
      'fixture.metadata',
      'fixture',
    ),
  ).toBeUndefined();
});
it('rejects ambiguous and oversized response metadata without publishing it', () => {
  const response = { output: [item] };
  expect(() =>
    retainModelProviderMetadata(response, 'fixture.metadata', 'fixture', [
      { outputIndex: 0, value: value('a') },
      { outputIndex: 0, value: value('b') },
    ]),
  ).toThrow();
  expect(captureModelProviderMetadata(response)).toBeUndefined();
  expect(() =>
    retainModelProviderMetadata(response, 'fixture.metadata', 'fixture', [
      { outputIndex: 0, value: value('x'.repeat(8 * 1024 * 1024)) },
    ]),
  ).toThrow('response limit');
  expect(captureModelProviderMetadata(response)).toBeUndefined();
});

it('keeps streamed sidecars off public frames and preserves exact output indexes', () => {
  const response = { output: [item] };
  retainModelProviderMetadata(response, 'fixture.metadata', 'fixture', [
    { outputIndex: 0, value: value('owned') },
  ]);
  const frame = {
    type: 'response.output_item.done',
    output_index: 0,
    item: { ...item, id: 'native-item' },
  };
  retainModelProviderStreamFrame(frame, response, 0);
  expect(JSON.stringify(frame)).not.toContain('continuation');
  const wire = JSON.parse(
    captureModelProviderStreamFrame(JSON.stringify(frame), frame),
  );
  expect(wire.__sdk_model_provider_metadata.metadata.value).toEqual(
    value('owned'),
  );
  expect(
    captureModelProviderStreamFrame(JSON.stringify({ ...frame }), { ...frame }),
  ).toBe(JSON.stringify(frame));
  expect(() =>
    retainModelProviderStreamFrame(
      { ...frame, item: { ...frame.item, arguments: '{"changed":true}' } },
      response,
      0,
    ),
  ).toThrow();
});
it('preserves serialized tool arguments and rejects post-capture frame mutation', () => {
  const source = { ...item, arguments: '{"synthetic":9007199254740993}' };
  const response = { output: [source] };
  retainModelProviderMetadata(response, 'fixture.metadata', 'fixture', [
    { outputIndex: 0, value: value('owned') },
  ]);
  const frame = {
    type: 'response.output_item.done',
    output_index: 0,
    item: { ...source, id: 'native-item' },
  };
  retainModelProviderStreamFrame(frame, response, 0);
  const encoded = JSON.stringify(frame);
  expect(captureModelProviderStreamFrame(encoded, frame)).toContain(
    '9007199254740993',
  );
  frame.item.arguments = '{"edited":true}';
  expect(() =>
    captureModelProviderStreamFrame(JSON.stringify(frame), frame),
  ).toThrow('changed before settlement');
});
it('merges complete opaque provider namespaces without changing prototypes', () => {
  const first = {
    openai: { itemId: 'rs', reasoningEncryptedContent: 'synthetic-opaque' },
  };
  const next = JSON.parse(
    '{"openai":{"itemId":"rs"},"__proto__":{"synthetic":true}}',
  );
  const merged = mergeModelProviderMetadata(first, next)!;
  expect((merged.openai as any).reasoningEncryptedContent).toBe(
    'synthetic-opaque',
  );
  expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  expect(Object.hasOwn(merged, '__proto__')).toBe(true);
});

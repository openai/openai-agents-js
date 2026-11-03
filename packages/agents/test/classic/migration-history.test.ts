import { describe, expect, it } from 'vitest';
import { MemorySession } from '@openai/agents-core';
import type {
  AgentInputItem,
  AssistantMessageItem,
  UserMessageItem,
} from '@openai/agents-core/types';
import { captureCompletedHistory } from '../../src/migration/history';

const call = {
  type: 'function_call',
  callId: 'c1',
  name: 'effect',
  arguments: '{}',
} as const;
const result = {
  type: 'function_call_result',
  callId: 'c1',
  name: 'effect',
  status: 'completed',
  output: 'done',
} as const;
const answer = {
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'finished' }],
} as const;
const history = (): AgentInputItem[] => [
  { role: 'user', content: 'do it' },
  { ...call },
  { ...result },
  { ...answer, content: [{ type: 'output_text', text: 'finished' }] },
];
const capture = (items: unknown[]) =>
  captureCompletedHistory(items as AgentInputItem[]);
const inlinePng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const imagePart = { type: 'input_image', image: inlinePng } as const;

describe('completed migration history admission', () => {
  it('preserves ordered Session history without mutating or writing the store', async () => {
    const session = new MemorySession({ initialItems: history() });
    const items = await session.getItems();
    const snapshot = captureCompletedHistory(items);
    expect(snapshot).toEqual(items);
    expect(snapshot).not.toBe(items);
    (items[0] as { content: string }).content = 'mutated';
    expect(snapshot[0]).toEqual({ role: 'user', content: 'do it' });
    expect(await session.getItems()).toEqual(history());
  });

  it('isolates nested snapshots in both directions and separate histories', () => {
    const source = history();
    const a = captureCompletedHistory(source);
    const b = captureCompletedHistory(source);
    const item = a[3] as AssistantMessageItem;
    (item.content[0] as { text: string }).text = 'changed';
    expect(b).toEqual(history());
    expect(source).toEqual(history());
    expect(captureCompletedHistory([])).toEqual([]);
  });

  it('preserves completed assistant commentary before a matching result', () => {
    const items = [
      { ...call },
      { ...answer, phase: 'commentary' },
      { ...result },
    ];
    expect(capture(items)).toEqual(items);
  });

  it('isolates nested text tool output from its source', () => {
    const output = { type: 'text', text: 'done' };
    const source = [{ ...call }, { ...result, output }];
    const snapshot = capture(source);
    output.text = 'changed';
    expect(snapshot[1]).toMatchObject({
      output: { type: 'text', text: 'done' },
    });
    expect(source[1]).toMatchObject({ output: { text: 'changed' } });
  });

  it('retains inert Responses metadata in detached completed history', () => {
    const annotation = {
      type: 'url_citation',
      start_index: 0,
      end_index: 8,
      title: 'Fixture',
      url: 'https://fixture.invalid/source',
    };
    const items = [
      {
        ...call,
        id: 'fc_c1',
        providerData: { id: 'fc_c1', type: 'function_call' },
      },
      { ...result },
      {
        ...answer,
        phase: 'final_answer',
        providerData: { phase: 'final_answer' },
        content: [
          {
            type: 'output_text',
            text: 'finished',
            providerData: { annotations: [annotation], logprobs: [] },
          },
        ],
      },
    ];
    const snapshot = capture(items);
    expect(snapshot).toEqual(items);
    annotation.title = 'changed';
    expect(snapshot[2]).toMatchObject({
      content: [{ providerData: { annotations: [{ title: 'Fixture' }] } }],
    });
  });

  it.each([undefined, 'auto'] as const)(
    'snapshots ordered user images with default detail %s and completed pairs',
    (detail) => {
      const before = { type: 'input_text' as const, text: 'before image' };
      const image = {
        type: 'input_image' as const,
        image: inlinePng,
        ...(detail === undefined ? {} : { detail }),
        providerData: { type: 'input_image' },
      };
      const message = {
        type: 'message' as const,
        role: 'user' as const,
        id: 'image-user',
        providerData: { id: 'image-user', type: 'message' },
        content: [
          before,
          image,
          { type: 'input_text' as const, text: 'after image' },
        ],
      };
      const source: AgentInputItem[] = [message, ...history().slice(1)];
      const expected = structuredClone(source);
      const first = captureCompletedHistory(source);
      const second = captureCompletedHistory(source);
      expect(first).toEqual(expected);
      before.text = 'changed source text';
      image.image = 'https://fixture.invalid/changed.png';
      image.providerData.type = 'changed source metadata';
      message.id = 'changed source id';
      message.providerData.id = 'changed source metadata';
      expect(first).toEqual(expected);
      expect(second).toEqual(expected);

      const copied = first[0] as UserMessageItem;
      if (!Array.isArray(copied.content))
        throw new Error('Expected image parts');
      const copiedImage = copied.content[1];
      if (copiedImage.type !== 'input_image')
        throw new Error('Expected an image');
      copiedImage.image = 'changed snapshot';
      copiedImage.providerData!.type = 'changed snapshot metadata';
      expect(second).toEqual(expected);
      expect(message.id).toBe('changed source id');
      expect(image.image).toBe('https://fixture.invalid/changed.png');
    },
  );

  it.each([
    {
      name: 'remote URL',
      part: { ...imagePart, image: 'https://fixture.invalid/image.png' },
    },
    {
      name: 'file reference',
      part: { ...imagePart, image: { id: 'file-image' } },
    },
    { name: 'missing image', part: { type: 'input_image' } },
    {
      name: 'noncanonical base64',
      part: { ...imagePart, image: 'data:image/png;base64,YQ' },
    },
    { name: 'nondefault detail', part: { ...imagePart, detail: 'high' } },
    { name: 'null detail', part: { ...imagePart, detail: null } },
    { name: 'extra wire alias', part: { ...imagePart, image_url: inlinePng } },
    {
      name: 'cache marker',
      part: { ...imagePart, promptCacheBreakpoint: { mode: 'explicit' } },
    },
    {
      name: 'effect metadata',
      part: { ...imagePart, providerData: { approval: 'pending' } },
    },
  ])('rejects user images with $name', ({ part }) => {
    expect(() => capture([{ role: 'user', content: [part] }])).toThrow(
      TypeError,
    );
  });

  it('accepts parallel calls and reverse result order without reordering', () => {
    const items = [
      { ...call },
      { ...call, callId: 'c2' },
      { ...result, callId: 'c2' },
      { ...result },
    ];
    expect(capture(items)).toEqual(items);
  });

  it.each([
    'done',
    { type: 'text', text: 'done' },
    [{ type: 'input_text', text: 'done' }],
  ])('preserves supported text tool output %j', (output) => {
    const items = [{ ...call }, { ...result, output }];
    expect(capture(items)).toEqual(items);
  });

  it.each([
    [{ ...call }],
    [{ ...result }],
    [{ ...result }, { ...call }],
    [{ ...call }, { ...call }, { ...result }],
    [{ ...call }, { ...result }, { ...result }],
    [{ ...call }, { ...result, name: 'different' }],
    [{ ...call, namespace: 'functions' }, { ...result }],
    [{ ...call }, { role: 'user', content: 'next' }, { ...result }],
    [{ ...call }, { role: 'user', content: [{ ...imagePart }] }, { ...result }],
    [{ ...call, status: 'in_progress' }, { ...result }],
    [{ ...call }, { ...result, status: 'incomplete' }],
    [{ ...answer, status: 'in_progress' }],
    [{ type: 'tool_approval_request', id: 'approval' }],
    [{ type: 'item_reference', id: 'remote' }],
    [{ role: 'user', content: [{ type: 'input_image', image: 'remote' }] }],
    [{ ...answer, content: [{ ...imagePart }] }],
    [{ ...answer, content: [{ type: 'image', image: inlinePng }] }],
    [{ role: 'user', content: [{ type: 'audio', audio: 'YQ==' }] }],
    [{ role: 'user', content: [{ type: 'input_file', file: 'file-data' }] }],
    [{ ...call }, { ...result, output: { type: 'image', image: 'remote' } }],
    [{ ...call }, { ...result, output: { type: 'image', image: inlinePng } }],
    [{ role: 'user', content: 'hi', phase: { approval: 'pending' } }],
    [{ role: 'user', content: 'hi', status: 'completed' }],
    [{ ...answer, providerData: { approval: 'pending' } }],
    [{ ...answer, providerData: { type: 'function_call' } }],
    [{ role: 'user', content: 'hello', status: 'in_progress' }],
    [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'hi', unknown: 'state' }],
      },
    ],
  ])('rejects unsupported or unsettled history %j', (...items) => {
    expect(() => capture(items)).toThrow();
  });
});

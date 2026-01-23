import { describe, expect, test } from 'vitest';
import type { RunStreamEvent } from '@openai/agents';
import {
  ChatKitResponseStreamConverter,
  createChatKitSseResponse,
  createChatKitTextMessageDoneEvent,
  streamChatKitEvents,
} from '../../src/chatkit/index';

async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const item of iterable) {
    output.push(item);
  }
  return output;
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

function rawModelEvent(event: Record<string, unknown>): RunStreamEvent {
  return {
    type: 'raw_model_stream_event',
    data: {
      type: 'model',
      event,
    },
  } as RunStreamEvent;
}

describe('streamChatKitEvents', () => {
  test('maps response text events into thread item updates', async () => {
    async function* source(): AsyncIterable<RunStreamEvent> {
      yield rawModelEvent({
        type: 'response.output_item.added',
        item: { type: 'message', id: 'msg_1', content: [] },
      });
      yield rawModelEvent({
        type: 'response.content_part.added',
        item_id: 'msg_1',
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      yield rawModelEvent({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        content_index: 0,
        delta: 'Hello ',
      });
      yield rawModelEvent({
        type: 'response.output_text.annotation.added',
        item_id: 'msg_1',
        content_index: 0,
        annotation: {
          type: 'file_citation',
          filename: 'file.txt',
          index: 5,
        },
      });
      yield rawModelEvent({
        type: 'response.output_text.done',
        item_id: 'msg_1',
        content_index: 0,
        text: 'Hello world',
      });
      yield rawModelEvent({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: 'msg_1',
          content: [
            {
              type: 'output_text',
              text: 'Hello world',
              annotations: [
                { type: 'file_citation', filename: 'file.txt', index: 5 },
              ],
            },
          ],
        },
      });
    }

    const events = await collectEvents(
      streamChatKitEvents(source(), {
        threadId: 'thread_1',
        includeStreamOptions: false,
      }),
    );

    const addedEvent = events.find(
      (event) => event.type === 'thread.item.added',
    );
    expect(addedEvent?.type).toBe('thread.item.added');
    if (addedEvent?.type === 'thread.item.added') {
      expect(addedEvent.item.type).toBe('assistant_message');
      expect(addedEvent.item.id).toBe('msg_1');
    }

    const annotationEvent = events.find(
      (event) =>
        event.type === 'thread.item.updated' &&
        event.update.type === 'assistant_message.content_part.annotation_added',
    );
    expect(annotationEvent?.type).toBe('thread.item.updated');
    if (annotationEvent?.type === 'thread.item.updated') {
      const update = annotationEvent.update;
      if (update.type === 'assistant_message.content_part.annotation_added') {
        expect(update.annotation_index).toBe(0);
        expect(update.annotation.source.type).toBe('file');
      }
    }

    const contentPartDoneEvent = events.find(
      (event) =>
        event.type === 'thread.item.updated' &&
        event.update.type === 'assistant_message.content_part.done',
    );
    expect(contentPartDoneEvent?.type).toBe('thread.item.updated');
    if (contentPartDoneEvent?.type === 'thread.item.updated') {
      const update = contentPartDoneEvent.update;
      if (update.type === 'assistant_message.content_part.done') {
        expect(update.content.annotations.length).toBe(1);
        expect(update.content.annotations[0]?.source.type).toBe('file');
      }
    }

    const doneEvent = events.find((event) => event.type === 'thread.item.done');
    expect(doneEvent?.type).toBe('thread.item.done');
    if (doneEvent?.type === 'thread.item.done') {
      const item = doneEvent.item;
      if (item.type === 'assistant_message') {
        expect(item.content[0]?.text).toBe('Hello world');
        expect(item.content[0]?.annotations.length).toBe(1);
      }
    }
  });

  test('respects createdAt option across message added and done events', async () => {
    const createdAt = '2024-01-02T03:04:05.000Z';
    async function* source(): AsyncIterable<RunStreamEvent> {
      yield rawModelEvent({
        type: 'response.output_item.added',
        item: { type: 'message', id: 'msg_created_at', content: [] },
      });
      yield rawModelEvent({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: 'msg_created_at',
          content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
        },
      });
    }

    const events = await collectEvents(
      streamChatKitEvents(source(), {
        threadId: 'thread_created_at',
        createdAt,
        includeStreamOptions: false,
      }),
    );

    const addedEvent = events.find(
      (event) => event.type === 'thread.item.added',
    );
    expect(addedEvent?.type).toBe('thread.item.added');
    if (addedEvent?.type === 'thread.item.added') {
      expect(addedEvent.item.created_at).toBe(createdAt);
    }

    const doneEvent = events.find((event) => event.type === 'thread.item.done');
    expect(doneEvent?.type).toBe('thread.item.done');
    if (doneEvent?.type === 'thread.item.done') {
      expect(doneEvent.item.created_at).toBe(createdAt);
    }
  });

  test('maps generated image events with progress', async () => {
    async function* source(): AsyncIterable<RunStreamEvent> {
      yield rawModelEvent({
        type: 'response.output_item.added',
        item: { type: 'image_generation_call', id: 'img_1' },
      });
      yield rawModelEvent({
        type: 'response.image_generation_call.partial_image',
        item_id: 'img_1',
        partial_image_b64: 'dGVzdA==',
        partial_image_index: 1,
      });
      yield rawModelEvent({
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          id: 'img_1',
          result: 'dGVzdA==',
        },
      });
    }

    const converter = new ChatKitResponseStreamConverter({ partialImages: 3 });
    const events = await collectEvents(
      streamChatKitEvents(source(), {
        threadId: 'thread_1',
        includeStreamOptions: false,
        converter,
      }),
    );

    const added = events[0];
    expect(added?.type).toBe('thread.item.added');
    if (added?.type !== 'thread.item.added') {
      return;
    }
    expect(added.item.type).toBe('generated_image');
    const imageItemId = added.item.id;

    const updated = events[1];
    expect(updated?.type).toBe('thread.item.updated');
    if (updated?.type === 'thread.item.updated') {
      expect(updated.item_id).toBe(imageItemId);
      if (updated.update.type === 'generated_image.updated') {
        expect(updated.update.progress).toBeCloseTo(2 / 3, 5);
        expect(updated.update.image.url).toContain('data:image/png');
      }
    }

    const done = events[2];
    expect(done?.type).toBe('thread.item.done');
    if (done?.type === 'thread.item.done') {
      expect(done.item.type).toBe('generated_image');
      expect(done.item.id).toBe(imageItemId);
      if (done.item.type === 'generated_image') {
        expect(done.item.image?.url).toContain('data:image/png');
      }
    }
  });

  test('passes partial image index to the converter', async () => {
    async function* source(): AsyncIterable<RunStreamEvent> {
      yield rawModelEvent({
        type: 'response.output_item.added',
        item: { type: 'image_generation_call', id: 'img_2' },
      });
      yield rawModelEvent({
        type: 'response.image_generation_call.partial_image',
        item_id: 'img_2',
        partial_image_b64: 'dGVzdA==',
        partial_image_index: 2,
      });
    }

    class IndexAwareConverter extends ChatKitResponseStreamConverter {
      seenPartialIndex: number | null = null;

      override async base64ImageToUrl(
        base64Image: string,
        partialImageIndex?: number | null,
      ): Promise<string> {
        this.seenPartialIndex = partialImageIndex ?? null;
        return super.base64ImageToUrl(base64Image, partialImageIndex);
      }
    }

    const converter = new IndexAwareConverter({ partialImages: 3 });
    const events = await collectEvents(
      streamChatKitEvents(source(), {
        threadId: 'thread_1',
        includeStreamOptions: false,
        converter,
      }),
    );

    const updated = events[1];
    expect(updated?.type).toBe('thread.item.updated');
    expect(converter.seenPartialIndex).toBe(2);
  });

  test('streams reasoning summary tasks into workflow updates', async () => {
    async function* source(): AsyncIterable<RunStreamEvent> {
      yield rawModelEvent({
        type: 'response.output_item.added',
        item: { type: 'reasoning', id: 'resp_1', summary: [] },
      });
      yield rawModelEvent({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'resp_1',
        summary_index: 0,
        delta: 'Think',
      });
      yield rawModelEvent({
        type: 'response.reasoning_summary_text.done',
        item_id: 'resp_1',
        summary_index: 0,
        text: 'Thinking',
      });
      yield rawModelEvent({
        type: 'response.reasoning_summary_text.done',
        item_id: 'resp_1',
        summary_index: 1,
        text: 'Next',
      });
    }

    const events = await collectEvents(
      streamChatKitEvents(source(), {
        threadId: 'thread_1',
        includeStreamOptions: false,
      }),
    );

    expect(events[0]?.type).toBe('thread.item.added');
    const firstUpdate = events[1];
    expect(firstUpdate?.type).toBe('thread.item.updated');
    if (firstUpdate?.type === 'thread.item.updated') {
      expect(firstUpdate.update.type).toBe('workflow.task.added');
      if (firstUpdate.update.type === 'workflow.task.added') {
        expect(firstUpdate.update.task.type).toBe('thought');
      }
    }

    const secondUpdate = events[2];
    expect(secondUpdate?.type).toBe('thread.item.updated');
    if (secondUpdate?.type === 'thread.item.updated') {
      expect(secondUpdate.update.type).toBe('workflow.task.updated');
    }

    const thirdUpdate = events[3];
    expect(thirdUpdate?.type).toBe('thread.item.updated');
    if (thirdUpdate?.type === 'thread.item.updated') {
      expect(thirdUpdate.update.type).toBe('workflow.task.added');
    }
  });

  test('streams reasoning deltas for summary indices beyond the first', async () => {
    async function* source(): AsyncIterable<RunStreamEvent> {
      yield rawModelEvent({
        type: 'response.output_item.added',
        item: { type: 'reasoning', id: 'resp_multi', summary: [] },
      });
      yield rawModelEvent({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'resp_multi',
        summary_index: 0,
        delta: 'First',
      });
      yield rawModelEvent({
        type: 'response.reasoning_summary_text.done',
        item_id: 'resp_multi',
        summary_index: 0,
        text: 'First done',
      });
      yield rawModelEvent({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'resp_multi',
        summary_index: 1,
        delta: 'Second',
      });
    }

    const events = await collectEvents(
      streamChatKitEvents(source(), {
        threadId: 'thread_multi',
        includeStreamOptions: false,
      }),
    );

    const addedUpdates = events.filter(
      (event) =>
        event.type === 'thread.item.updated' &&
        event.update.type === 'workflow.task.added',
    );
    expect(addedUpdates.length).toBeGreaterThanOrEqual(2);
    const secondAdded = addedUpdates[1];
    expect(secondAdded?.type).toBe('thread.item.updated');
    if (secondAdded?.type === 'thread.item.updated') {
      const update = secondAdded.update;
      if (update.type === 'workflow.task.added') {
        expect(update.task_index).toBe(1);
        expect(update.task.type).toBe('thought');
        if (update.task.type === 'thought') {
          expect(update.task.content).toBe('Second');
        }
      }
    }
  });
});

describe('createChatKitSseResponse', () => {
  test('encodes thread events as SSE payloads', async () => {
    const response = createChatKitSseResponse(
      (async function* () {
        yield createChatKitTextMessageDoneEvent('Hello', {
          threadId: 'thread_sse',
          itemId: 'item_sse',
          createdAt: '2024-01-03T00:00:00.000Z',
        });
      })(),
    );

    expect(response.headers.get('content-type')).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(response.headers.get('cache-control')).toBe('no-cache');

    const body = await readResponseText(response);
    expect(body).toContain('data:');
    expect(body).toContain('"thread.item.done"');
  });
});

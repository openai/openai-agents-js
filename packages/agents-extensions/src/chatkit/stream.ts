import type { ResponseStreamEvent } from '@openai/agents';
import type {
  ChatKitAnnotation,
  ChatKitGeneratedImageItem,
  ChatKitStreamOptions,
  ChatKitStreamSource,
  ChatKitThoughtTask,
  ChatKitThreadItemDoneEvent,
  ChatKitThreadStreamEvent,
  ChatKitWorkflowItem,
} from './types';
import {
  convertAnnotation,
  convertContentArray,
  convertContentPart,
  getConverter,
} from './converter';
import {
  createId,
  normalizeCreatedAt,
  readContentIndex,
  readDelta,
  readItemId,
  readSummaryIndex,
  readText,
  resolveEventSource,
  unwrapModelEvent,
} from './utils';

type StreamingThoughtState = {
  itemId: string;
  index: number;
  task: ChatKitThoughtTask;
};

type AnnotationIndexState = Map<string, Map<number, number>>;
type AnnotationState = Map<string, Map<number, ChatKitAnnotation[]>>;

function nextAnnotationIndex(
  counts: AnnotationIndexState,
  itemId: string,
  contentIndex: number,
): number {
  let itemMap = counts.get(itemId);
  if (!itemMap) {
    itemMap = new Map();
    counts.set(itemId, itemMap);
  }
  const current = itemMap.get(contentIndex) ?? 0;
  itemMap.set(contentIndex, current + 1);
  return current;
}

function appendAnnotation(
  state: AnnotationState,
  itemId: string,
  contentIndex: number,
  annotation: ChatKitAnnotation,
): void {
  let itemMap = state.get(itemId);
  if (!itemMap) {
    itemMap = new Map();
    state.set(itemId, itemMap);
  }
  const current = itemMap.get(contentIndex);
  if (current) {
    current.push(annotation);
    return;
  }
  itemMap.set(contentIndex, [annotation]);
}

function readAnnotations(
  state: AnnotationState,
  itemId: string,
  contentIndex: number,
): ChatKitAnnotation[] {
  const annotations = state.get(itemId)?.get(contentIndex);
  return annotations ? [...annotations] : [];
}

function createThoughtTask(content: string): ChatKitThoughtTask {
  return { type: 'thought', content };
}

function endWorkflowItem(
  item: ChatKitWorkflowItem,
): ChatKitThreadItemDoneEvent {
  const createdAt = new Date(item.created_at).getTime();
  const durationSeconds = Number.isFinite(createdAt)
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
    : 0;
  if (!item.workflow.summary) {
    item.workflow.summary = { duration: durationSeconds };
  }
  item.workflow.expanded = false;
  return { type: 'thread.item.done', item };
}

export async function* streamChatKitEvents(
  source: ChatKitStreamSource,
  options: ChatKitStreamOptions = {},
): AsyncIterable<ChatKitThreadStreamEvent> {
  const events = resolveEventSource(source);
  const threadId = options.threadId ?? createId('thread');
  const includeStreamOptions = options.includeStreamOptions ?? true;
  const allowCancel = options.allowCancel ?? true;
  const converter = getConverter(options.converter);
  const fixedCreatedAt = options.createdAt
    ? normalizeCreatedAt(options.createdAt)
    : null;

  if (includeStreamOptions) {
    yield {
      type: 'stream_options',
      stream_options: { allow_cancel: allowCancel },
    };
  }

  let workflowItem: ChatKitWorkflowItem | null = null;
  const generatedImageItems = new Map<string, ChatKitGeneratedImageItem>();
  let streamingThought: StreamingThoughtState | null = null;
  const annotationCounts: AnnotationIndexState = new Map();
  const annotationsByContent: AnnotationState = new Map();
  const createdAtByItemId = new Map<string, string>();

  function resolveCreatedAt(itemId: string, rawCreatedAt?: unknown): string {
    const existing = createdAtByItemId.get(itemId);
    if (existing) {
      return existing;
    }
    const next =
      typeof rawCreatedAt === 'string' || rawCreatedAt instanceof Date
        ? normalizeCreatedAt(rawCreatedAt)
        : (fixedCreatedAt ?? new Date().toISOString());
    createdAtByItemId.set(itemId, next);
    return next;
  }

  for await (const event of events) {
    if (event.type !== 'raw_model_stream_event') {
      continue;
    }
    const rawEvent = unwrapModelEvent(event.data as ResponseStreamEvent);
    if (!rawEvent) {
      continue;
    }

    const type = (rawEvent as { type?: string }).type;
    if (typeof type !== 'string') {
      continue;
    }

    if (type === 'response.content_part.added') {
      const part = (rawEvent as { part?: unknown }).part;
      if ((part as { type?: string })?.type === 'reasoning_text') {
        continue;
      }
      const contentIndex = readContentIndex(rawEvent);
      const itemId = readItemId(rawEvent);
      if (contentIndex === null || !itemId) {
        continue;
      }
      const content = await convertContentPart(part, converter);
      if (!content) {
        continue;
      }
      yield {
        type: 'thread.item.updated',
        item_id: itemId,
        update: {
          type: 'assistant_message.content_part.added',
          content_index: contentIndex,
          content,
        },
      };
      continue;
    }

    if (type === 'response.output_text.delta') {
      const contentIndex = readContentIndex(rawEvent);
      const itemId = readItemId(rawEvent);
      const delta = readDelta(rawEvent);
      if (contentIndex === null || !itemId || !delta) {
        continue;
      }
      yield {
        type: 'thread.item.updated',
        item_id: itemId,
        update: {
          type: 'assistant_message.content_part.text_delta',
          content_index: contentIndex,
          delta,
        },
      };
      continue;
    }

    if (type === 'response.output_text.done') {
      const contentIndex = readContentIndex(rawEvent);
      const itemId = readItemId(rawEvent);
      const text = readText(rawEvent) ?? '';
      if (contentIndex === null || !itemId) {
        continue;
      }
      const annotations = readAnnotations(
        annotationsByContent,
        itemId,
        contentIndex,
      );
      yield {
        type: 'thread.item.updated',
        item_id: itemId,
        update: {
          type: 'assistant_message.content_part.done',
          content_index: contentIndex,
          content: {
            type: 'output_text',
            text,
            annotations,
          },
        },
      };
      continue;
    }

    if (type === 'response.output_text.annotation.added') {
      const itemId = readItemId(rawEvent);
      const contentIndex = readContentIndex(rawEvent);
      if (!itemId || contentIndex === null) {
        continue;
      }
      const annotation = await convertAnnotation(
        (rawEvent as { annotation?: unknown }).annotation,
        converter,
      );
      if (!annotation) {
        continue;
      }
      const annotationIndex = nextAnnotationIndex(
        annotationCounts,
        itemId,
        contentIndex,
      );
      appendAnnotation(annotationsByContent, itemId, contentIndex, annotation);
      yield {
        type: 'thread.item.updated',
        item_id: itemId,
        update: {
          type: 'assistant_message.content_part.annotation_added',
          content_index: contentIndex,
          annotation_index: annotationIndex,
          annotation,
        },
      };
      continue;
    }

    if (type === 'response.output_item.added') {
      const item = (rawEvent as { item?: any }).item;
      if (!item || typeof item !== 'object') {
        continue;
      }
      if (item.type === 'reasoning') {
        if (!workflowItem) {
          const workflowId = createId('workflow');
          workflowItem = {
            type: 'workflow',
            id: workflowId,
            thread_id: threadId,
            created_at: resolveCreatedAt(
              workflowId,
              item.created_at ?? item.createdAt,
            ),
            workflow: { type: 'reasoning', tasks: [] },
          };
          yield { type: 'thread.item.added', item: workflowItem };
        }
        continue;
      }

      if (item.type === 'message') {
        if (workflowItem) {
          yield endWorkflowItem(workflowItem);
          workflowItem = null;
          streamingThought = null;
        }
        const content = await convertContentArray(item.content, converter);
        const messageId =
          typeof item.id === 'string' ? item.id : createId('message');
        const createdAt = resolveCreatedAt(
          messageId,
          item.created_at ?? item.createdAt,
        );
        yield {
          type: 'thread.item.added',
          item: {
            type: 'assistant_message',
            id: messageId,
            thread_id: threadId,
            created_at: createdAt,
            content,
          },
        };
        continue;
      }

      if (item.type === 'image_generation_call') {
        const imageItemId =
          typeof item.id === 'string' ? item.id : createId('image');
        const generatedImageItem: ChatKitGeneratedImageItem = {
          type: 'generated_image',
          id: imageItemId,
          thread_id: threadId,
          created_at: resolveCreatedAt(
            imageItemId,
            item.created_at ?? item.createdAt,
          ),
          image: null,
        };
        generatedImageItems.set(imageItemId, generatedImageItem);
        yield { type: 'thread.item.added', item: generatedImageItem };
      }
      continue;
    }

    if (type === 'response.image_generation_call.partial_image') {
      const itemId = readItemId(rawEvent);
      if (!itemId) {
        continue;
      }
      const generatedImageItem = generatedImageItems.get(itemId);
      if (!generatedImageItem) {
        continue;
      }
      const base64Image = (rawEvent as { partial_image_b64?: unknown })
        .partial_image_b64;
      const partialIndex = (rawEvent as { partial_image_index?: unknown })
        .partial_image_index;
      if (typeof base64Image !== 'string' || typeof partialIndex !== 'number') {
        continue;
      }
      const url = await converter.base64ImageToUrl(base64Image, partialIndex);
      const progress = converter.partialImageIndexToProgress(partialIndex);
      const image = { id: generatedImageItem.id, url };
      generatedImageItem.image = image;
      yield {
        type: 'thread.item.updated',
        item_id: generatedImageItem.id,
        update: {
          type: 'generated_image.updated',
          image,
          progress,
        },
      };
      continue;
    }

    if (type === 'response.reasoning_summary_text.delta') {
      if (!workflowItem) {
        continue;
      }
      const delta = readDelta(rawEvent);
      const itemId = readItemId(rawEvent);
      const summaryIndex = readSummaryIndex(rawEvent);
      if (!delta || !itemId || summaryIndex === null) {
        continue;
      }
      const isActiveThought =
        streamingThought &&
        streamingThought.itemId === itemId &&
        streamingThought.index === summaryIndex &&
        workflowItem.workflow.tasks.includes(streamingThought.task);
      const activeThought = streamingThought;
      if (!isActiveThought || !activeThought) {
        streamingThought = {
          itemId,
          index: summaryIndex,
          task: createThoughtTask(delta),
        };
        workflowItem.workflow.tasks.push(streamingThought.task);
        yield {
          type: 'thread.item.updated',
          item_id: workflowItem.id,
          update: {
            type: 'workflow.task.added',
            task_index: workflowItem.workflow.tasks.length - 1,
            task: streamingThought.task,
          },
        };
        continue;
      }
      activeThought.task.content += delta;
      const taskIndex = workflowItem.workflow.tasks.indexOf(activeThought.task);
      yield {
        type: 'thread.item.updated',
        item_id: workflowItem.id,
        update: {
          type: 'workflow.task.updated',
          task_index: taskIndex,
          task: activeThought.task,
        },
      };
      continue;
    }

    if (type === 'response.reasoning_summary_text.done') {
      if (!workflowItem) {
        continue;
      }
      const itemId = readItemId(rawEvent);
      const summaryIndex = readSummaryIndex(rawEvent);
      const text = readText(rawEvent) ?? '';
      if (!itemId || summaryIndex === null) {
        continue;
      }
      if (
        streamingThought &&
        streamingThought.itemId === itemId &&
        streamingThought.index === summaryIndex &&
        workflowItem.workflow.tasks.includes(streamingThought.task)
      ) {
        streamingThought.task.content = text;
        const taskIndex = workflowItem.workflow.tasks.indexOf(
          streamingThought.task,
        );
        streamingThought = null;
        yield {
          type: 'thread.item.updated',
          item_id: workflowItem.id,
          update: {
            type: 'workflow.task.updated',
            task_index: taskIndex,
            task: workflowItem.workflow.tasks[taskIndex],
          },
        };
      } else {
        const task = createThoughtTask(text);
        workflowItem.workflow.tasks.push(task);
        yield {
          type: 'thread.item.updated',
          item_id: workflowItem.id,
          update: {
            type: 'workflow.task.added',
            task_index: workflowItem.workflow.tasks.indexOf(task),
            task,
          },
        };
      }
      continue;
    }

    if (type === 'response.output_item.done') {
      const item = (rawEvent as { item?: any }).item;
      if (!item || typeof item !== 'object') {
        continue;
      }
      if (item.type === 'message') {
        const content = await convertContentArray(item.content, converter);
        const messageId =
          typeof item.id === 'string' ? item.id : createId('message');
        const createdAt = resolveCreatedAt(
          messageId,
          item.created_at ?? item.createdAt,
        );
        yield {
          type: 'thread.item.done',
          item: {
            type: 'assistant_message',
            id: messageId,
            thread_id: threadId,
            created_at: createdAt,
            content,
          },
        };
      } else if (item.type === 'image_generation_call' && item.result) {
        const itemId = typeof item.id === 'string' ? item.id : null;
        if (!itemId) {
          continue;
        }
        const generatedImageItem = generatedImageItems.get(itemId);
        if (!generatedImageItem) {
          continue;
        }
        const url = await converter.base64ImageToUrl(item.result);
        const image = { id: generatedImageItem.id, url };
        generatedImageItem.image = image;
        yield { type: 'thread.item.done', item: generatedImageItem };
        generatedImageItems.delete(itemId);
      }
    }
  }
}

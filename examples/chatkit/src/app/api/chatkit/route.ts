export const runtime = 'nodejs';

import { Runner, user, type StreamedRunResult } from '@openai/agents';
import {
  ChatKitResponseStreamConverter,
  createChatKitSseResponse,
  streamChatKitEvents,
  type ChatKitThreadStreamEvent,
  type ChatKitRequest,
  type ChatKitUserMessageInput,
  ChatKitErrorEvent,
} from '@openai/agents-extensions/chatkit';

import { createMainAgent, imagePartialCount } from '@/app/lib/agents';
import {
  addItem,
  attachPreviousResponseIdPersistence,
  buildUserMessageItem,
  createThread,
  deleteThread,
  deriveThreadTitle,
  ensureThread,
  ensureTraceId,
  getPreviousResponseId,
  getThread,
  listItems,
  listThreads,
  removeItem,
  replaceItem,
  setPreviousResponseId,
  toThreadResponse,
  updateThreadTitle,
  userMessageToText,
} from '@/app/lib/chatkit';

async function* persistAssistantEvents(
  threadId: string,
  events: AsyncIterable<ChatKitThreadStreamEvent>,
): AsyncIterable<ChatKitThreadStreamEvent> {
  for await (const event of events) {
    if (event.type === 'thread.item.done') {
      replaceItem(threadId, event.item);
    } else if (event.type === 'thread.item.replaced') {
      replaceItem(threadId, event.item);
    } else if (event.type === 'thread.item.removed') {
      removeItem(threadId, event.item_id);
    }
    yield event;
  }
}

async function* streamAssistantResponse(
  threadId: string,
  stream: StreamedRunResult<any, any>,
): AsyncIterable<ChatKitThreadStreamEvent> {
  const converter = new ChatKitResponseStreamConverter({
    partialImages: imagePartialCount,
  });
  const events = streamChatKitEvents(stream, {
    threadId,
    converter,
    includeStreamOptions: false,
  });
  for await (const event of persistAssistantEvents(threadId, events)) {
    yield event;
  }
}

async function* respondToUserMessage(
  threadId: string,
  input: ChatKitUserMessageInput,
): AsyncIterable<ChatKitThreadStreamEvent> {
  const thread = getThread(threadId);
  if (thread && !thread.title) {
    const title = deriveThreadTitle(input);
    if (title) {
      const updated = updateThreadTitle(threadId, title);
      if (updated) {
        yield { type: 'thread.updated', thread: toThreadResponse(updated) };
      }
    }
  }

  const userMessage = buildUserMessageItem(threadId, input);
  const prompt = userMessageToText(userMessage);
  if (!prompt.trim()) {
    yield createErrorEvent('Message content is empty.');
    return;
  }

  addItem(threadId, userMessage);
  yield { type: 'thread.item.done', item: userMessage };
  yield { type: 'stream_options', stream_options: { allow_cancel: true } };

  const traceId = ensureTraceId(threadId);

  const codexEnabled = process.env.EXAMPLES_CHATKIT_CODEX_ENABLED === '1';
  if (codexEnabled) {
    // if you don't run codex tool at all, remove this section
    const { createCodexStreamCoordinator } =
      await import('@/app/lib/chatkit/codex');
    const { attachCodexTool } = await import('@/app/lib/codex');
    const codex = createCodexStreamCoordinator(threadId);
    const agent = createMainAgent();
    await attachCodexTool(agent, { onStream: codex.onCodexStream });

    const runner = new Runner({
      traceId,
      groupId: threadId,
      workflowName: 'ChatKit Session',
    });
    const stream = await runner.run(agent, [user(prompt)], {
      stream: true,
      previousResponseId: getPreviousResponseId(threadId),
    });
    attachPreviousResponseIdPersistence(stream, (id) =>
      setPreviousResponseId(threadId, id),
    );
    const assistantStream = streamAssistantResponse(threadId, stream);
    for await (const event of codex.merge(assistantStream)) {
      yield event;
    }

    return;
  }

  const agent = createMainAgent();
  const runner = new Runner({
    traceId,
    groupId: threadId,
    workflowName: 'ChatKit Session',
  });
  const stream = await runner.run(agent, [user(prompt)], {
    stream: true,
    previousResponseId: getPreviousResponseId(threadId),
  });
  attachPreviousResponseIdPersistence(stream, (id) =>
    setPreviousResponseId(threadId, id),
  );
  for await (const event of streamAssistantResponse(threadId, stream)) {
    yield event;
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ChatKitRequest | null;
  if (!body || typeof body.type !== 'string') {
    return new Response('Invalid request.', { status: 400 });
  }

  switch (body.type) {
    case 'threads.create': {
      const thread = createThread();
      const stream =
        (async function* (): AsyncIterable<ChatKitThreadStreamEvent> {
          yield { type: 'thread.created', thread: toThreadResponse(thread) };
          for await (const event of respondToUserMessage(
            thread.id,
            body.params.input,
          )) {
            yield event;
          }
        })();
      return createChatKitSseResponse(stream);
    }
    case 'threads.add_user_message': {
      const thread = ensureThread(body.params.thread_id);
      const stream = respondToUserMessage(thread.id, body.params.input);
      return createChatKitSseResponse(stream);
    }
    case 'threads.get_by_id': {
      const thread = getThread(body.params.thread_id);
      if (!thread) return new Response('Thread not found.', { status: 404 });
      return Response.json(toThreadResponse(thread));
    }
    case 'threads.list': {
      return Response.json(listThreads(body.params));
    }
    case 'items.list': {
      return Response.json(listItems(body.params.thread_id, body.params));
    }
    case 'threads.update': {
      const thread = updateThreadTitle(
        body.params.thread_id,
        body.params.title,
      );
      if (!thread) return new Response('Thread not found.', { status: 404 });
      return Response.json(toThreadResponse(thread));
    }
    case 'threads.delete': {
      if (!deleteThread(body.params.thread_id)) {
        return new Response('Thread not found.', { status: 404 });
      }
      return Response.json({});
    }
    case 'items.feedback': {
      return Response.json({});
    }
    case 'threads.custom_action':
    case 'threads.retry_after_item':
    case 'threads.add_client_tool_output': {
      const stream =
        (async function* (): AsyncIterable<ChatKitThreadStreamEvent> {
          yield createErrorEvent(`Unsupported request type: ${body.type}.`);
        })();
      return createChatKitSseResponse(stream);
    }
    default:
      return new Response(
        `Unsupported request type: ${(body as { type: string }).type}.`,
        { status: 400 },
      );
  }
}

function createErrorEvent(message: string): ChatKitErrorEvent {
  return {
    type: 'error',
    code: 'custom',
    message,
    allow_retry: false,
  };
}

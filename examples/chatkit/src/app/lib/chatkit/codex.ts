import type {
  ChatKitThreadStreamEvent,
  ChatKitThoughtTask,
  ChatKitWorkflowItem,
} from '@openai/agents-extensions/chatkit';

import { addItem, replaceItem } from './store';
import { createId } from './utils';

type QueueState<T> = {
  values: T[];
  resolvers: Array<(result: IteratorResult<T>) => void>;
  closed: boolean;
};

function createAsyncQueue<T>() {
  const state: QueueState<T> = { values: [], resolvers: [], closed: false };

  return {
    push(value: T) {
      if (state.closed) {
        return;
      }
      const resolver = state.resolvers.shift();
      if (resolver) {
        resolver({ value, done: false });
        return;
      }
      state.values.push(value);
    },
    close() {
      if (state.closed) {
        return;
      }
      state.closed = true;
      while (state.resolvers.length > 0) {
        const resolver = state.resolvers.shift();
        if (resolver) {
          resolver({ value: undefined as never, done: true });
        }
      }
    },
    async *stream(): AsyncIterable<T> {
      while (true) {
        if (state.values.length > 0) {
          yield state.values.shift() as T;
          continue;
        }
        if (state.closed) {
          return;
        }
        const next = await new Promise<IteratorResult<T>>((resolve) => {
          state.resolvers.push(resolve);
        });
        if (next.done) {
          return;
        }
        yield next.value;
      }
    },
  };
}

async function* mergeWithPriority<T>(
  primary: AsyncIterable<T>,
  secondary: AsyncIterable<T>,
): AsyncIterable<T> {
  const primaryQueue: T[] = [];
  const secondaryQueue: T[] = [];
  let primaryDone = false;
  let secondaryDone = false;
  const waiters: Array<() => void> = [];

  const notify = () => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter();
    }
  };

  const waitForItem = () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
    });

  void (async () => {
    for await (const value of primary) {
      primaryQueue.push(value);
      notify();
    }
    primaryDone = true;
    notify();
  })();

  void (async () => {
    for await (const value of secondary) {
      secondaryQueue.push(value);
      notify();
    }
    secondaryDone = true;
    notify();
  })();

  while (
    primaryQueue.length > 0 ||
    secondaryQueue.length > 0 ||
    !primaryDone ||
    !secondaryDone
  ) {
    if (primaryQueue.length > 0) {
      yield primaryQueue.shift() as T;
      continue;
    }
    if (secondaryQueue.length > 0) {
      yield secondaryQueue.shift() as T;
      continue;
    }
    await waitForItem();
  }
}

function createCodexWorkflowEmitter(
  threadId: string,
  queue: ReturnType<typeof createAsyncQueue<ChatKitThreadStreamEvent>>,
) {
  let workflowItem: ChatKitWorkflowItem | null = null;
  let startedAt: number | null = null;
  let lastError: string | null = null;
  let seenEvent = false;

  const truncate = (value: string, max = 160) =>
    value.length > max ? `${value.slice(0, max)}...` : value;

  const getItemTypeLabel = (item?: { type?: string }) => {
    switch (item?.type) {
      case 'command_execution':
        return 'command';
      case 'file_change':
        return 'file change';
      case 'mcp_tool_call':
        return 'MCP tool';
      case 'web_search':
        return 'web search';
      case 'todo_list':
        return 'todo list';
      case 'error':
        return 'error';
      case 'reasoning':
        return 'reasoning';
      case 'agent_message':
        return 'agent message';
      default:
        return item?.type ?? 'work';
    }
  };

  const getItemDetail = (item?: Record<string, unknown>) => {
    if (!item) {
      return null;
    }
    switch (item.type) {
      case 'command_execution': {
        const command = typeof item.command === 'string' ? item.command : null;
        return command ? truncate(command) : null;
      }
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const first = changes[0] as { path?: string } | undefined;
        const path = first?.path;
        return typeof path === 'string' ? `First change: ${path}` : null;
      }
      case 'mcp_tool_call': {
        const server = typeof item.server === 'string' ? item.server : null;
        const tool = typeof item.tool === 'string' ? item.tool : null;
        return server && tool ? `${server}.${tool}` : null;
      }
      case 'web_search': {
        const query = typeof item.query === 'string' ? item.query : null;
        return query ? truncate(query) : null;
      }
      case 'todo_list': {
        const items = Array.isArray(item.items) ? item.items : [];
        const first = items[0] as { text?: string } | undefined;
        const text = first?.text;
        return typeof text === 'string'
          ? truncate(text)
          : items.length
            ? `${items.length} items`
            : null;
      }
      case 'error': {
        const message = typeof item.message === 'string' ? item.message : null;
        return message ? truncate(message) : null;
      }
      case 'reasoning': {
        const text = typeof item.text === 'string' ? item.text : null;
        return text ? truncate(text) : null;
      }
      case 'agent_message': {
        const text = typeof item.text === 'string' ? item.text : null;
        return text ? truncate(text) : null;
      }
      default:
        return null;
    }
  };

  const ensureWorkflow = () => {
    if (workflowItem) {
      return;
    }
    workflowItem = {
      type: 'workflow',
      id: createId('workflow'),
      thread_id: threadId,
      created_at: new Date().toISOString(),
      workflow: {
        type: 'reasoning',
        tasks: [],
      },
    };
    startedAt = Date.now();
    addItem(threadId, workflowItem);
    queue.push({ type: 'thread.item.added', item: workflowItem });
  };

  const addTask = (
    title: string,
    detail: string | null,
    status: 'loading' | 'complete' = 'loading',
  ) => {
    ensureWorkflow();
    if (!workflowItem) {
      return;
    }
    const content = detail ? `${title}\n\n${detail}` : title;
    const task: ChatKitThoughtTask = {
      type: 'thought',
      content,
      status_indicator: status,
    };
    workflowItem.workflow.tasks.push(task);
    replaceItem(threadId, workflowItem);
    queue.push({
      type: 'thread.item.updated',
      item_id: workflowItem.id,
      update: {
        type: 'workflow.task.added',
        task_index: workflowItem.workflow.tasks.length - 1,
        task,
      },
    });
  };

  const finishWorkflow = () => {
    if (!workflowItem) {
      return;
    }
    if (startedAt) {
      const duration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      workflowItem.workflow.summary = { duration };
    }
    workflowItem.workflow.expanded = false;
    replaceItem(threadId, workflowItem);
    queue.push({ type: 'thread.item.done', item: workflowItem });
  };

  const onCodexStream = (payload: any) => {
    const event = payload?.event as { type?: unknown; item?: unknown } | null;
    const type = event?.type;
    if (typeof type !== 'string') {
      return;
    }

    seenEvent = true;

    switch (type) {
      case 'thread.started':
        addTask('Codex session started', null);
        break;
      case 'item.started': {
        const item = (event as { item?: Record<string, unknown> }).item;
        const itemType = getItemTypeLabel(item);
        addTask(`Started ${itemType}`, getItemDetail(item) ?? 'item.started');
        break;
      }
      case 'item.updated': {
        const item = (event as { item?: Record<string, unknown> }).item;
        if (!item) {
          break;
        }
        const itemType = getItemTypeLabel(item);
        addTask(`Updated ${itemType}`, getItemDetail(item) ?? 'item.updated');
        break;
      }
      case 'item.completed': {
        const item = (event as { item?: Record<string, unknown> }).item;
        const itemType = getItemTypeLabel(item);
        const itemError =
          item &&
          typeof (item as { error?: { message?: string } }).error?.message ===
            'string'
            ? (item as { error?: { message?: string } }).error?.message
            : null;
        if (itemError) {
          lastError = itemError;
        }
        addTask(
          `Completed ${itemType}`,
          itemError ?? getItemDetail(item) ?? 'item.completed',
          'complete',
        );
        break;
      }
      case 'turn.completed':
        addTask('Codex turn completed', null, 'complete');
        finishWorkflow();
        queue.close();
        break;
      case 'turn.failed':
        addTask('Codex turn failed', lastError, 'complete');
        finishWorkflow();
        queue.push({
          type: 'notice',
          level: 'warning',
          message: 'Codex turn failed',
        });
        queue.close();
        break;
      default:
        break;
    }
  };

  return {
    onCodexStream,
    close: () => queue.close(),
    hasEvents: () => seenEvent,
  };
}

export function createCodexStreamCoordinator(threadId: string) {
  const codexQueue = createAsyncQueue<ChatKitThreadStreamEvent>();
  const codexEmitter = createCodexWorkflowEmitter(threadId, codexQueue);

  const merge = (assistantStream: AsyncIterable<ChatKitThreadStreamEvent>) => {
    let assistantDone = false;

    const wrappedAssistant = (async function* () {
      try {
        for await (const event of assistantStream) {
          yield event;
        }
      } finally {
        assistantDone = true;
        if (!codexEmitter.hasEvents()) {
          codexEmitter.close();
        }
      }
    })();

    return (async function* () {
      try {
        for await (const event of mergeWithPriority(
          wrappedAssistant,
          codexQueue.stream(),
        )) {
          yield event;
        }
      } finally {
        if (!assistantDone || codexEmitter.hasEvents()) {
          codexEmitter.close();
        }
      }
    })();
  };

  return { onCodexStream: codexEmitter.onCodexStream, merge };
}

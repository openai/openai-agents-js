import type { VoiceHistoryItem } from './conversation-history';

export type PortableHistoryUpdate =
  | readonly VoiceHistoryItem[]
  | ((history: readonly VoiceHistoryItem[]) => readonly VoiceHistoryItem[]);

type Edit =
  | { type: 'delete'; item_id: string }
  | {
      type: 'input';
      item: VoiceHistoryItem;
      previous_item_id: string;
      create_response: false;
    };
type Command =
  | Edit
  | {
      type: 'validate_history';
      delete_ids: string[];
      items: VoiceHistoryItem[];
    };
type HistoryFrame = {
  type?: string;
  event_id?: string;
  item_id?: string;
  item?: { id?: string };
  error?: { event_id?: string };
};
const CAPACITY = 8 * 1024 * 1024;

/** Bounded message edits; Rust retains tool and approval admission authority. */
export class PortableVoiceHistory {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private closed: Error | undefined;
  private pending:
    | {
        edit: Edit;
        frame?: HistoryFrame;
        pauseDeadline(): void;
        trackSend(sending: Promise<void>): void;
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;

  constructor(
    private readonly snapshot: () => readonly VoiceHistoryItem[],
    private readonly send: (command: Command) => void,
    private readonly fail: (error: Error) => void,
    private readonly rejected?: (error: Error) => void,
  ) {}

  async update(update: PortableHistoryUpdate): Promise<void> {
    if (this.closed) throw this.closed;
    const captured = typeof update === 'function' ? undefined : capture(update);
    return this.enqueue(captured?.bytes ?? 0, async (retain) => {
      const next =
        typeof update === 'function'
          ? capture(update(this.snapshot()))
          : captured!;
      if (typeof update === 'function') {
        if (this.closed) throw this.closed;
        retain(next.bytes);
      }
      const edits = plan(this.snapshot(), next.items);
      if (!edits.length) return;
      // Pure native preflight: every edit must be valid before the first write.
      this.send({
        type: 'validate_history',
        delete_ids: edits.flatMap((edit) =>
          edit.type === 'delete' ? [edit.item_id] : [],
        ),
        items: edits.flatMap((edit) =>
          edit.type === 'input' ? [edit.item] : [],
        ),
      });
      for (const edit of edits) {
        if (this.closed) throw this.closed;
        await this.apply(edit);
      }
    });
  }

  async delete(itemId: string): Promise<void> {
    return this.enqueue(itemId.length * 2, () =>
      this.apply({ type: 'delete', item_id: itemId }),
    );
  }

  dispatchAfterEdits(
    command: Record<string, unknown>,
    dispatch: (command: Record<string, unknown>) => void,
  ): void {
    if (this.closed) throw this.closed;
    if (this.queued === 0) {
      dispatch(command);
      return;
    }
    const captured = JSON.stringify(command);
    void this.enqueue(captured.length * 2, async () => {
      dispatch(JSON.parse(captured));
    }).catch(() => {});
  }

  private enqueue(
    bytes: number,
    work: (retain: (bytes: number) => void) => Promise<void>,
  ): Promise<void> {
    if (this.closed) throw this.closed;
    if (this.queued >= 16 || this.queuedBytes + bytes > CAPACITY) {
      const error = new Error('Portable history queue exceeds capacity.');
      this.rejected?.(error);
      throw error;
    }
    let retainedBytes = bytes;
    this.queued++;
    this.queuedBytes += retainedBytes;
    const operation = this.tail.then(async () => {
      try {
        if (this.closed) throw this.closed;
        await work((additionalBytes) => {
          if (this.queuedBytes + additionalBytes > CAPACITY)
            throw new Error('Portable history queue exceeds capacity.');
          retainedBytes += additionalBytes;
          this.queuedBytes += additionalBytes;
        });
      } catch (error) {
        this.rejected?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      } finally {
        this.queued--;
        this.queuedBytes -= retainedBytes;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  rejectDeletion(itemId: string, error: Error): boolean {
    const pending = this.pending;
    if (pending?.edit.type !== 'delete' || pending.edit.item_id !== itemId)
      return false;
    pending.reject(error);
    return true;
  }

  trackSend(event: unknown, sending: Promise<void>): void {
    const pending = this.pending;
    if (!pending || !event || typeof event !== 'object') return;
    const frame = event as HistoryFrame;
    const { type, item_id, item } = frame;
    if (pending.edit.type === 'delete') {
      if (
        item_id !== pending.edit.item_id ||
        (type !== 'conversation.item.retrieve' &&
          type !== 'conversation.item.delete')
      )
        return;
    } else if (
      type !== 'conversation.item.create' ||
      item?.id !== pending.edit.item.id
    )
      return;
    pending.frame = frame;
    pending.trackSend(sending);
  }

  receive(event: unknown): void {
    const pending = this.pending;
    if (!pending?.frame || !event || typeof event !== 'object') return;
    if (matchesReceipt(pending.frame, event as HistoryFrame)) {
      // Rust may hold this receipt until outstanding transport sends finish.
      pending.pauseDeadline();
    }
  }

  observe(event: Record<string, any>): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.edit.type === 'delete') {
      if (
        pending.frame?.type === 'conversation.item.delete' &&
        event.type === 'conversation.item.deleted' &&
        event.item_id === pending.edit.item_id
      )
        pending.resolve();
      return;
    }
    if (
      !['conversation.item.added', 'conversation.item.created'].includes(
        event.type,
      ) ||
      event.item?.id !== pending.edit.item.id
    )
      return;
    const previous = pending.edit.previous_item_id;
    if (
      !contains(event.item, pending.edit.item) ||
      (event.previous_item_id !== previous &&
        !(previous === 'root' && event.previous_item_id === null))
    ) {
      const error = new Error(
        'Provider history acknowledgement conflicts with the requested edit.',
      );
      pending.reject(error);
      this.close(error);
      this.fail(error);
    } else pending.resolve();
  }

  close(reason: unknown): void {
    this.closed ??=
      reason instanceof Error
        ? reason
        : new Error('Portable history owner closed.');
    this.pending?.reject(this.closed);
  }

  private async apply(edit: Edit): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let latestSend: Promise<void> | undefined;
      const pauseDeadline = () => {
        latestSend = undefined;
        clearTimeout(timer);
      };
      const finish = () => {
        settled = true;
        pauseDeadline();
      };
      const rejectEdit = (error: unknown) => {
        finish();
        reject(
          error instanceof Error
            ? error
            : new Error('History edit admission failed.'),
        );
      };
      this.pending = {
        edit,
        pauseDeadline,
        trackSend: (sending) => {
          // A successful lookup can queue a second frame behind other egress.
          clearTimeout(timer);
          latestSend = sending;
          void sending.then(() => {
            if (settled || latestSend !== sending) return;
            timer = setTimeout(() => {
              const error = new Error(
                'Provider history acknowledgement timed out.',
              );
              this.close(error);
              this.fail(error); // A possibly accepted mutation must never be replayed.
            }, 10_000);
          }, rejectEdit);
        },
        resolve: () => {
          finish();
          resolve();
        },
        reject: rejectEdit,
      };
      try {
        this.send(edit);
      } catch (error) {
        rejectEdit(error);
      }
    }).finally(() => {
      this.pending = undefined;
    });
  }
}

function matchesReceipt(frame: HistoryFrame, event: HistoryFrame): boolean {
  if (event.type === 'error')
    return (
      frame.event_id !== undefined && event.error?.event_id === frame.event_id
    );
  switch (frame.type) {
    case 'conversation.item.retrieve':
      return (
        event.type === 'conversation.item.retrieved' &&
        event.item?.id === frame.item_id
      );
    case 'conversation.item.delete':
      return (
        event.type === 'conversation.item.deleted' &&
        event.item_id === frame.item_id
      );
    case 'conversation.item.create':
      return (
        (event.type === 'conversation.item.created' ||
          event.type === 'conversation.item.added') &&
        event.item?.id === frame.item?.id
      );
    default:
      return false;
  }
}

function capture(value: unknown): { items: VoiceHistoryItem[]; bytes: number } {
  if (!Array.isArray(value) || value.length > 4096)
    throw new TypeError('Portable history must contain at most 4096 items.');
  let bytes = 0;
  const visit = (value: unknown, depth: number): void => {
    bytes += 256;
    if (bytes > CAPACITY || depth > 128)
      throw new Error('Portable history exceeds capacity.');
    if (typeof value === 'string') bytes += value.length * 4;
    else if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
      } else {
        if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
          throw new TypeError('Portable history must contain JSON data.');
        for (const key of Object.keys(value)) {
          bytes += 128 + key.length * 4;
          visit((value as Record<string, unknown>)[key], depth + 1);
        }
      }
    } else if (
      value !== null &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      throw new TypeError('Portable history must contain JSON data.');
    if (bytes > CAPACITY) throw new Error('Portable history exceeds capacity.');
  };
  visit(value, 0);
  return { items: JSON.parse(JSON.stringify(value)), bytes };
}

function contains(actual: any, expected: any): boolean {
  if (actual === expected) return true;
  if (
    !actual ||
    !expected ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  )
    return false;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => contains(actual[index], item))
    );
  return Object.keys(expected).every((key) =>
    contains(actual[key], expected[key]),
  );
}

function plan(
  current: readonly VoiceHistoryItem[],
  desired: readonly VoiceHistoryItem[],
): Edit[] {
  const old = new Map(current.map((item, index) => [item.id, { item, index }]));
  const seen = new Set<string>();
  const kept = new Set<string>();
  const anchors: string[] = [];
  let lastAnchor = -1;
  for (const item of desired) {
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      item.id === 'root' ||
      item.id.length > 512 ||
      seen.has(item.id)
    )
      throw new TypeError(
        'Portable history requires unique, bounded item IDs.',
      );
    seen.add(item.id);
    const previous = old.get(item.id);
    if (
      item.type !== 'message' ||
      (previous?.item.type !== 'message' && previous)
    ) {
      if (
        !previous ||
        !contains(item, previous.item) ||
        !contains(previous.item, item) ||
        previous.index <= lastAnchor
      )
        throw new Error(
          'Tool and control history rows must remain unchanged and ordered.',
        );
      anchors.push(item.id);
      kept.add(item.id);
      lastAnchor = previous.index;
    }
  }
  let anchor = 0;
  let cursor = -1;
  for (const item of desired) {
    const id = item.id as string;
    const previous = old.get(id);
    if (kept.has(id)) {
      cursor = previous!.index;
      anchor++;
      continue;
    }
    const boundary = anchors[anchor]
      ? old.get(anchors[anchor])!.index
      : Infinity;
    if (
      previous &&
      previous.index > cursor &&
      previous.index < boundary &&
      contains(previous.item, item) &&
      contains(item, previous.item)
    ) {
      kept.add(id);
      cursor = previous.index;
    }
  }
  const edits: Edit[] = [];
  for (const item of current)
    if (!kept.has(item.id as string)) {
      if (item.status === 'in_progress')
        throw new Error('Active history rows cannot be replaced.');
      edits.push({ type: 'delete', item_id: item.id as string });
    }
  let previous = 'root';
  for (const item of desired) {
    if (!kept.has(item.id as string)) {
      if (
        item.type !== 'message' ||
        !['user', 'assistant', 'system'].includes(item.role as string) ||
        !Array.isArray(item.content) ||
        item.content.some(
          (part: any) =>
            !part ||
            ![
              'input_text',
              'output_text',
              'input_audio',
              'input_image',
            ].includes(part.type),
        )
      )
        throw new Error(
          'Only replayable message history can be inserted or changed; convert output audio to text.',
        );
      edits.push({
        type: 'input',
        item,
        previous_item_id: previous,
        create_response: false,
      });
    }
    previous = item.id as string;
  }
  return edits;
}

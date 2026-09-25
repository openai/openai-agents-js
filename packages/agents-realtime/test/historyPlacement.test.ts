import { describe, expect, it, vi } from 'vitest';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';
import { RealtimeAgent } from '../src/realtimeAgent';
import { RealtimeSession } from '../src/realtimeSession';
import type { RealtimeItem, RealtimeMessageItem } from '../src/items';
import type { RealtimeClientMessage } from '../src/clientMessages';

const message = (itemId: string, text = itemId): RealtimeMessageItem => ({
  itemId,
  type: 'message',
  role: 'user',
  status: 'completed',
  content: [{ type: 'input_text', text }],
});

// Model the provider's placement rules while controlling wire acknowledgements.
// A scripted session transport bypasses the base transport's request tracking.
class HistoryTransport extends OpenAIRealtimeBase {
  status = 'connected' as const;
  connect = vi.fn(async () => {});
  mute = vi.fn();
  interrupt = vi.fn();
  get muted() {
    return false;
  }
  close() {
    this._onClose();
  }
  history: RealtimeMessageItem[] = [];
  replies: Record<string, unknown>[] = [];
  sent: RealtimeClientMessage[] = [];
  failNextCreate = false;
  throwNextSend = false;
  #sequence = 0;

  deliver(reply: Record<string, unknown>) {
    this._onMessage({
      data: JSON.stringify({
        event_id: `server_${++this.#sequence}`,
        ...reply,
      }),
    } as MessageEvent);
  }

  flush() {
    while (this.replies.length) this.deliver(this.replies.shift()!);
  }

  seed(items: RealtimeMessageItem[]) {
    this.history = [...items];
    for (const [index, item] of items.entries()) {
      this.deliver(this.added(item, items[index - 1]?.itemId ?? null));
    }
  }

  added(item: RealtimeMessageItem, predecessor: string | null) {
    const { itemId, ...wireItem } = item;
    return {
      type: 'conversation.item.added',
      previous_item_id: predecessor,
      item: { ...wireItem, id: itemId },
    };
  }

  sendEvent(event: RealtimeClientMessage) {
    if (this.throwNextSend) {
      this.throwNextSend = false;
      throw new Error('send failed');
    }
    this.sent.push(event);
    if (event.type === 'conversation.item.delete') {
      const index = this.history.findIndex(
        (item) => item.itemId === event.item_id,
      );
      if (index < 0) {
        this.reject(event);
      } else {
        this.history.splice(index, 1);
        this.replies.push({
          type: 'conversation.item.deleted',
          item_id: event.item_id,
        });
      }
    } else if (event.type === 'conversation.item.create') {
      const wireItem = event.item as {
        id: string;
        content: RealtimeMessageItem['content'];
      };
      const anchor = event.previous_item_id;
      const index =
        anchor === undefined
          ? this.history.length
          : anchor === 'root'
            ? 0
            : this.history.findIndex((item) => item.itemId === anchor) + 1;
      if (
        this.failNextCreate ||
        (anchor !== undefined && anchor !== 'root' && index === 0) ||
        this.history.some((item) => item.itemId === wireItem.id)
      ) {
        this.failNextCreate = false;
        this.reject(event);
        return;
      }
      const item = {
        ...message(wireItem.id),
        content: wireItem.content,
      } as RealtimeMessageItem;
      this.history.splice(index, 0, item);
      const added = this.added(item, this.history[index - 1]?.itemId ?? null);
      this.replies.push(added, { ...added, type: 'conversation.item.done' });
    }
  }

  reject(event: RealtimeClientMessage) {
    this.replies.push({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Rejected history operation',
        event_id: event.event_id,
      },
    });
  }
}

async function setup() {
  const transport = new HistoryTransport();
  const session = new RealtimeSession(new RealtimeAgent({ name: 'test' }), {
    transport,
  });
  const errors: unknown[] = [];
  session.on('error', (error) => errors.push(error));
  await session.connect({ apiKey: 'test' });
  transport.seed([message('a'), message('b'), message('c')]);
  return { transport, session, errors };
}

function insertX(history: RealtimeItem[]) {
  const result = [...history];
  result.splice(
    result.findIndex((item) => item.itemId === 'c'),
    0,
    message('x'),
  );
  return result;
}

function ids(items: RealtimeItem[]) {
  return items.map((item) => item.itemId);
}

describe('Realtime history placement with delayed acknowledgements', () => {
  it('inserts after a pending recreation and preserves corrected content', async () => {
    const { transport, session, errors } = await setup();
    session.updateHistory((history) =>
      history.map((item) =>
        item.itemId === 'b' ? message('b', 'corrected') : item,
      ),
    );
    session.updateHistory(insertX);
    expect(ids(transport.history)).toEqual(['a', 'b', 'x', 'c']);
    transport.flush();
    expect(ids(session.history)).toEqual(['a', 'b', 'x', 'c']);
    expect(session.history[1]).toMatchObject({
      content: [{ type: 'input_text', text: 'corrected' }],
    });
    expect(errors).toEqual([]);
    session.close();
  });

  it('skips an item deleted by an earlier update', async () => {
    const { transport, session, errors } = await setup();
    session.updateHistory((history) =>
      history.filter((item) => item.itemId !== 'b'),
    );
    session.updateHistory(insertX);
    transport.flush();
    expect(ids(transport.history)).toEqual(['a', 'x', 'c']);
    expect(ids(session.history)).toEqual(['a', 'x', 'c']);
    expect(errors).toEqual([]);
    session.close();
  });

  it('keeps a later deletion effective during recreation acknowledgements', async () => {
    const { transport, session, errors } = await setup();
    session.updateHistory((history) =>
      history.map((item) =>
        item.itemId === 'b' ? message('b', 'corrected') : item,
      ),
    );
    session.updateHistory((history) =>
      history.filter((item) => item.itemId !== 'b'),
    );
    transport.deliver(transport.replies.shift()!);
    transport.deliver(transport.replies.shift()!);
    session.updateHistory(insertX);
    transport.flush();
    expect(ids(transport.history)).toEqual(['a', 'x', 'c']);
    expect(ids(session.history)).toEqual(['a', 'x', 'c']);
    expect(errors).toEqual([]);
    session.close();
  });
  it('does not let a done event settle a newer recreation', async () => {
    const { transport, session, errors } = await setup();
    session.updateHistory((history) =>
      history.map((item) =>
        item.itemId === 'b' ? message('b', 'first') : item,
      ),
    );
    session.updateHistory((history) =>
      history.map((item) =>
        item.itemId === 'b' ? message('b', 'second') : item,
      ),
    );
    // Deliver only the first delete, added, and done; the second edit is pending.
    for (let i = 0; i < 3; i++) transport.deliver(transport.replies.shift()!);
    session.updateHistory(insertX);
    transport.flush();
    expect(ids(transport.history)).toEqual(['a', 'b', 'x', 'c']);
    expect(ids(session.history)).toEqual(['a', 'b', 'x', 'c']);
    expect(session.history[1]).toMatchObject({
      content: [{ type: 'input_text', text: 'second' }],
    });
    expect(errors).toEqual([]);
    session.close();
  });

  it('allows restoration after a failed recreation', async () => {
    const { transport, session, errors } = await setup();
    transport.failNextCreate = true;
    session.updateHistory((history) =>
      history.map((item) =>
        item.itemId === 'b' ? message('b', 'corrected') : item,
      ),
    );
    transport.flush();
    expect(errors).toHaveLength(1);
    expect(ids(session.history)).toEqual(['a', 'c']);
    session.updateHistory([
      message('a'),
      message('b', 'restored'),
      message('c'),
    ]);
    transport.flush();
    session.updateHistory(insertX);
    transport.flush();
    expect(ids(transport.history)).toEqual(['a', 'b', 'x', 'c']);
    expect(ids(session.history)).toEqual(['a', 'b', 'x', 'c']);
    expect(errors).toHaveLength(1);
    session.close();
  });

  it('does not retain a delete whose send throws', async () => {
    const { transport, session, errors } = await setup();
    transport.throwNextSend = true;
    expect(() =>
      session.updateHistory((history) =>
        history.filter((item) => item.itemId !== 'b'),
      ),
    ).toThrow('send failed');
    session.updateHistory(insertX);
    transport.flush();
    expect(ids(transport.history)).toEqual(['a', 'b', 'x', 'c']);
    expect(ids(session.history)).toEqual(['a', 'b', 'x', 'c']);
    expect(errors).toEqual([]);
    session.close();
  });
});

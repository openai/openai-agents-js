import OpenAI from 'openai';
import type { JsonObject } from '../../src/runtime/binding';

export const conversationMessage = (i: number): JsonObject => ({
  type: 'message',
  id: `msg_${i}`,
  role: 'user',
  status: 'completed',
  content: [{ type: 'input_text', text: String(i) }],
});

export function conversationsClientFixture() {
  const state = {
    items: [] as JsonObject[],
    creates: 0,
    pageSize: 2,
    requests: [] as { method: string; url: URL; body: any }[],
    batches: [] as JsonObject[][],
    failBatch: undefined as number | undefined,
    beforeCreate: undefined as (() => Promise<void>) | undefined,
  };
  const client = new OpenAI({
    apiKey: 'synthetic',
    baseURL: 'https://conversations.invalid/v1',
    maxRetries: 3,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json() : undefined;
      state.requests.push({ method: request.method, url, body });
      const respond = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.pathname === '/v1/conversations' && request.method === 'POST') {
        await state.beforeCreate?.();
        state.creates++;
        return respond({
          id: `conv_${state.creates}`,
          object: 'conversation',
          created_at: 1,
        });
      }
      if (url.pathname.endsWith('/items') && request.method === 'GET') {
        let ordered = [...state.items];
        if (url.searchParams.get('order') === 'desc') ordered.reverse();
        const after = url.searchParams.get('after');
        if (after !== null)
          ordered = ordered.slice(ordered.findIndex((i) => i.id === after) + 1);
        const included = new Set(url.searchParams.getAll('include[]'));
        const page = ordered.slice(0, state.pageSize).map((original) => {
          const item = structuredClone(original);
          if (
            item.type === 'message' &&
            Array.isArray(item.content) &&
            !included.has('message.input_image.image_url')
          ) {
            for (const part of item.content as JsonObject[]) {
              if (part.type === 'input_image') delete part.image_url;
            }
          }
          if (
            item.type === 'computer_call_output' &&
            item.output &&
            !included.has('computer_call_output.output.image_url')
          ) {
            delete (item.output as JsonObject).image_url;
          }
          return item;
        });
        return respond({
          object: 'list',
          data: page,
          first_id: page[0]?.id,
          last_id: page.at(-1)?.id,
          has_more: ordered.length > page.length,
        });
      }
      if (url.pathname.endsWith('/items') && request.method === 'POST') {
        state.batches.push(body.items);
        if (state.batches.length === state.failBatch)
          return respond({ error: { message: 'synthetic unavailable' } }, 503);
        state.items.push(...body.items);
        return respond({ object: 'list', data: body.items, has_more: false });
      }
      if (request.method === 'DELETE') {
        if (url.pathname.includes('/items/')) {
          const id = url.pathname.split('/').at(-1);
          state.items = state.items.filter((item) => item.id !== id);
          return respond({
            id: 'conv_existing',
            object: 'conversation',
            created_at: 1,
          });
        }
        state.items = [];
        return respond({
          id: url.pathname.split('/').at(-1),
          object: 'conversation.deleted',
          deleted: true,
        });
      }
      throw new Error(
        `Unexpected synthetic route ${request.method} ${url.pathname}`,
      );
    },
  });
  return { state, client };
}

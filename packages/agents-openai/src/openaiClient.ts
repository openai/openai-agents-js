import type { OpenAI } from 'openai';
import type { ConversationItem } from 'openai/resources/conversations/items';

// Keep the full client type for callers that read the SDK default.
export type BundledOpenAIClient = OpenAI | import('openai/index.mjs').OpenAI;

// OpenAI 7.2 represented MCP errors as text. Later versions use a structured
// error. The Agents SDK treats this field as provider data.
type CompatibleItem<Item> = Item extends { type: 'mcp_call' }
  ? Omit<Item, 'error'> & { error?: unknown }
  : Item;
type ResponseItem = CompatibleItem<OpenAI.Responses.ResponseOutputItem>;
type StoredItem = CompatibleItem<ConversationItem>;
type ModelResponse = Pick<
  OpenAI.Responses.Response,
  'id' | 'status' | 'usage'
> & {
  output: readonly ResponseItem[];
};
// Model responses and output items occur inside streaming events, too.
// OpenAI 7.2 also exposed new text annotations as unknown.
type StreamEvent<Event = OpenAI.Responses.ResponseStreamEvent> = Event extends {
  response: OpenAI.Responses.Response;
}
  ? Omit<Event, 'response'> & { response: ModelResponse }
  : Event extends { item: OpenAI.Responses.ResponseOutputItem }
    ? Omit<Event, 'item'> & { item: ResponseItem }
    : Event extends { type: 'response.output_text.annotation.added' }
      ? Omit<Event, 'annotation'> & { annotation: unknown }
      : Event;
type ChatResult = Pick<
  OpenAI.Chat.Completions.ChatCompletion,
  'id' | 'choices'
>;
type ChatEvent = Pick<
  OpenAI.Chat.Completions.ChatCompletionChunk,
  'id' | 'choices'
>;

type Create<ModelInput, Result, Event> = {
  (body: ModelInput & { stream?: false }): PromiseLike<Result>;
  (body: ModelInput & { stream: true }): PromiseLike<AsyncIterable<Event>>;
};

/**
 * Application clients can come from another installed copy of the OpenAI
 * SDK. Check the public operations and result fields shared across supported
 * versions without depending on private resource, promise, or stream classes.
 */
export type OpenAIClient = Pick<
  OpenAI,
  'apiKey' | 'baseURL' | 'organization' | 'project' | 'buildURL'
> & {
  responses: {
    create: Create<
      { model: string; input: string },
      ModelResponse,
      StreamEvent
    >;
    compact(body: {
      model: string;
      input: string;
    }): PromiseLike<{ output: readonly ResponseItem[] }>;
  };
  chat: {
    completions: {
      create: Create<
        { model: string; messages: { role: 'user'; content: string }[] },
        ChatResult,
        ChatEvent
      >;
    };
  };
  conversations: {
    create(): PromiseLike<{ id: string }>;
    delete(id: string): PromiseLike<{ deleted: boolean }>;
    items: {
      create(
        id: string,
        body: { items: [] },
      ): PromiseLike<{ data: readonly StoredItem[] }>;
      delete(
        id: string,
        body: { conversation_id: string },
      ): PromiseLike<{ id: string }>;
      list(id: string): AsyncIterable<StoredItem>;
    };
  };
};

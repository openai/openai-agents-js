import { describe, expect, it } from 'vitest';

import { MemorySession, RequestUsage, UserError } from '@openai/agents-core';
import type {
  AgentInputItem,
  OpenAIResponsesCompactionArgs,
  OpenAIResponsesCompactionResult,
  Session,
} from '@openai/agents-core';

import { OpenAIResponsesHistoryRewriteSession } from '../src';
import { OPENAI_SESSION_API } from '../src/memory/openaiSessionApi';

describe('OpenAIResponsesHistoryRewriteSession', () => {
  it('rejects conversations-backed sessions', () => {
    const underlyingSession = new MemorySession();
    Object.defineProperty(underlyingSession, OPENAI_SESSION_API, {
      value: 'conversations',
    });

    expect(() => {
      new OpenAIResponsesHistoryRewriteSession({
        underlyingSession,
      });
    }).toThrow(UserError);
  });

  it('rewrites local history when the underlying session is not rewrite-aware', async () => {
    class PlainSession implements Session {
      items: AgentInputItem[] = [];

      async getSessionId(): Promise<string> {
        return 'session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return this.items.map((item) => structuredClone(item));
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.items.push(...items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return this.items.pop();
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }
    }

    const session = new OpenAIResponsesHistoryRewriteSession({
      underlyingSession: new PlainSession(),
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call',
        callId: 'call_override',
        name: 'lookup_customer_profile',
        status: 'completed',
        arguments: JSON.stringify({ id: '1' }),
      },
      {
        type: 'function_call',
        callId: 'call_override',
        name: 'lookup_customer_profile',
        status: 'completed',
        arguments: JSON.stringify({ id: '2' }),
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ] as AgentInputItem[]);

    await session.applyHistoryMutations({
      mutations: [
        {
          type: 'replace_function_call',
          callId: 'call_override',
          replacement: {
            type: 'function_call',
            callId: 'call_override',
            name: 'lookup_customer_profile',
            status: 'completed',
            arguments: JSON.stringify({ id: '2' }),
          },
        },
      ],
    });

    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call',
        callId: 'call_override',
        name: 'lookup_customer_profile',
        status: 'completed',
        arguments: JSON.stringify({ id: '2' }),
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ]);
  });

  it('does not append a replacement when the underlying session already trimmed the original call', async () => {
    class PlainSession implements Session {
      items: AgentInputItem[] = [];

      async getSessionId(): Promise<string> {
        return 'session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return this.items.map((item) => structuredClone(item));
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.items.push(...items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return this.items.pop();
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }
    }

    const session = new OpenAIResponsesHistoryRewriteSession({
      underlyingSession: new PlainSession(),
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ] as AgentInputItem[]);

    await session.applyHistoryMutations({
      mutations: [
        {
          type: 'replace_function_call',
          callId: 'call_override',
          replacement: {
            type: 'function_call',
            callId: 'call_override',
            name: 'lookup_customer_profile',
            status: 'completed',
            arguments: JSON.stringify({ id: '2' }),
          },
        },
      ],
    });

    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ]);
  });

  it('forwards compaction requests when the underlying session supports them', async () => {
    class TrackingSession implements Session {
      async getSessionId(): Promise<string> {
        return 'session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return [];
      }

      async addItems(_items: AgentInputItem[]): Promise<void> {}

      async popItem(): Promise<AgentInputItem | undefined> {
        return undefined;
      }

      async clearSession(): Promise<void> {}

      async runCompaction(
        args?: OpenAIResponsesCompactionArgs,
      ): Promise<OpenAIResponsesCompactionResult | null> {
        return {
          usage: new RequestUsage({
            inputTokens: args?.responseId === 'resp_1' ? 1 : 0,
            outputTokens: 2,
            totalTokens: 3,
          }),
        };
      }
    }

    const session = new OpenAIResponsesHistoryRewriteSession({
      underlyingSession: new TrackingSession() as Session & {
        [OPENAI_SESSION_API]?: 'responses';
      },
    });

    await expect(
      session.runCompaction({ responseId: 'resp_1' }),
    ).resolves.toMatchObject({
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    });
  });
});

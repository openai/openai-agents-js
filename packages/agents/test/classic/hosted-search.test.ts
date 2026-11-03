import { describe, expect, it, onTestFinished } from 'vitest';
import type OpenAI from 'openai';
import {
  Agent,
  OpenAIProvider,
  Runner,
  assistant,
  user,
  webSearchTool,
} from '@openai/agents/classic';
import { startHostedSearchServer } from './fixtures/hosted-search-http';

const model = 'gpt-4.1';
const measuredUsage: OpenAI.Responses.ResponseUsage = {
  input_tokens: 12,
  input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
  output_tokens: 7,
  output_tokens_details: { reasoning_tokens: 3 },
  total_tokens: 19,
};

function message(
  text: string,
  annotations: OpenAI.Responses.ResponseOutputText['annotations'] = [],
  id = 'msg_fixture',
): OpenAI.Responses.ResponseOutputMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations, logprobs: [] }],
  };
}

function response(
  id: string,
  output: OpenAI.Responses.ResponseOutputItem[],
  usage?: OpenAI.Responses.ResponseUsage,
) {
  return {
    id,
    object: 'response',
    created_at: 1,
    status: 'completed',
    model,
    error: null,
    incomplete_details: null,
    output,
    ...(usage === undefined ? {} : { usage }),
  } satisfies Partial<OpenAI.Responses.Response>;
}

async function setup(reply: Parameters<typeof startHostedSearchServer>[0]) {
  const server = await startHostedSearchServer(reply);
  onTestFinished(async () => {
    await server.close();
    expect(server.errors).toEqual([]);
  });
  const provider = new OpenAIProvider({
    apiKey: 'synthetic-hosted-search-key',
    baseURL: server.baseURL,
    useResponses: true,
    useResponsesWebSocket: false,
  });
  onTestFinished(() => provider.close());
  return {
    server,
    runner: new Runner({ modelProvider: provider, tracingDisabled: true }),
  };
}

describe('classic hosted search over Responses HTTP', () => {
  it('forwards controls and prior messages, then consumes actual cited results on the next turn', async () => {
    const text = 'The library opens at nine.';
    const citation: OpenAI.Responses.ResponseOutputText.URLCitation = {
      type: 'url_citation',
      url: 'https://library.example.org/opening-hours',
      title: 'Library opening hours',
      start_index: 0,
      end_index: text.length,
    };
    const search: OpenAI.Responses.ResponseFunctionWebSearch = {
      id: 'ws_hours',
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        queries: ['library opening hours'],
        sources: [{ type: 'url', url: citation.url }],
      },
    };
    const { runner, server } = await setup((body, index) => {
      if (index === 0) {
        return response(
          'resp_search',
          [search, message(text, [citation])],
          measuredUsage,
        );
      }
      // The next answer depends on the citation actually replayed over HTTP.
      const input = body.input as OpenAI.Responses.ResponseInput;
      const prior = input.find(
        (item): item is OpenAI.Responses.ResponseOutputMessage =>
          item.type === 'message' && item.role === 'assistant' && 'id' in item,
      );
      const output = prior?.content.find((part) => part.type === 'output_text');
      const actualCitation = output?.annotations.find(
        (item) => item.type === 'url_citation',
      );
      if (!actualCitation)
        throw new Error('The next request lost the prior citation');
      return response('resp_followup', [
        message(
          `Continue from ${actualCitation.title}: ${actualCitation.url}`,
          [],
          'msg_followup',
        ),
      ]);
    });
    const location = {
      type: 'approximate',
      city: 'London',
      country: 'GB',
      region: 'England',
      timezone: 'Europe/London',
    } satisfies NonNullable<
      Parameters<typeof webSearchTool>[0]
    >['userLocation'];
    const agent = new Agent({
      name: 'cited research',
      model,
      modelSettings: { toolChoice: 'web_search', preserveRawUsage: true },
      tools: [
        webSearchTool({
          filters: {
            allowedDomains: ['library.example.org', 'council.example.org'],
          },
          userLocation: location,
        }),
      ],
    });
    const first = await runner.run(agent, [
      user('We are planning a library visit.'),
      assistant('I will check the opening hours.'),
      user('Find the opening time.'),
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      path: '/v1/responses',
      authorization: 'Bearer synthetic-hosted-search-key',
      body: {
        model,
        stream: false,
        tool_choice: { type: 'web_search' },
        tools: [
          {
            type: 'web_search',
            filters: {
              allowed_domains: ['library.example.org', 'council.example.org'],
            },
            user_location: location,
            search_context_size: 'medium',
          },
        ],
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'We are planning a library visit.' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'I will check the opening hours.' },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Find the opening time.' }],
          },
        ],
      },
    });
    expect(first.finalOutput).toBe(text);
    const raw = first.rawResponses[0]!;
    expect(raw.providerData).toMatchObject({
      output: [search, message(text, [citation])],
      usage: measuredUsage,
    });
    expect(raw.rawUsage).toEqual(measuredUsage);
    expect(raw.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
    });
    expect(first.runContext.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
    });
    const normalized = expect.arrayContaining([
      expect.objectContaining({
        type: 'hosted_tool_call',
        name: 'web_search_call',
        status: 'completed',
        providerData: expect.objectContaining({ action: search.action }),
      }),
      expect.objectContaining({
        role: 'assistant',
        content: [
          expect.objectContaining({
            type: 'output_text',
            text,
            providerData: expect.objectContaining({ annotations: [citation] }),
          }),
        ],
      }),
    ]);
    expect(raw.output).toEqual(normalized);
    expect(first.output).toEqual(normalized);
    expect(first.history).toEqual(normalized);
    const serialized = JSON.parse(JSON.stringify(first.rawResponses));
    expect(serialized[0]).toMatchObject({
      rawUsage: measuredUsage,
      providerData: {
        output: [search, message(text, [citation])],
        usage: measuredUsage,
      },
    });
    expect(serialized[0].output).toEqual(normalized);
    expect(JSON.parse(JSON.stringify(first.history))).toEqual(normalized);
    // The provider sent source URLs, not retrieved passages. Do not relabel answer text.
    const hostedCall = raw.output.find(
      (item) => item.type === 'hosted_tool_call',
    );
    expect(hostedCall?.providerData).toEqual({
      id: search.id,
      type: search.type,
      action: search.action,
    });

    const second = await runner.run(
      agent.clone({
        modelSettings: { toolChoice: 'auto', preserveRawUsage: true },
      }),
      [...first.history, user('Use that cited source in the next answer.')],
    );
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.body.tool_choice).toBe('auto');
    expect(server.requests[1]!.body.input).toEqual(
      expect.arrayContaining([search, message(text, [citation])]),
    );
    expect(second.finalOutput).toBe(
      `Continue from ${citation.title}: ${citation.url}`,
    );
  });

  it.each([
    { label: 'unknown', usage: undefined, toolChoice: undefined },
    {
      label: 'measured zero',
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
      toolChoice: 'none' as const,
    },
  ])(
    'preserves $label usage without inventing citations or passages',
    async ({ usage, toolChoice }) => {
      const { runner, server } = await setup(() =>
        response(
          'resp_no_sources',
          [message('No source evidence was returned.')],
          usage,
        ),
      );
      const agent = new Agent({
        name: 'optional evidence',
        model,
        tools: [webSearchTool()],
        modelSettings: {
          preserveRawUsage: true,
          ...(toolChoice ? { toolChoice } : {}),
        },
      });
      const result = await runner.run(
        agent,
        'Answer only from available evidence.',
      );
      const body = server.requests[0]!.body;
      expect(server.requests).toHaveLength(1);
      expect(body.tools).toEqual([
        { type: 'web_search', search_context_size: 'medium' },
      ]);
      if (toolChoice) expect(body.tool_choice).toBe('none');
      else expect(body).not.toHaveProperty('tool_choice');
      const raw = result.rawResponses[0]!;
      expect(raw.usage).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      });
      expect(raw.rawUsage).toEqual(usage);
      if (usage) expect(raw.providerData).toHaveProperty('usage', usage);
      else expect(raw.providerData).not.toHaveProperty('usage');
      expect(raw.output).toEqual([
        expect.objectContaining({
          content: [
            expect.objectContaining({
              providerData: expect.objectContaining({ annotations: [] }),
            }),
          ],
        }),
      ]);
      expect(result.finalOutput).toBe('No source evidence was returned.');
      const serialized = JSON.parse(JSON.stringify(result.rawResponses));
      if (usage) expect(serialized[0]).toHaveProperty('rawUsage', usage);
      else expect(serialized[0]).not.toHaveProperty('rawUsage');
      expect(JSON.stringify(serialized)).not.toContain('url_citation');
      expect(serialized[0].providerData).not.toHaveProperty('passages');
      // RunState keeps providerData, but does not serialize the optional rawUsage field.
      const state = result.state.toJSON();
      expect(state.modelResponses[0]).not.toHaveProperty('rawUsage');
      if (usage)
        expect(state.modelResponses[0]!.providerData).toHaveProperty(
          'usage',
          usage,
        );
      else
        expect(state.modelResponses[0]!.providerData).not.toHaveProperty(
          'usage',
        );
    },
  );
});

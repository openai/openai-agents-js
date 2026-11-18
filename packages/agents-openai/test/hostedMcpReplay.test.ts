import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { Agent, hostedMcpTool, Runner } from '@openai/agents-core';
import { OpenAIProvider } from '../src/openaiProvider';

describe('hosted MCP history replay', () => {
  it.each([false, true])(
    'preserves approved MCP results in the next request (stream=%s)',
    async (stream) => {
      const call = {
        type: 'mcp_call' as const,
        id: 'mcp_1',
        name: 'lookup',
        arguments: '{}',
        server_label: 'server',
        status: 'completed' as const,
        approval_request_id: 'approval_1',
        output: 'The lookup result is 42.',
      };
      const reasoning = {
        type: 'reasoning' as const,
        id: 'rs_1',
        summary: [],
        encrypted_content: 'synthetic-encrypted-reasoning',
      };
      const message = {
        type: 'message' as const,
        id: 'msg_1',
        role: 'assistant' as const,
        status: 'completed' as const,
        content: [
          { type: 'output_text' as const, text: '42', annotations: [] },
        ],
      };
      const outputs = [
        [
          {
            type: 'mcp_approval_request',
            id: 'approval_1',
            name: 'lookup',
            arguments: '{}',
            server_label: 'server',
          },
        ],
        [call, reasoning, message],
        [message],
      ];
      const bodies: OpenAI.Responses.ResponseCreateParams[] = [];
      // Capture real wire conversion and JSON serialization; ScriptedModel skips both.
      // Synthetic reasoning only verifies passthrough, not server-side verification.
      const client = new OpenAI({
        apiKey: 'test-key',
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(init!.body as string));
          const response = {
            id: `resp_${bodies.length}`,
            object: 'response',
            status: 'completed',
            output: outputs[bodies.length - 1],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
          return new Response(
            stream
              ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response })}\n\n`
              : JSON.stringify(response),
            {
              headers: {
                'content-type': stream
                  ? 'text/event-stream'
                  : 'application/json',
              },
            },
          );
        },
      });
      const runner = new Runner({
        modelProvider: new OpenAIProvider({ openAIClient: client }),
        tracingDisabled: true,
      });
      const agent = new Agent({
        name: 'MCP replay',
        model: 'gpt-5',
        modelSettings: { store: false },
        tools: [
          hostedMcpTool({
            serverLabel: 'server',
            serverUrl: 'https://mcp.example.com',
            requireApproval: 'always',
          }),
        ],
      });
      const interrupted = stream
        ? await runner.run(agent, 'Look up the answer.', { stream: true })
        : await runner.run(agent, 'Look up the answer.');
      if ('completed' in interrupted) await interrupted.completed;
      expect(interrupted.interruptions).toHaveLength(1);
      interrupted.state.approve(interrupted.interruptions[0]);

      const approved = stream
        ? await runner.run(agent, interrupted.state, { stream: true })
        : await runner.run(agent, interrupted.state);
      if ('completed' in approved) await approved.completed;
      expect(approved.finalOutput).toBe('42');
      expect(bodies[1].input).toContainEqual(
        expect.objectContaining({
          type: 'mcp_approval_response',
          approval_request_id: 'approval_1',
          approve: true,
        }),
      );
      const savedCall = approved.history.find(
        (item) => item.type === 'hosted_tool_call' && item.name === 'mcp_call',
      );
      expect(savedCall).toHaveProperty('output', call.output);
      expect(savedCall?.providerData).not.toHaveProperty('output');

      const nextInput = [
        ...approved.history,
        { role: 'user' as const, content: 'Repeat the answer.' },
      ];
      const next = stream
        ? await runner.run(agent, nextInput, { stream: true })
        : await runner.run(agent, nextInput);
      if ('completed' in next) await next.completed;
      expect(bodies).toHaveLength(3);
      expect(bodies[2].store).toBe(false);
      expect(bodies[2].previous_response_id).toBeUndefined();
      expect(bodies[2].input).toEqual(
        expect.arrayContaining([call, reasoning]),
      );
    },
  );
});

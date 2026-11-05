import assert from 'node:assert/strict';
import { z } from 'zod';
import { Agent, Runner, ToolOutput, tool } from '@openai/agents-codex';
import {
  text,
  toolCall,
  withScriptedResponses,
} from '@openai/agents-codex/testing';

/**
 * Exercise the public request, argument and result controls without live credentials.
 * The scripted provider uses explicit HTTP and a standard Responses (non-Lite) model.
 * Select eager ordinary tools for each sampling step of a direct root.
 * beforeStep may narrow a mixed opening catalog. Deferred sampled tools fail before the editor.
 * Environment, code mode, children and automatic compaction are outside this profile.
 * Pre-turn or mid-turn automatic compaction fails before any hidden model request.
 * Shorten the input or start a new operation without the callback. Earlier tool effects remain.
 * Post-turn compaction is refused while preserving the completed answer.
 * Supply new input to Agent.run when using prepareRequest. A resumed turn cannot add an editor.
 * Sampling edits do not change canonical history, executable schemas or policies.
 * For structured output, use native mode or prompted mode with maxRetries: 0.
 */
export async function runPreparedRequestExample(): Promise<string> {
  const effects: string[] = [];
  const lookup = tool({
    name: 'lookup',
    description: 'Look up a synthetic record.',
    parameters: z.object({ key: z.enum(['allowed']), label: z.string() }),
    before: ({ callId, originalArguments }) => {
      assert.equal(callId, 'lookup');
      assert.deepEqual(originalArguments, {
        key: 'allowed',
        label: 'original',
      });
      return {
        action: 'replaceArguments',
        arguments: { key: 'allowed' as const, label: 'corrected' },
      };
    },
    execute: ({ key, label }) => {
      effects.push(label);
      return `Raw record ${key}`;
    },
    after: (_output, { callId, effectiveArguments }) => {
      assert.equal(callId, 'lookup');
      assert.equal(effectiveArguments.label, 'corrected');
      return new ToolOutput([{ type: 'inputText', text: 'SHAPED_RESULT' }]);
    },
  });
  return withScriptedResponses(
    [
      [
        toolCall(
          'lookup',
          { key: 'allowed', label: 'original' },
          { callId: 'lookup' },
        ),
      ],
      [text('The record is allowed.')],
    ],
    async (peer) => {
      const result = await Runner.run(
        new Agent({
          model: 'gpt-5.5',
          instructions: 'Call lookup, then explain its result.',
          provider: peer.provider,
          tools: [lookup],
        }),
        'Look up the record.',
        {
          prepareRequest({ request, signal }) {
            signal.throwIfAborted();
            // Recovery can advance the index without a result. Inspect native input.
            if (
              !request.input.some(
                (item) =>
                  item !== null &&
                  typeof item === 'object' &&
                  !Array.isArray(item) &&
                  item.type === 'function_call_output' &&
                  item.call_id === 'lookup',
              )
            )
              return;
            request.instructions = 'Explain the lookup result in one sentence.';
            request.input.push({
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'SAMPLING_ONLY_NOTE' }],
            });
            request.tools[0].description = 'Sampled record description.';
            request.tools[0].parameters.properties = {
              key: { type: 'string', enum: ['allowed', 'sampled-only'] },
              label: { type: 'string' },
            };
            return request;
          },
        },
      );
      assert.deepEqual(effects, ['corrected']);
      assert.equal(peer.toolOutput('lookup'), 'SHAPED_RESULT');
      assert.equal(peer.requests.length, 2);
      assert.match(
        JSON.stringify(peer.requests[1].input),
        /SAMPLING_ONLY_NOTE/,
      );
      assert.match(
        JSON.stringify(peer.requests[1].tools),
        /Sampled record description/,
      );
      assert.match(
        JSON.stringify(peer.requests[1].input),
        /Explain the lookup result in one sentence/,
      );
      return result.finalOutput;
    },
  );
}

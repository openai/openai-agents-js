import assert from 'node:assert/strict';
import test from 'node:test';

import OpenAI from 'openai';
import { Agent, setTracingDisabled, tool } from '@openai/agents';
import {
  OpenAIHostedMultiAgentModel,
  getHostedAgentMetadata,
} from '@openai/agents-openai/experimental/hosted-multi-agent';
import { z } from 'zod';

import { createRunner, hostedModel, isBetaAccessError } from '../helpers.mjs';

setTracingDisabled(true);

test('hosted multi-agent preserves subagent tool caller identity', async (t) => {
  const callers = new Set();
  const callIds = new Set();
  const inspectProposal = tool({
    name: 'inspect_proposal',
    description: 'Return deterministic details for one proposal.',
    parameters: z.object({ proposal: z.enum(['alpha', 'beta']) }),
    execute: async ({ proposal }, _context, details) => {
      const metadata = getHostedAgentMetadata(details);
      callers.add(metadata?.agentName ?? '/root');
      callIds.add(details?.toolCall?.callId);
      return {
        proposal,
        estimatedWeeks: proposal === 'alpha' ? 6 : 8,
      };
    },
  });
  const model = new OpenAIHostedMultiAgentModel(new OpenAI(), hostedModel, {
    maxConcurrentSubagents: 2,
  });

  try {
    const agent = new Agent({
      name: 'Published hosted coordinator',
      model,
      instructions:
        'Create two subagents. Have one inspect proposal alpha and the other inspect proposal beta. Each subagent must call inspect_proposal before you compare them.',
      tools: [inspectProposal],
    });
    const result = await createRunner().run(
      agent,
      'Compare proposal alpha and proposal beta.',
      { maxTurns: 6 },
    );

    assert.ok(result.finalOutput);
    assert.equal(callIds.size, 2);
    assert.ok(callers.size >= 2);
    assert.equal(callers.has('/root'), false);
  } catch (error) {
    if (isBetaAccessError(error)) {
      return t.skip(`Hosted multi-agent beta is unavailable: ${error}`);
    }
    throw error;
  } finally {
    await model.close();
  }
});

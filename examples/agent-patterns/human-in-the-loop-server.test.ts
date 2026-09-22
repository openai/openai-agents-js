import { describe, expect, it, vi } from 'vitest';
import { Agent, RunState, tool } from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from '@openai/agents/testing';
import { z } from 'zod';
import {
  ApprovalServer,
  type PendingApproval,
} from '../docs/human-in-the-loop/server';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeServer(
  options: {
    multiple?: boolean;
    repeat?: boolean;
    outcome?: 'success' | 'failure' | 'cancel';
  } = {},
) {
  const calls: string[] = [];
  const started = deferred();
  const release = deferred();
  const firstCalls = [
    functionCall(
      'send_report',
      { destination: 'original' },
      { callId: 'call-1' },
    ),
  ];
  if (options.multiple)
    firstCalls.push(
      functionCall(
        'send_report',
        { destination: 'second' },
        { callId: 'call-2' },
      ),
    );
  const model = new ScriptedModel([
    firstCalls,
    ...(options.repeat
      ? [
          [
            functionCall(
              'send_report',
              { destination: 'second' },
              { callId: 'call-2' },
            ),
          ],
        ]
      : []),
    modelResponder(async () => {
      if (options.outcome) {
        started.resolve();
        await release.promise;
        if (options.outcome === 'failure')
          throw new Error('Synthetic model failure');
      }
      return [assistantMessage('done')];
    }),
  ]);
  const server = new ApprovalServer(
    new Agent({
      name: 'Reports',
      model,
      tools: [
        tool({
          name: 'send_report',
          description: 'Record a synthetic destination.',
          parameters: z.object({ destination: z.string() }),
          needsApproval: true,
          execute: async ({ destination }) => {
            calls.push(destination);
            return 'sent';
          },
        }),
      ],
    }),
  );
  return { server, calls, started, release, model };
}

async function pending(server: ApprovalServer): Promise<PendingApproval> {
  const result = await server.start('owner', 'Send a synthetic report');
  expect(result.kind).toBe('approval');
  if (result.kind !== 'approval') throw new Error('Expected pending approval');
  return result;
}

function decisionsFor(request: PendingApproval, approved = true) {
  return Object.fromEntries(
    request.prompts.map((prompt) => [prompt.decisionId, approved]),
  );
}

describe('server-owned approval example', () => {
  it.each([true, false])(
    'keeps state private and applies the owner decision %s to stored arguments',
    async (approved) => {
      const { server, calls, model } = makeServer();
      const request = await pending(server);
      expect(Object.keys(request).sort()).toEqual([
        'kind',
        'prompts',
        'requestId',
      ]);
      expect(Object.keys(request.prompts[0]).sort()).toEqual([
        'arguments',
        'decisionId',
        'toolName',
      ]);
      request.prompts[0].arguments = '{"destination":"changed by client"}';
      request.prompts[0].toolName = 'another_tool';
      const decisions = decisionsFor(request, approved);
      const result = server.decide('owner', request.requestId, decisions);
      // Mutation after submission cannot change the copied decision either.
      decisions[request.prompts[0].decisionId] = !approved;
      expect(await result).toEqual({ kind: 'completed', output: 'done' });
      expect(calls).toEqual(approved ? ['original'] : []);
      await expect(
        server.decide('owner', request.requestId, decisions),
      ).rejects.toThrow('unavailable');
      model.assertComplete();
    },
  );

  it('rejects foreign owners and unknown IDs without consuming the owned request', async () => {
    const { server, calls } = makeServer();
    const request = await pending(server);
    const decisions = decisionsFor(request);
    await expect(
      server.decide('other', request.requestId, decisions),
    ).rejects.toThrow('unavailable');
    await expect(server.decide('owner', 'unknown', decisions)).rejects.toThrow(
      'unavailable',
    );
    expect(calls).toEqual([]);
    await server.decide('owner', request.requestId, decisions);
    expect(calls).toEqual(['original']);
  });

  it.each([
    'missing',
    'foreign',
    'extra',
    'non_boolean',
    'snapshot',
    'null',
    'array',
  ])('rejects an invalid %s batch before consumption', async (kind) => {
    const { server, calls } = makeServer();
    const request = await pending(server);
    const id = request.prompts[0].decisionId;
    const invalid: Record<string, unknown> = {
      missing: {},
      foreign: { unknown: true },
      extra: { [id]: true, unknown: false },
      non_boolean: { [id]: 'true' },
      snapshot: { [id]: true, context: { approvals: { send_report: true } } },
      null: null,
      array: [true],
    };
    await expect(
      server.decide('owner', request.requestId, invalid[kind]),
    ).rejects.toThrow('one boolean decision');
    expect(calls).toEqual([]);
    await server.decide('owner', request.requestId, { [id]: false });
    expect(calls).toEqual([]);
  });

  it('requires a complete batch and maps decisions by stored IDs, not submission order', async () => {
    const { server, calls } = makeServer({ multiple: true });
    const request = await pending(server);
    const [first, second] = request.prompts;
    await expect(
      server.decide('owner', request.requestId, { [first.decisionId]: true }),
    ).rejects.toThrow('one boolean decision');
    expect(calls).toEqual([]);
    await server.decide('owner', request.requestId, {
      [second.decisionId]: false,
      [first.decisionId]: true,
    });
    expect(calls).toEqual(['original']);
  });

  it('binds a new approval batch to new owner-checked IDs', async () => {
    const { server, calls } = makeServer({ repeat: true });
    const first = await pending(server);
    const second = await server.decide(
      'owner',
      first.requestId,
      decisionsFor(first),
    );
    if (second.kind !== 'approval')
      throw new Error('Expected another approval');
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.prompts[0].decisionId).not.toBe(first.prompts[0].decisionId);
    await expect(
      server.decide('owner', second.requestId, decisionsFor(first)),
    ).rejects.toThrow('one boolean decision');
    await expect(
      server.decide('other', second.requestId, decisionsFor(second)),
    ).rejects.toThrow('unavailable');
    await server.decide('owner', second.requestId, decisionsFor(second, false));
    expect(calls).toEqual(['original']);
  });

  it.each(['success', 'failure', 'cancel'] as const)(
    'prevents in-flight and later replay after %s',
    async (outcome) => {
      const { server, calls, started, release } = makeServer({ outcome });
      const request = await pending(server);
      const decisions = decisionsFor(request);
      const controller = new AbortController();
      const first = server.decide(
        'owner',
        request.requestId,
        decisions,
        controller.signal,
      );
      // Attach a handler before cancellation can reject the pending run.
      const settled = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await started.promise;
        await expect(
          server.decide('owner', request.requestId, decisions),
        ).rejects.toThrow('unavailable');
        if (outcome === 'cancel')
          controller.abort(new Error('Synthetic cancellation'));
        release.resolve();
        const result = await settled;
        if (outcome === 'success')
          expect(result).toEqual({
            value: { kind: 'completed', output: 'done' },
          });
        else {
          expect(result).toHaveProperty('error');
          if ('error' in result)
            expect(String(result.error)).toMatch(
              outcome === 'failure'
                ? /Synthetic model failure/
                : /Synthetic cancellation|aborted/,
            );
        }
        await expect(
          server.decide('owner', request.requestId, decisions),
        ).rejects.toThrow('unavailable');
        expect(calls).toEqual(['original']);
      } finally {
        release.resolve();
        await settled;
      }
    },
  );

  it('consumes before deserialization, including a restore failure', async () => {
    const { server, calls } = makeServer();
    const request = await pending(server);
    const restore = vi
      .spyOn(RunState, 'fromString')
      .mockRejectedValueOnce(new Error('Synthetic restore failure'));
    try {
      await expect(
        server.decide('owner', request.requestId, decisionsFor(request)),
      ).rejects.toThrow('Synthetic restore failure');
    } finally {
      restore.mockRestore();
    }
    await expect(
      server.decide('owner', request.requestId, decisionsFor(request)),
    ).rejects.toThrow('unavailable');
    expect(calls).toEqual([]);
  });
});

import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider } from '../../src';
import type { ModelRequest } from '../../src';
import { call, message } from './fixtures/model-server';

it('dispatches a native handoff through the destination model backend', async () => {
  const routeCall = 'borrowed-profile-transfer';
  const sourceComplete = vi.fn((_request: ModelRequest) => ({
    output: [call('transfer_to_destination', {}, { callId: routeCall })],
  }));
  const destinationComplete = vi.fn((request: ModelRequest) => {
    expect(request.context).toEqual({ owner: 'workflow' });
    expect(JSON.stringify(request.body.input)).toContain('Destination only.');
    if (destinationComplete.mock.calls.length === 1)
      expect(request.body.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: routeCall,
          }),
        ]),
      );
    return { output: [message('destination response')] };
  });
  await using source = new NativeProvider({
    modelBackend: { complete: sourceComplete },
  });
  await using destination = new NativeProvider({
    modelBackend: { complete: destinationComplete },
  });
  const target = new Agent<{ owner: string }>({
    name: 'destination',
    instructions: 'Destination only.',
    provider: destination,
  });
  const agent = new Agent<{ owner: string }>({
    instructions: 'Source only.',
    provider: source,
    handoffs: [target],
  });
  let saved;
  {
    await using session = await agent.session({
      context: { owner: 'workflow' },
    });
    await expect(destination.close()).rejects.toThrow(
      'open or opening sessions',
    );
    expect((await (await session.submit('Route.')).wait()).finalOutput).toBe(
      'destination response',
    );
    expect(await session.getActiveAgent()).toBe(target);
    saved = await session.saveState();
  }
  await using restored = await agent.session({
    state: saved,
    context: { owner: 'workflow' },
  });
  expect(await restored.getActiveAgent()).toBe(target);
  expect((await (await restored.submit('Continue.')).wait()).finalOutput).toBe(
    'destination response',
  );
  expect(sourceComplete).toHaveBeenCalledOnce();
  expect(destinationComplete).toHaveBeenCalledTimes(2);
});

it('uses the destination backend to repair its prompted completion', async () => {
  const sourceComplete = vi.fn(() => ({
    output: [
      call('transfer_to_destination', {}, { callId: 'repair-transfer' }),
    ],
  }));
  const destinationComplete = vi.fn((request: ModelRequest) => {
    const repairing =
      request.body.instructions ===
        'Correct the supplied JSON to match its schema. Return only JSON.' ||
      JSON.stringify(request.body.input).includes('Correct the supplied JSON');
    return { output: [message(repairing ? '{"value":"repaired"}' : 'broken')] };
  });
  await using source = new NativeProvider({
    modelBackend: { complete: sourceComplete },
  });
  await using destination = new NativeProvider({
    modelBackend: { complete: destinationComplete },
  });
  const schema = z.object({ value: z.string() });
  const target = new Agent({
    name: 'destination',
    instructions: 'Destination.',
    provider: destination,
    outputType: { mode: 'prompted', schema, maxRetries: 1 },
  });
  const root = new Agent({
    instructions: 'Source.',
    provider: source,
    outputType: { mode: 'prompted', schema, maxRetries: 0 },
    handoffs: [target],
  });
  const result = await root.run('Route and format.');
  expect(result.finalOutput).toEqual({ value: 'repaired' });
  expect(result.repairAttempts).toHaveLength(1);
  expect(sourceComplete).toHaveBeenCalledOnce();
  expect(destinationComplete).toHaveBeenCalledTimes(2);
});

it('unwinds reserved profile backends if a reachable provider is closed', async () => {
  const calls = vi.fn(() => ({ output: [message('unexpected')] }));
  await using source = new NativeProvider({
    modelBackend: { complete: calls },
  });
  await using first = new NativeProvider({ modelBackend: { complete: calls } });
  const closed = new NativeProvider({ modelBackend: { complete: calls } });
  await closed.close();
  const root = new Agent({
    instructions: 'Source.',
    provider: source,
    handoffs: [
      new Agent({ name: 'first', instructions: 'First.', provider: first }),
      new Agent({ name: 'closed', instructions: 'Closed.', provider: closed }),
    ],
  });
  await expect(root.session()).rejects.toThrow('NativeProvider is closed');
  await expect(first.close()).resolves.toBeUndefined();
  await expect(source.close()).resolves.toBeUndefined();
  expect(calls).not.toHaveBeenCalled();
});

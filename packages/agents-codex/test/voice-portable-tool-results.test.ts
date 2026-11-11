import { readFileSync } from 'node:fs';
import { NativeVoiceControl } from '../src/voice/portable';
import { describe, expect, it, vi } from 'vitest';
import {
  PortableVoiceSession,
  type PortableVoiceTool,
  type PortableVoiceEffect,
} from '../src/voice/portable-session';
import { backgroundResult } from '../src/voice/portable';

// This double isolates host callbacks and wire commands; real Wasm owns continuation.
async function fixture(tool: Partial<PortableVoiceTool> = {}, auto?: boolean) {
  const commands: any[] = [];
  const close = vi.fn();
  const onApproval = vi.fn(async () => true);
  const session = new PortableVoiceSession(
    {
      apply(command: any): PortableVoiceEffect[] {
        commands.push(command);
        if (command.type === 'start') return [{ type: 'ready' }];
        if (command.type === 'approve' && command.approved)
          return [
            {
              type: 'execute',
              call_id: command.call_id,
              name: 'lookup',
              arguments: { value: 7 },
            },
          ];
        if (command.type !== 'provider') return [];
        const event = command.event;
        if (event.type === 'response.created')
          return [
            {
              type: 'scope',
              response_id: event.response.id,
              profile_id: 0,
              out_of_band: false,
            },
            { type: 'event', event },
          ];
        if (event.type === 'response.done')
          return [
            { type: 'event', event },
            ...event.response.output.map((item: any) => ({
              type: tool.needsApproval ? 'approve' : 'execute',
              call_id: item.call_id,
              name: item.name,
              arguments: { value: 7 },
            })),
          ];
        return [];
      },
    },
    { send() {}, close },
    {
      model: 'test',
      instructions: 'Help.',
      onApproval,
      automaticallyTriggerResponseForMcpToolCalls: auto,
      tools: [
        {
          name: 'lookup',
          description: 'Lookup.',
          parameters: { type: 'object' },
          execute: () => ({ value: 7 }),
          ...tool,
        },
      ],
    },
  );
  await session.start();
  const invoke = (id = 'call-1') => {
    const responseId = `response-${id}`;
    session.receive({ type: 'response.created', response: { id: responseId } });
    session.receive({
      type: 'response.done',
      response: {
        id: responseId,
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id,
            call_id: id,
            name: 'lookup',
            arguments: '{"value":7}',
          },
        ],
      },
    });
  };
  const results = () =>
    commands.filter((command) => command.type === 'tool_result');
  return { session, commands, close, onApproval, invoke, results };
}

describe('portable tool result host driver', () => {
  it.each([false, true])(
    'serializes JSON with background=%s',
    async (background) => {
      const f = await fixture({
        execute: () =>
          background ? backgroundResult({ value: 7 }) : { value: 7 },
      });
      f.invoke();
      await vi.waitFor(() =>
        expect(f.results()).toEqual([
          {
            type: 'tool_result',
            call_id: 'call-1',
            output: '{"value":7}',
            ...(background ? { background: true } : {}),
          },
        ]),
      );
      expect(f.close).not.toHaveBeenCalled();
      await f.session.close();
    },
  );

  it('rejects input before execution and replaces output', async () => {
    const execute = vi.fn(() => backgroundResult({ secret: true }));
    let reject = true;
    const f = await fixture({
      execute,
      before: () =>
        reject ? { action: 'deny', reason: 'Blocked.' } : { action: 'allow' },
      after: () => ({ safe: true }),
    });
    f.invoke();
    await vi.waitFor(() => expect(f.results()[0]?.output).toBe('Blocked.'));
    expect(execute).not.toHaveBeenCalled();
    reject = false;
    f.invoke('call-2');
    await vi.waitFor(() =>
      expect(f.results()[1]).toEqual({
        type: 'tool_result',
        call_id: 'call-2',
        output: '{"safe":true}',
      }),
    );
    await f.session.close();
  });

  it('recovers execution errors per call and accepts a follow-on call', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('private'))
      .mockResolvedValueOnce('next');
    const f = await fixture({ execute });
    f.invoke();
    await vi.waitFor(() =>
      expect(f.results()[0]?.output).toBe(
        'An error occurred while running the tool. Please try again.',
      ),
    );
    f.invoke('call-2');
    await vi.waitFor(() => expect(f.results()[1]?.output).toBe('next'));
    expect(f.close).not.toHaveBeenCalled();
    await f.session.close();
  });

  it('uses the caller error formatter', async () => {
    const f = await fixture({
      execute: () => {
        throw new Error('private');
      },
      errorFunction: (_error, context) => `Failed ${context.callId}.`,
    });
    f.invoke();
    await vi.waitFor(() =>
      expect(f.results()[0]?.output).toBe('Failed call-1.'),
    );
    await f.session.close();
  });

  it.each([false, true])(
    'recovers invalid arguments and keeps following calls live (approval=%s)',
    async (approval) => {
      for (const custom of [false, true]) {
        let invalid = true;
        const execute = vi.fn(() => 'next');
        const needsApproval = vi.fn(() => true);
        const f = await fixture({
          execute,
          ...(approval ? { needsApproval } : {}),
          parseArguments: (value) => {
            if (invalid) throw new Error('Private validation detail.');
            return value as Record<string, unknown>;
          },
          ...(custom
            ? {
                errorFunction: (
                  _error: unknown,
                  context: { callId: string },
                ) => ({ error: 'Invalid arguments', callId: context.callId }),
              }
            : {}),
        });
        f.invoke();
        const output = custom
          ? '{"error":"Invalid arguments","callId":"call-1"}'
          : 'An error occurred while running the tool. Please try again.';
        await vi.waitFor(() =>
          expect(f.commands).toContainEqual({
            type: approval ? 'approve' : 'tool_result',
            call_id: 'call-1',
            output,
            ...(approval ? { approved: false } : {}),
          }),
        );
        expect(execute).not.toHaveBeenCalled();
        expect(needsApproval).not.toHaveBeenCalled();
        expect(f.onApproval).not.toHaveBeenCalled();
        invalid = false;
        f.invoke('call-2');
        await vi.waitFor(() =>
          expect(f.results().at(-1)).toEqual({
            type: 'tool_result',
            call_id: 'call-2',
            output: 'next',
          }),
        );
        expect(f.close).not.toHaveBeenCalled();
        await f.session.close();
      }
    },
  );

  it.each(['arguments', 'execution'] as const)(
    'preserves errorFunction null for %s failures',
    async (phase) => {
      const f = await fixture({
        ...(phase === 'arguments'
          ? {
              parseArguments: () => {
                throw new Error('Invalid arguments.');
              },
              needsApproval: true,
            }
          : {}),
        execute: () => {
          throw new Error('Execution failed.');
        },
        errorFunction: null,
      });
      f.invoke();
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
      expect(f.results()).toEqual([]);
      expect(f.onApproval).not.toHaveBeenCalled();
    },
  );

  it('keeps a rejected policy fatal instead of converting it into tool content', async () => {
    const execute = vi.fn(() => 'unused');
    const f = await fixture({
      execute,
      before: () => {
        throw new Error('Policy tripwire.');
      },
    });
    f.invoke();
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
    expect(f.results()).toEqual([]);
  });

  it('discards execution results that settle after close', async () => {
    const pending = Promise.withResolvers<string>();
    const execute = vi.fn(() => pending.promise);
    const f = await fixture({ execute });
    f.invoke();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const closing = f.session.close();
    pending.resolve('late');
    await closing;
    expect(f.results()).toEqual([]);
  });

  it.each([undefined, true, false])(
    'sends an MCP override only for false (%s)',
    async (auto) => {
      const f = await fixture({}, auto);
      expect(f.commands[0].config).toEqual(
        expect.objectContaining(
          auto === false ? { hosted_mcp_auto_response: false } : {},
        ),
      );
      if (auto !== false)
        expect(f.commands[0].config).not.toHaveProperty(
          'hosted_mcp_auto_response',
        );
      await f.session.close();
    },
  );
});

describe.runIf(process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1')(
  'portable tool result Wasm continuation',
  () => {
    it.each(['background', 'mixed', 'foreground'] as const)(
      'continues %s results correctly',
      async (mode) => {
        const path = process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM;
        if (!path) throw new Error('Set OPENAI_AGENTS_PORTABLE_CONTROL_WASM.');
        const control = new NativeVoiceControl(
          new WebAssembly.Module(Uint8Array.from(readFileSync(path))),
        );
        const frames: any[] = [];
        const session: PortableVoiceSession = new PortableVoiceSession(
          control,
          {
            send(frame) {
              const event = JSON.parse(frame);
              frames.push(event);
              if (event.type === 'session.update')
                queueMicrotask(() =>
                  session.receive({
                    type: 'session.updated',
                    session: event.session,
                  }),
                );
            },
            close() {},
          },
          {
            model: 'test',
            instructions: 'Help.',
            tools: [
              {
                name: 'lookup',
                description: 'Lookup.',
                parameters: { type: 'object' },
                execute: (args) =>
                  mode === 'background' ||
                  (mode === 'mixed' && args.index === 0)
                    ? backgroundResult({ index: args.index as number })
                    : { index: args.index as number },
              },
            ],
          },
        );
        await session.start();
        const output = [0, 1].map((index) => ({
          type: 'function_call',
          id: `item-${index}`,
          call_id: `call-${index}`,
          name: 'lookup',
          arguments: JSON.stringify({ index }),
        }));
        session.receive({
          type: 'response.created',
          response: { id: 'response-1' },
        });
        for (const item of output)
          session.receive({
            type: 'response.output_item.done',
            response_id: 'response-1',
            item,
          });
        session.receive({
          type: 'response.done',
          response: { id: 'response-1', status: 'completed', output },
        });
        await vi.waitFor(() =>
          expect(
            frames.filter(
              (frame) => frame.item?.type === 'function_call_output',
            ),
          ).toHaveLength(2),
        );
        expect(
          frames
            .filter((frame) => frame.item?.type === 'function_call_output')
            .map((frame) => JSON.parse(frame.item.output)),
        ).toEqual([{ index: 0 }, { index: 1 }]);
        if (mode !== 'background')
          await vi.waitFor(() =>
            expect(
              frames.filter((frame) => frame.type === 'response.create'),
            ).toHaveLength(1),
          );
        else {
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(
            frames.filter((frame) => frame.type === 'response.create'),
          ).toHaveLength(0);
        }
        await session.close();
      },
    );
  },
);

describe.runIf(process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1')(
  'portable argument failure Wasm recovery',
  () => {
    it.each([false, true])(
      'keeps a subsequent call live (approval=%s)',
      async (needsApproval) => {
        const path = process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM;
        if (!path) throw new Error('Set OPENAI_AGENTS_PORTABLE_CONTROL_WASM.');
        let invalid = true;
        const frames: any[] = [];
        const onApproval = vi.fn(async () => true);
        const execute = vi.fn(() => 'next');
        const session: PortableVoiceSession = new PortableVoiceSession(
          new NativeVoiceControl(
            new WebAssembly.Module(Uint8Array.from(readFileSync(path))),
          ),
          {
            send(frame) {
              const event = JSON.parse(frame);
              frames.push(event);
              if (event.type === 'session.update')
                queueMicrotask(() =>
                  session.receive({
                    type: 'session.updated',
                    session: event.session,
                  }),
                );
            },
            close() {},
          },
          {
            model: 'test',
            instructions: 'Help.',
            onApproval,
            tools: [
              {
                name: 'lookup',
                description: 'Lookup.',
                parameters: { type: 'object' },
                needsApproval,
                execute,
                parseArguments(value) {
                  if (invalid) throw new Error('Private validation detail.');
                  return value as Record<string, unknown>;
                },
                errorFunction: (_error, context) => ({
                  error: 'Invalid arguments',
                  callId: context.callId,
                }),
              },
            ],
          },
        );
        await session.start();
        const invoke = (index: number) => {
          const id = `response-${index}`;
          const item = {
            type: 'function_call',
            id: `item-${index}`,
            call_id: `call-${index}`,
            name: 'lookup',
            arguments: '{}',
          };
          session.receive({ type: 'response.created', response: { id } });
          session.receive({
            type: 'response.output_item.done',
            response_id: id,
            item,
          });
          session.receive({
            type: 'response.done',
            response: { id, status: 'completed', output: [item] },
          });
        };
        const results = () =>
          frames.filter((frame) => frame.item?.type === 'function_call_output');
        invoke(1);
        await vi.waitFor(() =>
          expect(results()[0]?.item.output).toBe(
            '{"error":"Invalid arguments","callId":"call-1"}',
          ),
        );
        expect(onApproval).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        invalid = false;
        invoke(2);
        await vi.waitFor(() => expect(results()[1]?.item.output).toBe('next'));
        expect(execute).toHaveBeenCalledOnce();
        await session.close();
      },
    );
  },
);

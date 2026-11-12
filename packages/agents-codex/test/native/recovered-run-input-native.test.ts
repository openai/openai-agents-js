import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  RunDiagnosticError,
  manualTool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([
  {
    label: 'string',
    input: 'original caller request',
    capture: true,
    legacy: false,
    expose: true,
  },
  {
    label: 'message',
    input: {
      role: 'user' as const,
      type: 'message' as const,
      content: [
        { type: 'input_text' as const, text: 'original caller request' },
      ],
    },
    capture: true,
    legacy: false,
    expose: true,
  },
  {
    label: 'default off',
    input: 'uncaptured caller request',
    capture: false,
    legacy: false,
    expose: true,
  },
  {
    label: 'resume exposure off',
    input: 'captured but unexposed request',
    capture: true,
    legacy: false,
    expose: false,
  },
  {
    label: 'pre-change state',
    input: 'older caller request',
    capture: true,
    legacy: true,
    expose: true,
  },
])(
  'retains only captured original input after manual recovery: $label',
  async ({ input, capture, legacy, expose }) => {
    const expected = structuredClone(input);
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'recover-input' })],
      [message('resumed answer')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-recovered-input',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      provider,
      instructions: 'Ask lookup, then answer.',
      tools: [
        manualTool({
          name: 'lookup',
          description: 'Ask lookup.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
      outputGuardrails: [
        {
          name: 'fail-after-recovery',
          callback() {
            throw new Error('synthetic recovered failure');
          },
        },
      ],
    });
    const pending = agent
      .run(input, { captureErrorDetails: capture })
      .catch((error: unknown) => error);
    if (typeof input !== 'string')
      input.content[0]!.text = 'caller mutation after admission';
    const wrapped = await pending;
    const interrupted =
      wrapped instanceof RunDiagnosticError ? wrapped.cause : wrapped;
    expect(interrupted).toBeInstanceOf(InteractionRequired);
    const state = structuredClone((interrupted as InteractionRequired).state!);
    expect(state).toBeDefined();
    if (!('manual_context' in state))
      throw new Error('Expected manual checkpoint');
    const context = state.manual_context as typeof state.manual_context & {
      original_input?: unknown;
    };
    if (legacy) delete context.original_input;
    else expect(Object.hasOwn(context, 'original_input')).toBe(capture);
    const failure = await agent
      .run(null, {
        state,
        captureErrorDetails: expose,
        onInteraction(event) {
          if (event.type !== 'action_requested')
            throw new Error('Expected manual request');
          return event.reply('accepted lookup');
        },
      })
      .catch((error: unknown) => error);
    if (!expose) {
      expect(failure).not.toBeInstanceOf(RunDiagnosticError);
      expect((failure as Error).message).toContain(
        'synthetic recovered failure',
      );
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
      return;
    }
    expect(failure).toBeInstanceOf(RunDiagnosticError);
    expect((failure as RunDiagnosticError).details.input).toEqual(
      capture && !legacy ? expected : null,
    );
    expect((failure as RunDiagnosticError).details.incomplete).toBe(
      !capture || legacy,
    );
    expect(server.requests).toHaveLength(2);
    server.assertExhausted();
  },
);

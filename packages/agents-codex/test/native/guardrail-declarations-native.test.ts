import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  type InputGuardrail,
  type OutputGuardrail,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
async function providerFor(server: ModelServer) {
  const cfg = await server.config();
  return new NativeProvider({
    baseUrl: (cfg['model_providers.fixture'] as { base_url: string }).base_url,
    apiKey: 'synthetic-guardrail-capture',
    supportsWebsockets: false,
  });
}
it('captures getter-backed callbacks once with their original receiver', async () => {
  let callbacks = 0,
    children = 0,
    parallel = 0;
  const check = {
    name: 'getter',
    get callback() {
      callbacks++;
      return function (this: unknown) {
        expect(this).toBe(check);
        return { tripwireTriggered: false };
      };
    },
    get childCallback() {
      children++;
      return function (this: unknown) {
        expect(this).toBe(check);
        return { tripwireTriggered: false };
      };
    },
    get runInParallel() {
      parallel++;
      return false;
    },
  };
  const agent = new Agent({
    instructions: 'Answer.',
    inputGuardrails: [check],
  });
  expect({ callbacks, children, parallel }).toEqual({
    callbacks: 1,
    children: 1,
    parallel: 1,
  });
  const captured = agent.inputGuardrails[0];
  expect(Object.isFrozen(captured)).toBe(true);
  await captured.callback({} as never);
  await captured.childCallback!({} as never);
});
describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'guardrail callback capture',
  () => {
    it('executes input and output prototype methods with private fields', async () => {
      class InputCheck implements InputGuardrail {
        readonly name = 'class-input';
        #brand = 'input';
        calls = 0;
        callback(_context: Parameters<InputGuardrail['callback']>[0]) {
          expect(this.#brand).toBe('input');
          this.calls++;
          return { tripwireTriggered: false };
        }
      }
      class OutputCheck implements OutputGuardrail {
        readonly name = 'class-output';
        #brand = 'output';
        calls = 0;
        callback(_context: Parameters<OutputGuardrail['callback']>[0]) {
          expect(this.#brand).toBe('output');
          this.calls++;
          return { tripwireTriggered: false };
        }
      }
      const inputCheck = new InputCheck(),
        outputCheck = new OutputCheck();
      const server = new ModelServer([[message('done')]]);
      await using provider = await providerFor(server);
      const result = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        inputGuardrails: [inputCheck],
        outputGuardrails: [outputCheck],
      }).run('question');
      expect(result.finalOutput).toBe('done');
      expect(inputCheck.calls).toBe(1);
      expect(outputCheck.calls).toBe(1);
      server.assertExhausted();
    }, 25000);
  },
);

it('captures valid callables with an own bind override', async () => {
  const callback = function (this: unknown) {
    expect(this).toBe(check);
    return { tripwireTriggered: false };
  };
  Object.defineProperty(callback, 'bind', { value: undefined });
  const check = { name: 'own-bind', callback, childCallback: callback };
  const agent = new Agent({
    instructions: 'Answer.',
    inputGuardrails: [check],
  });
  await agent.inputGuardrails[0].callback({} as never);
  await agent.inputGuardrails[0].childCallback!({} as never);
});

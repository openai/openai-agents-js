import { beforeAll, describe, expect, it } from 'vitest';

import { setDefaultModelProvider, setTracingDisabled } from '../../src';
import { withTrace } from '../../src';
import { Agent, AgentOutputType } from '../../src/agent';
import {
  buildInputGuardrailDefinitions,
  runInputGuardrails,
  runOutputGuardrails,
  splitInputGuardrails,
} from '../../src/runner/guardrails';
import {
  defineInputGuardrail,
  defineOutputGuardrail,
} from '../../src/guardrail';
import { RunContext } from '../../src/runContext';
import { RunState } from '../../src/runState';
import {
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
} from '../../src/errors';
import { Usage } from '../../src/usage';
import { RunMessageOutputItem } from '../../src/items';
import { FakeModelProvider } from '../stubs';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

type AnyAgent = Agent<unknown, AgentOutputType<unknown>>;
const makeAgent = (config: ConstructorParameters<typeof Agent>[0]): AnyAgent =>
  new Agent(config) as AnyAgent;
const makeState = (agent: Agent<unknown, any>) =>
  new RunState(new RunContext(), 'hello', agent, 3);

describe('buildInputGuardrailDefinitions', () => {
  it('merges runner and agent guardrails', () => {
    const agentGuardrail = {
      name: 'agent',
      runInParallel: false,
      execute: async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }),
    };
    const agent = makeAgent({
      name: 'A',
      inputGuardrails: [agentGuardrail],
    });
    const runnerGuardrail = defineInputGuardrail({
      name: 'runner',
      execute: async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }),
    });

    const state = makeState(agent);
    const defs = buildInputGuardrailDefinitions(state, [runnerGuardrail]);

    expect(defs.map((g) => g.name)).toEqual(['runner', 'agent']);
    expect(defs[1]?.runInParallel).toBe(false);
  });
});

describe('splitInputGuardrails', () => {
  it('splits guardrails by runInParallel flag', () => {
    const blocking = defineInputGuardrail({
      name: 'block',
      runInParallel: false,
      execute: async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }),
    });
    const parallel = defineInputGuardrail({
      name: 'parallel',
      execute: async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }),
    });

    const { blocking: blockingResult, parallel: parallelResult } =
      splitInputGuardrails([blocking, parallel]);

    expect(blockingResult.map((g) => g.name)).toEqual(['block']);
    expect(parallelResult.map((g) => g.name)).toEqual(['parallel']);
  });
});

describe('runInputGuardrails', () => {
  it('records results and returns them when no tripwire triggers', async () => {
    const agent = makeAgent({ name: 'Safe' });
    const state = makeState(agent);
    const guardrail = defineInputGuardrail({
      name: 'safe',
      execute: async () => ({
        tripwireTriggered: false,
        outputInfo: { ok: true },
      }),
    });

    const results = await withTrace('guardrails-safe', () =>
      runInputGuardrails(state, [guardrail]),
    );

    expect(results).toHaveLength(1);
    expect(state._inputGuardrailResults).toHaveLength(1);
    expect(state._currentTurn).toBe(0);
  });

  it('throws when a tripwire triggers and preserves results', async () => {
    const agent = makeAgent({ name: 'Trip' });
    const state = makeState(agent);
    const guardrail = defineInputGuardrail({
      name: 'trip',
      execute: async () => ({
        tripwireTriggered: true,
        outputInfo: { reason: 'blocked' },
      }),
    });

    await expect(
      withTrace('guardrails-trip', () =>
        runInputGuardrails(state, [guardrail]),
      ),
    ).rejects.toBeInstanceOf(InputGuardrailTripwireTriggered);
    expect(state._inputGuardrailResults).toHaveLength(1);
    expect(state._currentTurn).toBe(0);
  });

  it('wraps execution failures and rolls back the current turn', async () => {
    const agent = makeAgent({ name: 'Error' });
    const state = makeState(agent);
    state._currentTurn = 2;
    const guardrail = defineInputGuardrail({
      name: 'error',
      execute: async () => {
        throw new Error('boom');
      },
    });

    await expect(
      withTrace('guardrails-error', () =>
        runInputGuardrails(state, [guardrail]),
      ),
    ).rejects.toBeInstanceOf(GuardrailExecutionError);
    expect(state._inputGuardrailResults).toHaveLength(0);
    expect(state._currentTurn).toBe(1);
  });
});

describe('runOutputGuardrails', () => {
  it('runs runner and agent guardrails and stores results', async () => {
    const agent = makeAgent({
      name: 'Output',
      outputGuardrails: [
        {
          name: 'agent-out',
          execute: async () => ({
            tripwireTriggered: false,
            outputInfo: { agent: true },
          }),
        },
      ],
    });
    const state = makeState(agent);
    state._lastTurnResponse = { output: [], usage: new Usage() };
    const runnerGuardrail = defineOutputGuardrail({
      name: 'runner-out',
      execute: async () => ({
        tripwireTriggered: false,
        outputInfo: { runner: true },
      }),
    });

    await withTrace('guardrails-output-success', () =>
      runOutputGuardrails(state, [runnerGuardrail as any], 'hi'),
    );

    expect(state._outputGuardrailResults.map((r) => r.guardrail.name)).toEqual(
      expect.arrayContaining(['runner-out', 'agent-out']),
    );
  });

  it('throws when any output guardrail trips and preserves recorded results', async () => {
    const agent = makeAgent({ name: 'TripOutput' });
    const state = makeState(agent);
    const runnerGuardrail = defineOutputGuardrail({
      name: 'trip',
      execute: async () => ({
        tripwireTriggered: true,
        outputInfo: { reason: 'bad' },
      }),
    });
    state._generatedItems = [
      new RunMessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok' }],
        },
        agent as Agent<unknown, 'text'>,
      ),
    ];

    await expect(
      withTrace('guardrails-output-trip', () =>
        runOutputGuardrails(state, [runnerGuardrail as any], 'ok'),
      ),
    ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
    expect(state._outputGuardrailResults).toHaveLength(1);
  });

  it('wraps errors from guardrails without recording results', async () => {
    const agent = makeAgent({ name: 'OutError' });
    const state = makeState(agent);
    const runnerGuardrail = defineOutputGuardrail({
      name: 'error',
      execute: async () => {
        throw new Error('nope');
      },
    });

    await expect(
      withTrace('guardrails-output-error', () =>
        runOutputGuardrails(state, [runnerGuardrail as any], 'ok'),
      ),
    ).rejects.toBeInstanceOf(GuardrailExecutionError);
    expect(state._outputGuardrailResults).toHaveLength(0);
  });
});

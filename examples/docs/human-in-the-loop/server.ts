import { randomUUID } from 'node:crypto';
import { Agent, Runner, RunState, type RunResult } from '@openai/agents';
import { z } from 'zod';

export type PendingApproval = {
  kind: 'approval';
  requestId: string;
  prompts: { decisionId: string; toolName: string; arguments: string }[];
};

type StoredRun = {
  ownerId: string;
  snapshot: string;
  decisionIds: string[];
};

// Simulation only: one event loop in one process. Production storage needs an
// atomic owner-checked consume operation and bounded retention. Consumption is
// permanent even after failure/cancellation; reconcile side effects before retry.
export class ApprovalServer {
  #agent: Agent;
  #runner = new Runner({ tracingDisabled: true });
  #pending = new Map<string, StoredRun>();

  constructor(agent: Agent) {
    this.#agent = agent;
  }

  // An HTTP adapter must obtain this identity from trusted authentication
  // middleware and apply request/CSRF protections. Never read it from the body.
  async start(authenticatedUserId: string, message: string) {
    const result = await this.#runner.run(this.#agent, message);
    return this.#save(authenticatedUserId, result);
  }

  #save<TContext, TAgent extends Agent<any, any>>(
    ownerId: string,
    result: RunResult<TContext, TAgent>,
  ) {
    const interruptions = result.state.getInterruptions();
    if (interruptions.length === 0) {
      // RunResult stays on the server; the app selects what the client may see.
      return { kind: 'completed' as const, output: result.finalOutput };
    }
    const requestId = randomUUID();
    const decisionIds = interruptions.map(() => randomUUID());
    this.#pending.set(requestId, {
      ownerId,
      snapshot: result.state.toString(),
      decisionIds,
    });
    const response: PendingApproval = {
      kind: 'approval',
      requestId,
      // Detached display values only. Filter arguments for the reviewer's access
      // policy; this demo uses synthetic weather data. Escape HTML in a web UI.
      prompts: interruptions.map((item, index) => ({
        decisionId: decisionIds[index],
        toolName: item.name ?? 'unknown_tool',
        arguments: item.arguments ?? '',
      })),
    };
    return response;
  }

  async decide(
    authenticatedUserId: string,
    requestId: string,
    decisions: unknown,
    signal?: AbortSignal,
  ) {
    const stored = this.#pending.get(requestId);
    if (!stored || stored.ownerId !== authenticatedUserId) {
      throw new Error('Approval request is unavailable.');
    }
    // Validate JSON request data, not client-supplied calls, state, or identity.
    const parsed = z.record(z.string(), z.boolean()).safeParse(decisions);
    if (
      !parsed.success ||
      Object.keys(parsed.data).length !== stored.decisionIds.length ||
      !stored.decisionIds.every((id) =>
        Object.prototype.hasOwnProperty.call(parsed.data, id),
      )
    ) {
      throw new Error(
        'Provide one boolean decision for every pending tool call.',
      );
    }
    // No await between the owner check and consume. The parsed decisions are a
    // detached copy, so client mutation while deserialization awaits has no effect.
    this.#pending.delete(requestId);
    const state = await RunState.fromString(this.#agent, stored.snapshot);
    const interruptions = state.getInterruptions();
    for (const [index, interruption] of interruptions.entries()) {
      if (parsed.data[stored.decisionIds[index]]) {
        state.approve(interruption);
      } else {
        state.reject(interruption);
      }
    }
    const result = await this.#runner.run(this.#agent, state, { signal });
    return this.#save(authenticatedUserId, result);
  }
}

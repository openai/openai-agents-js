import { Agent, AgentOutputType } from '../agent';
import { Runner, StreamRunOptions, NonStreamRunOptions } from '../run';
import { AgentInputItem } from '../types';
import { RunState } from '../runState';
import { RunResult, StreamedRunResult } from '../result';
import { AGUIAdapter, AGUIAdapterOptions } from './adapter';

export interface AGUIStreamRunOptions<TContext = undefined>
  extends StreamRunOptions<TContext> {
  agui?: AGUIAdapterOptions;
}

/**
 * Result wrapper that adds AG-UI streaming capabilities to any StreamedRunResult
 */
export class AGUIStreamedRunResult<
  TContext,
  TAgent extends Agent<TContext, AgentOutputType>,
> {
  private baseResult: StreamedRunResult<TContext, TAgent>;
  private aguiAdapter: AGUIAdapter;

  constructor(
    baseResult: StreamedRunResult<TContext, TAgent>,
    aguiOptions: AGUIAdapterOptions = {},
  ) {
    this.baseResult = baseResult;
    this.aguiAdapter = new AGUIAdapter(aguiOptions);
  }

  // Proxy all base result properties and methods
  get state() {
    return this.baseResult.state;
  }
  get input() {
    return this.baseResult.input;
  }
  get newItems() {
    return this.baseResult.newItems;
  }
  get rawResponses() {
    return this.baseResult.rawResponses;
  }
  get lastResponseId() {
    return this.baseResult.lastResponseId;
  }
  get lastAgent() {
    return this.baseResult.lastAgent;
  }
  get inputGuardrailResults() {
    return this.baseResult.inputGuardrailResults;
  }
  get outputGuardrailResults() {
    return this.baseResult.outputGuardrailResults;
  }
  get interruptions() {
    return this.baseResult.interruptions;
  }
  get finalOutput() {
    return this.baseResult.finalOutput;
  }
  get history() {
    return this.baseResult.history;
  }
  get output() {
    return this.baseResult.output;
  }
  get currentAgent() {
    return this.baseResult.currentAgent;
  }
  get currentTurn() {
    return this.baseResult.currentTurn;
  }
  get maxTurns() {
    return this.baseResult.maxTurns;
  }
  get cancelled() {
    return this.baseResult.cancelled;
  }
  get completed() {
    return this.baseResult.completed;
  }
  get error() {
    return this.baseResult.error;
  }

  toStream() {
    return this.baseResult.toStream();
  }
  toTextStream(options?: any) {
    return this.baseResult.toTextStream(options);
  }
  [Symbol.asyncIterator]() {
    return this.baseResult[Symbol.asyncIterator]();
  }

  /**
   * Returns an AG-UI compatible event stream
   */
  toAGUIStream() {
    const baseStream = this.baseResult.toStream();
    return this.aguiAdapter.transformToAGUIStream(baseStream);
  }

  /**
   * Convert the stream to AG-UI events as an async iterator
   */
  async *toAGUIAsyncIterator() {
    const stream = this.toAGUIStream();
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Convenience function to run an agent with AG-UI compatibility
 */
export async function runWithAGUI<
  TAgent extends Agent<any, any>,
  TContext = undefined,
>(
  agent: TAgent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?: AGUIStreamRunOptions<TContext>,
): Promise<AGUIStreamedRunResult<TContext, TAgent>>;
export async function runWithAGUI<
  TAgent extends Agent<any, any>,
  TContext = undefined,
>(
  agent: TAgent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?: NonStreamRunOptions<TContext>,
): Promise<RunResult<TContext, TAgent>>;
export async function runWithAGUI<
  TAgent extends Agent<any, any>,
  TContext = undefined,
>(
  agent: TAgent,
  input: string | AgentInputItem[] | RunState<TContext, TAgent>,
  options?: AGUIStreamRunOptions<TContext> | NonStreamRunOptions<TContext>,
): Promise<
  AGUIStreamedRunResult<TContext, TAgent> | RunResult<TContext, TAgent>
> {
  const runner = new Runner();

  if (options?.stream) {
    // Get the base streaming result
    const baseResult = await runner.run(agent, input, options);

    // Wrap it with AG-UI capabilities
    const aguiOptions = (options as AGUIStreamRunOptions<TContext>).agui || {};

    // Ensure we have proper AG-UI IDs
    if (!aguiOptions.thread_id) {
      aguiOptions.thread_id = `thread_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    if (!aguiOptions.run_id) {
      aguiOptions.run_id = `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    return new AGUIStreamedRunResult(baseResult, aguiOptions);
  } else {
    // For non-streaming runs, use standard result
    return runner.run(agent, input, options);
  }
}

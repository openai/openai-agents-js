import type { Engine, _ProviderHttpTransports } from '../../native/index.js';
import {
  disposePrivateKernel,
  type PrivateRuntimeSlot,
} from './private-engine-reuse';
import { NativeError } from './native-error';

type Create = (engine: Engine) => _ProviderHttpTransports;
interface State {
  phase: 'open' | 'closing' | 'closed';
  borrowers: Set<object>;
  native?: _ProviderHttpTransports;
  slot: PrivateRuntimeSlot;
  pending?: Promise<void>;
}
const owners = new WeakMap<NativeRuntime, State>();

/**
 * Explicit native resource lifetime shared by independently closed Providers.
 * HTTP clients and one quiescent private plain-run Engine may remain captured,
 * including credentials, configuration, a private home and a referenced server.
 * Close all borrowing Providers, then await close() to release those resources.
 * A new Provider does not refresh captured ambient native configuration.
 * Ordinary Sessions retain independent Engines. Busy slots use fresh resources.
 * This owner has no TTL, finalizer or implicit unref/abandonment cleanup.
 *
 * @example
 * ```ts
 * import { Agent, NativeProvider, NativeRuntime } from '@openai/agents-codex';
 *
 * const runtime = new NativeRuntime();
 * try {
 *   for (const input of ['Hello', 'Another question']) {
 *     const provider = new NativeProvider({ runtime, apiKey: 'your-api-key' });
 *     try {
 *       const agent = new Agent({ provider, model: 'gpt-5', instructions: 'Answer briefly.' });
 *       await agent.run(input);
 *     } finally {
 *       await provider.close();
 *     }
 *   }
 * } finally {
 *   await runtime.close();
 * }
 * ```
 *
 * HTTP/API-key route only; no WebSockets, ChatGPT login or modelBackend.
 * Owner close: rejected during active Provider borrows. Cleanup failures: retryable.
 * Node/Worker lifetime: referenced until explicit owner close.
 */
export class NativeRuntime {
  declare private readonly nativeRuntimeBrand: void;

  constructor() {
    owners.set(this, { phase: 'open', borrowers: new Set(), slot: {} });
  }

  close(): Promise<void> {
    const state = stateOf(this);
    if (state.phase === 'closed') return Promise.resolve();
    if (state.pending) return state.pending;
    if (state.borrowers.size)
      return Promise.reject(new Error('NativeRuntime has borrowing Providers'));
    // Claim before any await; failed phases stay closed to acquisition for retry.
    state.phase = 'closing';
    state.pending = (async () => {
      const entry = state.slot.entry;
      if (entry) {
        const diagnostic = await disposePrivateKernel(entry);
        state.slot.entry = undefined;
        if (diagnostic) throw new NativeError(diagnostic);
      }
      state.native?.close();
      state.native = undefined;
      state.phase = 'closed';
    })().finally(() => {
      state.pending = undefined;
    });
    return state.pending;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

function stateOf(owner: NativeRuntime): State {
  const state = owners.get(owner);
  if (!state) throw new TypeError('runtime must be a NativeRuntime');
  return state;
}

export function validateNativeRuntime(owner: NativeRuntime): void {
  if (stateOf(owner).phase !== 'open')
    throw new Error('NativeRuntime is closed or closing');
}

export interface NativeRuntimeBorrow {
  get(create: Create, engine: Engine): _ProviderHttpTransports;
  reserve(token: object): PrivateRuntimeSlot | undefined;
  release(): void;
}

export function borrowNativeRuntime(owner: NativeRuntime): NativeRuntimeBorrow {
  const state = stateOf(owner);
  validateNativeRuntime(owner);
  const token = {};
  state.borrowers.add(token);
  const check = () => {
    if (state.phase !== 'open' || !state.borrowers.has(token))
      throw new Error('NativeRuntime borrow is closed');
  };
  return {
    get(create, engine) {
      check();
      return (state.native ??= create(engine));
    },
    reserve(lease) {
      check();
      if (state.slot.active || state.slot.closing) return undefined;
      state.slot.active = lease;
      return state.slot;
    },
    release() {
      state.borrowers.delete(token);
    },
  };
}

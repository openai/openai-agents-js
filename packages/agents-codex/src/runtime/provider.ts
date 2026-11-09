import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeConfig } from './config';
import type { Engine, _ProviderHttpTransports } from '../../native/index.js';
import { captureChatGPTAuth, type ChatGPTAuth } from './chatgpt-auth';
import {
  disposePrivateKernel,
  type PrivateKernel,
  type PrivateRuntimeBorrow,
} from './private-engine-reuse';
import { NativeError } from './native-error';

export interface NativeProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  supportsWebsockets?: boolean;
  /** Explicit personal Apps credentials; never used for Model requests or refreshed. */
  chatGPT?: ChatGPTAuth;
}

interface PrivateRuntimeSlot {
  active?: LeaseToken;
  entry?: PrivateKernel;
  idle?: ReturnType<typeof setImmediate>;
  closing?: Promise<void>;
}

interface LeaseToken {
  failed: boolean;
  cleanup?: () => Promise<void>;
  pending?: Promise<void>;
}

function cleanFailedOpening(token: LeaseToken): Promise<void> {
  if (token.pending) return token.pending;
  const cleanup = token.cleanup!;
  token.pending = Promise.resolve()
    .then(cleanup)
    .finally(() => {
      token.pending = undefined;
    });
  return token.pending;
}

/**
 * A lazy native Responses connection. Close sessions before closing their provider.
 * Ordinary API-key HTTP clients may retain default/custom trust and ambient proxy
 * state until close. Construct a new provider to force fresh physical clients.
 */
export class NativeProvider {
  #options: Readonly<NativeProviderOptions>;
  #leases = new Set<LeaseToken>();
  #closed = false;
  #httpTransports?: _ProviderHttpTransports;
  #runtime?: PrivateRuntimeSlot;

  constructor(options: NativeProviderOptions = {}) {
    for (const key of ['baseUrl', 'apiKey'] as const) {
      if (
        options[key] !== undefined &&
        (typeof options[key] !== 'string' || !options[key])
      )
        throw new TypeError(`${key} must be a non-empty string`);
    }
    if (
      options.supportsWebsockets !== undefined &&
      typeof options.supportsWebsockets !== 'boolean'
    )
      throw new TypeError('supportsWebsockets must be a boolean');
    const captured = { ...options };
    this.#options = Object.freeze({
      ...captured,
      chatGPT: captureChatGPTAuth(captured.chatGPT),
    });
  }

  #schedulePrivateCleanup(): void {
    const slot = this.#runtime;
    if (
      !slot?.entry ||
      slot.active ||
      slot.closing ||
      slot.idle ||
      this.#leases.size !== 0 ||
      this.#closed
    )
      return;
    const entry = slot.entry;
    slot.idle = setImmediate(() => {
      slot.idle = undefined;
      if (
        this.#runtime !== slot ||
        slot.entry !== entry ||
        slot.active ||
        this.#leases.size !== 0 ||
        this.#closed
      )
        return;
      // Claim before the first await. New leases take independent fresh owners.
      const closing = Promise.resolve().then(async () => {
        const diagnostic = await disposePrivateKernel(entry);
        if (slot.entry === entry) slot.entry = undefined;
        if (diagnostic) throw new NativeError(diagnostic);
      });
      slot.closing = closing;
      // Keep a rejected cleanup latched until explicit close consumes it.
      void closing.then(
        () => {
          if (slot.closing === closing) slot.closing = undefined;
        },
        () => {},
      );
    });
  }

  get baseUrl(): string | undefined {
    return this.#options.baseUrl;
  }
  get apiKey(): string | undefined {
    return this.#options.apiKey;
  }
  get supportsWebsockets(): boolean | undefined {
    return this.#options.supportsWebsockets;
  }

  /** @internal Reserve synchronously after declaration validation, before opening resources. */
  _acquire(
    captured?: { readonly apiKey: string | undefined },
    privateRun = false,
  ): ProviderLease {
    if (this.#closed) throw new Error('NativeProvider is closed');
    const token: LeaseToken = { failed: false };
    this.#leases.add(token);
    const pendingIdle = this.#runtime;
    if (pendingIdle?.idle) {
      clearImmediate(pendingIdle.idle);
      pendingIdle.idle = undefined;
    }
    const options = this.#options;
    const websocketsAllowed =
      options.supportsWebsockets ?? options.baseUrl === undefined;
    const apiKey = captured
      ? captured.apiKey
      : (options.apiKey ?? process.env.OPENAI_API_KEY);
    const eligible =
      privateRun &&
      this.constructor === NativeProvider &&
      !options.chatGPT &&
      options.apiKey !== undefined &&
      apiKey === options.apiKey &&
      !websocketsAllowed;
    const slot = eligible ? (this.#runtime ??= {}) : undefined;
    const reserved =
      slot !== undefined &&
      slot.active === undefined &&
      slot.closing === undefined;
    if (reserved) slot.active = token;
    let home: string | undefined;
    let released = false;
    let privateDone = false;
    let privateFinishing: Promise<void> | undefined;
    const openHome = async () => {
      home = await mkdtemp(join(tmpdir(), 'agents-session-'));
      const cwd = join(home, 'workspace');
      await mkdir(cwd);
      return { codex_home: home, cwd };
    };
    const releaseLease = async () => {
      if (released) return;
      if (home) await rm(home, { recursive: true, force: true });
      released = true;
      this.#leases.delete(token);
      token.cleanup = undefined;
      privateDone = true;
      if (reserved && slot!.active === token) slot!.active = undefined;
      this.#schedulePrivateCleanup();
    };
    const release = () =>
      reserved && !privateDone && slot!.entry
        ? Promise.resolve()
        : releaseLease();
    const borrow: PrivateRuntimeBorrow | undefined = !reserved
      ? undefined
      : {
          get done() {
            return privateDone;
          },
          peek: () => (privateDone ? undefined : slot!.entry),
          bind: (engine, carrier, transports) => {
            if (
              privateDone ||
              slot!.active !== token ||
              !home ||
              apiKey === undefined
            )
              throw new Error('Private runtime reservation is closed');
            slot!.entry = {
              engine,
              carrier,
              transports,
              home: { codex_home: home, cwd: join(home, 'workspace') },
              apiKey,
              phase: 'engine',
            };
          },
          reset: async () => {
            if (privateDone || slot!.active !== token)
              throw new Error('Private runtime reservation is closed');
            const entry = slot!.entry;
            if (entry) {
              const diagnostic = await disposePrivateKernel(entry);
              slot!.entry = undefined;
              home = undefined;
              if (diagnostic) throw new NativeError(diagnostic);
            }
            return openHome();
          },
          finish: (keep) => {
            if (privateDone) return Promise.resolve();
            if (privateFinishing) return privateFinishing;
            privateFinishing = (async () => {
              if (slot!.active !== token)
                throw new Error('Private runtime reservation changed');
              const entry = slot!.entry;
              const canKeep =
                keep &&
                !token.failed &&
                !this.#closed &&
                entry !== undefined &&
                entry.phase === 'engine' &&
                entry.engine._private_reuse_ready &&
                entry.apiKey === apiKey &&
                entry.transports === this.#httpTransports &&
                entry.carrier.reuseBinding(entry.engine) !== undefined;
              let diagnostic: string | null = null;
              if (entry && !canKeep) {
                diagnostic = await disposePrivateKernel(entry);
                slot!.entry = undefined;
              }
              if (entry) home = undefined;
              await releaseLease();
              if (diagnostic) throw new NativeError(diagnostic);
            })().finally(() => {
              privateFinishing = undefined;
            });
            return privateFinishing;
          },
        };
    token.cleanup = borrow ? () => borrow.finish(false) : release;
    return {
      get failedOpeningCleanup() {
        return token.failed && token.cleanup
          ? () => cleanFailedOpening(token)
          : undefined;
      },
      websocketsAllowed,
      httpTransports: (create, engine) => {
        if (options.chatGPT) return undefined;
        if (released || this.#closed)
          throw new Error('NativeProvider lease is closed');
        // Synchronous empty allocation: no first-opening signal or pending task.
        return (this.#httpTransports ??= create(engine));
      },
      chatGPT: options.chatGPT,
      apiKey,
      privateRuntime: borrow,
      config: {
        model_provider: 'native_agent',
        'model_providers.native_agent': {
          name: 'Native agent provider',
          base_url: options.baseUrl ?? 'https://api.openai.com/v1',
          wire_api: 'responses',
          requires_openai_auth: true,
          supports_websockets: websocketsAllowed,
        },
      },
      async open() {
        if (borrow?.peek()) {
          const entry = borrow.peek()!;
          home = entry.home.codex_home;
          return entry.home;
        }
        return openHome();
      },
      release,
      retainOpeningCleanup(cleanup) {
        const previous = token.cleanup;
        token.cleanup = cleanup;
        return previous;
      },
      openingSucceeded() {
        token.cleanup = undefined;
      },
      async failOpening(error, cleanup = true) {
        token.failed = true;
        if (!cleanup) throw error;
        try {
          await cleanFailedOpening(token);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            released
              ? 'Session opening and cleanup failed'
              : 'Session opening failed; close active sessions, then call the captured provider.close() to retry cleanup',
            { cause: error },
          );
        }
        throw error;
      },
    };
  }

  async close(): Promise<void> {
    if ([...this.#leases].some((token) => !token.failed))
      throw new Error('NativeProvider has open or opening sessions');
    this.#closed = true;
    const slot = this.#runtime;
    if (slot?.idle) {
      clearImmediate(slot.idle);
      slot.idle = undefined;
    }
    if (slot?.closing) {
      const closing = slot.closing;
      try {
        await closing;
      } finally {
        // A failed close preserves entry.phase for a later explicit retry.
        if (slot.closing === closing) slot.closing = undefined;
      }
    }
    const results = await Promise.allSettled(
      [...this.#leases].map(cleanFailedOpening),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, 'NativeProvider cleanup failed', {
        cause: failures[0],
      });
    if (this.#runtime?.entry) {
      const entry = this.#runtime.entry;
      const diagnostic = await disposePrivateKernel(entry);
      this.#runtime.entry = undefined;
      if (diagnostic) throw new NativeError(diagnostic);
    }
    this.#httpTransports?.close();
    this.#httpTransports = undefined;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** @internal */
export interface ProviderLease {
  readonly privateRuntime?: PrivateRuntimeBorrow;
  readonly chatGPT?: Readonly<ChatGPTAuth>;
  readonly failedOpeningCleanup: (() => Promise<void>) | undefined;
  readonly websocketsAllowed: boolean;
  httpTransports(
    create: (engine: Engine) => _ProviderHttpTransports,
    engine: Engine,
  ): _ProviderHttpTransports | undefined;
  apiKey: string | undefined;
  config: NativeConfig;
  open(): Promise<{ codex_home: string; cwd: string }>;
  release(): Promise<void>;
  retainOpeningCleanup(
    cleanup: () => Promise<void>,
  ): (() => Promise<void>) | undefined;
  openingSucceeded(): void;
  failOpening(error: unknown, cleanup?: boolean): Promise<never>;
}

export interface ModelSettings {
  reasoningEffort?: string;
  reasoningSummary?: string;
  /** null clears an existing service tier override. */
  serviceTier?: string | null;
  /** Outer Responses tool choice. Defaults to `auto` on a new Session. */
  toolChoice?: 'auto' | 'none' | 'required';
}

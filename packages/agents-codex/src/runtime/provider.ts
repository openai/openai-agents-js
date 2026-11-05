import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeConfig } from './config';
import { captureChatGPTAuth, type ChatGPTAuth } from './chatgpt-auth';

export interface NativeProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  supportsWebsockets?: boolean;
  /** Explicit personal Apps credentials; never used for Model requests or refreshed. */
  chatGPT?: ChatGPTAuth;
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

/** A lazy native Responses connection. Close sessions before closing their provider. */
export class NativeProvider {
  #options: Readonly<NativeProviderOptions>;
  #leases = new Set<LeaseToken>();
  #closed = false;

  constructor(options: NativeProviderOptions = {}) {
    for (const key of ['baseUrl', 'apiKey'] as const) {
      if (options[key] !== undefined && !options[key])
        throw new TypeError(`${key} must be non-empty`);
    }
    const captured = { ...options };
    this.#options = Object.freeze({
      ...captured,
      chatGPT: captureChatGPTAuth(captured.chatGPT),
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
  _acquire(captured?: { readonly apiKey: string | undefined }): ProviderLease {
    if (this.#closed) throw new Error('NativeProvider is closed');
    const token: LeaseToken = { failed: false };
    this.#leases.add(token);
    const options = this.#options;
    const websocketsAllowed =
      options.supportsWebsockets ?? options.baseUrl === undefined;
    let home: string | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      if (home) await rm(home, { recursive: true, force: true });
      released = true;
      this.#leases.delete(token);
      token.cleanup = undefined;
    };
    token.cleanup = release;
    return {
      get failedOpeningCleanup() {
        return token.failed && token.cleanup
          ? () => cleanFailedOpening(token)
          : undefined;
      },
      websocketsAllowed,
      chatGPT: options.chatGPT,
      apiKey: captured
        ? captured.apiKey
        : (options.apiKey ?? process.env.OPENAI_API_KEY),
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
        home = await mkdtemp(join(tmpdir(), 'agents-session-'));
        const cwd = join(home, 'workspace');
        await mkdir(cwd);
        return { codex_home: home, cwd };
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
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** @internal */
export interface ProviderLease {
  readonly chatGPT?: Readonly<ChatGPTAuth>;
  readonly failedOpeningCleanup: (() => Promise<void>) | undefined;
  readonly websocketsAllowed: boolean;
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
}

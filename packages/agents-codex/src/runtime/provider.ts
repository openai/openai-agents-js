import { invalidTransportHeaderName } from './model-settings';
/** @internal */
export {
  captureModelSettings,
  modelOverrides,
  requestTransportWire,
} from './model-settings';
export type {
  HostedToolChoice,
  ModelSettings,
  ProviderCompactionPolicy,
} from './model-settings';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeConfig } from './config';
import type { NativeModel, ModelProvider } from './models';
import type { Engine, _ProviderHttpTransports } from '../../native/index.js';
import { captureChatGPTAuth, type ChatGPTAuth } from './chatgpt-auth';
import {
  disposePrivateKernel,
  type PrivateRuntimeBorrow,
  type PrivateRuntimeSlot,
} from './private-engine-reuse';
import { NativeError } from './native-error';
import {
  borrowNativeRuntime,
  validateNativeRuntime,
  type NativeRuntime,
  type NativeRuntimeBorrow,
} from './native-runtime';
import {
  capturePlanCredential,
  type SignInWithChatGPT,
} from './sign-in-with-chatgpt';

export interface NativeProviderOptions {
  modelBackend?: NativeModel | ModelProvider;
  /** Share native clients and eligible plain-run Engines until runtime.close(). */
  runtime?: NativeRuntime;
  /** Native phase timeouts in integer milliseconds; zero expires immediately. */
  streamIdleTimeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  websocketOptions?: Readonly<{
    pingIntervalMs?: number | null;
    pingTimeoutMs?: number | null;
  }>;
  baseUrl?: string;
  /** Base URL for Responses WebSockets when that transport is allowed. */
  websocketBaseUrl?: string;
  apiKey?: string;
  /** Use the file-backed ChatGPT login saved by the Codex CLI for Responses. */
  codexLogin?: {
    /** Defaults to CODEX_HOME or the CLI's default home. */
    readonly codexHome?: string;
    /** Require this ChatGPT account or workspace. */
    readonly accountId?: string;
  };
  /**
   * Set true to allow WebSockets on every streaming call. When omitted, eligible
   * stateless Agent.run calls use HTTP; other calls allow WebSockets only when
   * baseUrl is omitted.
   * With runtime, omitted support has been preserving HTTP; true has been enabling WebSockets.
   */
  supportsWebsockets?: boolean;
  /** Read one complete Responses JSON body over API-key HTTP. */
  responseMode?: 'streaming' | 'buffered';
  queryParams?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  /** Resolve once when this descriptor is constructed; missing/empty values stay omitted. */
  envHeaders?: Readonly<Record<string, string>>;
  organization?: string;
  project?: string;
  /** Explicit personal Apps credentials; never used for Model requests or refreshed. */
  chatGPT?: ChatGPTAuth;
  /** Use an explicitly selected ChatGPT plan for native Responses Lite inference. */
  signInWithChatGPT?: SignInWithChatGPT;
  /** Failed HTTP request retries. Native default: 4; native cap: 100; zero disables. */
  requestMaxRetries?: number;
  /** Dropped response stream reconnections. Native default: 5; native cap: 100; zero disables. */
  streamMaxRetries?: number;
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
 * Routing maps and envHeaders values are captured at construction; missing/empty
 * env values stay omitted. Routing options reject same/cross-origin redirects.
 * Native auth/protocol/private-hop headers remain reserved. A new provider
 * refreshes the captured routing values.
 * Without runtime, compatible adjacent one-shot API-key WebSocket calls have
 * been allowing this Provider to retain an Engine. Each run has been preparing
 * a fresh WebSocket connector and TLS trust configuration, including when its
 * Engine has been staying retained. Proxy routing has been continuing through
 * the existing per-dial resolver and its platform cache.
 * Ordinary API-key HTTP clients may retain default/custom trust and ambient proxy
 * state until close. Without runtime, a new Provider forces fresh
 * physical clients. With it, captured native configuration, credentials, private
 * homes and referenced carriers can outlive Providers until runtime.close().
 * With runtime, a compatible retained Engine has been allowing its WebSocket
 * connector and TLS trust configuration to stay captured across runs. A fresh
 * borrowing Provider has not been guaranteeing refreshed ambient native configuration.
 * Closing all borrowing Providers and the runtime before creating a new owner
 * has been providing the guaranteed refresh boundary.
 */
export class NativeProvider {
  #options: Readonly<NativeProviderOptions>;
  #leases = new Set<LeaseToken>();
  #closed = false;
  #httpTransports?: _ProviderHttpTransports;
  #nativeRuntimeBorrow?: NativeRuntimeBorrow;
  #routing: Readonly<{
    query_params?: Readonly<Record<string, string>>;
    http_headers?: Readonly<Record<string, string>>;
  }>;
  #runtime?: PrivateRuntimeSlot;
  #getPlanCredential?: SignInWithChatGPT['getCredential'];

  constructor(options: NativeProviderOptions = {}) {
    const rawWebsocketOptions = options.websocketOptions;
    let websocketOptions: NativeProviderOptions['websocketOptions'];
    if (rawWebsocketOptions !== undefined) {
      if (
        !rawWebsocketOptions ||
        typeof rawWebsocketOptions !== 'object' ||
        Array.isArray(rawWebsocketOptions)
      )
        throw new TypeError('websocketOptions must be an options object');
      const capturedOptions = { ...rawWebsocketOptions };
      for (const [name, value] of Object.entries(capturedOptions)) {
        if (!['pingIntervalMs', 'pingTimeoutMs'].includes(name))
          throw new TypeError('Unsupported websocketOptions field');
        if (
          value !== null &&
          value !== undefined &&
          (!Number.isSafeInteger(value) || value <= 0)
        )
          throw new TypeError(
            `${name} must be a positive safe integer or null`,
          );
      }
      websocketOptions = Object.freeze(capturedOptions);
    }
    const runtime = options.runtime;
    if (runtime !== undefined) validateNativeRuntime(runtime);
    const signIn = options.signInWithChatGPT;
    if (signIn !== undefined) {
      if (options.codexLogin !== undefined)
        throw new TypeError('Choose either codexLogin or signInWithChatGPT');
      const callback = signIn?.getCredential;
      if (typeof callback !== 'function')
        throw new TypeError('signInWithChatGPT requires getCredential');
      if (
        options.apiKey !== undefined ||
        options.chatGPT !== undefined ||
        options.modelBackend !== undefined ||
        options.baseUrl !== undefined ||
        options.websocketBaseUrl !== undefined ||
        options.queryParams !== undefined ||
        options.headers !== undefined ||
        options.envHeaders !== undefined ||
        options.organization !== undefined ||
        options.project !== undefined ||
        options.supportsWebsockets === true ||
        options.responseMode === 'buffered' ||
        (options.requestMaxRetries ?? 0) !== 0 ||
        (options.streamMaxRetries ?? 0) !== 0
      )
        throw new TypeError(
          'signInWithChatGPT requires the default streaming HTTP route without other credentials or retries',
        );
      this.#getPlanCredential = callback.bind(signIn);
    }
    if (options.modelBackend !== undefined) {
      if (
        !options.modelBackend ||
        ((!('complete' in options.modelBackend) ||
          typeof options.modelBackend.complete !== 'function') &&
          (!('getModel' in options.modelBackend) ||
            typeof options.modelBackend.getModel !== 'function'))
      )
        throw new TypeError(
          'modelBackend must implement complete(request) or getModel(modelName)',
        );
      if (options.supportsWebsockets === true || options.chatGPT !== undefined)
        throw new TypeError(
          'modelBackend requires HTTP mode without ChatGPT authentication',
        );
    }
    for (const key of [
      'requestMaxRetries',
      'streamMaxRetries',
      'streamIdleTimeoutMs',
      'websocketConnectTimeoutMs',
    ] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new TypeError(`${key} must be a nonnegative safe integer`);
    }
    for (const key of ['baseUrl', 'apiKey'] as const) {
      if (
        options[key] !== undefined &&
        (typeof options[key] !== 'string' || !options[key])
      )
        throw new TypeError(`${key} must be a non-empty string`);
    }
    if (options.websocketBaseUrl !== undefined) {
      const error =
        'websocketBaseUrl must be an absolute HTTP(S) or WS(S) URL without userinfo or fragment';
      const endpoint = options.websocketBaseUrl;
      if (typeof endpoint !== 'string') throw new TypeError(error);
      let base: URL;
      try {
        base = new URL(endpoint);
      } catch {
        throw new TypeError(error);
      }
      const authority = /^(?:https?|wss?):\/\/([^/?#]+)/i.exec(endpoint)?.[1];
      if (
        !authority ||
        authority.includes('@') ||
        !base.hostname ||
        /\s/.test(endpoint) ||
        base.href.includes('#')
      )
        throw new TypeError(error);
    }
    if (
      options.supportsWebsockets !== undefined &&
      typeof options.supportsWebsockets !== 'boolean'
    )
      throw new TypeError('supportsWebsockets must be a boolean');
    if (
      options.responseMode !== undefined &&
      !['streaming', 'buffered'].includes(options.responseMode)
    )
      throw new TypeError('responseMode must be streaming or buffered');
    if (
      options.responseMode === 'buffered' &&
      options.supportsWebsockets === true
    )
      throw new TypeError(
        'buffered Responses requires HTTP without WebSockets',
      );
    const codexLogin = captureCodexLogin(options);
    const routing = captureProviderRouting(options);
    this.#routing = routing.config;
    const captured = { ...options, ...routing.options };
    if (
      runtime !== undefined &&
      (captured.modelBackend !== undefined ||
        captured.chatGPT !== undefined ||
        captured.codexLogin !== undefined ||
        captured.signInWithChatGPT !== undefined ||
        codexLogin !== undefined ||
        this.#getPlanCredential !== undefined)
    )
      throw new TypeError(
        'runtime requires API-key inference without a model backend or ChatGPT authentication',
      );
    this.#options = Object.freeze({
      ...captured,
      websocketOptions,
      runtime,
      supportsWebsockets:
        runtime === undefined
          ? captured.supportsWebsockets
          : captured.supportsWebsockets === true,
      chatGPT: captureChatGPTAuth(captured.chatGPT),
      codexLogin,
    });
  }

  get modelBackend(): NativeModel | ModelProvider | undefined {
    return this.#options.modelBackend;
  }
  /** @internal */
  get _supportsProfileRouting(): boolean {
    return (
      this.#options.modelBackend === undefined &&
      this.#options.codexLogin === undefined &&
      this.#getPlanCredential === undefined &&
      this.#options.chatGPT === undefined
    );
  }

  get _usesChatGPTPlan(): boolean {
    return this.#getPlanCredential !== undefined;
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
  get responseMode(): 'streaming' | 'buffered' {
    return this.#options.responseMode ?? 'streaming';
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
    const options = this.#options;
    const getPlanCredential = this.#getPlanCredential;
    const nativeChatGPTInference =
      getPlanCredential !== undefined || options.codexLogin !== undefined;
    const realtimeApiKey = nativeChatGPTInference
      ? undefined
      : captured
        ? captured.apiKey
        : (options.apiKey ?? process.env.OPENAI_API_KEY);
    const apiKey =
      options.modelBackend !== undefined
        ? 'native-model-producer'
        : realtimeApiKey;
    if (options.runtime !== undefined) {
      if (!apiKey) throw new TypeError('runtime requires an effective API key');
      this.#nativeRuntimeBorrow ??= borrowNativeRuntime(options.runtime);
    }
    const token: LeaseToken = { failed: false };
    this.#leases.add(token);
    const pendingIdle = this.#runtime;
    if (pendingIdle?.idle) {
      clearImmediate(pendingIdle.idle);
      pendingIdle.idle = undefined;
    }
    const privateCandidate =
      privateRun &&
      this.constructor === NativeProvider &&
      !options.chatGPT &&
      apiKey !== undefined &&
      apiKey.length > 0 &&
      (options.modelBackend !== undefined ||
        options.apiKey === undefined ||
        apiKey === options.apiKey);
    const websocketsAllowed =
      !nativeChatGPTInference &&
      options.modelBackend === undefined &&
      options.responseMode !== 'buffered' &&
      (options.supportsWebsockets ??
        (options.baseUrl === undefined && !privateCandidate));
    let slot = privateCandidate
      ? this.#nativeRuntimeBorrow
        ? this.#nativeRuntimeBorrow.reserve(token)
        : (this.#runtime ??= {})
      : undefined;
    const reserved =
      slot !== undefined &&
      (slot.runs
        ? slot.runs.has(token)
        : slot.active === undefined || slot.active === token) &&
      slot.closing === undefined;
    if (reserved && !slot!.runs) slot!.active = token;
    const ownsReservation = () =>
      slot?.runs ? slot.runs.has(token) : slot?.active === token;
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
      if (reserved) {
        slot!.runs?.delete(token);
        if (slot!.active === token) slot!.active = undefined;
      }
      this.#schedulePrivateCleanup();
    };
    const release = () =>
      reserved && !privateDone && slot!.entry
        ? Promise.resolve()
        : releaseLease();
    const refreshWebsocketTrust =
      websocketsAllowed && this.#nativeRuntimeBorrow === undefined;
    const plainOnly =
      this.#nativeRuntimeBorrow !== undefined || refreshWebsocketTrust;
    const borrow: PrivateRuntimeBorrow | undefined = !reserved
      ? undefined
      : {
          plainOnly,
          refreshWebsocketTrust,
          concurrent: slot!.runs !== undefined,
          invalidate: () => {
            if (!privateDone && ownsReservation() && slot!.runs && slot!.entry)
              slot!.retiring = true;
          },
          get done() {
            return privateDone;
          },
          peek: () => (privateDone ? undefined : slot!.entry),
          bind: (engine, carrier, transports) => {
            if (
              privateDone ||
              !ownsReservation() ||
              slot!.entry !== undefined ||
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
            if (privateDone || !ownsReservation())
              throw new Error('Private runtime reservation is closed');
            const entry = slot!.entry;
            if (slot!.runs) {
              // A mismatch leaves the immutable shared entry and its siblings alone.
              if (entry && slot!.retiring && slot!.runs.size === 1) {
                const diagnostic = await disposePrivateKernel(entry);
                slot!.entry = undefined;
                slot!.retiring = false;
                if (diagnostic) throw new NativeError(diagnostic);
              }
              slot!.runs.delete(token);
              slot = { active: token };
              home = undefined;
            } else if (entry) {
              const diagnostic = await disposePrivateKernel(entry);
              slot!.entry = undefined;
              home = undefined;
              if (diagnostic) throw new NativeError(diagnostic);
            }
            return openHome();
          },
          finish: (keep, plain = false) => {
            if (privateDone) return Promise.resolve();
            if (privateFinishing) return privateFinishing;
            privateFinishing = (async () => {
              if (!ownsReservation())
                throw new Error('Private runtime reservation changed');
              const entry = slot!.entry;
              const canKeep =
                keep &&
                !slot!.retiring &&
                (!plainOnly || plain) &&
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
                if (slot!.runs) slot!.retiring = true;
                if (!slot!.runs || slot!.runs.size === 1) {
                  diagnostic = await disposePrivateKernel(entry);
                  slot!.entry = undefined;
                  slot!.retiring = false;
                }
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
        if (options.chatGPT || nativeChatGPTInference) return undefined;
        if (released || this.#closed)
          throw new Error('NativeProvider lease is closed');
        // Synchronous empty allocation: no first-opening signal or pending task.
        return (this.#httpTransports ??= this.#nativeRuntimeBorrow
          ? this.#nativeRuntimeBorrow.get(create, engine)
          : create(engine));
      },
      chatGPT: options.chatGPT,
      capturePlan: getPlanCredential
        ? (signal) => capturePlanCredential(getPlanCredential, signal)
        : undefined,
      codexLogin: options.codexLogin,
      apiKey,
      realtimeApiKey,
      privateRuntime: borrow,
      config: {
        model_provider: 'native_agent',
        'model_providers.native_agent': {
          name: 'Native agent provider',
          base_url: options.codexLogin
            ? 'https://chatgpt.com/backend-api/codex'
            : (options.baseUrl ?? 'https://api.openai.com/v1'),
          wire_api: 'responses',
          requires_openai_auth: !getPlanCredential,
          supports_websockets: websocketsAllowed,
          ...this.#routing,
          ...Object.fromEntries(
            Object.entries({
              websocket_base_url: options.websocketBaseUrl,
              request_max_retries: getPlanCredential
                ? 0
                : options.requestMaxRetries,
              stream_max_retries: getPlanCredential
                ? 0
                : options.streamMaxRetries,
              stream_idle_timeout_ms: options.streamIdleTimeoutMs,
              websocket_connect_timeout_ms: options.websocketConnectTimeoutMs,
              websocket_options:
                options.websocketOptions === undefined
                  ? undefined
                  : {
                      ...(options.websocketOptions.pingIntervalMs == null
                        ? {}
                        : {
                            ping_interval_ms:
                              options.websocketOptions.pingIntervalMs,
                          }),
                      ...(options.websocketOptions.pingTimeoutMs == null
                        ? {}
                        : {
                            ping_timeout_ms:
                              options.websocketOptions.pingTimeoutMs,
                          }),
                    },
            }).filter(([, value]) => value !== undefined),
          ),
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
    if (this.#nativeRuntimeBorrow) {
      // Own Engines/carriers have joined above; the shared owner retains clients.
      this.#nativeRuntimeBorrow.release();
      this.#nativeRuntimeBorrow = undefined;
    } else {
      this.#httpTransports?.close();
    }
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
  readonly capturePlan?: (
    signal: AbortSignal,
  ) => ReturnType<typeof capturePlanCredential>;
  readonly codexLogin?: NativeProviderOptions['codexLogin'];
  readonly failedOpeningCleanup: (() => Promise<void>) | undefined;
  readonly websocketsAllowed: boolean;
  httpTransports(
    create: (engine: Engine) => _ProviderHttpTransports,
    engine: Engine,
  ): _ProviderHttpTransports | undefined;
  apiKey: string | undefined;
  readonly realtimeApiKey?: string;
  config: NativeConfig;
  open(): Promise<{ codex_home: string; cwd: string }>;
  release(): Promise<void>;
  retainOpeningCleanup(
    cleanup: () => Promise<void>,
  ): (() => Promise<void>) | undefined;
  openingSucceeded(): void;
  failOpening(error: unknown, cleanup?: boolean): Promise<never>;
}

function captureCodexLogin(options: NativeProviderOptions) {
  const login = options.codexLogin;
  if (login === undefined) return undefined;
  if (
    login === null ||
    typeof login !== 'object' ||
    Array.isArray(login) ||
    Object.keys(login).some((key) => key !== 'codexHome' && key !== 'accountId')
  ) {
    throw new TypeError('codexLogin must contain only codexHome and accountId');
  }
  for (const key of ['codexHome', 'accountId'] as const) {
    const value = login[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    ) {
      throw new TypeError(`codexLogin.${key} must be a non-empty string`);
    }
  }
  if (
    options.apiKey !== undefined ||
    options.modelBackend !== undefined ||
    options.baseUrl !== undefined ||
    options.websocketBaseUrl !== undefined ||
    options.supportsWebsockets === true ||
    options.responseMode === 'buffered' ||
    options.headers !== undefined ||
    options.envHeaders !== undefined ||
    options.queryParams !== undefined ||
    options.organization !== undefined ||
    options.project !== undefined
  ) {
    throw new TypeError(
      'codexLogin requires native streaming HTTP with default ChatGPT routing',
    );
  }
  const { codexHome, accountId } = login;
  return Object.freeze({
    ...(codexHome === undefined ? {} : { codexHome: resolve(codexHome) }),
    ...(accountId === undefined ? {} : { accountId }),
  });
}

/** Capture routing values, never environment names, into the native descriptor. */
function captureProviderRouting(options: NativeProviderOptions) {
  const configured = [
    'queryParams',
    'headers',
    'envHeaders',
    'organization',
    'project',
  ].some((name) => options[name as keyof NativeProviderOptions] !== undefined);
  if (configured) {
    let base: URL;
    try {
      base = new URL(options.baseUrl ?? 'https://api.openai.com/v1');
    } catch {
      throw new TypeError(
        'Custom provider routing requires an absolute HTTP(S) base URL',
      );
    }
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      !base.hostname ||
      base.username ||
      base.password ||
      base.hash
    )
      throw new TypeError(
        'Custom provider routing requires an HTTP(S) URL without userinfo or fragment',
      );
  }
  const copied: Partial<NativeProviderOptions> = {};
  for (const name of ['queryParams', 'headers', 'envHeaders'] as const) {
    const value = options[name];
    if (value !== undefined) {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([key, item]) => !key || typeof item !== 'string',
        )
      )
        throw new TypeError(`${name} must be a string map with nonempty keys`);
      copied[name] = Object.freeze(Object.fromEntries(Object.entries(value)));
    }
  }
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of ['headers', 'envHeaders'] as const) {
    for (const [key, original] of Object.entries(copied[name] ?? {})) {
      const lower = key.toLowerCase();
      if (invalidTransportHeaderName(key))
        throw new TypeError(
          'Provider header name is invalid or belongs to native transport/auth',
        );
      if (seen.has(lower))
        throw new TypeError(
          'Provider header names must be unique ignoring case',
        );
      seen.add(lower);
      let value = original;
      if (name === 'envHeaders') {
        if (!value || value.includes('=') || value.includes('\u0000'))
          throw new TypeError(
            'envHeaders values must name environment variables',
          );
        const selected = process.env[value];
        if (selected === undefined || !selected.trim()) continue;
        value = selected;
      }
      if (/[^\x20-\x7e]/.test(value))
        throw new TypeError(
          'Provider header values must contain printable ASCII',
        );
      Object.defineProperty(headers, lower, { value, enumerable: true });
    }
  }
  for (const [name, header] of [
    ['organization', 'openai-organization'],
    ['project', 'openai-project'],
  ] as const) {
    const value = options[name];
    if (value !== undefined) {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        /[^\x20-\x7e]/.test(value)
      )
        throw new TypeError(
          `${name} must be a nonempty printable ASCII string`,
        );
      Object.defineProperty(headers, header, { value, enumerable: true });
    }
  }
  const config: {
    query_params?: Readonly<Record<string, string>>;
    http_headers?: Readonly<Record<string, string>>;
  } = {};
  if (options.queryParams !== undefined)
    config.query_params = copied.queryParams;
  if (
    ['headers', 'envHeaders', 'organization', 'project'].some(
      (name) => options[name as keyof NativeProviderOptions] !== undefined,
    )
  )
    config.http_headers = Object.freeze(headers);
  return { options: copied, config: Object.freeze(config) };
}

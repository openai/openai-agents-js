/** Private connection data supplied to an application-owned transport or model. */
export interface NativeRealtimeAdapterContext {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly model?: string;
  readonly signal: AbortSignal;
}

/** Canonical Realtime V2 frames, with independent incoming and outgoing I/O. */
export interface NativeRealtimeConnection {
  readonly incoming: AsyncIterable<string>;
  send(frame: string): Promise<void>;
  /**
   * Release the connection and wake pending sends and incoming iteration.
   * A failed close may be retried and must be idempotent.
   */
  close(): Promise<void>;
}

/**
 * Supply a custom socket or translate a model's protocol to Realtime V2 frames.
 * Core retains history, tool authorization, configuration ACKs and ordering.
 */
export interface NativeRealtimeAdapter {
  /** Clean up partial resources before rejecting; honor signal during setup. */
  connect(
    context: NativeRealtimeAdapterContext,
  ): Promise<NativeRealtimeConnection>;
}

/** @internal A one-use native capability, created by its owning NativeThread. */
export interface NativeRealtimeAdapterHandle {
  next(): Promise<NativeRealtimeAdapterRequest | null>;
  receive(frame: string): Promise<void>;
  end(success: boolean): void;
  finish(): void;
}
interface NativeRealtimeAdapterRequest {
  readonly event_json: string;
  complete(success: boolean): boolean;
}

/** @internal Request attachment and its factory share the same native Thread. */
export interface NativeRealtimeAdapterBridge {
  create(generation: string): NativeRealtimeAdapterHandle;
  prepare(
    params: import('./binding').JsonObject,
    handle: NativeRealtimeAdapterHandle,
  ): Promise<unknown>;
}

/** @internal Owns application I/O; native code owns all protocol interpretation. */
export class NativeRealtimeAdapterDriver {
  private readonly cancellation = new AbortController();
  private readonly factory: NativeRealtimeAdapter['connect'];
  private readonly sends = new Set<Promise<void>>();
  private setup?: Promise<void>;
  private reading?: Promise<void>;
  private connection?: {
    send?: NativeRealtimeConnection['send'];
    close: NativeRealtimeConnection['close'];
    incoming?: AsyncIterator<string>;
  };
  private cleaning?: Promise<void>;
  private cleaned = false;
  private finished = false;
  private readonly running: Promise<void>;
  private operationError?: { error: unknown };
  private closeError?: { error: unknown };

  constructor(
    adapter: NativeRealtimeAdapter,
    readonly handle: NativeRealtimeAdapterHandle,
    private readonly invoke: <T>(callback: () => T | Promise<T>) => Promise<T>,
  ) {
    this.factory = adapter.connect.bind(adapter);
    this.running = this.run();
    // Native errors can arrive before the owner joins this driver.
    void this.running.catch(() => {});
  }

  get failure(): { error: unknown } | undefined {
    return this.operationError;
  }

  get cleanupFailure(): { error: unknown } | undefined {
    return this.closeError;
  }

  private remember(error: unknown) {
    this.operationError ??= { error };
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        const request = await this.handle.next();
        if (!request) break;
        try {
          const event = JSON.parse(request.event_json);
          switch (event.type) {
            case 'connect':
              if (this.setup)
                throw new Error('Realtime adapter was connected twice');
              this.setup = this.connect(request, event);
              break;
            case 'send': {
              if (typeof event.frame !== 'string')
                throw new TypeError('Invalid adapter frame');
              const sending = this.send(request, event.frame);
              this.sends.add(sending);
              void sending.finally(() => this.sends.delete(sending));
              break;
            }
            case 'close':
              void this.cleanup().then(
                () => {
                  request.complete(true);
                },
                () => {
                  request.complete(false);
                },
              );
              break;
            case 'cancel':
              this.cancellation.abort(
                new Error('Native Realtime adapter cancelled'),
              );
              request.complete(true);
              break;
            default:
              throw new TypeError('Unknown native adapter request');
          }
        } catch (error) {
          this.remember(error);
          request.complete(false);
          this.handle.end(false);
        }
      }
    } catch (error) {
      this.remember(error);
    } finally {
      await this.cleanup();
    }
  }

  private async connect(
    request: NativeRealtimeAdapterRequest,
    event: {
      url: string;
      headers: Record<string, string>;
      model?: string | null;
    },
  ): Promise<void> {
    try {
      this.cancellation.signal.throwIfAborted();
      const connection = await this.invoke(() =>
        this.factory(
          Object.freeze({
            url: event.url,
            headers: Object.freeze({ ...event.headers }),
            model: event.model ?? undefined,
            signal: this.cancellation.signal,
          }),
        ),
      );
      if (!connection || typeof connection.close !== 'function')
        throw new TypeError('Realtime adapter must return an owned connection');
      // Retain cleanup before inspecting the rest of an application object.
      this.connection = { close: connection.close.bind(connection) };
      if (
        typeof connection.send !== 'function' ||
        !connection.incoming?.[Symbol.asyncIterator]
      )
        throw new TypeError(
          'Realtime adapter requires send and async incoming frames',
        );
      this.connection.send = connection.send.bind(connection);
      this.connection.incoming = await this.invoke(() =>
        connection.incoming[Symbol.asyncIterator](),
      );
      if (this.cancellation.signal.aborted) {
        request.complete(false);
        return;
      }
      if (request.complete(true)) this.reading = this.read();
    } catch (error) {
      if (!this.cancellation.signal.aborted) this.remember(error);
      request.complete(false);
    }
  }

  private async read(): Promise<void> {
    try {
      const iterator = this.connection!.incoming!;
      while (!this.cancellation.signal.aborted) {
        const next = await this.invoke(() => iterator.next());
        if (next.done) {
          this.handle.end(true);
          return;
        }
        if (typeof next.value !== 'string')
          throw new TypeError(
            'Realtime adapter incoming frames must be strings',
          );
        if (Buffer.byteLength(next.value, 'utf8') > 8 * 1024 * 1024)
          throw new RangeError(
            'Realtime adapter frame exceeds the native limit',
          );
        if (!this.cancellation.signal.aborted)
          await this.handle.receive(next.value);
      }
    } catch (error) {
      if (!this.cancellation.signal.aborted) {
        this.remember(error);
        this.handle.end(false);
      }
    }
  }

  private async send(
    request: NativeRealtimeAdapterRequest,
    frame: string,
  ): Promise<void> {
    try {
      this.cancellation.signal.throwIfAborted();
      if (!this.connection?.send)
        throw new Error('Realtime adapter is not connected');
      const send = this.connection.send;
      await this.invoke(() => send(frame));
      request.complete(!this.cancellation.signal.aborted);
    } catch (error) {
      if (!this.cancellation.signal.aborted) this.remember(error);
      request.complete(false);
    }
  }

  private cleanup(): Promise<void> {
    if (this.cleaned) return Promise.resolve();
    if (this.cleaning) return this.cleaning;
    this.cancellation.abort(new Error('Native Realtime adapter closed'));
    const cleaning = (async () => {
      await this.setup;
      // Closing I/O must wake a pending send/receive before those tasks are joined.
      const connection = this.connection;
      if (connection) await this.invoke(() => connection.close());
      await Promise.all([...this.sends, this.reading]);
      if (connection?.incoming?.return)
        await this.invoke(() => connection.incoming!.return!());
      this.connection = undefined;
      this.cleaned = true;
      this.closeError = undefined;
    })();
    this.cleaning = cleaning;
    void cleaning.catch((error) => {
      this.closeError = { error };
      if (this.cleaning === cleaning) this.cleaning = undefined;
    });
    return cleaning;
  }

  /** Call only after native cleanup succeeds; a rejected join can be retried. */
  async finish(): Promise<void> {
    if (this.finished) return this.cleanup();
    this.finished = true;
    this.handle.finish();
    await this.running;
  }
}

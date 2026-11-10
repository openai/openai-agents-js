import {
  addRealtimeUsage,
  reportedRealtimeUsage,
  type NativeRealtimeUsage,
} from '../runtime/realtime-usage';
export type { NativeRealtimeUsage } from '../runtime/realtime-usage';

const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_SEND_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_SENDS = 256;

/** Host effects for the target-neutral Rust Realtime control crate. */
export interface PortableVoiceTransport {
  send(frame: string): void | Promise<void>;
  close(): void | Promise<void>;
}

/** Provider-format text and image parts in a user message. */
export type PortableVoiceMessageContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; [key: string]: unknown };

export interface PortableVoiceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  needsApproval?: boolean;
  execute(
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): string | Promise<string>;
}

export interface PortableVoiceOptions {
  model: string;
  instructions: string;
  tools?: PortableVoiceTool[];
  /** Provider-format session settings; model, instructions and tools belong to the named options. */
  sessionSettings?: Readonly<Record<string, unknown>>;
  onApproval?: (
    request: {
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    },
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  onEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
}

type Effect =
  | { type: 'send'; id: number; event: unknown }
  | {
      type: 'approve' | 'execute';
      call_id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: 'event'; event: unknown }
  | { type: 'ready' | 'closed' };

type ControlExports = {
  memory: WebAssembly.Memory;
  input_buffer(length: number): number;
  apply(): void;
  output_pointer(): number;
  output_length(): number;
};

/** One Wasm instance owns one generation. Use the reviewed native control module. */
export class NativeVoiceControl {
  readonly #exports: ControlExports;
  readonly #encode = new TextEncoder();
  readonly #decode = new TextDecoder('utf-8', { fatal: true });

  constructor(module: WebAssembly.Module) {
    if (WebAssembly.Module.imports(module).length)
      throw new Error(
        'Native voice control must not import host capabilities.',
      );
    this.#exports = new WebAssembly.Instance(module).exports as ControlExports;
    if (
      !(this.#exports.memory instanceof WebAssembly.Memory) ||
      ['input_buffer', 'apply', 'output_pointer', 'output_length'].some(
        (name) =>
          typeof this.#exports[name as keyof ControlExports] !== 'function',
      )
    )
      throw new Error('Invalid native voice control module.');
  }

  apply(command: unknown): Effect[] {
    const input = this.#encode.encode(JSON.stringify(command));
    const pointer = this.#exports.input_buffer(input.length);
    if (!pointer) throw new Error('Native voice command exceeds capacity.');
    new Uint8Array(this.#exports.memory.buffer, pointer, input.length).set(
      input,
    );
    this.#exports.apply();
    const output = JSON.parse(
      this.#decode.decode(
        new Uint8Array(
          this.#exports.memory.buffer,
          this.#exports.output_pointer(),
          this.#exports.output_length(),
        ),
      ),
    ) as { effects?: Effect[]; error?: string };
    if (output.error) throw new Error(output.error);
    if (!Array.isArray(output.effects))
      throw new Error('Invalid native voice control response.');
    return output.effects;
  }
}

/** Portable effect driver. Rust owns admission, approval receipts and continuation. */
export class PortableVoiceSession {
  readonly #abort = new AbortController();
  readonly #tools = new Map<string, PortableVoiceTool>();
  readonly #tasks = new Set<Promise<void>>();
  #send: Promise<void> = Promise.resolve();
  #queuedSends = 0;
  #queuedSendBytes = 0;
  #closed = false;
  #started = false;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  #closing: Promise<void> | undefined;
  #readyResolve!: () => void;
  #readyReject!: (error: unknown) => void;
  #usageTotals?: ReturnType<typeof reportedRealtimeUsage>;
  readonly #ready = new Promise<void>((resolve, reject) => {
    this.#readyResolve = resolve;
    this.#readyReject = reject;
  });

  constructor(
    private readonly control: NativeVoiceControl,
    private readonly transport: PortableVoiceTransport,
    private readonly options: PortableVoiceOptions,
  ) {
    for (const tool of options.tools ?? []) {
      if (this.#tools.has(tool.name))
        throw new Error('Duplicate portable voice tool.');
      this.#tools.set(tool.name, tool);
    }
    // A transport can fail before start returns its readiness promise.
    void this.#ready.catch(() => {});
  }

  /** Observed speech-model usage; omitted counters remain unknown. */
  get usage(): NativeRealtimeUsage | undefined {
    return this.#usageTotals === undefined
      ? undefined
      : (structuredClone(this.#usageTotals) as NativeRealtimeUsage);
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('Portable voice session is closed.');
    if (this.#started)
      throw new Error('Portable voice session already started.');
    this.#started = true;
    this.#readyTimer = setTimeout(
      () =>
        this.fail(
          new Error('Portable voice configuration acceptance timed out.'),
        ),
      10_000,
    );
    try {
      this.#dispatch({
        type: 'start',
        config: {
          model: this.options.model,
          instructions: this.options.instructions,
          session_settings: this.options.sessionSettings ?? {},
          tools: [...this.#tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            needs_approval: tool.needsApproval ?? false,
          })),
        },
      });
    } catch (error) {
      this.fail(error);
    }
    return this.#ready;
  }

  receive(event: unknown): void {
    if (this.#closed) return;
    try {
      this.#dispatch({ type: 'provider', event });
    } catch (error) {
      this.fail(error);
    }
  }

  sendText(text: string): void {
    this.#sendInput({ type: 'text', text });
  }

  sendMessage(
    content: readonly PortableVoiceMessageContent[],
    { triggerResponse = true }: { triggerResponse?: boolean } = {},
  ): void {
    this.#sendInput({
      type: 'message',
      content,
      trigger_response: triggerResponse,
    });
  }

  /** Append bytes in the format selected by the accepted session configuration. */
  sendAudio(
    audio: ArrayBuffer,
    { commit = false }: { commit?: boolean } = {},
  ): void {
    if (!(audio instanceof ArrayBuffer))
      throw new TypeError('Portable voice audio must be an ArrayBuffer.');
    if (typeof commit !== 'boolean')
      throw new TypeError('Portable voice audio commit must be a boolean.');
    // Check both native JSON bytes and the existing host UTF-16 queue budget
    // before encoding or reserving any native send receipts.
    const encodedLength = Math.ceil(audio.byteLength / 3) * 4;
    const commandLength =
      JSON.stringify({ type: 'audio', audio: '', commit }).length +
      encodedLength;
    const appendLength =
      JSON.stringify({ type: 'input_audio_buffer.append', audio: '' }).length +
      encodedLength;
    const commitLength = commit
      ? JSON.stringify({ type: 'input_audio_buffer.commit' }).length
      : 0;
    if (
      commandLength > MAX_COMMAND_BYTES ||
      this.#queuedSends + (commit ? 2 : 1) > MAX_QUEUED_SENDS ||
      this.#queuedSendBytes + (appendLength + commitLength) * 2 >
        MAX_QUEUED_SEND_BYTES
    )
      throw new RangeError('Audio input exceeds capacity.');
    const bytes = new Uint8Array(audio);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 8192)
      chunks.push(
        String.fromCharCode(...bytes.subarray(offset, offset + 8192)),
      );
    this.#sendInput({ type: 'audio', audio: btoa(chunks.join('')), commit });
  }

  commitAudio(): void {
    this.#sendInput({ type: 'commit_audio' });
  }

  clearAudio(): void {
    this.#sendInput({ type: 'clear_audio' });
  }

  requestResponse(): void {
    this.#sendInput({ type: 'respond' });
  }

  /** Stop the current response. Previously admitted tool work may still finish. */
  interrupt(): void {
    this.#sendInput({ type: 'interrupt' });
  }

  #sendInput(command: unknown): void {
    try {
      this.#dispatch(command);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    const failure =
      error instanceof Error ? error : new Error('Voice host failed.');
    this.#readyReject(failure);
    void this.close().catch(() => {});
    try {
      this.options.onError?.(failure);
    } catch {
      // Error observers cannot interrupt retirement of the native owner.
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
    this.#abort.abort(new Error('Portable voice session closed.'));
    this.#readyReject(this.#abort.signal.reason);
    try {
      this.control.apply({ type: 'close' });
    } catch {
      // The Rust owner may already have retired after a protocol failure.
    }
    this.#closing = (async () => {
      try {
        await this.transport.close();
      } finally {
        await Promise.allSettled([...this.#tasks]);
      }
    })();
    return this.#closing;
  }

  #dispatch(command: unknown): void {
    if (this.#closed) throw new Error('Portable voice session is closed.');
    for (const effect of this.control.apply(command)) {
      if (this.#closed) break;
      switch (effect.type) {
        case 'ready':
          clearTimeout(this.#readyTimer);
          this.#readyTimer = undefined;
          this.#readyResolve();
          break;
        case 'event': {
          const event = effect.event as {
            type?: string;
            response?: { usage?: unknown };
          };
          if (event.type === 'response.done' && event.response?.usage != null)
            this.#usageTotals = addRealtimeUsage(
              this.#usageTotals ?? {},
              reportedRealtimeUsage(event.response.usage),
            );
          this.options.onEvent?.(effect.event);
          break;
        }
        case 'send': {
          const frame = JSON.stringify(effect.event);
          const bytes = frame.length * 2;
          if (
            this.#queuedSends >= MAX_QUEUED_SENDS ||
            this.#queuedSendBytes + bytes > MAX_QUEUED_SEND_BYTES
          )
            throw new Error('Portable voice egress exceeds capacity.');
          this.#queuedSends++;
          this.#queuedSendBytes += bytes;
          const sending = this.#send
            .then(async () => {
              if (this.#closed) return;
              await this.transport.send(frame);
              if (!this.#closed)
                this.#dispatch({ type: 'sent', id: effect.id });
            })
            .finally(() => {
              this.#queuedSends--;
              this.#queuedSendBytes -= bytes;
            });
          this.#send = sending.catch(() => {});
          this.#track(sending);
          break;
        }
        case 'approve':
          this.#track(
            Promise.resolve().then(async () => {
              if (this.#closed) return;
              const approved = await this.options.onApproval?.(
                {
                  callId: effect.call_id,
                  name: effect.name,
                  arguments: effect.arguments,
                },
                this.#abort.signal,
              );
              if (!this.#closed)
                this.#dispatch({
                  type: 'approve',
                  call_id: effect.call_id,
                  approved: approved === true,
                });
            }),
          );
          break;
        case 'execute':
          this.#track(
            Promise.resolve().then(async () => {
              if (this.#closed) return;
              const tool = this.#tools.get(effect.name);
              if (!tool)
                throw new Error('Native control selected an unknown tool.');
              const output = await tool.execute(
                effect.arguments,
                this.#abort.signal,
              );
              if (typeof output !== 'string')
                throw new TypeError('Portable voice tools must return text.');
              if (!this.#closed)
                this.#dispatch({
                  type: 'tool_result',
                  call_id: effect.call_id,
                  output,
                });
            }),
          );
          break;
        case 'closed':
          break;
      }
    }
  }

  #track(task: Promise<void>): void {
    this.#tasks.add(task);
    void task
      .catch((error) => this.fail(error))
      .finally(() => this.#tasks.delete(task));
  }
}

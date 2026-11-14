/** @internal Import-free controller exports from the lowered Rust text build. */
export interface LoweredTurnExports {
  memory: { readonly buffer: ArrayBufferLike };
  input_buffer(length: number): number;
  apply(): void;
  output_pointer(): number;
  output_length(): number;
}

/** Instantiate a separate Rust controller for every turn. */
export class HermesTextControl {
  readonly #instantiate: () => LoweredTurnExports;

  /** @internal The packaged factory supplies the lowered controller. */
  constructor(instantiate: () => LoweredTurnExports) {
    this.#instantiate = instantiate;
  }

  /** @internal */
  instantiate(): LoweredTurnExports {
    return this.#instantiate();
  }
}

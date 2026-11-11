export {
  backgroundResult,
  type BackgroundResult,
} from '../runtime/background-result';
export type { PortableVoiceApiKey } from './portable-credentials';
import { PortableVoiceControlBinding } from './portable-binding';
import type { PortableVoiceControlExports } from './portable-binding';
export * from './portable-binding';
export * from './portable-session';
export * from './portable-socket';

/** One Wasm instance owns one generation. Use the reviewed native control module. */
export class NativeVoiceControl extends PortableVoiceControlBinding {
  constructor(module: WebAssembly.Module) {
    if (WebAssembly.Module.imports(module).length)
      throw new Error(
        'Native voice control must not import host capabilities.',
      );
    const exports = new WebAssembly.Instance(module)
      .exports as unknown as PortableVoiceControlExports;
    if (!(exports.memory instanceof WebAssembly.Memory))
      throw new Error('Invalid native voice control module.');
    super(exports);
  }
}

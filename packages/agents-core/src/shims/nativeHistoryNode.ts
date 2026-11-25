import bindings from '#agents-native-history';
import { createInputHistoryAccelerator } from '../runner/nativeInputHistory';
import type { InputHistoryAccelerator } from '../runner/nativeInputHistory';

function initialize(): InputHistoryAccelerator | undefined {
  if (!bindings) return undefined;
  try {
    return createInputHistoryAccelerator(bindings);
  } catch {
    // Any witness/template initialization failure keeps the portable baseline active.
    return undefined;
  }
}

export const inputHistoryAccelerator = initialize();

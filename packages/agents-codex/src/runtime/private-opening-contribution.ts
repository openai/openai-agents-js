import type { BeforeComplete } from './model-callbacks';
import type { Tool } from './tools';

/** @internal Already configured optional values, before canonical admission. */
export interface PrivateOpeningContribution<Context> {
  readonly tools?: readonly Tool<Context>[];
  readonly beforeComplete?: BeforeComplete<Context>;
}

/** @internal A qualified private build binds one implementation here. */
export function privateOpeningContribution<Context>():
  PrivateOpeningContribution<Context> | undefined {
  return undefined;
}

/** @internal Only the two SDK-issued memory phase calls carry this marker. */
export const sdkMemoryPhase = Symbol('sdkMemoryPhase');

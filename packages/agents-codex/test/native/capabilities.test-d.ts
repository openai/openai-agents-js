import { expectTypeOf } from 'vitest';
import {
  CapabilityError,
  NativeError,
  type Capabilities,
  type CheckpointStatus,
  type FeatureName,
  type FeatureSupport,
  type Session,
} from '../../src';

// Compile-only public API contracts.
declare const session: Session<string, { actor: string }>;
const retained: Capabilities = session.capabilities;
expectTypeOf(retained.get('nativeOutput')).toEqualTypeOf<FeatureSupport>();
expectTypeOf(
  retained.require('promptedOutput', { allowLimited: true }),
).toEqualTypeOf<void>();
expectTypeOf(session.checkpointStatus({ kind: 'manualWait' })).toEqualTypeOf<
  Promise<CheckpointStatus>
>();
expectTypeOf<FeatureName>().toEqualTypeOf<
  | 'nativeOutput'
  | 'promptedOutput'
  | 'manualSuspend'
  | 'nativeOutputManualRestore'
  | 'toolSelection'
  | 'functionPolicy'
  | 'mcpBeforePolicy'
  | 'mcpResultPolicy'
  | 'environmentBeforePolicy'
  | 'environmentCodeResultPolicy'
  | 'nativeAgents'
  | 'remoteSkills'
  | 'checklist'
>();
const report = retained.get('functionPolicy');
const error: NativeError = new CapabilityError('functionPolicy', report);
// @ts-expect-error Reports are immutable.
report.status = 'supported';
// @ts-expect-error Captured provider policy is read-only.
retained.websocketsAllowed = true;
// @ts-expect-error The retained view cannot be replaced.
session.capabilities = retained;
// @ts-expect-error Feature names form a closed union.
retained.get('native_output');
// @ts-expect-error The checkpoint kind is explicit.
session.checkpointStatus({});
// @ts-expect-error Python names are not aliases.
session.checkpointStatus({ kind: 'manual_wait' });
export async function readonlyAdvice() {
  const advice = await session.checkpointStatus({ kind: 'idle' });
  // @ts-expect-error Reasons cannot be mutated.
  advice.reasons.push('changed');
  // @ts-expect-error Advice is immutable.
  advice.status = 'ready';
  return error;
}

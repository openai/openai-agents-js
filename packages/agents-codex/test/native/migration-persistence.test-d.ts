import { expectTypeOf } from 'vitest';
import type {
  LocalStorage,
  SessionState,
  SessionStore,
  ReconciledCall,
} from '../../src';
import type { MigrationRunOptions } from '../../src/migration';

declare const state: SessionState;
declare const local: LocalStorage;
declare const custom: SessionStore;
declare const receipts: readonly ReconciledCall[];

const portable: MigrationRunOptions<undefined> = {
  context: undefined,
  state,
  returnState: true,
};
const fresh: MigrationRunOptions<undefined> = {
  context: undefined,
  storage: local,
};
const resumed: MigrationRunOptions<undefined> = {
  context: undefined,
  storage: custom,
  resume: 'id',
  returnState: false,
};
const reconciled: MigrationRunOptions<undefined> = {
  context: undefined,
  storage: local,
  resume: 'id',
  reconciledCalls: receipts,
};
expectTypeOf(portable).toExtend<MigrationRunOptions<undefined>>();
expectTypeOf(fresh).toExtend<MigrationRunOptions<undefined>>();
expectTypeOf(resumed).toExtend<MigrationRunOptions<undefined>>();
expectTypeOf(reconciled).toExtend<MigrationRunOptions<undefined>>();

// @ts-expect-error A portable checkpoint cannot use persistent storage.
const conflicting: MigrationRunOptions<undefined> = {
  context: undefined,
  state,
  storage: local,
};
// @ts-expect-error A persistent invocation cannot return portable state.
const returning: MigrationRunOptions<undefined> = {
  context: undefined,
  storage: custom,
  returnState: true,
};
// @ts-expect-error Resume requires a persistence owner.
const orphan: MigrationRunOptions<undefined> = {
  context: undefined,
  resume: 'id',
};
// @ts-expect-error Local reconciliation requires a resume identity.
const missingResume: MigrationRunOptions<undefined> = {
  context: undefined,
  storage: local,
  reconciledCalls: receipts,
};
// @ts-expect-error Custom-store reconciliation has its own explicit API.
const customReceipts: MigrationRunOptions<undefined> = {
  context: undefined,
  storage: custom,
  resume: 'id',
  reconciledCalls: receipts,
};
void [conflicting, returning, orphan, missingResume, customReceipts];

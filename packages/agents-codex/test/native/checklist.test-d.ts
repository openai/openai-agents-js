import { expectTypeOf } from 'vitest';
import {
  checklist,
  type Checklist,
  type ChecklistState,
  type Session,
  type Tool,
} from '../../src';

expectTypeOf(checklist()).toEqualTypeOf<Checklist>();
expectTypeOf<Checklist>().toExtend<Tool>();
declare const session: Session;
expectTypeOf(session.checklist()).toEqualTypeOf<
  Promise<ChecklistState | null>
>();
session.checklist({ subagentId: 'owned-child' });
declare const state: ChecklistState;
// @ts-expect-error Read snapshots do not grant an application-side writer.
state.threadId = 'other';
// @ts-expect-error Steps remain readonly throughout the detached result.
state.plan[0].status = 'completed';
// @ts-expect-error The ordered accepted list is readonly.
state.plan.push({ step: 'new', status: 'pending' });
// @ts-expect-error The opening descriptor has no mutable setting.
checklist().kind = 'checklist';

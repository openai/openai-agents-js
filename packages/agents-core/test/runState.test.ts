import {
  registerRunStateApprovalTests,
  registerRunStateCoreTests,
  registerRunStateMigrationTests,
} from './runState.cases';

registerRunStateCoreTests();
registerRunStateMigrationTests();
registerRunStateApprovalTests();

import type { SessionStore } from './custom-thread-store';
import type { ReconciledCall } from './local-recovery';
import type { LocalStorage } from './local-storage';
import type { SessionState } from './state';

/** Select one persistence owner; recovery receipts belong to local resumes. */
export type SessionPersistenceOptions =
  | {
      /** Restore a portable checkpoint using current application bindings. */
      state?: SessionState;
      storage?: never;
      resume?: never;
      reconciledCalls?: never;
    }
  | {
      state?: never;
      /** Select native storage for a fresh Session, or omit it for memory. */
      storage?: LocalStorage | SessionStore;
      resume?: never;
      reconciledCalls?: never;
    }
  | {
      state?: never;
      storage: LocalStorage | SessionStore;
      /** Reopen this original native Session ID in the selected store. */
      resume?: string;
      reconciledCalls?: never;
    }
  | {
      state?: never;
      storage: LocalStorage;
      resume: string;
      /** Application-confirmed outcomes for unknown calls on this local resume. */
      reconciledCalls?: readonly ReconciledCall[];
    };

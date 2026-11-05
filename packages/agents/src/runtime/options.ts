import type { JsonObject, JsonValue } from './binding';
import type { EnvironmentConfig } from './environment';

/** SDK-owned configuration sent to the native runtime. */
export type RuntimeOptions = JsonObject & {
  environment?: EnvironmentConfig | null;
  native_goal_store?: string | null;
  native_thread_store?: string | null;
  _sdk_resume_thread_id?: string;
  cwd?: string | null;
  codex_home?: string | null;
  model?: string | null;
  model_provider?: string | null;
  approval_policy?: JsonValue;
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  base_instructions?: string | null;
  developer_instructions?: string | null;
  loader?: JsonObject;
};
export type ThreadOptions = JsonObject & {
  _sdk_resume_thread_id?: string;
  config?: JsonObject;
  runtime?: RuntimeOptions;
  instructions?: string;
  dynamic_tools?: JsonValue[];
};

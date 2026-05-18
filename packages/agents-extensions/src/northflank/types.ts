import type { FunctionTool } from '@openai/agents-core';

/**
 * Northflank tool group identifiers. Used by the `include` option on
 * {@link NorthflankToolsOptions} to filter which tools are exposed to the agent.
 */
export type NorthflankToolGroup =
  | 'read'
  | 'deploy'
  | 'exec'
  | 'files'
  | 'logs'
  | 'metrics'
  | 'secrets';

/**
 * Canonical names of every tool produced by {@link northflankTools}. Use these
 * to override approval behaviour or refer to specific tools in error handling.
 */
export type NorthflankToolName =
  | 'northflank_list_projects'
  | 'northflank_get_project'
  | 'northflank_list_services'
  | 'northflank_get_service'
  | 'northflank_create_service'
  | 'northflank_update_service_deployment'
  | 'northflank_start_service_build'
  | 'northflank_restart_service'
  | 'northflank_scale_service'
  | 'northflank_exec_service'
  | 'northflank_exec_job'
  | 'northflank_exec_addon'
  | 'northflank_upload_files'
  | 'northflank_download_files'
  | 'northflank_get_service_logs'
  | 'northflank_get_service_metrics'
  | 'northflank_list_secrets';

/**
 * Approval policy for the generated tools.
 *
 * - `'auto'` (default): mutating + exec + file-upload tools require approval; reads do not.
 * - `'always'`: every tool requires approval.
 * - `'never'`: no tool requires approval (use only for trusted automation).
 * - object: per-tool override. Falls back to `'auto'` for unspecified tools.
 */
export type NorthflankApprovalsConfig =
  | 'auto'
  | 'always'
  | 'never'
  | Partial<Record<NorthflankToolName, boolean>>;

export interface NorthflankToolsOptions {
  /**
   * Limit the toolset to the specified groups. Defaults to all groups except
   * `secrets`, which is opt-in because it exposes sensitive metadata.
   */
  include?: NorthflankToolGroup[];

  /**
   * Approval policy. See {@link NorthflankApprovalsConfig}.
   */
  approvals?: NorthflankApprovalsConfig;

  /**
   * If provided, the `projectId` argument on every tool becomes optional and
   * falls back to this value. Useful when an agent is scoped to a single project.
   */
  defaultProjectId?: string;

  /**
   * If provided, scopes API calls to a specific team/org. Pass-through on every
   * request and exposed as a default for tools that accept an explicit teamId.
   */
  teamId?: string;

  /**
   * Hard cap on captured output per exec call, in characters. Defaults to
   * 20,000. For exec tools the cap is split evenly between stdout and stderr
   * (so total output is still bounded by this number, not double it). For
   * other tools the whole JSON response is truncated to this length.
   * Truncation is marked with `[truncated N chars]` so the model can adapt.
   */
  outputCharLimit?: number;

  /**
   * Timeout for exec tools (`exec_service` / `exec_job` / `exec_addon`), in
   * milliseconds. Defaults to 120,000 (2 minutes). The OpenAI Agents runtime
   * aborts the tool call past this point so a stuck remote command can't hang
   * the run forever.
   */
  execTimeoutMs?: number;

  /**
   * Timeout for file copy tools (`upload_files` / `download_files`), in
   * milliseconds. Defaults to 300,000 (5 minutes) to accommodate larger
   * directory copies.
   */
  fileTimeoutMs?: number;
}

export type NorthflankTool = FunctionTool<any, any, any>;

/** Private binding. JSON authority fields must retain their original integer text. */
export type NativeId = string;
export class Engine {
  private constructor();
  readonly startup_warnings: string[];
  _sentinel_bind(
    base: string,
    grant: string,
    excluded_base: string | null,
  ): void;
  _sentinel_admit(provider_id: string, metadata: string): Promise<string>;
  _sentinel_claim(
    provider_id: string,
    metadata: string,
    expected: string,
  ): Promise<string>;
  _sentinel_current(
    provider_id: string,
    metadata: string,
    expected: string,
  ): Promise<string>;
  _sentinel_finish(
    provider_id: string,
    metadata: string,
    expected: string,
  ): Promise<string>;
  _sentinel_restore_schemas(
    provider_id: string,
    ticket: string,
    body: string,
  ): Promise<string>;
  _sentinel_open(
    provider_id: string,
    headers: string,
  ): Promise<NativeModelWebSocket>;
  _sentinel_websocket_failed(
    provider_id: string,
    ticket: string,
    oversized: boolean,
  ): Promise<void>;
  _sentinel_stream(
    provider_id: string,
    headers: string,
    body: Buffer,
    ticket: string,
    request: _ModelHttpRequest,
  ): Promise<NativeModelResponse>;
  restore_checkpoint(
    payload_json: string,
    options_json: string,
    specs_json: string | null,
    fresh_manual?: boolean,
  ): Promise<NativeThread>;
  start_replaceable_thread(
    options_json: string,
    specs_json: string,
  ): Promise<NativeThread>;
  _start_local_resume(
    options_json: string,
    specs_json: string,
  ): Promise<NativeThread | string>;
  _close_report(): Promise<string | null>;
  close(): Promise<void>;
}

export class _ContextChange {
  private constructor();
  options(): Promise<string>;
  prepare(summary: string): Promise<string>;
  createCandidateEngine(
    apiKey?: string | null,
    mcpServersJson?: string | null,
  ): Promise<Engine>;
  validateCandidate(thread: NativeThread): Promise<void>;
  retire(): Promise<string | null>;
  fence(): Promise<void>;
  release(): Promise<void>;
  publishCandidateMcpServers(
    thread: NativeThread,
    servers_json: string,
    policies_json?: string | null,
    interception_rules_json?: string | null,
  ): Promise<string>;
  nextCandidateEvent(thread: NativeThread): Promise<string | null>;
  stopCandidateEvents(): Promise<void>;
  cleanupCandidate(): Promise<string | null>;
}
export class NativeThread {
  _native_question_pending(question_id: string): Promise<boolean>;
  /** Whether this captured URL still has its original unanswered consent RPC. */
  _native_url_pending(question_id: string): Promise<boolean>;
  /** null means incomplete; true/false is the original completion/expiry outcome. */
  _native_url_completion_status(question_id: string): Promise<boolean | null>;
  _cancel_native_url_completion(question_id: string): Promise<boolean>;
  _respond_owned_native_question(
    question_id: string,
    response_json: string,
  ): Promise<boolean>;
  /** Negative retirement only. Positive replies require a captured question. */
  _respond_native_question(response_json: string): Promise<void>;
  _selected_model_root(): string;
  _begin_context_change(): Promise<_ContextChange>;
  _application_instructions(): string | null;
  private constructor();
  readonly id: string;
  readonly rollout_path: string | null;
  _enable_native_interception(timeout: number, scope: string): boolean;
  _configure_native_interception(rules_json: string): void;
  _revoke_native_interception(): void;
  _next_native_interception(): Promise<string>;
  _resolve_native_interception(nonce: NativeId, reply: string): boolean;
  _check_native_interception(nonce: string): boolean;
  _hold_native_interception_for_stop(nonce: string): _NativePolicyStop | null;
  _release_native_interception(nonce: NativeId): boolean;
  _handoff_native_interception(nonce: NativeId): boolean;
  _finish_native_interception_reader(): void;
  _enable_native_mcp_results(timeout: number): void;
  _revoke_native_mcp_results(): void;
  _take_native_mcp_result_failure(turn_id: string): boolean;
  _next_native_mcp_result(): Promise<string>;
  _check_native_mcp_result(
    nonce: NativeId,
    turn_id: string,
    call_id: string,
  ): boolean;
  _fail_native_mcp_result(
    nonce: NativeId,
    turn_id: string,
    call_id: string,
  ): boolean;
  _handoff_native_mcp_result(nonce: NativeId): boolean;
  _release_native_mcp_result(nonce: NativeId): boolean;
  _resolve_native_mcp_result(
    nonce: NativeId,
    turn_id: string,
    call_id: string,
    reply: string,
  ): boolean;
  _read_goal(): Promise<string>;
  _fork_settled(): Promise<NativeThread>;
  _discard_fork(): Promise<string | null>;
  _export_checkpoint(
    request_json: string | null,
    closing: boolean,
    probe?: boolean,
  ): Promise<string>;
  _check_python_tool(request_json: string): void;
  /** JSON array of original native event strings, preserving exact receipt integers. */
  _pending_manual_tools(owner_json: string): string;
  _manual_tool_current(request_json: string): boolean;
  call(
    operation: 'set_instructions' | 'list_subagents',
    params_json: string,
  ): Promise<string>;
  _submit(params_json: string): Promise<string>;
  _validate_hosted_search_model(): Promise<void>;
  _update_model_settings(settings_json: string): Promise<boolean>;
  _compact(): Promise<string>;
  _execute_command(name: string, arguments_: string): Promise<string>;
  _reply_step(response_json: string): void;
  _check_step(response_json: string): boolean;
  _reply_child_step(response_json: string): boolean;
  _replace_tools(
    generation: NativeId,
    specs_json: string,
    default_slots_json?: string,
  ): Promise<NativeId>;
  _replace_mcp_servers(
    servers_json: string,
    policies_json?: string,
    interception_rules_json?: string,
    tool_generation?: string,
    specs_json?: string,
    startup_boundary?: string,
  ): Promise<string>;
  _cancel_child_callback(request_json: string): Promise<boolean>;
  _respond_python_tool(response_json: string): Promise<boolean>;
  _configure_manual_tools(slots_json: string): void;
  _manual_checkpoint_config_supported(): Promise<boolean>;
  _begin_manual_checkpoint_wait(validated_requests_json: string): string;
  _wait_manual_checkpoint_progress(token: string): Promise<void>;
  _end_manual_checkpoint_wait(token: string): void;
  _manual_checkpoint_ready(validated_requests_json: string): Promise<boolean>;
  _seal_manual_checkpoint(validated_requests_json: string): Promise<string>;
  _restore_manual_continuation(continuation_json: string): Promise<string>;
  _respond_manual_continuation(request_and_output_json: string): Promise<void>;
  _complete_manual_continuation(
    outputSchemaJson?: string,
    selectionJson?: string,
  ): Promise<string>;
  read_thread_history(subagent_id: string | null): Promise<string>;
  read_checklist(subagent_id?: string | null): Promise<string>;
  _interrupt_session(): Promise<void>;
  _next_session_event(): Promise<string>;
  _child_turn(child_id: string): Promise<_NativeChildTurn | null>;
  _child_instance(
    child_id: string,
  ): Promise<[instanceId: string, turn: _NativeChildTurn | null] | null>;
  _child_submit(
    child_id: string,
    instance_id: string,
    input_json: string,
  ): Promise<_NativeChildTurn>;
  _finish_child_event_reader(): void;
  close(): Promise<void>;
  _close_report(): Promise<string | null>;
  _close_selected_environment(): Promise<string | null>;
  _stop_sampling_for_close(): void;
  _request_graph_stop(
    scope: 'root' | 'thread_tree',
    mode: 'force' | 'graceful',
  ): _NativeGraphStop;
}

/** Private stop reservation, held until native work and SDK cleanup settle. */
export class _NativeGraphStop {
  private constructor();
  settle(): Promise<void>;
  release(success: boolean): void;
}

export class _NativeChildTurn {
  _continue(): Promise<_NativeChildTurn | null>;
  private constructor();
  readonly session_id: string;
  readonly child_id: string;
  readonly instance_id: string;
  readonly incarnation: string;
  readonly turn_id: string;
  /** Private JSON result bridge preserving exact i64 usage counters. */
  wait_with_usage(): Promise<string>;
  /** Cached terminal error for this exact child outcome; reading starts no work. */
  terminal_error(): string | null;
  /** Null means confirmed interruption with failed native cleanup. */
  cancel(): Promise<boolean | null>;
}

export class _ModelHttpRequest {
  constructor();
  cancel(): void;
}

export class NativeModelResponse {
  private constructor();
  readonly status: number;
  readonly headers: [string, string][];
  /** Returns null on terminal end. Calling code implements the JS iterator. */
  next_chunk(): Promise<Buffer | null>;
  close(): Promise<void>;
}

export type NativeFrame =
  | { type: 'text'; text: string }
  | { type: 'binary'; data: Buffer }
  | { type: 'close'; code: number; reason: string }
  | { type: 'closed' };
export class NativeModelWebSocket {
  private constructor();
  readonly available: boolean;
  readonly error_body: Buffer;
  readonly status: number;
  readonly headers: [string, string][];
  project_response_items(
    items_json: string,
    content_item_kinds: boolean,
  ): string;
  send_text(text: string): Promise<void>;
  receive(): Promise<NativeFrame | null>;
  close(code: number, reason: string): Promise<void>;
}
/** Pure declaration preflight; never acquires runtime resources. */
export function _validate_python_tool_declarations(specs_json: string): void;
export function _read_session_instructions(history_json: string): string;
export function _validate_application_instructions(
  history_json: string,
  instructions: string | null,
): boolean;
export function create_engine(
  config_json: string,
  runtime_json: string,
  api_key: string | null,
  application_apps_json?: string | null,
): Promise<Engine>;
export function create_checkpoint_engine(
  config_json: string,
  runtime_json: string,
  api_key: string | null,
  initial_checkpoint?: string | null,
  initial_specs_json?: string | null,
  fresh_manual?: boolean | null,
  application_apps_json?: string | null,
): Promise<Engine>;
export function configure_telemetry(config_json: string): Promise<void>;
export function shutdown_telemetry(): Promise<void>;
export function _embedded_commands(): string;
export const CODEX_REVISION: string;

declare const binding: {
  _packaged_runtime(): {
    codex_self_exe: string;
    codex_linux_sandbox_exe?: string;
    main_execve_wrapper_exe?: string;
    code_mode_host_exe: string;
  };
  Engine: typeof Engine;
  _ContextChange: typeof _ContextChange;
  _NativePolicyStop: typeof _NativePolicyStop;
  NativeThread: typeof NativeThread;
  _ModelHttpRequest: typeof _ModelHttpRequest;
  NativeModelResponse: typeof NativeModelResponse;
  NativeModelWebSocket: typeof NativeModelWebSocket;
  _validate_python_tool_declarations: typeof _validate_python_tool_declarations;
  _read_session_instructions: typeof _read_session_instructions;
  _validate_application_instructions: typeof _validate_application_instructions;
  create_engine: typeof create_engine;
  create_checkpoint_engine: typeof create_checkpoint_engine;
  configure_telemetry: typeof configure_telemetry;
  shutdown_telemetry: typeof shutdown_telemetry;
  _embedded_commands: typeof _embedded_commands;
  CODEX_REVISION: typeof CODEX_REVISION;
};
export default binding;

/** Private exact-owner receipt, captured atomically with effect admission fencing. */
export class _NativePolicyStop {
  private constructor();
  finish(): Promise<void>;
}

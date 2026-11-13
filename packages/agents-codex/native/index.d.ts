/** Private binding. JSON authority fields must retain their original integer text. */
export type NativeId = string;
export class _StoredHistoryClose {
  private constructor();
  apply(): Promise<void>;
}
export class _ProviderHttpTransports {
  private constructor();
  /** Drops cached clients; does not claim an asynchronous transport drain. */
  close(): void;
}
export function _create_provider_http_transports(
  engine: Engine,
): _ProviderHttpTransports;
export class _PlainRun {
  private constructor();
  cancel(): void;
  wait(): Promise<string>;
  close(): Promise<void>;
}
export class Engine {
  _plain_run_supported(
    config: string,
    runtime: string,
    model?: string | null,
  ): Promise<boolean>;
  _plain_run(request: string): Promise<_PlainRun>;
  private constructor();
  readonly startup_warnings: string[];
  _sentinel_bind(
    base: string,
    grant: string,
    excluded_base: string | null,
    shared_transports?: _ProviderHttpTransports | null,
  ): void;
  _sentinel_admit(provider_id: string, metadata: string): Promise<string>;
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
  _start_seeded_replaceable_thread(
    options_json: string,
    specs_json: string,
    initial_messages_json: string,
  ): Promise<NativeThread>;
  _start_local_resume(
    options_json: string,
    specs_json: string,
  ): Promise<NativeThread | string>;
  readonly _private_reuse_ready: boolean;
  _private_start_thread(
    configJson: string,
    runtimeJson: string,
    origin: string,
    grant: string,
    optionsJson: string,
    specsJson: string,
  ): Promise<NativeThread | null>;
  _close_report(): Promise<string | null>;
  _close_report_defer_saved_login(): Promise<string | null>;
  _retained_storage_failure(): string | null;
  close(): Promise<void>;
}

export class _ContextChange {
  private constructor();
  context(): Promise<string>;
  options(): Promise<string>;
  prepare(summary: string, retainedIndices: number[]): Promise<string>;
  restoreCandidate(
    optionsJson: string,
    specsJson?: string | null,
  ): Promise<NativeThread>;
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
/** Private exact-generation media cleanup; retains no native Thread or Engine. */
export class _RealtimeCleanup {
  close(generation: string): Promise<void>;
}

export class NativeThread {
  _realtime_adapter(generation: string): _NativeRealtimeAdapter;
  _prepare_realtime(
    paramsJson: string,
    adapter?: _NativeRealtimeAdapter | null,
  ): Promise<string>;
  _realtime_cleanup(): _RealtimeCleanup;
  _submit_realtime_tools(paramsJson: string): Promise<string>;
  _configure_agent_profiles(
    rosterJson: string,
    rootId: string,
  ): Promise<string>;
  _active_agent_profile(): Promise<string>;
  _admit_realtime_agent_graph(
    generation: string,
    rosterJson: string,
    rootId: string,
    expectedJson: string,
  ): Promise<string>;
  _discard_realtime_agent_graph(
    generation: string,
    receiptJson: string,
  ): Promise<void>;
  _realtime_agent_source(
    generation: string,
    targetJson: string,
  ): Promise<string>;
  _restore_realtime_agent_graph(generation: string): Promise<string>;
  _activate_agent_profile(
    target: string,
    expectedJson: string,
  ): Promise<string>;
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
  _read_model_context(): Promise<string>;
  _read_plan_usage(request: _ModelHttpRequest): Promise<string | null>;
  _enable_raw_provider_events(): void;
  _canonical_history(
    limit?: number | null,
    forReplay?: boolean,
  ): Promise<string>;
  _record_memory_input_admission(turn_id: string): Promise<void>;
  _memory_history(turn_id: string): Promise<string>;
  _stored_history(query_json: string): Promise<string>;
  _set_stored_name(name_json: string): Promise<string>;
  _stored_history_close_action(action_json: string): _StoredHistoryClose;
  _transact_history(
    expectedRevision: string,
    keep: number,
    itemsJson: string,
  ): Promise<string>;
  _append_recovered_output(
    expectedRevision: string,
    messageId: string,
    text: string,
  ): Promise<string>;
  _pop_history(
    expectedRevision: string,
    allowRebuild: boolean,
  ): Promise<string>;
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
  _take_native_mcp_result_failure(turn_id: string, aborted?: boolean): boolean;
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
  _resolve_native_mcp_result_with_assignment(
    nonce: NativeId,
    turn_id: string,
    call_id: string,
    reply: string,
  ): Promise<[boolean, boolean]>;
  _read_goal(): Promise<string>;
  _set_paused_goal(
    objective: string,
    token_budget?: string | null,
  ): Promise<string>;
  _fork_settled(): Promise<NativeThread>;
  _fork_stored(requestJson: string): Promise<NativeThread>;
  _discard_stored_fork(): Promise<string | null>;
  _publish_stored_fork(): Promise<string>;
  _discard_fork(): Promise<string | null>;
  _export_checkpoint(
    request_json: string | null,
    closing: boolean,
    probe?: boolean,
  ): Promise<string>;
  _check_python_tool(request_json: string): boolean;
  _set_configured_continuation(
    request_json: string,
    receipt_json: string,
    state_json?: string,
  ): Promise<boolean>;
  _enter_python_callback(receipt_json: string): boolean;
  _python_callback_cancelled(receipt_json: string): boolean;
  _release_python_callback(
    receipt_json: string,
    cleanup_failed?: boolean,
  ): boolean;
  /** JSON array of original native event strings, preserving exact receipt integers. */
  _pending_manual_tools(owner_json: string): string;
  _manual_tool_current(request_json: string): boolean;
  call(
    operation:
      | 'set_instructions'
      | 'realtime_tool_selection_sdk'
      | 'realtime_conversation_config_sdk'
      | 'realtime_conversation_send_event_sdk'
      | 'realtime_conversation_update_history_sdk'
      | 'realtime_conversation_retrieve_item_sdk'
      | 'realtime_conversation_retrieve_history_sdk'
      | 'realtime_conversation_hosted_mcp_approval_sdk'
      | 'realtime_conversation_prepare_sdk'
      | 'realtime_conversation_activate_sdk'
      | 'realtime_conversation_start_sdk'
      | 'realtime_conversation_update_sdk'
      | 'realtime_conversation_audio_sdk'
      | 'realtime_conversation_audio_commit_sdk'
      | 'realtime_conversation_input_sdk'
      | 'realtime_conversation_response_sdk'
      | 'realtime_conversation_delete_item_sdk'
      | 'realtime_conversation_text_sdk'
      | 'realtime_conversation_complete_sdk'
      | 'realtime_conversation_fail_sdk'
      | 'realtime_conversation_interrupt_sdk'
      | 'realtime_conversation_close_sdk'
      | 'list_subagents'
      | 'list_mcp_resources'
      | 'list_mcp_prompts'
      | 'get_mcp_prompt'
      | 'list_mcp_resource_templates'
      | 'read_mcp_resource'
      | 'call_mcp_app_tool'
      | 'mcp_app_tool_metadata',
    params_json: string,
  ): Promise<string>;
  _submit(params_json: string): Promise<string>;
  _validate_hosted_search_model(): Promise<void>;
  _update_model_settings(settings_json: string): Promise<boolean>;
  _compact(
    traceJson?: string | null,
    tracing_context?: string,
  ): Promise<string>;
  _execute_command(
    name: string,
    arguments_: string,
    traceJson?: string | null,
    tracing_context?: string,
  ): Promise<string>;
  _reply_model_retry(responseJson: string): void;
  _report_model_attempt_usage(ownerJson: string, usageJson: string): boolean;
  _reply_model_producer(response_json: string): void;
  _start_model_producer(
    owner_json: string,
    chat_stream?: boolean,
    upstream_request_id?: string,
  ): void;
  _push_model_producer(
    owner_json: string,
    event_json: string,
    raw_chat_chunk?: boolean,
  ): Promise<boolean>;
  _reply_prepared_request(responseJson: string): void;
  _reply_step(response_json: string): void;
  _reply_compaction(response_json: string): void;
  _reply_provider_response_span(responseJson: string): void;
  _reply_handoff_input(response_json: string): void;
  _reply_model_context(response_json: string): void;
  _reply_natural_completion(response_json: string): void;
  _load_client_tool_search(request_json: string, paths_json?: string): string;
  _capture_client_tool_search(
    request_json: string,
    specs_json: string,
  ): NativeId;
  _check_step(response_json: string): boolean;
  _stop_step(response_json: string): boolean;
  _reply_child_step(response_json: string): boolean;
  _replace_tools(
    generation: NativeId,
    specs_json: string,
    default_slots_json?: string,
    terminal_slots_json?: string,
    allocate_generation?: boolean,
  ): Promise<NativeId>;
  _replace_mcp_servers(
    servers_json: string,
    policies_json?: string,
    interception_rules_json?: string,
    tool_generation?: string,
    specs_json?: string,
    startup_boundary?: string,
    cancel_on_resource_close?: boolean,
    terminal_slots_json?: string,
    default_slots_json?: string,
    allocate_generation?: boolean,
  ): Promise<string>;
  _configured_child_policy(request_json: string): Promise<string>;
  _cancel_child_callback(request_json: string): Promise<boolean>;
  _respond_python_tool(
    response_json: string,
    wait_for_acceptance?: boolean,
  ): Promise<boolean>;
  _require_tool_approval(requestJson: string, argumentsJson?: string): boolean;
  _approve_manual_tool(requestJson: string): Promise<boolean>;
  _configure_manual_tools(
    slots_json: string,
    terminal_slots_json?: string,
  ): void;
  _check_tool_completion(response_json: string): boolean;
  _reply_tool_completion(response_json: string): boolean;
  _manual_checkpoint_config_supported(): Promise<boolean>;
  _begin_manual_checkpoint_wait(validated_requests_json: string): string;
  _wait_manual_checkpoint_progress(token: string): Promise<void>;
  _end_manual_checkpoint_wait(token: string): void;
  _manual_checkpoint_ready(validated_requests_json: string): Promise<boolean>;
  _seal_manual_checkpoint(validated_requests_json: string): Promise<string>;
  _restore_manual_continuation(
    continuation_json: string,
    tracing_context?: string,
    operation_tools_json?: string,
  ): Promise<string>;
  _respond_manual_continuation(request_and_output_json: string): Promise<void>;
  _complete_manual_continuation(
    outputSchemaJson?: string,
    selectionJson?: string,
    traceJson?: string,
    tracing_context?: string,
    observationSubmissionId?: string,
  ): Promise<string>;
  _start_raw_usage(): void;
  _start_request_attempts(): void;
  _take_request_attempts(turn_id: string): string;
  _attach_raw_usage(parent: NativeThread): void;
  _take_raw_usage(turn_id: string): string;
  _start_produced_items(): void;
  _take_produced_items(turn_id: string): string;
  read_thread_history(subagent_id: string | null): Promise<string>;
  read_checklist(subagent_id?: string | null): Promise<string>;
  _interrupt_session(): Promise<void>;
  _next_session_event(): Promise<string>;
  _enable_sandbox_operations(): void;
  _next_session_events(): Promise<string[]>;
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
  _close_private_root_report(): Promise<string | null>;
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
  _send_owned_text(text: string, ticket: string): Promise<void>;
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
export class _SessionStoreReconciliation {
  run(): Promise<void>;
  close(): Promise<void>;
}
export function reconcile_thread_store(
  callback: (request: string) => Promise<string>,
  result_json: string,
  plan_identity?: string,
): _SessionStoreReconciliation;
export function create_store_engine(
  config_json: string,
  runtime_json: string,
  api_key: string | null,
  callback: (request: string) => Promise<string>,
  application_apps_json?: string | null,
): Promise<Engine>;
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
export function _create_plan_engine(
  config_json: string,
  runtime_json: string,
  bearer: string,
  identity: string,
  initial_checkpoint?: string | null,
  initial_specs_json?: string | null,
  store?: ((request: string) => Promise<string>) | null,
): Promise<Engine>;
export function configure_telemetry(config_json: string): Promise<void>;
export function shutdown_telemetry(timeout_ms?: number): Promise<void>;
export function start_trace_span(options_json: string): string;
export function end_trace_span(handle: string, outcome_json: string): void;
export function retain_trace_context(handle: string): string;
export function borrow_trace_context(
  parent: string,
  restrictions_parent: string | null,
  disabled: boolean,
  include_sensitive_data: boolean,
): string;
export function _retain_callback_dispatch_context(
  handle: string,
  key: string,
  release: () => void,
): string;
export function release_trace_context(context: string): void;
export function trace_span_context(handle: string): string;
export function release_trace_span(handle: string): void;
export function force_flush_telemetry(timeout_ms: number): Promise<string>;
export function set_trace_routes(options_json: string): number;
export function drain_trace_events(max_count: number): Promise<string>;
export function dispatch_trace_event(encoded: string): Promise<void>;
export function ack_trace_events(
  through_sequence: number,
  failed_deliveries: number,
): void;
export function register_trace_credentials(headers_json: string): string;
export function release_trace_credentials(ref: string): void;
export function _embedded_commands(): string;
export const CODEX_REVISION: string;
export function initialize_sdk_client(version: string): void;

declare const binding: {
  _decision_questions: typeof _decision_questions;
  _decision_result: typeof _decision_result;
  _agent_profiles_fingerprint: typeof _agent_profiles_fingerprint;
  _agent_profiles_restore_source: typeof _agent_profiles_restore_source;
  _agent_profiles_operation_source: typeof _agent_profiles_operation_source;
  _packaged_runtime(): {
    codex_self_exe: string;
    codex_linux_sandbox_exe?: string;
    main_execve_wrapper_exe?: string;
    code_mode_host_exe: string;
  };
  Engine: typeof Engine;
  _ProviderHttpTransports: typeof _ProviderHttpTransports;
  _create_provider_http_transports: typeof _create_provider_http_transports;
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
  create_store_engine: typeof create_store_engine;
  _create_plan_engine: typeof _create_plan_engine;
  _SessionStoreReconciliation: typeof _SessionStoreReconciliation;
  reconcile_thread_store: typeof reconcile_thread_store;
  create_checkpoint_engine: typeof create_checkpoint_engine;
  configure_telemetry: typeof configure_telemetry;
  start_trace_span: typeof start_trace_span;
  end_trace_span: typeof end_trace_span;
  retain_trace_context: typeof retain_trace_context;
  borrow_trace_context: typeof borrow_trace_context;
  _retain_callback_dispatch_context: typeof _retain_callback_dispatch_context;
  release_trace_context: typeof release_trace_context;
  trace_span_context: typeof trace_span_context;
  release_trace_span: typeof release_trace_span;
  force_flush_telemetry: typeof force_flush_telemetry;
  set_trace_routes: typeof set_trace_routes;
  drain_trace_events: typeof drain_trace_events;
  dispatch_trace_event: typeof dispatch_trace_event;
  ack_trace_events: typeof ack_trace_events;
  register_trace_credentials: typeof register_trace_credentials;
  release_trace_credentials: typeof release_trace_credentials;
  shutdown_telemetry: typeof shutdown_telemetry;
  _embedded_commands: typeof _embedded_commands;
  initialize_sdk_client: typeof initialize_sdk_client;
  CODEX_REVISION: typeof CODEX_REVISION;
};
export default binding;

/** Private exact-owner receipt, captured atomically with effect admission fencing. */
export class _NativePolicyStop {
  private constructor();
  finish(): Promise<void>;
}

export function _agent_profiles_fingerprint(
  rosterJson: string,
  rootId: string,
): string;

export function _agent_profiles_restore_source(
  rosterJson: string,
  rootId: string,
  historyJson: string,
): string;

/** Resolve the proved declaration origin of an explicitly selected suspended operation. */
export function _agent_profiles_operation_source(
  roster_json: string,
  root_id: string,
  history_json: string,
  turn_id: string,
): string;

export class _NativeRealtimeAdapter {
  private constructor();
  next(): Promise<_NativeRealtimeAdapterRequest | null>;
  receive(frame: string): Promise<void>;
  end(success: boolean): void;
  finish(): void;
}
export class _NativeRealtimeAdapterRequest {
  private constructor();
  readonly event_json: string;
  complete(success: boolean): boolean;
}

export declare function _decision_questions(
  schemaJson: string,
  question: string,
): string;
export declare function _decision_result(
  schemaJson: string,
  question: string,
  answersJson: string,
): string;

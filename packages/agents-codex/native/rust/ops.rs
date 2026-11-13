//! JSON adapters for native operations that contain Rust-only channels or values.
use crate::config::{decode, optional};
use crate::environment::StrictExecutorWrites;
use anyhow::{Context, Result, bail, ensure};
use codex_core_api::{AbsolutePathBuf, CodexThread, WithTurnExtensionData};
use codex_extension_api::ExtensionDataInit;
use codex_protocol::config_types::{
    ApprovalsReviewer, CollaborationMode, Personality, ReasoningSummary, ToolChoice,
    WindowsSandboxLevel,
};
use codex_protocol::models::{
    ActivePermissionProfile, PermissionProfile, PermissionProfileSnapshot, ProfileWorkspaceRoot,
};
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::*;
use codex_protocol::sandbox::SandboxType;
use codex_protocol::turn_input::*;
use codex_protocol::user_input::UserInput;
use codex_utils_path_uri::PathUri;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use tokio::sync::oneshot;

macro_rules! params {
    ($name:ident { $($(#[$attr:meta])* $field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct $name { $($(#[$attr])* $field: $ty),* }
    };
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentSelection {
    pub environment_id: String,
    pub cwd: PathUri,
    #[serde(default)]
    pub workspace_roots: Vec<PathUri>,
    #[serde(default)]
    pub config: EnvironmentState,
}

/// Decode complete native environment selections for thread and turn startup.
pub fn environments(value: Value) -> Result<Vec<TurnEnvironmentSelection>> {
    decode::<Vec<EnvironmentSelection>>(value)?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentState {
    #[default]
    FromThread,
    Pending,
    Ready(EnvironmentOptions),
    Failed(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentOptions {
    allow_login_shell: bool,
    workspace_roots: Vec<PathUri>,
    permission_profile: PermissionSnapshot,
    // Reuse native config parsing for wildcard patterns and filter precedence.
    shell_environment_policy: codex_config::types::ShellEnvironmentPolicyToml,
    windows_sandbox_level: WindowsSandboxLevel,
    windows_sandbox_type: SandboxType,
    use_legacy_landlock: bool,
    exec_policy: Option<codex_config::RequirementsExecPolicyToml>,
    mcp_policy: Option<McpPolicy>,
    network_policy: Option<codex_core_api::EnvironmentNetworkPolicy>,
    #[serde(default)]
    selected_capability_roots: Vec<codex_protocol::capabilities::SelectedCapabilityRoot>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionSnapshot {
    permission_profile: PermissionProfile,
    active_permission_profile: Option<ActivePermissionProfile>,
    #[serde(default)]
    profile_workspace_roots: Vec<PathUri>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpPolicy {
    servers: Option<BTreeMap<String, codex_protocol::mcp_policy::McpServerRequirement>>,
    plugins: Option<BTreeMap<String, codex_protocol::mcp_policy::PluginMcpRequirements>>,
}

impl TryFrom<EnvironmentOptions> for EnvironmentConfig {
    type Error = anyhow::Error;
    fn try_from(value: EnvironmentOptions) -> Result<Self> {
        let p = value.permission_profile;
        let permission_profile = match p.active_permission_profile {
            Some(active) => PermissionProfileSnapshot::active_with_profile_workspace_roots(
                p.permission_profile,
                active,
                p.profile_workspace_roots
                    .into_iter()
                    .map(Into::into)
                    .collect(),
            ),
            None if p.profile_workspace_roots.is_empty() => {
                PermissionProfileSnapshot::legacy(p.permission_profile)
            }
            None => bail!("profile_workspace_roots require an active_permission_profile"),
        };
        Ok(Self {
            allow_login_shell: value.allow_login_shell,
            workspace_roots: value.workspace_roots,
            permission_profile,
            shell_environment_policy: value.shell_environment_policy.into(),
            windows_sandbox_level: value.windows_sandbox_level,
            windows_sandbox_type: value.windows_sandbox_type,
            use_legacy_landlock: value.use_legacy_landlock,
            exec_policy: value
                .exec_policy
                .map(|p| {
                    p.to_policy()
                        .map(codex_execpolicy::RequirementsExecPolicy::new)
                })
                .transpose()?,
            mcp_policy: value
                .mcp_policy
                .map(|p| codex_core_api::EnvironmentMcpPolicy {
                    servers: p.servers,
                    plugins: p.plugins,
                }),
            network_policy: value.network_policy,
            selected_capability_roots: value.selected_capability_roots,
        })
    }
}

impl TryFrom<EnvironmentSelection> for TurnEnvironmentSelection {
    type Error = anyhow::Error;
    fn try_from(value: EnvironmentSelection) -> Result<Self> {
        let selection = Self {
            environment_id: value.environment_id,
            cwd: value.cwd,
            workspace_roots: value.workspace_roots,
            config: match value.config {
                EnvironmentState::FromThread => EnvironmentConfigState::FromThread,
                EnvironmentState::Pending => EnvironmentConfigState::Pending,
                EnvironmentState::Ready(config) => {
                    EnvironmentConfigState::Ready(config.try_into()?)
                }
                EnvironmentState::Failed(error) => EnvironmentConfigState::Failed(error),
            },
        };
        Ok(selection)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Environments {
    legacy_fallback_cwd: AbsolutePathBuf,
    environments: Vec<EnvironmentSelection>,
}

fn deserialize_environments<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<TurnEnvironmentSelections>, D::Error> {
    Option::<Environments>::deserialize(d)?
        .map(|v| {
            Ok::<_, anyhow::Error>(TurnEnvironmentSelections {
                legacy_fallback_cwd: v.legacy_fallback_cwd,
                environments: v
                    .environments
                    .into_iter()
                    .map(TryInto::try_into)
                    .collect::<Result<_>>()?,
            })
        })
        .transpose()
        .map_err(serde::de::Error::custom)
}

fn profile_roots<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Vec<ProfileWorkspaceRoot>>, D::Error> {
    Ok(Option::<Vec<PathUri>>::deserialize(d)?
        .map(|roots| roots.into_iter().map(Into::into).collect()))
}

#[derive(Default, Deserialize)]
#[serde(remote = "ThreadSettingsOverrides", default, deny_unknown_fields)]
pub struct ThreadSettings {
    #[serde(deserialize_with = "deserialize_environments")]
    environments: Option<TurnEnvironmentSelections>,
    runtime_workspace_roots: Option<Vec<AbsolutePathBuf>>,
    #[serde(deserialize_with = "profile_roots")]
    profile_workspace_roots: Option<Vec<ProfileWorkspaceRoot>>,
    approval_policy: Option<AskForApproval>,
    approvals_reviewer: Option<ApprovalsReviewer>,
    sandbox_policy: Option<SandboxPolicy>,
    permission_profile: Option<PermissionProfile>,
    active_permission_profile: Option<ActivePermissionProfile>,
    windows_sandbox_level: Option<WindowsSandboxLevel>,
    model: Option<String>,
    #[serde(deserialize_with = "optional")]
    effort: Option<Option<ReasoningEffort>>,
    summary: Option<ReasoningSummary>,
    #[serde(deserialize_with = "optional")]
    service_tier: Option<Option<String>>,
    tool_choice: Option<ToolChoice>,
    #[serde(deserialize_with = "optional")]
    invocation_timeout_ms: Option<Option<u32>>,
    request_controls: Option<codex_protocol::model_request_controls::ModelRequestControls>,
    collaboration_mode: Option<CollaborationMode>,
    personality: Option<Personality>,
    disabled_plugin_ids: Option<Vec<String>>,
}

/// Restrict the managed Session API to model settings, before any native mutation.
pub fn model_settings(params: Value) -> Result<ThreadSettingsOverrides> {
    let fields = params
        .as_object()
        .context("model settings must be an object")?;
    for (key, value) in fields {
        match key.as_str() {
            "invocation_timeout_ms" => {
                if !value.is_null() {
                    let ms = value
                        .as_u64()
                        .context("invocation_timeout_ms must be an integer or null")?;
                    anyhow::ensure!(
                        (1..=u32::MAX as u64).contains(&ms),
                        "invocation_timeout_ms must be in the range 1..=4294967295"
                    );
                }
            }
            "request_controls" => {
                anyhow::ensure!(value.is_object(), "request_controls must be an object");
                if let Some(target) = value
                    .get("named_tool_choice")
                    .filter(|value| !value.is_null())
                {
                    let fields = target
                        .as_object()
                        .context("named tool choice must be an object")?;
                    anyhow::ensure!(
                        fields
                            .keys()
                            .all(|key| matches!(key.as_str(), "name" | "namespace")),
                        "unknown named tool choice member"
                    );
                }
            }
            "model" | "effort" | "summary" | "service_tier" | "tool_choice" => {
                if key == "service_tier" && value.is_null() {
                    continue;
                }
                let text = value.as_str().context("model settings must be strings")?;
                anyhow::ensure!(!text.trim().is_empty(), "model settings must not be empty");
            }
            _ => bail!("unsupported model setting: {key}"),
        }
    }
    let settings = ThreadSettings::deserialize(params)?;
    if let Some(controls) = &settings.request_controls {
        controls.validate_shape().map_err(anyhow::Error::msg)?;
    }
    anyhow::ensure!(
        settings.effort != Some(Some(ReasoningEffort::Persistent)),
        "persistent reasoning is unsupported for replaceable sessions"
    );
    Ok(settings)
}

#[derive(Default, Deserialize)]
#[serde(remote = "TurnStartOptions", default, deny_unknown_fields)]
pub struct StartOptions {
    turn_trigger: Option<String>,
    final_output_json_schema: Option<Value>,
    service_tier: Option<String>,
    model_override: Option<String>,
    model_settings_override:
        Option<codex_protocol::model_request_controls::RunModelSettingsOverride>,
    parent_turn_id: Option<String>,
    root_turn_id: Option<String>,
    cyber_access_program: Option<CyberAccessProgram>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ContextKind {
    Untrusted,
    Application,
}

params!(ContextEntry {
    value: String,
    kind: ContextKind
});

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    StartIfIdle,
    StartOrSteer,
    Steer,
    ContinueIfIdle,
}
impl Default for Mode {
    fn default() -> Self {
        Self::StartIfIdle
    }
}

params!(TurnParams {
    input: Value,
    #[serde(default)]
    profile_output_override: bool,
    observation_submission_id: Option<String>,
    client_id: Option<String>,
    #[serde(default, alias = "settings", with = "ThreadSettings")]
    thread_settings: ThreadSettingsOverrides,
    #[serde(default, with = "StartOptions")]
    start: TurnStartOptions,
    #[serde(default)]
    additional_context: BTreeMap<String, ContextEntry>,
    responsesapi_client_metadata: Option<HashMap<String, String>>,
    trace: Option<W3cTraceContext>,
    #[serde(default)] mode: Mode,
    expected_turn_id: Option<String>,
    expected_previous_turn_id: Option<String>,
    #[serde(default)] exact_steering: bool,
    writable_roots: Option<Vec<PathUri>>,
    raise_on_unknown_tool: Option<bool>,
});

fn rejection(reason: NotSubmittedReason) -> Value {
    let reason = match reason {
        NotSubmittedReason::Superseded => json!({"type": "superseded"}),
        NotSubmittedReason::ServerDraining => json!({"type": "server_draining"}),
        NotSubmittedReason::NotIdle => json!({"type": "not_idle"}),
        NotSubmittedReason::PendingTriggerTurn => json!({"type": "pending_trigger_turn"}),
        NotSubmittedReason::PlanMode => json!({"type": "plan_mode"}),
        NotSubmittedReason::NoActiveTurn => json!({"type": "no_active_turn"}),
        NotSubmittedReason::ExpectedTurnMismatch { expected, actual } => {
            json!({"type": "expected_turn_mismatch", "expected": expected, "actual": actual})
        }
        NotSubmittedReason::ActiveTurnNotSteerable { turn_kind } => {
            json!({"type": "active_turn_not_steerable", "turn_kind": turn_kind})
        }
        NotSubmittedReason::ActiveTurnModelOverrideMismatch => {
            json!({"type": "active_turn_model_override_mismatch"})
        }
        NotSubmittedReason::ActiveTurnOutputSchemaMismatch => {
            json!({"type": "active_turn_output_schema_mismatch"})
        }
        NotSubmittedReason::EmptyInput => json!({"type": "empty_input"}),
    };
    json!({"status": "not_submitted", "reason": reason})
}

fn submission(result: TurnInputSubmission) -> Value {
    match result {
        TurnInputSubmission::Started { turn_id } => {
            json!({"status": "started", "turn_id": turn_id})
        }
        TurnInputSubmission::Steered { turn_id } => {
            json!({"status": "steered", "turn_id": turn_id})
        }
        TurnInputSubmission::NotSubmitted { reason } => rejection(reason),
    }
}

fn idle_submission(result: StartIfIdleSubmission) -> Value {
    match result {
        StartIfIdleSubmission::Started { turn_id } => {
            json!({"status": "started", "turn_id": turn_id})
        }
        StartIfIdleSubmission::NotSubmitted { reason } => rejection(reason),
    }
}

// Only private managed submit uses this distinction at the Node-API boundary.
// A local guard or decode before the Core submit await cannot have started work.
// Keep the original diagnostic; all other operation errors remain unconfirmed.
#[derive(Debug)]
pub(crate) struct PreAdmissionError(String);

impl std::fmt::Display for PreAdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub(crate) fn pre_admission(error: anyhow::Error) -> anyhow::Error {
    let marker = PreAdmissionError(error.to_string());
    error.context(marker)
}

/// Trace conflicts are known not to have admitted work, including submissions
/// whose host has already published an operation MCP selection.
pub(crate) fn prepare_submission_trace(value: &mut Value) -> Result<Option<Value>> {
    match crate::prepare_submission_trace(value) {
        Ok(()) => Ok(None),
        Err(crate::TraceIngressError::Conflict) => Ok(Some(json!({
            "status": "not_submitted",
            "reason": {
                "type": "trace_context_conflict",
                "message": "Explicit trace context must match the SDK tracing parent"
            }
        }))),
        Err(error) => Err(pre_admission(anyhow::Error::msg(error.to_string()))),
    }
}

pub async fn submit_replaceable(state: &crate::engine::ThreadState, value: Value) -> Result<Value> {
    let mut value = value;
    if let Some(receipt) = prepare_submission_trace(&mut value)? {
        return Ok(receipt);
    }
    let mut mutation = Some(state.mutations.lock().await);
    crate::graph_stop::check_after_wait(state, &value)?;
    let thread = &state.thread;
    if let Some(store) = &state.engine.local_checklist_store {
        if !matches!(
            thread.agent_status().await,
            codex_protocol::protocol::AgentStatus::Running
        ) {
            store
                .check_settled(state.id)
                .await
                .map_err(|error| pre_admission(error.into()))?;
        }
    }
    let mut value = value;
    let selection = value
        .as_object_mut()
        .and_then(|object| object.remove("selection"))
        .map(decode::<crate::python_tools::OperationSelection>)
        .transpose()
        .map_err(pre_admission)?;
    let mut p: TurnParams = decode(value).map_err(pre_admission)?;
    if p.raise_on_unknown_tool.is_some() && !matches!(p.mode, Mode::StartIfIdle) {
        return Err(pre_admission(anyhow::anyhow!(
            "Tool-not-found choice applies only to new roots"
        )));
    }
    if let Some(selection) = &selection {
        ensure!(
            selection.model_override == p.start.model_override
                && selection.model_settings_override == p.start.model_settings_override,
            "operation selection differs from the admitted run model"
        );
    }
    if let Some(model) = &p.start.model_override {
        state
            .engine
            .validate_hosted_search_model(model)
            .await
            .map_err(pre_admission)?;
    }
    if let Some(settings) = &p.start.model_settings_override {
        let mut controls = model_settings(
            serde_json::to_value(settings).map_err(|error| pre_admission(error.into()))?,
        )
        .map_err(pre_admission)?;
        controls.model = p.start.model_override.clone();
        state
            .engine
            .validate_request_controls(thread, &controls)
            .await
            .map_err(pre_admission)?;
    }
    let strict = thread.thread_extension_data().get::<StrictExecutorWrites>();
    if (strict.is_some()
        || state.engine.local_checklist_store.is_some()
        || state.engine.saved_login_file.is_some())
        && p.thread_settings
            .environments
            .as_ref()
            .is_some_and(|selection| !selection.environments.is_empty())
    {
        return Err(pre_admission(anyhow::anyhow!(
            "native executor overrides cannot replace trusted environment policy"
        )));
    }
    let has_selection = selection.is_some();
    let mut turn_init = if let Some(selection) = selection {
        if !matches!(p.mode, Mode::StartIfIdle) {
            return Err(pre_admission(anyhow::anyhow!(
                "Selection applies only to new roots"
            )));
        }
        let tools = thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
            .context("Selection requires managed tools")
            .map_err(pre_admission)?;
        tools
            .validate_operation(&selection)
            .map_err(pre_admission)?;
        let mut init = thread.config_snapshot().await.turn_extension_init;
        init.insert(Some(selection));
        Some(init)
    } else {
        None
    };
    if matches!(p.mode, Mode::StartIfIdle) {
        let init = turn_init.get_or_insert(thread.config_snapshot().await.turn_extension_init);
        if !has_selection {
            init.insert(None::<crate::python_tools::OperationSelection>);
        }
        init.insert(if p.raise_on_unknown_tool == Some(true) {
            codex_extension_api::ToolNotFoundBehavior::RaiseError
        } else {
            codex_extension_api::ToolNotFoundBehavior::ReturnErrorToModel
        });
    }
    if matches!(p.mode, Mode::ContinueIfIdle) {
        if p.writable_roots.is_some() {
            return Err(pre_admission(anyhow::anyhow!(
                "Writable roots require a new root turn"
            )));
        }
        return continue_managed(state, &mut mutation, p).await;
    }
    if !(matches!(p.mode, Mode::StartIfIdle | Mode::StartOrSteer | Mode::Steer)
        && p.input.is_array()
        && p.start.parent_turn_id.is_none()
        && p.start.root_turn_id.is_none()
        && p.thread_settings.effort != Some(Some(ReasoningEffort::Persistent))
        && !p
            .thread_settings
            .collaboration_mode
            .as_ref()
            .is_some_and(|mode| mode.reasoning_effort() == Some(ReasoningEffort::Persistent)))
    {
        return Err(pre_admission(anyhow::anyhow!(
            "replaceable tools support ordinary submit/steer only, without persistent execution"
        )));
    }
    let next_strict = if let Some(roots) = p.writable_roots.take() {
        let strict = strict
            .filter(|_| matches!(p.mode, Mode::StartIfIdle))
            .ok_or_else(|| {
                pre_admission(anyhow::anyhow!(
                    "Writable roots require a new root and a strict Session Environment"
                ))
            })?;
        let (selection, next_strict) = prepare_write_selection(state, &strict, roots)
            .await
            .map_err(pre_admission)?;
        p.thread_settings.environments = Some(selection);
        Some(next_strict)
    } else {
        None
    };
    let result = start_with_params(thread, p, turn_init, Some((state, &mut mutation))).await?;
    if let Some(strict) = next_strict
        && result["status"] == "started"
    {
        // Keep the old grants if Core declined to start the turn.
        thread.thread_extension_data().insert(strict);
    }
    Ok(result)
}

params!(RealtimeToolSubmission {
    generation: String,
    response_id: String,
    #[serde(default)]
    expected_root_turn_id: Option<String>,
    call_ids: Vec<String>,
    #[serde(default)]
    disabled_call_ids: Vec<String>,
    observation_submission_id: Option<String>,
    trace: Option<W3cTraceContext>
});

pub(crate) async fn submit_realtime_tools(
    state: &crate::engine::ThreadState,
    mut value: Value,
) -> Result<Value> {
    if let Some(receipt) = prepare_submission_trace(&mut value)? {
        return Ok(receipt);
    }
    let mut mutation = Some(state.mutations.lock().await);
    crate::graph_stop::check_after_wait(state, &value)?;
    let p: RealtimeToolSubmission = decode(value).map_err(pre_admission)?;
    state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
        .context("Realtime tool submission requires a managed tool session")
        .map_err(pre_admission)?;
    if let Some(expected_root_turn_id) = p.expected_root_turn_id {
        // Attachment owns work on the existing root. It must not reopen the
        // graph or seed a replacement turn/admission receipt.
        let result = state
            .thread
            .attach_realtime_tools_if_owned_with_policy(
                p.generation,
                p.response_id,
                p.call_ids,
                p.disabled_call_ids,
                expected_root_turn_id.clone(),
                p.trace,
            )
            .await?;
        return realtime_attachment(result, &expected_root_turn_id);
    }
    let mut init = state.thread.config_snapshot().await.turn_extension_init;
    init.insert(None::<crate::python_tools::OperationSelection>);
    if let Some(submission) = p.observation_submission_id {
        state
            .request_metadata
            .seed(&mut init, submission, state.id.to_string());
    }
    Ok(idle_submission(
        crate::turn_settlement::start_realtime(
            state,
            &mut mutation,
            p.generation,
            p.response_id,
            p.call_ids,
            p.disabled_call_ids,
            p.trace,
            init,
        )
        .await?,
    ))
}

fn realtime_attachment(result: TurnInputSubmission, expected_root_turn_id: &str) -> Result<Value> {
    match result {
        TurnInputSubmission::Steered { turn_id } => {
            anyhow::ensure!(
                turn_id == expected_root_turn_id,
                "Realtime attachment root changed"
            );
            Ok(json!({"status":"attached","root_turn_id":turn_id}))
        }
        TurnInputSubmission::NotSubmitted { reason } => Ok(rejection(reason)),
        TurnInputSubmission::Started { .. } => {
            bail!("Realtime attachment created an unexpected root")
        }
    }
}

async fn prepare_write_selection(
    state: &crate::engine::ThreadState,
    strict: &StrictExecutorWrites,
    roots: Vec<PathUri>,
) -> Result<(TurnEnvironmentSelections, StrictExecutorWrites)> {
    let thread = &state.thread;
    let current = thread.environment_selections().await;
    let [selection] = current.as_slice() else {
        bail!("Writable roots require one selected native Environment");
    };
    let config = thread.config().await;
    let (replacement, strict) = crate::environment::replace_writable_roots(
        selection,
        &config,
        &state.engine.manager.environment_manager(),
        strict,
        roots,
        state.engine.local_private_paths(),
    )
    .await?;
    if selection.environment_id == codex_exec_server::LOCAL_ENVIRONMENT_ID
        && let Some(store) = &state.engine.local_checklist_store
    {
        let path = store.live_rollout_path(state.id).await?;
        strict.check_local_rollout_path(&path).await?;
    }
    if selection != &replacement {
        let descendants = state
            .engine
            .manager
            .list_agent_subtree_thread_ids(state.id)
            .await?;
        anyhow::ensure!(
            descendants.iter().all(|id| *id == state.id)
                && thread.active_turn_environment_selections().await.is_none()
                && thread.list_background_terminals().await.is_empty()
                && !thread
                    .thread_extension_data()
                    .get::<crate::native_interception::Control>()
                    .is_some_and(|control| control.has_unsettled_code_cells()),
            "Cannot change writable roots while earlier executor work or descendants are retained"
        );
    }
    Ok((
        TurnEnvironmentSelections::new(
            thread.config_snapshot().await.cwd().clone(),
            vec![replacement],
        ),
        strict,
    ))
}

// Called only from the private SDK submit route after decoded Session options.
async fn continue_managed<'a>(
    state: &'a crate::engine::ThreadState,
    mutation: &mut Option<tokio::sync::MutexGuard<'a, ()>>,
    mut p: TurnParams,
) -> Result<Value> {
    if !(state.instructions.managed()
        && p.input.as_array().is_some_and(Vec::is_empty)
        && p.expected_turn_id.is_none()
        && p.start.parent_turn_id.is_none()
        && p.start.root_turn_id.is_none())
    {
        return Err(pre_admission(anyhow::anyhow!(
            "continuation requires a settled SDK turn"
        )));
    }
    let previous_id = p
        .expected_previous_turn_id
        .context("continuation requires previous turn ID")
        .map_err(pre_admission)?;
    // Only the successfully settled previous turn can authorize continuation.
    let settlement = state
        .thread
        .thread_extension_data()
        .get_or_init(crate::turn_settlement::Settlement::default);
    if !crate::graph_stop::continuation_allowed(state) || !settlement.can_continue_id(&previous_id)
    {
        return Ok(rejection(NotSubmittedReason::Superseded));
    }
    let mut init = state.thread.config_snapshot().await.turn_extension_init;
    let mut selection = None;
    if let Some(tools) = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
    {
        selection = tools.continuation_selection(&previous_id);
        if let Some(selection) = &selection {
            tools.validate_operation(selection).map_err(pre_admission)?;
        }
    }
    state
        .thread
        .flush_rollout()
        .await
        .map_err(|error| pre_admission(error.into()))?;
    let history = state
        .engine
        .load_checkpoint_history(state.id)
        .await
        .map_err(|error| pre_admission(error.into()))?;
    let raise_on_unknown_tool = matches!(
        codex_extension_api::ToolNotFoundBehavior::from_turn_history(&history, &previous_id)
            .map_err(|error| pre_admission(anyhow::anyhow!(error)))?,
        Some(codex_extension_api::ToolNotFoundBehavior::RaiseError)
    );
    init.insert(if raise_on_unknown_tool {
        codex_extension_api::ToolNotFoundBehavior::RaiseError
    } else {
        codex_extension_api::ToolNotFoundBehavior::ReturnErrorToModel
    });
    let retained_model = selection
        .as_ref()
        .and_then(|selection| selection.model_override.clone());
    ensure!(
        p.start.model_override.is_none() || p.start.model_override == retained_model,
        "continuation cannot replace the admitted run model"
    );
    p.start.model_override = retained_model;
    let retained_settings = selection
        .as_ref()
        .and_then(|selection| selection.model_settings_override.clone());
    ensure!(
        p.start.model_settings_override.is_none()
            || p.start.model_settings_override == retained_settings,
        "continuation cannot replace the admitted run model settings"
    );
    p.start.model_settings_override = retained_settings;
    init.insert(selection);
    init.insert(codex_extension_api::AgentProfileOutputControl {
        thread_id: state.id.to_string(),
        preserve_turn_output: p.profile_output_override,
    });
    if let Some(submission) = p.observation_submission_id {
        state
            .request_metadata
            .seed(&mut init, submission, state.id.to_string());
    }
    let value = submission(
        crate::turn_settlement::continue_retained(
            state,
            mutation,
            &previous_id,
            p.trace,
            p.start,
            init,
        )
        .await?,
    );
    Ok(value)
}

pub async fn recover_prepared(
    state: &crate::engine::ThreadState,
    turn_id: String,
    original_call_ids: Vec<String>,
    thread_settings: ThreadSettingsOverrides,
    final_output_json_schema: Option<Value>,
    model_override: Option<String>,
    model_settings_override: Option<
        codex_protocol::model_request_controls::RunModelSettingsOverride,
    >,
    selection: Option<crate::python_tools::OperationSelection>,
    trace: Option<W3cTraceContext>,
    observation_submission_id: Option<String>,
    terminal: Option<crate::python_tools::RecoveredToolCompletionSeed>,
    staged_input: codex_extension_api::StagedInputBatch,
    raise_on_unknown_tool: bool,
    profile_output_override: bool,
) -> Result<Value> {
    let thread = &state.thread;
    let mut init = thread.config_snapshot().await.turn_extension_init;
    if let Some(submission) = observation_submission_id {
        state
            .request_metadata
            .seed(&mut init, submission, state.id.to_string());
    }
    init.insert(selection);
    init.insert(codex_extension_api::AgentProfileOutputControl {
        thread_id: state.id.to_string(),
        preserve_turn_output: profile_output_override,
    });
    init.insert(if raise_on_unknown_tool {
        codex_extension_api::ToolNotFoundBehavior::RaiseError
    } else {
        codex_extension_api::ToolNotFoundBehavior::ReturnErrorToModel
    });
    if let Some(terminal) = terminal {
        terminal.attach(&mut init);
    }
    init.insert(staged_input);
    crate::recovery_guard::Seed::attach(&mut init, &turn_id, original_call_ids);
    let value = idle_submission(
        thread
            .recover_turn_if_idle(WithTurnExtensionData::new(
                RecoverTurnRequest {
                    model_override,
                    model_settings_override,
                    turn_id: turn_id.clone(),
                    thread_settings,
                    final_output_json_schema,
                    trace,
                    cyber_access_program: None,
                },
                init,
            ))
            .await?,
    );
    Ok(value)
}

/// Validate before invalidating; invalid arguments must not strand a live hold.
/// Caller owns ThreadState.mutations through enqueueing.

async fn start_with_params<'a>(
    thread: &CodexThread,
    p: TurnParams,
    turn_init: Option<ExtensionDataInit>,
    managed: Option<(
        &'a crate::engine::ThreadState,
        &mut Option<tokio::sync::MutexGuard<'a, ()>>,
    )>,
) -> Result<Value> {
    if p.exact_steering && !matches!(p.mode, Mode::Steer) {
        return Err(pre_admission(anyhow::anyhow!(
            "exact_steering requires steer mode"
        )));
    }

    let turn_init = if let (Some((state, _)), Some(submission)) =
        (managed.as_ref(), p.observation_submission_id)
    {
        let mut init = match turn_init {
            Some(init) => init,
            None => {
                // Making metadata explicit must preserve the ordinary-root reset.
                let mut init = thread.config_snapshot().await.turn_extension_init;
                init.insert(None::<crate::python_tools::OperationSelection>);
                init
            }
        };
        state
            .request_metadata
            .seed(&mut init, submission, state.id.to_string());
        Some(init)
    } else {
        turn_init
    };
    let turn_init = if let Some((state, _)) = managed.as_ref() {
        if matches!(p.mode, Mode::Steer) {
            turn_init
        } else {
            let mut init = match turn_init {
                Some(init) => init,
                None => {
                    let mut init = thread.config_snapshot().await.turn_extension_init;
                    init.insert(None::<crate::python_tools::OperationSelection>);
                    init
                }
            };
            init.insert(codex_extension_api::AgentProfileOutputControl {
                thread_id: state.id.to_string(),
                preserve_turn_output: p.profile_output_override,
            });
            Some(init)
        }
    } else {
        turn_init
    };
    let mut prompt_cache_breakpoints = Vec::new();
    let input = if p.input.is_array() {
        let captured = decode::<Vec<codex_protocol::prompt_cache::PromptCacheUserInput>>(p.input).map_err(pre_admission)?;
        let (content, breakpoints) = codex_protocol::prompt_cache::split_user_input(captured);
        prompt_cache_breakpoints = breakpoints;
        TurnInput::UserInput {
            content,
            client_id: p.client_id,
        }
    } else {
        if p.client_id.is_some() {
            return Err(pre_admission(anyhow::anyhow!(
                "client_id must be inside native TurnInput when input is not a list"
            )));
        }
        decode::<TurnInput>(p.input).map_err(pre_admission)?
    };
    let mut request = TurnInputRequest {
        input,
        prompt_cache_breakpoints,
        thread_settings: p.thread_settings,
        start: p.start,
        additional_context: p
            .additional_context
            .into_iter()
            .map(|(key, entry)| {
                (
                    key,
                    AdditionalContextEntry {
                        value: entry.value,
                        kind: match entry.kind {
                            ContextKind::Untrusted => AdditionalContextKind::Untrusted,
                            ContextKind::Application => AdditionalContextKind::Application,
                        },
                    },
                )
            })
            .collect(),
        responsesapi_client_metadata: p.responsesapi_client_metadata,
        trace: p.trace,
    };
    match p.mode {
        Mode::StartIfIdle | Mode::StartOrSteer
            if p.expected_turn_id.is_some() || p.expected_previous_turn_id.is_some() =>
        {
            Err(pre_admission(anyhow::anyhow!(
                "expected turn IDs require steer or continue_if_idle mode"
            )))
        }
        Mode::StartIfIdle | Mode::StartOrSteer => {
            let init = match turn_init {
                Some(init) => init,
                None => {
                    // Core retains turn initializers. A new ordinary root must
                    // clear the previous operation without changing other data.
                    let mut init = thread.config_snapshot().await.turn_extension_init;
                    init.insert(None::<crate::python_tools::OperationSelection>);
                    init
                }
            };
            if matches!(p.mode, Mode::StartIfIdle) {
                if let Some((state, mutation)) = managed {
                    return Ok(idle_submission(
                        crate::turn_settlement::start(state, mutation, request, init).await?,
                    ));
                }
                Ok(idle_submission(
                    thread
                        .start_turn_if_idle(WithTurnExtensionData::new(request, init))
                        .await?,
                ))
            } else {
                Ok(submission(
                    thread
                        .start_or_steer_turn(WithTurnExtensionData::new(request, init))
                        .await?,
                ))
            }
        }
        Mode::ContinueIfIdle => {
            if p.expected_turn_id.is_some() {
                return Err(pre_admission(anyhow::anyhow!(
                    "expected_turn_id is only valid in steer mode"
                )));
            }
            let previous_id = p
                .expected_previous_turn_id
                .context("continue_if_idle requires expected_previous_turn_id")
                .map_err(pre_admission)?;
            Ok(submission(
                thread.continue_turn_if_idle(request, previous_id).await?,
            ))
        }
        Mode::Steer => {
            if p.expected_previous_turn_id.is_some() {
                return Err(pre_admission(anyhow::anyhow!(
                    "expected_previous_turn_id is only valid in continue_if_idle mode"
                )));
            }
            let expected = p
                .expected_turn_id
                .context("steer requires expected_turn_id")
                .map_err(pre_admission)?;
            let reserved = if let TurnInput::UserInput { client_id, .. } = &mut request.input {
                thread
                    .thread_extension_data()
                    .get::<crate::turn_settlement::Settlement>()
                    .and_then(|settlement| settlement.matching(&expected))
                    .and_then(|turn| {
                        turn.reserve_steering().map(|id| {
                            *client_id = Some(id.clone());
                            (turn, id)
                        })
                    })
            } else {
                None
            };
            if p.exact_steering && reserved.is_none() {
                return Ok(rejection(NotSubmittedReason::NoActiveTurn));
            }
            // Core can complete an accepted item before this await returns.
            // Rejections and dispatch errors must remove only their unused ID.
            let result = thread.steer_turn(request, expected).await;
            if !matches!(&result, Ok(SteerSubmission::Steered { .. }))
                && let Some((turn, id)) = &reserved
            {
                turn.discard_steering(id);
            }
            Ok(match result? {
                SteerSubmission::Steered { turn_id } if p.exact_steering => {
                    let (_, input_id) = reserved.expect("exact steering reserved an input ID");
                    json!({"status": "steered", "turn_id": turn_id, "input_id": input_id})
                }
                SteerSubmission::Steered { turn_id } => {
                    json!({"status": "steered", "turn_id": turn_id})
                }
                SteerSubmission::NotSubmitted { reason } => rejection(reason),
            })
        }
    }
}

pub async fn interrupt(thread: &CodexThread) -> Result<()> {
    thread.submit(Op::Interrupt).await?;
    Ok(())
}

pub async fn interrupt_if_no_pending_input(thread: &CodexThread, turn_id: String) -> Result<bool> {
    let (reply, result) = oneshot::channel();
    thread
        .submit(Op::InterruptIfNoPendingInput { turn_id, reply })
        .await?;
    Ok(result.await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum OnceApproval {
    AllowOnce,
    Deny,
}

impl OnceApproval {
    fn decision(self) -> ReviewDecision {
        match self {
            Self::AllowOnce => ReviewDecision::Approved,
            Self::Deny => ReviewDecision::Denied {
                rejection: "denied".to_owned(),
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum NativeQuestionResponse {
    ExecApproval {
        id: String,
        turn_id: String,
        decision: OnceApproval,
    },
    PatchApproval {
        id: String,
        decision: OnceApproval,
    },
    McpApproval {
        server_name: String,
        request_id: String,
        decision: OnceApproval,
    },
    DeclineElicitation {
        server_name: String,
        request_id: codex_protocol::mcp::RequestId,
    },
    AcceptUrlElicitation {
        server_name: String,
        request_id: codex_protocol::mcp::RequestId,
    },
    AcceptElicitation {
        server_name: String,
        request_id: codex_protocol::mcp::RequestId,
        content: serde_json::Map<String, serde_json::Value>,
    },
}

/// Decode only one-time approvals and structured elicitation replies; no raw Op surface.
pub(crate) fn native_question_response(source: &str) -> Result<Op> {
    use codex_protocol::approvals::ElicitationAction;
    use codex_protocol::mcp::RequestId;
    Ok(
        match serde_json::from_str::<NativeQuestionResponse>(source)? {
            NativeQuestionResponse::ExecApproval {
                id,
                turn_id,
                decision,
            } => {
                anyhow::ensure!(
                    !id.is_empty() && !turn_id.is_empty(),
                    "Missing approval identity"
                );
                Op::ExecApproval {
                    id,
                    turn_id: Some(turn_id),
                    decision: decision.decision(),
                }
            }
            NativeQuestionResponse::PatchApproval { id, decision } => {
                anyhow::ensure!(!id.is_empty(), "Missing approval identity");
                Op::PatchApproval {
                    id,
                    decision: decision.decision(),
                }
            }
            NativeQuestionResponse::McpApproval {
                server_name,
                request_id,
                decision,
            } => {
                anyhow::ensure!(
                    request_id.starts_with("mcp_tool_call_approval_") && !server_name.is_empty(),
                    "Unsupported MCP approval identity"
                );
                Op::ResolveElicitation {
                    server_name,
                    request_id: RequestId::String(request_id),
                    decision: match decision {
                        OnceApproval::AllowOnce => ElicitationAction::Accept,
                        OnceApproval::Deny => ElicitationAction::Decline,
                    },
                    content: None,
                    meta: None,
                }
            }
            NativeQuestionResponse::DeclineElicitation {
                server_name,
                request_id,
            } => {
                anyhow::ensure!(!server_name.is_empty(), "Missing elicitation server");
                Op::ResolveElicitation {
                    server_name,
                    request_id,
                    decision: ElicitationAction::Decline,
                    content: None,
                    meta: None,
                }
            }
            NativeQuestionResponse::AcceptUrlElicitation {
                server_name,
                request_id,
            } => {
                anyhow::ensure!(!server_name.is_empty(), "Missing elicitation server");
                anyhow::ensure!(
                    !matches!(&request_id, RequestId::String(id) if id.starts_with("mcp_tool_call_approval_")),
                    "MCP approvals require an approval response"
                );
                Op::ResolveElicitation {
                    server_name,
                    request_id,
                    decision: ElicitationAction::Accept,
                    content: None,
                    meta: None,
                }
            }
            NativeQuestionResponse::AcceptElicitation {
                server_name,
                request_id,
                content,
            } => {
                anyhow::ensure!(!server_name.is_empty(), "Missing elicitation server");
                // Approval content can select persistent decisions in Core. Keep those
                // requests on the closed, one-time McpApproval response path.
                anyhow::ensure!(
                    !matches!(&request_id, RequestId::String(id) if id.starts_with("mcp_tool_call_approval_")),
                    "MCP approvals require an approval response"
                );
                Op::ResolveElicitation {
                    server_name,
                    request_id,
                    decision: ElicitationAction::Accept,
                    content: Some(serde_json::Value::Object(content)),
                    meta: None,
                }
            }
        },
    )
}

pub(crate) fn native_question_is_url_consent(source: &str) -> Result<bool> {
    Ok(matches!(
        serde_json::from_str::<NativeQuestionResponse>(source)?,
        NativeQuestionResponse::AcceptUrlElicitation { .. }
    ))
}

pub(crate) fn native_url_question_response(source: &str) -> Result<Op> {
    anyhow::ensure!(
        matches!(
            serde_json::from_str::<NativeQuestionResponse>(source)?,
            NativeQuestionResponse::AcceptUrlElicitation { .. }
                | NativeQuestionResponse::DeclineElicitation { .. }
        ),
        "URL requests require URL consent or refusal"
    );
    native_question_response(source)
}

/// Uncaptured requests may be retired, but can never grant action authority.
pub(crate) fn native_question_retirement(source: &str) -> Result<Op> {
    let operation = native_question_response(source)?;
    anyhow::ensure!(
        matches!(
            &operation,
            Op::ExecApproval {
                decision: ReviewDecision::Denied { .. },
                ..
            } | Op::PatchApproval {
                decision: ReviewDecision::Denied { .. },
                ..
            } | Op::ResolveElicitation {
                decision: codex_protocol::approvals::ElicitationAction::Decline,
                content: None,
                meta: None,
                ..
            }
        ),
        "Positive native replies require a captured question"
    );
    Ok(operation)
}

#[cfg(test)]
mod native_question_tests {
    use super::*;

    #[test]
    fn uncaptured_requests_allow_only_negative_retirement() {
        for response in [
            r#"{"kind":"exec_approval","id":"callback","turn_id":"turn","decision":"deny"}"#,
            r#"{"kind":"patch_approval","id":"callback","decision":"deny"}"#,
            r#"{"kind":"mcp_approval","server_name":"records","request_id":"mcp_tool_call_approval_call","decision":"deny"}"#,
            r#"{"kind":"decline_elicitation","server_name":"records","request_id":9007199254740993}"#,
        ] {
            assert!(native_question_retirement(response).is_ok());
        }
        for response in [
            r#"{"kind":"exec_approval","id":"callback","turn_id":"turn","decision":"allow_once"}"#,
            r#"{"kind":"patch_approval","id":"callback","decision":"allow_once"}"#,
            r#"{"kind":"mcp_approval","server_name":"records","request_id":"mcp_tool_call_approval_call","decision":"allow_once"}"#,
            r#"{"kind":"accept_elicitation","server_name":"records","request_id":9007199254740993,"content":{}}"#,
        ] {
            assert!(native_question_retirement(response).is_err());
        }
    }

    #[test]
    fn decisions_are_one_time_and_fields_are_closed() {
        assert!(matches!(native_question_response(r#"{"kind":"exec_approval","id":"callback","turn_id":"turn","decision":"allow_once"}"#).unwrap(), Op::ExecApproval { decision: ReviewDecision::Approved, .. }));
        for extra in [
            r#""decision":"allow_always""#,
            r#""decision":"allow_once","persist":true"#,
        ] {
            let input =
                format!(r#"{{"kind":"exec_approval","id":"callback","turn_id":"turn",{extra}}}"#);
            assert!(native_question_response(&input).is_err());
        }
        assert!(native_question_response(r#"{"kind":"mcp_approval","server_name":"records","request_id":"unbound","decision":"allow_once"}"#).is_err());
    }

    #[test]
    fn decline_keeps_numeric_and_string_request_ids_distinct() {
        for id in ["9007199254740993", "\"9007199254740993\""] {
            let input = format!(
                r#"{{"kind":"decline_elicitation","server_name":"records","request_id":{id}}}"#
            );
            let Op::ResolveElicitation {
                request_id,
                content,
                meta,
                ..
            } = native_question_response(&input).unwrap()
            else {
                panic!("wrong reply kind")
            };
            assert_eq!(serde_json::to_string(&request_id).unwrap(), id);
            assert!(content.is_none() && meta.is_none());
        }
    }

    #[test]
    fn accept_preserves_object_content_and_exact_request_ids() {
        for id in ["9007199254740993", "\"9007199254740993\""] {
            let input = format!(
                r#"{{"kind":"accept_elicitation","server_name":"records","request_id":{id},"content":{{"name":"Ada","count":2,"enabled":true,"choices":["a","b"]}}}}"#
            );
            let Op::ResolveElicitation {
                server_name,
                request_id,
                decision,
                content,
                meta,
            } = native_question_response(&input).unwrap()
            else {
                panic!("wrong reply kind")
            };
            assert_eq!(server_name, "records");
            assert_eq!(serde_json::to_string(&request_id).unwrap(), id);
            assert!(matches!(
                decision,
                codex_protocol::approvals::ElicitationAction::Accept
            ));
            assert_eq!(
                content,
                Some(serde_json::json!({
                    "name": "Ada",
                    "count": 2,
                    "enabled": true,
                    "choices": ["a", "b"]
                }))
            );
            assert!(meta.is_none());
        }
    }

    #[test]
    fn accept_requires_an_object_and_closed_response_fields() {
        for content in ["null", "[]", "true", "12", r#""text""#] {
            let input = format!(
                r#"{{"kind":"accept_elicitation","server_name":"records","request_id":1,"content":{content}}}"#
            );
            assert!(native_question_response(&input).is_err());
        }
        assert!(
            native_question_response(
                r#"{"kind":"accept_elicitation","server_name":"records","request_id":1}"#
            )
            .is_err()
        );
        assert!(
            native_question_response(
                r#"{"kind":"accept_elicitation","server_name":"","request_id":1,"content":{}}"#
            )
            .is_err()
        );
        for extra in [
            r#""meta":{}"#,
            r#""decision":"allow_always""#,
            r#""persist":true"#,
            r#""op":"resolve_elicitation""#,
        ] {
            let input = format!(
                r#"{{"kind":"accept_elicitation","server_name":"records","request_id":1,"content":{{}},{extra}}}"#
            );
            assert!(native_question_response(&input).is_err());
        }
    }

    #[test]
    fn accept_cannot_carry_mcp_approval_content() {
        assert!(native_question_response(r#"{"kind":"accept_elicitation","server_name":"records","request_id":"mcp_tool_call_approval_call","content":{"mcp_tool_call_approval_call":"Allow for this session"}}"#).is_err());
        assert!(native_question_response(r#"{"kind":"accept_elicitation","server_name":"records","request_id":"mcp_tool_call_approval","content":{}}"#).is_ok());
        assert!(matches!(native_question_response(r#"{"kind":"mcp_approval","server_name":"records","request_id":"mcp_tool_call_approval_call","decision":"allow_once"}"#).unwrap(), Op::ResolveElicitation { content: None, meta: None, .. }));
    }
}

params!(RealtimeSdkGeneration { generation: String });
params!(RealtimeSdkEvent {
    generation: String,
    event: Value
});
params!(RealtimeSdkResponse {
    generation: String,
    #[serde(default)]
    response: codex_protocol::realtime_settings::RealtimeResponseOptions,
});
fn realtime_auto_response_default() -> bool {
    true
}
params!(RealtimeSdkHostedMcpApproval {
    generation: String,
    approval_id: String,
    approve: bool,
    #[serde(default)]
    reason: Option<String>
});
params!(RealtimeSdkStart {
    generation: String,
    params: RealtimeStart,
    settings: Option<codex_protocol::realtime_settings::RealtimeV2SessionSettings>,
    #[serde(default)]
    function_tools: Option<Vec<codex_protocol::dynamic_tools::DynamicToolFunctionSpec>>,
    #[serde(default)]
    expected_selection_id: Option<String>,
    #[serde(default)]
    disabled_tool_names: Option<Vec<String>>,
    #[serde(default = "realtime_auto_response_default")]
    hosted_mcp_auto_response: bool,
    #[serde(default)]
    include_raw_provider_events: bool
});
params!(RealtimeSdkConfig {
    params: RealtimeStart,
    settings: Option<codex_protocol::realtime_settings::RealtimeV2SessionSettings>,
    #[serde(default)]
    function_tools: Option<Vec<codex_protocol::dynamic_tools::DynamicToolFunctionSpec>>,
    #[serde(default)]
    expected_selection_id: Option<String>,
    #[serde(default)]
    disabled_tool_names: Option<Vec<String>>
});
pub(crate) async fn prepare_realtime(
    thread: &CodexThread,
    params: Value,
    adapter: Option<std::sync::Arc<dyn codex_api::RealtimeAdapter>>,
) -> Result<Value> {
    let p: RealtimeSdkStart = decode(params)?;
    let mut init = ExtensionDataInit::new();
    if let Some(adapter) = adapter {
        init.insert(adapter);
    }
    let (reply, result) = oneshot::channel();
    thread
        .submit(WithTurnExtensionData::new(
            Op::RealtimeConversationPrepareSdk {
                generation: p.generation,
                params: p.params.into(),
                settings: p.settings,
                function_tools: realtime_function_tools(p.function_tools),
                expected_selection_id: p.expected_selection_id,
                disabled_tool_names: p.disabled_tool_names,
                hosted_mcp_auto_response: p.hosted_mcp_auto_response,
                provider_event_observation: if p.include_raw_provider_events {
                    codex_protocol::protocol::RealtimeProviderEventObservation::All
                } else {
                    codex_protocol::protocol::RealtimeProviderEventObservation::History
                },
                reply,
            },
            init,
        ))
        .await?;
    Ok(serde_json::to_value(result.await??)?)
}
params!(RealtimeSdkActivate {
    generation: String,
    api_key: Option<String>,
    #[serde(default)]
    connection_options: RealtimeConversationConnectionOptions,
});
params!(RealtimeSdkUpdate {
    generation: String,
    update: codex_protocol::realtime_settings::RealtimeSessionUpdate,
    #[serde(default)]
    profile: Option<RealtimeSdkProfileUpdate>
});
params!(RealtimeSdkProfileUpdate {
    #[serde(default)]
    response_id: Option<String>,
    #[serde(default)]
    delegation_id: Option<String>,
    #[serde(default)]
    target: Option<codex_protocol::agent_profile::AgentProfileReceipt>,
    #[serde(default)]
    function_tools: Option<Vec<codex_protocol::dynamic_tools::DynamicToolFunctionSpec>>,
    #[serde(default)]
    expected_selection_id: Option<String>,
    #[serde(default)]
    disabled_tool_names: Option<Vec<String>>
});
impl From<RealtimeSdkProfileUpdate>
    for codex_protocol::realtime_settings::RealtimeToolProfileUpdate
{
    fn from(value: RealtimeSdkProfileUpdate) -> Self {
        Self {
            response_id: value.response_id,
            delegation_id: value.delegation_id,
            target: value.target,
            function_tools: realtime_function_tools(value.function_tools),
            expected_selection_id: value.expected_selection_id,
            disabled_tool_names: value.disabled_tool_names,
        }
    }
}

fn realtime_function_tools(
    definitions: Option<Vec<codex_protocol::dynamic_tools::DynamicToolFunctionSpec>>,
) -> Option<Vec<codex_protocol::realtime_settings::RealtimeFunctionTool>> {
    definitions.map(|definitions| {
        definitions
            .into_iter()
            .map(|definition| {
                codex_protocol::realtime_settings::RealtimeFunctionTool {
                    name: definition.name,
                    description: Some(definition.description),
                    parameters: definition.input_schema,
                    // The captured source owns the actual provider strictness.
                    strict: None,
                }
            })
            .collect()
    })
}
params!(RealtimeSdkAudio {
    generation: String,
    frame: RealtimeAudioFrame
});
params!(RealtimeSdkHistory {
    generation: String,
    items: Vec<Value>,
    #[serde(default)]
    expected_items: Option<Vec<Value>>,
});
params!(RealtimeSdkDeleteItem {
    generation: String,
    item_id: String
});
params!(RealtimeSdkInput {
    generation: String,
    content: Vec<codex_protocol::models::ContentItem>,
    #[serde(default = "realtime_auto_response_default")]
    trigger_response: bool
});
params!(RealtimeSdkText {
    generation: String,
    text: String,
    #[serde(default)]
    role: ConversationTextRole
});
params!(RealtimeSdkComplete {
    generation: String,
    handoff_id: String,
    text: String
});
params!(RealtimeSdkHandoff {
    generation: String,
    handoff_id: String
});
params!(RealtimeSdkInterrupt {
    generation: String,
    response_id: Option<String>,
    playback: Option<codex_protocol::protocol::RealtimePlaybackPosition>,
    feedback: Option<String>,
    cancel_tools: Option<bool>,
    owned_handoffs: Option<Vec<(String, Option<String>, String)>>
});
params!(RealtimeText {
    text: String,
    #[serde(default)]
    role: ConversationTextRole
});
impl From<RealtimeText> for ConversationTextParams {
    fn from(p: RealtimeText) -> Self {
        Self {
            text: p.text,
            role: p.role,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum RealtimeTransport {
    Websocket,
    Webrtc {
        sdp: String,
    },
    ExistingCall {
        call_id: String,
        sideband_base_url: Option<String>,
    },
}

params!(RealtimeStart {
    client_managed_handoffs: bool,
    delegation_ack_filler: Option<bool>,
    flush_transcript_tail_on_session_end: bool,
    codex_responses_as_items: bool,
    codex_response_item_prefix: Option<String>,
    codex_response_handoff_mode: CodexResponseHandoffMode,
    backend_reasoning_status: bool,
    codex_response_handoff_channel_prefixes: Option<BTreeMap<String, Vec<String>>>,
    model: Option<String>,
    output_modality: RealtimeOutputModality,
    include_startup_context: bool,
    #[serde(default)] initial_items: Vec<RealtimeText>,
    realtime_start_instructions: Option<String>,
    realtime_end_instructions: Option<String>,
    #[serde(default, deserialize_with = "optional")] prompt: Option<Option<String>>,
    realtime_session_id: Option<String>,
    transport: Option<RealtimeTransport>,
    version: Option<RealtimeConversationVersion>,
    voice: Option<RealtimeVoice>,
});

impl From<RealtimeStart> for ConversationStartParams {
    fn from(p: RealtimeStart) -> Self {
        Self {
            client_managed_handoffs: p.client_managed_handoffs,
            delegation_ack_filler: p.delegation_ack_filler,
            flush_transcript_tail_on_session_end: p.flush_transcript_tail_on_session_end,
            codex_responses_as_items: p.codex_responses_as_items,
            codex_response_item_prefix: p.codex_response_item_prefix,
            codex_response_handoff_mode: p.codex_response_handoff_mode,
            backend_reasoning_status: p.backend_reasoning_status,
            codex_response_handoff_channel_prefixes: p.codex_response_handoff_channel_prefixes,
            model: p.model,
            output_modality: p.output_modality,
            include_startup_context: p.include_startup_context,
            initial_items: p.initial_items.into_iter().map(Into::into).collect(),
            realtime_start_instructions: p.realtime_start_instructions,
            realtime_end_instructions: p.realtime_end_instructions,
            prompt: p.prompt,
            realtime_session_id: p.realtime_session_id,
            transport: p.transport.map(|t| match t {
                RealtimeTransport::Websocket => ConversationStartTransport::Websocket,
                RealtimeTransport::Webrtc { sdp } => ConversationStartTransport::Webrtc { sdp },
                RealtimeTransport::ExistingCall {
                    call_id,
                    sideband_base_url,
                } => ConversationStartTransport::ExistingCall {
                    call_id,
                    sideband_base_url,
                },
            }),
            version: p.version,
            voice: p.voice,
        }
    }
}

/// Acknowledged media commands for the matching SDK-owned Realtime generation.
pub async fn realtime_sdk(thread: &CodexThread, operation: &str, params: Value) -> Result<Value> {
    if operation == "realtime_tool_selection_sdk" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SelectionParams {
            #[serde(default)]
            mcp_policy: Option<crate::native_interception::RealtimeMcpPolicy>,
        }
        let params: SelectionParams = decode(params)?;
        if let Some(policy) = params.mcp_policy {
            thread.thread_extension_data().insert(policy);
        }
        let tools = thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
            .context("Realtime tool selection requires a managed Session")?;
        return tools.realtime_tool_selection(thread).await;
    }
    if operation == "realtime_conversation_start_sdk" {
        let p: RealtimeSdkStart = decode(params)?;
        let function_tools = realtime_function_tools(p.function_tools);
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationStartSdk {
                generation: p.generation,
                params: p.params.into(),
                settings: p.settings,
                function_tools,
                expected_selection_id: p.expected_selection_id,
                disabled_tool_names: p.disabled_tool_names,
                hosted_mcp_auto_response: p.hosted_mcp_auto_response,
                reply,
            })
            .await?;
        return Ok(serde_json::to_value(result.await??)?);
    }
    if operation == "realtime_conversation_send_event_sdk" {
        let p: RealtimeSdkEvent = decode(params)?;
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationSendEventSdk {
                generation: p.generation,
                event: p.event,
                reply,
            })
            .await?;
        return Ok(serde_json::to_value(result.await??)?);
    }
    if operation == "realtime_conversation_update_history_sdk" {
        let p: RealtimeSdkHistory = decode(params)?;
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationUpdateHistorySdk {
                generation: p.generation,
                items: p.items,
                expected_items: p.expected_items,
                reply,
            })
            .await?;
        return Ok(serde_json::to_value(result.await??)?);
    }
    if operation == "realtime_conversation_retrieve_item_sdk" {
        let p: RealtimeSdkDeleteItem = decode(params)?;
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationRetrieveItemSdk {
                generation: p.generation,
                item_id: p.item_id,
                reply,
            })
            .await?;
        return Ok(serde_json::to_value(result.await??)?);
    }
    if operation == "realtime_conversation_retrieve_history_sdk" {
        let p: RealtimeSdkGeneration = decode(params)?;
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationRetrieveHistorySdk {
                generation: p.generation,
                reply,
            })
            .await?;
        return Ok(serde_json::to_value(result.await??)?);
    }
    if operation == "realtime_conversation_config_sdk" {
        let p: RealtimeSdkConfig = decode(params)?;
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationConfigSdk {
                params: p.params.into(),
                settings: p.settings,
                function_tools: realtime_function_tools(p.function_tools),
                expected_selection_id: p.expected_selection_id,
                disabled_tool_names: p.disabled_tool_names,
                reply,
            })
            .await?;
        return Ok(result.await??);
    }
    if operation == "realtime_conversation_prepare_sdk" {
        let p: RealtimeSdkStart = decode(params)?;
        let function_tools = realtime_function_tools(p.function_tools);
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationPrepareSdk {
                generation: p.generation,
                params: p.params.into(),
                settings: p.settings,
                function_tools,
                expected_selection_id: p.expected_selection_id,
                disabled_tool_names: p.disabled_tool_names,
                hosted_mcp_auto_response: p.hosted_mcp_auto_response,
                provider_event_observation: if p.include_raw_provider_events {
                    codex_protocol::protocol::RealtimeProviderEventObservation::All
                } else {
                    codex_protocol::protocol::RealtimeProviderEventObservation::History
                },
                reply,
            })
            .await?;
        return Ok(serde_json::to_value(result.await??)?);
    }
    if operation == "realtime_conversation_activate_sdk" {
        let p: RealtimeSdkActivate = decode(params)?;
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationActivateSdk {
                generation: p.generation,
                api_key: p.api_key.map(RealtimeConversationApiKey::new),
                connection_options: p.connection_options,
                reply,
            })
            .await?;
        return Ok(serde_json::to_value(result.await??)?);
    }
    if operation == "realtime_conversation_interrupt_sdk" {
        let p: RealtimeSdkInterrupt = decode(params)?;
        let (reply, result) = oneshot::channel();
        thread
            .submit(Op::RealtimeConversationInterruptSdk {
                generation: p.generation,
                response_id: p.response_id,
                playback: p.playback,
                feedback: p.feedback,
                cancel_tools: p.cancel_tools.unwrap_or(true),
                owned_handoffs: p.owned_handoffs.unwrap_or_default(),
                reply,
            })
            .await?;
        return Ok(serde_json::to_value(result.await??)?);
    }
    let (reply, result) = oneshot::channel();
    let operation = match operation {
        "realtime_conversation_hosted_mcp_approval_sdk" => {
            let p: RealtimeSdkHostedMcpApproval = decode(params)?;
            Op::RealtimeConversationHostedMcpApprovalSdk {
                generation: p.generation,
                approval_id: p.approval_id,
                approve: p.approve,
                reason: p.reason,
                reply,
            }
        }
        "realtime_conversation_update_sdk" => {
            let p: RealtimeSdkUpdate = decode(params)?;
            Op::RealtimeConversationUpdateSdk {
                generation: p.generation,
                update: p.update,
                profile: p.profile.map(Into::into),
                reply,
            }
        }
        "realtime_conversation_audio_sdk" => {
            let p: RealtimeSdkAudio = decode(params)?;
            Op::RealtimeConversationAudioSdk {
                generation: p.generation,
                params: ConversationAudioParams { frame: p.frame },
                reply,
            }
        }
        "realtime_conversation_audio_commit_sdk" => {
            let p: RealtimeSdkGeneration = decode(params)?;
            Op::RealtimeConversationAudioCommitSdk {
                generation: p.generation,
                reply,
            }
        }
        "realtime_conversation_delete_item_sdk" => {
            let p: RealtimeSdkDeleteItem = decode(params)?;
            Op::RealtimeConversationDeleteItemSdk {
                generation: p.generation,
                item_id: p.item_id,
                reply,
            }
        }
        "realtime_conversation_input_sdk" => {
            let p: RealtimeSdkInput = decode(params)?;
            Op::RealtimeConversationInputSdk {
                generation: p.generation,
                params: ConversationInputParams {
                    content: p.content,
                    trigger_response: p.trigger_response,
                },
                reply,
            }
        }
        "realtime_conversation_response_sdk" => {
            let p: RealtimeSdkResponse = decode(params)?;
            Op::RealtimeConversationResponseSdk {
                generation: p.generation,
                response: p.response,
                reply,
            }
        }
        "realtime_conversation_text_sdk" => {
            let p: RealtimeSdkText = decode(params)?;
            Op::RealtimeConversationTextSdk {
                generation: p.generation,
                params: ConversationTextParams {
                    text: p.text,
                    role: p.role,
                },
                reply,
            }
        }
        "realtime_conversation_complete_sdk" => {
            let p: RealtimeSdkComplete = decode(params)?;
            Op::RealtimeConversationCompleteSdk {
                generation: p.generation,
                handoff_id: p.handoff_id,
                text: p.text,
                reply,
            }
        }
        "realtime_conversation_fail_sdk" => {
            let p: RealtimeSdkHandoff = decode(params)?;
            Op::RealtimeConversationFailSdk {
                generation: p.generation,
                handoff_id: p.handoff_id,
                reply,
            }
        }
        "realtime_conversation_close_sdk" => {
            let p: RealtimeSdkGeneration = decode(params)?;
            Op::RealtimeConversationCloseSdk {
                generation: p.generation,
                reply,
            }
        }
        _ => bail!("Unknown private Realtime operation"),
    };
    let response_scoped = matches!(
        &operation,
        Op::RealtimeConversationUpdateSdk { profile: Some(profile), .. }
            if profile.response_id.is_some()
    );
    thread.submit(operation).await?;
    let outcome = result.await?;
    if response_scoped
        && matches!(
            &outcome,
            Err(error)
                if matches!(
                    error.details(),
                    codex_protocol::error::CodexErrorDetails::TurnAborted
                )
        )
    {
        return Ok(serde_json::json!({"applied": false}));
    }
    outcome?;
    Ok(Value::Null)
}

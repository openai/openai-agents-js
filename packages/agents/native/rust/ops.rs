//! JSON adapters for native operations that contain Rust-only channels or values.
use crate::config::{decode, optional};
use crate::environment::StrictExecutorWrites;
use anyhow::{Context, Result, bail};
use codex_core_api::{AbsolutePathBuf, CodexThread, WithTurnExtensionData};
use codex_extension_api::ExtensionDataInit;
use codex_protocol::config_types::{
    ApprovalsReviewer, CollaborationMode, Personality, ReasoningSummary, WindowsSandboxLevel,
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
            "model" | "effort" | "summary" | "service_tier" => {
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

pub async fn submit_replaceable(state: &crate::engine::ThreadState, value: Value) -> Result<Value> {
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
    let strict = thread.thread_extension_data().get::<StrictExecutorWrites>();
    if (strict.is_some() || state.engine.local_checklist_store.is_some())
        && p.thread_settings
            .environments
            .as_ref()
            .is_some_and(|selection| !selection.environments.is_empty())
    {
        return Err(pre_admission(anyhow::anyhow!(
            "native executor overrides cannot replace trusted environment policy"
        )));
    }
    let turn_init = if let Some(selection) = selection {
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
        state.engine.local_storage_home(),
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
    p: TurnParams,
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
    init.insert(selection);
    let value = submission(
        crate::turn_settlement::continue_retained(state, mutation, &previous_id, p.start, init)
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
    selection: Option<crate::python_tools::OperationSelection>,
    observation_submission_id: Option<String>,
) -> Result<Value> {
    let thread = &state.thread;
    let mut init = thread.config_snapshot().await.turn_extension_init;
    if let Some(submission) = observation_submission_id {
        state
            .request_metadata
            .seed(&mut init, submission, state.id.to_string());
    }
    init.insert(selection);
    crate::recovery_guard::Seed::attach(&mut init, &turn_id, original_call_ids);
    let value = idle_submission(
        thread
            .recover_turn_if_idle(WithTurnExtensionData::new(
                RecoverTurnRequest {
                    turn_id: turn_id.clone(),
                    thread_settings,
                    final_output_json_schema,
                    trace: None,
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
            None => thread.config_snapshot().await.turn_extension_init,
        };
        state
            .request_metadata
            .seed(&mut init, submission, state.id.to_string());
        Some(init)
    } else {
        turn_init
    };
    let input = if p.input.is_array() {
        TurnInput::UserInput {
            content: decode::<Vec<UserInput>>(p.input).map_err(pre_admission)?,
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

//! Captured Agent declarations; Core alone owns the committed active profile.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

use anyhow::{Context, Result, ensure};
use codex_core_api::{CodexThread, StartThreadOptions};
use codex_extension_api::{
    AgentProfile, AgentProfileActivation, AgentProfileBoundaryInput, AgentProfileEnvironment,
    AgentProfileExecutorTools, AgentProfileModelSettings, AgentProfileReceipt,
    CapturedAgentProfile, ExtensionData, ExtensionDataInit, ExtensionFuture, ToolContributor,
    TurnLifecycleContributor,
};
use codex_history::{ResponseItemEnvelope, RolloutItem};
use codex_protocol::dynamic_tools::{DynamicToolFunctionSpec, DynamicToolSpec};
use codex_protocol::model_request_transport::RequestTransportOverrides;
use codex_tools::{
    FunctionCallError, ToolCall, ToolExecutor, ToolExecutorFuture, ToolExposure, ToolExposures,
    ToolName, ToolOutput, ToolSpec, dynamic_tool_to_responses_api_tool,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::application_instructions::Accepted;
use crate::tool_callers::ToolDeclarations;
type InstructionFile = Value;
use crate::python_tools::{ProfileCatalog, PythonTools};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpeningProfiles {
    pub(crate) root_id: String,
    pub(crate) roster: Vec<ProfileSpec>,
    pub(crate) fingerprint: String,
    // Fresh presentation callbacks never participate in the effect-authority fingerprint.
    #[serde(default)]
    pub(crate) input_preparations: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProfileSpec {
    id: String,
    model: AgentProfileModelSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_provider_id: Option<String>,
    instructions: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    workspace_preparation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_instructions: Option<String>,
    tools: ToolDeclarations,
    #[serde(default)]
    manual_slots: Vec<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    terminal_slots: Vec<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    input_error_slots: Vec<usize>,
    #[serde(default)]
    step_defaults: Option<Vec<usize>>,
    #[serde(default)]
    handoffs: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    handoff_callbacks: BTreeMap<String, usize>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    decision_handoffs: BTreeMap<String, DecisionHandoffSpec>,
    #[serde(default)]
    transform_context: bool,
    #[serde(default)]
    before_compact: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    post_turn_compact: bool,
    #[serde(default)]
    before_complete: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    tool_batch_completion: bool,
    #[serde(default)]
    selecting_steps: bool,
    output_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wire_output_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    wire_output_plain: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wire_output_guidance: Option<String>,
    // Fresh SDK output guidance is not checkpoint data or declaration identity.
    #[serde(default, skip_serializing)]
    runtime_output_guidance: Option<String>,
    #[serde(default)]
    mcp_servers: BTreeMap<String, Value>,
    #[serde(default)]
    mcp_result_tools: BTreeMap<String, BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    mcp_metadata_tools: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    mcp_discovery_tools: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    mcp_tools: BTreeMap<String, McpToolDeclaration>,
    /// Trusted opening-only executor declaration supplied by the SDK.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    environment: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    environment_tools: Option<HashSet<String>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DecisionHandoffSpec {
    slot: usize,
    targets: Vec<String>,
}

/// A selection belongs only to the admitted callback executor and its wrapper.
pub(crate) struct DecisionHandoffSelection {
    targets: Vec<String>,
    selected: Mutex<HashMap<(String, String), String>>,
}

impl DecisionHandoffSelection {
    pub(crate) fn record(
        &self,
        turn: &str,
        call: &str,
        target: Option<String>,
        success: bool,
    ) -> Result<()> {
        if !success {
            ensure!(
                target.is_none(),
                "Failed Decision handoff cannot select a target"
            );
            return Ok(());
        }
        let target = target.context("Decision handoff requires a target")?;
        ensure!(
            self.targets.contains(&target),
            "Decision handoff target is outside its captured declaration"
        );
        let mut selected = self
            .selected
            .lock()
            .expect("Decision handoff selection poisoned");
        ensure!(
            !selected.contains_key(&(turn.into(), call.into())),
            "Repeated Decision handoff selection"
        );
        selected.insert((turn.into(), call.into()), target);
        Ok(())
    }

    fn take(&self, turn: &str, call: &str) -> Option<String> {
        self.selected
            .lock()
            .expect("Decision handoff selection poisoned")
            .remove(&(turn.into(), call.into()))
    }
}

pub(crate) fn decision_handoff_selection(
    thread: &ExtensionData,
    source: Option<&AgentProfileReceipt>,
    slot: usize,
) -> Option<Arc<DecisionHandoffSelection>> {
    let source = source?;
    let profiles = thread.get::<Arc<AgentProfiles>>()?;
    let profile = profiles.profiles.get(&source.profile_id)?;
    let declaration = profile
        .declaration
        .decision_handoffs
        .values()
        .find(|declaration| declaration.slot == slot)?;
    Some(Arc::new(DecisionHandoffSelection {
        targets: declaration.targets.clone(),
        selected: Mutex::new(HashMap::new()),
    }))
}

impl ProfileSpec {
    fn admits_handoff(&self, name: &ToolName, target: &str) -> bool {
        let name = name.clone().with_default_namespace();
        self.handoffs.iter().any(|(declared, destination)| {
            ToolName::new(None, declared.clone()).with_default_namespace() == name
                && destination == target
        }) || self
            .decision_handoffs
            .iter()
            .any(|(declared, declaration)| {
                ToolName::new(None, declared.clone()).with_default_namespace() == name
                    && declaration
                        .targets
                        .iter()
                        .any(|destination| destination == target)
            })
    }

    fn decision_tools(&self) -> codex_extension_api::AgentProfileDecisionHandoffTools {
        codex_extension_api::AgentProfileDecisionHandoffTools {
            targets: self
                .decision_handoffs
                .iter()
                .map(|(name, declaration)| {
                    (
                        ToolName::new(None, name.clone()).with_default_namespace(),
                        declaration.targets.clone(),
                    )
                })
                .collect(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct McpToolDeclaration {
    pub(crate) tools: Vec<String>,
    defer_loading: bool,
    #[serde(default)]
    pub(crate) before: bool,
    #[serde(default)]
    pub(crate) approval: bool,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspacePreparation {
    instructions: String,
    workspace_instructions: String,
}
#[derive(Clone)]
struct WorkspaceAppendix(String);

struct OpeningFiles(Vec<InstructionFile>);

pub(crate) struct PendingProviderKeys(pub(crate) BTreeMap<String, String>);

#[derive(Clone)]
pub(crate) struct ProfileProviders(
    pub(crate) BTreeMap<String, codex_core::SdkAgentProfileProvider>,
);

pub(crate) async fn bind_profile_providers(
    startup: &mut StartThreadOptions,
) -> Result<()> {
    let opening = startup.thread_extension_init.get::<OpeningProfiles>();
    let declared: HashSet<&str> = opening.iter().flat_map(|opening| {
        opening.roster.iter().filter_map(|profile| profile.native_provider_id.as_deref())
    }).collect();
    if let Some(bound) = startup.thread_extension_init.get::<ProfileProviders>() {
        ensure!(
            bound.0.len() == declared.len()
                && bound.0.keys().all(|id| declared.contains(id.as_str())),
            "Handoff provider authority differs from the current graph"
        );
        return Ok(());
    }
    let keys = startup.thread_extension_init.remove::<PendingProviderKeys>();
    let count = keys.as_ref().map_or(0, |keys| keys.0.len());
    ensure!(count == declared.len(), "Missing current handoff provider authority");
    let Some(keys) = keys else { return Ok(()); };
    ensure!(
        startup.config.sdk_provider_history.is_none(),
        "Distinct handoff providers require SDK-managed history"
    );
    let mut providers = BTreeMap::new();
    for (id, key) in &keys.0 {
        ensure!(declared.contains(id.as_str()), "Unexpected handoff provider authority");
        let info = startup.config.model_providers.get(id)
            .context("Missing current handoff provider configuration")?.clone();
        ensure!(
            info.requires_openai_auth && info.auth.is_none() && info.env_key.is_none()
                && info.experimental_bearer_token.is_none() && info.gateway_oauth.is_none()
                && !info.is_amazon_bedrock(),
            "Distinct handoff providers require captured API-key Responses authority"
        );
        let auth_manager = crate::auth::manager(&startup.config, Some(key.clone())).await?;
        providers.insert(id.clone(), codex_core::SdkAgentProfileProvider {
            id: Arc::from(id.as_str()),
            info,
            auth_manager,
        });
    }
    startup.thread_extension_init.insert(ProfileProviders(providers));
    Ok(())
}

fn insert_profile_provider(
    thread: &CodexThread,
    descriptor: &ProfileSpec,
    data: &mut ExtensionDataInit,
) -> Result<()> {
    if let Some(id) = &descriptor.native_provider_id {
        let providers = thread.thread_extension_data().get::<ProfileProviders>()
            .context("Missing current handoff provider authority")?;
        let provider = providers.0.get(id).context("Unknown current handoff provider")?;
        data.insert(provider.clone());
    }
    Ok(())
}

/// Private ready executor selections supplied by the current host graph.
pub(crate) struct ProfileEnvironments {
    profiles: BTreeMap<String, AgentProfileEnvironment>,
    _executor_owners: Vec<codex_exec_server::ScopedEnvironment>,
    pub(crate) default: AgentProfileEnvironment,
    pub(crate) digest: String,
    pub(crate) strict: bool,
}

impl ProfileEnvironments {
    fn selection(&self, profile_id: &str) -> Result<AgentProfileEnvironment> {
        self.profiles
            .get(profile_id)
            .cloned()
            .context("Agent has no admitted executor selection")
    }
}

fn environment_policy(
    environment: &AgentProfileEnvironment,
    config: &codex_core_api::Config,
    manager: &codex_core_api::EnvironmentManager,
) -> Result<Option<Value>> {
    let local_network = crate::environment::local_session_network_policy(config);
    environment
        .0
        .as_ref()
        .map(|selection| {
            let remote = manager
                .get_environment(&selection.environment_id)
                .context("selected executor was not registered")?
                .is_remote();
            let mut policy = codex_protocol::protocol::sdk_executor_policy_receipt(
                selection,
                remote,
                local_network.as_ref(),
            )
            .context("Agent executor policy is unavailable")?;
            // Native IDs are process-local routing keys. A fresh owner supplies
            // transport, credentials and an independently qualified selection.
            policy
                .as_object_mut()
                .expect("executor policy object")
                .remove("environment_id");
            Ok(policy)
        })
        .transpose()
}

pub(crate) async fn prepare_environments(
    engine: &crate::engine::EngineState,
    startup: &mut StartThreadOptions,
) -> Result<()> {
    let Some(opening) = startup.thread_extension_init.get::<OpeningProfiles>() else {
        return Ok(());
    };
    if opening
        .roster
        .iter()
        .all(|profile| profile.environment.is_none() && profile.environment_tools.is_none())
    {
        return Ok(());
    }
    ensure!(
        engine.saved_login_file.is_none(),
        "Agent environments require a host-owned executor configuration"
    );
    let inherited = match startup.environments.as_deref().unwrap_or_default() {
        [] => AgentProfileEnvironment(None),
        [selection]
            if matches!(
                selection.config,
                codex_protocol::protocol::EnvironmentConfigState::Ready(_)
            ) =>
        {
            AgentProfileEnvironment(Some(selection.clone()))
        }
        _ => anyhow::bail!("Agent environments require one ready default executor or no default"),
    };
    let manager = engine.manager.environment_manager();
    let mut bindings = BTreeMap::new();
    for profile in &opening.roster {
        if let Some(environment) = &profile.environment {
            let options: crate::environment::EnvironmentOptions =
                serde_json::from_value(environment.clone())
                    .context("Invalid Agent executor options")?;
            options.restrict_network_approval(&mut startup.config)?;
            bindings.insert(profile.id.clone(), options);
        }
    }
    let mut admitted = BTreeMap::new();
    let mut executor_owners = Vec::new();
    let mut policies = BTreeMap::new();
    let mut has_strict = startup
        .thread_extension_init
        .get::<crate::environment::StrictExecutorWrites>()
        .is_some();
    let inherited_policy = environment_policy(&inherited, &startup.config, &manager)?;
    for profile in &opening.roster {
        let tools = profile
            .environment_tools
            .as_ref()
            .context("Agent requires its captured executor tool declaration")?;
        ensure!(
            tools.iter().all(|name| matches!(
                name.as_str(),
                "exec_command" | "write_stdin" | "apply_patch" | "project_glob" | "project_grep"
            )),
            "Invalid Agent executor tool declaration"
        );
        let mut tool_names: Vec<_> = tools.iter().collect();
        tool_names.sort_unstable();
        let environment = if let Some(options) = bindings.get(&profile.id) {
            // Each runtime registration is fresh. Portable history selects the
            // profile and cannot name, replace or reconnect an executor.
            let id = format!(
                "sdk-profile-{}",
                codex_protocol::ThreadId::new().to_string().replace('-', "")
            );
            let (selection, strict, owner) = options
                .prepare_profile_selection(
                    &id,
                    &startup.config,
                    &manager,
                    engine.local_private_paths(),
                )
                .await?;
            executor_owners.extend(owner);
            let environment = AgentProfileEnvironment(Some(selection));
            let policy = environment_policy(&environment, &startup.config, &manager)?;
            policies.insert(
                profile.id.clone(),
                (true, strict.is_some(), policy, tool_names),
            );
            has_strict |= strict.is_some();
            environment
        } else {
            ensure!(
                inherited.0.is_some() || tools.is_empty(),
                "Agent has executor tools without an executor"
            );
            policies.insert(
                profile.id.clone(),
                (false, false, inherited_policy.clone(), tool_names),
            );
            inherited.clone()
        };
        admitted.insert(profile.id.clone(), environment);
    }
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&policies)?));
    startup.thread_extension_init.insert(ProfileEnvironments {
        profiles: admitted,
        _executor_owners: executor_owners,
        default: inherited,
        digest,
        strict: has_strict,
    });
    Ok(())
}

impl OpeningProfiles {
    /// Names admitted by the fresh graph installed before native startup.
    pub(crate) fn admitted_tool_names(&self) -> HashSet<ToolName> {
        self.roster
            .iter()
            .flat_map(|profile| {
                let mut names = crate::python_tools::tool_names(&profile.tools);
                names.extend(
                    profile
                        .handoffs
                        .keys()
                        .cloned()
                        .map(|name| ToolName::new(None, name).with_default_namespace()),
                );
                names
            })
            .collect()
    }

    /// A serialized pending source can only claim permissions the fresh graph
    /// grants without running a callback.
    pub(crate) fn validate_pending_source(&self, source: &AgentProfileReceipt) -> Result<()> {
        let mut candidates = vec![self.root_id.as_str()];
        let mut visited = HashSet::new();
        while let Some(id) = candidates.pop() {
            if id == source.profile_id {
                return Ok(());
            }
            if !visited.insert(id) {
                continue;
            }
            if let Some(profile) = self.roster.iter().find(|profile| profile.id == id) {
                candidates.extend(
                    profile
                        .handoffs
                        .iter()
                        .filter(|(name, _)| !profile.handoff_callbacks.contains_key(*name))
                        .map(|(_, target)| target.as_str()),
                );
            }
        }
        anyhow::bail!("Restored pending Agent profile requires live callback acceptance")
    }

    pub(crate) fn validate_restored_handoff(
        &self,
        tool_name: &ToolName,
        receipt: &codex_protocol::agent_profile::AgentProfileHandoff,
        pending: bool,
    ) -> Result<()> {
        let source = self
            .roster
            .iter()
            .find(|profile| profile.id == receipt.source.profile_id)
            .context("Restored handoff source is outside the declared graph")?;
        ensure!(
            source.admits_handoff(tool_name, &receipt.target_profile_id),
            "Restored handoff is outside its source declaration"
        );
        // Checkpoints cannot authorize a callback for the current turn.
        ensure!(
            !pending
                || (!source.handoff_callbacks.contains_key(&tool_name.name)
                    && !source.decision_handoffs.contains_key(&tool_name.name)),
            "Pending callback-backed Agent handoffs require live acceptance"
        );
        Ok(())
    }

    pub(crate) fn manual_restore_declaration(
        &self,
        profile_id: &str,
    ) -> Result<(&str, &ToolDeclarations, &[usize])> {
        let profile = self
            .roster
            .iter()
            .find(|profile| profile.id == profile_id)
            .context("Manual continuation source is outside the captured graph")?;
        Ok((&profile.instructions, &profile.tools, &profile.manual_slots))
    }

    /// Rebind a saved ordered subset only to the exact fresh source declarations.
    pub(crate) fn restore_catalog(
        &self,
        history: &[RolloutItem],
        saved: &Value,
    ) -> Result<(ToolDeclarations, Vec<usize>)> {
        ensure!(
            roster_fingerprint(&self.roster, &self.root_id)? == self.fingerprint,
            "Captured Agent graph fingerprint does not match its declarations"
        );
        let saved: Vec<DynamicToolSpec> = serde_json::from_value(saved.clone())?;
        let (_, source) = restored_envelope(self, history)?
            .context("Managed Agent checkpoint has no source receipt")?;
        let (_, declarations, manual) = self.manual_restore_declaration(&source.profile_id)?;
        let mut seen = HashSet::new();
        let mut slots = Vec::new();
        let mut rebound = ToolDeclarations::default();
        for (slot, spec) in saved.iter().enumerate() {
            let value = serde_json::to_value(spec)?;
            let original = declarations
                .iter()
                .position(|candidate| {
                    serde_json::to_value(candidate).is_ok_and(|candidate| candidate == value)
                })
                .context("Saved Agent tool is outside the fresh source declaration")?;
            ensure!(
                seen.insert(original),
                "Duplicate saved Agent tool declaration"
            );
            if manual.contains(&original) {
                slots.push(slot);
            }
            rebound.append_captured(&declarations, original);
        }
        Ok((rebound, slots))
    }

    pub(crate) fn capabilities(&self) -> [bool; 6] {
        [
            self.roster.iter().any(|profile| profile.selecting_steps),
            self.roster.iter().any(|profile| profile.transform_context),
            self.roster.iter().any(|profile| profile.before_compact),
            self.roster.iter().any(|profile| profile.before_complete),
            self.roster.iter().any(|profile| profile.post_turn_compact),
            self.roster
                .iter()
                .any(|profile| profile.tool_batch_completion),
        ]
    }
}

fn decode_roster(raw: &str) -> Result<Vec<ProfileSpec>> {
    serde_json::from_str(raw).map_err(|_| anyhow::anyhow!("Invalid captured Agent roster"))
}

fn validate(roster: &[ProfileSpec], root_id: &str) -> Result<()> {
    let ids = roster
        .iter()
        .map(|profile| profile.id.as_str())
        .collect::<HashSet<_>>();
    ensure!(
        ids.len() == roster.len() && ids.contains(root_id),
        "Invalid captured Agent identities"
    );
    for profile in roster {
        ensure!(
            !profile.id.is_empty() && !profile.output_fingerprint.is_empty(),
            "Incomplete captured Agent declaration"
        );
        ensure!(
            profile.native_provider_id.as_deref().is_none_or(|id| {
                profile.id != root_id
                    && id.strip_prefix("sdk_profile_").is_some_and(|number| {
                        !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
                    })
            }),
            "Invalid captured handoff provider identity"
        );
        ensure!(
            profile
                .wire_output_schema
                .as_ref()
                .is_none_or(Value::is_object),
            "Captured Agent wire output schema must be an object"
        );
        ensure!(
            !profile.wire_output_plain || profile.wire_output_schema.is_none(),
            "Captured Agent cannot declare both plain and structured wire output"
        );
        ensure!(
            profile
                .wire_output_guidance
                .iter()
                .chain(profile.runtime_output_guidance.iter())
                .all(|guidance| !guidance.is_empty() && profile.wire_output_schema.is_none()),
            "Captured Agent prompted output requires text wire output and guidance"
        );
        let mut all_declarations = profile.tools.to_vec();
        for name in profile.handoffs.keys() {
            if profile.handoff_callbacks.contains_key(name) {
                continue;
            }
            all_declarations.push(DynamicToolSpec::Function(DynamicToolFunctionSpec {
                strict: false,
                output_schema: None,
                name: name.clone(),
                description: "Native handoff".into(),
                input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
                defer_loading: false,
            }));
        }
        crate::python_tools::validate_declarations(&all_declarations)?;
        for (name, slot) in &profile.handoff_callbacks {
            ensure!(
                profile.handoffs.contains_key(name)
                    && matches!(profile.tools.get(*slot), Some(DynamicToolSpec::Function(spec)) if spec.name == *name)
                    && !profile.manual_slots.contains(slot)
                    && !profile.terminal_slots.contains(slot),
                "Handoff callback must name its exact automatic catalog slot"
            );
            ensure!(
                profile
                    .tools
                    .caller_limits(*slot)
                    .is_none_or(|callers| callers.contains(ToolExposures::DIRECT)),
                "Handoff callback must allow direct model calls"
            );
        }
        for (name, declaration) in &profile.decision_handoffs {
            ensure!(
                !profile.handoffs.contains_key(name)
                    && matches!(profile.tools.get(declaration.slot), Some(DynamicToolSpec::Function(spec)) if spec.name == *name)
                    && !profile.manual_slots.contains(&declaration.slot)
                    && !profile.terminal_slots.contains(&declaration.slot)
                    && !declaration.targets.is_empty()
                    && declaration
                        .targets
                        .iter()
                        .all(|target| ids.contains(target.as_str()))
                    && declaration.targets.iter().collect::<HashSet<_>>().len()
                        == declaration.targets.len(),
                "Decision handoff must name an exact automatic slot and distinct captured targets"
            );
        }
        for (name, target) in &profile.handoffs {
            ensure!(
                !name.is_empty()
                    && name.len() <= 64
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
                    && ids.contains(target.as_str()),
                "Invalid captured handoff declaration"
            );
        }
    }
    Ok(())
}

fn roster_fingerprint(roster: &[ProfileSpec], root_id: &str) -> Result<String> {
    validate(roster, root_id)?;
    let declarations = roster
        .iter()
        .map(|profile| {
            let mut descriptor = serde_json::to_value(profile)?;
            descriptor["tools"] = serde_json::to_value(
                profile.tools.without_configured_agent_roles(),
            )?;
            descriptor["model"] = serde_json::to_value(profile.model.for_persistence())?;
            // Endpoint credentials, process configuration and refreshed policies are not
            // declaration compatibility. Their fresh native owners remain authority.
            descriptor["mcp_servers"] = json!(profile.mcp_servers.keys().collect::<Vec<_>>());
            let fields = descriptor
                .as_object_mut()
                .expect("Agent declaration object");
            fields.remove("environment");
            fields.remove("environment_tools");
            Ok(descriptor)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!({
            "root_id": root_id, "roster": declarations,
        }))?)
    ))
}

/// Pure normalization shared by opening, restoration and Python's graph capture.
/// Hashes declaration/model/instruction/output/callback shapes and MCP names, never credentials.
pub(crate) fn fingerprint(roster_json: &str, root_id: &str) -> Result<String> {
    roster_fingerprint(&decode_roster(roster_json)?, root_id)
}

pub(crate) fn opening(thread: &CodexThread) -> Option<(OpeningProfiles, Vec<Value>)> {
    let store = thread.thread_extension_data();
    Some((
        (*store.get::<OpeningProfiles>()?).clone(),
        store
            .get::<OpeningFiles>()
            .map(|files| files.0.clone())
            .unwrap_or_default(),
    ))
}

pub(crate) fn install_opening(
    startup: &mut StartThreadOptions,
    opening: OpeningProfiles,
    files: Vec<InstructionFile>,
) -> Result<()> {
    ensure!(
        roster_fingerprint(&opening.roster, &opening.root_id)? == opening.fingerprint,
        "Captured Agent graph fingerprint does not match its declarations"
    );
    ensure!(
        startup
            .thread_extension_init
            .get::<OpeningProfiles>()
            .is_none(),
        "Captured Agent graph is already installed"
    );
    for (id, names) in &opening.input_preparations {
        let source = opening.roster.iter().find(|profile| &profile.id == id)
            .context("Handoff input source is outside the captured graph")?;
        let unique: HashSet<_> = names.iter().collect();
        ensure!(unique.len() == names.len() && names.iter().all(|name|
            (source.handoffs.contains_key(name) || source.decision_handoffs.contains_key(name))),
            "Handoff input callback is outside its exact captured declarations");
    }
    if opening.input_preparations.values().any(|names| !names.is_empty()) {
        startup.thread_extension_init.insert(
            codex_protocol::agent_profile::AgentProfileHandoffInputCapture,
        );
    }
    startup.thread_extension_init.insert(OpeningFiles(files));
    startup.thread_extension_init.insert(opening);
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedProfile {
    profile_id: String,
    epoch: u64,
    model: AgentProfileModelSettings,
    #[serde(default)]
    presentation: Option<codex_protocol::agent_profile::AgentProfileHandoffPresentation>,
}

impl PersistedProfile {
    fn validate_presentation(&self) -> Result<()> {
        // An idle update may retain an earlier admitted presentation. Core
        // validates the complete publication chain before it can use that view.
        ensure!(
            self.presentation.as_ref().is_none_or(|value| {
                value.destination.profile_id == self.profile_id
                    && value.destination.epoch <= self.epoch
                    && value.belongs_to(&value.destination)
            }),
            "Restored presentation belongs to another Agent destination"
        );
        Ok(())
    }
}

pub(crate) fn profile_receipt(value: &Value) -> Result<AgentProfileReceipt> {
    let source: PersistedProfile = serde_json::from_value(value.clone())
        .map_err(|_| anyhow::anyhow!("Invalid restored Agent receipt"))?;
    source.validate_presentation()?;
    Ok(AgentProfileReceipt {
        profile_id: source.profile_id,
        epoch: source.epoch,
    })
}

fn restored_envelope<'a>(
    opening: &OpeningProfiles,
    history: &'a [RolloutItem],
) -> Result<Option<(&'a ResponseItemEnvelope, PersistedProfile)>> {
    let latest = history.iter().rev().find_map(|item| match item {
        RolloutItem::ResponseItem(envelope)
            if envelope
                .metadata
                .as_ref()
                .is_some_and(|metadata| metadata.sdk_agent_profile.is_some()) =>
        {
            Some(envelope)
        }
        _ => None,
    });
    let Some(envelope) = latest else {
        return Ok(None);
    };
    let metadata = envelope
        .metadata
        .as_ref()
        .context("Missing restored Agent metadata")?;
    ensure!(
        metadata.sdk_agent_graph.as_deref() == Some(opening.fingerprint.as_str()),
        "Restore requires the exact captured Agent declaration graph"
    );
    let receipt: PersistedProfile = serde_json::from_value(
        metadata
            .sdk_agent_profile
            .clone()
            .context("Missing restored Agent receipt")?,
    )
    .map_err(|_| anyhow::anyhow!("Invalid restored Agent receipt"))?;
    receipt.validate_presentation()?;
    ensure!(
        opening
            .roster
            .iter()
            .any(|profile| profile.id == receipt.profile_id),
        "Restored Agent is outside the captured graph"
    );
    ensure!(
        !receipt.model.model.is_empty(),
        "Invalid restored Agent settings"
    );
    ensure!(
        receipt
            .model
            .request_controls
            .hosted_prompt
            .as_ref()
            .and_then(|prompt| prompt.as_ref())
            .is_none_or(|prompt| prompt.reference.is_none()),
        "Stored hosted prompt references require current declarations"
    );
    Ok(Some((envelope, receipt)))
}

/// Recover the declaration owner frozen before queue admission, never the sampled actor.
pub(crate) fn operation_source(
    opening: &OpeningProfiles,
    history: &[RolloutItem],
    turn_id: &str,
) -> Result<AgentProfileReceipt> {
    validate_restored(opening, history)?;
    ensure!(!turn_id.is_empty(), "Missing operation turn identity");
    let mut original = None;
    let mut first = None;
    for (index, item) in history.iter().enumerate() {
        let RolloutItem::TurnContext(context) = item else {
            continue;
        };
        if context.turn_id.as_deref() != Some(turn_id) {
            continue;
        }
        let Some(receipt) = &context.sdk_receipt else {
            continue;
        };
        let value = receipt
            .get("operation_declaration_source")
            .context("Missing original operation declaration provenance")?;
        let source: AgentProfileReceipt = serde_json::from_value(value.clone())
            .context("Invalid original operation declaration provenance")?;
        ensure!(
            original.as_ref().is_none_or(|previous| previous == &source),
            "Operation declaration provenance changed within its owning turn"
        );
        first.get_or_insert(index);
        original = Some(source);
    }
    let source = original.context("Missing original operation declaration provenance")?;
    let first = first.expect("an original source has an owning receipt");
    let mut matching = 0;
    for item in &history[..first] {
        let RolloutItem::ResponseItem(envelope) = item else {
            continue;
        };
        let Some(metadata) = &envelope.metadata else {
            continue;
        };
        let Some(value) = &metadata.sdk_agent_profile else {
            continue;
        };
        if profile_receipt(value)? == source {
            ensure!(
                metadata.sdk_agent_graph.as_deref() == Some(opening.fingerprint.as_str()),
                "Original operation belongs to a different Agent graph"
            );
            ensure!(
                opening
                    .roster
                    .iter()
                    .any(|profile| profile.id == source.profile_id),
                "Original operation is outside the fresh Agent declaration graph"
            );
            matching += 1;
        }
    }
    ensure!(
        matching == 1,
        "Original operation has no unique canonical accepted Agent envelope"
    );
    Ok(source)
}

/// Compares the stored canonical publication to freshly admitted grants.
pub(crate) fn validate_restored_environment(
    expected: Option<&str>,
    history: &[RolloutItem],
) -> Result<bool> {
    let latest_profile = history.iter().rev().find_map(|item| match item {
        RolloutItem::ResponseItem(envelope) => envelope
            .metadata
            .as_ref()
            .filter(|metadata| metadata.sdk_agent_profile.is_some()),
        _ => None,
    });
    let recorded = latest_profile.and_then(|metadata| metadata.sdk_agent_environment_policy.as_deref());
    let no_profile_or_sampling = latest_profile.is_none()
        && !history.iter().any(|item| matches!(item,
            RolloutItem::TurnContext(context) if context.sdk_receipt.is_some()
        ));
    ensure!(
        recorded == expected || no_profile_or_sampling,
        "Restore requires the recorded Agent environment grants"
    );
    Ok(recorded.is_some())
}

pub(crate) fn restore_source(
    opening: &OpeningProfiles,
    history: &[RolloutItem],
) -> Result<AgentProfileReceipt> {
    validate_restored(opening, history)?;
    let (_, source) = restored_envelope(opening, history)?
        .context("Managed Agent checkpoint has no source receipt")?;
    Ok(AgentProfileReceipt {
        profile_id: source.profile_id,
        epoch: source.epoch,
    })
}

pub(crate) fn validate_restored(
    opening: &OpeningProfiles,
    history: &[RolloutItem],
) -> Result<Accepted> {
    ensure!(
        roster_fingerprint(&opening.roster, &opening.root_id)? == opening.fingerprint,
        "Captured Agent graph fingerprint does not match its declarations"
    );
    let (envelope, _) = restored_envelope(opening, history)?
        .context("Managed Agent checkpoint has no native profile receipt")?;
    let accepted = crate::application_instructions::latest(history)?
        .context("Managed Agent checkpoint has no accepted instructions")?;
    ensure!(
        Some(&accepted.id) == envelope.item.id(),
        "Latest accepted instructions have no matching Agent profile receipt"
    );
    Ok(accepted)
}

pub(crate) fn restored_request_transport(
    opening: &OpeningProfiles,
    history: &[RolloutItem],
) -> Result<Option<Option<RequestTransportOverrides>>> {
    let (_, source) = restored_envelope(opening, history)?
        .context("Managed Agent checkpoint has no source receipt")?;
    let profile = opening
        .roster
        .iter()
        .find(|profile| profile.id == source.profile_id)
        .context("Restored Agent is outside the captured graph")?;
    Ok(profile.model.request_controls.request_transport.clone())
}

#[derive(Clone)]
struct PreparedProfile {
    declaration: ProfileSpec,
    model: AgentProfileModelSettings,
    catalog: ProfileCatalog,
    mcp: Arc<codex_mcp::McpBinding>,
    plugins: codex_extension_api::SelectedPluginSnapshot,
    result_selection: crate::mcp_result_control::Selection,
    mcp_policy: crate::native_interception::ProfileMcpPolicy,
    environment: Option<AgentProfileEnvironment>,
    environment_tools: Option<AgentProfileExecutorTools>,
}

struct Reservation {
    turn: String,
    expected: AgentProfileReceipt,
    target: String,
    calls: HashSet<String>,
    accepted: bool,
    restored: bool,
}

struct AgentProfiles {
    opening: Arc<OpeningProfiles>,
    environment_policy_digest: Option<String>,
    thread: Weak<CodexThread>,
    tools: Arc<PythonTools>,
    profiles: BTreeMap<String, PreparedProfile>,
    files: Vec<InstructionFile>,
    reservation: Mutex<Option<Reservation>>,
}

#[derive(Clone)]
struct VoiceProfileRegistry {
    generation: String,
    previous: Option<Arc<AgentProfiles>>,
}

// Only the last unpublished admission can restore the preceding registry snapshot.
struct VoiceGraphAdmission {
    generation: String,
    receipt: AgentProfileReceipt,
    profiles: Arc<AgentProfiles>,
    previous: Option<Arc<AgentProfiles>>,
    previous_registry: Option<VoiceProfileRegistry>,
}

fn rebind_restored_controls(
    model: &mut AgentProfileModelSettings,
    current: &AgentProfileModelSettings,
) {
    model.invocation_timeout_ms = current.invocation_timeout_ms;
    model.request_controls.retry = current.request_controls.retry.clone();
    model.request_controls.attempt_timeout_ms = current.request_controls.attempt_timeout_ms;
    model
        .request_controls
        .request_transport
        .clone_from(&current.request_controls.request_transport);
}

async fn prepare_profile(
    thread: &CodexThread,
    tools: &PythonTools,
    descriptor: &ProfileSpec,
    mut model: AgentProfileModelSettings,
    default_model: &str,
    startup: bool,
    voice: bool,
    environment: Option<AgentProfileEnvironment>,
    environment_tools: Option<AgentProfileExecutorTools>,
) -> Result<PreparedProfile> {
    if model.model.is_empty() {
        model.model = default_model.to_owned();
    }
    let flags = [
        descriptor.selecting_steps,
        descriptor.transform_context,
        descriptor.before_compact,
        descriptor.before_complete,
        descriptor.post_turn_compact,
        descriptor.tool_batch_completion,
    ];
    let catalog = if voice {
        tools.voice_profile_catalog(
            descriptor.tools.clone(),
            &descriptor.manual_slots,
            &descriptor.terminal_slots,
            &descriptor.input_error_slots,
            descriptor.step_defaults.as_deref(),
            flags,
        )?
    } else {
        tools.profile_catalog(
            descriptor.tools.clone(),
            &descriptor.manual_slots,
            &descriptor.terminal_slots,
            &descriptor.input_error_slots,
            descriptor.step_defaults.as_deref(),
            flags,
            startup,
        )?
    };
    let servers = crate::mcp_roster::decode(json!(descriptor.mcp_servers))?;
    let result_selection: crate::mcp_result_control::Selection = serde_json::from_value(json!({
        "generation": catalog.generation.id, "servers": descriptor.mcp_result_tools,
        "metadata_servers": descriptor.mcp_metadata_tools,
        "discovery_servers": descriptor.mcp_discovery_tools,
    }))?;
    result_selection.validate(&servers)?;
    let (mcp, plugins) = prepare_profile_mcp(thread, servers, environment.as_ref()).await?;
    let mcp_policy = crate::native_interception::ProfileMcpPolicy::prepare(
        &mcp,
        &descriptor.mcp_tools,
        catalog.generation.id,
    )?;
    Ok(PreparedProfile {
        declaration: descriptor.clone(),
        model,
        catalog,
        mcp,
        plugins,
        result_selection,
        mcp_policy,
        environment,
        environment_tools,
    })
}

async fn prepare_profile_mcp(
    thread: &CodexThread,
    servers: HashMap<String, codex_config::McpServerConfig>,
    environment: Option<&AgentProfileEnvironment>,
) -> Result<(
    Arc<codex_mcp::McpBinding>,
    codex_extension_api::SelectedPluginSnapshot,
)> {
    Ok(match environment {
        Some(environment) => {
            thread
                .prepare_agent_profile_mcp_in_environment(servers, environment)
                .await?
        }
        None => thread.prepare_agent_profile_mcp(servers).await?,
    })
}

pub(crate) async fn admit_realtime_graph(
    state: &crate::engine::ThreadState,
    generation: &str,
    roster_json: &str,
    root_id: &str,
    expected: Option<AgentProfileReceipt>,
) -> Result<Value> {
    let thread = &state.thread;
    let current = thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .map(|current| current.as_ref().clone());
    let previous_registry = thread
        .thread_extension_data()
        .get::<VoiceProfileRegistry>()
        .map(|registry| registry.as_ref().clone());
    let original = match &previous_registry {
        Some(registry) => {
            ensure!(
                registry.generation == generation,
                "Voice graph belongs to another generation"
            );
            registry.previous.clone()
        }
        None => current.clone(),
    };
    let tools = thread
        .thread_extension_data()
        .get::<PythonTools>()
        .context("Voice update requires the native tool owner")?;
    let roster = decode_roster(roster_json)?;
    validate(&roster, root_id)?;
    ensure!(
        roster
            .iter()
            .all(|profile| profile.environment.is_none() && profile.environment_tools.is_none()),
        "Voice Agent updates cannot attach a new executor to an existing Session"
    );
    let (environment, environment_tools) =
        if let Some(source) = thread.captured_agent_profile().await? {
            (
                source
                    .profile
                    .data
                    .get::<AgentProfileEnvironment>()
                    .map(|env| (*env).clone()),
                source
                    .profile
                    .data
                    .get::<AgentProfileExecutorTools>()
                    .map(|tools| (*tools).clone()),
            )
        } else {
            (None, None)
        };
    let mut prepared = current
        .as_ref()
        .map(|current| current.profiles.clone())
        .unwrap_or_default();
    ensure!(
        prepared.len() + roster.len() <= 1024,
        "Voice Agent graph capacity exceeded"
    );
    ensure!(
        roster
            .iter()
            .all(|profile| !prepared.contains_key(&profile.id)),
        "Voice Agent identities cannot be reused"
    );
    let default_model = thread.thread_settings_snapshot().await.model;
    for descriptor in &roster {
        prepared.insert(
            descriptor.id.clone(),
            prepare_profile(
                thread,
                &tools,
                descriptor,
                descriptor.model.clone(),
                &default_model,
                false,
                true,
                environment.clone(),
                environment_tools.clone(),
            )
            .await?,
        );
    }
    let opening = match &current {
        Some(current) => current.opening.clone(),
        None => Arc::new(OpeningProfiles {
            input_preparations: Default::default(),
            root_id: root_id.to_owned(),
            roster: roster.clone(),
            fingerprint: roster_fingerprint(&roster, root_id)?,
        }),
    };
    let profiles = Arc::new(AgentProfiles {
        opening,
        environment_policy_digest: current
            .as_ref()
            .and_then(|current| current.environment_policy_digest.clone()),
        thread: Arc::downgrade(thread),
        tools,
        profiles: prepared,
        files: current
            .as_ref()
            .map(|current| current.files.clone())
            .unwrap_or_default(),
        reservation: Mutex::new(None),
    });
    let target = profiles.candidate(thread, root_id)?;
    thread.thread_extension_data().insert(profiles.clone());
    let captured = thread
        .capture_realtime_agent_profile_source(generation, expected.as_ref(), target)
        .await;
    let receipt = match captured {
        Ok(receipt) => receipt,
        Err(error) => {
            match current {
                Some(current) => {
                    thread.thread_extension_data().insert(current);
                }
                None => {
                    thread
                        .thread_extension_data()
                        .remove::<Arc<AgentProfiles>>();
                }
            }
            return Err(error.into());
        }
    };
    thread.thread_extension_data().insert(VoiceProfileRegistry {
        generation: generation.to_owned(),
        previous: original,
    });
    thread.thread_extension_data().insert(VoiceGraphAdmission {
        generation: generation.to_owned(),
        receipt: receipt.clone(),
        profiles: profiles.clone(),
        previous: current,
        previous_registry,
    });
    let catalogs = roster
        .iter()
        .map(|profile| {
            (
                profile.id.clone(),
                profiles.profiles[&profile.id]
                    .catalog
                    .generation
                    .id
                    .to_string(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let catalog = &profiles.profiles[&receipt.profile_id].catalog;
    let (selection_id, function_tools) = thread
        .realtime_agent_source_selection(Some(generation), Some(&receipt))
        .await?;
    Ok(json!({
        "active": receipt,
        "catalogs": catalogs,
        "active_catalog": {
            "generation": catalog.generation.id.to_string(),
            "specs": catalog.slot_specs()?,
        },
        "selection_id": selection_id,
        "function_tools": function_tools,
        "generation_high_water": profiles.tools.generation_high_water().to_string(),
    }))
}

pub(crate) fn discard_realtime_graph(
    thread: &CodexThread,
    generation: &str,
    receipt: &AgentProfileReceipt,
) -> Result<()> {
    let admission = thread
        .thread_extension_data()
        .get::<VoiceGraphAdmission>()
        .context("Voice has no staged Agent graph")?;
    ensure!(
        admission.generation == generation && &admission.receipt == receipt,
        "Voice graph discard requires the exact last admission"
    );
    let current = thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .context("Voice staged Agent graph is no longer installed")?;
    ensure!(
        Arc::ptr_eq(current.as_ref(), &admission.profiles),
        "Voice staged Agent graph is no longer installed"
    );
    thread.release_realtime_agent_profile_source(generation, receipt);
    match &admission.previous {
        Some(previous) => {
            thread.thread_extension_data().insert(previous.clone());
        }
        None => {
            thread
                .thread_extension_data()
                .remove::<Arc<AgentProfiles>>();
        }
    }
    match &admission.previous_registry {
        Some(previous) => {
            thread.thread_extension_data().insert(previous.clone());
        }
        None => {
            thread
                .thread_extension_data()
                .remove::<VoiceProfileRegistry>();
        }
    }
    thread
        .thread_extension_data()
        .remove::<VoiceGraphAdmission>();
    Ok(())
}

pub(crate) async fn restore_realtime_graph(
    thread: &CodexThread,
    generation: &str,
) -> Result<Value> {
    if let Some(registry) = thread.thread_extension_data().get::<VoiceProfileRegistry>() {
        ensure!(
            registry.generation == generation,
            "Voice graph belongs to another generation"
        );
        match &registry.previous {
            Some(previous) => {
                thread.thread_extension_data().insert(previous.clone());
            }
            None => {
                thread
                    .thread_extension_data()
                    .remove::<Arc<AgentProfiles>>();
            }
        }
        thread.release_realtime_agent_profile_sources(generation);
        thread
            .thread_extension_data()
            .remove::<VoiceGraphAdmission>();
        thread
            .thread_extension_data()
            .remove::<VoiceProfileRegistry>();
    }
    if let Some(profiles) = thread.thread_extension_data().get::<Arc<AgentProfiles>>() {
        profiles.receipt(thread).await
    } else {
        let tools = thread
            .thread_extension_data()
            .get::<PythonTools>()
            .context("Native tool owner is unavailable")?;
        Ok(
            json!({"active":null,"catalogs":{},"generation_high_water":tools.generation_high_water()}),
        )
    }
}

pub(crate) async fn realtime_source(
    thread: &CodexThread,
    generation: &str,
    receipt: AgentProfileReceipt,
) -> Result<Value> {
    let profiles = thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .context("Captured Agent graph is unavailable")?;
    let catalog = &profiles
        .profiles
        .get(&receipt.profile_id)
        .context("Voice Agent source is outside its retained graph")?
        .catalog;
    let (selection_id, function_tools) = thread
        .realtime_agent_source_selection(Some(generation), Some(&receipt))
        .await?;
    Ok(
        json!({"profile_receipt": receipt, "catalog_generation": catalog.generation.id,
        "selection_id": selection_id, "function_tools": function_tools}),
    )
}

impl AgentProfiles {
    fn candidate(&self, thread: &CodexThread, id: &str) -> Result<Arc<AgentProfile>> {
        self.workspace_candidate(thread, id, None)
    }
    fn workspace_candidate(
        &self,
        thread: &CodexThread,
        id: &str,
        workspace: Option<WorkspacePreparation>,
    ) -> Result<Arc<AgentProfile>> {
        let prepared = self
            .profiles
            .get(id)
            .context("Agent is outside the captured graph")?;
        let files = if id == self.opening.root_id {
            self.files.clone()
        } else {
            Vec::new()
        };
        let (instructions, appendix) = match workspace {
            Some(workspace) => {
                ensure!(
                    prepared.declaration.workspace_preparation,
                    "Workspace preparation is outside its captured declaration"
                );
                (
                    workspace.instructions,
                    Some(workspace.workspace_instructions),
                )
            }
            None => (
                prepared.declaration.instructions.clone(),
                prepared.declaration.workspace_instructions.clone(),
            ),
        };
        let text = match &appendix {
            Some(appendix) => format!("{instructions}\n\n{appendix}"),
            None => instructions,
        };
        let (mut envelope, accepted) =
            crate::application_instructions::prepare(thread, &text, files)?;
        let metadata = envelope.metadata.get_or_insert_with(Default::default);
        metadata.sdk_agent_graph = Some(self.opening.fingerprint.clone());
        metadata.sdk_agent_environment_policy = self.environment_policy_digest.clone();
        let mut data = ExtensionDataInit::new();
        data.insert(codex_extension_api::AgentProfileOutputStrict(
            prepared
                .declaration
                .model
                .request_controls
                .output_schema_strict
                .unwrap_or(true),
        ));
        if let Some(appendix) = appendix {
            data.insert(WorkspaceAppendix(appendix));
        }
        data.insert(codex_extension_api::AgentProfileInstructions {
            text: Some(accepted.text.clone()),
        });
        if let Some(guidance) = prepared
            .declaration
            .runtime_output_guidance
            .as_ref()
            .or(prepared.declaration.wire_output_guidance.as_ref())
        {
            data.insert(codex_extension_api::AgentProfileOutputGuidance(
                guidance.clone(),
            ));
        }
        if prepared.declaration.wire_output_plain
            || prepared.declaration.wire_output_schema.is_some()
        {
            data.insert(codex_extension_api::AgentProfileOutputSchema(
                prepared.declaration.wire_output_schema.clone(),
            ));
        }
        data.insert(accepted);
        insert_profile_provider(thread, &prepared.declaration, &mut data)?;
        data.insert(prepared.catalog.clone());
        data.insert(prepared.plugins.clone());
        data.insert(prepared.declaration.decision_tools());
        data.insert(codex_extension_api::AgentProfileHandoffTools {
            targets: prepared
                .declaration
                .handoffs
                .iter()
                .map(|(name, target)| {
                    (
                        ToolName::new(None, name.clone()).with_default_namespace(),
                        target.clone(),
                    )
                })
                .collect(),
        });
        data.insert(prepared.result_selection.clone());
        data.insert(prepared.mcp_policy.clone());
        if let Some(environment) = &prepared.environment {
            data.insert(environment.clone());
        }
        if let Some(tools) = &prepared.environment_tools {
            data.insert(tools.clone());
        }
        Ok(Arc::new(AgentProfile {
            profile_id: id.to_owned(),
            model: prepared.model.clone(),
            application_instructions: envelope,
            data,
            mcp: prepared.mcp.clone(),
        }))
    }

    async fn receipt(&self, thread: &CodexThread) -> Result<Value> {
        let captured = thread
            .captured_agent_profile()
            .await?
            .context("Captured Agent graph has no committed native profile")?;
        let active = &captured.receipt;
        let catalogs = self
            .profiles
            .iter()
            .map(|(id, profile)| (id.clone(), profile.catalog.generation.id.to_string()))
            .collect::<BTreeMap<_, _>>();
        let catalog = captured
            .profile
            .data
            .get::<ProfileCatalog>()
            .context("Captured Agent profile has no tool catalog")?;
        Ok(json!({"active": active, "catalogs": catalogs,
            "active_catalog":{"generation":catalog.generation.id.to_string(),"specs":catalog.slot_specs()?},
            "generation_high_water": self.tools.generation_high_water().to_string()}))
    }
}

pub(crate) async fn active_specs(thread: &CodexThread) -> Result<Option<ToolDeclarations>> {
    if thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .is_none()
    {
        return Ok(None);
    }
    let Some(captured) = thread.captured_agent_profile().await? else {
        return Ok(None);
    };
    let catalog = captured
        .profile
        .data
        .get::<ProfileCatalog>()
        .context("Managed Agent checkpoint has no captured catalog")?;
    Ok(Some(catalog.selected_declarations()))
}

pub(crate) async fn active(thread: &CodexThread) -> Result<Option<AgentProfileReceipt>> {
    Ok(thread.agent_profile_receipt().await?)
}

pub(crate) async fn configure(
    state: &crate::engine::ThreadState,
    roster_json: &str,
    root_id: &str,
) -> Result<Value> {
    let thread = &state.thread;
    let opening = thread
        .thread_extension_data()
        .get::<OpeningProfiles>()
        .context("Captured Agent graph was not installed before native opening")?;
    let supplied = decode_roster(roster_json)?;
    ensure!(
        root_id == opening.root_id
            && roster_fingerprint(&supplied, root_id)? == opening.fingerprint,
        "Captured Agent graph changed after native opening"
    );
    if let Some(profiles) = thread.thread_extension_data().get::<Arc<AgentProfiles>>() {
        return profiles.receipt(thread).await;
    }
    let tools = thread
        .thread_extension_data()
        .get::<PythonTools>()
        .context("Agent profiles require the admitted Python tool owner")?;
    tools.check_idle(thread).await?;
    let files = thread
        .thread_extension_data()
        .get::<OpeningFiles>()
        .map(|files| files.0.clone())
        .unwrap_or_default();
    let config = thread.config().await;
    let settings = thread.thread_settings_snapshot().await;
    let history = thread.load_history(true).await?;
    let restored = restored_envelope(&opening, &history.items)?.is_some();
    let opening_model = history.items.iter().find_map(|item| {
        let RolloutItem::ResponseItem(envelope) = item else {
            return None;
        };
        let metadata = envelope.metadata.as_ref()?;
        if metadata.sdk_agent_graph.as_deref() != Some(opening.fingerprint.as_str()) {
            return None;
        }
        let source: PersistedProfile =
            serde_json::from_value(metadata.sdk_agent_profile.clone()?).ok()?;
        (source.profile_id == opening.root_id).then_some(source.model)
    });
    ensure!(
        !restored || opening_model.is_some(),
        "Restored Agent graph has no captured root defaults"
    );
    let opening_model = opening_model.unwrap_or(AgentProfileModelSettings {
        model: settings.model.clone(),
        reasoning_effort: settings.reasoning_effort,
        reasoning_summary: settings.reasoning_summary,
        service_tier: settings.service_tier.clone(),
        tool_choice: settings.tool_choice,
        personality: config.personality,
        invocation_timeout_ms: settings.invocation_timeout_ms,
        request_controls: settings.request_controls.clone(),
    });
    let environments = thread.thread_extension_data().get::<ProfileEnvironments>();
    let mut profiles = BTreeMap::new();
    for descriptor in &opening.roster {
        let mut model = if descriptor.id == opening.root_id {
            opening_model.clone()
        } else {
            descriptor.model.clone()
        };
        if restored {
            rebind_restored_controls(&mut model, &descriptor.model);
        }
        profiles.insert(
            descriptor.id.clone(),
            prepare_profile(
                thread,
                &tools,
                descriptor,
                model,
                &opening_model.model,
                !restored && descriptor.id == opening.root_id,
                false,
                environments
                    .as_ref()
                    .map(|env| env.selection(&descriptor.id))
                    .transpose()?,
                descriptor
                    .environment_tools
                    .clone()
                    .map(|allowed| AgentProfileExecutorTools { allowed }),
            )
            .await?,
        );
    }
    let profiles = Arc::new(AgentProfiles {
        opening,
        environment_policy_digest: environments
            .as_ref()
            .map(|environment| environment.digest.clone()),
        thread: Arc::downgrade(thread),
        tools,
        profiles,
        files,
        reservation: Mutex::new(None),
    });
    let restored = restored_envelope(&profiles.opening, &history.items)?;
    let target = if let Some((envelope, receipt)) = restored {
        let prepared = profiles
            .profiles
            .get(&receipt.profile_id)
            .context("Restored Agent is outside the captured graph")?;
        let accepted = validate_restored(&profiles.opening, &history.items)?;
        let catalog = profiles.tools.startup_profile_catalog(
            [
                prepared.catalog.selecting_steps,
                prepared.catalog.transform_context,
                prepared.catalog.before_compact,
                prepared.catalog.before_complete,
                prepared.catalog.post_turn_compact,
                prepared.catalog.tool_batch_completion,
            ],
            &prepared.catalog,
        )?;
        let generation = catalog.generation.id;
        let mut data = ExtensionDataInit::new();
        data.insert(codex_extension_api::AgentProfileOutputStrict(
            prepared
                .declaration
                .model
                .request_controls
                .output_schema_strict
                .unwrap_or(true),
        ));
        data.insert(codex_extension_api::AgentProfileInstructions {
            text: Some(accepted.text.clone()),
        });
        if let Some(guidance) = prepared
            .declaration
            .runtime_output_guidance
            .as_ref()
            .or(prepared.declaration.wire_output_guidance.as_ref())
        {
            data.insert(codex_extension_api::AgentProfileOutputGuidance(
                guidance.clone(),
            ));
        }
        if prepared.declaration.wire_output_plain
            || prepared.declaration.wire_output_schema.is_some()
        {
            data.insert(codex_extension_api::AgentProfileOutputSchema(
                prepared.declaration.wire_output_schema.clone(),
            ));
        }
        data.insert(accepted);
        insert_profile_provider(thread, &prepared.declaration, &mut data)?;
        data.insert(catalog);
        data.insert(prepared.declaration.decision_tools());
        data.insert(codex_extension_api::AgentProfileHandoffTools {
            targets: prepared
                .declaration
                .handoffs
                .iter()
                .map(|(name, target)| {
                    (
                        ToolName::new(None, name.clone()).with_default_namespace(),
                        target.clone(),
                    )
                })
                .collect(),
        });
        if let Some(environment) = &prepared.environment {
            data.insert(environment.clone());
        }
        if let Some(tools) = &prepared.environment_tools {
            data.insert(tools.clone());
        }
        let mut model = receipt.model;
        model
            .request_controls
            .request_transport
            .clone_from(&prepared.model.request_controls.request_transport);
        let mut target = AgentProfile {
            profile_id: receipt.profile_id,
            model,
            application_instructions: envelope.clone(),
            data,
            mcp: prepared.mcp.clone(),
        };
        bind_accepted_mcp(
            thread,
            &mut target,
            &prepared.declaration,
            generation,
            false,
        )
        .await?;
        Arc::new(target)
    } else {
        profiles.candidate(thread, &profiles.opening.root_id)?
    };
    thread.activate_agent_profile(None, target).await?;
    thread.thread_extension_data().insert(profiles.clone());
    thread
        .thread_extension_data()
        .get::<crate::native_interception::Control>()
        .context("Agent profiles require the native source policy owner")?
        .enable_profile_policies();
    profiles.receipt(thread).await
}

/// An idle update replaces only Core's current immutable snapshot. A later activation
/// intentionally returns to the captured declaration defaults.
pub(crate) async fn update_instructions(thread: &CodexThread, text: &str) -> Result<bool> {
    if thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .is_none()
    {
        return Ok(false);
    }
    let Some(captured) = thread.captured_agent_profile().await? else {
        return Ok(false);
    };
    let accepted = captured
        .profile
        .data
        .get::<Accepted>()
        .context("Managed Agent instructions are absent")?;
    update_active(thread, None, Some((text, accepted.files.clone())), None).await
}

pub(crate) async fn update_instructions_with_settings(
    thread: &CodexThread,
    text: &str,
    settings: Option<&codex_protocol::protocol::ThreadSettingsOverrides>,
) -> Result<bool> {
    if thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .is_none()
    {
        return Ok(false);
    }
    let Some(captured) = thread.captured_agent_profile().await? else {
        return Ok(false);
    };
    let accepted = captured
        .profile
        .data
        .get::<Accepted>()
        .context("Managed Agent instructions are absent")?;
    update_active(thread, settings, Some((text, accepted.files.clone())), None).await
}

pub(crate) async fn update_active(
    thread: &CodexThread,
    settings: Option<&codex_protocol::protocol::ThreadSettingsOverrides>,
    instructions: Option<(&str, Vec<InstructionFile>)>,
    catalog: Option<ProfileCatalog>,
) -> Result<bool> {
    update_active_inner(thread, settings, instructions, catalog, false).await
}

/// Publish the newly accepted MCP roster with the current immutable SDK catalog.
/// Existing voice sources keep their original profile and connection bindings.
pub(crate) async fn refresh_active_mcp(thread: &CodexThread) -> Result<bool> {
    update_active_inner(thread, None, None, None, true).await
}

async fn update_active_inner(
    thread: &CodexThread,
    settings: Option<&codex_protocol::protocol::ThreadSettingsOverrides>,
    instructions: Option<(&str, Vec<InstructionFile>)>,
    catalog: Option<ProfileCatalog>,
    refresh_mcp: bool,
) -> Result<bool> {
    let Some(profiles) = thread.thread_extension_data().get::<Arc<AgentProfiles>>() else {
        return Ok(false);
    };
    profiles.tools.check_idle(thread).await?;
    let Some(captured) = thread.captured_agent_profile().await? else {
        return Ok(false);
    };
    let catalog = if refresh_mcp {
        Some(
            captured
                .profile
                .data
                .get::<ProfileCatalog>()
                .context("Managed Agent MCP update has no captured catalog")?
                .as_ref()
                .clone(),
        )
    } else {
        catalog
    };
    let mut target = (*captured.profile).clone();
    if catalog.is_some() && !refresh_mcp {
        if let Some(Some(prompt)) = &mut target.model.request_controls.hosted_prompt {
            prompt.omit_tools = false;
        }
    }
    if let Some(settings) = settings {
        if let Some(model) = &settings.model {
            target.model.model = model.clone();
            if settings
                .request_controls
                .as_ref()
                .is_none_or(|controls| controls.hosted_prompt.is_none())
            {
                if let Some(Some(prompt)) = &mut target.model.request_controls.hosted_prompt {
                    prompt.omit_model = false;
                }
            }
        }
        if let Some(effort) = &settings.effort {
            target.model.reasoning_effort = effort.clone();
        }
        if let Some(summary) = settings.summary {
            target.model.reasoning_summary = Some(summary);
        }
        if let Some(tier) = &settings.service_tier {
            target.model.service_tier = tier.clone();
        }
        if let Some(choice) = settings.tool_choice {
            target.model.tool_choice = Some(choice);
            target.model.request_controls.named_tool_choice = Some(None);
            target.model.request_controls.hosted_tool_choice = Some(None);
        }
        if let Some(timeout) = settings.invocation_timeout_ms {
            target.model.invocation_timeout_ms = timeout;
        }
        if let Some(controls) = &settings.request_controls {
            target.model.request_controls.apply_patch(controls);
        }
        if let Some(personality) = settings.personality {
            target.model.personality = Some(personality);
        }
    }
    // An identical settings reset keeps the already committed publication and view.
    // Instruction and catalog updates still pass through the native publication owner.
    if instructions.is_none() && catalog.is_none() && target.model == captured.profile.model {
        return Ok(true);
    }
    let accepted = captured
        .profile
        .data
        .get::<Accepted>()
        .context("Managed Agent update has no captured instructions")?;
    let changed_instructions = instructions.is_some();
    let (text, files) = instructions.unwrap_or((&accepted.text, accepted.files.clone()));
    let workspace_text = captured
        .profile
        .data
        .get::<WorkspaceAppendix>()
        .filter(|_| changed_instructions)
        .map(|appendix| format!("{text}\n\n{}", appendix.0));
    let (mut envelope, accepted) = crate::application_instructions::prepare(
        thread,
        workspace_text.as_deref().unwrap_or(text),
        files,
    )?;
    let metadata = envelope.metadata.get_or_insert_with(Default::default);
    metadata.sdk_agent_graph = Some(profiles.opening.fingerprint.clone());
    metadata.sdk_agent_environment_policy = profiles.environment_policy_digest.clone();
    target.application_instructions = envelope;
    target
        .data
        .insert(codex_extension_api::AgentProfileInstructions {
            text: Some(accepted.text.clone()),
        });
    target.data.insert(accepted);
    if let Some(catalog) = catalog {
        let declaration = profiles
            .profiles
            .get(&captured.receipt.profile_id)
            .context("Active Agent is outside the captured declaration graph")?;
        bind_accepted_mcp(
            thread,
            &mut target,
            &declaration.declaration,
            catalog.generation.id,
            refresh_mcp,
        )
        .await?;
        target.data.insert(catalog);
    }
    thread
        .activate_agent_profile(Some(captured.receipt.clone()), Arc::new(target))
        .await?;
    Ok(true)
}

/// Bind an unpublished active candidate to the exact roster already accepted by
/// the SDK mutation. Declaration templates and existing captured sources stay owned.
async fn bind_accepted_mcp(
    thread: &CodexThread,
    target: &mut AgentProfile,
    declaration: &ProfileSpec,
    generation: u64,
    refresh_policy: bool,
) -> Result<()> {
    let current = thread.config().await;
    let environment = target.data.get::<AgentProfileEnvironment>();
    let (mcp, plugins) = prepare_profile_mcp(
        thread,
        current.mcp_servers.get().clone(),
        environment.as_deref(),
    )
    .await?;
    let policy = if refresh_policy {
        // The MCP publication has committed its callbacks. Keep their exact
        // generation and deadline rather than the opening declaration's flags.
        thread
            .thread_extension_data()
            .get::<crate::native_interception::Control>()
            .context("Agent MCP publication has no source policy owner")?
            .capture_mcp_policy(&mcp)
    } else {
        crate::native_interception::ProfileMcpPolicy::prepare(
            &mcp,
            &declaration.mcp_tools,
            generation,
        )?
    };
    let mut selection = thread
        .thread_extension_data()
        .get::<crate::mcp_result_control::McpResultControl>()
        .and_then(|control| control.capture_source_selection())
        .unwrap_or(serde_json::from_value(
            json!({"generation":generation,"servers":{}}),
        )?);
    if !refresh_policy {
        selection.generation = generation;
    }
    target.mcp = mcp;
    target.data.insert(plugins);
    target.data.insert(policy);
    target.data.insert(selection);
    Ok(())
}

pub(crate) async fn replace_tools(
    thread: &CodexThread,
    requested: u64,
    specs: ToolDeclarations,
    defaults: Option<Vec<usize>>,
    terminal_slots: &[usize],
    input_error_slots: &[usize],
) -> Result<Option<u64>> {
    let Some(profiles) = thread.thread_extension_data().get::<Arc<AgentProfiles>>() else {
        return Ok(None);
    };
    profiles.tools.check_idle(thread).await?;
    profiles.tools.check_family_idle()?;
    let Some(captured) = thread.captured_agent_profile().await? else {
        return Ok(None);
    };
    let previous = captured
        .profile
        .data
        .get::<ProfileCatalog>()
        .context("Managed Agent replacement has no captured catalog")?;
    let catalog = profiles.tools.profile_catalog(
        specs,
        &[],
        terminal_slots,
        input_error_slots,
        defaults.as_deref(),
        [
            previous.selecting_steps,
            previous.transform_context,
            previous.before_compact,
            previous.before_complete,
            previous.post_turn_compact,
            previous.tool_batch_completion,
        ],
        false,
    )?;
    let generation = catalog.generation.id;
    ensure!(
        requested == generation,
        "JavaScript tool generation is out of sequence"
    );
    update_active(thread, None, None, Some(catalog)).await?;
    Ok(Some(generation))
}

/// Restore only a typed accepted result paired by the checkpoint owner with its original call.
pub(crate) fn restore_handoff(
    state: &crate::engine::ThreadState,
    captured: &CapturedAgentProfile,
    turn: &str,
    tool_name: &ToolName,
    receipt: &codex_protocol::agent_profile::AgentProfileHandoff,
) -> Result<()> {
    ensure!(
        captured.receipt == receipt.source,
        "Restored handoff source changed"
    );
    let declarations = captured
        .profile
        .data
        .get::<codex_extension_api::AgentProfileHandoffTools>()
        .context("Restored handoff has no admitted source declarations")?;
    ensure!(
        declarations
            .targets
            .get(&tool_name.clone().with_default_namespace())
            == Some(&receipt.target_profile_id)
            || captured
                .profile
                .data
                .get::<codex_extension_api::AgentProfileDecisionHandoffTools>()
                .is_some_and(|tools| {
                    tools
                        .targets
                        .get(&tool_name.clone().with_default_namespace())
                        .is_some_and(|targets| targets.contains(&receipt.target_profile_id))
                }),
        "Restored handoff is outside its source declaration"
    );
    let profiles = state
        .thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .context("Restored handoff graph is absent")?;
    if profiles.opening.input_preparations.get(&receipt.source.profile_id)
        .is_some_and(|names| names.iter().any(|name| name == &tool_name.name)) {
        state.thread.thread_extension_data().insert(
            codex_protocol::agent_profile::AgentProfileHandoffInputRequest {
                turn_id:turn.to_owned(), tool_name:tool_name.name.clone(),
                handoff:receipt.clone(), restored:true,
            },
        );
    }
    let mut pending = profiles
        .reservation
        .lock()
        .expect("Agent reservation poisoned");
    if let Some(previous) = pending.as_mut() {
        ensure!(
            previous.turn == turn
                && previous.expected == receipt.source
                && previous.target == receipt.target_profile_id,
            "Conflicting restored Agent handoffs"
        );
        previous.calls.insert(receipt.call_id.clone());
        previous.accepted = true;
        previous.restored = true;
    } else {
        *pending = Some(Reservation {
            turn: turn.into(),
            expected: receipt.source.clone(),
            target: receipt.target_profile_id.clone(),
            calls: HashSet::from([receipt.call_id.clone()]),
            accepted: true,
            restored: true,
        });
    }
    Ok(())
}

pub(crate) async fn check_workspace_activation(
    state: &crate::engine::ThreadState,
    target: &str,
    expected: &AgentProfileReceipt,
) -> Result<()> {
    let profiles = state
        .thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .context("Captured Agent graph is not configured")?;
    profiles.tools.check_idle(&state.thread).await?;
    profiles.tools.check_family_idle()?;
    let captured = state
        .thread
        .captured_agent_profile()
        .await?
        .context("Captured Agent source is absent")?;
    ensure!(
        &captured.receipt == expected,
        "Captured Agent workspace source is stale"
    );
    ensure!(
        profiles
            .profiles
            .get(target)
            .is_some_and(|target| target.declaration.workspace_preparation),
        "Workspace target is outside its captured preparation owner"
    );
    Ok(())
}

pub(crate) async fn activate(
    state: &crate::engine::ThreadState,
    target: &str,
    expected: AgentProfileReceipt,
    workspace: Option<WorkspacePreparation>,
) -> Result<AgentProfileReceipt> {
    let profiles = state
        .thread
        .thread_extension_data()
        .get::<Arc<AgentProfiles>>()
        .context("Captured Agent graph is not configured")?;
    profiles.tools.check_idle(&state.thread).await?;
    let current = state
        .thread
        .captured_agent_profile()
        .await?
        .context("Captured Agent source is absent")?;
    ensure!(
        current.receipt == expected,
        "Captured Agent activation source is stale"
    );
    let declaration = &profiles
        .profiles
        .get(target)
        .context("Target is outside the captured graph")?
        .declaration;
    ensure!(
        !declaration.workspace_preparation || workspace.is_some(),
        "Agent activation requires its owned workspace preparation"
    );
    let candidate = profiles.workspace_candidate(&state.thread, target, workspace)?;
    Ok(state
        .thread
        .activate_agent_profile(Some(expected), candidate)
        .await?)
}

pub(crate) struct Contributor;

impl TurnLifecycleContributor for Contributor {
    fn before_step_agent_activation<'a>(
        &'a self,
        input: AgentProfileBoundaryInput<'a>,
    ) -> ExtensionFuture<'a, std::result::Result<Option<AgentProfileActivation>, String>> {
        Box::pin(async move {
            let Some(profiles) = input.thread_store.get::<Arc<AgentProfiles>>() else {
                return Ok(None);
            };
            let restored = profiles
                .reservation
                .lock()
                .expect("Agent reservation poisoned")
                .take()
                .filter(|reservation| {
                    reservation.restored
                        && reservation.accepted
                        && reservation.turn == input.turn_id
                });
            let handoff = input.accepted_handoff;
            let (expected, target_id) = match (handoff, restored) {
                (Some(handoff), Some(restored)) => {
                    if handoff.source != restored.expected
                        || handoff.target_profile_id != restored.target
                    {
                        return Err("Conflicting accepted Agent handoffs".into());
                    }
                    (handoff.source.clone(), handoff.target_profile_id.clone())
                }
                (Some(handoff), None) => {
                    (handoff.source.clone(), handoff.target_profile_id.clone())
                }
                (None, Some(restored)) => (restored.expected, restored.target),
                (None, None) => return Ok(None),
            };
            if input.active != Some(&expected) {
                return Err("Captured Agent handoff source is stale".into());
            }
            let source = profiles
                .profiles
                .get(&expected.profile_id)
                .ok_or("Accepted handoff source is outside the graph")?;
            if !source
                .declaration
                .handoffs
                .values()
                .any(|target| target == &target_id)
                && !source
                    .declaration
                    .decision_handoffs
                    .values()
                    .any(|declaration| declaration.targets.contains(&target_id))
            {
                return Err("Accepted handoff target is outside its source declaration".into());
            }
            let thread = profiles
                .thread
                .upgrade()
                .ok_or("Native Agent thread is closed")?;
            let destination = profiles
                .profiles
                .get(&target_id)
                .ok_or("Accepted handoff target is outside the graph")?;
            let workspace = if destination.declaration.workspace_preparation {
                let captured = thread
                    .captured_agent_profile()
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("Workspace activation has no captured source")?;
                if captured.receipt != expected {
                    return Err("Workspace activation source is stale".into());
                }
                let result = profiles
                    .tools
                    .prepare_agent_workspace(
                        input.thread_store.level_id(),
                        input.turn_id,
                        &captured,
                        &target_id,
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                Some(result)
            } else {
                None
            };
            let mut target = profiles
                .workspace_candidate(&thread, &target_id, workspace)
                .map_err(|error| error.to_string())?;
            if let Some(request) = input.turn_store.get::<
                codex_protocol::agent_profile::AgentProfileHandoffInputRequest,
            >() {
                let proposed = input.turn_store.get::<
                    codex_protocol::agent_profile::AgentProfileHandoffPresentation,
                >().ok_or("Handoff input lacks its native grouped proposal")?;
                if proposed.handoff != request.handoff || request.turn_id != input.turn_id {
                    return Err("Handoff input proposal belongs to another accepted call".into());
                }
                let captured = thread.captured_agent_profile().await
                    .map_err(|error| error.to_string())?.ok_or("Handoff source profile closed")?;
                let prepared = profiles.tools.prepare_handoff_input(
                    input.turn_store, input.thread_store.level_id(), input.turn_id, &captured, &request, &proposed,
                ).await.map_err(|error| error.to_string())?;
                let mut with_input = (*target).clone();
                with_input.data.insert(prepared);
                target = Arc::new(with_input);
            }
            Ok(Some(AgentProfileActivation { expected, target }))
        })
    }
}

struct HandoffExecutor {
    profiles: Arc<AgentProfiles>,
    source: AgentProfileReceipt,
    name: String,
    target: String,
    decision_selection: Option<Arc<DecisionHandoffSelection>>,
    spec: ToolSpec,
    callback: Option<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>>,
}

/// A callback failure retires only its own provisional reservation. Accepted or
/// still-running siblings retain their original native reservation owner.
struct ProvisionalHandoff<'a> {
    executor: &'a HandoffExecutor,
    turn: String,
    call: String,
    keep: bool,
}

impl Drop for ProvisionalHandoff<'_> {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        let mut pending = self
            .executor
            .profiles
            .reservation
            .lock()
            .expect("Agent reservation poisoned");
        if let Some(reservation) = pending.as_mut() {
            if reservation.turn == self.turn
                && reservation.expected == self.executor.source
                && reservation.target == self.executor.target
            {
                reservation.calls.remove(&self.call);
                if reservation.calls.is_empty() && !reservation.accepted {
                    *pending = None;
                }
            }
        }
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for HandoffExecutor {
    fn allowed_callers(&self) -> Option<ToolExposures> {
        self.callback
            .as_ref()
            .and_then(|callback| callback.allowed_callers())
            .map(|callers| callers & ToolExposures::DIRECT)
    }
    fn exposure(&self) -> ToolExposure {
        ToolExposure::DirectModelOnly
    }
    fn tool_name(&self) -> ToolName {
        ToolName::new(None, self.name.clone())
    }
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }
    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }
    fn is_automatic_function_callback(&self) -> bool {
        self.callback
            .as_ref()
            .is_some_and(|callback| callback.is_automatic_function_callback())
    }
    fn on_result_accepted(
        &self,
        turn_id: &str,
        call_id: &str,
        result: &dyn ToolOutput,
    ) -> codex_tools::AcceptedToolOutcome {
        let mut outcome = self
            .callback
            .as_ref()
            .map_or_else(Default::default, |callback| {
                callback.on_result_accepted(turn_id, call_id, result)
            });
        let handoff = (|| {
            if !result.success_for_logging() {
                return None;
            }
            let mut pending = self
                .profiles
                .reservation
                .lock()
                .expect("Agent reservation poisoned");
            let pending = pending.as_mut()?;
            if pending.turn != turn_id
                || pending.expected != self.source
                || (self.decision_selection.is_none() && pending.target != self.target)
                || !pending.calls.contains(call_id)
            {
                return None;
            }
            pending.accepted = true;
            Some(codex_protocol::agent_profile::AgentProfileHandoff {
                source: self.source.clone(),
                target_profile_id: pending.target.clone(),
                call_id: call_id.into(),
            })
        })();
        if let Some(handoff) = &handoff {
            if self.profiles.opening.input_preparations.get(&self.source.profile_id)
                .is_some_and(|names| names.contains(&self.name)) {
                if let Some(thread) = self.profiles.thread.upgrade() {
                    thread.thread_extension_data().insert(
                        codex_protocol::agent_profile::AgentProfileHandoffInputRequest {
                            turn_id:turn_id.to_owned(), tool_name:self.name.clone(),
                            handoff:handoff.clone(), restored:false,
                        },
                    );
                }
            }
        }
        // This wrapper alone owns the transfer receipt; retain other accepted metadata.
        outcome.handoff = handoff;
        outcome
    }
    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        ToolCall<'call>: 'a,
    {
        Box::pin(async move {
            if let Some(selection) = &self.decision_selection {
                let turn = call.turn_id.to_owned();
                let call_id = call.call_id.clone();
                let output = self
                    .callback
                    .as_ref()
                    .expect("Decision handoff callback")
                    .handle(call)
                    .await?;
                let target = selection.take(&turn, &call_id);
                if !output.success_for_logging() {
                    return Ok(output);
                }
                let target = target.ok_or_else(|| {
                    FunctionCallError::RespondToModel("Decision handoff requires a target".into())
                })?;
                let mut pending = self
                    .profiles
                    .reservation
                    .lock()
                    .expect("Agent reservation poisoned");
                if let Some(previous) = pending.as_mut() {
                    if previous.turn != turn
                        || previous.expected != self.source
                        || previous.target != target
                    {
                        return Err(FunctionCallError::RespondToModel(
                            "Conflicting Agent handoffs in one tool batch".into(),
                        ));
                    }
                    previous.calls.insert(call_id);
                } else {
                    *pending = Some(Reservation {
                        turn,
                        expected: self.source.clone(),
                        target,
                        calls: HashSet::from([call_id]),
                        accepted: false,
                        restored: false,
                    });
                }
                return Ok(output);
            }
            if self.callback.is_none() {
                let arguments: Value =
                    serde_json::from_str(call.function_arguments()?).map_err(|_| {
                        FunctionCallError::RespondToModel("Invalid handoff arguments".into())
                    })?;
                if !arguments
                    .as_object()
                    .is_some_and(|arguments| arguments.is_empty())
                {
                    return Err(FunctionCallError::RespondToModel(
                        "Handoffs accept no arguments".into(),
                    ));
                }
            }
            {
                let mut pending = self
                    .profiles
                    .reservation
                    .lock()
                    .expect("Agent reservation poisoned");
                if pending
                    .as_ref()
                    .is_some_and(|previous| previous.turn != call.turn_id)
                {
                    *pending = None;
                }
                if let Some(previous) = pending.as_mut() {
                    if previous.turn != call.turn_id
                        || previous.expected != self.source
                        || previous.target != self.target
                    {
                        return Err(FunctionCallError::RespondToModel(
                            "Conflicting Agent handoffs in one tool batch".into(),
                        ));
                    }
                    previous.calls.insert(call.call_id.clone());
                } else {
                    *pending = Some(Reservation {
                        turn: call.turn_id.to_owned(),
                        expected: self.source.clone(),
                        target: self.target.clone(),
                        calls: HashSet::from([call.call_id.clone()]),
                        accepted: false,
                        restored: false,
                    });
                }
            }
            let mut reservation = ProvisionalHandoff {
                executor: self,
                turn: call.turn_id.to_owned(),
                call: call.call_id.clone(),
                keep: false,
            };
            let output = if let Some(callback) = &self.callback {
                callback.handle(call).await?
            } else {
                Box::new(crate::python_tools::PythonOutput(
                codex_protocol::dynamic_tools::DynamicToolResponse {
                    content_items: vec![codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputText { text: "Handoff reserved.".into() }],
                    success: true,
                },
                )) as Box<dyn ToolOutput>
            };
            reservation.keep = output.success_for_logging();
            Ok(output)
        })
    }
}

/// The ordinary Python factory owns exact callback admission and result fencing.
pub(crate) fn wrap_handoff_callback(
    thread: &ExtensionData,
    source: Option<&AgentProfileReceipt>,
    callback: Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>,
    decision_selection: Option<Arc<DecisionHandoffSelection>>,
) -> Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>> {
    let Some(source) = source else {
        return callback;
    };
    let Some(profiles) = thread.get::<Arc<AgentProfiles>>() else {
        return callback;
    };
    let Some(profile) = profiles.profiles.get(&source.profile_id) else {
        return callback;
    };
    let callback_name = callback.tool_name().with_default_namespace();
    if let Some(selection) = decision_selection {
        if let Some((name, _)) = profile
            .declaration
            .decision_handoffs
            .iter()
            .find(|(name, _)| {
                ToolName::new(None, name.to_string()).with_default_namespace() == callback_name
            })
        {
            return Arc::new(HandoffExecutor {
                profiles: profiles.as_ref().clone(),
                source: source.clone(),
                name: name.clone(),
                target: String::new(),
                decision_selection: Some(selection),
                spec: callback.spec(),
                callback: Some(callback),
            });
        }
    }

    let Some((name, _)) = profile
        .declaration
        .handoff_callbacks
        .iter()
        .find(|(name, _)| {
            ToolName::new(None, name.to_string()).with_default_namespace() == callback_name
        })
    else {
        return callback;
    };
    let Some(target) = profile.declaration.handoffs.get(name) else {
        return callback;
    };
    Arc::new(HandoffExecutor {
        profiles: profiles.as_ref().clone(),
        source: source.clone(),
        name: name.clone(),
        target: target.clone(),
        decision_selection: None,
        spec: callback.spec(),
        callback: Some(callback),
    })
}

fn handoff_declaration(name: &str, target: &str) -> DynamicToolFunctionSpec {
    DynamicToolFunctionSpec {
        strict: false,
        output_schema: None,
        name: name.to_owned(),
        description: format!("Transfer this conversation to captured Agent {target}."),
        input_schema: json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        defer_loading: false,
    }
}

/// Project only the handoffs admitted by this immutable producing Agent profile.
pub(crate) fn is_handoff_callback(
    thread: &ExtensionData,
    source: Option<&AgentProfileReceipt>,
    name: &ToolName,
) -> bool {
    source
        .and_then(|source| {
            thread.get::<Arc<AgentProfiles>>().and_then(|profiles| {
                profiles.profiles.get(&source.profile_id).map(|profile| {
                    profile
                        .declaration
                        .handoff_callbacks
                        .contains_key(&name.name)
                })
            })
        })
        .unwrap_or(false)
}

pub(crate) fn realtime_handoff_declarations(
    handoffs: &codex_extension_api::AgentProfileHandoffTools,
    thread: &ExtensionData,
    source: Option<&AgentProfileReceipt>,
) -> Result<Vec<codex_extension_api::RealtimeToolDeclaration>> {
    handoffs
        .targets
        .iter()
        .filter(|(name, _)| !is_handoff_callback(thread, source, name))
        .map(|(name, target)| {
            let raw = handoff_declaration(&name.name, target);
            let native = dynamic_tool_to_responses_api_tool(&raw)?;
            Ok(codex_extension_api::RealtimeToolDeclaration {
                native_name: name.clone(),
                spec: codex_extension_api::PreparedToolPresentation {
                    namespace: name.namespace.clone(),
                    name: native.name,
                    kind: "function".into(),
                    description: native.description,
                    parameters: raw.input_schema,
                    strict: native.strict,
                    defer_loading: None,
                },
            })
        })
        .collect()
}

impl ToolContributor for Contributor {
    fn tools(
        &self,
        _: &ExtensionData,
        _: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        // Handoff declarations require the exact producing native step.
        Vec::new()
    }

    fn tools_for_step(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
        step: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Some(profiles) = thread.get::<Arc<AgentProfiles>>() else {
            return Vec::new();
        };
        let Some(source) = step.get::<CapturedAgentProfile>() else {
            return Vec::new();
        };
        let Some(profile) = profiles.profiles.get(&source.receipt.profile_id) else {
            return Vec::new();
        };
        profile
            .declaration
            .handoffs
            .iter()
            .filter(|(name, _)| !profile.declaration.handoff_callbacks.contains_key(*name))
            .filter_map(|(name, target)| {
                let declaration = handoff_declaration(name, target);
                let spec =
                    ToolSpec::Function(dynamic_tool_to_responses_api_tool(&declaration).ok()?);
                Some(Arc::new(HandoffExecutor {
                    profiles: profiles.as_ref().clone(),
                    source: source.receipt.clone(),
                    name: name.clone(),
                    target: target.clone(),
                    decision_selection: None,
                    spec,
                    callback: None,
                })
                    as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_graph_policy_names_include_captured_nondefault_targets_and_handoffs() {
        let mut raw = roster();
        raw[1]["tools"] = json!([{"type":"function","name":"destination_lookup",
            "description":"target","inputSchema":{"type":"object","properties":{}},"deferLoading":false}]);
        raw[1]["step_defaults"] = json!([]);
        let roster = decode_roster(&raw.to_string()).unwrap();
        let opening = OpeningProfiles {
            input_preparations: Default::default(),
            fingerprint: roster_fingerprint(&roster, "a").unwrap(),
            root_id: "a".into(),
            roster,
        };
        let names = opening.admitted_tool_names();
        for name in ["lookup", "destination_lookup", "transfer_to_b"] {
            assert!(names.contains(&ToolName::new(None, name).with_default_namespace()));
        }
        assert_eq!(names.len(), 3);
        assert!(!names.contains(&ToolName::new(None, "exec_command").with_default_namespace()));
    }

    fn roster() -> Value {
        json!([
            {"id":"a","model":{"model":"","reasoning_effort":null,"reasoning_summary":null,
                "service_tier":null,"tool_choice":null,"personality":null},
                "instructions":"Root","tools":[{"type":"function","name":"lookup",
                    "description":"Lookup A","inputSchema":{"type":"object","properties":{},
                        "additionalProperties":false},"deferLoading":false}],
                "handoffs":{"transfer_to_b":"b"},"output_fingerprint":"output-a",
                "mcp_servers":{"remote":{"url":"https://first.invalid","headers":{"Authorization":"first"}}}},
            {"id":"b","model":{"model":"destination","reasoning_effort":null,"reasoning_summary":null,
                "service_tier":null,"tool_choice":null,"personality":null},
                "instructions":"Destination","tools":[],"output_fingerprint":"output-b"}
        ])
    }

    #[test]
    fn decision_handoff_selection_requires_a_captured_call_target() {
        let selection = DecisionHandoffSelection {
            targets: vec!["a".into(), "b".into()],
            selected: Mutex::new(HashMap::new()),
        };
        assert!(selection.record("turn", "call", None, true).is_err());
        assert!(
            selection
                .record("turn", "call", Some("outside".into()), true)
                .is_err()
        );
        assert!(
            selection
                .record("turn", "call", Some("b".into()), false)
                .is_err()
        );
        selection
            .record("turn", "call", Some("b".into()), true)
            .unwrap();
        assert_eq!(selection.take("other-turn", "call"), None);
        assert_eq!(selection.take("turn", "other-call"), None);
        assert_eq!(selection.take("turn", "call"), Some("b".into()));
        assert_eq!(selection.take("turn", "call"), None);
    }

    #[test]
    fn decision_handoff_roster_preserves_identity_and_restore_authority() {
        let mut raw = roster();
        raw[0]["handoffs"] = json!({});
        raw[0]["decision_handoffs"] = json!({"lookup":{"slot":0,"targets":["a","b"]}});
        let fingerprint = fingerprint(&raw.to_string(), "a").unwrap();
        let opening = OpeningProfiles {
            input_preparations: Default::default(),
            root_id: "a".into(),
            roster: decode_roster(&raw.to_string()).unwrap(),
            fingerprint: fingerprint.clone(),
        };
        let name = ToolName::new(None, "lookup");
        let saved = codex_protocol::agent_profile::AgentProfileHandoff {
            source: AgentProfileReceipt {
                profile_id: "a".into(),
                epoch: 0,
            },
            target_profile_id: "b".into(),
            call_id: "saved-call".into(),
        };
        opening
            .validate_restored_handoff(&name, &saved, false)
            .unwrap();
        assert!(
            opening
                .validate_restored_handoff(&name, &saved, true)
                .is_err()
        );
        assert!(
            opening
                .validate_restored_handoff(&ToolName::new(None, "other"), &saved, false)
                .is_err()
        );
        assert!(
            opening
                .validate_pending_source(&AgentProfileReceipt {
                    profile_id: "b".into(),
                    epoch: 1
                })
                .is_err()
        );
        raw[0]["decision_handoffs"]["lookup"]["targets"] = json!(["a"]);
        assert_ne!(
            super::fingerprint(&raw.to_string(), "a").unwrap(),
            fingerprint
        );
        raw[0]["decision_handoffs"]["lookup"]["targets"] = json!(["outside"]);
        assert!(super::fingerprint(&raw.to_string(), "a").is_err());
        raw[0]["decision_handoffs"]["lookup"]["targets"] = json!(["a", "a"]);
        assert!(super::fingerprint(&raw.to_string(), "a").is_err());
        raw[0]["decision_handoffs"]["lookup"]["targets"] = json!(["b"]);
        raw[0]["manual_slots"] = json!([0]);
        assert!(super::fingerprint(&raw.to_string(), "a").is_err());
    }

    #[test]
    fn pending_handoff_restore_requires_live_callback_acceptance() {
        let open = |raw: Value| {
            let raw = raw.to_string();
            OpeningProfiles {
                input_preparations: Default::default(),
                root_id: "a".into(),
                roster: serde_json::from_str(&raw).unwrap(),
                fingerprint: fingerprint(&raw, "a").unwrap(),
            }
        };
        let mut raw = roster();
        let builtin = open(raw.clone());
        raw[0]["tools"].as_array_mut().unwrap().push(json!({
            "type":"function", "name":"transfer_to_b", "description":"Authorize transfer",
            "inputSchema":{"type":"object","properties":{"reason":{"type":"string"}},
                "required":["reason"],"additionalProperties":false},
            "deferLoading":false,
        }));
        raw[0]["handoff_callbacks"] = json!({"transfer_to_b":1});
        let callback = open(raw);
        let destination = AgentProfileReceipt {
            profile_id: "b".into(),
            epoch: 1,
        };
        builtin.validate_pending_source(&destination).unwrap();
        let error = callback.validate_pending_source(&destination).unwrap_err();
        assert!(error.to_string().contains("live callback acceptance"));
        let name = ToolName::new(None, "transfer_to_b");
        let saved = codex_protocol::agent_profile::AgentProfileHandoff {
            source: AgentProfileReceipt {
                profile_id: "a".into(),
                epoch: 0,
            },
            target_profile_id: "b".into(),
            call_id: "saved-call".into(),
        };
        callback.validate_pending_source(&saved.source).unwrap();
        builtin
            .validate_restored_handoff(&name, &saved, true)
            .unwrap();
        callback
            .validate_restored_handoff(&name, &saved, false)
            .unwrap();
        let error = callback
            .validate_restored_handoff(&name, &saved, true)
            .unwrap_err();
        assert!(error.to_string().contains("live acceptance"));
    }

    #[test]
    fn queued_operation_origin_is_distinct_from_admitted_and_restored_actor() {
        let raw = roster().to_string();
        let opening = OpeningProfiles {
            input_preparations: Default::default(),
            root_id: "a".into(),
            roster: serde_json::from_str(&raw).unwrap(),
            fingerprint: fingerprint(&raw, "a").unwrap(),
        };
        let envelope = |profile: &str, epoch: u64, text: &str| {
            let mut model = opening
                .roster
                .iter()
                .find(|item| item.id == profile)
                .unwrap()
                .model
                .clone();
            if model.model.is_empty() {
                model.model = "opening-model".into();
            }
            ResponseItemEnvelope {
                item: crate::application_instructions::publication(text),
                metadata: Some(codex_history::CodexHarnessMetadata {
                    sdk_agent_graph: Some(opening.fingerprint.clone()),
                    sdk_agent_profile: Some(
                        json!({"profile_id":profile,"epoch":epoch,"model":model}),
                    ),
                    client_authored: true,
                    ..Default::default()
                }),
            }
        };
        let a = envelope("a", 0, "Root");
        let b = envelope("b", 1, "Destination");
        let context = |source: Value| -> RolloutItem {
            serde_json::from_value(json!({"type":"turn_context","payload":{
                "turn_id":"queued-turn","sdk_receipt":{
                    "instruction_revision":b.item.id(),"operation_declaration_source":source
                },
                "cwd":std::env::current_dir().unwrap(),"approval_policy":"never",
                "sandbox_policy":codex_protocol::protocol::SandboxPolicy::new_read_only_policy(),
                "model":"destination","summary":"auto"
            }}))
            .unwrap()
        };
        let original = json!({"profile_id":"a","epoch":0});
        let mut history = vec![
            RolloutItem::ResponseItem(a),
            RolloutItem::ResponseItem(b.clone()),
            context(original.clone()),
        ];
        assert_eq!(restore_source(&opening, &history).unwrap().profile_id, "b");
        assert_eq!(
            operation_source(&opening, &history, "queued-turn")
                .unwrap()
                .profile_id,
            "a"
        );
        let mut compacted: codex_history::CompactedItem =
            serde_json::from_value(json!({"message":"summary"})).unwrap();
        compacted.replacement_history = Some(vec![b.clone()]);
        history.push(RolloutItem::Compacted(compacted));
        history.push(context(original));
        assert_eq!(
            operation_source(&opening, &history, "queued-turn")
                .unwrap()
                .profile_id,
            "a"
        );
        history.push(context(json!({"profile_id":"b","epoch":1})));
        assert!(operation_source(&opening, &history, "queued-turn").is_err());
        history.pop();
        history.push(context(json!({"profile_id":"a","epoch":0,"unknown":true})));
        assert!(operation_source(&opening, &history, "queued-turn").is_err());
        history.pop();
        assert!(operation_source(&opening, &history, "different-turn").is_err());
        if let RolloutItem::ResponseItem(source) = &mut history[0] {
            source.metadata.as_mut().unwrap().sdk_agent_graph = Some("different graph".into());
        }
        assert!(operation_source(&opening, &history, "queued-turn").is_err());
    }
    #[test]
    fn declaration_fingerprint_excludes_connection_credentials_but_keeps_server_identity() {
        let mut declaration = roster();
        let original = fingerprint(&declaration.to_string(), "a").unwrap();
        declaration[0]["mcp_servers"]["remote"] = json!({
            "url":"https://second.invalid","headers":{"Authorization":"second"}
        });
        assert_eq!(
            fingerprint(&declaration.to_string(), "a").unwrap(),
            original
        );
        declaration[0]["mcp_servers"] = json!({"different":{}});
        assert_ne!(
            fingerprint(&declaration.to_string(), "a").unwrap(),
            original
        );
    }

    #[test]
    fn declaration_fingerprint_pins_edges_schemas_output_and_result_policy() {
        let declaration = roster();
        let original = fingerprint(&declaration.to_string(), "a").unwrap();
        for (path, replacement) in [
            ("/0/handoffs/transfer_to_b", json!("a")),
            ("/0/tools/0/inputSchema/additionalProperties", json!(true)),
            ("/0/output_fingerprint", json!("changed retry policy")),
            ("/0/instructions", json!("Changed root")),
        ] {
            let mut changed = declaration.clone();
            *changed.pointer_mut(path).unwrap() = replacement;
            assert_ne!(
                fingerprint(&changed.to_string(), "a").unwrap(),
                original,
                "{path}"
            );
        }
        let mut changed = declaration;
        changed[0]["mcp_result_tools"] = json!({"remote":{"lookup":30.0}});
        assert_ne!(fingerprint(&changed.to_string(), "a").unwrap(), original);
    }

    #[test]
    fn persisted_receipt_accepts_initial_epoch_and_rejects_unknown_metadata() {
        let model = roster()[1]["model"].clone();
        let receipt = json!({"profile_id":"b","epoch":0,"model":model});
        assert_eq!(
            profile_receipt(&receipt).unwrap(),
            AgentProfileReceipt {
                profile_id: "b".into(),
                epoch: 0,
            }
        );
        let mut invalid = receipt;
        invalid["unrecognized_authority"] = json!(true);
        assert!(profile_receipt(&invalid).is_err());
    }
}

/// Native MCP replay cannot rerun host MCP callbacks from a checkpoint.
pub(crate) fn native_mcp_checkpoint_source(source: &CapturedAgentProfile) -> bool {
    source
        .profile
        .data
        .get::<crate::native_interception::ProfileMcpPolicy>()
        .is_some_and(|policy| !policy.has_callbacks())
        && source
            .profile
            .data
            .get::<crate::mcp_result_control::Selection>()
            .is_some_and(|selection| !selection.has_callbacks())
}

//! Thread startup options and host-provided instruction snapshots.

use std::sync::{Arc, RwLock};

use anyhow::Context;

use codex_core_api::{InitialHistory, StartThreadOptions};
use codex_extension_api::{
    Instructions, LoadInstructionsFuture, LoadedUserInstructions,
    SdkInheritedApplicationInstructions, ThreadInstructionsProvider, ToolPolicy,
    UserInstructionsProvider,
};
use codex_protocol::dynamic_tools::DynamicToolSpec;
use codex_protocol::protocol::{SessionSource, ThreadHistoryMode, ThreadSource, W3cTraceContext};
use codex_protocol::{ThreadId, ToolName};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::{config, ops};

enum InstructionState {
    Raw(Option<String>),
    Pending {
        text: Option<String>,
        manual: bool,
        files: Vec<Value>,
    },
    Accepted(crate::application_instructions::Accepted),
    Uncertain,
}

pub struct ThreadInstructions {
    state: RwLock<InstructionState>,
    managed: bool,
    shared: bool,
}

impl ThreadInstructions {
    #[cfg(test)]
    pub(crate) fn for_test(text: Option<String>, managed: bool) -> Self {
        Self::new(text, managed, false, Vec::new())
    }

    fn new(text: Option<String>, managed: bool, shared: bool, files: Vec<Value>) -> Self {
        Self {
            state: RwLock::new(if managed {
                InstructionState::Pending {
                    text,
                    manual: false,
                    files,
                }
            } else {
                InstructionState::Raw(text)
            }),
            managed,
            shared,
        }
    }

    pub fn managed(&self) -> bool {
        self.managed
    }

    pub fn check_usable(&self) -> anyhow::Result<()> {
        let state = self
            .state
            .read()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        anyhow::ensure!(
            !matches!(&*state, InstructionState::Uncertain),
            "native application instruction acceptance is uncertain; close this Session"
        );
        Ok(())
    }

    pub fn text(&self) -> anyhow::Result<Option<String>> {
        let state = self
            .state
            .read()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        match &*state {
            InstructionState::Raw(text) | InstructionState::Pending { text, .. } => {
                Ok(text.clone())
            }
            InstructionState::Accepted(accepted) => Ok(Some(accepted.text.clone())),
            InstructionState::Uncertain => anyhow::bail!(
                "native application instruction acceptance is uncertain; close this Session"
            ),
        }
    }

    pub fn accepted(&self) -> Option<crate::application_instructions::Accepted> {
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match &*state {
            InstructionState::Accepted(accepted) => Some(accepted.clone()),
            _ => None,
        }
    }

    pub fn confirm(
        &self,
        mut accepted: crate::application_instructions::Accepted,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.managed,
            "application instruction receipt requires a managed Session"
        );
        let mut state = self
            .state
            .write()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        anyhow::ensure!(
            !matches!(&*state, InstructionState::Uncertain),
            "native application instruction acceptance is uncertain; close this Session"
        );
        accepted.files = match &*state {
            InstructionState::Pending { text, files, .. }
                if text.as_deref().unwrap_or_default() == accepted.text =>
            {
                files.clone()
            }
            InstructionState::Accepted(prior) if prior.id == accepted.id => prior.files.clone(),
            _ => accepted.files.clone(),
        };
        *state = InstructionState::Accepted(accepted);
        Ok(())
    }

    pub fn defer_manual(&self) -> anyhow::Result<()> {
        let mut state = self
            .state
            .write()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        if let InstructionState::Pending { manual, .. } = &mut *state {
            *manual = true;
        }
        Ok(())
    }

    pub fn needs_publication(&self, include_legacy_manual: bool) -> bool {
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        matches!(&*state, InstructionState::Pending { manual, .. } if !manual || include_legacy_manual)
    }

    pub fn retire_uncertain(&self) {
        *self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = InstructionState::Uncertain;
    }
}

pub struct EmptyUserInstructions;

impl UserInstructionsProvider for EmptyUserInstructions {
    fn load_user_instructions(&self) -> LoadInstructionsFuture<'_> {
        Box::pin(async { LoadedUserInstructions::default() })
    }
}

impl ThreadInstructionsProvider for ThreadInstructions {
    fn load_thread_instructions(&self) -> LoadInstructionsFuture<'_> {
        Box::pin(async {
            match self.state.read() {
                Ok(state) => {
                    // Core may share this exact provider with children and gives
                    // it no caller id. Keep that provider for opted-in sharing.
                    // A legacy manual continuation still uses its original raw
                    // declaration until its sealed turn has finished.
                    let text = match &*state {
                        InstructionState::Raw(text) => text.clone(),
                        InstructionState::Pending { text, manual, .. }
                            if *manual || self.shared =>
                        {
                            text.clone()
                        }
                        InstructionState::Accepted(receipt) if self.shared => {
                            Some(receipt.text.clone())
                        }
                        _ => None,
                    };
                    LoadedUserInstructions {
                        instructions: text.map(|text| Instructions { text, source: None }),
                        warnings: Vec::new(),
                    }
                }
                Err(_) => LoadedUserInstructions {
                    instructions: None,
                    warnings: vec!["thread instructions unavailable".into()],
                },
            }
        })
    }

    fn share_with_subagents(&self) -> bool {
        self.shared
    }
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ThreadOptions {
    #[serde(rename = "_provider_history")]
    provider_history: Option<codex_protocol::provider_history::ProviderHistorySelection>,
    #[serde(rename = "_context_callbacks")]
    context_callbacks: crate::python_tools::ContextCallbacks,
    #[serde(rename = "_sdk_profile_provider_keys")]
    profile_provider_keys: std::collections::BTreeMap<String, String>,
    #[serde(rename = "_agent_profiles")]
    pub(crate) agent_profiles: Option<crate::agent_profiles::OpeningProfiles>,
    #[serde(rename = "_sdk_resume_thread_id")]
    pub(crate) sdk_resume_thread_id: Option<ThreadId>,
    #[serde(rename = "_sdk_reconciled_calls")]
    pub(crate) sdk_reconciled_calls: Vec<crate::local_reconciliation::Receipt>,
    #[serde(rename = "_native_agent_roles")]
    native_agent_roles: Option<Vec<String>>,
    #[serde(rename = "_native_agent_tools")]
    native_agent_tools: Vec<codex_core::ManagedAgentToolSpec>,
    #[serde(rename = "_native_agent_before_step")]
    native_agent_before_step: bool,
    #[serde(rename = "_native_agent_max_depth")]
    native_agent_max_depth: Option<usize>,
    // Private native Agent.session admission, never the outer SDK Runner.
    #[serde(rename = "_managed_instructions")]
    managed_instructions: bool,
    #[serde(rename = "_sdk_instruction_files")]
    instruction_files: Vec<Value>,
    #[serde(rename = "_sdk_request_transport")]
    sdk_request_transport:
        Option<codex_protocol::model_request_transport::RequestTransportOverrides>,
    config: Map<String, Value>,
    runtime: Map<String, Value>,
    instructions: Option<String>,
    share_instructions_with_subagents: bool,
    allow_provider_model_fallback: bool,
    initial_history: Option<InitialHistory>,
    history_mode: Option<ThreadHistoryMode>,
    session_source: Option<SessionSource>,
    thread_source: Option<ThreadSource>,
    dynamic_tools: Vec<DynamicToolSpec>,
    #[serde(rename = "_buffered_responses", default)]
    buffered_responses: bool,
    #[serde(rename = "_hosted_tools")]
    hosted_tools: Vec<codex_tools::HostedToolSpec>,
    metrics_service_name: Option<String>,
    parent_trace: Option<W3cTraceContext>,
    environments: Option<Value>,
    #[serde(rename = "_canonical_rules", default)]
    canonical_rules: bool,
    reserved_thread_id: Option<ThreadId>,
    disabled_plugin_ids: Option<Vec<String>>,
    client_mcp_extensions: Map<String, Value>,
    user_instructions: Option<UserInstructions>,
    user_instructions_appendix: Option<String>,
    tool_policy: Option<Policy>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Policy {
    allowed_tools: Option<Vec<ToolName>>,
    allowed_mcp_tools: Option<Vec<(String, String, ToolName)>>,
    require_managed_sandbox: bool,
    require_unified_exec: bool,
    expose_additional_permissions: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserInstructions {
    instructions: Option<InstructionText>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstructionText {
    text: String,
    source: Option<codex_core_api::AbsolutePathBuf>,
}

impl ThreadOptions {
    pub(crate) fn validate_initial_messages(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.managed_instructions
                && self.sdk_resume_thread_id.is_none()
                && self.initial_history.is_none()
                && self.reserved_thread_id.is_none(),
            "initial messages require a managed fresh root without history or reserved identity"
        );
        Ok(())
    }

    pub(crate) fn matches_private_inputs(&self, config: &Value, runtime: &Value) -> bool {
        config.as_object() == Some(&self.config) && runtime.as_object() == Some(&self.runtime)
    }

    pub(crate) fn validate_local_authority(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.client_mcp_extensions.is_empty(),
            "local storage does not support client MCP extensions"
        );
        Ok(())
    }

    pub fn validate_instruction_json(&self, history: &Value) -> anyhow::Result<()> {
        if self.managed_instructions {
            let parsed = crate::application_instructions::decode(history.clone())?;
            self.validate_instructions(&parsed)?;
        }
        Ok(())
    }
    pub fn validate_instructions(
        &self,
        history: &[codex_history::RolloutItem],
    ) -> anyhow::Result<Option<crate::application_instructions::Accepted>> {
        if self.managed_instructions {
            if let Some(opening) = &self.agent_profiles {
                return crate::agent_profiles::validate_restored(opening, history).map(Some);
            }
            crate::application_instructions::validate(
                history,
                self.instructions.as_deref().unwrap_or(""),
            )
        } else {
            Ok(None)
        }
    }

    pub async fn build(
        self,
        base_config: &str,
        base_runtime: &str,
        cloud: codex_config::CloudConfigBundleLoader,
    ) -> anyhow::Result<(StartThreadOptions, Arc<ThreadInstructions>)> {
        let base: Map<String, Value> = serde_json::from_str(base_runtime)?;
        for key in [
            "_native_interception_http",
            "_sdk_codex_login",
            "environment",
            "codex_home",
            "native_thread_store",
            "_sdk_resume_thread_id",
            "native_goal_store",
            "codex_self_exe",
            "codex_linux_sandbox_exe",
            "code_mode_host_exe",
            "linux_sandbox_pid_namespace",
            "proxy_private_ips_via_upstream",
            "allowed_symlinked_codex_home",
        ] {
            if let Some(value) = self.runtime.get(key) {
                anyhow::ensure!(
                    base.get(key) == Some(value),
                    "{key} belongs to the Codex client runtime; create a separate client to change it"
                );
            }
        }
        let runtime = merged(base_runtime, self.runtime)?;
        let source = merged(base_config, self.config)?;
        let mut configuration = config::load(&source, &runtime, Some(cloud)).await?.0;
        if let Some(selection) = &self.provider_history {
            selection.validate_shape().map_err(anyhow::Error::msg)?;
        }
        configuration.sdk_provider_history = self.provider_history;
        if let Some(transport) = self.sdk_request_transport {
            let controls = codex_protocol::model_request_controls::ModelRequestControls {
                request_transport: Some(Some(transport)),
                ..Default::default()
            };
            controls.validate_shape().map_err(anyhow::Error::msg)?;
            configuration.sdk_request_controls.apply_patch(&controls);
        }
        let mut options = StartThreadOptions::new(configuration);
        options.thread_extension_init.insert(self.context_callbacks);
        options
            .thread_extension_init
            .insert(codex_core::BufferedResponsesPreference(
                self.buffered_responses,
            ));
        options
            .thread_extension_init
            .insert(codex_extension_api::HostedModelTools {
                tools: self.hosted_tools,
            });
        anyhow::ensure!(
            !self.native_agent_before_step || self.native_agent_roles.is_some(),
            "Child step selection requires NativeAgents roles"
        );
        anyhow::ensure!(
            self.native_agent_tools.is_empty() || self.native_agent_roles.is_some(),
            "Native role tools require NativeAgents roles"
        );
        if self.native_agent_before_step {
            options
                .thread_extension_init
                .insert(crate::python_tools::ChildStepSelection);
        }
        if let Some(roles) = self.native_agent_roles {
            anyhow::ensure!(
                config::native_agents(&runtime)?,
                "Native agents require their initial runtime declaration"
            );
            let max_depth = self.native_agent_max_depth.unwrap_or(1);
            anyhow::ensure!(max_depth > 0, "NativeAgents max_depth must be positive");
            let inherited_instructions = self.instructions.as_deref().and_then(|text| {
                // Core trims configured subagent instructions before applying them to children.
                let text = text.trim();
                (!text.is_empty()
                    && !self.instruction_files.is_empty()
                    && options
                        .config
                        .multi_agent_v2
                        .subagent_developer_instructions
                        .as_deref()
                        == Some(text))
                .then(|| {
                    Arc::new(SdkInheritedApplicationInstructions {
                        developer_sha256: crate::application_instructions::sha256(text),
                        files: self.instruction_files.clone(),
                    })
                })
            });
            options
                .thread_extension_init
                .insert(crate::native_agents::Policy {
                    roles,
                    managed_tools: self
                        .native_agent_tools
                        .iter()
                        .map(|tool| tool.name.clone())
                        .collect(),
                    max_depth,
                    inherited_instructions,
                    allowed: Default::default(),
                });
            if !self.native_agent_tools.is_empty() {
                options.thread_extension_init.insert(
                    codex_core::ManagedAgentToolCatalog::new(self.native_agent_tools)
                        .map_err(anyhow::Error::msg)?,
                );
            }
        }

        let profile_files = self
            .agent_profiles
            .as_ref()
            .map(|_| self.instruction_files.clone());
        options
            .thread_extension_init
            .insert(ThreadInstructions::new(
                self.instructions,
                self.managed_instructions,
                self.share_instructions_with_subagents,
                self.instruction_files,
            ));
        let instructions = options
            .thread_extension_init
            .get::<ThreadInstructions>()
            .expect("inserted thread instructions");

        options.thread_instructions_provider = Some(instructions.clone());
        if let Some(profiles) = self.agent_profiles {
            crate::agent_profiles::install_opening(
                &mut options,
                profiles,
                profile_files.unwrap_or_default(),
            )?;
        }
        if !self.profile_provider_keys.is_empty() {
            options.thread_extension_init.insert(
                crate::agent_profiles::PendingProviderKeys(self.profile_provider_keys),
            );
        }
        options.allow_provider_model_fallback = self.allow_provider_model_fallback;
        options.initial_history = self.initial_history.unwrap_or(InitialHistory::New);
        options.history_mode = self.history_mode;
        options.session_source = self.session_source;
        options.thread_source = self.thread_source;
        options.dynamic_tools = self.dynamic_tools;
        options.metrics_service_name = self.metrics_service_name;
        options.parent_trace = self.parent_trace;
        let environment = config::environment(base_runtime)?;
        if self.canonical_rules {
            let trusted = environment
                .as_ref()
                .context("Project guidance requires an explicit primary executor")?;
            options
                .thread_extension_init
                .insert(crate::canonical_rules::Rules::new(
                    trusted.trusted_root().clone(),
                    trusted.id(),
                ));
        }
        // An explicit empty selection also clears roots restored from history.
        options.thread_extension_init.insert(
            environment
                .as_ref()
                .and_then(|env| env.capability_roots())
                .unwrap_or_default(),
        );
        if self.environments.is_none() && environment.is_some() {
            options
                .thread_extension_init
                .insert(crate::native_interception::EagerCommandEnvironment(true));
        }
        options.environments = self.environments.map(ops::environments).transpose()?;
        options.reserved_thread_id = self.reserved_thread_id;
        options.disabled_plugin_ids = self.disabled_plugin_ids;
        options.client_mcp_extensions =
            codex_protocol::mcp::ClientMcpExtensions::new(self.client_mcp_extensions);
        options.user_instructions_appendix = self.user_instructions_appendix;
        options.user_instructions = self.user_instructions.map(|user| LoadedUserInstructions {
            instructions: user.instructions.map(|i| Instructions {
                text: i.text,
                source: i.source,
            }),
            warnings: user.warnings,
        });
        if let Some(policy) = self.tool_policy {
            options.thread_extension_init.insert(ToolPolicy {
                allowed_tools: policy.allowed_tools,
                allowed_mcp_tools: policy.allowed_mcp_tools,
                require_managed_sandbox: policy.require_managed_sandbox,
                require_unified_exec: policy.require_unified_exec,
                expose_additional_permissions: policy.expose_additional_permissions.unwrap_or(true),
            });
        }
        Ok((options, instructions))
    }
}

fn merged(base: &str, overrides: Map<String, Value>) -> anyhow::Result<String> {
    let mut result: Value = serde_json::from_str(base)?;
    merge_objects(&mut result, Value::Object(overrides));
    Ok(serde_json::to_string(&result)?)
}

fn merge_objects(base: &mut Value, overrides: Value) {
    match (base, overrides) {
        (Value::Object(base), Value::Object(overrides)) => {
            for (key, value) in overrides {
                merge_objects(base.entry(key).or_insert(Value::Null), value);
            }
        }
        (base, value) => *base = value,
    }
}

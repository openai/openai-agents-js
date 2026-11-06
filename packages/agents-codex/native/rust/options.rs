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
            _ => Vec::new(),
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
    #[serde(rename = "_sdk_resume_thread_id")]
    pub(crate) sdk_resume_thread_id: Option<ThreadId>,
    #[serde(rename = "_sdk_reconciled_calls")]
    pub(crate) sdk_reconciled_calls: Vec<crate::local_reconciliation::Receipt>,
    #[serde(rename = "_native_agent_roles")]
    native_agent_roles: Option<Vec<String>>,
    #[serde(rename = "_native_agent_before_step")]
    native_agent_before_step: bool,
    #[serde(rename = "_native_agent_max_depth")]
    native_agent_max_depth: Option<usize>,
    // Private native Agent.session admission, never the outer SDK Runner.
    #[serde(rename = "_managed_instructions")]
    managed_instructions: bool,
    #[serde(rename = "_sdk_instruction_files")]
    instruction_files: Vec<Value>,
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
    metrics_service_name: Option<String>,
    parent_trace: Option<W3cTraceContext>,
    environments: Option<Value>,
    #[serde(rename = "_canonical_rules", default)]
    canonical_rules: bool,
    reserved_thread_id: Option<ThreadId>,
    disabled_plugin_ids: Option<Vec<String>>,
    client_mcp_extensions: Map<String, Value>,
    user_instructions: Option<UserInstructions>,
    tool_policy: Option<Policy>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Policy {
    allowed_tools: Option<Vec<ToolName>>,
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
        self.build_with_first_root(base_config, base_runtime, cloud, None)
            .await
    }

    pub(crate) async fn build_with_first_root(
        self,
        base_config: &str,
        base_runtime: &str,
        cloud: codex_config::CloudConfigBundleLoader,
        prepared: Option<Box<codex_core_api::Config>>,
    ) -> anyhow::Result<(StartThreadOptions, Arc<ThreadInstructions>)> {
        let plain_root = self.sdk_resume_thread_id.is_none()
            && self.sdk_reconciled_calls.is_empty()
            && self.native_agent_roles.is_none()
            && !self.native_agent_before_step
            && self.reserved_thread_id.is_none()
            && self.environments.is_none()
            && !self.canonical_rules
            && self.session_source.is_none()
            && self.thread_source.is_none()
            && self
                .initial_history
                .as_ref()
                .is_none_or(|history| matches!(history, InitialHistory::New));
        let base: Map<String, Value> = serde_json::from_str(base_runtime)?;
        for key in [
            "_native_interception_http",
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
        let configuration = match prepared {
            Some(config)
                if plain_root
                    && serde_json::from_str::<Value>(&source)?
                        == serde_json::from_str::<Value>(base_config)?
                    && serde_json::from_str::<Value>(&runtime)?
                        == serde_json::from_str::<Value>(base_runtime)? =>
            {
                *config
            }
            _ => config::load(&source, &runtime, Some(cloud)).await?.0,
        };
        let mut options = StartThreadOptions::new(configuration);
        anyhow::ensure!(
            !self.native_agent_before_step || self.native_agent_roles.is_some(),
            "Child step selection requires NativeAgents roles"
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
                    max_depth,
                    inherited_instructions,
                    allowed: Default::default(),
                });
        }

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

#[cfg(test)]
mod first_root_tests {
    use super::*;

    async fn inputs() -> (
        tempfile::TempDir,
        String,
        String,
        std::path::PathBuf,
        codex_core_api::Config,
    ) {
        let home = tempfile::tempdir().unwrap();
        let user = home.path().join("config.toml");
        std::fs::write(&user, "model_reasoning_effort = 'low'\n").unwrap();
        let source = serde_json::json!({"model":"gpt-5", "mcp_servers":{}}).to_string();
        let runtime = config::prepare_runtime(
            &serde_json::json!({
                "codex_home":home.path(), "cwd":home.path(),
                "loader":{"user_config_path":user,"ignore_user_config":false}
            })
            .to_string(),
        )
        .unwrap();
        let loaded = config::load(&source, &runtime, None).await.unwrap().0;
        (home, source, runtime, user, loaded)
    }

    #[tokio::test]
    async fn matching_first_inputs_use_one_coherent_view_but_raw_build_reloads() {
        let (_home, source, runtime, user, prepared) = inputs().await;
        std::fs::write(user, "[broken").unwrap();
        // JSON formatting and a repeated identical override are not input changes.
        let options: ThreadOptions =
            config::decode(serde_json::json!({"config":{"model":"gpt-5"}})).unwrap();
        let (_startup, _) = options
            .build_with_first_root(
                &source,
                &runtime,
                Default::default(),
                Some(Box::new(prepared)),
            )
            .await
            .unwrap();
        assert!(
            ThreadOptions::default()
                .build(&source, &runtime, Default::default())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn changed_overrides_discard_prepared_view_and_reload() {
        let (_home, source, runtime, user, prepared) = inputs().await;
        std::fs::write(user, "[broken").unwrap();
        let options: ThreadOptions =
            config::decode(serde_json::json!({"config":{"model":"another-model"}})).unwrap();
        assert!(
            options
                .build_with_first_root(
                    &source,
                    &runtime,
                    Default::default(),
                    Some(Box::new(prepared))
                )
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn non_root_options_cannot_use_prepared_view() {
        let (_home, source, runtime, user, prepared) = inputs().await;
        std::fs::write(user, "[broken").unwrap();
        let options: ThreadOptions =
            config::decode(serde_json::json!({"_canonical_rules":true})).unwrap();
        assert!(
            options
                .build_with_first_root(
                    &source,
                    &runtime,
                    Default::default(),
                    Some(Box::new(prepared))
                )
                .await
                .is_err()
        );
    }
}

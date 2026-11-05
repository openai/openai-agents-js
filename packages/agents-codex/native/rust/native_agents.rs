//! Native child role and tool admission, shared by direct and programmatic calls.
use anyhow::{Context, ensure};
use codex_core_api::{Config, Feature};
use codex_extension_api::{SdkInheritedApplicationInstructions, ToolPolicy};
use codex_models_manager::manager::{RefreshStrategy, SharedModelsManager};
use codex_protocol::openai_models::{ConfigShellToolType, ModelInfo, ReasoningEffort, ToolMode};
use codex_tools::ToolName;
use std::sync::{Arc, OnceLock};

// Freeze the root and all current application-declared role models before an
// environment is attached. Role files are created by the SDK, never restored
// from historical instructions or model-selected overrides.
pub async fn validated_catalog(
    config: &Config,
    models: &SharedModelsManager,
    retained_models: &[String],
) -> anyhow::Result<Vec<ModelInfo>> {
    #[derive(serde::Deserialize)]
    struct DeclaredRole {
        model: Option<String>,
        model_reasoning_effort: Option<ReasoningEffort>,
    }

    let root_model = config
        .model
        .as_ref()
        .context("NativeAgents requires an explicit model")?;
    let mut catalog = vec![validate_model(config, models, root_model).await?];
    let mut roles = Vec::new();
    for role in config.agent_roles.values() {
        if let Some(path) = &role.config_file {
            let source = tokio::fs::read_to_string(path).await?;
            let declaration: DeclaredRole = toml::from_str(&source)?;
            if let Some(model) = &declaration.model
                && !catalog.iter().any(|info| &info.slug == model)
            {
                let info = validate_model(config, models, model).await?;
                ensure!(
                    !config.features.enabled(Feature::CodeMode)
                        || matches!(
                            info.tool_mode,
                            Some(ToolMode::CodeMode | ToolMode::CodeModeOnly)
                        ),
                    "Native role model metadata is incompatible with Session Code Mode"
                );
                catalog.push(info);
            }
            roles.push(declaration);
        }
    }
    // Retained open children can resume with their stored model after Core
    // applies current role config. Resolve against the original current manager,
    // before freezing a restricted catalog that would otherwise invent fallback
    // metadata for an absent saved slug. Keep the real metadata for cold reloads.
    for model in retained_models {
        if !catalog.iter().any(|info| &info.slug == model) {
            catalog.push(validate_model(config, models, model).await?);
        }
    }
    for role in roles {
        if let Some(effort) = role.model_reasoning_effort {
            // A role without its own model inherits whichever admitted parent
            // delegated to it, including another role at a deeper level.
            ensure!(
                effort != ReasoningEffort::Persistent
                    && catalog
                        .iter()
                        .filter(|info| role.model.as_ref().is_none_or(|model| model == &info.slug))
                        .all(|info| info
                            .supported_reasoning_levels
                            .iter()
                            .any(|preset| preset.effort == effort)),
                "Native role reasoning effort is incompatible with its possible models"
            );
        }
    }
    Ok(catalog)
}

async fn validate_model(
    config: &Config,
    models: &SharedModelsManager,
    model: &str,
) -> anyhow::Result<ModelInfo> {
    let info = models
        .get_model_info(model, &config.to_models_manager_config())
        .await;
    crate::engine::EngineState::validate_hosted_search(config, &info)?;
    ensure!(
        !info.used_fallback_model_metadata
            && !matches!(info.shell_type, ConfigShellToolType::Disabled)
            && info.apply_patch_tool_type.is_some()
            && (matches!(info.tool_mode, None | Some(ToolMode::Direct))
                || (matches!(
                    info.tool_mode,
                    Some(ToolMode::CodeMode | ToolMode::CodeModeOnly)
                ) && (config.features.enabled(Feature::CodeMode)
                    || (config
                        .code_mode
                        .direct_only_tool_namespaces
                        .iter()
                        .any(|name| name == "functions")
                        && config
                            .code_mode
                            .direct_only_tool_namespaces
                            .iter()
                            .any(|name| name == "collaboration"))))),
        "The selected model metadata is incompatible with NativeAgents"
    );
    // No online refresh or provider fallback expands this admission decision.
    let selected = models
        .get_default_model(
            &Some(model.to_owned()),
            false,
            RefreshStrategy::Offline,
            config.http_client_factory(),
        )
        .await;
    ensure!(
        selected == model,
        "NativeAgents model selection did not match"
    );
    Ok(info)
}

pub struct Policy {
    pub roles: Vec<String>,
    pub max_depth: usize,
    pub inherited_instructions: Option<Arc<SdkInheritedApplicationInstructions>>,
    // Current startup policy is host authority. Core reads its own copy before
    // child lifecycle callbacks, so every direct dispatch checks this ceiling.
    pub allowed: OnceLock<Arc<ToolPolicy>>,
}

impl Policy {
    fn explicitly_allows(&self, name: &ToolName) -> bool {
        self.allowed
            .get()
            .is_some_and(|policy| policy.allowed_tools.is_some() && policy.allows(name))
    }

    pub fn admits(&self, depth: usize, item: &codex_protocol::models::ResponseItem) -> bool {
        use codex_protocol::models::ResponseItem;
        match item {
            ResponseItem::FunctionCall {
                name,
                namespace,
                arguments,
                ..
            } => {
                let allowed =
                    self.explicitly_allows(&ToolName::new(namespace.clone(), name.clone()));
                if !allowed {
                    return false;
                }
                if namespace.as_deref() != Some("collaboration") {
                    // The Code Mode wrapper requires an explicit current
                    // ToolPolicy grant, just like each nested dispatch.
                    return true;
                }
                if (depth != 0 && self.max_depth == 1)
                    || (name == "spawn_agent" && depth >= self.max_depth)
                {
                    return false;
                }
                if name != "spawn_agent" {
                    return matches!(
                        name.as_str(),
                        "wait_agent"
                            | "send_message"
                            | "followup_task"
                            | "interrupt_agent"
                            | "list_agents"
                    );
                }
                let Ok(serde_json::Value::Object(arguments)) = serde_json::from_str(arguments)
                else {
                    return false;
                };
                if arguments.contains_key("model") || arguments.contains_key("reasoning_effort") {
                    return false;
                }
                let role = match arguments.get("agent_type") {
                    None | Some(serde_json::Value::Null) => "default",
                    Some(serde_json::Value::String(role)) => role,
                    _ => return false,
                };
                matches!(role, "default" | "explorer" | "worker")
                    || self.roles.iter().any(|allowed| allowed == role)
            }
            ResponseItem::CustomToolCall {
                name, namespace, ..
            } => {
                namespace
                    .as_deref()
                    .is_none_or(|ns| matches!(ns, "functions" | ""))
                    && matches!(name.as_str(), "apply_patch" | "exec")
                    && self.explicitly_allows(&ToolName::new(namespace.clone(), name.clone()))
            }
            _ => false,
        }
    }

    pub(crate) fn admits_nested(
        &self,
        depth: usize,
        invocation: &codex_code_mode::CodeModeNestedToolCall,
    ) -> bool {
        let name = &invocation.tool_name;
        if !self.explicitly_allows(name) {
            return false;
        }
        match invocation.tool_kind {
            codex_code_mode::CodeModeToolKind::Freeform => {
                name.is_default_namespace() && name.name == "apply_patch"
            }
            codex_code_mode::CodeModeToolKind::Function => {
                if name.namespace.as_deref() != Some("collaboration") {
                    return true;
                }
                if (depth != 0 && self.max_depth == 1)
                    || (name.name == "spawn_agent" && depth >= self.max_depth)
                {
                    return false;
                }
                if name.name != "spawn_agent" {
                    return matches!(
                        name.name.as_str(),
                        "wait_agent"
                            | "send_message"
                            | "followup_task"
                            | "interrupt_agent"
                            | "list_agents"
                    );
                }
                let Some(serde_json::Value::Object(args)) = invocation.input.as_ref() else {
                    return false;
                };
                if args.contains_key("model") || args.contains_key("reasoning_effort") {
                    return false;
                }
                let role = match args.get("agent_type") {
                    None | Some(serde_json::Value::Null) => "default",
                    Some(serde_json::Value::String(role)) => role,
                    _ => return false,
                };
                matches!(role, "default" | "explorer" | "worker")
                    || self.roles.iter().any(|allowed| allowed == role)
            }
        }
    }
}

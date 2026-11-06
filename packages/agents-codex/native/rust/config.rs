//! Native configuration loading; defaults and precedence stay owned by Codex.
use anyhow::{Context, Result, bail};
use codex_config::{CloudConfigBundleLoader, LoaderOverrides};
use codex_core::config::{ConfigBuilder, ConfigOverrides};
use codex_core_api::{AbsolutePathBuf, Config, SqliteConfig};
use codex_protocol::config_types::{ApprovalsReviewer, Personality, SandboxMode};
use codex_protocol::models::PermissionProfile;
use codex_protocol::protocol::AskForApproval;
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// Unlike ordinary nested Option decoding, JSON null explicitly clears a value.
pub fn optional<'de, D, T>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Native serde types often ignore unknown fields; a bridge must not lose options.
pub fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    let mut ignored = Vec::new();
    let result = serde_ignored::deserialize(value, |path| ignored.push(path.to_string()))?;
    if !ignored.is_empty() {
        bail!("unknown options: {}", ignored.join(", "));
    }
    Ok(result)
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct RuntimeOptions {
    #[serde(rename = "_native_agents")]
    native_agents: bool,
    #[serde(rename = "_sdk_selected_model")]
    sdk_selected_model: bool,
    // Set by Agent.session before creating the runtime, never by a turn.
    // Interceptor-enabled Agent.session selects transport before constructing
    // the model provider. Keep this on the live runtime, never in saved TOML.
    #[serde(rename = "_native_interception_http")]
    native_interception_http: Option<crate::native_interception::Scope>,
    // The facade owns this signal on its live runtime; checkpoint runtime is ignored.
    #[serde(rename = "_sdk_native_config")]
    sdk_native_config: bool,
    environment: Option<crate::environment::EnvironmentOptions>,
    codex_home: Option<PathBuf>,
    native_goal_store: Option<AbsolutePathBuf>,
    native_thread_store: Option<AbsolutePathBuf>,
    #[serde(rename = "_sdk_resume_thread_id")]
    sdk_resume_thread_id: Option<codex_protocol::ThreadId>,
    #[serde(default = "strict_by_default")]
    strict_config: bool,
    fallback_cwd: Option<PathBuf>,
    loader: LoaderOptions,
    linux_sandbox_pid_namespace: Option<String>,
    proxy_private_ips_via_upstream: Option<bool>,
    model_provider_include_internal_metadata: Option<bool>,
    code_mode_host_exe: Option<PathBuf>,
    #[cfg(target_os = "macos")]
    allowed_symlinked_codex_home: Option<AbsolutePathBuf>,
    model: Option<String>,
    review_model: Option<String>,
    cwd: Option<PathBuf>,
    approval_policy: Option<AskForApproval>,
    approvals_reviewer: Option<ApprovalsReviewer>,
    sandbox_mode: Option<SandboxMode>,
    permission_profile: Option<PermissionProfile>,
    default_permissions: Option<String>,
    persisted_permission_profile_id: Option<String>,
    model_provider: Option<String>,
    #[serde(deserialize_with = "optional")]
    service_tier: Option<Option<String>>,
    codex_self_exe: Option<PathBuf>,
    codex_linux_sandbox_exe: Option<PathBuf>,
    main_execve_wrapper_exe: Option<PathBuf>,
    default_zsh_path: Option<AbsolutePathBuf>,
    base_instructions: Option<String>,
    developer_instructions: Option<String>,
    personality: Option<Personality>,
    compact_prompt: Option<String>,
    show_raw_agent_reasoning: Option<bool>,
    tools_web_search_request: Option<bool>,
    ephemeral: Option<bool>,
    bypass_hook_trust: Option<bool>,
    additional_writable_roots: Vec<PathBuf>,
    workspace_roots: Option<Vec<AbsolutePathBuf>>,
}

impl RuntimeOptions {
    pub(crate) fn from_json(runtime_json: &str) -> Result<Self> {
        decode(serde_json::from_str(runtime_json)?)
    }

    pub(crate) fn environment(&self) -> Option<crate::environment::EnvironmentOptions> {
        self.environment.clone()
    }

    pub(crate) fn native_agents(&self) -> bool {
        self.native_agents
    }

    pub(crate) fn sdk_selected_model(&self) -> bool {
        self.sdk_selected_model
    }

    pub(crate) fn sdk_native_config(&self) -> bool {
        self.sdk_native_config
    }

    pub(crate) fn native_thread_store(&self) -> Option<AbsolutePathBuf> {
        self.native_thread_store.clone()
    }

    pub(crate) fn native_goal_store_enabled(&self) -> bool {
        self.native_goal_store.is_some()
    }

    pub(crate) fn sdk_resume_thread_id(&self) -> Option<codex_protocol::ThreadId> {
        self.sdk_resume_thread_id
    }

    pub(crate) fn code_mode_provider(
        &self,
        config: &Config,
    ) -> Option<Arc<dyn codex_code_mode::CodeModeSessionProvider>> {
        if !code_mode_host_enabled(config) {
            return None;
        }
        self.code_mode_host_exe.clone().map(|program| {
            Arc::new(codex_code_mode::ProcessOwnedCodeModeSessionProvider::with_host_program(program))
                as Arc<dyn codex_code_mode::CodeModeSessionProvider>
        })
    }
}

/// Supply native path metadata without creating a home or loading ambient config.
pub fn prepare_runtime(runtime_json: &str) -> Result<String> {
    prepare_runtime_for_first_root(runtime_json).map(|(runtime, _)| runtime)
}

pub(crate) fn prepare_runtime_for_first_root(runtime_json: &str) -> Result<(String, bool)> {
    let mut runtime: serde_json::Map<String, Value> = serde_json::from_str(runtime_json)?;
    // Preserve provenance before preparation supplies isolated system/managed
    // paths. Explicit loader paths/profiles/policy overrides always reload.
    let isolated_loader = runtime.get("loader").is_none_or(|loader| {
        loader.as_object().is_some_and(|fields| {
            fields
                .keys()
                .all(|key| matches!(key.as_str(), "ignore_user_config" | "ignore_project_config"))
        })
    });
    let home =
        std::env::temp_dir().join(format!("codex-agents-{}", codex_protocol::ThreadId::new()));
    if runtime.get("codex_home").is_none_or(Value::is_null) {
        runtime.insert("codex_home".into(), serde_json::to_value(home.as_path())?);
    }
    if runtime.get("cwd").is_none_or(Value::is_null)
        && runtime.get("fallback_cwd").is_none_or(Value::is_null)
    {
        runtime.insert("cwd".into(), serde_json::to_value(home.join("workspace"))?);
    }
    let selected_model = runtime.get("_sdk_selected_model").and_then(Value::as_bool) == Some(true);
    let loader = runtime.entry("loader").or_insert(serde_json::json!({}));
    let loader = loader
        .as_object_mut()
        .context("runtime.loader must be an object")?;
    for key in [
        "ignore_user_config",
        "ignore_project_config",
        "ignore_user_and_project_exec_policy_rules",
        "ignore_managed_requirements",
        "ignore_login_requirements",
    ] {
        if selected_model && key == "ignore_managed_requirements" {
            anyhow::ensure!(
                loader
                    .get(key)
                    .is_none_or(|value| value == &Value::Bool(false)),
                "Selected Model cannot bypass managed requirements"
            );
            loader.insert(key.into(), Value::Bool(false));
        } else {
            loader.entry(key).or_insert(Value::Bool(true));
        }
    }
    for key in [
        "managed_config_path",
        "system_config_path",
        "system_requirements_path",
    ] {
        if !selected_model {
            loader
                .entry(key)
                .or_insert(serde_json::to_value(home.as_path().join(key))?);
        }
    }
    if !selected_model {
        loader
            .entry("macos_managed_config_requirements_base64")
            .or_insert(Value::String(String::new()));
    }
    #[cfg(target_os = "macos")]
    if !selected_model {
        loader
            .entry("managed_preferences_base64")
            .or_insert(Value::String(String::new()));
    }
    Ok((serde_json::to_string(&runtime)?, isolated_loader))
}

fn strict_by_default() -> bool {
    true
}

pub fn environment(runtime_json: &str) -> Result<Option<crate::environment::EnvironmentOptions>> {
    let options: RuntimeOptions = decode(serde_json::from_str(runtime_json)?)?;
    Ok(options.environment)
}

pub fn native_agents(runtime_json: &str) -> Result<bool> {
    let options: RuntimeOptions = decode(serde_json::from_str(runtime_json)?)?;
    Ok(options.native_agents)
}

pub fn native_thread_store(runtime_json: &str) -> Result<Option<AbsolutePathBuf>> {
    let options: RuntimeOptions = decode(serde_json::from_str(runtime_json)?)?;
    Ok(options.native_thread_store)
}

pub fn sdk_resume_thread_id(runtime_json: &str) -> Result<Option<codex_protocol::ThreadId>> {
    let options: RuntimeOptions = decode(serde_json::from_str(runtime_json)?)?;
    Ok(options.sdk_resume_thread_id)
}

pub(crate) fn web_search_tool(config: &Config) -> Option<codex_tools::ToolName> {
    use codex_protocol::config_types::WebSearchMode;
    if config.web_search_mode.value() == WebSearchMode::Disabled {
        None
    } else if config
        .features
        .enabled(codex_core_api::Feature::StandaloneWebSearch)
    {
        Some(codex_tools::ToolName::new(
            Some("web".to_owned()),
            "run".to_owned(),
        ))
    } else {
        Some(codex_tools::ToolName::plain("web_search").with_default_namespace())
    }
}

pub(crate) fn validate_local_tool_config(config: &Config) -> Result<()> {
    anyhow::ensure!(
        config
            .mcp_servers
            .get()
            .values()
            .all(|server| !server.enabled),
        "local storage does not support native MCP servers"
    );
    anyhow::ensure!(
        !config.features.enabled(codex_core_api::Feature::Apps)
            && !config.features.enabled(codex_core_api::Feature::Plugins),
        "local storage requires hosted Apps and plugin discovery to be disabled"
    );
    // Native search is admitted by the current managed policy in PythonTools::install.
    // Hosted search must reserve its plain name there, not rely on the registry gate.
    anyhow::ensure!(
        config.tool_registry.error_on_tool_collisions,
        "local storage requires error_on_tool_collisions=true"
    );
    Ok(())
}

pub fn native_goal_store_enabled(runtime_json: &str) -> Result<bool> {
    let options: RuntimeOptions = decode(serde_json::from_str(runtime_json)?)?;
    Ok(options.native_goal_store.is_some())
}

pub fn code_mode_host_enabled(config: &Config) -> bool {
    config
        .features
        .enabled(codex_core_api::Feature::CodeModeHost)
        || config.code_mode.disable_in_process_fallback
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct LoaderOptions {
    packaged_defaults_path: Option<AbsolutePathBuf>,
    user_config_path: Option<AbsolutePathBuf>,
    user_config_profile: Option<String>,
    managed_config_path: Option<PathBuf>,
    system_config_path: Option<PathBuf>,
    system_requirements_path: Option<PathBuf>,
    ignore_managed_requirements: bool,
    ignore_login_requirements: bool,
    ignore_user_config: bool,
    ignore_project_config: bool,
    ignore_user_and_project_exec_policy_rules: bool,
    #[cfg(target_os = "macos")]
    managed_preferences_base64: Option<String>,
    macos_managed_config_requirements_base64: Option<String>,
}

fn toml_value(value: Value) -> Result<toml::Value> {
    Ok(match value {
        Value::Null => bail!("TOML cannot represent null"),
        Value::Bool(value) => toml::Value::Boolean(value),
        Value::String(value) => toml::Value::String(value),
        Value::Number(value) => {
            let number = value.to_string();
            if number.contains(['.', 'e', 'E']) {
                let value: f64 = number.parse().context("invalid TOML float")?;
                anyhow::ensure!(value.is_finite(), "TOML float must be finite");
                toml::Value::Float(value)
            } else {
                toml::Value::Integer(number.parse().context("TOML integer exceeds i64 range")?)
            }
        }
        Value::Array(values) => {
            toml::Value::Array(values.into_iter().map(toml_value).collect::<Result<_>>()?)
        }
        Value::Object(values) => toml::Value::Table(
            values
                .into_iter()
                .map(|(key, value)| Ok((key, toml_value(value)?)))
                .collect::<Result<_>>()?,
        ),
    })
}

// On success, validating the existing value avoids a TOML text round trip.
// Keep the old path for every failure so diagnostics retain their exact wording
// and ordering. Empty source text is never used to report an error.
fn validate_effective_config(effective: toml::Value, sdk_native_config: bool) -> Result<()> {
    if codex_config::config_error_from_ignored_toml_value_fields::<
        codex_config::config_toml::ConfigToml,
    >("JavaScript configuration", "", effective.clone())
    .is_none()
    {
        return Ok(());
    }
    let contents = toml::to_string(&effective)?;
    if let Some(error) = codex_config::config_error_from_ignored_toml_fields::<
        codex_config::config_toml::ConfigToml,
    >("JavaScript configuration", &contents)
    {
        if sdk_native_config {
            bail!("Unsupported isolated SDK configuration");
        }
        bail!("{}", error.message);
    }
    Ok(())
}

pub async fn load(
    config_json: &str,
    runtime_json: &str,
    cloud: Option<CloudConfigBundleLoader>,
) -> Result<(Config, CloudConfigBundleLoader)> {
    load_with_first_root(config_json, runtime_json, cloud)
        .await
        .map(|(config, cloud, _)| (config, cloud))
}

pub(crate) async fn load_with_first_root(
    config_json: &str,
    runtime_json: &str,
    cloud: Option<CloudConfigBundleLoader>,
) -> Result<(Config, CloudConfigBundleLoader, bool)> {
    let values: serde_json::Map<String, Value> = serde_json::from_str(config_json)
        .context("config must be an object of native TOML options")?;
    let mut overrides = vec![
        (
            "openai_base_url".to_owned(),
            toml::Value::String("https://api.openai.com/v1".into()),
        ),
        ("project_doc_max_bytes".to_owned(), toml::Value::Integer(0)),
        (
            "features.skip_host_skill_discovery".to_owned(),
            toml::Value::Boolean(true),
        ),
        (
            "skills.bundled.enabled".to_owned(),
            toml::Value::Boolean(false),
        ),
        (
            "features.shell_snapshot".to_owned(),
            toml::Value::Boolean(false),
        ),
        (
            "features.api_key_model_discovery".to_owned(),
            toml::Value::Boolean(false),
        ),
        ("analytics.enabled".to_owned(), toml::Value::Boolean(false)),
    ];
    let options: RuntimeOptions = decode(serde_json::from_str(runtime_json)?)?;
    anyhow::ensure!(
        options.linux_sandbox_pid_namespace.is_none()
            && options.proxy_private_ips_via_upstream.is_none(),
        "Configure executor startup options on the remote exec-server"
    );
    #[cfg(target_os = "macos")]
    anyhow::ensure!(
        options.allowed_symlinked_codex_home.is_none(),
        "Configure executor startup options on the remote exec-server"
    );
    // Only the isolated SDK model path can retain one opening snapshot. Managed
    // requirements, storage, executors, selected models and NativeAgents reload.
    let first_root_eligible = options
        .cwd
        .as_ref()
        .or(options.fallback_cwd.as_ref())
        .is_some_and(|path| path.is_absolute())
        && !options.sdk_selected_model
        && !options.native_agents
        && options.environment.is_none()
        && options.native_thread_store.is_none()
        && options.native_goal_store.is_none()
        && options.sdk_resume_thread_id.is_none()
        && options.loader.ignore_managed_requirements
        && options.loader.ignore_login_requirements
        && options.loader.ignore_user_config
        && options.loader.ignore_project_config
        && options.loader.ignore_user_and_project_exec_policy_rules;
    let loader = options.loader;
    let loader = LoaderOverrides {
        packaged_defaults_path: loader.packaged_defaults_path,
        user_config_path: loader.user_config_path,
        user_config_profile: loader
            .user_config_profile
            .map(|value| value.parse())
            .transpose()?,
        managed_config_path: loader.managed_config_path,
        system_config_path: loader.system_config_path,
        system_requirements_path: loader.system_requirements_path,
        ignore_managed_requirements: loader.ignore_managed_requirements,
        ignore_login_requirements: loader.ignore_login_requirements,
        ignore_user_config: loader.ignore_user_config,
        ignore_project_config: loader.ignore_project_config,
        ignore_user_and_project_exec_policy_rules: loader.ignore_user_and_project_exec_policy_rules,
        #[cfg(target_os = "macos")]
        managed_preferences_base64: loader.managed_preferences_base64,
        macos_managed_config_requirements_base64: loader.macos_managed_config_requirements_base64,
    };
    let cloud = cloud.unwrap_or_default();
    // A live SDK/HTTP route selects its own provider before this load, at both
    // engine and thread startup. Never merge ambient provider definitions into it.
    let ambient_provider = options.sdk_native_config
        && options.model_provider.is_none()
        && !values.contains_key("model_provider");
    if options.sdk_native_config {
        let source_home = match codex_core::config::find_codex_home() {
            Ok(home) => home,
            // A fresh SDK persistent store may not have created its home yet.
            // In that case there is no user config to project. Keep the existing
            // isolated defaults, never fall back to a different user's home.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                AbsolutePathBuf::from_absolute_path(
                    options
                        .codex_home
                        .as_ref()
                        .context("Missing SDK working home")?,
                )?
            }
            Err(_) => bail!("Unable to locate native user configuration"),
        };
        let source = codex_config::loader::load_config_layers_state(
            codex_exec_server::LOCAL_FS.as_ref(),
            &source_home,
            None,
            &[],
            codex_config::ConfigLoadOptions {
                loader_overrides: LoaderOverrides {
                    user_config_path: None,
                    ignore_user_config: false,
                    ignore_project_config: true,
                    ignore_user_and_project_exec_policy_rules: true,
                    ..loader.clone()
                },
                strict_config: false,
                cloud_config_bundle: cloud.clone(),
            },
            &codex_config::NoopThreadConfigLoader,
        )
        .await
        // Config errors may include source text. Do not expose credentials.
        .map_err(|_| anyhow::anyhow!("Unable to load native user configuration"))?;
        let effective = source.effective_config();
        // Keep the facade's historical default when no user selection is configured.
        overrides.push(("model".into(), toml::Value::String("gpt-5.1-codex".into())));
        for key in ["projects", "project_root_markers"] {
            if let Some(value) = effective.get(key) {
                overrides.push((key.into(), value.clone()));
            }
        }
        if ambient_provider {
            for key in [
                "model",
                "model_provider",
                "model_providers",
                "openai_base_url",
            ] {
                if let Some(value) = effective.get(key) {
                    overrides.push((key.into(), value.clone()));
                }
            }
        }
    }
    // Live application configuration and permissions always win over facade defaults.
    overrides.extend(
        values
            .into_iter()
            .map(|(key, value)| {
                let value =
                    toml_value(value).with_context(|| format!("invalid TOML value for {key}"))?;
                Ok((key, value))
            })
            .collect::<Result<Vec<_>>>()?,
    );
    let harness = ConfigOverrides {
        model: options.model,
        review_model: options.review_model,
        cwd: options.cwd,
        approval_policy: options.approval_policy,
        approvals_reviewer: options.approvals_reviewer,
        sandbox_mode: options.sandbox_mode,
        permission_profile: options.permission_profile,
        default_permissions: options.default_permissions,
        persisted_permission_profile_id: options.persisted_permission_profile_id,
        model_provider: options.model_provider,
        service_tier: options.service_tier,
        codex_self_exe: options.codex_self_exe,
        codex_linux_sandbox_exe: options.codex_linux_sandbox_exe,
        main_execve_wrapper_exe: options.main_execve_wrapper_exe,
        default_zsh_path: options.default_zsh_path,
        base_instructions: options.base_instructions,
        developer_instructions: options.developer_instructions,
        personality: options.personality,
        compact_prompt: options.compact_prompt,
        show_raw_agent_reasoning: options.show_raw_agent_reasoning,
        tools_web_search_request: options.tools_web_search_request,
        ephemeral: options.ephemeral,
        bypass_hook_trust: options.bypass_hook_trust,
        additional_writable_roots: options.additional_writable_roots,
        workspace_roots: options.workspace_roots,
    };
    let mut builder = ConfigBuilder::default()
        .cli_overrides(overrides)
        .harness_overrides(harness)
        .loader_overrides(loader)
        .cloud_config_bundle(cloud.clone())
        .strict_config(options.strict_config)
        .fallback_cwd(options.fallback_cwd);
    if let Some(home) = options.codex_home {
        builder = builder.codex_home(home);
    }
    let built = builder.build().await;
    let mut config = if options.sdk_native_config {
        built.map_err(|_| anyhow::anyhow!("Unable to load isolated SDK configuration"))?
    } else {
        built?
    };
    config
        .features
        .disable(codex_core_api::Feature::UnboundedConnectionRetries)?;
    // Managed requirements may normalize the requested value back to true.
    anyhow::ensure!(
        !config
            .features
            .enabled(codex_core_api::Feature::UnboundedConnectionRetries),
        "Native SDK configuration requires finite connection retries"
    );
    // Only current application runtime configuration authorizes native storage.
    // Config and checkpoint sqlite_home values cannot choose its location.
    if let (Some(goals), Some(threads)) = (&options.native_goal_store, &options.native_thread_store)
    {
        anyhow::ensure!(
            goals == threads,
            "native goal and thread storage directories must agree"
        );
    }
    anyhow::ensure!(
        options.native_thread_store.is_none() || !config.ephemeral,
        "local storage requires persistent threads"
    );
    if let Some(home) = options.native_thread_store.or(options.native_goal_store) {
        config.sqlite = SqliteConfig::from_sqlite_home(home);
    }
    anyhow::ensure!(
        !config.features.enabled(codex_core_api::Feature::MemoryTool),
        "Native memories require host files; this SDK runtime keeps state in memory"
    );
    anyhow::ensure!(
        !config.bundled_skills_enabled(),
        "Bundled skills require host files and are unavailable in this SDK"
    );
    anyhow::ensure!(
        config
            .features
            .enabled(codex_core_api::Feature::SkipHostSkillDiscovery),
        "Host skill discovery is unavailable in this SDK"
    );
    if options.strict_config {
        // Validate after merging: a partial provider override may not deserialize
        // on its own, which prevents the native loader's early ignored-key check.
        validate_effective_config(
            config.config_layer_stack.effective_config(),
            options.sdk_native_config,
        )?;
    }
    if let Some(enabled) = options.model_provider_include_internal_metadata {
        config.model_provider.include_internal_metadata = enabled;
        if let Some(provider) = config.model_providers.get_mut(&config.model_provider_id) {
            provider.include_internal_metadata = enabled;
        }
    }
    if let Some(scope) = options.native_interception_http {
        // The pinned WS LastResponse is made from the already-edited stream;
        // its previous_response_id still names the server's unedited prefix.
        // Resolve first so this works with built-ins and config-layer providers
        // without changing base_url, auth, retry policy, or model capabilities.
        config.model_provider.supports_websockets = false;
        for (id, provider) in &mut config.model_providers {
            // A native resumed ThreadSpawn selects its saved provider from
            // this inherited map, not necessarily the root's current one.
            if scope == crate::native_interception::Scope::ThreadTree
                || *id == config.model_provider_id
            {
                provider.supports_websockets = false;
            }
        }
    }
    if options.sdk_selected_model {
        use codex_core_api::Feature;
        config
            .features
            .disable(Feature::UnboundedConnectionRetries)?;
        config.features.disable(Feature::ApiKeyModelDiscovery)?;
        anyhow::ensure!(
            !config.features.enabled(Feature::UnboundedConnectionRetries)
                && !config.features.enabled(Feature::ApiKeyModelDiscovery)
                && config.model_provider.request_max_retries() == 0
                && config.model_provider.stream_max_retries() == 0
                && !config.model_provider.supports_websockets,
            "Selected Model requires managed discovery/connection retries disabled and HTTP with zero retries"
        );
    }
    let first_root_eligible = first_root_eligible
        && !config.features.enabled(codex_core_api::Feature::CodeMode)
        && !config.model_provider.supports_websockets;
    Ok((config, cloud, first_root_eligible))
}

#[cfg(test)]
mod selected_model_tests {
    use super::*;

    #[test]
    fn selected_mode_keeps_managed_requirements_and_ordinary_mode_keeps_isolation() {
        let selected: Value =
            serde_json::from_str(&prepare_runtime(r#"{"_sdk_selected_model":true}"#).unwrap())
                .unwrap();
        assert_eq!(selected["loader"]["ignore_managed_requirements"], false);
        for field in [
            "managed_config_path",
            "system_requirements_path",
            "macos_managed_config_requirements_base64",
        ] {
            assert!(selected["loader"].get(field).is_none());
        }
        let ordinary: Value = serde_json::from_str(&prepare_runtime("{}").unwrap()).unwrap();
        assert_eq!(ordinary["loader"]["ignore_managed_requirements"], true);
        assert!(ordinary["loader"]["system_requirements_path"].is_string());
    }

    #[test]
    fn selected_mode_refuses_a_managed_requirements_bypass() {
        assert!(
            prepare_runtime(
                r#"{"_sdk_selected_model":true,
            "loader":{"ignore_managed_requirements":true}}"#
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn selected_load_honors_managed_discovery_and_connection_retry_pins() {
        use codex_core_api::Feature;

        for (key, feature) in [
            (
                "unbounded_connection_retries",
                Feature::UnboundedConnectionRetries,
            ),
            ("api_key_model_discovery", Feature::ApiKeyModelDiscovery),
        ] {
            for pin in [None, Some(false), Some(true)] {
                let home = tempfile::tempdir().unwrap();
                let requirements = home.path().join("requirements.toml");
                let contents = pin
                    .map(|enabled| format!("[features]\n{key} = {enabled}\n"))
                    .unwrap_or_default();
                std::fs::write(&requirements, contents).unwrap();
                let mut runtime = serde_json::json!({
                    "_sdk_selected_model": true,
                    "codex_home": home.path(),
                    "cwd": home.path(),
                    "loader": {
                        "ignore_managed_requirements": false,
                        "managed_config_path": home.path().join("managed_config.toml"),
                        "system_config_path": home.path().join("system_config.toml"),
                        "system_requirements_path": requirements,
                        "macos_managed_config_requirements_base64": "",
                    },
                });
                if cfg!(target_os = "macos") {
                    runtime["loader"]["managed_preferences_base64"] = Value::String(String::new());
                }
                let mut config = serde_json::json!({
                    "model": "gpt-5.1-codex",
                    "model_provider": "selected_model_test",
                    "model_providers.selected_model_test": {
                        "name": "Selected Model configuration test",
                        "base_url": "http://127.0.0.1:1/v1",
                        "wire_api": "responses",
                        "requires_openai_auth": false,
                        "supports_websockets": false,
                        "request_max_retries": 0,
                        "stream_max_retries": 0,
                    },
                    "features.unbounded_connection_retries": false,
                    "features.api_key_model_discovery": false,
                });
                // No pin starts enabled, proving selected mode disables the feature.
                // Explicit settings agree with pins so Core can load the fixture.
                config[format!("features.{key}")] = Value::Bool(pin.unwrap_or(true));
                let config = serde_json::to_string(&config).unwrap();

                if pin == Some(true) {
                    let mut ordinary = runtime.clone();
                    ordinary["_sdk_selected_model"] = Value::Bool(false);
                    let ordinary = prepare_runtime(&ordinary.to_string()).unwrap();
                    let loaded = load(&config, &ordinary, None).await;
                    if key == "unbounded_connection_retries" {
                        let error = loaded
                            .err()
                            .expect("ordinary SDK must reject a managed true pin");
                        assert!(
                            error
                                .to_string()
                                .contains("requires finite connection retries")
                        );
                    } else {
                        assert!(
                            loaded.unwrap().0.features.enabled(feature),
                            "{key}: fixture must load its true pin"
                        );
                    }
                }

                let runtime = prepare_runtime(&runtime.to_string()).unwrap();
                let result = load(&config, &runtime, None).await;
                if pin == Some(true) {
                    let error = match result {
                        Err(error) => error,
                        Ok(_) => panic!("{key}: selected mode accepted a managed true pin"),
                    };
                    let expected = if key == "unbounded_connection_retries" {
                        "requires finite connection retries"
                    } else {
                        "Selected Model requires"
                    };
                    assert!(
                        error.to_string().contains(expected),
                        "{key}: expected policy refusal, got {error:#}"
                    );
                } else {
                    let (loaded, _) = result.unwrap();
                    assert!(!loaded.features.enabled(Feature::UnboundedConnectionRetries));
                    assert!(!loaded.features.enabled(Feature::ApiKeyModelDiscovery));
                    assert_eq!(loaded.model_provider.request_max_retries(), 0);
                    assert_eq!(loaded.model_provider.stream_max_retries(), 0);
                    assert!(!loaded.model_provider.supports_websockets);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "config_strict_value_tests.rs"]
mod strict_value_tests;

#[cfg(test)]
mod first_root_loader_tests {
    use super::*;

    #[test]
    fn only_the_ordinary_loader_shape_can_supply_a_first_root_snapshot() {
        let (_, ordinary) = prepare_runtime_for_first_root(
            r#"{"loader":{"ignore_user_config":true,"ignore_project_config":true}}"#,
        )
        .unwrap();
        assert!(ordinary);
        for key in [
            "managed_config_path",
            "system_config_path",
            "system_requirements_path",
            "packaged_defaults_path",
            "user_config_path",
            "user_config_profile",
            "ignore_managed_requirements",
            "macos_managed_config_requirements_base64",
        ] {
            let mut loader = serde_json::Map::new();
            loader.insert(key.to_owned(), Value::String("explicit".into()));
            let runtime = serde_json::json!({"loader":loader});
            let (_, isolated) = prepare_runtime_for_first_root(&runtime.to_string()).unwrap();
            assert!(!isolated, "explicit loader field {key} must reload");
        }
    }
}

//! Register admitted MCP execution and bind the selected remote executor.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use codex_core::{
    config::validate_environment_network_policy, windows_sandbox::WindowsSandboxLevelExt,
};
use codex_core_api::{
    Config, EnvironmentManager, EnvironmentNetworkPolicy, NetworkDomainPermission,
    NetworkDomainPermissionEntry, NetworkDomainPermissions,
};
use codex_exec_server::{
    ExecServerRuntimeOptions, REMOTE_ENVIRONMENT_ID, RemoteEnvironmentOptions,
};
use codex_protocol::capabilities::{CapabilityRootLocation, SelectedCapabilityRoot};
use codex_protocol::config_types::WindowsSandboxLevel;
use codex_protocol::models::{PermissionProfile, PermissionProfileSnapshot};
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_protocol::protocol::{
    AskForApproval, EnvironmentConfig, EnvironmentConfigState, GranularApprovalConfig,
    TurnEnvironmentSelection,
};
use codex_utils_path_uri::{PathConvention, PathUri, Platform};
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};

pub async fn for_unattached_threads(config: &Config) -> Result<EnvironmentManager> {
    // An explicitly absent helper supports model-only clients. Native MCP
    // admits servers against the actual manager at session selection time.
    if config.codex_self_exe.is_none() {
        return Ok(EnvironmentManager::without_environments(
            config.http_client_factory(),
        ));
    }
    let paths = ExecServerRuntimeOptions::from_optional_paths(
        config.codex_self_exe.clone(),
        config.codex_linux_sandbox_exe.clone(),
    )?;
    // The pinned public constructor reads a file; never read or replace the caller's home.
    // Shared Codex sessions may admit a current local MCP roster after manager
    // construction. Reserve its lazy executor here: only configured MCP starts
    // it without a workspace selection. No default grants ordinary threads a
    // shell. Agent execution uses the explicitly assigned remote environment.
    let home = tempfile::tempdir().context("prepare native MCP environment")?;
    std::fs::write(
        home.path().join("environments.toml"),
        "default = \"none\"\ninclude_local = true\n",
    )?;
    let prepared = EnvironmentManager::prepare_from_codex_home(home.path()).await?;
    // Noise takes precedence over the file upstream. Do not start an ambient executor.
    ensure!(
        !prepared.default_environment_is_remote(),
        "native local MCP configuration cannot select an ambient remote environment"
    );
    Ok(prepared.build(Some(paths), config.http_client_factory())?)
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentOptions {
    url: String,
    cwd: PathUri,
    #[serde(default)]
    headers: HashMap<String, String>,
    connect_timeout: Option<f64>,
    capability_directories: Option<Vec<PathUri>>,
    #[serde(default, deserialize_with = "deserialize_network")]
    network: Option<EnvironmentNetworkPolicy>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct NetworkOptions {
    allowed_domains: Vec<String>,
    denied_domains: Vec<String>,
    allow_all_unix_sockets: bool,
    allow_local_binding: bool,
}

fn deserialize_network<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<EnvironmentNetworkPolicy>, D::Error> {
    let Some(options) = Option::<NetworkOptions>::deserialize(deserializer)? else {
        return Ok(None);
    };
    let mut domains = NetworkDomainPermissions::default();
    for (patterns, permission) in [
        (options.allowed_domains, NetworkDomainPermission::Allow),
        (options.denied_domains, NetworkDomainPermission::Deny),
    ] {
        domains.entries.extend(
            patterns
                .into_iter()
                .map(|pattern| NetworkDomainPermissionEntry {
                    pattern,
                    permission,
                }),
        );
    }
    Ok(Some(EnvironmentNetworkPolicy {
        requires_proxy: true,
        // Core resolves conflicting domain rules and enforces the strict allowlist.
        domains: Some(domains),
        unix_sockets: None,
        allow_upstream_proxy: false,
        dangerously_allow_all_unix_sockets: options.allow_all_unix_sockets,
        allow_local_binding: Some(options.allow_local_binding),
        managed_allowed_domains_only: true,
    }))
}

impl EnvironmentOptions {
    fn permission_profile(&self) -> PermissionProfile {
        // Resolve the application-owned root now so a command's workdir cannot expand writes.
        PermissionProfile::workspace_write_with_path_uris(
            &[],
            NetworkSandboxPolicy::Restricted,
            true,
            true,
        )
        .materialize_project_roots_with_path_uris(std::slice::from_ref(&self.cwd))
    }

    pub fn trusted_root(&self) -> &PathUri {
        &self.cwd
    }

    pub fn capability_roots(&self) -> Option<Vec<SelectedCapabilityRoot>> {
        self.capability_directories.as_ref().map(|directories| {
            directories
                .iter()
                .map(|path| SelectedCapabilityRoot {
                    id: format!(
                        "codex-agents:{REMOTE_ENVIRONMENT_ID}:capability-directory:{:x}",
                        Sha256::digest(path.to_string().as_bytes())
                    ),
                    location: CapabilityRootLocation::Environment {
                        environment_id: REMOTE_ENVIRONMENT_ID.to_owned(),
                        path: path.clone(),
                    },
                })
                .collect()
        })
    }

    pub fn restrict_network_approval(&self, config: &mut Config) -> Result<()> {
        if self.network.is_none() {
            return Ok(());
        }
        // An escalated command bypasses the proxy. Preserve all other approval categories.
        let policy = &mut config.permissions.approval_policy;
        let granular = match policy.value() {
            AskForApproval::Never => return Ok(()),
            AskForApproval::Granular(existing) if !existing.sandbox_approval => return Ok(()),
            AskForApproval::Granular(existing) => GranularApprovalConfig {
                sandbox_approval: false,
                ..existing
            },
            AskForApproval::OnRequest => GranularApprovalConfig {
                sandbox_approval: false,
                rules: true,
                skill_approval: true,
                request_permissions: true,
                mcp_elicitations: true,
            },
            AskForApproval::UnlessTrusted => {
                anyhow::bail!("network policy cannot preserve untrusted command approvals")
            }
        };
        policy
            .set(AskForApproval::Granular(granular))
            .context("network policy conflicts with required approvals")
    }

    pub(crate) fn check_network_config(&self, config: &Config) -> Result<()> {
        if self.network.is_some() {
            let approval = config.permissions.approval_policy.value();
            let no_escalation = approval == AskForApproval::Never
                || matches!(approval, AskForApproval::Granular(policy) if !policy.sandbox_approval);
            ensure!(
                config.permissions.network.is_none()
                    && !config.features.use_legacy_landlock()
                    && no_escalation,
                "network policy requires the standard sandbox without escalation or a controller proxy"
            );
        }
        Ok(())
    }

    pub(crate) async fn check_network_target(
        &self,
        environment: &codex_exec_server::Environment,
    ) -> Result<()> {
        if let Some(network) = &self.network {
            let info = environment
                .info()
                .await
                .map_err(|_| anyhow::anyhow!("could not verify remote executor capabilities"))?;
            let platform = Platform::from_platform_os(info.platform_os.as_deref());
            ensure!(
                platform != Platform::Linux || network.dangerously_allow_all_unix_sockets,
                "this executor cannot enforce Unix-socket denial for an explicit network policy. \
                 Linux requires explicit access to all Unix sockets (allow_all_unix_sockets=True)"
            );
            ensure!(
                matches!(platform, Platform::Linux | Platform::Macos)
                    && info.capabilities.network_proxy_launch,
                "network policy requires a Linux or macOS executor with managed proxy launch"
            );
            ensure!(
                self.cwd.infer_path_convention() == Some(PathConvention::Posix),
                "network policy requires a POSIX executor workspace"
            );
            validate_environment_network_policy(network, &self.permission_profile(), platform)?;
        }
        Ok(())
    }

    pub(crate) async fn prepare(self, config: &Config) -> Result<EnvironmentManager> {
        let needs_local_mcp = config.mcp_servers.get().values().any(|server| {
            server.enabled
                && server.is_local_environment()
                && matches!(
                    server.transport,
                    codex_config::McpServerTransportConfig::Stdio { .. }
                )
        });
        let manager = if needs_local_mcp {
            let manager = for_unattached_threads(config).await?;
            ensure!(
                manager.try_local_environment().is_some(),
                "local stdio MCP requires the native process helper"
            );
            manager
        } else {
            EnvironmentManager::without_environments(config.http_client_factory())
        };
        self.register(&manager)
            .map_err(|_| anyhow::anyhow!("invalid remote executor connection settings"))?;
        Ok(manager)
    }

    fn register(
        &self,
        manager: &EnvironmentManager,
    ) -> Result<Arc<codex_exec_server::Environment>> {
        manager.upsert_environment_with_options(
            REMOTE_ENVIRONMENT_ID.to_owned(),
            RemoteEnvironmentOptions {
                exec_server_url: self.url.clone(),
                http_headers: self.headers.clone(),
                connect_timeout: self
                    .connect_timeout
                    .map(Duration::try_from_secs_f64)
                    .transpose()
                    .context("connect_timeout must be finite and nonnegative")?,
            },
            Default::default(),
        )?;
        Ok(manager
            .get_environment(REMOTE_ENVIRONMENT_ID)
            .context("remote environment was not registered")?)
    }

    pub fn selection(self, config: &Config) -> TurnEnvironmentSelection {
        let selected_capability_roots = self.capability_roots().unwrap_or_default();
        let permissions = &config.permissions;
        let workspace_roots = vec![self.cwd.clone()];
        // An assigned remote workspace has its own write boundary. Resolve it
        // now so a command's workdir cannot widen that boundary.
        let profile = self.permission_profile();
        let permission_profile = PermissionProfileSnapshot::legacy(profile);
        TurnEnvironmentSelection {
            environment_id: REMOTE_ENVIRONMENT_ID.to_owned(),
            workspace_roots: workspace_roots.clone(),
            cwd: self.cwd,
            // Owner configuration prevents executor-advertised roots from being added.
            config: EnvironmentConfigState::Ready(EnvironmentConfig {
                allow_login_shell: permissions.allow_login_shell,
                workspace_roots,
                permission_profile,
                shell_environment_policy: permissions.shell_environment_policy.clone(),
                windows_sandbox_level: WindowsSandboxLevel::from_config(config),
                windows_sandbox_type: config.windows_sandbox_type_from_config(),
                use_legacy_landlock: config.features.use_legacy_landlock(),
                exec_policy: None,
                mcp_policy: None,
                network_policy: self.network,
                selected_capability_roots,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_empty_network_still_requires_the_managed_proxy() {
        let base = json!({ "url": "wss://executor.invalid", "cwd": "file:///workspace" });
        let omitted: EnvironmentOptions = serde_json::from_value(base.clone()).unwrap();
        assert!(omitted.network.is_none());
        let mut explicit = base.clone();
        explicit["network"] = json!({});
        let selected: EnvironmentOptions = serde_json::from_value(explicit).unwrap();
        let policy = selected.network.unwrap();
        assert!(policy.requires_proxy);
        assert!(policy.managed_allowed_domains_only);
        assert!(!policy.allow_upstream_proxy);
        assert!(policy.domains.unwrap().entries.is_empty());
        assert_eq!(policy.allow_local_binding, Some(false));
        assert!(!policy.dangerously_allow_all_unix_sockets);
        assert!(policy.unix_sockets.is_none());
        let mut unknown = base;
        unknown["network"] = json!({ "unexpected": true });
        assert!(serde_json::from_value::<EnvironmentOptions>(unknown).is_err());
    }

    #[test]
    fn selected_rules_retain_both_permissions_and_explicit_socket_consent() {
        let options: EnvironmentOptions = serde_json::from_value(json!({
            "url": "wss://executor.invalid", "cwd": "file:///workspace",
            "network": {
                "allowed_domains": ["*.example.invalid"],
                "denied_domains": ["blocked.example.invalid"],
                "allow_all_unix_sockets": true,
                "allow_local_binding": true
            }
        }))
        .unwrap();
        let policy = options.network.unwrap();
        let entries = policy.domains.unwrap().entries;
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pattern, "*.example.invalid");
        assert!(matches!(
            entries[0].permission,
            NetworkDomainPermission::Allow
        ));
        assert_eq!(entries[1].pattern, "blocked.example.invalid");
        assert!(matches!(
            entries[1].permission,
            NetworkDomainPermission::Deny
        ));
        assert!(policy.dangerously_allow_all_unix_sockets);
        assert_eq!(policy.allow_local_binding, Some(true));
    }

    #[test]
    fn directory_presence_and_canonical_remote_identity() {
        let base = json!({ "url": "wss://executor.invalid", "cwd": "file:///workspace" });
        let omitted: EnvironmentOptions = serde_json::from_value(base.clone()).unwrap();
        assert!(omitted.capability_roots().is_none());
        let mut empty = base.clone();
        empty["capability_directories"] = json!([]);
        let empty: EnvironmentOptions = serde_json::from_value(empty).unwrap();
        assert_eq!(empty.capability_roots(), Some(Vec::new()));
        let mut selected = base;
        selected["capability_directories"] = json!(["file://localhost/remote/catalog"]);
        let selected: EnvironmentOptions = serde_json::from_value(selected).unwrap();
        assert_eq!(
            serde_json::to_value(selected.capability_roots().unwrap()).unwrap(),
            json!([{
                "id": "codex-agents:remote:capability-directory:404dcb36b758dbdc125a745efa1a3df9fcccdb265e35b46cf2e04a627a21f6ca",
                "location": { "type": "environment", "environmentId": "remote", "path": "file:///remote/catalog" }
            }])
        );
    }
}

//! Register admitted MCP execution and bind the selected executor.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use codex_config::{NetworkConstraints, NetworkDomainPermissionToml, NetworkDomainPermissionsToml};
use codex_core::{
    config::validate_environment_network_policy, windows_sandbox::WindowsSandboxLevelExt,
};
use codex_core_api::{
    AbsolutePathBuf, Config, EnvironmentManager, EnvironmentNetworkPolicy, NetworkDomainPermission,
    NetworkDomainPermissionEntry, NetworkDomainPermissions, NetworkProxySpec,
};
use codex_exec_server::{
    Environment, EnvironmentInfo, ExecParams, ExecProcessEvent, ExecServerError,
    ExecServerRuntimeOptions, FileSystemSandboxContext, GetMetadataOptions, LOCAL_ENVIRONMENT_ID,
    ProcessId, REMOTE_ENVIRONMENT_ID, RemoteEnvironmentOptions,
};
use codex_protocol::capabilities::{CapabilityRootLocation, SelectedCapabilityRoot};
use codex_protocol::config_types::{
    ShellEnvironmentPolicy, ShellEnvironmentPolicyInherit, WindowsSandboxLevel,
};
use codex_protocol::models::{PermissionProfile, PermissionProfileSnapshot};
use codex_protocol::permissions::{
    FileSystemAccessMode, FileSystemPath, FileSystemSpecialPath, NetworkSandboxPolicy,
};
use codex_protocol::protocol::{
    AskForApproval, EnvironmentConfig, EnvironmentConfigState, GranularApprovalConfig,
    TurnEnvironmentSelection,
};
use codex_protocol::sandbox::SandboxType;
use codex_utils_path_uri::{PathConvention, PathUri, Platform};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_rustls::rustls;
use tokio_tungstenite::tungstenite::{Error as WebSocketError, error::TlsError};

pub async fn for_unattached_threads(config: &Config) -> Result<EnvironmentManager> {
    local_environment_manager(config, /*restricted*/ false).await
}

async fn local_environment_manager(
    config: &Config,
    restricted: bool,
) -> Result<EnvironmentManager> {
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
    let paths = if restricted {
        let paths = paths
            .with_file_system_helper_env(local_command_env())
            .with_join_unreturned_local_exec_on_interrupt();
        #[cfg(target_os = "macos")]
        let paths = paths.with_restricted_macos_process_sandbox();
        paths
    } else {
        paths
    };
    // The pinned public constructor reads a file; never read or replace the caller's home.
    // Shared Codex sessions may admit a current local MCP roster after manager
    // construction. Reserve its lazy executor here: only configured MCP starts
    // it without a workspace selection. No default grants ordinary threads a
    // shell. SDK execution uses the explicitly assigned environment.
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

const LOCAL_COMMAND_PATH: &str = "/usr/bin:/bin";

fn local_command_env() -> HashMap<String, String> {
    // The Linux sandbox helper resolves bubblewrap from PATH before isolation.
    HashMap::from([("PATH".to_owned(), LOCAL_COMMAND_PATH.to_owned())])
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentOptions {
    url: Option<String>,
    #[serde(default)]
    local: bool,
    cwd: PathUri,
    #[serde(default)]
    headers: HashMap<String, String>,
    connect_timeout: Option<f64>,
    capability_directories: Option<Vec<PathUri>>,
    writable_roots: Option<Vec<PathUri>>,
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

/// The opening workspace identity and live path grants for a strict executor.
#[derive(Clone)]
pub(crate) struct StrictExecutorWrites {
    canonical_cwd: PathUri,
    root_pins: HashMap<Vec<u8>, PathUri>,
}

impl StrictExecutorWrites {
    pub(crate) fn check_pins(&self, previous: &Self) -> Result<()> {
        ensure!(
            self.canonical_cwd == previous.canonical_cwd,
            "Cannot change writable roots because the executor workspace changed"
        );
        ensure!(
            self.root_pins.iter().all(|(path, canonical)| previous
                .root_pins
                .get(path)
                .is_none_or(|pinned| pinned == canonical)),
            "An executor write root changed its resolved directory"
        );
        Ok(())
    }
}

fn write_root_key(path: &PathUri) -> Vec<u8> {
    // POSIX treats repeated and trailing separators as the same directory.
    path.decoded_path_bytes()
        .split(|byte| *byte == b'/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(&b'/')
}

impl EnvironmentOptions {
    pub(crate) fn id(&self) -> &'static str {
        if self.local {
            LOCAL_ENVIRONMENT_ID
        } else {
            REMOTE_ENVIRONMENT_ID
        }
    }

    pub(crate) fn strict_writes(&self) -> bool {
        self.local || self.writable_roots.is_some()
    }

    pub fn trusted_root(&self) -> &PathUri {
        &self.cwd
    }

    pub fn capability_roots(&self) -> Option<Vec<SelectedCapabilityRoot>> {
        let environment_id = self.id();
        self.capability_directories.as_ref().map(|directories| {
            directories
                .iter()
                .map(|path| SelectedCapabilityRoot {
                    id: format!(
                        "codex-agents:{environment_id}:capability-directory:{:x}",
                        Sha256::digest(path.to_string().as_bytes())
                    ),
                    location: CapabilityRootLocation::Environment {
                        environment_id: environment_id.to_owned(),
                        path: path.clone(),
                    },
                })
                .collect()
        })
    }

    pub fn restrict_network_approval(&self, config: &mut Config) -> Result<()> {
        let strict_writes = self.strict_writes();
        if strict_writes {
            check_rule_directories(config)?;
            config
                .features
                .enable(codex_core_api::Feature::WriteStdinApproval)
                .context("Environment grants require stdin approval")?;
            config
                .features
                .disable(codex_core_api::Feature::RequestPermissionsTool)
                .context("Environment grants forbid permission requests")?;
        } else if self.network.is_none() {
            return Ok(());
        }
        // Escalation can bypass the write and network policy.
        let policy = &mut config.permissions.approval_policy;
        let granular = match policy.value() {
            AskForApproval::Never => return Ok(()),
            AskForApproval::Granular(existing)
                if !existing.sandbox_approval
                    && (!strict_writes || !existing.request_permissions) =>
            {
                return Ok(());
            }
            AskForApproval::Granular(existing) => GranularApprovalConfig {
                sandbox_approval: false,
                request_permissions: !strict_writes && existing.request_permissions,
                ..existing
            },
            AskForApproval::OnRequest => GranularApprovalConfig {
                sandbox_approval: false,
                rules: true,
                skill_approval: true,
                request_permissions: !strict_writes,
                mcp_elicitations: true,
            },
            AskForApproval::UnlessTrusted => {
                anyhow::bail!("executor policy cannot preserve untrusted command approvals")
            }
        };
        policy
            .set(AskForApproval::Granular(granular))
            .context("executor policy conflicts with required approvals")
    }

    pub(crate) fn check_config(&self, config: &Config) -> Result<()> {
        if self.strict_writes() {
            check_writable_config(config, /*local_session_proxy*/ false)?;
        }
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

    fn check_network_target(
        &self,
        info: &EnvironmentInfo,
        profile: &PermissionProfile,
    ) -> Result<()> {
        if let Some(network) = &self.network {
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
            validate_environment_network_policy(network, profile, platform)?;
        }
        Ok(())
    }

    pub(crate) fn check_local_storage(&self, storage: &Path) -> Result<()> {
        if !self.local {
            return Ok(());
        }
        let roots = std::iter::once(&self.cwd)
            .chain(self.writable_roots.iter().flatten())
            .map(|root| {
                root.to_abs_path()?
                    .canonicalize()
                    .context("could not resolve an executor write root")
            })
            .collect::<Result<Vec<_>>>()?;
        check_local_storage_write_roots(&roots, storage)
    }

    pub(crate) async fn prepare(&self, config: &Config) -> Result<EnvironmentManager> {
        self.check_config(config)?;
        if self.local {
            ensure!(
                self.url.is_none() && self.headers.is_empty() && self.connect_timeout.is_none(),
                "a local executor does not accept connection settings"
            );
            check_local_helpers(config)?;
            return local_environment_manager(config, /*restricted*/ true).await;
        }
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
        self.register(&manager)?;
        Ok(manager)
    }

    pub(crate) async fn check_ready(
        &self,
        config: &Config,
        manager: &EnvironmentManager,
    ) -> Result<()> {
        let environment = manager
            .get_environment(self.id())
            .context("selected executor was not registered")?;
        environment.wait_until_ready().await.map_err(|error| {
            let location = if self.local { "local" } else { "remote" };
            anyhow::anyhow!(
                "{location} executor failed to become ready: {}",
                startup_cause(&error)
            )
        })?;
        if self.strict_writes() || self.network.is_some() {
            let info = executor_info(&environment).await?;
            let (_, profile) = self.profile(config, &environment, &info, None).await?;
            self.check_network_target(&info, &profile)?;
            if self.local {
                probe_local_sandbox(&environment, &self.cwd, profile).await?;
            }
        }
        Ok(())
    }

    fn register(&self, manager: &EnvironmentManager) -> Result<Arc<Environment>> {
        ensure!(
            !self.local,
            "a deferred executor requires a remote connection"
        );
        manager
            .upsert_environment_with_options(
                REMOTE_ENVIRONMENT_ID.to_owned(),
                RemoteEnvironmentOptions {
                    exec_server_url: self.url.clone().context("remote executor requires a URL")?,
                    http_headers: self.headers.clone(),
                    connect_timeout: self
                        .connect_timeout
                        .map(Duration::try_from_secs_f64)
                        .transpose()
                        .map_err(|_| anyhow::anyhow!("invalid remote executor connect timeout"))?,
                },
                Default::default(),
            )
            .map_err(|error| {
                anyhow::anyhow!(
                    "invalid remote executor connection settings: {}",
                    startup_cause(&error)
                )
            })?;
        Ok(manager
            .get_environment(REMOTE_ENVIRONMENT_ID)
            .context("remote environment was not registered")?)
    }

    async fn profile(
        &self,
        config: &Config,
        environment: &Environment,
        info: &EnvironmentInfo,
        local_storage: Option<&Path>,
    ) -> Result<(Option<StrictExecutorWrites>, PermissionProfile)> {
        if self.strict_writes() {
            let (strict, profile) = strict_write_profile(
                config,
                environment,
                info,
                &self.cwd,
                self.writable_roots.as_deref().unwrap_or_default(),
                local_storage,
            )
            .await?;
            Ok((Some(strict), profile))
        } else {
            Ok((None, workspace_profile(std::slice::from_ref(&self.cwd))))
        }
    }

    pub(crate) async fn selection(
        &self,
        config: &Config,
        manager: &EnvironmentManager,
        local_storage: Option<&Path>,
    ) -> Result<(TurnEnvironmentSelection, Option<StrictExecutorWrites>)> {
        self.check_config(config)?;
        let environment = manager
            .get_environment(self.id())
            .context("selected executor was not registered")?;
        let needs_info = self.strict_writes()
            || self.network.is_some()
            || self.cwd.infer_path_convention() == Some(PathConvention::Windows);
        let (strict, profile, windows_executor) = if needs_info {
            let info = executor_info(&environment).await?;
            let (strict, profile) = self
                .profile(config, &environment, &info, local_storage)
                .await?;
            self.check_network_target(&info, &profile)?;
            (
                strict,
                profile,
                info.platform_os.as_deref() == Some("windows"),
            )
        } else {
            (
                None,
                workspace_profile(std::slice::from_ref(&self.cwd)),
                false,
            )
        };
        let permissions = &config.permissions;
        let windows_sandbox_type = config.windows_sandbox_type_from_config();
        let windows_sandbox_level = match WindowsSandboxLevel::from_config(config) {
            // Core's legacy approval check runs on the controller. For a verified Unix
            // peer, the POSIX workspace keeps Windows sandbox selection off the wire.
            WindowsSandboxLevel::Disabled
                if windows_sandbox_type == SandboxType::None
                    && (windows_executor || (cfg!(windows) && self.network.is_some())) =>
            {
                WindowsSandboxLevel::RestrictedToken
            }
            configured => configured,
        };
        let selected_capability_roots = self.capability_roots().unwrap_or_default();
        let workspace_roots = vec![self.cwd.clone()];
        let shell_environment_policy = if self.local {
            ShellEnvironmentPolicy {
                inherit: ShellEnvironmentPolicyInherit::None,
                r#set: local_command_env(),
                ..Default::default()
            }
        } else {
            permissions.shell_environment_policy.clone()
        };
        let selection = TurnEnvironmentSelection {
            environment_id: self.id().to_owned(),
            workspace_roots: workspace_roots.clone(),
            cwd: self.cwd.clone(),
            // Owner configuration prevents executor-advertised roots from being added.
            config: EnvironmentConfigState::Ready(EnvironmentConfig {
                allow_login_shell: !self.local && permissions.allow_login_shell,
                workspace_roots,
                permission_profile: PermissionProfileSnapshot::legacy(profile),
                shell_environment_policy,
                windows_sandbox_level,
                windows_sandbox_type,
                use_legacy_landlock: config.features.use_legacy_landlock(),
                exec_policy: None,
                mcp_policy: None,
                network_policy: if self.local {
                    None
                } else {
                    self.network.clone()
                },
                selected_capability_roots,
            }),
        };
        Ok((selection, strict))
    }

    pub(crate) fn configure_local_proxy(
        &self,
        config: &mut Config,
        selection: &TurnEnvironmentSelection,
    ) -> Result<()> {
        let Some(network) = self.network.as_ref().filter(|_| self.local) else {
            return Ok(());
        };
        let EnvironmentConfigState::Ready(settings) = &selection.config else {
            anyhow::bail!("local network policy requires a ready Session Environment");
        };
        ensure!(
            selection.environment_id == LOCAL_ENVIRONMENT_ID
                && config.permissions.network.is_none(),
            "local network policy cannot replace an existing controller proxy"
        );
        config.permissions.network = Some(local_proxy_spec(
            network,
            settings.permission_profile.permission_profile(),
        )?);
        Ok(())
    }
}

fn local_proxy_spec(
    network: &EnvironmentNetworkPolicy,
    profile: &PermissionProfile,
) -> Result<NetworkProxySpec> {
    let domains = network
        .domains
        .as_ref()
        .map(|domains| NetworkDomainPermissionsToml {
            entries: domains
                .entries
                .iter()
                .filter_map(|entry| {
                    let permission = match entry.permission {
                        NetworkDomainPermission::Allow => NetworkDomainPermissionToml::Allow,
                        NetworkDomainPermission::Deny => NetworkDomainPermissionToml::Deny,
                        NetworkDomainPermission::None => return None,
                    };
                    Some((entry.pattern.clone(), permission))
                })
                .collect(),
        });
    // Core keeps these constraints when it recomputes the session proxy for a new profile.
    NetworkProxySpec::from_config_and_constraints(
        Default::default(),
        Some(NetworkConstraints {
            enabled: Some(true),
            http_port: Some(0),
            socks_port: Some(0),
            allow_upstream_proxy: Some(false),
            dangerously_allow_non_loopback_proxy: Some(false),
            dangerously_allow_all_unix_sockets: Some(network.dangerously_allow_all_unix_sockets),
            domains,
            managed_allowed_domains_only: Some(true),
            allow_local_binding: network.allow_local_binding,
            ..Default::default()
        }),
        profile,
    )
    .context("could not configure the local executor network proxy")
}

pub(crate) fn local_session_network_policy(config: &Config) -> Option<EnvironmentNetworkPolicy> {
    config
        .permissions
        .network
        .as_ref()
        .map(NetworkProxySpec::environment_policy)
        .filter(|policy| policy.requires_proxy)
}

fn workspace_profile(roots: &[PathUri]) -> PermissionProfile {
    PermissionProfile::workspace_write_with_path_uris(
        &[],
        NetworkSandboxPolicy::Restricted,
        true,
        true,
    )
    .materialize_project_roots_with_path_uris(roots)
}

fn check_rule_directories(config: &Config) -> Result<()> {
    let stack = &config.config_layer_stack;
    ensure!(
        stack.requirements().exec_policy.is_none(),
        "strict executor write policy does not support managed exec-policy rules"
    );
    for layer in stack.layers_low_to_high() {
        if stack.ignore_user_and_project_exec_policy_rules()
            && matches!(
                layer.name,
                codex_config::ConfigLayerSource::User { .. }
                    | codex_config::ConfigLayerSource::Project { .. }
            )
        {
            continue;
        }
        let Some(folder) = layer.config_folder() else {
            continue;
        };
        match std::fs::symlink_metadata(folder.join("rules")) {
            Ok(_) => anyhow::bail!(
                "strict executor write policy does not support native exec-policy rule directories"
            ),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => anyhow::bail!("could not verify native exec-policy rule directories"),
        }
    }
    Ok(())
}

fn check_writable_config(config: &Config, local_session_proxy: bool) -> Result<()> {
    check_rule_directories(config)?;
    let approval = config.permissions.approval_policy.value();
    let no_escalation = approval == AskForApproval::Never
        || matches!(approval, AskForApproval::Granular(policy) if !policy.sandbox_approval && !policy.request_permissions);
    ensure!(
        no_escalation
            && (local_session_proxy || config.permissions.network.is_none())
            && !config.features.use_legacy_landlock()
            && config
                .features
                .enabled(codex_core_api::Feature::WriteStdinApproval)
            && !config
                .features
                .enabled(codex_core_api::Feature::RequestPermissionsTool),
        "strict executor write policy requires the standard sandbox with escalation and permission requests disabled"
    );
    Ok(())
}

async fn executor_info(environment: &Environment) -> Result<EnvironmentInfo> {
    environment.info().await.map_err(|error| {
        anyhow::anyhow!(
            "could not verify executor capabilities: {}",
            startup_cause(&error)
        )
    })
}

async fn strict_write_profile(
    config: &Config,
    environment: &Environment,
    info: &EnvironmentInfo,
    cwd: &PathUri,
    additional: &[PathUri],
    local_storage: Option<&Path>,
) -> Result<(StrictExecutorWrites, PermissionProfile)> {
    ensure!(
        matches!(
            Platform::from_platform_os(info.platform_os.as_deref()),
            Platform::Linux | Platform::Macos
        ) && info.capabilities.sandboxed_file_streaming,
        "strict executor write policy requires a Linux or macOS executor with sandboxed file access"
    );
    // Resolve on the executor, so controller path aliases cannot change the grant.
    let filesystem = environment.get_filesystem();
    let mut roots = Vec::with_capacity(additional.len() + 1);
    let mut root_pins = HashMap::new();
    for root in std::iter::once(cwd).chain(additional) {
        ensure!(
            root.infer_path_convention() == Some(PathConvention::Posix) && root.parent().is_some(),
            "executor write roots must be absolute directories below the filesystem root"
        );
        let canonical = filesystem
            .canonicalize(root, None)
            .await
            .map_err(|_| anyhow::anyhow!("could not resolve an executor write root"))?;
        ensure!(
            canonical.infer_path_convention() == Some(PathConvention::Posix)
                && canonical.parent().is_some()
                && filesystem
                    .get_metadata(
                        &canonical,
                        GetMetadataOptions {
                            follow_symlinks: false
                        },
                        None
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("could not verify an executor write root"))?
                    .is_directory,
            "executor write roots must be existing directories below the filesystem root"
        );
        for path in [root, &canonical] {
            if let Some(previous) = root_pins.insert(write_root_key(path), canonical.clone()) {
                ensure!(
                    previous == canonical,
                    "An executor write root changed its resolved directory"
                );
            }
        }
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }
    // The cwd remains first; equivalent declarations keep the same digest.
    roots[1..].sort_by_key(ToString::to_string);
    let mut filesystem_policy = workspace_profile(&roots).file_system_sandbox_policy();
    if !environment.is_remote() {
        let local_roots = roots
            .iter()
            .map(PathUri::to_abs_path)
            .collect::<Result<Vec<_>, _>>()?;
        check_local_helper_write_roots(config, &local_roots)?;
        if let Some(storage) = local_storage {
            check_local_storage_write_roots(&local_roots, storage)?;
        }
        for entry in &mut filesystem_policy.entries {
            if entry.access == FileSystemAccessMode::Read
                && matches!(
                    entry.path,
                    FileSystemPath::Special {
                        value: FileSystemSpecialPath::Root
                    }
                )
            {
                entry.path = FileSystemPath::Special {
                    value: FileSystemSpecialPath::Minimal,
                };
            }
        }
    }
    // A caller may explicitly grant a linked worktree's gitdir or common dir.
    // Remove only default carveouts at those exact paths. Core still adds
    // read-only carveouts for protected metadata under every granted root.
    filesystem_policy.entries.retain(|entry| {
        entry.access != FileSystemAccessMode::Read
            || !matches!(&entry.path, FileSystemPath::Path { path } if roots.contains(path))
    });
    Ok((
        StrictExecutorWrites {
            canonical_cwd: roots[0].clone(),
            root_pins,
        },
        PermissionProfile::from_runtime_permissions(
            &filesystem_policy,
            NetworkSandboxPolicy::Restricted,
        ),
    ))
}

fn check_local_helper_write_roots(config: &Config, roots: &[AbsolutePathBuf]) -> Result<()> {
    let code_mode = config
        .codex_self_exe
        .as_ref()
        .map(|path| path.with_file_name("codex-code-mode-host"))
        .filter(|path| path.is_file());
    let helpers = [
        config.codex_self_exe.as_deref(),
        config.codex_linux_sandbox_exe.as_deref(),
        config.main_execve_wrapper_exe.as_deref(),
        code_mode.as_deref(),
    ];
    let system_search = LOCAL_COMMAND_PATH
        .split(':')
        .filter(|_| cfg!(target_os = "linux"))
        .map(Path::new);
    check_local_helper_paths(roots, helpers.into_iter().flatten(), system_search)
}

fn check_local_helper_paths<'a>(
    roots: &[AbsolutePathBuf],
    helpers: impl IntoIterator<Item = &'a Path>,
    system_search: impl IntoIterator<Item = &'a Path>,
) -> Result<()> {
    let verify = |path: &Path| -> Result<()> {
        resolve_local_path(
            path,
            false,
            "could not resolve a local sandbox helper path",
            |entry| {
                ensure!(
                    !roots.iter().any(|root| entry.starts_with(root.as_path())),
                    "local executor write roots must not contain installed sandbox helpers"
                );
                Ok(())
            },
        )?;
        Ok(())
    };
    for path in helpers {
        verify(path)?;
    }
    for directory in system_search {
        verify(directory)?;
        // A system bwrap may resolve outside its search directory. It can run
        // before isolation, even for the capability probe used to select it.
        let bwrap = directory.join("bwrap");
        if bwrap.symlink_metadata().is_ok() {
            verify(&bwrap)?;
        }
    }
    Ok(())
}

fn check_local_storage_write_roots(roots: &[AbsolutePathBuf], storage: &Path) -> Result<()> {
    const OVERLAP: &str = "Keep local session storage outside the executor cwd and writable roots";
    let resolved = resolve_local_path(
        storage,
        true,
        "could not resolve local session storage",
        |entry| {
            ensure!(
                !roots.iter().any(|root| entry.starts_with(root.as_path())),
                "{OVERLAP}"
            );
            Ok(())
        },
    )?;
    ensure!(
        !roots
            .iter()
            .any(|root| root.as_path().starts_with(&resolved)),
        "{OVERLAP}"
    );
    Ok(())
}

fn resolve_local_path(
    path: &Path,
    allow_missing: bool,
    error_context: &'static str,
    check_entry: impl Fn(&Path) -> Result<()>,
) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "{error_context}");
    let mut resolved = PathBuf::new();
    visit_local_path(
        path,
        &mut resolved,
        &mut 40,
        allow_missing,
        error_context,
        &check_entry,
    )?;
    Ok(resolved)
}

fn visit_local_path(
    path: &Path,
    resolved: &mut PathBuf,
    links_left: &mut usize,
    allow_missing: bool,
    error_context: &'static str,
    check_entry: &impl Fn(&Path) -> Result<()>,
) -> Result<()> {
    for part in path.components() {
        match part {
            Component::CurDir => continue,
            Component::ParentDir => {
                resolved.pop();
                continue;
            }
            _ => resolved.push(part),
        }
        let mut link = None;
        if matches!(part, Component::Normal(_)) {
            match resolved.symlink_metadata() {
                Ok(metadata) if metadata.is_symlink() => {
                    link = Some(resolved.read_link().context(error_context)?);
                }
                Ok(_) => *resolved = resolved.canonicalize().context(error_context)?,
                Err(error) if allow_missing && error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error).context(error_context),
            }
        }
        // Check each entry before following it. A writable link can redirect
        // the configured path even when its current target is outside the grant.
        check_entry(resolved)?;
        if let Some(target) = link {
            *links_left = links_left.checked_sub(1).context(error_context)?;
            resolved.pop();
            visit_local_path(
                &target,
                resolved,
                links_left,
                allow_missing,
                error_context,
                check_entry,
            )?;
        }
    }
    Ok(())
}

/// Replace just the write profile of the currently selected executor.
pub(crate) async fn replace_writable_roots(
    selection: &TurnEnvironmentSelection,
    config: &Config,
    manager: &EnvironmentManager,
    previous: &StrictExecutorWrites,
    writable_roots: Vec<PathUri>,
    local_storage: Option<&Path>,
) -> Result<(TurnEnvironmentSelection, StrictExecutorWrites)> {
    // The SDK installs its local proxy after rejecting an ambient controller at selection.
    let local = selection.environment_id == LOCAL_ENVIRONMENT_ID;
    check_writable_config(config, local)?;
    let mut selection = selection.clone();
    let EnvironmentConfigState::Ready(settings) = &mut selection.config else {
        anyhow::bail!("writable_roots requires a ready Session Environment")
    };
    let environment = manager
        .get_environment(&selection.environment_id)
        .context("selected executor was not registered")?;
    let info = executor_info(&environment).await?;
    let platform = Platform::from_platform_os(info.platform_os.as_deref());
    let (strict, profile) = strict_write_profile(
        config,
        &environment,
        &info,
        &selection.cwd,
        &writable_roots,
        local_storage,
    )
    .await?;
    strict.check_pins(previous)?;
    // An alias in a writable directory can change before the caller reuses
    // it. Require a canonical path to expand the active set of grants.
    ensure!(
        strict.root_pins.iter().all(|(path, target)| {
            let canonical = write_root_key(target);
            path == &canonical || previous.root_pins.get(&canonical) == Some(target)
        }),
        "New executor write roots must name their canonical directories"
    );
    let local_network = if local {
        local_session_network_policy(config)
    } else {
        None
    };
    if let Some(network) = settings.network_policy.as_ref().or(local_network.as_ref()) {
        ensure!(
            info.capabilities.network_proxy_launch,
            "network policy requires an executor with managed proxy launch"
        );
        validate_environment_network_policy(network, &profile, platform)?;
    }
    let next_profile = PermissionProfileSnapshot::legacy(profile);
    if platform == Platform::Macos && !local {
        // WSS macOS executors keep their opening Seatbelt grants for the Session.
        ensure!(
            settings.permission_profile == next_profile,
            "Cannot change writable roots on a macOS executor after opening the Session"
        );
    } else {
        settings.permission_profile = next_profile;
    }
    Ok((selection, strict))
}

fn executor_policy_values(
    selections: &[TurnEnvironmentSelection],
    config: &Config,
) -> Result<Vec<serde_json::Value>> {
    let local_network = local_session_network_policy(config);
    selections
        .iter()
        .map(|selection| {
            codex_protocol::protocol::sdk_executor_policy_receipt(
                selection,
                selection.environment_id == REMOTE_ENVIRONMENT_ID,
                local_network.as_ref(),
            )
            .context("Selected executor policy is unavailable")
        })
        .collect()
}

fn digest(policy: &[serde_json::Value]) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(policy)?)))
}

pub(crate) async fn checkpoint_policy(
    thread: &codex_core_api::CodexThread,
) -> Result<Option<String>> {
    if thread
        .thread_extension_data()
        .get::<StrictExecutorWrites>()
        .is_none()
    {
        return Ok(None);
    }
    let selections = thread.environment_selections().await;
    let config = thread.config().await;
    Ok(Some(digest(&executor_policy_values(
        &selections,
        &config,
    )?)?))
}

pub(crate) fn check_checkpoint_policy(
    recorded: Option<&str>,
    startup: &codex_core_api::StartThreadOptions,
) -> Result<()> {
    if let Some(expected) = recorded {
        ensure!(
            startup
                .thread_extension_init
                .get::<StrictExecutorWrites>()
                .is_some()
                && expected
                    == digest(&executor_policy_values(
                        startup.environments.as_deref().unwrap_or_default(),
                        &startup.config,
                    )?)?,
            "Restore requires the recorded executor write and network policy"
        );
    }
    Ok(())
}

/// Trusted current executor policy, compared under the durable writer lock.
#[derive(Default)]
pub(crate) struct LocalResumeExecutorPolicy {
    values: Vec<serde_json::Value>,
    strict: bool,
}

impl LocalResumeExecutorPolicy {
    pub(crate) fn from_startup(startup: &codex_core_api::StartThreadOptions) -> Result<Self> {
        Ok(Self {
            values: executor_policy_values(
                startup.environments.as_deref().unwrap_or_default(),
                &startup.config,
            )?,
            strict: startup
                .thread_extension_init
                .get::<StrictExecutorWrites>()
                .is_some(),
        })
    }

    pub(crate) fn validate(
        &self,
        history: &[codex_history::RolloutItem],
        id: codex_protocol::ThreadId,
    ) -> Result<()> {
        let id = id.to_string();
        let is_strict = |flag: Option<&serde_json::Value>| {
            flag.is_some_and(|flag| flag.as_bool() != Some(false))
        };
        let mut recorded = history.iter().rev().filter_map(|item| {
            let codex_history::RolloutItem::TurnContext(context) = item else {
                return None;
            };
            let receipt = context.sdk_receipt.as_ref()?;
            if receipt["thread_id"].as_str() != Some(id.as_str()) {
                return None;
            }
            let executors = receipt.get("executors");
            let strict_flag = receipt.get("strict_executor_writes");
            (executors.is_some() || is_strict(strict_flag)).then_some((executors, strict_flag))
        });
        if let Some((previous, strict_flag)) = recorded.next() {
            let previous = previous
                .and_then(serde_json::Value::as_array)
                .context("Local resume requires a valid recorded executor policy")?;
            let strict = is_strict(strict_flag);
            let same_policy = if previous.is_empty() {
                let model_only = self.values.is_empty();
                let implicit_remote = matches!(
                    self.values.as_slice(),
                    [policy] if is_implicit_remote_policy(policy)
                );
                // A fresh implicit workspace may attach only to model-only history.
                // An executorless reopen can follow an earlier verified implicit grant.
                !strict
                    && !self.strict
                    && (model_only || implicit_remote)
                    && recorded.all(|(policies, flag)| {
                        !is_strict(flag)
                            && policies.and_then(Value::as_array).is_some_and(|policies| {
                                policies.is_empty()
                                    || (model_only
                                        && policies.iter().all(is_implicit_remote_policy))
                            })
                    })
            } else if strict || self.strict {
                // Legacy receipts lacked the mode and still require an exact profile.
                strict_flag.is_none_or(|flag| flag.as_bool() == Some(self.strict))
                    && *previous == self.values
            } else if self.values.is_empty() {
                // A durable session without an Environment has no executor.
                previous.iter().all(is_implicit_remote_policy)
            } else {
                // For implicit remote grants, cwd and its materialized write
                // paths are chosen by the current trusted workspace owner.
                previous.len() == self.values.len()
                    && previous.iter().zip(&self.values).all(|(before, after)| {
                        before == after || same_implicit_remote_policy(before, after)
                    })
            };
            ensure!(
                same_policy,
                "Local resume requires the recorded executor write and network policy"
            );
        }
        Ok(())
    }
}

fn implicit_remote_workspace_receipt(
    receipt: &serde_json::Value,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    let receipt = receipt.as_object()?;
    if receipt.get("transport")?.as_str()? != "remote" {
        return None;
    }
    let cwd = receipt.get("cwd")?;
    if receipt.get("writable_roots")?.as_array()?.as_slice() != std::slice::from_ref(cwd) {
        return None;
    }
    let cwd = PathUri::parse(cwd.as_str()?).ok()?;
    let profile = serde_json::to_value(workspace_profile(&[cwd])).ok()?;
    (receipt.get("permission_profile")? == &profile).then_some(receipt)
}

fn same_implicit_remote_policy(before: &serde_json::Value, after: &serde_json::Value) -> bool {
    let (Some(before), Some(after)) = (
        implicit_remote_workspace_receipt(before),
        implicit_remote_workspace_receipt(after),
    ) else {
        return false;
    };
    before.len() == after.len()
        && before.iter().all(|(key, value)| {
            matches!(
                key.as_str(),
                "cwd" | "writable_roots" | "permission_profile"
            ) || after.get(key) == Some(value)
        })
}

fn is_implicit_remote_policy(receipt: &Value) -> bool {
    let Some(receipt) = implicit_remote_workspace_receipt(receipt) else {
        return false;
    };
    if receipt.len() != 7
        || receipt.get("environment_id").and_then(Value::as_str) != Some(REMOTE_ENVIRONMENT_ID)
        || receipt.get("network_sandbox").and_then(Value::as_str) != Some("restricted")
    {
        return false;
    }
    // Recognize only the fields written by the legacy remote receipt producer.
    match receipt.get("network_policy") {
        Some(Value::Null) => true,
        Some(Value::Object(policy)) => {
            policy.len() == 4
                && policy.get("requires_proxy").and_then(Value::as_bool) == Some(true)
                && policy
                    .get("allow_all_unix_sockets")
                    .is_some_and(Value::is_boolean)
                && policy
                    .get("allow_local_binding")
                    .is_some_and(Value::is_boolean)
                && policy
                    .get("domains")
                    .and_then(Value::as_object)
                    .is_some_and(|domains| {
                        domains
                            .values()
                            .all(|value| matches!(value.as_str(), Some("allow" | "deny")))
                    })
        }
        _ => false,
    }
}

/// The candidate of an in-place context change belongs to the same live
/// owner. Its declaration must carry the roots currently applied by Core.
pub(crate) async fn context_candidate_runtime(
    thread: &codex_core_api::CodexThread,
    runtime: &str,
) -> Result<String> {
    if thread
        .thread_extension_data()
        .get::<StrictExecutorWrites>()
        .is_none()
    {
        return Ok(runtime.to_owned());
    }
    let selections = thread.environment_selections().await;
    let [selection] = selections.as_slice() else {
        anyhow::bail!("strict executor context change requires one selected Environment");
    };
    let config = thread.config().await;
    let local_network = local_session_network_policy(&config);
    let receipt = codex_protocol::protocol::sdk_executor_policy_receipt(
        selection,
        selection.environment_id == REMOTE_ENVIRONMENT_ID,
        local_network.as_ref(),
    )
    .context("Selected executor policy is unavailable")?;
    let mut runtime: serde_json::Value = serde_json::from_str(runtime)?;
    let environment = runtime
        .get_mut("environment")
        .and_then(serde_json::Value::as_object_mut)
        .context("strict executor context change requires a current Environment declaration")?;
    environment.insert(
        "writable_roots".to_owned(),
        receipt["writable_roots"].clone(),
    );
    Ok(serde_json::to_string(&runtime)?)
}

fn check_local_helpers(config: &Config) -> Result<()> {
    ensure!(
        cfg!(any(target_os = "linux", target_os = "macos")),
        "the local executor requires Linux or macOS"
    );
    ensure!(
        config
            .codex_self_exe
            .as_ref()
            .is_some_and(|path| path.is_file()),
        "local executor requires the native process helper"
    );
    #[cfg(target_os = "linux")]
    ensure!(
        config
            .codex_linux_sandbox_exe
            .as_ref()
            .is_some_and(|path| path.is_file()),
        "local executor requires the native Linux sandbox helper"
    );
    Ok(())
}

async fn probe_local_sandbox(
    environment: &Environment,
    cwd: &PathUri,
    profile: PermissionProfile,
) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let runtime = environment
            .local_runtime_paths()
            .context("local executor requires the native macOS helper")?;
        codex_exec_server::darwin_command::check_supported(runtime.codex_self_exe.as_path())
            .await
            .context("local executor could not establish managed macOS command cleanup")?;
    }
    // The direct local backend has no transport handshake. A fixed command
    // verifies that this process can launch the requested sandbox.
    let params = ExecParams {
        process_id: ProcessId::new("sdk-local-sandbox-readiness"),
        metadata: None,
        argv: vec!["/bin/sh".to_owned(), "-c".to_owned(), "exit 0".to_owned()],
        cwd: cwd.clone(),
        env_policy: None,
        shell_snapshot: None,
        env: local_command_env(),
        tty: false,
        pipe_stdin: false,
        arg0: None,
        sandbox: Some(FileSystemSandboxContext::from_permission_profile(
            profile,
            cwd.clone(),
        )),
        enforce_managed_network: false,
        managed_network: None,
        network_proxy: None,
    };
    let backend = environment.get_exec_backend();
    let process = backend.start(params).await.map_err(|error| {
        anyhow::anyhow!(
            "local executor sandbox launch failed: {}",
            startup_cause(&error)
        )
    })?;
    let expected_sandbox = if cfg!(target_os = "macos") {
        SandboxType::MacosSeatbelt
    } else {
        SandboxType::LinuxSeccomp
    };
    let mut events = process.process.subscribe_events();
    let verified = tokio::time::timeout(Duration::from_secs(5), async {
        while let Ok(event) = events.recv().await {
            match event {
                ExecProcessEvent::Output(_) => {}
                ExecProcessEvent::Exited { exit_code, .. } => return exit_code == 0,
                _ => return false,
            }
        }
        false
    })
    .await;
    if process.sandbox_type != Some(expected_sandbox) || !matches!(verified, Ok(true)) {
        let _ = process.process.terminate().await;
        anyhow::bail!("local executor could not establish the platform sandbox");
    }
    Ok(())
}

fn startup_cause(mut error: &ExecServerError) -> String {
    while let ExecServerError::ConnectionAttempt(source) = error {
        error = source;
    }
    match error {
        ExecServerError::Spawn(error) => format!("process launch failed ({:?})", error.kind()),
        ExecServerError::WebSocketConnectTimeout { .. } => "WebSocket connection timed out".into(),
        ExecServerError::WebSocketConnect { source, .. } => websocket_cause(source),
        ExecServerError::WebSocketConfiguration(_) => {
            "invalid WebSocket connection configuration".into()
        }
        ExecServerError::InitializeTimedOut { .. } => "executor initialization timed out".into(),
        ExecServerError::ApplicationNetworkPolicy(_) => {
            "application network policy denied the connection".into()
        }
        ExecServerError::AuthenticationRequired(_) => "executor authentication denied".into(),
        ExecServerError::Closed | ExecServerError::Disconnected(_) => {
            "connection closed during startup".into()
        }
        ExecServerError::Protocol(_) | ExecServerError::Json(_) => {
            "executor protocol error during startup".into()
        }
        ExecServerError::Server { code, .. } => {
            format!("executor rejected initialization (RPC code {code})")
        }
        _ => "executor connection or initialization failed".into(),
    }
}

fn websocket_cause(error: &WebSocketError) -> String {
    match error {
        WebSocketError::Http(response) => {
            let status = response.status();
            let reason = if matches!(
                status,
                http::StatusCode::UNAUTHORIZED | http::StatusCode::FORBIDDEN
            ) {
                "executor authentication denied"
            } else {
                "WebSocket handshake rejected"
            };
            format!("{reason} (HTTP {})", status.as_u16())
        }
        WebSocketError::Io(error) => {
            if let Some(error) = error
                .get_ref()
                .and_then(|source| source.downcast_ref::<rustls::Error>())
            {
                tls_cause(error).into()
            } else if error.kind() == ErrorKind::ConnectionRefused {
                "connection refused".into()
            } else {
                format!("WebSocket connection I/O failed ({:?})", error.kind())
            }
        }
        WebSocketError::Tls(TlsError::Rustls(error)) => tls_cause(error).into(),
        WebSocketError::Tls(_) => "TLS handshake failed".into(),
        WebSocketError::Protocol(_) => "WebSocket handshake protocol error".into(),
        _ => "WebSocket connection failed".into(),
    }
}

fn tls_cause(error: &rustls::Error) -> &'static str {
    use rustls::{CertificateError, Error};
    match error {
        Error::InvalidCertificate(CertificateError::UnknownIssuer) => {
            "TLS certificate issuer is not trusted"
        }
        Error::InvalidCertificate(
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
        ) => "TLS certificate does not match the executor host",
        Error::InvalidCertificate(_) => "TLS certificate verification failed",
        _ => "TLS handshake failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn durable_resume_does_not_skip_a_malformed_executor_receipt() {
        let id = codex_protocol::ThreadId::new();
        let context = |receipt| {
            serde_json::from_value::<codex_history::RolloutItem>(json!({
                "type": "turn_context",
                "payload": {
                    "sdk_receipt": receipt,
                    "cwd": std::env::current_dir().unwrap(),
                    "approval_policy": AskForApproval::Never,
                    "sandbox_policy": codex_protocol::protocol::SandboxPolicy::new_read_only_policy(),
                    "model": "synthetic-model",
                    "summary": "auto",
                },
            }))
            .unwrap()
        };
        let values = vec![json!({ "transport": "remote" })];
        let older = context(json!({
            "thread_id": id,
            "strict_executor_writes": true,
            "executors": values,
        }));
        let policy = LocalResumeExecutorPolicy {
            values,
            strict: true,
        };
        let legacy = context(json!({ "thread_id": id }));
        assert!(policy.validate(&[older.clone(), legacy], id).is_ok());
        let legacy_model_only = context(json!({ "thread_id": id, "executors": [] }));
        assert!(
            LocalResumeExecutorPolicy::default()
                .validate(std::slice::from_ref(&legacy_model_only), id)
                .is_ok()
        );
        assert!(policy.validate(&[legacy_model_only], id).is_err());

        let malformed = context(json!({ "thread_id": id, "executors": "invalid" }));
        let empty = context(json!({ "thread_id": id, "executors": [] }));
        assert!(
            LocalResumeExecutorPolicy::default()
                .validate(&[malformed.clone(), empty], id)
                .is_err()
        );
        let error = policy.validate(&[older, malformed], id).unwrap_err();
        assert!(error.to_string().contains("valid recorded executor policy"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_writable_target_of_a_system_sandbox_helper() {
        let directory = tempfile::tempdir().unwrap();
        let system_bin = directory.path().join("bin");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&system_bin).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let root = AbsolutePathBuf::from_absolute_path(workspace.canonicalize().unwrap()).unwrap();
        let check = || {
            check_local_helper_paths(
                std::slice::from_ref(&root),
                std::iter::empty(),
                std::iter::once(system_bin.as_path()),
            )
        };
        assert!(check().is_ok());

        let target = workspace.join("helper");
        std::fs::write(&target, b"synthetic helper").unwrap();
        std::os::unix::fs::symlink(&target, system_bin.join("bwrap")).unwrap();
        let error = check().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("write roots must not contain installed sandbox helpers")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_writable_intermediate_hop_of_a_system_sandbox_helper() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let system_bin = directory.path().join("bin");
        let workspace = directory.path().join("workspace");
        let trusted = directory.path().join("trusted");
        for path in [&system_bin, &workspace, &trusted] {
            std::fs::create_dir(path).unwrap();
        }
        let bwrap = system_bin.join("bwrap");
        let hop = workspace.join("bwrap-link");
        std::fs::write(trusted.join("bwrap"), b"trusted").unwrap();
        std::fs::write(workspace.join("replacement"), b"replacement").unwrap();
        symlink("../trusted/bwrap", &hop).unwrap();
        symlink("../workspace/bwrap-link", &bwrap).unwrap();

        let root = AbsolutePathBuf::from_absolute_path(workspace.canonicalize().unwrap()).unwrap();
        let check =
            |roots| check_local_helper_paths(roots, std::iter::empty(), [system_bin.as_path()]);
        assert!(check(&[]).is_ok());
        assert_eq!(std::fs::read(&bwrap).unwrap(), b"trusted");
        let overlap = check(std::slice::from_ref(&root));
        std::fs::remove_file(&hop).unwrap();
        symlink("replacement", &hop).unwrap();
        assert_eq!(std::fs::read(&bwrap).unwrap(), b"replacement");
        assert!(
            overlap
                .unwrap_err()
                .to_string()
                .contains("write roots must not contain installed sandbox helpers")
        );
    }

    #[test]
    fn implicit_relocation_preserves_the_rest_of_the_receipt() {
        let receipt = |cwd| {
            let cwd = PathUri::parse(cwd).unwrap();
            json!({
                "environment_id": REMOTE_ENVIRONMENT_ID,
                "transport": "remote",
                "cwd": cwd,
                "writable_roots": [cwd],
                "permission_profile": workspace_profile(std::slice::from_ref(&cwd)),
                "network_sandbox": "restricted",
                "network_policy": null,
            })
        };
        let before = receipt("file:///before");
        let after = receipt("file:///after");
        assert!(same_implicit_remote_policy(&before, &after));
        assert!(is_implicit_remote_policy(&before));

        let mut changed_profile = before.clone();
        changed_profile["permission_profile"] = json!(PermissionProfile::read_only());
        assert!(!same_implicit_remote_policy(&changed_profile, &after));
        assert!(!is_implicit_remote_policy(&changed_profile));

        let mut changed_roots = before.clone();
        changed_roots["writable_roots"] = json!(["file:///before", "file:///extra"]);
        assert!(!same_implicit_remote_policy(&changed_roots, &after));
        assert!(!is_implicit_remote_policy(&changed_roots));

        let mut changed_identity = before.clone();
        changed_identity["environment_id"] = json!("unknown");
        assert!(!is_implicit_remote_policy(&changed_identity));

        let mut explicit_network = before.clone();
        explicit_network["network_policy"] = json!({
            "requires_proxy": true,
            "allow_all_unix_sockets": true,
            "allow_local_binding": false,
            "domains": {"example.invalid": "allow"},
        });
        assert!(is_implicit_remote_policy(&explicit_network));
        explicit_network["network_policy"]["domains"]["example.invalid"] = json!("unknown");
        assert!(!is_implicit_remote_policy(&explicit_network));

        let mut extra_field = before;
        extra_field["extra_field"] = json!(true);
        assert!(!same_implicit_remote_policy(&extra_field, &after));
        assert!(!is_implicit_remote_policy(&extra_field));
    }

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

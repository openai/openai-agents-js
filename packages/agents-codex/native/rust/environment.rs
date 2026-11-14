//! Register admitted MCP execution and bind the selected executor.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use codex_config::{NetworkConstraints, NetworkDomainPermissionToml, NetworkDomainPermissionsToml};
use codex_core::{
    config::validate_environment_network_policy, project_read_path::ProjectReadPathMapping,
    windows_sandbox::WindowsSandboxLevelExt,
};
use codex_core_api::{
    AbsolutePathBuf, Config, EnvironmentManager, EnvironmentNetworkPolicy, NetworkDomainPermission,
    NetworkDomainPermissionEntry, NetworkDomainPermissions, NetworkProxySpec, SqliteConfig,
};
use codex_exec_server::{
    Environment, EnvironmentInfo, ExecOutputStream, ExecParams, ExecProcessEvent, ExecServerError,
    ExecServerRuntimeOptions, FileSystemSandboxContext, GetMetadataOptions, LOCAL_ENVIRONMENT_ID,
    LocalWriteRoots, ProcessId, REMOTE_ENVIRONMENT_ID, RemoteEnvironmentOptions,
    StdioExecServerCommand,
};
use codex_history::RolloutItem;
use codex_protocol::capabilities::{CapabilityRootLocation, SelectedCapabilityRoot};
use codex_protocol::config_types::{
    ShellEnvironmentPolicy, ShellEnvironmentPolicyInherit, WindowsSandboxLevel,
};
use codex_protocol::models::{
    ManagedFileSystemPermissions, PermissionProfile, PermissionProfileSnapshot, ResponseItem,
};
use codex_protocol::permissions::{
    FileSystemAccessMode, FileSystemPath, FileSystemSandboxEntry, FileSystemSpecialPath,
    NetworkSandboxPolicy,
};
use codex_protocol::protocol::{
    AskForApproval, EnvironmentConfig, EnvironmentConfigState, EventMsg, GranularApprovalConfig,
    TurnEnvironmentSelection,
};
use codex_protocol::sandbox::SandboxType;
use codex_utils_path_uri::{PathConvention, PathUri, Platform};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_rustls::rustls;
use tokio_tungstenite::tungstenite::{Error as WebSocketError, error::TlsError};

#[cfg(target_os = "linux")]
#[path = "linux_apparmor_probe.rs"]
mod linux_apparmor_probe;

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
    let paths = if restricted {
        restricted_local_runtime(config)?
    } else {
        ExecServerRuntimeOptions::from_optional_paths(
            config.codex_self_exe.clone(),
            config.codex_linux_sandbox_exe.clone(),
        )?
    };
    // The SDK owns its explicit execution selection. Reserve host MCP capacity
    // without reading ambient Noise or user environment configuration.
    Ok(EnvironmentManager::with_unselected_local_environment(
        paths,
        config.http_client_factory(),
    )?)
}

fn restricted_local_runtime(config: &Config) -> Result<ExecServerRuntimeOptions> {
    check_local_helpers(config)?;
    let paths = ExecServerRuntimeOptions::from_optional_paths(
        config.codex_self_exe.clone(),
        config.codex_linux_sandbox_exe.clone(),
    )?
    .with_file_system_helper_env(local_command_env())
    .with_join_unreturned_local_exec_on_interrupt();
    #[cfg(target_os = "macos")]
    let paths = paths.with_restricted_macos_process_sandbox();
    Ok(paths)
}

const LOCAL_COMMAND_PATH: &str = "/usr/bin:/bin";

fn local_command_env() -> HashMap<String, String> {
    // Provide a predictable default for commands without importing host values.
    HashMap::from([("PATH".to_owned(), LOCAL_COMMAND_PATH.to_owned())])
}

fn trusted_command_env(
    temp: &Path,
    allow_all_unix_sockets: bool,
) -> Result<HashMap<String, String>> {
    let mut env = local_command_env();
    for key in [
        "HOME",
        "GIT_CONFIG_GLOBAL",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LC_MESSAGES",
        "TERM",
        "PATH",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_owned(), value);
        }
    }
    if allow_all_unix_sockets && let Ok(socket) = std::env::var("SSH_AUTH_SOCK") {
        env.insert("SSH_AUTH_SOCK".to_owned(), socket);
    }
    let temp = temp
        .to_str()
        .context("Trusted local command temp requires a UTF-8 path")?;
    env.insert("TMPDIR".to_owned(), temp.to_owned());
    Ok(env)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum LocalWritePolicy {
    TrustedWorkspaceWrite,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentOptions {
    url: Option<String>,
    #[serde(default)]
    stdio_command: Option<StdioCommandOptions>,
    #[serde(default)]
    local: bool,
    cwd: PathUri,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default, rename = "env_json", deserialize_with = "deserialize_env")]
    env: HashMap<String, String>,
    connect_timeout: Option<f64>,
    capability_directories: Option<Vec<PathUri>>,
    writable_roots: Option<Vec<PathUri>>,
    write_policy: Option<LocalWritePolicy>,
    #[serde(default)]
    read_only_roots: Vec<PathUri>,
    #[serde(default)]
    read_only: bool,
    #[serde(default, deserialize_with = "deserialize_mounts")]
    mounts: Option<Vec<LocalStorageMount>>,
    #[serde(default, deserialize_with = "deserialize_network")]
    network: Option<EnvironmentNetworkPolicy>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct StdioCommandOptions {
    #[serde(default)]
    require_process_identity: bool,
    program: String,
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    cwd: Option<PathBuf>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalStorageMount {
    source: String,
    destination: String,
    strategy: String,
    #[serde(default = "mount_read_only")]
    read_only: bool,
}

fn mount_read_only() -> bool {
    true
}

fn deserialize_env<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<String, String>, D::Error> {
    let encoded = String::deserialize(deserializer)
        .map_err(|_| serde::de::Error::custom("invalid environment variables"))?;
    let values: HashMap<String, String> = serde_json::from_str(&encoded)
        .map_err(|_| serde::de::Error::custom("invalid environment variables"))?;
    if values.iter().any(|(name, value)| {
        name.is_empty()
            || codex_protocol::shell_environment::is_non_inheritable_env_var(name)
            || [
                "CODEX_SDK_BWRAP_SEARCH_PATH",
                "CARGO_BIN_EXE_bwrap",
                "CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE",
                "CODEX_SANDBOX_COMMAND_ENV_JSON",
                "CODEX_THREAD_ID",
                "CODEX_SESSION_ID",
                "CODEX_VERSION",
                "CODEX_PERMISSION_PROFILE",
                "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS",
                "CODEX_PLUGIN_METRICS_OUTPUT",
            ]
            .iter()
            .any(|reserved| name.eq_ignore_ascii_case(reserved))
            || name
                .get(.."CODEX_SANDBOX_COMMAND_ENV_JSON_".len())
                .is_some_and(|prefix| {
                    prefix.eq_ignore_ascii_case("CODEX_SANDBOX_COMMAND_ENV_JSON_")
                })
            || name.contains(['\0', '='])
            || value.contains('\0')
    }) {
        return Err(serde::de::Error::custom("invalid environment variables"));
    }
    Ok(values)
}

fn environment_target_name_validation_required(
    platform: Option<&str>,
    supported: bool,
) -> Result<bool> {
    ensure!(
        platform.is_some(),
        "explicit environment variables require the executor platform"
    );
    if platform == Some("windows") {
        ensure!(
            supported,
            "explicit environment variables require native name validation on this Windows executor"
        );
        Ok(true)
    } else {
        Ok(false)
    }
}

async fn validate_environment_target_names(
    environment: &Environment,
    values: &HashMap<String, String>,
    info: &EnvironmentInfo,
) -> Result<()> {
    if values.is_empty()
        || !environment_target_name_validation_required(
            info.platform_os.as_deref(),
            info.capabilities.environment_variable_name_validation,
        )?
    {
        return Ok(());
    }
    environment
        .validate_environment_variable_names(values.keys().cloned().collect())
        .await
        .map_err(|_| anyhow::anyhow!("invalid explicit environment names for this executor"))
}

fn deserialize_mounts<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<LocalStorageMount>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    serde_json::from_value::<Vec<LocalStorageMount>>(value)
        .map(Some)
        .map_err(|_| serde::de::Error::custom("Invalid local storage mounts"))
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
    read_only_roots: Vec<PathUri>,
    has_storage_mounts: bool,
    read_only: bool,
    trusted_workspace_write: bool,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct LocalPrivatePaths<'a> {
    pub(crate) storage: Option<&'a Path>,
    pub(crate) saved_login_file: Option<&'a crate::auth::SavedLoginFile>,
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

    pub(crate) async fn check_local_rollout_path(&self, path: &Path) -> Result<()> {
        let existing = codex_rollout::existing_rollout_path(path).await;
        let roots = self
            .root_pins
            .values()
            .chain(&self.read_only_roots)
            .map(PathUri::to_abs_path)
            .collect::<Result<Vec<_>, _>>()?;
        let roots = LocalWriteRoots::new(&roots).context("could not verify local write roots")?;
        let resolved = resolve_local_rollout_path(&roots, path)?;
        let resolved = if let Some(existing) = existing.filter(|existing| existing != path) {
            resolve_local_rollout_path(&roots, &existing)?
        } else {
            resolved
        };
        // Resume can materialize a compressed rollout next to the canonical file.
        let plain = codex_rollout::plain_rollout_path(&resolved);
        let plain = (plain != resolved)
            .then(|| resolve_local_rollout_path(&roots, &plain))
            .transpose()?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let mut linked = linked_local_rollout_file(resolved)?
                .into_iter()
                .collect::<Vec<_>>();
            if let Some(plain) = plain {
                linked.extend(linked_local_rollout_file(plain)?);
            }
            ensure!(
                !roots.contains_hard_link_to_any(&linked)?,
                "{LOCAL_STORAGE_OVERLAP}; remove hard links to its files from the writable roots"
            );
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let _ = plain;
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

enum RemoteTransport {
    Stdio(StdioExecServerCommand, Option<Duration>),
    WebSocket(RemoteEnvironmentOptions),
}

fn environment_registration_error(error: codex_exec_server::ExecServerError) -> anyhow::Error {
    anyhow::anyhow!(
        "invalid remote executor connection settings: {}",
        startup_cause(&error)
    )
}

impl EnvironmentOptions {
    /// Current private stdio launch declaration, never restored data.
    pub(crate) fn requires_process_identity(&self) -> bool {
        self.stdio_command
            .as_ref()
            .is_some_and(|command| command.require_process_identity)
    }

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

    pub(crate) fn trusted_command_temp(&self) -> Result<Option<tempfile::TempDir>> {
        if self.write_policy.is_none() {
            return Ok(None);
        }
        let parent = std::env::temp_dir()
            .canonicalize()
            .context("Could not resolve the trusted local command temp directory")?;
        Ok(Some(
            tempfile::Builder::new()
                .prefix("agents-command-")
                .tempdir_in(parent)
                .context("Could not create a scoped trusted local command temp directory")?,
        ))
    }

    pub fn trusted_root(&self) -> &PathUri {
        &self.cwd
    }

    pub(crate) fn project_read_path_mapping(
        &self,
        strict: &StrictExecutorWrites,
    ) -> Option<ProjectReadPathMapping> {
        (self.local && self.cwd != strict.canonical_cwd).then(|| {
            ProjectReadPathMapping::new(
                self.id().to_owned(),
                self.cwd.clone(),
                strict.canonical_cwd.clone(),
            )
        })
    }

    pub fn capability_roots(&self) -> Option<Vec<SelectedCapabilityRoot>> {
        self.capability_roots_at(self.id())
    }

    fn capability_roots_at(&self, environment_id: &str) -> Option<Vec<SelectedCapabilityRoot>> {
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

    pub(crate) fn check_trusted_write_policy(&self) -> Result<()> {
        if self.write_policy.is_some() {
            ensure!(
                self.local,
                "Trusted workspace writes require a local Environment"
            );
            ensure!(
                !self.read_only,
                "Read-only execution requires strict write policy"
            );
            ensure!(
                cfg!(any(target_os = "linux", target_os = "macos")),
                "Trusted workspace writes require Linux or macOS"
            );
        }
        Ok(())
    }

    pub(crate) fn check_config(&self, config: &Config) -> Result<()> {
        ensure!(
            self.read_only_roots.is_empty() || (self.local && cfg!(target_os = "macos")),
            "read_only_roots requires a local macOS Environment"
        );
        self.check_trusted_write_policy()?;
        if self.read_only {
            ensure!(
                self.strict_writes(),
                "read-only execution requires strict write policy"
            );
            ensure!(
                self.writable_roots.as_ref().is_none_or(Vec::is_empty),
                "read-only execution does not accept writable_roots"
            );
            ensure!(
                !self.local || cfg!(any(target_os = "linux", target_os = "macos")),
                "read-only local execution requires Linux or macOS"
            );
        }
        self.validate_storage_mounts(config, LocalPrivatePaths::default())?;
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

    // Read grants can expose private state just as write grants can corrupt it.
    // Reuse physical/mount identity checks rather than compare path spellings only.
    fn validate_storage_mounts(
        &self,
        config: &Config,
        private_paths: LocalPrivatePaths<'_>,
    ) -> Result<Vec<PathUri>> {
        let Some(declarations) = &self.mounts else {
            return Ok(Vec::new());
        };
        ensure!(
            self.local && cfg!(target_os = "linux"),
            "Storage mounts require a local Linux Environment"
        );
        let error = "Invalid local storage mounts: require disjoint canonical existing directories, same-path local_bind, and read_only true";
        let mut mounts = Vec::new();
        #[cfg(target_os = "linux")]
        let mut linked_mount_files = Vec::new();
        let write_paths = std::iter::once(&self.cwd)
            .chain(self.writable_roots.iter().flatten())
            .map(|path| path.to_abs_path()?.canonicalize().context(error))
            .collect::<Result<Vec<_>>>()?;
        for mount in declarations {
            ensure!(
                mount.strategy == "local_bind"
                    && mount.read_only
                    && mount.source == mount.destination,
                "{error}"
            );
            let source = Path::new(&mount.source);
            ensure!(source.is_absolute() && source.parent().is_some(), "{error}");
            let canonical = source.canonicalize().context(error)?;
            ensure!(
                canonical.as_os_str() == source.as_os_str() && canonical.is_dir(),
                "{error}"
            );
            let path = PathUri::from_host_native_path(&canonical).context(error)?;
            let absolute = vec![path.to_abs_path()?];
            let authority = LocalWriteRoots::new(&absolute).context(error)?;
            for other in write_paths.iter().map(|path| path.as_path()).chain(
                mounts
                    .iter()
                    .map(|path: &PathUri| path.to_path_buf())
                    .collect::<Vec<_>>()
                    .iter()
                    .map(PathBuf::as_path),
            ) {
                ensure!(
                    !authority.contains_entry(other).context(error)?
                        && !authority.has_root_at_or_below(other).context(error)?,
                    "{error}"
                );
            }
            check_local_session_write_roots(
                config,
                &authority,
                private_paths,
                self.write_policy.is_some(),
            )
            .map(drop)
            .context("Storage mounts must not expose private SDK state")?;
            #[cfg(target_os = "linux")]
            linked_mount_files.extend(linked_local_protected_files(
                &canonical,
                false,
                Some(STORAGE_MOUNT_ENTRY_ERROR),
                "Could not inspect storage mount files for hard links",
            )?);
            mounts.push(path);
        }
        #[cfg(target_os = "linux")]
        if !linked_mount_files.is_empty() {
            let roots = LocalWriteRoots::new(&write_paths).context(error)?;
            ensure!(
                !roots
                    .contains_hard_link_to_any(&linked_mount_files)
                    .context("Could not inspect writable roots for storage mount hard links")?,
                "Storage mounts must not share hard-linked files with cwd or writable roots"
            );
        }
        mounts.sort_by_key(ToString::to_string);
        Ok(mounts)
    }

    pub(crate) fn check_local_session_paths(
        &self,
        config: &Config,
        private_paths: LocalPrivatePaths<'_>,
    ) -> Result<()> {
        self.validate_storage_mounts(config, private_paths)?;
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
        validate_local_read_only_roots(config, &self.read_only_roots, &roots, private_paths)?;
        let roots = LocalWriteRoots::new(&roots).context("could not verify local write roots")?;
        check_local_session_write_roots(config, &roots, private_paths, self.write_policy.is_some())
            .map(drop)
    }

    pub(crate) async fn prepare(&self, config: &Config) -> Result<EnvironmentManager> {
        self.check_config(config)?;
        if self.local {
            ensure!(
                self.url.is_none()
                    && self.stdio_command.is_none()
                    && self.headers.is_empty()
                    && self.connect_timeout.is_none(),
                "a local executor does not accept connection settings"
            );
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
        // SDK selections may publish a host MCP roster after this manager is built.
        // Reserve its lazy local launcher without selecting a host workspace:
        // for_unattached_threads has no default; selection below remains remote.
        let manager = for_unattached_threads(config).await?;
        if needs_local_mcp {
            ensure!(
                manager.try_local_environment().is_some(),
                "local stdio MCP requires the native process helper"
            );
        }
        self.register(&manager)?;
        Ok(manager)
    }

    pub(crate) async fn check_ready(
        &self,
        config: &Config,
        manager: &EnvironmentManager,
        private_paths: LocalPrivatePaths<'_>,
        trusted_temp: Option<&Path>,
    ) -> Result<()> {
        self.check_ready_at(self.id(), config, manager, private_paths, trusted_temp)
            .await
    }

    async fn check_ready_at(
        &self,
        environment_id: &str,
        config: &Config,
        manager: &EnvironmentManager,
        private_paths: LocalPrivatePaths<'_>,
        trusted_temp: Option<&Path>,
    ) -> Result<()> {
        let environment = manager
            .get_environment(environment_id)
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
            let (_, profile) = self
                .profile(config, &environment, &info, private_paths, trusted_temp)
                .await?;
            self.check_network_target(&info, profile.permission_profile())?;
            if self.local {
                probe_local_sandbox(
                    &environment,
                    &self.cwd,
                    profile.permission_profile().clone(),
                )
                .await?;
            }
        }
        Ok(())
    }

    fn register(&self, manager: &EnvironmentManager) -> Result<Arc<Environment>> {
        let transport = self.remote_transport()?;
        match transport {
            RemoteTransport::Stdio(command, timeout) => {
                manager.upsert_stdio_environment(REMOTE_ENVIRONMENT_ID.to_owned(), command, timeout)
            }
            RemoteTransport::WebSocket(options) => manager.upsert_environment_with_options(
                REMOTE_ENVIRONMENT_ID.to_owned(),
                options,
                Default::default(),
            ),
        }
        .map_err(environment_registration_error)?;
        manager
            .get_environment(REMOTE_ENVIRONMENT_ID)
            .context("remote environment was not registered")
    }

    fn register_scoped(
        &self,
        manager: &Arc<EnvironmentManager>,
        id: &str,
    ) -> Result<codex_exec_server::ScopedEnvironment> {
        match self.remote_transport()? {
            RemoteTransport::Stdio(command, timeout) => {
                manager.register_scoped_stdio_environment(id.to_owned(), command, timeout)
            }
            RemoteTransport::WebSocket(options) => {
                manager.register_scoped_environment(id.to_owned(), options)
            }
        }
        .map_err(environment_registration_error)
    }

    fn remote_transport(&self) -> Result<RemoteTransport> {
        ensure!(
            !self.local,
            "a remote executor requires a remote connection"
        );
        let timeout = self
            .connect_timeout
            .map(Duration::try_from_secs_f64)
            .transpose()
            .map_err(|_| anyhow::anyhow!("invalid remote executor connect timeout"))?;
        if let Some(command) = &self.stdio_command {
            ensure!(
                self.headers.is_empty(),
                "stdio executor cannot send HTTP headers"
            );
            ensure!(
                self.url
                    .as_deref()
                    .is_some_and(|url| url.starts_with("docker://")),
                "stdio executor requires a current SDK Docker source"
            );
            Ok(RemoteTransport::Stdio(
                StdioExecServerCommand {
                    program: command.program.clone(),
                    args: command.args.clone(),
                    env: command.env.clone(),
                    cwd: command.cwd.clone(),
                },
                timeout,
            ))
        } else {
            Ok(RemoteTransport::WebSocket(RemoteEnvironmentOptions {
                exec_server_url: self.url.clone().context("remote executor requires a URL")?,
                http_headers: self.headers.clone(),
                connect_timeout: timeout,
            }))
        }
    }

    async fn profile(
        &self,
        config: &Config,
        environment: &Environment,
        info: &EnvironmentInfo,
        private_paths: LocalPrivatePaths<'_>,
        trusted_temp: Option<&Path>,
    ) -> Result<(Option<StrictExecutorWrites>, PermissionProfileSnapshot)> {
        ensure!(
            self.write_policy.is_some() == trusted_temp.is_some(),
            "Trusted workspace writes require a scoped command temp directory"
        );
        if self.strict_writes() {
            let mounts = self.validate_storage_mounts(config, private_paths)?;
            let (strict, profile) = strict_write_profile(
                config,
                environment,
                info,
                &self.cwd,
                self.writable_roots.as_deref().unwrap_or_default(),
                &mounts,
                &self.read_only_roots,
                private_paths,
                self.read_only,
                trusted_temp,
            )
            .await?;
            Ok((Some(strict), profile))
        } else {
            Ok((
                None,
                PermissionProfileSnapshot::legacy(workspace_profile(std::slice::from_ref(
                    &self.cwd,
                ))),
            ))
        }
    }

    pub(crate) async fn selection(
        &self,
        config: &Config,
        manager: &EnvironmentManager,
        private_paths: LocalPrivatePaths<'_>,
        trusted_temp: Option<&Path>,
    ) -> Result<(TurnEnvironmentSelection, Option<StrictExecutorWrites>)> {
        self.selection_at(self.id(), config, manager, private_paths, trusted_temp)
            .await
    }

    async fn selection_at(
        &self,
        environment_id: &str,
        config: &Config,
        manager: &EnvironmentManager,
        private_paths: LocalPrivatePaths<'_>,
        trusted_temp: Option<&Path>,
    ) -> Result<(TurnEnvironmentSelection, Option<StrictExecutorWrites>)> {
        self.check_config(config)?;
        let environment = manager
            .get_environment(environment_id)
            .context("selected executor was not registered")?;
        let needs_info = !self.env.is_empty()
            || self.strict_writes()
            || self.network.is_some()
            || self.cwd.infer_path_convention() == Some(PathConvention::Windows);
        let (strict, profile, windows_executor) = if needs_info {
            let info = executor_info(&environment).await?;
            validate_environment_target_names(&environment, &self.env, &info).await?;
            let (strict, profile) = self
                .profile(config, &environment, &info, private_paths, trusted_temp)
                .await?;
            self.check_network_target(&info, profile.permission_profile())?;
            (
                strict,
                profile,
                info.platform_os.as_deref() == Some("windows"),
            )
        } else {
            (
                None,
                PermissionProfileSnapshot::legacy(workspace_profile(std::slice::from_ref(
                    &self.cwd,
                ))),
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
        let selected_capability_roots =
            self.capability_roots_at(environment_id).unwrap_or_default();
        let workspace_roots = vec![self.cwd.clone()];
        let mut shell_environment_policy = if self.local {
            ShellEnvironmentPolicy {
                inherit: ShellEnvironmentPolicyInherit::None,
                r#set: if let Some(temp) = trusted_temp {
                    let allow_all_unix_sockets = self
                        .network
                        .as_ref()
                        .is_some_and(|network| network.dangerously_allow_all_unix_sockets);
                    trusted_command_env(temp, allow_all_unix_sockets)?
                } else {
                    local_command_env()
                },
                ..Default::default()
            }
        } else {
            permissions.shell_environment_policy.clone()
        };
        shell_environment_policy.set_sdk_environment_overrides(self.env.clone());
        let selection = TurnEnvironmentSelection {
            environment_id: environment_id.to_owned(),
            workspace_roots: workspace_roots.clone(),
            cwd: self.cwd.clone(),
            // Owner configuration prevents executor-advertised roots from being added.
            config: EnvironmentConfigState::Ready(EnvironmentConfig {
                allow_login_shell: !self.local && permissions.allow_login_shell,
                workspace_roots,
                permission_profile: profile,
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

    /// Prepares a named executor before committing its Agent profile.
    pub(crate) async fn prepare_profile_selection(
        &self,
        environment_id: &str,
        config: &Config,
        manager: &Arc<EnvironmentManager>,
        private_paths: LocalPrivatePaths<'_>,
    ) -> Result<(
        TurnEnvironmentSelection,
        Option<StrictExecutorWrites>,
        Option<codex_exec_server::ScopedEnvironment>,
    )> {
        ensure!(
            environment_id
                .strip_prefix("sdk-profile-")
                .is_some_and(|id| {
                    !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
                }),
            "invalid Agent profile executor identity"
        );
        self.check_config(config)?;
        self.check_local_session_paths(config, private_paths)?;
        let owner = if self.local {
            ensure!(
                self.url.is_none()
                    && self.stdio_command.is_none()
                    && self.headers.is_empty()
                    && self.connect_timeout.is_none(),
                "a local executor does not accept connection settings"
            );
            ensure!(
                self.network.is_none() && self.write_policy.is_none(),
                "Agent profile cannot replace the Session's local proxy or trusted write policy"
            );
            manager
                .register_scoped_local_environment(
                    environment_id.to_owned(),
                    restricted_local_runtime(config)?,
                )
                .map_err(environment_registration_error)?
        } else {
            self.register_scoped(manager, environment_id)?
        };
        self.check_ready_at(environment_id, config, manager, private_paths, None)
            .await?;
        let (selection, strict) = self
            .selection_at(environment_id, config, manager, private_paths, None)
            .await?;
        Ok((selection, strict, Some(owner)))
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

/// Bind observed credentials only under the current private launch declaration.
pub(crate) async fn bind_process_identity_receipt(
    manager: &EnvironmentManager,
    selection: &TurnEnvironmentSelection,
    compare_identity: bool,
    policy: &mut Value,
) -> Result<()> {
    if !compare_identity {
        return Ok(());
    }
    let environment = manager
        .get_environment(&selection.environment_id)
        .context("Selected user executor is unavailable")?;
    let info = executor_info(&environment).await?;
    append_process_identity_receipt(policy, &info)
}

fn append_process_identity_receipt(policy: &mut Value, info: &EnvironmentInfo) -> Result<()> {
    let identity = info
        .process_identity
        .as_ref()
        .context("Selected Docker user requires current executor process identity")?;
    policy
        .as_object_mut()
        .context("Selected user executor policy is unavailable")?
        .insert(
            "process_identity".to_owned(),
            serde_json::to_value(identity)?,
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
    mounts: &[PathUri],
    read_only_roots: &[PathUri],
    private_paths: LocalPrivatePaths<'_>,
    read_only: bool,
    trusted_temp: Option<&Path>,
) -> Result<(StrictExecutorWrites, PermissionProfileSnapshot)> {
    let platform = Platform::from_platform_os(info.platform_os.as_deref());
    ensure!(
        matches!(platform, Platform::Linux | Platform::Macos)
            && info.capabilities.sandboxed_file_streaming,
        "strict executor write policy requires a Linux or macOS executor with sandboxed file access"
    );
    ensure!(
        read_only_roots.is_empty() || (!environment.is_remote() && platform == Platform::Macos),
        "read_only_roots requires a local macOS Environment"
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
    let mut private_denials = Vec::new();
    let mut read_grants = Vec::new();
    if !environment.is_remote() {
        let local_roots = roots
            .iter()
            .map(PathUri::to_abs_path)
            .collect::<Result<Vec<_>, _>>()?;
        read_grants =
            validate_local_read_only_roots(config, read_only_roots, &local_roots, private_paths)?;
        let local_roots =
            LocalWriteRoots::new(&local_roots).context("could not verify local write roots")?;
        check_local_helper_write_roots(config, &local_roots)?;
        if let Some(file) = check_local_session_write_roots(
            config,
            &local_roots,
            private_paths,
            trusted_temp.is_some(),
        )? {
            // The platform defaults can also grant reads under system paths.
            private_denials.push(
                PathUri::from_host_native_path(&file)
                    .context("could not protect the saved Codex login file")?,
            );
        }
        if let Some(temp) = trusted_temp {
            let error = "Could not verify the scoped trusted local command temp directory";
            let resolved = resolve_local_path(temp, false, error, |_| Ok(()))?;
            ensure!(resolved == temp && temp.is_dir(), "{error}");
            ensure!(
                !local_roots.contains_entry(temp)? && !local_roots.has_root_at_or_below(temp)?,
                "Keep the scoped command temp directory separate from the executor write roots"
            );
            let path = PathUri::from_host_native_path(temp).context(error)?;
            // Mark the Session-owned grant so durable comparisons can omit it.
            filesystem_policy
                .entries
                .push(FileSystemSandboxEntry::skip_missing_path(
                    FileSystemPath::Path { path },
                    FileSystemAccessMode::Write,
                ));
            // Retain platform defaults when private exclusions restrict host reads.
            filesystem_policy.entries.push(FileSystemSandboxEntry::new(
                FileSystemPath::Special {
                    value: FileSystemSpecialPath::Minimal,
                },
                FileSystemAccessMode::Read,
            ));
            let (denials, selected_denials) =
                trusted_auth_denials(config, &local_roots, private_paths.saved_login_file)?;
            private_denials.extend(selected_denials);
            for path in denials {
                // Selected credentials are excluded from model context and portable policy.
                if private_denials.contains(&path) {
                    continue;
                }
                filesystem_policy.entries.push(FileSystemSandboxEntry::new(
                    FileSystemPath::Path { path },
                    FileSystemAccessMode::Deny,
                ));
            }
        } else {
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
    }
    // A caller may explicitly grant a linked worktree's gitdir or common dir.
    // Remove only default carveouts at those exact paths. Core still adds
    // read-only carveouts for protected metadata under every granted root.
    filesystem_policy.entries.retain(|entry| {
        entry.access != FileSystemAccessMode::Read
            || !matches!(&entry.path, FileSystemPath::Path { path } if roots.contains(path))
    });
    filesystem_policy
        .entries
        .extend(
            mounts
                .iter()
                .chain(&read_grants)
                .map(|path| FileSystemSandboxEntry {
                    path: FileSystemPath::Path { path: path.clone() },
                    access: FileSystemAccessMode::Read,
                    missing_path_behavior: None,
                }),
        );
    // Intersect after the strict roots and Minimal have been applied.
    let profile = PermissionProfile::from_runtime_permissions(
        &filesystem_policy,
        NetworkSandboxPolicy::Restricted,
    );
    let profile = if read_only {
        profile
            .intersect_with_read_only()
            .context("read-only execution requires managed filesystem enforcement")?
    } else {
        profile
    };
    let profile =
        PermissionProfileSnapshot::legacy_with_sdk_private_denies(profile, private_denials);
    Ok((
        StrictExecutorWrites {
            canonical_cwd: roots[0].clone(),
            root_pins,
            read_only_roots: read_grants,
            has_storage_mounts: !mounts.is_empty(),
            read_only,
            trusted_workspace_write: trusted_temp.is_some(),
        },
        profile,
    ))
}

fn validate_local_read_only_roots(
    config: &Config,
    declarations: &[PathUri],
    write_paths: &[AbsolutePathBuf],
    private_paths: LocalPrivatePaths<'_>,
) -> Result<Vec<PathUri>> {
    let invalid = "read_only_roots requires disjoint canonical existing directories below the filesystem root";
    let mut roots = Vec::with_capacity(declarations.len());
    for declaration in declarations {
        let path = declaration.to_abs_path().context(invalid)?;
        let canonical = path.canonicalize().context(invalid)?;
        ensure!(
            canonical.as_os_str() == path.as_os_str() && canonical.parent().is_some(),
            "{invalid}"
        );
        let metadata = canonical.as_path().symlink_metadata().context(invalid)?;
        ensure!(metadata.is_dir(), "{invalid}");
        let root = LocalWriteRoots::new(std::slice::from_ref(&canonical)).context(invalid)?;
        for other in write_paths.iter().chain(&roots) {
            ensure!(
                !root.contains_entry(other.as_path()).context(invalid)?
                    && !root
                        .has_root_at_or_below(other.as_path())
                        .context(invalid)?,
                "{invalid}"
            );
        }
        let private = "read_only_roots must not expose private SDK state";
        check_local_session_write_roots(config, &root, private_paths, false).context(private)?;
        if let Some(login) = private_paths.saved_login_file {
            resolve_local_protected_path(&root, &login.declared, private, private)?;
            if let Some(parent) = login.canonical.parent() {
                // Saved login refresh stages a replacement alongside the current file.
                resolve_local_protected_path(&root, parent, private, private)?;
            }
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        validate_local_read_root_links(canonical.as_path(), &metadata)?;
        roots.push(canonical);
    }
    let mut grants = roots
        .iter()
        .map(|root| PathUri::from_host_native_path(root.as_path()).context(invalid))
        .collect::<Result<Vec<_>>>()?;
    grants.sort_by_key(ToString::to_string);
    Ok(grants)
}

fn trusted_auth_denials(
    config: &Config,
    roots: &LocalWriteRoots<'_>,
    selected_login: Option<&crate::auth::SavedLoginFile>,
) -> Result<(Vec<PathUri>, Vec<PathUri>)> {
    const RESOLVE_ERROR: &str =
        "Could not protect the trusted local executor's private authentication files";
    const OVERLAP_ERROR: &str =
        "Keep private authentication files outside the executor write roots";
    let runtime_home = config.codex_home.as_path();
    let runtime_home = resolve_local_path(runtime_home, false, RESOLVE_ERROR, |_| Ok(()))?;
    ensure!(runtime_home.is_dir(), "{RESOLVE_ERROR}");
    let resolved_codex_home =
        codex_core::config::find_codex_home().map_err(|_| anyhow::anyhow!(RESOLVE_ERROR))?;
    // Preserve the override's lexical path so the overlap check sees each
    // symlink before Core's canonicalization.
    let codex_home = match std::env::var("CODEX_HOME")
        .ok()
        .filter(|home| !home.is_empty())
    {
        Some(home) => std::path::absolute(home).context(RESOLVE_ERROR)?,
        None => resolved_codex_home.to_path_buf(),
    };
    let default_home = std::env::home_dir().context(RESOLVE_ERROR)?.join(".codex");
    let resolve_credential = |path: &Path| -> Result<PathBuf> {
        let path = resolve_local_protected_path(roots, path, RESOLVE_ERROR, OVERLAP_ERROR)?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        ensure!(
            linked_local_regular_file(path.clone())
                .map_err(|_| anyhow::anyhow!(RESOLVE_ERROR))?
                .is_none(),
            "{RESOLVE_ERROR}: a credential file has multiple hard links"
        );
        Ok(path)
    };
    let mut denied = vec![runtime_home.clone()];
    // The embedded runtime keeps its private home separate. Core can also
    // find the Codex login and MCP OAuth fallback files in the user's home.
    for home in [
        runtime_home.as_path(),
        codex_home.as_path(),
        default_home.as_path(),
    ] {
        for name in ["auth.json", ".credentials.json"] {
            let path = resolve_credential(&home.join(name))?;
            if !path.starts_with(&runtime_home) && !denied.contains(&path) {
                denied.push(path);
            }
        }
    }
    let mut selected_denied = Vec::new();
    if let Some(login) = selected_login {
        // Validate the declared symlink hops and the originally selected home.
        for auth in [&login.declared, &login.canonical] {
            let path = resolve_credential(&auth.with_file_name(".credentials.json"))?;
            if !path.starts_with(&runtime_home) && !selected_denied.contains(&path) {
                selected_denied.push(path);
            }
        }
    }
    let to_uris = |paths: Vec<PathBuf>| -> Result<Vec<PathUri>> {
        paths
            .iter()
            .map(|path| PathUri::from_host_native_path(path).context(RESOLVE_ERROR))
            .collect()
    };
    Ok((to_uris(denied)?, to_uris(selected_denied)?))
}

fn check_local_helper_write_roots(config: &Config, roots: &LocalWriteRoots<'_>) -> Result<()> {
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
    roots: &LocalWriteRoots<'_>,
    helpers: impl IntoIterator<Item = &'a Path>,
    system_search: impl IntoIterator<Item = &'a Path>,
) -> Result<()> {
    let verify = |path: &Path| {
        resolve_local_path(
            path,
            false,
            "could not resolve a local sandbox helper path",
            |entry| {
                ensure!(
                    !roots.contains_entry(entry)?,
                    "local executor write roots must not contain installed sandbox helpers"
                );
                Ok(())
            },
        )
    };
    let mut resolved_helpers = Vec::new();
    for path in helpers {
        resolved_helpers.push(verify(path)?);
    }
    for directory in system_search {
        verify(directory)?;
        // A system bwrap may resolve outside its search directory. It can run
        // before isolation, even for the capability probe used to select it.
        let bwrap = directory.join("bwrap");
        if bwrap.symlink_metadata().is_ok() {
            resolved_helpers.push(verify(&bwrap)?);
        }
    }
    ensure!(
        !roots
            .contains_hard_link_to_any(&resolved_helpers)
            .context("could not check writable roots for installed sandbox helper hard links; use readable writable roots")?,
        "local executor write roots must not contain installed sandbox helpers"
    );
    Ok(())
}

fn check_local_session_write_roots(
    config: &Config,
    roots: &LocalWriteRoots<'_>,
    private_paths: LocalPrivatePaths<'_>,
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        allow(unused_variables)
    )]
    trusted_workspace_write: bool,
) -> Result<Option<PathBuf>> {
    let sqlite = config.sqlite_config();
    if let Some(storage) = private_paths.storage {
        check_local_protected_path(
            roots,
            storage,
            sqlite,
            "could not resolve local session storage",
            LOCAL_STORAGE_OVERLAP,
            /*private_runtime_home*/ false,
        )?;
    }
    check_local_protected_path(
        roots,
        config.codex_home.as_path(),
        sqlite,
        "could not resolve the native runtime home",
        "Keep the native runtime home outside the executor cwd and writable roots",
        /*private_runtime_home*/ true,
    )?;
    let Some(file) = private_paths.saved_login_file else {
        return Ok(None);
    };
    let resolve_error = "could not inspect the saved Codex login file";
    let overlap_error = "Keep the saved Codex login outside local executor grants";
    let resolved =
        resolve_local_protected_path(roots, &file.canonical, resolve_error, overlap_error)?;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    if let Some(linked) = linked_local_regular_file(resolved.clone()).context(resolve_error)? {
        // Trusted commands can read hard-link aliases outside their write roots.
        ensure!(
            !trusted_workspace_write,
            "{resolve_error}: a credential file has multiple hard links"
        );
        ensure!(
            !roots.contains_hard_link_to_any(&[linked]).context(
                "could not check local executor grants for saved Codex login hard links"
            )?,
            "{overlap_error}; remove hard links to the saved Codex login file"
        );
    }
    Ok(Some(resolved))
}

fn check_local_protected_path(
    roots: &LocalWriteRoots<'_>,
    path: &Path,
    sqlite: &SqliteConfig,
    resolve_error: &'static str,
    overlap_error: &'static str,
    private_runtime_home: bool,
) -> Result<()> {
    let resolved = resolve_local_protected_path(roots, path, resolve_error, overlap_error)?;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut linked_files =
            linked_local_protected_files(&resolved, private_runtime_home, None, resolve_error)?;
        if path == sqlite.home() {
            linked_files.extend(linked_relocated_sqlite_files(roots, sqlite, overlap_error)?);
            linked_files.extend(linked_relocated_rollout_files(roots, &resolved)?);
            linked_files.extend(linked_relocated_checklist_files(roots, &resolved)?);
        }
        ensure!(
            !roots
                .contains_hard_link_to_any(&linked_files)
                .context("could not check writable roots for private storage hard links")?,
            "{overlap_error}; remove hard links to its files from the writable roots"
        );
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = (resolved, sqlite, private_runtime_home);
    Ok(())
}

const LOCAL_STORAGE_OVERLAP: &str =
    "Keep local session storage outside the executor cwd and writable roots";

#[cfg(target_os = "linux")]
const STORAGE_MOUNT_ENTRY_ERROR: &str =
    "Storage mounts support only regular files, directories, and symlink entries";

fn resolve_local_rollout_path(roots: &LocalWriteRoots<'_>, path: &Path) -> Result<PathBuf> {
    resolve_local_protected_path(
        roots,
        path,
        "could not resolve a native rollout path",
        LOCAL_STORAGE_OVERLAP,
    )
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn linked_local_rollout_file(path: PathBuf) -> Result<Option<PathBuf>> {
    linked_local_regular_file(path).context("could not inspect a native rollout file")
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn linked_local_regular_file(path: PathBuf) -> std::io::Result<Option<PathBuf>> {
    use std::os::unix::fs::MetadataExt;

    match path.symlink_metadata() {
        Ok(metadata) => Ok((metadata.is_file() && metadata.nlink() > 1).then_some(path)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn linked_relocated_checklist_files(
    roots: &LocalWriteRoots<'_>,
    home: &Path,
) -> Result<Vec<PathBuf>> {
    let error = "could not inspect native checklist storage";
    let directory = home.join(crate::local_storage::CHECKLIST_DIRECTORY);
    let resolve =
        |path: &Path| resolve_local_protected_path(roots, path, error, LOCAL_STORAGE_OVERLAP);
    let resolved = resolve(&directory)?;
    let entries = match std::fs::read_dir(&resolved) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(source).context(error),
    };
    let mut linked = Vec::new();
    for entry in entries {
        let entry = entry.context(error)?;
        let kind = entry.file_type().context(error)?;
        // The SDK owns this directory. A volume can resolve alternate
        // spellings to the same file, so check direct entries by identity.
        let path = if kind.is_symlink() {
            resolve(&entry.path())?
        } else if resolved != directory && kind.is_file() {
            entry.path()
        } else {
            continue;
        };
        linked.extend(linked_local_regular_file(path).context(error)?);
    }
    Ok(linked)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn linked_relocated_rollout_files(
    roots: &LocalWriteRoots<'_>,
    home: &Path,
) -> Result<Vec<PathBuf>> {
    let sessions = home.join(codex_rollout::SESSIONS_SUBDIR);
    let archives = home.join(codex_rollout::ARCHIVED_SESSIONS_SUBDIR);
    let mut directories = Vec::new();
    for (path, date_depth) in [(sessions, 0), (archives, 3)] {
        let resolved = resolve_local_rollout_path(roots, &path)?;
        let relocated = resolved != path;
        directories.push((resolved, date_depth, relocated));
    }
    let mut linked = Vec::new();
    while let Some((directory, date_depth, relocated)) = directories.pop() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                continue;
            }
            Err(error) => {
                return Err(error).context("could not inspect a native rollout directory");
            }
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            // Follow directory aliases only in Core's sessions/YYYY/MM/DD layout.
            let date = entry.file_name();
            let date = date.as_encoded_bytes();
            let date_directory = date_depth < 3
                && date.len() == if date_depth == 0 { 4 } else { 2 }
                && date.iter().all(u8::is_ascii_digit);
            if date_directory && (kind.is_dir() || kind.is_symlink()) {
                let (path, relocated) = if kind.is_symlink() {
                    (resolve_local_rollout_path(roots, &path)?, true)
                } else {
                    (path, relocated)
                };
                directories.push((path, date_depth + 1, relocated));
            } else if (relocated || kind.is_symlink())
                && codex_rollout::rollout_id_from_path(&path).is_some()
            {
                let path = resolve_local_rollout_path(roots, &path)?;
                linked.extend(linked_local_rollout_file(path)?);
            }
        }
    }
    Ok(linked)
}

fn resolve_local_protected_path(
    roots: &LocalWriteRoots<'_>,
    path: &Path,
    resolve_error: &'static str,
    overlap_error: &'static str,
) -> Result<PathBuf> {
    // Runtime and SQLite files may be created after this check.
    let resolved = resolve_local_path(path, true, resolve_error, |entry| {
        ensure!(!roots.contains_entry(entry)?, "{overlap_error}");
        Ok(())
    })?;
    ensure!(!roots.has_root_at_or_below(&resolved)?, "{overlap_error}");
    Ok(resolved)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn linked_relocated_sqlite_files(
    roots: &LocalWriteRoots<'_>,
    sqlite: &SqliteConfig,
    overlap_error: &'static str,
) -> Result<Vec<PathBuf>> {
    use std::os::unix::fs::MetadataExt;

    let resolve_error = "could not inspect a native SQLite path";
    let mut linked_files = Vec::new();
    for db in sqlite.runtime_db_paths() {
        let metadata = match db.path.symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error).context(resolve_error),
        };
        if !metadata.is_symlink() {
            continue;
        }
        // SQLite resolves its configured DB filename and keeps sidecars beside
        // the resolved DB. Inspect those files without traversing external trees.
        let db = resolve_local_protected_path(roots, &db.path, resolve_error, overlap_error)?;
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut path = db.as_os_str().to_os_string();
            path.push(suffix);
            let path = PathBuf::from(path);
            let metadata = match path.symlink_metadata() {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(error).context(resolve_error),
            };
            if metadata.is_file() {
                ensure!(
                    !roots.contains_entry(&path)? && !roots.has_root_at_or_below(&path)?,
                    "{overlap_error}"
                );
                if metadata.nlink() > 1 {
                    linked_files.push(path);
                }
            }
        }
    }
    Ok(linked_files)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
type LocalFileIdentity = (u64, u64);

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn validate_local_read_root_links(root: &Path, root_metadata: &std::fs::Metadata) -> Result<()> {
    use std::collections::HashSet;
    use std::os::unix::fs::MetadataExt;

    let error = "read_only_roots must contain every directory entry for each hard-linked file";
    let root_identity = (root_metadata.dev(), root_metadata.ino());
    let mut counts = HashMap::new();
    let mut entries = HashSet::new();
    visit_local_regular_files(
        root,
        false,
        Some("read_only_roots supports only regular files, directories, and symlink entries"),
        "could not inspect a read_only_roots directory",
        |parent, entry, metadata| {
            let file = (metadata.dev(), metadata.ino());
            let links = metadata.nlink();
            // A later singleton observation must agree with its known link group.
            if links == 1 && !counts.contains_key(&file) {
                return Ok(());
            }
            let (expected, seen) = counts.entry(file).or_insert((links, 0));
            ensure!(links == *expected, "{error}");
            // An aliased traversal can visit the same physical directory entry twice.
            if entries.insert((file, parent.unwrap_or(root_identity), entry.file_name())) {
                *seen += 1;
            }
            Ok(())
        },
    )?;
    ensure!(
        counts.values().all(|(expected, seen)| expected == seen),
        "{error}"
    );
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn linked_local_protected_files(
    root: &Path,
    private_runtime_home: bool,
    strict_tree_error: Option<&'static str>,
    resolve_error: &'static str,
) -> Result<Vec<PathBuf>> {
    use std::os::unix::fs::MetadataExt;

    let mut linked_files = Vec::new();
    visit_local_regular_files(
        root,
        private_runtime_home,
        strict_tree_error,
        resolve_error,
        |_, entry, metadata| {
            if metadata.nlink() > 1 {
                linked_files.push(entry.path());
            }
            Ok(())
        },
    )?;
    Ok(linked_files)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn visit_local_regular_files(
    root: &Path,
    private_runtime_home: bool,
    strict_tree_error: Option<&'static str>,
    resolve_error: &'static str,
    mut visit: impl FnMut(
        Option<LocalFileIdentity>,
        &std::fs::DirEntry,
        &std::fs::Metadata,
    ) -> Result<()>,
) -> Result<()> {
    use std::fs;
    use std::os::unix::fs::MetadataExt;

    let mut directories = vec![(root.to_owned(), None)];
    while let Some((directory, directory_identity)) = directories.pop() {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if strict_tree_error.is_none() && error.kind() == ErrorKind::NotFound => {
                continue;
            }
            Err(error) => return Err(error).context(resolve_error),
        };
        for entry in entries {
            let entry = entry.context(resolve_error)?;
            // DirEntry::metadata does not follow symlinks. Native state can
            // also disappear during a normal rename or cleanup. Caller-selected
            // directories must remain enumerable, so their scans reject missing entries.
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error)
                    if strict_tree_error.is_none() && error.kind() == ErrorKind::NotFound =>
                {
                    continue;
                }
                Err(error) => return Err(error).context(resolve_error),
            };
            // The SDK creates and owns this temporary directory. Public
            // LocalStorage profiles instead allow relocations of known paths.
            ensure!(
                !private_runtime_home || !metadata.file_type().is_symlink(),
                "symbolic links inside the private native runtime home are unsupported"
            );
            if let Some(error) = strict_tree_error {
                ensure!(
                    metadata.is_dir() || metadata.is_file() || metadata.file_type().is_symlink(),
                    "{error}"
                );
            }
            if metadata.is_dir() {
                directories.push((entry.path(), Some((metadata.dev(), metadata.ino()))));
            } else if metadata.is_file() {
                visit(directory_identity, &entry, &metadata)?;
            }
        }
    }
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
    private_paths: LocalPrivatePaths<'_>,
) -> Result<(TurnEnvironmentSelection, StrictExecutorWrites)> {
    ensure!(
        !previous.has_storage_mounts,
        "Cannot replace writable_roots while storage mounts are active"
    );
    ensure!(
        !previous.read_only || writable_roots.is_empty(),
        "read-only execution does not accept writable_roots"
    );
    let environment = manager
        .get_environment(&selection.environment_id)
        .context("selected executor was not registered")?;
    // The SDK installs its local proxy after rejecting an ambient controller at selection.
    let local = !environment.is_remote();
    check_writable_config(config, local)?;
    let mut selection = selection.clone();
    let EnvironmentConfigState::Ready(settings) = &mut selection.config else {
        anyhow::bail!("writable_roots requires a ready Session Environment")
    };
    let trusted_temp = if previous.trusted_workspace_write {
        ensure!(
            local,
            "Trusted workspace writes require a local Environment"
        );
        // Strict Sessions reject raw selection overrides. The SDK sets TMPDIR
        // in the ready selection from the current engine's command temp.
        Some(
            settings
                .shell_environment_policy
                .r#set
                .get("TMPDIR")
                .map(Path::new)
                .context("Trusted workspace writes require a scoped command temp directory")?,
        )
    } else {
        None
    };
    let info = executor_info(&environment).await?;
    let platform = Platform::from_platform_os(info.platform_os.as_deref());
    let (strict, profile) = strict_write_profile(
        config,
        &environment,
        &info,
        &selection.cwd,
        &writable_roots,
        &[],
        &previous.read_only_roots,
        private_paths,
        previous.read_only,
        trusted_temp,
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
        validate_environment_network_policy(network, profile.permission_profile(), platform)?;
    }
    if platform == Platform::Macos && !local {
        // WSS macOS executors keep their opening Seatbelt grants for the Session.
        ensure!(
            settings.permission_profile == profile,
            "Cannot change writable roots on a macOS executor after opening the Session"
        );
    } else {
        settings.permission_profile = profile;
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

// Core receipts retain the effective sandbox. Restore compares caller authority
// and reconstructs the private denials and temp grant from the current runtime.
fn declared_trusted_policy(mut receipt: Value) -> Option<Value> {
    if receipt["transport"] != "local" {
        return None;
    }
    let mut profile: PermissionProfile =
        serde_json::from_value(receipt.get("permission_profile")?.clone()).ok()?;
    let PermissionProfile::Managed {
        file_system: ManagedFileSystemPermissions::Restricted { entries, .. },
        ..
    } = &mut profile
    else {
        return None;
    };
    let mut temp = entries.iter().filter_map(|entry| match &entry.path {
        FileSystemPath::Path { path }
            if entry.access == FileSystemAccessMode::Write && entry.skips_missing_path() =>
        {
            Some(path.to_string())
        }
        _ => None,
    });
    let temp_root = temp.next()?;
    if temp.next().is_some() {
        return None;
    }
    let roots = receipt.get_mut("writable_roots")?.as_array_mut()?;
    let before = roots.len();
    roots.retain(|root| root.as_str() != Some(&temp_root));
    if roots.len() + 1 != before {
        return None;
    }
    entries.retain(|entry| {
        entry.access != FileSystemAccessMode::Deny
            && !(entry.access == FileSystemAccessMode::Write && entry.skips_missing_path())
    });
    receipt["permission_profile"] = serde_json::to_value(profile).ok()?;
    Some(receipt)
}

fn declared_executor_policies(values: Vec<Value>, trusted: bool) -> Result<Vec<Value>> {
    if trusted {
        values
            .into_iter()
            .map(|value| {
                declared_trusted_policy(value).context("Invalid trusted local executor policy")
            })
            .collect()
    } else {
        Ok(values)
    }
}

pub(crate) async fn checkpoint_policy(
    thread: &codex_core_api::CodexThread,
) -> Result<Option<String>> {
    let Some(strict) = thread.thread_extension_data().get::<StrictExecutorWrites>() else {
        return Ok(None);
    };
    let selections = if let Some(profile) = thread
        .thread_extension_data()
        .get::<crate::agent_profiles::ProfileEnvironments>()
    {
        profile.default.0.as_slice().to_vec()
    } else {
        thread.environment_selections().await
    };
    let config = thread.config().await;
    let values = executor_policy_values(&selections, &config)?;
    Ok(Some(digest(&declared_executor_policies(
        values,
        strict.trusted_workspace_write,
    )?)?))
}

pub(crate) fn check_checkpoint_policy(
    recorded: Option<&str>,
    startup: &codex_core_api::StartThreadOptions,
) -> Result<()> {
    let strict = startup.thread_extension_init.get::<StrictExecutorWrites>();
    if let Some(expected) = recorded {
        let strict = startup
            .thread_extension_init
            .get::<StrictExecutorWrites>()
            .context("Restore requires the recorded executor write and network policy")?;
        let values = executor_policy_values(
            startup.environments.as_deref().unwrap_or_default(),
            &startup.config,
        )?;
        ensure!(
            expected
                == digest(&declared_executor_policies(
                    values,
                    strict.trusted_workspace_write
                )?)?,
            "Restore requires the recorded executor write and network policy"
        );
    } else {
        ensure!(
            strict.is_none_or(|policy| policy.read_only_roots.is_empty()),
            "Restore requires the recorded executor policy for read-only roots"
        );
    }
    Ok(())
}

fn has_executor_receipt_markers(receipt: &Value) -> bool {
    ["codex_source_tree", "strict_executor_writes", "executors"]
        .into_iter()
        .any(|field| receipt.get(field).is_some())
}

fn validate_sdk_receipt_identities(history: &[RolloutItem], thread_id: &str) -> Result<()> {
    // Core writes sampling receipts into the producing thread's raw rollout.
    // Native forks and subagents may retain identified ancestor receipts.
    let own_root = matches!(history.first(), Some(RolloutItem::SessionMeta(header))
        if header.meta.id.to_string() == thread_id
            && header.meta.source.parent_thread_id().is_none()
            && header.meta.parent_thread_id.is_none()
            && header.meta.forked_from_id.is_none()
            && header.meta.history_base.is_none());
    for item in history {
        let RolloutItem::TurnContext(context) = item else {
            continue;
        };
        let Some(receipt) = context.sdk_receipt.as_ref() else {
            continue;
        };
        if has_executor_receipt_markers(receipt) {
            ensure!(
                receipt["thread_id"].as_str().is_some_and(|id| {
                    codex_protocol::ThreadId::from_string(id).is_ok()
                        && (!own_root || id == thread_id)
                }),
                "Local resume requires the recorded executor write and network policy"
            );
        }
    }
    Ok(())
}

fn has_sampled_model(history: &[RolloutItem]) -> bool {
    history.iter().any(|item| match item {
        RolloutItem::EventMsg(EventMsg::TurnComplete(turn)) => {
            turn.last_agent_message.is_some()
                || turn.time_to_first_token_ms.is_some()
                || turn.tool_completion.is_some()
        }
        RolloutItem::ResponseItem(response) => match &response.item {
            ResponseItem::Message { role, .. } => role == "assistant",
            ResponseItem::Reasoning { .. }
            | ResponseItem::LocalShellCall { .. }
            | ResponseItem::FunctionCall { .. }
            | ResponseItem::CustomToolCall { .. }
            | ResponseItem::ToolSearchCall { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::ImageGenerationCall { .. } => true,
            _ => false,
        },
        _ => false,
    })
}

fn has_legacy_executor_profiles(history: &[RolloutItem]) -> bool {
    let mut contexts = history
        .iter()
        .filter_map(|item| match item {
            RolloutItem::TurnContext(context) => Some(context),
            _ => None,
        })
        .peekable();
    contexts.peek().is_some()
        && contexts.all(|context| {
            context.network.is_none() && is_legacy_executor_profile(&context.permission_profile())
        })
}

fn is_legacy_executor_profile(profile: &PermissionProfile) -> bool {
    if *profile == PermissionProfile::read_only() {
        return true;
    }
    // The concrete write path is a PathUri and can belong to a different OS.
    profile
        .file_system_sandbox_policy()
        .entries
        .into_iter()
        .find(|entry| entry.access == FileSystemAccessMode::Write)
        .is_some_and(|entry| match entry.path {
            FileSystemPath::Path { path } => {
                *profile == workspace_profile(std::slice::from_ref(&path))
            }
            _ => false,
        })
}

/// Trusted current executor policy, compared under the durable writer lock.
#[derive(Default)]
pub(crate) struct LocalResumeExecutorPolicy {
    values: Vec<serde_json::Value>,
    agent_graph: Option<std::sync::Arc<crate::agent_profiles::OpeningProfiles>>,
    agent_environment_policy: Option<String>,
    strict: bool,
    trusted: bool,
    local_writes: Option<Arc<StrictExecutorWrites>>,
}

impl LocalResumeExecutorPolicy {
    pub(crate) fn from_startup(startup: &codex_core_api::StartThreadOptions) -> Result<Self> {
        let selections = startup.environments.as_deref().unwrap_or_default();
        let strict_writes = startup.thread_extension_init.get::<StrictExecutorWrites>();
        let trusted = strict_writes
            .as_ref()
            .is_some_and(|strict| strict.trusted_workspace_write);
        Ok(Self {
            values: declared_executor_policies(
                executor_policy_values(selections, &startup.config)?,
                trusted,
            )?,
            agent_graph: startup
                .thread_extension_init
                .get::<crate::agent_profiles::OpeningProfiles>(),
            agent_environment_policy: startup
                .thread_extension_init
                .get::<crate::agent_profiles::ProfileEnvironments>()
                .map(|graph| graph.digest.clone()),
            strict: strict_writes.is_some(),
            trusted,
            local_writes: strict_writes.filter(|_| {
                selections
                    .iter()
                    .any(|selection| selection.environment_id == LOCAL_ENVIRONMENT_ID)
            }),
        })
    }

    pub(crate) fn agent_graph(&self) -> Option<&crate::agent_profiles::OpeningProfiles> {
        self.agent_graph.as_deref()
    }

    pub(crate) async fn check_rollout_path(&self, path: &Path) -> Result<()> {
        if let Some(strict) = &self.local_writes {
            strict.check_local_rollout_path(path).await?;
        }
        Ok(())
    }

    pub(crate) fn validate(
        &self,
        history: &[RolloutItem],
        id: codex_protocol::ThreadId,
    ) -> Result<()> {
        let id = id.to_string();
        validate_sdk_receipt_identities(history, &id)?;
        if crate::agent_profiles::validate_restored_environment(
            self.agent_environment_policy.as_deref(),
            history,
        )? {
            // Profile publications pin the entire fresh graph and the active
            // profile. Ordinary executor receipts contain per-engine route IDs.
            return Ok(());
        }
        let is_strict = |flag: Option<&serde_json::Value>| {
            flag.is_some_and(|flag| flag.as_bool() != Some(false))
        };
        let mut recorded = history.iter().rev().filter_map(|item| {
            let RolloutItem::TurnContext(context) = item else {
                return None;
            };
            let receipt = context.sdk_receipt.as_ref()?;
            (receipt["thread_id"].as_str() == Some(id.as_str())
                && has_executor_receipt_markers(receipt))
            .then_some((
                receipt.get("executors"),
                receipt.get("strict_executor_writes"),
            ))
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
                // A strict reopen requires durable evidence of the recorded strict mode.
                strict_flag.and_then(Value::as_bool) == Some(self.strict)
                    && if self.trusted {
                        declared_executor_policies(previous.clone(), true)
                            .is_ok_and(|previous| previous == self.values)
                    } else {
                        *previous == self.values
                    }
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
        } else if has_sampled_model(history) {
            // Released SDKs wrote receipt-free model-only and implicit WSS histories.
            // Only the current owner's default policy can reopen these profiles.
            let implicit = match self.values.as_slice() {
                [] => true,
                [policy] => is_implicit_remote_policy(policy) && policy["network_policy"].is_null(),
                _ => false,
            };
            ensure!(
                !self.strict && implicit && has_legacy_executor_profiles(history),
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

/// Capture the named issuing turn's accepted executor grants, never opening defaults.
pub(crate) async fn configured_child_policy(
    owner: &codex_core_api::CodexThread,
    thread: &codex_core_api::CodexThread,
    manager: &EnvironmentManager,
    turn: &str,
    restored: bool,
) -> Result<Value> {
    let selections = if restored {
        // The current opening was already validated before creating this
        // restored grant. The parent will not have a live Core turn yet.
        thread.environment_selections().await
    } else {
        thread
            .current_turn_environment_selections(turn)
            .await
            .context("Configured child parent turn is no longer active")?
    };
    let [selection] = selections.as_slice() else {
        anyhow::bail!("Configured child requires one accepted executor Environment");
    };
    let config = thread.config().await;
    let local_network = local_session_network_policy(&config);
    let environment = manager
        .get_environment(&selection.environment_id)
        .context("selected executor was not registered")?;
    let receipt = codex_protocol::protocol::sdk_executor_policy_receipt(
        selection,
        environment.is_remote(),
        local_network.as_ref(),
    )
    .context("Configured child executor policy is unavailable")?;
    let trusted = owner
        .thread_extension_data()
        .get::<StrictExecutorWrites>()
        .is_some_and(|strict| strict.trusted_workspace_write);
    configured_child_policy_receipt(receipt, trusted)
}

fn configured_child_policy_receipt(receipt: Value, trusted: bool) -> Result<Value> {
    let receipt = if trusted {
        declared_trusted_policy(receipt).context("Invalid trusted local executor policy")?
    } else {
        receipt
    };
    Ok(serde_json::json!({
        "cwd": receipt["cwd"],
        "writableRoots": receipt["writable_roots"],
    }))
}

/// The candidate of an in-place context change belongs to the same live
/// owner. Its declaration must carry the roots currently applied by Core.
pub(crate) async fn context_candidate_runtime(
    thread: &codex_core_api::CodexThread,
    runtime: &str,
) -> Result<String> {
    let Some(strict) = thread.thread_extension_data().get::<StrictExecutorWrites>() else {
        return Ok(runtime.to_owned());
    };
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
    let receipt = if strict.trusted_workspace_write {
        declared_trusted_policy(receipt).context("Invalid trusted local executor policy")?
    } else {
        receipt
    };
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
    // The direct local backend has no handshake. Verify sandbox startup and,
    // for trusted profiles, that the backend actually applies private read masks.
    let mut private_paths = Vec::new();
    for entry in profile.file_system_sandbox_policy().entries {
        if entry.access == FileSystemAccessMode::Deny
            && let FileSystemPath::Path { path } = entry.path
        {
            let path = path.to_abs_path().context(
                "Could not protect the trusted local executor's private authentication files",
            )?;
            private_paths.push(
                path.to_str()
                    .context("Trusted local executor authentication paths must be UTF-8")?
                    .to_owned(),
            );
        }
    }
    let checks_private_auth = !private_paths.is_empty();
    let mut argv = vec!["/bin/sh".to_owned(), "-c".to_owned()];
    if checks_private_auth {
        argv.extend([
            format!(r#"for path; do if ( : < "$path" ) 2>/dev/null; then exit {PRIVATE_AUTH_READABLE}; fi; done"#),
            "sdk-local-sandbox-readiness".to_owned(),
        ]);
        argv.extend(private_paths);
    } else {
        argv.push("exit 0".to_owned());
    }
    let params = ExecParams {
        process_id: ProcessId::new("sdk-local-sandbox-readiness"),
        metadata: None,
        argv,
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
    let sandbox_matches = process.sandbox_type == Some(expected_sandbox);
    let mut events = process.process.subscribe_events();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let outcome = tokio::time::timeout_at(deadline, async {
        let mut readiness =
            LocalSandboxReadiness::new(cfg!(target_os = "linux") && sandbox_matches);
        while let Ok(event) = events.recv().await {
            if checks_private_auth
                && matches!(
                    event,
                    ExecProcessEvent::Exited {
                        exit_code: PRIVATE_AUTH_READABLE,
                        ..
                    }
                )
            {
                return LocalSandboxOutcome::PrivateAuthReadable;
            }
            if let Some(outcome) = readiness.observe(event) {
                return outcome;
            }
        }
        LocalSandboxOutcome::Failed
    })
    .await;
    if sandbox_matches && matches!(outcome, Ok(LocalSandboxOutcome::Ready)) {
        return Ok(());
    }
    let _ = process.process.terminate().await;
    if matches!(outcome, Ok(LocalSandboxOutcome::PrivateAuthReadable)) {
        anyhow::bail!(
            "The installed local executor sandbox cannot protect private authentication files"
        );
    }
    #[cfg(target_os = "linux")]
    if matches!(outcome, Ok(LocalSandboxOutcome::PossibleAppArmorDenial))
        && confirm_linux_apparmor_denial(environment, deadline).await
    {
        anyhow::bail!(concat!(
            "local executor could not establish the platform sandbox: ",
            "AppArmor has restricted unprivileged user namespace capabilities for the installed ",
            "codex-linux-sandbox helper. Ask an administrator to check the kernel audit log for ",
            "the failed Bubblewrap launch and load the helper profile if the log confirms the denial. See ",
            "https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/guides/local-execution.md",
            "#allow-the-linux-sandbox-helper-to-use-user-namespaces-on-ubuntu-2404",
        ));
    }
    anyhow::bail!("local executor could not establish the platform sandbox");
}

#[derive(Debug, PartialEq, Eq)]
enum LocalSandboxOutcome {
    Ready,
    Failed,
    PrivateAuthReadable,
    PossibleAppArmorDenial,
}

const PRIVATE_AUTH_READABLE: i32 = 42;

const BWRAP_APPARMOR_MESSAGES: [&[u8]; 3] = [
    b"bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n",
    b"bwrap: loopback: Failed RTM_NEWLINK: Operation not permitted\n",
    b"bwrap: setting up uid map: Permission denied\n",
];

struct LocalSandboxReadiness {
    // Match complete Ubuntu Bubblewrap messages across chunks without
    // retaining or surfacing any process output.
    remaining_stderr: [Option<&'static [u8]>; BWRAP_APPARMOR_MESSAGES.len()],
    exited_nonzero: bool,
}

impl LocalSandboxReadiness {
    fn new(check_apparmor: bool) -> Self {
        Self {
            remaining_stderr: BWRAP_APPARMOR_MESSAGES
                .map(|message| check_apparmor.then_some(message)),
            exited_nonzero: false,
        }
    }

    fn observe(&mut self, event: ExecProcessEvent) -> Option<LocalSandboxOutcome> {
        match event {
            ExecProcessEvent::Output(chunk) if chunk.stream == ExecOutputStream::Stderr => {
                for candidate in &mut self.remaining_stderr {
                    *candidate = candidate
                        .and_then(|remaining| remaining.strip_prefix(chunk.chunk.0.as_slice()));
                }
                if self.exited_nonzero && self.remaining_stderr.iter().all(Option::is_none) {
                    return Some(LocalSandboxOutcome::Failed);
                }
            }
            ExecProcessEvent::Output(_) => {}
            ExecProcessEvent::Exited { exit_code: 0, .. } => {
                return Some(LocalSandboxOutcome::Ready);
            }
            ExecProcessEvent::Exited { .. }
                if self.remaining_stderr.iter().any(Option::is_some) =>
            {
                self.exited_nonzero = true;
            }
            // Exit can arrive before the final output chunk. Closed marks the
            // end of the stream and rules out a match against a partial prefix.
            ExecProcessEvent::Closed { .. }
                if self.exited_nonzero && self.remaining_stderr.contains(&Some(&[])) =>
            {
                return Some(LocalSandboxOutcome::PossibleAppArmorDenial);
            }
            _ => return Some(LocalSandboxOutcome::Failed),
        }
        None
    }
}

#[cfg(target_os = "linux")]
async fn confirm_linux_apparmor_denial(
    environment: &Environment,
    deadline: tokio::time::Instant,
) -> bool {
    use std::process::Stdio;

    let Some(helper) = environment
        .local_runtime_paths()
        .and_then(|paths| paths.codex_linux_sandbox_exe.as_deref())
    else {
        return false;
    };
    if tokio::time::Instant::now() >= deadline {
        return false;
    }
    let mut command = tokio::process::Command::new(helper);
    command
        .arg(linux_apparmor_probe::ARG)
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    matches!(
        tokio::time::timeout_at(deadline, command.status()).await,
        Ok(Ok(status)) if status.code() == Some(linux_apparmor_probe::CONFIRMED_EXIT_CODE)
    )
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
    #[cfg(target_os = "linux")]
    use codex_core_api::AbsolutePathBuf;
    use codex_exec_server::{ByteChunk, ProcessOutputChunk};
    use serde_json::json;

    #[test]
    fn stdio_registration_rejects_http_headers_before_spawning() {
        let options = serde_json::from_value::<EnvironmentOptions>(json!({
            "url": "docker://selected/container",
            "cwd": "file:///workspace",
            "headers": {"Authorization": "synthetic-must-not-forward"},
            "stdio_command": {
                "program": "must-not-spawn", "args": [], "env": {}, "cwd": null
            }
        }))
        .expect("decode host options");
        let manager =
            EnvironmentManager::without_environments(codex_http_client::HttpClientFactory::new(
                codex_http_client::OutboundProxyPolicy::ReqwestDefault,
            ));
        let error = options
            .register(&manager)
            .err()
            .expect("reject HTTP headers");
        assert_eq!(error.to_string(), "stdio executor cannot send HTTP headers");
        assert!(manager.get_environment(REMOTE_ENVIRONMENT_ID).is_none());
    }

    #[test]
    fn configured_child_trusted_policy_omits_only_runtime_temp_grants() {
        let path = |value: &str| PathUri::parse(value).unwrap();
        let cwd = path("file:///workspace");
        let extra = path("file:///declared");
        let temporary = path("file:///private-runtime");
        let entry = |root: PathUri| {
            FileSystemSandboxEntry::new(
                FileSystemPath::Path { path: root },
                FileSystemAccessMode::Write,
            )
        };
        let profile = PermissionProfile::Managed {
            file_system: ManagedFileSystemPermissions::Restricted {
                entries: vec![
                    entry(cwd.clone()),
                    entry(extra.clone()),
                    FileSystemSandboxEntry::skip_missing_path(
                        FileSystemPath::Path {
                            path: temporary.clone(),
                        },
                        FileSystemAccessMode::Write,
                    ),
                ],
                glob_scan_max_depth: None,
            },
            network: NetworkSandboxPolicy::Restricted,
        };
        let receipt = json!({
            "transport": "local", "cwd": cwd,
            "writable_roots": [cwd, extra, temporary], "permission_profile": profile,
        });
        let view = configured_child_policy_receipt(receipt.clone(), true).unwrap();
        assert_eq!(view["writableRoots"], json!([cwd, extra]));
        assert_eq!(view["cwd"], json!(cwd));
        assert_eq!(
            configured_child_policy_receipt(receipt.clone(), false).unwrap()["writableRoots"],
            receipt["writable_roots"]
        );
        let mut malformed = receipt;
        malformed["permission_profile"] = json!(PermissionProfile::Managed {
            file_system: ManagedFileSystemPermissions::Restricted {
                entries: vec![entry(cwd), entry(extra), entry(temporary)],
                glob_scan_max_depth: None,
            },
            network: NetworkSandboxPolicy::Restricted,
        });
        assert!(configured_child_policy_receipt(malformed, true).is_err());
    }

    #[test]
    fn explicit_environment_names_match_receiver_restrictions() {
        for name in codex_protocol::shell_environment::NON_INHERITABLE_ENV_VARS
            .iter()
            .copied()
            .chain([
                "CODEX_SDK_BWRAP_SEARCH_PATH",
                "CARGO_BIN_EXE_bwrap",
                "CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE",
                "CODEX_SANDBOX_COMMAND_ENV_JSON",
                "CODEX_THREAD_ID",
                "CODEX_SESSION_ID",
                "CODEX_VERSION",
                "CODEX_PERMISSION_PROFILE",
                "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS",
                "CODEX_PLUGIN_METRICS_OUTPUT",
                "CODEX_SANDBOX_COMMAND_ENV_JSON_0",
                "CODEX_SANDBOX_COMMAND_ENV_JSON_é",
            ])
        {
            for variant in [name.to_owned(), name.to_ascii_lowercase()] {
                let values =
                    std::collections::HashMap::from([(variant, "private-environment-value")]);
                let result = serde_json::from_value::<super::EnvironmentOptions>(json!({
                    "cwd": "file:///workspace", "env_json": serde_json::to_string(&values).unwrap()
                }));
                let error = result
                    .err()
                    .expect("receiver-reserved environment name")
                    .to_string();
                assert!(!error.contains("private-environment-value"));
            }
        }
    }

    #[test]
    fn explicit_environment_name_identity_is_owned_by_the_receiver() {
        assert!(super::environment_target_name_validation_required(Some("windows"), true).unwrap());
        assert!(
            super::environment_target_name_validation_required(Some("windows"), false).is_err()
        );
        assert!(!super::environment_target_name_validation_required(Some("linux"), false).unwrap());
        assert!(!super::environment_target_name_validation_required(Some("macos"), false).unwrap());
        assert!(super::environment_target_name_validation_required(None, false).is_err());
    }

    #[test]
    fn explicit_environment_values_validate_before_native_selection() {
        let valid: super::EnvironmentOptions = serde_json::from_value(json!({
            "cwd": "file:///workspace",
            "env_json": r#"{"VALUE":"private-environment-value","EMPTY":"","__proto__":"literal"}"#
        }))
        .unwrap();
        assert_eq!(valid.env["EMPTY"], "");
        assert_eq!(valid.env["__proto__"], "literal");
        for (name, value) in [
            ("$serde_json::private::Number", "7301592846"),
            (
                "$serde_json::private::RawValue",
                r#"{"APP_MODE":"injected-env-marker"}"#,
            ),
        ] {
            let values = std::collections::HashMap::from([(name, value)]);
            let options: super::EnvironmentOptions = serde_json::from_value(json!({
                "cwd": "file:///workspace",
                "env_json": serde_json::to_string(&values).unwrap()
            }))
            .unwrap();
            assert_eq!(options.env.len(), 1);
            assert_eq!(options.env[name], value);
        }
        for values in [
            json!({"": "private-environment-value"}),
            json!({"BAD=NAME": "private-environment-value"}),
            json!({"BAD\0NAME": "private-environment-value"}),
            json!({"CODEX_SDK_BWRAP_SEARCH_PATH": "private-environment-value"}),
            json!({"CARGO_BIN_EXE_bwrap": "private-environment-value"}),
            json!({"NAME": "private-environment-value\0"}),
            json!({"NAME": 3}),
            json!(["private-environment-value"]),
        ] {
            let result = serde_json::from_value::<super::EnvironmentOptions>(json!({
                "cwd": "file:///workspace", "env_json": values.to_string()
            }));
            let error = match result {
                Ok(_) => panic!("invalid environment values were accepted"),
                Err(error) => error.to_string(),
            };
            assert!(error.contains("environment"));
            assert!(!error.contains("private-environment-value"));
        }
    }

    fn readiness_output(seq: u64, stream: ExecOutputStream, bytes: &[u8]) -> ExecProcessEvent {
        ExecProcessEvent::Output(ProcessOutputChunk {
            seq,
            stream,
            chunk: ByteChunk::from(bytes.to_vec()),
        })
    }

    fn readiness_outcome(
        events: impl IntoIterator<Item = ExecProcessEvent>,
    ) -> LocalSandboxOutcome {
        let mut readiness = LocalSandboxReadiness::new(true);
        events
            .into_iter()
            .find_map(|event| readiness.observe(event))
            .unwrap_or(LocalSandboxOutcome::Failed)
    }

    #[test]
    fn sandbox_readiness_matches_stderr_that_completes_after_exit() {
        for message in [
            b"bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n".as_slice(),
            b"bwrap: loopback: Failed RTM_NEWLINK: Operation not permitted\n",
            b"bwrap: setting up uid map: Permission denied\n",
        ] {
            let (prefix, suffix) = message.split_at(24);
            let events = [
                readiness_output(0, ExecOutputStream::Stderr, prefix),
                ExecProcessEvent::Exited {
                    seq: 1,
                    exit_code: 1,
                    sandbox_denied: None,
                },
                readiness_output(2, ExecOutputStream::Stderr, suffix),
                ExecProcessEvent::Closed { seq: 3 },
            ];
            assert_eq!(
                readiness_outcome(events),
                LocalSandboxOutcome::PossibleAppArmorDenial,
                "{}",
                String::from_utf8_lossy(message)
            );
        }
    }

    #[test]
    fn sandbox_readiness_requires_complete_stderr_and_a_failed_exit() {
        let failure = ExecProcessEvent::Exited {
            seq: 1,
            exit_code: 1,
            sandbox_denied: None,
        };
        let closed = ExecProcessEvent::Closed { seq: 2 };
        let matching = readiness_output(0, ExecOutputStream::Stderr, BWRAP_APPARMOR_MESSAGES[0]);
        for events in [
            vec![matching.clone(), failure.clone()],
            vec![
                readiness_output(0, ExecOutputStream::Stdout, BWRAP_APPARMOR_MESSAGES[0]),
                failure.clone(),
                closed.clone(),
            ],
            vec![
                matching.clone(),
                failure,
                readiness_output(2, ExecOutputStream::Stderr, b"additional error\n"),
                ExecProcessEvent::Closed { seq: 3 },
            ],
        ] {
            assert_eq!(readiness_outcome(events), LocalSandboxOutcome::Failed);
        }

        let events = [
            matching,
            ExecProcessEvent::Exited {
                seq: 1,
                exit_code: 0,
                sandbox_denied: None,
            },
        ];
        assert_eq!(readiness_outcome(events), LocalSandboxOutcome::Ready);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn read_only_roots_admit_stable_directories_and_protect_private_paths() {
        use std::fs;
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;

        let temporary = tempfile::tempdir().unwrap();
        let base = temporary.path().canonicalize().unwrap();
        let cwd = base.join("work");
        let source = base.join("skills");
        let child = source.join("child");
        let second = base.join("resources");
        let home = base.join("home");
        let login_home = base.join("login");
        for path in [&cwd, &source, &child, &second, &home, &login_home] {
            fs::create_dir(path).unwrap();
        }
        let (config, _) = crate::config::load(
            "{}",
            &json!({
                "codex_home": home, "cwd": cwd,
                "loader":{"ignore_user_config":true,"ignore_project_config":true}
            })
            .to_string(),
            None,
        )
        .await
        .unwrap();
        let uri = |path: &Path| PathUri::from_host_native_path(path).unwrap();
        let write = [uri(&cwd).to_abs_path().unwrap()];
        let validate = |paths: &[&Path], private| {
            let declarations: Vec<_> = paths.iter().map(|path| uri(path)).collect();
            validate_local_read_only_roots(&config, &declarations, &write, private)
        };
        let private = LocalPrivatePaths::default();
        assert_eq!(
            validate(&[&source, &second], private).unwrap(),
            vec![uri(&second), uri(&source)]
        );
        let alias = base.join("alias");
        symlink(&source, &alias).unwrap();
        let regular = source.join("marker");
        fs::write(&regular, b"fixture").unwrap();
        let work_child = cwd.join("child");
        fs::create_dir(&work_child).unwrap();
        for path in [
            &base,
            &cwd,
            &work_child,
            &alias,
            &regular,
            &base.join("missing"),
        ] {
            assert!(validate(&[path], private).is_err(), "{path:?}");
        }
        for paths in [[source.as_path(), child.as_path()], [&child, &source]] {
            assert!(validate(&paths, private).is_err());
        }
        assert!(validate(&[&home], private).is_err());

        fs::hard_link(&regular, child.join("linked")).unwrap();
        assert_eq!(validate(&[&source], private).unwrap(), vec![uri(&source)]);
        let external_alias = source.join("external-alias");
        for directory in [&second, &cwd] {
            let external = directory.join("external");
            fs::write(&external, b"external fixture").unwrap();
            fs::hard_link(&external, &external_alias).unwrap();
            assert!(
                validate(&[&source], private)
                    .unwrap_err()
                    .to_string()
                    .contains("hard-linked")
            );
            fs::remove_file(&external_alias).unwrap();
        }
        let _socket = UnixListener::bind(source.join("socket")).unwrap();
        assert!(
            validate(&[&source], private)
                .unwrap_err()
                .to_string()
                .contains("only regular files")
        );
        fs::remove_file(source.join("socket")).unwrap();

        // The durable profile alias resolves into the proposed read grant.
        let storage = base.join("profile");
        symlink(&second, &storage).unwrap();
        assert!(
            validate(
                &[&second],
                LocalPrivatePaths {
                    storage: Some(&storage),
                    ..private
                },
            )
            .unwrap_err()
            .to_string()
            .contains("private SDK state")
        );

        // The declared alias and the actual atomic refresh directory are
        // separate filesystem entries. Neither belongs to a read grant.
        let login_alias = second.join("login");
        symlink(&login_home, &login_alias).unwrap();
        let auth = login_home.join("auth.json");
        fs::write(&auth, b"synthetic").unwrap();
        let login = crate::auth::SavedLoginFile {
            declared: login_alias.join("auth.json"),
            canonical: auth,
        };
        let private = LocalPrivatePaths {
            saved_login_file: Some(&login),
            ..private
        };
        let refresh_directory_child = login_home.join("resources");
        fs::create_dir(&refresh_directory_child).unwrap();
        for path in [&second, &refresh_directory_child] {
            assert!(
                validate(&[path], private)
                    .unwrap_err()
                    .to_string()
                    .contains("private SDK state")
            );
        }
        assert_eq!(validate(&[&source], private).unwrap(), vec![uri(&source)]);
        fs::hard_link(&login.canonical, source.join("auth-alias")).unwrap();
        assert!(
            validate(&[&source], private)
                .unwrap_err()
                .to_string()
                .contains("private SDK state")
        );
    }

    #[test]
    fn mount_wire_rejects_unknown_authority_without_reflecting_secrets() {
        let error = serde_json::from_value::<EnvironmentOptions>(json!({
            "local":true, "cwd":"file:///workspace", "mounts":[{
                "source":"/data", "destination":"/data", "strategy":"local_bind",
                "synthetic-secret":"synthetic-secret"
            }]
        }))
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("Invalid local storage mounts"));
        assert!(!error.contains("synthetic-secret"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn storage_mount_preflight_protects_private_state_and_rejects_unsupported_inputs() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let cwd = root.join("work");
        let source = root.join("storage");
        let home = root.join("home");
        for path in [&cwd, &source, &home] {
            std::fs::create_dir(path).unwrap();
        }
        let (config, _) = crate::config::load(
            "{}",
            &json!({
                "codex_home": home, "cwd": cwd,
                "loader":{"ignore_user_config":true,"ignore_project_config":true}
            })
            .to_string(),
            None,
        )
        .await
        .unwrap();
        let mount = json!({"source":source,"destination":source,"strategy":"local_bind"});
        let options: EnvironmentOptions = serde_json::from_value(json!({
            "local":true,"cwd":PathUri::from_host_native_path(&cwd).unwrap(),"mounts":[mount]
        }))
        .unwrap();
        assert_eq!(
            options
                .validate_storage_mounts(&config, LocalPrivatePaths::default())
                .unwrap()
                .len(),
            1
        );
        assert!(
            options
                .validate_storage_mounts(
                    &config,
                    LocalPrivatePaths {
                        storage: Some(&source.join("profile")),
                        ..Default::default()
                    },
                )
                .is_err()
        );
        for key in ["read_only", "strategy", "destination", "source"] {
            let mut bad = options.clone();
            match key {
                "read_only" => bad.mounts.as_mut().unwrap()[0].read_only = false,
                "strategy" => bad.mounts.as_mut().unwrap()[0].strategy = "synthetic-secret".into(),
                "destination" => {
                    bad.mounts.as_mut().unwrap()[0].destination = cwd.to_string_lossy().into_owned()
                }
                _ => {
                    bad.mounts.as_mut().unwrap()[0].source = cwd.to_string_lossy().into_owned();
                    bad.mounts.as_mut().unwrap()[0].destination =
                        bad.mounts.as_ref().unwrap()[0].source.clone();
                }
            }
            let error = bad
                .validate_storage_mounts(&config, LocalPrivatePaths::default())
                .unwrap_err()
                .to_string();
            assert!(!error.contains("synthetic-secret"));
        }
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        let mut aliased = options.clone();
        aliased.mounts.as_mut().unwrap()[0].source = alias.to_string_lossy().into_owned();
        aliased.mounts.as_mut().unwrap()[0].destination =
            aliased.mounts.as_ref().unwrap()[0].source.clone();
        assert!(
            aliased
                .validate_storage_mounts(&config, LocalPrivatePaths::default())
                .is_err()
        );
        let private = home.join("credentials.json");
        std::fs::write(&private, "synthetic-private-state").unwrap();
        std::fs::hard_link(&private, source.join("private-alias")).unwrap();
        assert!(
            options
                .validate_storage_mounts(&config, LocalPrivatePaths::default())
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(private).unwrap(),
            "synthetic-private-state"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn storage_mount_rejects_only_hard_links_in_writable_grants() {
        use std::fs;
        use std::os::unix::fs::{MetadataExt, symlink};

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let cwd = root.join("work");
        let extra = root.join("extra");
        let source = root.join("storage");
        let home = root.join("home");
        let outside = root.join("outside");
        for path in [&cwd, &extra, &source, &home, &outside] {
            fs::create_dir(path).unwrap();
        }
        let (config, _) = crate::config::load(
            "{}",
            &json!({
                "codex_home": home, "cwd": cwd,
                "loader":{"ignore_user_config":true,"ignore_project_config":true}
            })
            .to_string(),
            None,
        )
        .await
        .unwrap();
        let options: EnvironmentOptions = serde_json::from_value(json!({
            "local":true,"cwd":PathUri::from_host_native_path(&cwd).unwrap(),
            "writable_roots":[PathUri::from_host_native_path(&extra).unwrap()],
            "mounts":[{"source":source,"destination":source,"strategy":"local_bind"}]
        }))
        .unwrap();
        let marker = source.join("marker");
        fs::write(&marker, "caller-owned").unwrap();
        let mode = fs::metadata(&marker).unwrap().mode();
        // No multiply-linked files: the writable-tree scan is unnecessary.
        options
            .validate_storage_mounts(&config, LocalPrivatePaths::default())
            .unwrap();
        fs::hard_link(&marker, source.join("readonly-alias")).unwrap();
        fs::hard_link(&marker, outside.join("outside-alias")).unwrap();
        symlink(&marker, cwd.join("symlink-alias")).unwrap();
        // Read-only aliases and links outside the grants are harmless. A symlink
        // inside a grant must not cause the identity scan to follow its target.
        options
            .validate_storage_mounts(&config, LocalPrivatePaths::default())
            .unwrap();
        for writable in [&cwd, &extra] {
            let alias = writable.join("writable-alias");
            fs::hard_link(&marker, &alias).unwrap();
            let error = options
                .validate_storage_mounts(&config, LocalPrivatePaths::default())
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("must not share hard-linked files")
            );
            assert_eq!(fs::read_to_string(&marker).unwrap(), "caller-owned");
            assert_eq!(fs::metadata(&marker).unwrap().mode(), mode);
            fs::remove_file(alias).unwrap();
            options
                .validate_storage_mounts(&config, LocalPrivatePaths::default())
                .unwrap();
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn storage_mount_file_scan_fails_when_required_inspection_cannot_complete() {
        let temporary = tempfile::tempdir().unwrap();
        let missing = temporary.path().join("disappeared-directory");
        let error = "Could not inspect storage mount files for hard links";
        let mount_tree = Some(STORAGE_MOUNT_ENTRY_ERROR);
        assert_eq!(
            linked_local_protected_files(&missing, false, mount_tree, error)
                .unwrap_err()
                .to_string(),
            error
        );
        // Private SDK state retains its existing allowance for absent files.
        assert!(
            linked_local_protected_files(&missing, false, None, error)
                .unwrap()
                .is_empty()
        );
        let file = temporary.path().join("not-a-directory");
        std::fs::write(&file, "caller-owned").unwrap();
        assert!(linked_local_protected_files(&file, false, mount_tree, error).is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "caller-owned");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn storage_mount_scan_accepts_data_tree_and_rejects_special_entries() {
        use std::fs;
        use std::os::unix::fs::{FileTypeExt, MetadataExt, symlink};
        use std::os::unix::net::UnixListener;

        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("storage");
        fs::create_dir(&source).unwrap();
        let nested = source.join("nested");
        fs::create_dir(&nested).unwrap();
        let marker = nested.join("marker");
        fs::write(&marker, "caller-owned").unwrap();
        let outside = temporary.path().join("outside-socket");
        let _outside_listener = UnixListener::bind(&outside).unwrap();
        symlink(&outside, nested.join("unfollowed-socket-link")).unwrap();
        let error = "Could not inspect storage mount files";
        let mount_tree = Some(STORAGE_MOUNT_ENTRY_ERROR);
        // The symlink entry is allowed; its special-file target is not inspected.
        assert!(
            linked_local_protected_files(&source, false, mount_tree, error)
                .unwrap()
                .is_empty()
        );
        let endpoint = source.join("socket");
        let _listener = UnixListener::bind(&endpoint).unwrap();
        let original = fs::symlink_metadata(&endpoint).unwrap();
        let rejected = linked_local_protected_files(&source, false, mount_tree, error).unwrap_err();
        assert!(
            rejected
                .to_string()
                .contains("support only regular files, directories, and symlink entries")
        );
        // The shared collector must not add a special-file restriction to
        // private-state scans, which use their existing symlink rules.
        assert!(
            linked_local_protected_files(&source, false, None, error)
                .unwrap()
                .is_empty()
        );
        let after = fs::symlink_metadata(&endpoint).unwrap();
        assert!(after.file_type().is_socket());
        assert_eq!(
            (after.dev(), after.ino(), after.mode()),
            (original.dev(), original.ino(), original.mode())
        );
        assert_eq!(fs::read_to_string(marker).unwrap(), "caller-owned");
    }

    #[test]
    fn legacy_executor_profile_supports_a_windows_wss_workspace() {
        let cwd: PathUri = "file:///C:/workspace".parse().unwrap();
        let extra: PathUri = "file:///C:/extra".parse().unwrap();
        assert!(is_legacy_executor_profile(&workspace_profile(
            std::slice::from_ref(&cwd)
        )));
        assert!(!is_legacy_executor_profile(&workspace_profile(&[
            cwd, extra
        ])));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn rejects_a_selected_compressed_rollout_alias_into_a_local_grant() {
        use std::fs;
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let store = directory.path().join("relocated");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&store).unwrap();
        let cwd = PathUri::from_host_native_path(workspace.canonicalize().unwrap()).unwrap();
        let strict = StrictExecutorWrites {
            canonical_cwd: cwd.clone(),
            root_pins: HashMap::from([(write_root_key(&cwd), cwd)]),
            read_only_roots: Vec::new(),
            has_storage_mounts: false,
            read_only: false,
            trusted_workspace_write: false,
        };
        let recorded = store.join("rollout.jsonl");
        let compressed = recorded.with_extension("jsonl.zst");
        let target = workspace.join("rollout.jsonl.zst");
        fs::write(&target, []).unwrap();
        symlink(&target, &compressed).unwrap();

        assert!(!recorded.exists());
        let error = strict
            .check_local_rollout_path(&recorded)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(LOCAL_STORAGE_OVERLAP));

        fs::remove_file(&compressed).unwrap();
        fs::rename(target, &compressed).unwrap();
        strict.check_local_rollout_path(&recorded).await.unwrap();
    }

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
        let parent = codex_protocol::ThreadId::new();
        let fork = RolloutItem::SessionMeta(codex_protocol::protocol::SessionMetaLine {
            meta: codex_protocol::protocol::SessionMeta {
                id,
                forked_from_id: Some(parent),
                ..Default::default()
            },
            git: None,
        });
        let inherited = context(json!({ "codex_source_tree": "fixture", "thread_id": parent }));
        assert!(validate_sdk_receipt_identities(&[fork, inherited], &id.to_string()).is_ok());

        let values = vec![json!({ "transport": "remote" })];
        let older = context(json!({
            "thread_id": id,
            "strict_executor_writes": true,
            "executors": values,
        }));
        let policy = LocalResumeExecutorPolicy {
            values,
            strict: true,
            ..Default::default()
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
                &LocalWriteRoots::new(std::slice::from_ref(&root)).unwrap(),
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
        let check = |roots: &[AbsolutePathBuf]| {
            check_local_helper_paths(
                &LocalWriteRoots::new(roots).unwrap(),
                std::iter::empty(),
                [system_bin.as_path()],
            )
        };
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

#[cfg(test)]
mod terminal_tool_recovery_tests {
    use super::*;

    #[test]
    fn terminal_tool_fact_counts_as_sampled_without_assistant_or_first_token() {
        let terminal = serde_json::from_value(serde_json::json!({
            "turn_id":"turn", "last_agent_message":null,
            "tool_completion":{"call_id":"call", "name":"finish", "final_output":{"answer":7}}
        }))
        .unwrap();
        assert!(has_sampled_model(&[RolloutItem::EventMsg(
            EventMsg::TurnComplete(terminal)
        )]));
        let empty = serde_json::from_value(serde_json::json!({
            "turn_id":"turn", "last_agent_message":null
        }))
        .unwrap();
        assert!(!has_sampled_model(&[RolloutItem::EventMsg(
            EventMsg::TurnComplete(empty)
        )]));
    }
}

#[cfg(test)]
mod selected_process_identity_tests {
    #[test]
    fn comparison_requirement_comes_only_from_current_private_launch() {
        let mut value = serde_json::json!({
            "cwd": "/workspace",
            "stdio_command": {
                "program": "/usr/bin/env",
                "args": [],
                "env": { "USER": "0", "LOGNAME": "root" },
                "cwd": null
            }
        });
        let options: super::EnvironmentOptions = serde_json::from_value(value.clone()).unwrap();
        assert!(!options.requires_process_identity());
        value["stdio_command"]["require_process_identity"] = serde_json::json!(true);
        let options: super::EnvironmentOptions = serde_json::from_value(value).unwrap();
        assert!(options.requires_process_identity());
        assert!(options.clone().requires_process_identity());
    }

    use super::*;

    fn observed(uid: u32) -> EnvironmentInfo {
        serde_json::from_value(serde_json::json!({
            "shell": {"name":"sh", "path":"/bin/sh"},
            "processIdentity": {"type":"unix", "effectiveUid":uid,
                "effectiveGid":1000, "supplementaryGids":[1000]},
        }))
        .expect("current executor metadata")
    }

    #[test]
    fn selected_user_does_not_infer_root_from_legacy_metadata() {
        let info: EnvironmentInfo = serde_json::from_value(serde_json::json!({
            "shell": {"name":"sh", "path":"/bin/sh"},
        }))
        .expect("legacy metadata");
        let mut policy = serde_json::json!({"cwd":"/workspace"});
        let original = policy.clone();
        assert!(append_process_identity_receipt(&mut policy, &info).is_err());
        assert_eq!(policy, original);
    }

    #[test]
    fn selected_user_policy_distinguishes_actual_effective_credentials() {
        let mut unprivileged = serde_json::json!({"cwd":"/workspace"});
        let mut root = unprivileged.clone();
        append_process_identity_receipt(&mut unprivileged, &observed(1000)).expect("user policy");
        append_process_identity_receipt(&mut root, &observed(0)).expect("root policy");
        assert_ne!(
            digest(&[unprivileged]).expect("policy digest"),
            digest(&[root]).expect("policy digest")
        );
    }
}

//! Canonical project guidance discovered with each native step's read authority.
use std::collections::{HashMap, HashSet, VecDeque};
use std::io;
use std::sync::{Arc, Mutex, Weak};

use anyhow::{Context, Result, bail, ensure};
use codex_code_mode::CodeModeNestedToolCall;
use codex_core_api::{EnvironmentManager, Feature, ThreadManager};
use codex_extension_api::{
    ContextContributor, ExtensionData, ExtensionFuture, PreviousWorldStateSection,
    RenderedWorldStateFragment, ToolCallOutcome, ToolContributor, ToolFinishInput,
    ToolLifecycleContributor, ToolLifecycleFuture, ToolPolicy, ToolStartInput, TurnAbortInput,
    TurnLifecycleContributor, TurnStartInput, TurnStopInput, WorldStateContributionInput,
    WorldStateSectionContribution,
};
use codex_file_system::{
    CopyOptions, CreateDirectoryOptions, EnvironmentAccess, EnvironmentAccessKey,
    ExecutorFileSystem, ExecutorFileSystemFuture, FileMetadata, FileSystemEnvironmentAccessor,
    FileSystemReadStream, FileSystemSandboxContext, GetMetadataOptions, ReadDirectoryEntry,
    ReadFileOptions, RemoveOptions, WalkOptions, WalkOutcome, WriteFileOptions,
};
use codex_protocol::models::PermissionProfile;
use codex_protocol::protocol::EnvironmentConfigState;
use codex_tools::{
    FunctionCallError, JsonToolOutput, ResponsesApiTool, ToolCall, ToolCallSource, ToolExecutor,
    ToolExecutorFuture, ToolExposure, ToolName, ToolOutput, ToolPayload, ToolSpec,
};
use codex_utils_path_uri::{PathConvention, PathUri};
use futures_util::StreamExt;
use globset::GlobBuilder;
use serde::Deserialize;
use serde_json::{Value, json};

const SOURCE_LIMIT: usize = 32_768;
const CONTEXT_LIMIT: usize = 3_000;
const MARKERS: (&str, &str) = ("<canonical_rules>", "</canonical_rules>");

#[path = "canonical_access.rs"]
mod access;
pub use access::AccessContributor;

// Installed only from current host thread options, never from saved history.
pub struct Rules(Mutex<Scope>, PathUri, Mutex<Option<PathUri>>);

struct RulesTurn(String);

#[derive(Default)]
struct Scope {
    turn: String,
    identity: Option<Arc<AccessContext>>,
    batch: Option<Arc<Batch>>,
    // Only Scope selects a collecting batch. Tools never carry an old batch.
    active: Option<Arc<Batch>>,
    native_view_image: bool,
    images: HashMap<String, PendingImage>,
    // Only the bridge to Core's queued dispatch, not a history of cells or I/O.
    // A retained delegate owns the origin; entries live for one invocation.
    nested_images: HashMap<(String, String), Arc<AccessContext>>,
}

// Native step stores are built with the tool plan, before World State. Fill
// this once during discovery; yielded executors keep their issuing context.
#[derive(Default)]
struct StepAccess(Mutex<Option<Arc<AccessContext>>>);

#[derive(Clone, PartialEq)]
struct AccessContext {
    environment_id: String,
    cwd: PathUri,
    workspace_roots: Vec<PathUri>,
    permission_profile: PermissionProfile,
    sandbox: FileSystemSandboxContext,
    canonical_root: PathUri,
    key: EnvironmentAccessKey,
}

#[derive(Default)]
struct Batch(Mutex<BatchPaths>);

#[derive(Default)]
struct BatchPaths {
    paths: HashSet<PathUri>,
    // A native call cannot be turned into a failed call by an observation.
    // Fail the rule snapshot closed on native overflow instead of dropping paths.
    overflow: bool,
}

/// An actual access owned by this Rules thread store, not a process-global journal.
/// Borrowed call/turn/env identity is validated synchronously; only bounded paths
/// survive in the current collecting batch. Never stores file contents or arguments.
struct AccessObservation<'a> {
    context: &'a Arc<AccessContext>,
    key: EnvironmentAccessKey,
    owner_turn: &'a str,
    call_id: &'a str,
    environment_id: &'a str,
    cwd: &'a PathUri,
    path: PathUri,
    kind: AccessKind,
}

#[derive(Clone, Copy)]
enum AccessKind {
    ValidatedTextRead,
    NativeImageRead,
    ExecutorRead,
    ExecutorWrite,
}

struct PendingImage {
    turn: String,
    context: Arc<AccessContext>,
    path: PathUri,
    source: ToolCallSource,
}

// Captured by the existing native exec handoff, ONLY if the issuing step
// proves Core owns view_image. A missing origin must never use today's proof.
#[derive(Clone)]
pub(crate) struct CellImageOrigin {
    rules: Weak<Rules>,
    context: Arc<AccessContext>,
}

impl Rules {
    pub fn new(trusted_root: PathUri) -> Self {
        Self(Mutex::new(Scope::default()), trusted_root, Mutex::new(None))
    }

    pub(crate) fn cell_image_origin(self: &Arc<Self>, turn: &str) -> Option<CellImageOrigin> {
        let scope = self.0.lock().expect("canonical rules scope poisoned");
        if scope.turn != turn || !scope.native_view_image {
            return None;
        }
        Some(CellImageOrigin {
            rules: Arc::downgrade(self),
            context: scope.identity.clone()?,
        })
    }
}

pub(crate) struct NestedImage {
    rules: Arc<Rules>,
    context: Arc<AccessContext>,
    turn: String,
    id: (String, String),
}

impl CellImageOrigin {
    pub(crate) fn track(
        &self,
        turn: &str,
        invocation: &CodeModeNestedToolCall,
    ) -> Option<NestedImage> {
        if !invocation.tool_name.is_default_namespace() || invocation.tool_name.name != "view_image"
        {
            return None;
        }
        let rules = self.rules.upgrade()?;
        let id = (
            invocation.cell_id.as_str().to_owned(),
            invocation.runtime_tool_call_id.clone(),
        );
        {
            let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
            // An invalidated cell cannot occupy slots or overflow the new scope.
            if scope.turn != turn
                || !scope
                    .identity
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &self.context))
            {
                return None;
            }
            if scope.nested_images.len() >= 128 {
                scope.native_overflow();
                return None;
            }
            scope.nested_images.insert(id.clone(), self.context.clone());
        }
        Some(NestedImage {
            rules,
            context: self.context.clone(),
            turn: turn.to_owned(),
            id,
        })
    }
}

// Drop covers the queued call, native errors, external cancellation and cell
// shutdown. An old task must not remove an entry belonging to a renewed owner.
impl Drop for NestedImage {
    fn drop(&mut self) {
        let mut scope = self.rules.0.lock().expect("canonical rules scope poisoned");
        if scope.turn == self.turn
            && scope
                .nested_images
                .get(&self.id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.context))
        {
            scope.nested_images.remove(&self.id);
        }
    }
}

impl Scope {
    // Discard every producer's old authority and paths, not just image starts.
    // Only a step whose discovery resolved an accessor may collect NEW I/O.
    // Its tools were already constructed with StepAccess before World State.
    fn renew_context(&mut self, step: &ExtensionData, context: Option<AccessContext>) {
        let identity = context.map(Arc::new);
        *self = Self {
            turn: std::mem::take(&mut self.turn),
            active: identity.as_ref().map(|_| Arc::new(Batch::default())),
            identity,
            ..Self::default()
        };
        *step
            .get_or_init(StepAccess::default)
            .0
            .lock()
            .expect("canonical rules step poisoned") = self.identity.clone();
    }

    fn native_overflow(&mut self) {
        if let Some(batch) = self.active.clone() {
            batch
                .0
                .lock()
                .expect("canonical rules batch poisoned")
                .overflow = true;
            self.batch = Some(batch);
        }
    }

    fn observe(&mut self, access: AccessObservation<'_>) -> Result<()> {
        ensure!(
            self.turn == access.owner_turn,
            "read belongs to an expired turn"
        );
        // A context may have changed away and back. Matching values alone must
        // never reauthorize evidence from an invalidated accessor. Where native
        // discovery exposes its key, also require the exact actual access key.
        if !self.identity.as_ref().is_some_and(|context| {
            Arc::ptr_eq(context, access.context)
                && context.environment_id == access.environment_id
                && &context.cwd == access.cwd
                && context.key == access.key
        }) {
            return Ok(());
        }
        let Some(batch) = &self.active else {
            return Ok(());
        };
        // The call ID is carried by the native caller, never inferred from time or
        // a current thread. Pending native accesses must match the exact finish ID.
        // Do not retain IDs with guidance paths or constrain the native ID format.
        let _ = access.call_id;
        let mut state = batch.0.lock().expect("canonical rules batch poisoned");
        if !state.paths.contains(&access.path) && state.paths.len() >= 64 {
            match access.kind {
                AccessKind::ValidatedTextRead => bail!("read batch exceeds 64 distinct paths"),
                AccessKind::NativeImageRead
                | AccessKind::ExecutorRead
                | AccessKind::ExecutorWrite => state.overflow = true,
            }
        } else {
            state.paths.insert(access.path);
        }
        self.batch = Some(batch.clone());
        Ok(())
    }
}

pub struct CanonicalRules {
    threads: Weak<ThreadManager>,
    environments: Arc<EnvironmentManager>,
}

impl CanonicalRules {
    pub fn new(threads: Weak<ThreadManager>, environments: Arc<EnvironmentManager>) -> Self {
        Self {
            threads,
            environments,
        }
    }

    async fn current(&self, input: &WorldStateContributionInput<'_>) -> Result<String> {
        let Some(rules) = input.thread_store.get::<Rules>() else {
            return Ok(String::new());
        };
        // A previous step's eligibility cannot authorize NEW starts during
        // discovery. Its already-proven native calls may still finish after
        // Code Mode yields. Retain them unless the actual rule context changes.
        {
            let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
            if scope.turn == input.turn_id {
                scope.native_view_image = false;
            }
        }
        let manager = self
            .threads
            .upgrade()
            .context("thread manager unavailable")?;
        let thread = manager.get_thread(input.thread_id).await?;
        let config = thread.config().await;
        // The read tool uses the first native selection as its cwd as well.
        let selection = input.environments.first().context("no selected executor")?;
        ensure!(
            selection.environment_id == codex_exec_server::REMOTE_ENVIRONMENT_ID
                && selection.cwd == rules.1,
            "trusted primary executor changed"
        );
        // The primary FromThread selection deliberately hides its normalized
        // config. Use Core's effective native snapshot, which resolves defaults
        // and materializes workspace roots. Never borrow thread permissions for
        // an unresolved owner attachment.
        let snapshot = thread.config_snapshot().await;
        let permission_profile = match &selection.config {
            EnvironmentConfigState::FromThread => snapshot.permission_profile.clone(),
            EnvironmentConfigState::Ready(config) => {
                config.permission_profile.permission_profile().clone()
            }
            EnvironmentConfigState::Pending | EnvironmentConfigState::Failed(_) => {
                bail!("selected executor configuration unavailable")
            }
        };
        let environment = self
            .environments
            .get_environment(&selection.environment_id)
            .context("selected executor unavailable")?;
        if let Some(discovery) = input.executor_capability_discovery
            && !discovery.sandbox_contexts().is_empty()
        {
            ensure!(
                discovery
                    .sandbox_contexts()
                    .contains_key(&selection.environment_id),
                "selected executor authority missing from discovery"
            );
        }
        let sandbox = match input
            .executor_capability_discovery
            .and_then(|discovery| discovery.sandbox_contexts().get(&selection.environment_id))
        {
            Some(sandbox) => sandbox.clone(),
            None => {
                ensure!(
                    input
                        .environments
                        .iter()
                        .all(|environment| match &environment.config {
                            EnvironmentConfigState::Ready(config) => config
                                .permission_profile
                                .permission_profile()
                                .file_system_sandbox_policy()
                                .has_full_disk_read_access(),
                            EnvironmentConfigState::FromThread => snapshot
                                .permission_profile
                                .file_system_sandbox_policy()
                                .has_full_disk_read_access(),
                            EnvironmentConfigState::Pending | EnvironmentConfigState::Failed(_) =>
                                false,
                        }),
                    "executor discovery authority unavailable"
                );
                // Core omits discovery contexts for full-disk-read profiles. Rebuild
                // its exact permission-bound accessor from the resolved remote owner,
                // rather than treating missing discovery as unrestricted authority.
                let EnvironmentConfigState::Ready(config) = &selection.config else {
                    bail!("resolved executor authority unavailable");
                };
                ensure!(
                    permission_profile
                        .file_system_sandbox_policy()
                        .has_full_disk_read_access(),
                    "discovery authority unavailable for restricted executor"
                );
                let info = environment
                    .info()
                    .await
                    .context("executor authority metadata unavailable")?;
                let (file_system, network) = permission_profile.to_runtime_permissions();
                let permissions = PermissionProfile::from_runtime_permissions_with_enforcement(
                    permission_profile.enforcement(),
                    &file_system,
                    network,
                );
                let mut sandbox = FileSystemSandboxContext::from_permission_profile(
                    permissions,
                    selection.cwd.clone(),
                );
                sandbox.workspace_roots = config.workspace_roots.clone();
                sandbox.user_home_dir = info.user_home_dir;
                sandbox.temporary_directories = info.temporary_directories;
                sandbox.use_legacy_landlock = config.use_legacy_landlock;
                if selection.cwd.infer_path_convention() == Some(PathConvention::Windows) {
                    use codex_file_system::WindowsSandboxSelection;
                    use codex_protocol::{config_types::WindowsSandboxLevel, sandbox::SandboxType};
                    sandbox.windows_sandbox_selection =
                        if config.windows_sandbox_type == SandboxType::WindowsMxc {
                            WindowsSandboxSelection::Mxc
                        } else if config.windows_sandbox_level == WindowsSandboxLevel::Disabled {
                            WindowsSandboxSelection::RestrictedToken
                        } else {
                            config.windows_sandbox_level.into()
                        };
                }
                sandbox
            }
        };
        let bound =
            FileSystemEnvironmentAccessor::new(environment.filesystem_ref(), sandbox.clone());
        let fs = ReadAccess::Authorized(&bound);
        let key = bound.cache_key();
        let canonical_root = fs.canonicalize(&rules.1, None).await?;
        {
            let mut trusted = rules.2.lock().expect("trusted root poisoned");
            if let Some(original) = trusted.as_ref() {
                ensure!(original == &canonical_root, "trusted project root changed");
            } else {
                *trusted = Some(canonical_root.clone());
            }
        }
        let identity = AccessContext {
            environment_id: selection.environment_id.clone(),
            cwd: selection.cwd.clone(),
            workspace_roots: selection.workspace_roots.clone(),
            permission_profile,
            sandbox: sandbox.clone(),
            canonical_root: canonical_root.clone(),
            key,
        };
        let (paths, origin) = {
            let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
            if scope.identity.as_deref() != Some(&identity) {
                scope.renew_context(input.step_store, Some(identity));
            }
            *input
                .step_store
                .get_or_init(StepAccess::default)
                .0
                .lock()
                .expect("canonical rules step poisoned") = scope.identity.clone();
            // Never carry the issuing batch into a later inference. Keep the
            // last successful batch for display until this new one observes I/O.
            scope.active = Some(Arc::new(Batch::default()));
            let paths: Result<_> = scope.batch.as_ref().map_or_else(
                || Ok(HashSet::new()),
                |batch| {
                    let state = batch.0.lock().expect("canonical rules batch poisoned");
                    ensure!(!state.overflow, "read batch exceeds 64 distinct paths");
                    Ok(state.paths.clone())
                },
            );
            (paths, scope.identity.clone())
        };
        // Core spec_plan adds utility tools before external tools. A ready
        // primary selection above proves its advertisement environment condition,
        // including when StableEnvironmentTools is disabled. ViewImage is a
        // session-static feature at this pin (refresh only updates MCP features).
        // The startup ToolPolicy gates both trusted and external registrations;
        // require_managed_sandbox additionally gates ALL core sources.
        let policy = input.thread_store.get::<ToolPolicy>().unwrap_or_default();
        let mut eligible = config.features.enabled(Feature::ViewImage)
            && policy.allows(&ToolName::new(None, "view_image"));
        if eligible && policy.require_managed_sandbox {
            eligible = matches!(
                snapshot.permission_profile,
                PermissionProfile::Managed { .. }
            ) && input
                .environments
                .iter()
                .all(|selection| match &selection.config {
                    EnvironmentConfigState::FromThread => true,
                    EnvironmentConfigState::Ready(environment) => matches!(
                        environment.permission_profile.permission_profile(),
                        PermissionProfile::Managed { .. }
                    ),
                    EnvironmentConfigState::Pending | EnvironmentConfigState::Failed(_) => false,
                });
        }
        // Unavailable rules are nonfatal to tool construction. Finish late
        // loading here so error invalidation cannot erase this step's proof.
        let body = async {
            let paths = paths?;
            load_rules(&fs, &rules.1, &canonical_root, &paths).await
        }
        .await;
        {
            let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
            if scope.turn == input.turn_id
                && scope
                    .identity
                    .as_ref()
                    .zip(origin.as_ref())
                    .is_some_and(|(current, origin)| Arc::ptr_eq(current, origin))
            {
                if body.is_err() {
                    // Invalidate cells and pending calls, even on the same
                    // filesystem. Only this newly proven step can collect.
                    scope.renew_context(input.step_store, origin.as_deref().cloned());
                }
                scope.native_view_image = eligible;
            }
        }
        Ok(body.unwrap_or_else(Self::unavailable))
    }

    fn unavailable(error: anyhow::Error) -> String {
        // Bound even errors containing paths or YAML. Do not copy source bodies.
        let detail: String = format!("{error:#}").chars().take(384).collect();
        format!("Canonical rules unavailable: {detail}")
    }
}

// Core's view_image is not an extension ToolCall and cannot be decorated via
// EnvironmentAccess. At the pin it returns Completed(success) only after
// get_metadata(is_file), sandboxed read_file and image::load_from_memory.
// Capture typed FINALIZED parameters here, then admit on that proven postcondition.
// This postcondition applies ONLY when native registration owns that name in
// the captured step, not when a Python/other external executor fills the slot.
// Blocked, failed/invalid images and MCP tools with a similar name never activate.
impl ToolLifecycleContributor for CanonicalRules {
    fn on_tool_start<'a>(&'a self, input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if input.mcp_tool.is_some()
                || !input.tool_name.is_default_namespace()
                || input.tool_name.name != "view_image"
            {
                return;
            }
            let Some(rules) = input.thread_store.get::<Rules>() else {
                return;
            };
            let ToolPayload::Function { arguments } = input.payload else {
                return;
            };
            let Ok(args) = serde_json::from_str::<ImageArguments>(arguments) else {
                return;
            };
            let (context, path) = {
                let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
                if scope.turn != input.turn_id || scope.active.is_none() {
                    return;
                }
                let context = match &input.source {
                    ToolCallSource::Direct => {
                        if !scope.native_view_image {
                            return;
                        }
                        scope.identity.clone()
                    }
                    ToolCallSource::CodeMode {
                        cell_id,
                        runtime_tool_call_id,
                    } => scope
                        .nested_images
                        .get(&(cell_id.clone(), runtime_tool_call_id.clone()))
                        .cloned(),
                };
                let Some(context) = context.filter(|origin| {
                    scope
                        .identity
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, origin))
                }) else {
                    return;
                };
                if scope.images.len() >= 128 {
                    scope.native_overflow();
                    return;
                }
                // Rules currently use the primary selected executor. Never interpret
                // a different executor's path in that primary filesystem's rules tree.
                if args
                    .environment_id
                    .as_ref()
                    .is_some_and(|selected| selected != &context.environment_id)
                {
                    return;
                }
                let Ok(path) = context.cwd.join(&args.path) else {
                    return;
                };
                (context, path)
            };
            let Some(environment) = self.environments.get_environment(&context.environment_id)
            else {
                return;
            };
            let fs = FileSystemEnvironmentAccessor::new(
                environment.filesystem_ref(),
                context.sandbox.clone(),
            );
            if context.key != fs.cache_key()
                || !contained(&ReadAccess::Authorized(&fs), &context.canonical_root, &path).await
            {
                return;
            }
            let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
            if scope.turn != input.turn_id
                || !scope
                    .identity
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &context))
            {
                return;
            }
            if scope.images.len() >= 128 {
                scope.native_overflow();
                return;
            }
            scope.images.insert(
                input.call_id.to_owned(),
                PendingImage {
                    turn: input.turn_id.to_owned(),
                    context,
                    path,
                    source: input.source,
                },
            );
        })
    }

    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if !input.tool_name.is_default_namespace() || input.tool_name.name != "view_image" {
                return;
            }
            let Some(rules) = input.thread_store.get::<Rules>() else {
                return;
            };
            let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
            let Some(pending) = scope.images.remove(input.call_id) else {
                return;
            };
            if pending.turn == input.turn_id
                && pending.source == input.source
                && input.outcome == (ToolCallOutcome::Completed { success: true })
            {
                // Presence of this entry proves eligibility at start. Turn and
                // full identity (including discovery authority) changes clear it.
                // Collect only the completed path into this step; never restore
                // the yielded step's old batch and its unrelated stale paths.
                let _ = scope.observe(AccessObservation {
                    context: &pending.context,
                    key: pending.context.key.clone(),
                    owner_turn: input.turn_id,
                    call_id: input.call_id,
                    environment_id: &pending.context.environment_id,
                    cwd: &pending.context.cwd,
                    path: pending.path,
                    kind: AccessKind::NativeImageRead,
                });
            }
        })
    }
}

#[derive(Deserialize)]
struct ImageArguments {
    path: String,
    #[serde(default)]
    environment_id: Option<String>,
}

impl TurnLifecycleContributor for CanonicalRules {
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(rules) = input.thread_store.get::<Rules>() {
                input
                    .turn_store
                    .get_or_init(|| RulesTurn(input.turn_id.to_owned()));
                *rules.0.lock().expect("canonical rules scope poisoned") = Scope {
                    turn: input.turn_id.to_owned(),
                    ..Scope::default()
                };
            }
        })
    }
    fn on_turn_stop<'a>(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            retire_turn(input.thread_store, input.turn_store);
        })
    }
    fn on_turn_abort<'a>(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            retire_turn(input.thread_store, input.turn_store);
        })
    }
}

fn retire_turn(thread: &ExtensionData, turn: &ExtensionData) {
    if let (Some(rules), Some(owner)) = (thread.get::<Rules>(), turn.get::<RulesTurn>()) {
        let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
        if scope.turn == owner.0 {
            *scope = Scope::default();
        }
    }
}

impl ContextContributor for CanonicalRules {
    fn contribute_world_state<'a>(
        &'a self,
        input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move {
            let body = match self.current(&input).await {
                Ok(body) => body,
                Err(error) => {
                    // An error before validated rule loading is a real
                    // invalidation, not an inference rollover.
                    if let Some(rules) = input.thread_store.get::<Rules>() {
                        let mut scope = rules.0.lock().expect("canonical rules scope poisoned");
                        if scope.turn == input.turn_id {
                            // If this step resolved its own discovery authority
                            // before the failure, new calls may still collect.
                            // Rebind them to a fresh epoch; no old accessor,
                            // pending image, or cell may survive an unavailable
                            // snapshot. Early discovery errors have no context.
                            let context = input.step_store.get::<StepAccess>().and_then(|step| {
                                step.0
                                    .lock()
                                    .expect("canonical rules step poisoned")
                                    .as_deref()
                                    .cloned()
                            });
                            scope.renew_context(input.step_store, context);
                        }
                    }
                    Self::unavailable(error)
                }
            };
            vec![WorldStateSectionContribution::new("spike_canonical_rules", move |previous| {
                let snapshot = if body.is_empty() { Value::Null } else { Value::String(body.clone()) };
                let unchanged = match previous {
                    PreviousWorldStateSection::Absent => body.is_empty(),
                    PreviousWorldStateSection::Known(value) => value == &snapshot,
                    PreviousWorldStateSection::Unknown => false,
                };
                let fragment = (!unchanged).then(|| RenderedWorldStateFragment::new(
                    "user", MARKERS,
                    if body.is_empty() {
                        "Canonical rules cleared. No earlier canonical rules apply.".to_owned()
                    } else {
                        format!("Current canonical project guidance; replaces all earlier canonical rules.\n{body}")
                    },
                ));
                (Some(snapshot), fragment)
            })
            // No legacy matcher: marker-like user input cannot create native state.
            .with_retained_fragment_matcher(|role, text| {
                role == "user" && text.trim_start().starts_with(MARKERS.0)
                    && text.trim_end().ends_with(MARKERS.1)
            })]
        })
    }
}

impl ToolContributor for CanonicalRules {
    fn tools(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        thread
            .get::<Rules>()
            .map(|rules| {
                vec![Arc::new(ReadText {
                    rules,
                    step: Arc::new(StepAccess::default()),
                })
                    as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>]
            })
            .unwrap_or_default()
    }

    fn tools_for_step(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
        step: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        thread
            .get::<Rules>()
            .map(|rules| {
                vec![Arc::new(ReadText {
                    rules,
                    step: step.get_or_init(StepAccess::default),
                })
                    as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>]
            })
            .unwrap_or_default()
    }
}

struct ReadText {
    rules: Arc<Rules>,
    step: Arc<StepAccess>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArguments {
    path: String,
}

impl<'call> ToolExecutor<ToolCall<'call>> for ReadText {
    fn tool_name(&self) -> ToolName {
        ToolName::new(None, "read_text_file")
    }
    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: "read_text_file".into(),
            description: "Read a regular UTF-8 text file, at most 32768 bytes. Paths are absolute or relative to the environment cwd. Successful reads select applicable canonical project rules.".into(),
            strict: true,
            defer_loading: None,
            parameters: serde_json::from_value(json!({
                "type": "object", "properties": {"path": {"type": "string"}},
                "required": ["path"], "additionalProperties": false
            })).expect("static read_text_file schema"),
            output_schema: None,
        })
    }
    fn exposure(&self) -> ToolExposure {
        ToolExposure::DirectModelOnly
    }
    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }
    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        ToolCall<'call>: 'a,
    {
        Box::pin(async move {
            let read = async {
                ensure!(
                    call.source == ToolCallSource::Direct,
                    "read_text_file is only available directly"
                );
                let args: ReadArguments = serde_json::from_str(call.function_arguments()?)?;
                let env = call.environments.first().context("no selected executor")?;
                let path = env.cwd.join(&args.path)?;
                let context = self
                    .step
                    .0
                    .lock()
                    .expect("canonical rules step poisoned")
                    .clone();
                let key = env.fs().cache_key();
                let eligible = if let Some(context) = context.as_ref() {
                    contained(
                        &ReadAccess::Authorized(env.fs()),
                        &context.canonical_root,
                        &path,
                    )
                    .await
                } else {
                    false
                };
                let text = read_text(&ReadAccess::Authorized(env.fs()), &path).await?;
                if let Some(context) = context.filter(|_| eligible) {
                    let mut scope = self.rules.0.lock().expect("canonical rules scope poisoned");
                    scope.observe(AccessObservation {
                        context: &context,
                        key,
                        owner_turn: &call.turn_id,
                        call_id: &call.call_id,
                        environment_id: &env.environment_id,
                        cwd: &env.cwd,
                        path,
                        kind: AccessKind::ValidatedTextRead,
                    })?;
                }
                Ok::<_, anyhow::Error>(text)
            }
            .await
            .map_err(|e| FunctionCallError::RespondToModel(format!("read_text_file: {e}")))?;
            Ok(Box::new(JsonToolOutput::new(Value::String(read))) as Box<dyn ToolOutput>)
        })
    }
}

// Discovery and tool reads both retain their current native authority.
enum ReadAccess<'a> {
    Authorized(&'a dyn EnvironmentAccess),
}

// Read-only discovery delegates every operation to the captured authority.
impl ExecutorFileSystem for ReadAccess<'_> {
    fn canonicalize<'a>(
        &'a self,
        path: &'a PathUri,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri> {
        match self {
            Self::Authorized(fs) => fs.canonicalize(path),
        }
    }
    fn read_file<'a>(
        &'a self,
        path: &'a PathUri,
        options: ReadFileOptions,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>> {
        match self {
            Self::Authorized(fs) => fs.read_file(path, options),
        }
    }
    fn read_file_stream<'a>(
        &'a self,
        path: &'a PathUri,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream> {
        match self {
            Self::Authorized(fs) => fs.read_file_stream(path),
        }
    }
    fn get_metadata<'a>(
        &'a self,
        path: &'a PathUri,
        options: GetMetadataOptions,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        match self {
            Self::Authorized(fs) => fs.get_metadata(path, options),
        }
    }
    fn read_directory<'a>(
        &'a self,
        path: &'a PathUri,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>> {
        match self {
            Self::Authorized(fs) => fs.read_directory(path),
        }
    }
    fn walk<'a>(
        &'a self,
        path: &'a PathUri,
        options: WalkOptions,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, WalkOutcome> {
        match self {
            Self::Authorized(fs) => fs.walk(path, options),
        }
    }
    fn write_file<'a>(
        &'a self,
        _: &'a PathUri,
        _: Vec<u8>,
        _: WriteFileOptions,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        denied_write()
    }
    fn create_directory<'a>(
        &'a self,
        _: &'a PathUri,
        _: CreateDirectoryOptions,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        denied_write()
    }
    fn remove<'a>(
        &'a self,
        _: &'a PathUri,
        _: RemoveOptions,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        denied_write()
    }
    fn copy<'a>(
        &'a self,
        _: &'a PathUri,
        _: &'a PathUri,
        _: CopyOptions,
        _: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        denied_write()
    }
}

fn denied_write<'a>() -> ExecutorFileSystemFuture<'a, ()> {
    Box::pin(async {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "canonical discovery is read-only",
        ))
    })
}

impl ReadAccess<'_> {
    fn metadata<'a>(&'a self, path: &'a PathUri) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        let options = GetMetadataOptions::default();
        self.get_metadata(path, options, None)
    }
    fn stream<'a>(
        &'a self,
        path: &'a PathUri,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream> {
        self.read_file_stream(path, None)
    }
}

// Canonical containment constrains guidance evidence, never the tool's permissions.
// The native API does not expose an atomic opened-file target identity.
async fn contained(fs: &ReadAccess<'_>, root: &PathUri, path: &PathUri) -> bool {
    fs.canonicalize(path, None)
        .await
        .is_ok_and(|target| target.starts_with(root))
}

async fn read_text(fs: &ReadAccess<'_>, path: &PathUri) -> Result<String> {
    let metadata = fs.metadata(path).await?;
    ensure!(
        metadata.is_file && metadata.size <= SOURCE_LIMIT as u64,
        "expected a regular text file of at most 32768 bytes"
    );
    let mut stream = fs.stream(path).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        ensure!(
            bytes.len() + chunk.len() <= SOURCE_LIMIT,
            "source exceeds 32768 bytes"
        );
        ensure!(!chunk.contains(&0), "text contains NUL");
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8(bytes).context("text is not UTF-8")?)
}

async fn load_rules(
    fs: &ReadAccess<'_>,
    root: &PathUri,
    canonical_root: &PathUri,
    paths: &HashSet<PathUri>,
) -> Result<String> {
    let directory = root.join(".claude/rules")?;
    let no_follow = GetMetadataOptions {
        follow_symlinks: false,
    };
    match fs.get_metadata(&directory, no_follow, None).await {
        Ok(m) if m.is_symlink => return Ok(String::new()),
        Ok(m) => ensure!(m.is_directory, ".claude/rules is not a directory"),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.into()),
    }
    ensure!(
        contained(fs, canonical_root, &directory).await,
        "rules directory outside trusted project"
    );
    // Native walk omits nonregular entries and file symlinks entirely, and silently
    // stops at max_depth. The guide needs all .md sources validated or an error.
    let mut pending = VecDeque::from([(directory, 0usize)]);
    let mut directories = 1usize;
    let mut entries = 0usize;
    let mut files = Vec::new();
    while let Some((dir, depth)) = pending.pop_front() {
        for entry in fs.read_directory(&dir, None).await? {
            entries += 1;
            ensure!(entries <= 1024, "rules discovery exceeds 1024 entries");
            let path = dir.join(&entry.file_name)?;
            // Default metadata identifies links; no-follow metadata rejects them.
            // Match native walk without reading linked rule contents.
            if fs.metadata(&path).await?.is_symlink {
                continue;
            }
            let meta = fs.get_metadata(&path, no_follow, None).await?;
            if meta.is_symlink {
                continue;
            }
            if meta.is_directory {
                directories += 1;
                ensure!(
                    directories <= 256,
                    "rules discovery exceeds 256 directories"
                );
                ensure!(depth < 64, "rules discovery depth exceeds 64");
                pending.push_back((path, depth + 1));
            } else if entry.file_name.ends_with(".md") {
                files.push(path);
            }
        }
    }
    files.sort_by_key(ToString::to_string);
    let windows = root.infer_path_convention() == Some(PathConvention::Windows);
    let relative: Vec<_> = paths
        .iter()
        .filter_map(|p| p.relative_path_from(root))
        .map(|s| if windows { s.replace('\\', "/") } else { s })
        .collect();
    let mut result = String::new();
    for path in files {
        let label = path
            .relative_path_from(root)
            .context("rule outside project")?;
        ensure!(
            contained(fs, canonical_root, &path).await,
            "rule outside trusted project"
        );
        let source = read_text(fs, &path)
            .await
            .with_context(|| format!("invalid {label}"))?;
        let (body, applies) =
            applicable(&source, &relative, windows).with_context(|| format!("invalid {label}"))?;
        if applies {
            let labeled = format!("\n{label}:\n{body}\n");
            ensure!(
                result.len() + labeled.len() <= CONTEXT_LIMIT,
                "applicable rules exceed 3000 bytes"
            );
            result.push_str(&labeled);
        }
    }
    Ok(result)
}

fn applicable<'a>(source: &'a str, paths: &[String], windows: bool) -> Result<(&'a str, bool)> {
    let mut lines = source.split_inclusive('\n');
    let first = lines.next().unwrap_or_default();
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return Ok((source, true));
    }
    let start = first.len();
    let mut end = start;
    for line in lines.by_ref() {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let header = &source[start..end];
            let value: serde_yaml::Value =
                serde_yaml::from_str(header).context("invalid YAML header")?;
            let body = &source[end + line.len()..];
            if value.is_null() && header.trim().is_empty() {
                return Ok((body, true));
            }
            let mapping = value
                .as_mapping()
                .context("frontmatter must be a mapping")?;
            let Some(globs) = mapping.get(serde_yaml::Value::String("paths".into())) else {
                return Ok((body, true));
            };
            let globs = globs
                .as_sequence()
                .context("paths must be a non-empty YAML list")?;
            ensure!(!globs.is_empty(), "paths must be a non-empty YAML list");
            let mut matches = false;
            for glob in globs {
                let pattern = glob.as_str().context("paths entries must be strings")?;
                ensure!(
                    !pattern.is_empty()
                        && pattern.trim() == pattern
                        && !pattern.starts_with(['!', '~', '/'])
                        && !pattern.contains(['\\', ':', '\0'])
                        && !pattern.split('/').any(|c| matches!(c, "" | "." | ".."))
                        && !["?(", "*(", "+(", "@(", "!("]
                            .iter()
                            .any(|s| pattern.contains(s)),
                    "invalid paths glob"
                );
                let matcher = GlobBuilder::new(pattern)
                    .literal_separator(true)
                    .backslash_escape(false)
                    .case_insensitive(windows)
                    .build()
                    .context("invalid paths glob")?
                    .compile_matcher();
                matches |= paths.iter().any(|p| matcher.is_match(p));
            }
            return Ok((body, matches));
        }
        end += line.len();
    }
    bail!("unclosed YAML frontmatter")
}

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};

use anyhow::{Context, Result, ensure};
use codex_core_api::{CodexThread, Config, Feature, StartThreadOptions, ThreadManager};
use codex_extension_api::{
    ContextContributor, ExtensionData, ExtensionFuture, ThreadIdleInput,
    ThreadLifecycleContributor, ThreadStartInput, ThreadStopInput, ToolCallOutcome,
    ToolContributor, ToolFinishInput, ToolLifecycleContributor, ToolLifecycleFuture, ToolPolicy,
    TurnAbortInput, TurnLifecycleContributor, TurnStartInput, TurnStopInput,
    WorldStateContributionInput, WorldStateSectionContribution,
};
use codex_protocol::dynamic_tools::{
    DynamicToolFunctionSpec, DynamicToolNamespaceSpec, DynamicToolNamespaceTool,
    DynamicToolResponse, DynamicToolSpec,
};
use codex_protocol::models::{
    FunctionCallOutputBody, FunctionCallOutputContentItem, FunctionCallOutputPayload,
    ResponseInputItem, ResponseItem,
};
use codex_protocol::openai_models::ToolMode;
use codex_protocol::protocol::{AgentStatus, SessionSource, ThreadSource};
use codex_tools::{
    FunctionCallError, ResponsesApiNamespace, ResponsesApiNamespaceTool, ToolCall, ToolCallSource,
    ToolExecutor, ToolExecutorFuture, ToolExposure, ToolName, ToolOutput, ToolPayload,
    ToolSearchInfo, ToolSearchSourceInfo, ToolSpec, default_namespace_description,
    dynamic_tool_to_responses_api_tool,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

#[path = "manual.rs"]
mod manual;
pub(crate) use manual::{Continuation, ManualLedger, ManualSlot};

#[path = "schema_fidelity.rs"]
mod schema_fidelity;

#[path = "prepared_requests.rs"]
pub(crate) mod prepared_requests;

struct Entry {
    name: ToolName,
    spec: ToolSpec,
    exposure: ToolExposure,
}

struct Generation {
    id: u64,
    schema_token: Option<String>,
    entries: Vec<Entry>,
    specs: Vec<DynamicToolSpec>,
    defaults: Vec<usize>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, Deserialize, Serialize)]
pub struct ReplyKey {
    pub thread: String,
    pub generation: u64,
    pub slot: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_grant: Option<String>,
}

// turn/call come from the original request, not a name lookup at response time.
#[derive(Clone, Debug, Hash, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct PendingKey {
    #[serde(rename = "_sdk_python_tool")]
    pub(crate) reply: ReplyKey,
    #[serde(rename = "turnId")]
    pub(crate) turn: String,
    #[serde(rename = "callId")]
    pub(crate) call: String,
}

/// Independent schema and local-authority decisions for one root installation.
pub(crate) struct ToolInstallOptions {
    pub(crate) preserve_schemas: bool,
    pub(crate) allow_local_goals: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManualOwner {
    pub(crate) thread: String,
    pub(crate) instance: Option<String>,
    #[serde(rename = "turnId")]
    pub(crate) turn: String,
}

struct PendingCall {
    _tracing: Option<codex_otel::sdk_trace::ContextLease>,
    sender: oneshot::Sender<DynamicToolResponse>,
    manual_request: Option<Value>,
}

pub(crate) struct ChildStepSelection;

pub struct PythonTools {
    local_store: Option<Arc<crate::local_storage::LocalChecklistStore>>,
    custom_store: Option<Arc<crate::custom_storage::CustomThreadStore>>,
    preserve_schemas: bool,
    schema_receipts: schema_fidelity::Receipts,
    current: RwLock<Arc<Generation>>,
    fixed: HashSet<ToolName>,
    policy: Arc<ToolPolicy>,
    pending: Mutex<HashMap<PendingKey, PendingCall>>,
    family: Arc<Family>,
    instance: Option<String>,
    pub(crate) inherit_children: bool,
    child_before_step: bool,
    manual: Mutex<ManualLedger>,
    selection: Mutex<Option<ActiveSelection>>,
    step_replies: Mutex<HashMap<u64, PendingStep>>,
    prepared: Mutex<Option<Arc<prepared_requests::Owner>>>,
}

// The family inbox transports requests; reply authority stays with each issuer.
enum FamilyRequest {
    Step(Weak<PythonTools>, u64, Value),
    Prepared(Weak<prepared_requests::Owner>, u64, Value),
    Call(Weak<PythonTools>, PendingKey, Value),
    Retired { thread: String, instance: String },
}
struct Family {
    members: RwLock<HashMap<String, Weak<PythonTools>>>,
    requests: mpsc::UnboundedSender<FamilyRequest>,
    receiver: AsyncMutex<mpsc::UnboundedReceiver<FamilyRequest>>,
    manual_progress: manual::ManualProgress,
    next_step: AtomicU64,
}
impl Default for Family {
    fn default() -> Self {
        let (requests, receiver) = mpsc::unbounded_channel();
        Self {
            members: RwLock::default(),
            requests,
            receiver: AsyncMutex::new(receiver),
            manual_progress: manual::ManualProgress::default(),
            next_step: AtomicU64::new(1),
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct Reply {
    pub(crate) request: PendingKey,
    pub(crate) response: DynamicToolResponse,
}

fn functions(
    specs: &[DynamicToolSpec],
) -> Vec<(Option<&DynamicToolNamespaceSpec>, &DynamicToolFunctionSpec)> {
    let mut functions = Vec::new();
    for spec in specs {
        match spec {
            DynamicToolSpec::Function(tool) => functions.push((None, tool)),
            DynamicToolSpec::Namespace(namespace) => {
                for DynamicToolNamespaceTool::Function(tool) in &namespace.tools {
                    functions.push((Some(namespace), tool));
                }
            }
        }
    }
    functions
}

fn validate_slots(specs: &[DynamicToolSpec]) -> Result<()> {
    ensure!(
        specs.iter().all(|spec| match spec {
            DynamicToolSpec::Function(_) => true,
            DynamicToolSpec::Namespace(ns) => ns.tools.len() == 1,
        }),
        "invalid JavaScript tool slot projection"
    );
    Ok(())
}

/// Validate declarations without acquiring runtime resources or consulting live policy.
pub(crate) fn validate_declarations(specs: &[DynamicToolSpec]) -> Result<()> {
    validate_slots(specs)?;
    let mut seen = HashSet::new();
    for (namespace, tool) in functions(specs) {
        let key = ToolName::new(namespace.map(|ns| ns.name.clone()), tool.name.clone())
            .with_default_namespace();
        ensure!(seen.insert(key.clone()), "Duplicate JavaScript tool: {key}");
        ensure!(
            !(key.is_default_namespace()
                && matches!(
                    key.name.as_str(),
                    "exec_command"
                        | "shell_command"
                        | "exec"
                        | "wait"
                        | "tool_search"
                        | "apply_patch"
                        | "write_stdin"
                ))
                && key.namespace.as_deref() != Some("tool_search")
                && !matches!(
                    (key.namespace.as_deref(), key.name.as_str()),
                    (Some("web"), "run") | (Some("image_gen"), "imagegen")
                ),
            "JavaScript tool uses a reserved name: {key}"
        );
        dynamic_tool_to_responses_api_tool(tool)?;
    }
    Ok(())
}

// Keep the local ceiling tied to the current native planning grant. A persisted
// checklist never adds a name to the ceiling, and managed callbacks remain managed.
fn validate_local_policy(
    policy: &ToolPolicy,
    names: &HashSet<ToolName>,
    planning: bool,
    search: Option<&ToolName>,
) -> Result<()> {
    let plan = ToolName::plain("update_plan").with_default_namespace();
    let allowed = policy
        .allowed_tools
        .as_ref()
        .context("local storage requires an explicit managed ToolPolicy ceiling")?;
    ensure!(
        allowed.iter().all(|name| {
            let name = name.clone().with_default_namespace();
            names.contains(&name) || (planning && name == plan) || search == Some(&name)
        }) && (!planning
            || allowed
                .iter()
                .any(|name| name.clone().with_default_namespace() == plan))
            && search.is_none_or(|search| allowed
                .iter()
                .any(|name| name.clone().with_default_namespace() == *search)),
        "local storage ToolPolicy may only allow admitted managed tools, checked native planning and current WebSearch"
    );
    Ok(())
}

fn tool_names(specs: &[DynamicToolSpec]) -> HashSet<ToolName> {
    functions(specs)
        .into_iter()
        .map(|(namespace, tool)| {
            ToolName::new(namespace.map(|ns| ns.name.clone()), tool.name.clone())
                .with_default_namespace()
        })
        .collect()
}

// Portable SDK v2 specs include deferLoading even when false. Core omits that
// default on serialization. Keep the exact existing SDK representation (also
// for namespace members), without preserving any unknown authority fields.
pub fn checkpoint_specs(specs: &[DynamicToolSpec]) -> Result<Value> {
    let mut value = serde_json::to_value(specs)?;
    for spec in value.as_array_mut().expect("serialized specs array") {
        if let Some(tools) = spec.get_mut("tools").and_then(Value::as_array_mut) {
            for tool in tools {
                tool.as_object_mut()
                    .expect("serialized namespace tool")
                    .entry("deferLoading")
                    .or_insert(Value::Bool(false));
            }
        } else {
            spec.as_object_mut()
                .expect("serialized tool")
                .entry("deferLoading")
                .or_insert(Value::Bool(false));
        }
    }
    Ok(value)
}

impl PythonTools {
    pub(crate) fn inherits_children(&self) -> bool {
        self.inherit_children
    }
    pub(crate) fn install(
        startup: &mut StartThreadOptions,
        specs: Vec<DynamicToolSpec>,
        options: ToolInstallOptions,
    ) -> Result<()> {
        let ToolInstallOptions {
            preserve_schemas,
            allow_local_goals,
        } = options;
        // Core resolves absent source options from resumed metadata at startup.
        let resumed_sources = startup.initial_history.get_resumed_session_sources();
        let session_source = startup
            .session_source
            .as_ref()
            .or_else(|| resumed_sources.as_ref().map(|(source, _)| source));
        let thread_source = startup.thread_source.as_ref().or_else(|| {
            resumed_sources
                .as_ref()
                .and_then(|(_, source)| source.as_ref())
        });
        ensure!(
            matches!(thread_source, None | Some(ThreadSource::User))
                && !matches!(
                    session_source,
                    Some(SessionSource::Internal(_) | SessionSource::SubAgent(_))
                ),
            "replaceable tools require a root thread"
        );
        ensure!(
            !startup
                .config
                .features
                .enabled(Feature::CodeModeOnlyStrictThirdPartyTools),
            "replaceable tools do not support strict third-party Code Mode"
        );
        ensure!(
            !startup
                .config
                .features
                .persistent_execution_enabled(startup.config.model_reasoning_effort.as_ref()),
            "replaceable tools do not support persistent execution"
        );
        // Core can fall back to the header when raw startup tools are absent.
        // Preserve every fixed name as a boundary, even if explicit raw
        // options temporarily hide that history from the native advertisement.
        let history_tools = startup
            .initial_history
            .get_dynamic_tools()
            .unwrap_or_default();
        let mut fixed = tool_names(&history_tools);
        fixed.extend(tool_names(&startup.dynamic_tools));
        if startup.config.update_plan_enabled {
            fixed.insert(ToolName::plain("update_plan").with_default_namespace());
        }
        let search = crate::config::web_search_tool(&startup.config);
        fixed.extend(search.iter().cloned());
        let hosted_names: HashSet<_> = startup
            .thread_extension_init
            .get::<codex_extension_api::HostedModelTools>()
            .map(|hosted| {
                hosted
                    .tools
                    .iter()
                    .map(|tool| {
                        ToolName::plain(match tool {
                            codex_tools::HostedToolSpec::FileSearch(_) => "file_search",
                            codex_tools::HostedToolSpec::CodeInterpreter(_) => "code_interpreter",
                            codex_tools::HostedToolSpec::ImageGeneration(_) => "image_generation",
                        })
                        .with_default_namespace()
                    })
                    .collect()
            })
            .unwrap_or_default();
        fixed.extend(hosted_names.iter().cloned());
        let policy = startup
            .thread_extension_init
            .get::<ToolPolicy>()
            .unwrap_or_default();
        if let Some(search) = &search {
            ensure!(
                policy.allows(search),
                "WebSearch is excluded by the current ToolPolicy"
            );
        }
        ensure!(
            !preserve_schemas || !startup.config.features.enabled(Feature::IncrementalTools),
            "Managed tool schema fidelity requires request-scoped native tool declarations"
        );
        let local_store = startup
            .thread_extension_init
            .get::<crate::local_storage::LocalReceiptStore>();
        ensure!(
            !allow_local_goals
                || (local_store.is_some() && startup.config.features.enabled(Feature::Goals)),
            "native goals require a checked local grant"
        );
        let goal_names = if allow_local_goals {
            crate::goals::tool_names()
        } else {
            HashSet::new()
        };
        if local_store.is_some()
            || startup
                .thread_extension_init
                .get::<crate::custom_storage::ReceiptStore>()
                .is_some()
        {
            let mut names = tool_names(&specs);
            names.extend(hosted_names.iter().cloned());
            names.extend(goal_names.iter().cloned());
            // These are current startup grants, not names read from history.
            // Keep the explicit ToolPolicy ceiling and all normal native
            // environment/collaboration checks in addition to this local gate.
            let execution = startup
                .environments
                .as_ref()
                .is_some_and(|items| !items.is_empty());
            if execution {
                names.extend(
                    [
                        "exec_command",
                        "write_stdin",
                        "apply_patch",
                        "project_glob",
                        "project_grep",
                    ]
                    .into_iter()
                    .map(|name| ToolName::plain(name).with_default_namespace()),
                );
            }
            if execution && startup.config.agents_enabled {
                names.extend(
                    [
                        "spawn_agent",
                        "wait_agent",
                        "send_message",
                        "followup_task",
                        "interrupt_agent",
                        "list_agents",
                    ]
                    .into_iter()
                    .map(|name| ToolName::new(Some("collaboration".into()), name)),
                );
            }
            validate_local_policy(
                &policy,
                &names,
                startup.config.update_plan_enabled,
                search.as_ref(),
            )?;
            ensure!(
                policy
                    .allowed_tools
                    .as_ref()
                    .is_some_and(|allowed| goal_names.iter().all(|name| allowed
                        .iter()
                        .any(|allowed| allowed.clone().with_default_namespace() == *name))),
                "local storage ToolPolicy may only allow admitted managed tools"
            );
        }
        fixed.extend(goal_names);
        let tools = Self {
            custom_store: startup
                .thread_extension_init
                .get::<crate::custom_storage::ReceiptStore>()
                .map(|store| store.0.clone()),
            local_store: startup
                .thread_extension_init
                .get::<crate::local_storage::LocalReceiptStore>()
                .map(|store| store.0.clone()),
            preserve_schemas,
            schema_receipts: Default::default(),
            current: RwLock::new(Arc::new(Generation {
                id: 0,
                schema_token: None,
                entries: Vec::new(),
                specs: Vec::new(),
                defaults: Vec::new(),
            })),
            fixed,
            policy,
            pending: Mutex::new(HashMap::new()),
            family: Arc::new(Family::default()),
            instance: None,
            inherit_children: startup
                .thread_extension_init
                .get::<crate::native_agents::Policy>()
                .is_some()
                || startup
                    .config
                    .features
                    .enabled(Feature::MultiAgentV2DynamicTools),
            child_before_step: startup
                .thread_extension_init
                .get::<ChildStepSelection>()
                .is_some(),
            manual: Mutex::new(ManualLedger::default()),
            selection: Mutex::new(None),
            step_replies: Mutex::new(HashMap::new()),
            prepared: Mutex::new(None),
        };
        let seed = Arc::new(tools.prepare(0, specs)?);
        tools.schema_receipts.register(&seed);
        *tools.current.write().expect("JavaScript catalog poisoned") = seed;
        startup
            .thread_extension_init
            .insert(tools.family.manual_progress.clone());
        startup.thread_extension_init.insert(tools);
        Ok(())
    }

    pub(crate) fn owner(self: &Arc<Self>, root: &str, key: &PendingKey) -> Option<Arc<Self>> {
        self.exact_owner(root, &key.reply.thread, &key.reply.instance)
    }

    pub(crate) fn exact_owner(
        self: &Arc<Self>,
        root: &str,
        thread: &str,
        instance: &Option<String>,
    ) -> Option<Arc<Self>> {
        if thread == root && instance == &self.instance {
            return Some(self.clone());
        }
        self.family
            .members
            .read()
            .ok()?
            .get(thread)?
            .upgrade()
            .filter(|owner| &owner.instance == instance && Arc::ptr_eq(&owner.family, &self.family))
    }

    fn descendant(parent: &Self, instance: String, policy: Arc<ToolPolicy>) -> Result<Self> {
        let child = Self {
            // Receipt ownership stays with each child writer/turn/call, not the root.
            local_store: parent.local_store.clone(),
            custom_store: parent.custom_store.clone(),
            preserve_schemas: parent.preserve_schemas,
            schema_receipts: Default::default(),
            current: RwLock::new(parent.snapshot()),
            fixed: parent.fixed.clone(),
            policy,
            pending: Mutex::default(),
            family: parent.family.clone(),
            instance: Some(instance),
            inherit_children: parent.inherit_children,
            child_before_step: parent.child_before_step,
            manual: Mutex::new(parent.child_manual_ledger()),
            selection: Mutex::new(None),
            step_replies: Mutex::new(HashMap::new()),
            prepared: Mutex::new(None),
        };
        // Validate the inherited catalog against this child's current ceiling.
        let parent_generation = parent.snapshot();
        let mut generation =
            child.prepare(parent_generation.id, parent_generation.specs.clone())?;
        generation.defaults = parent_generation.defaults.clone();
        let generation = Arc::new(generation);
        child.schema_receipts.register(&generation);
        *child.current.write().expect("JavaScript catalog poisoned") = generation;
        Ok(child)
    }

    fn prepare(&self, id: u64, specs: Vec<DynamicToolSpec>) -> Result<Generation> {
        let mut entries = Vec::new();
        let schema_token = self
            .preserve_schemas
            .then(|| codex_protocol::ThreadId::new().to_string());
        validate_declarations(&specs)?;
        for (namespace, tool) in functions(&specs) {
            let name = ToolName::new(namespace.map(|ns| ns.name.clone()), tool.name.clone());
            let key = name.clone().with_default_namespace();
            ensure!(
                !self.fixed.contains(&key),
                "JavaScript tool collides with fixed tool: {key}"
            );
            ensure!(
                self.policy.allows(&key),
                "JavaScript tool is excluded by ToolPolicy: {key}"
            );
            let mut function = dynamic_tool_to_responses_api_tool(tool)?;
            function.defer_loading = None;
            function.strict = false;
            if let Some(token) = &schema_token {
                function.description =
                    schema_fidelity::Receipts::description(&tool.description, token, entries.len());
            }
            let spec = match namespace.filter(|_| !key.is_default_namespace()) {
                None => ToolSpec::Function(function),
                Some(ns) => ToolSpec::Namespace(ResponsesApiNamespace {
                    name: ns.name.clone(),
                    description: if ns.description.trim().is_empty() {
                        default_namespace_description(&ns.name)
                    } else {
                        ns.description.clone()
                    },
                    tools: vec![ResponsesApiNamespaceTool::Function(function)],
                }),
            };
            entries.push(Entry {
                name,
                spec,
                exposure: if tool.defer_loading {
                    ToolExposure::Deferred
                } else {
                    ToolExposure::Direct
                },
            });
        }
        Ok(Generation {
            id,
            schema_token,
            defaults: (0..entries.len()).collect(),
            entries,
            specs,
        })
    }

    pub fn current_specs(&self) -> Result<Value> {
        let generation = self.snapshot();
        checkpoint_specs(
            &generation
                .defaults
                .iter()
                .map(|&slot| generation.specs[slot].clone())
                .collect::<Vec<_>>(),
        )
    }

    /// Internal context replacement retains hidden admitted bindings too.
    pub(crate) fn context_specs(&self) -> Result<Value> {
        checkpoint_specs(&self.snapshot().specs)
    }

    pub(crate) fn retain_context_revision(&self, source: &Self) -> Result<()> {
        self.check_context_manual_idle()?;
        self.check_context_manual_bindings(source)?;
        let original = source.snapshot();
        let mut current = self.current.write().expect("JavaScript catalog poisoned");
        ensure!(
            current.id == 0,
            "compaction candidate tool revision is no longer fresh"
        );
        ensure!(
            checkpoint_specs(&current.specs)? == checkpoint_specs(&original.specs)?,
            "compaction candidate must retain current tool declarations"
        );
        let mut seed = self.prepare(original.id, current.specs.clone())?;
        seed.defaults = original.defaults.clone();
        let seed = Arc::new(seed);
        self.schema_receipts.register(&seed);
        *current = seed;
        Ok(())
    }

    pub(crate) fn generation(&self) -> u64 {
        self.snapshot().id
    }

    pub(crate) fn check_family_idle(&self) -> Result<()> {
        ensure!(
            !self.inherits_children()
                || !self
                    .family
                    .members
                    .read()
                    .expect("JavaScript family poisoned")
                    .values()
                    .any(|member| member.upgrade().is_some()),
            "Tool replacement requires closed inheriting native children"
        );
        Ok(())
    }

    pub async fn replace(
        &self,
        thread: &CodexThread,
        id: u64,
        specs: Vec<DynamicToolSpec>,
        defaults: Option<Vec<usize>>,
    ) -> Result<u64> {
        let mut candidate = self.prepare(id, specs)?;
        if let Some(defaults) = defaults {
            validate_selection(&defaults, &(0..candidate.entries.len()).collect::<Vec<_>>())?;
            candidate.defaults = defaults;
        }
        self.check_idle(thread).await?;
        self.check_family_idle()?;
        self.publish(candidate)
    }

    fn publish(&self, candidate: Generation) -> Result<u64> {
        let id = candidate.id;
        let mut current = self.current.write().expect("JavaScript catalog poisoned");
        ensure!(
            id == current.id + 1,
            "JavaScript tool generation is out of sequence"
        );
        let candidate = Arc::new(candidate);
        self.schema_receipts.register(&candidate);
        *current = candidate;
        *self.manual.lock().expect("manual tools poisoned") = ManualLedger::default();
        Ok(id)
    }

    pub async fn check_idle(&self, thread: &CodexThread) -> Result<()> {
        ensure!(
            thread.active_turn_environment_selections().await.is_none()
                && !matches!(
                    thread.agent_status().await,
                    AgentStatus::Running | AgentStatus::Shutdown | AgentStatus::NotFound
                ),
            "replaceable tools require an idle, open native thread"
        );
        ensure!(
            self.pending
                .lock()
                .expect("JavaScript replies poisoned")
                .is_empty(),
            "JavaScript tool replies are pending"
        );
        Ok(())
    }

    // An automatic checkpoint is the one busy snapshot admitted by the SDK.
    // Do not accept a name, a past generation, or an expired reply as authority.
    pub fn check_pending(&self, owner: &str, key: &PendingKey) -> Result<()> {
        ensure!(
            key.reply.thread == owner
                && key.reply.instance == self.instance
                && key.reply.generation == self.snapshot().id
                && self
                    .pending
                    .lock()
                    .expect("JavaScript replies poisoned")
                    .contains_key(key),
            "Expired or invalid managed JavaScript tool request"
        );
        Ok(())
    }

    fn snapshot(&self) -> Arc<Generation> {
        self.current
            .read()
            .expect("JavaScript catalog poisoned")
            .clone()
    }

    pub(crate) fn has_pending_request(&self) -> bool {
        self.family
            .receiver
            .try_lock()
            .map_or(true, |receiver| !receiver.is_empty())
    }

    pub async fn next_request(self: &Arc<Self>) -> Value {
        let mut receiver = self.family.receiver.lock().await;
        loop {
            match receiver.recv().await {
                Some(FamilyRequest::Prepared(owner, id, request)) => {
                    if owner.upgrade().is_some_and(|owner| owner.queued(id)) {
                        return request;
                    }
                }
                Some(FamilyRequest::Step(owner, id, request)) => {
                    if owner.upgrade().is_some_and(|tools| {
                        if tools.instance.is_some() {
                            let Some(thread) = request["msg"]["thread"].as_str() else {
                                return false;
                            };
                            if !self
                                .exact_owner("", thread, &tools.instance)
                                .is_some_and(|current| Arc::ptr_eq(&current, &tools))
                            {
                                return false;
                            }
                            let (Some(turn), Some(generation)) = (
                                request["msg"]["turn_id"].as_str(),
                                request["msg"]["generation"].as_str(),
                            ) else {
                                return false;
                            };
                            let response = StepReply {
                                thread: thread.to_owned(),
                                instance: tools.instance.clone(),
                                turn_id: turn.to_owned(),
                                generation: generation.to_owned(),
                                request_id: id.to_string(),
                                slots: None,
                                names: None,
                            };
                            return tools.check_step(thread, &response).unwrap_or(false);
                        }
                        tools
                            .step_replies
                            .lock()
                            .expect("JavaScript step replies poisoned")
                            .get(&id)
                            .is_some_and(|pending| !pending.reply.is_closed())
                    }) {
                        return request;
                    }
                }
                Some(FamilyRequest::Call(owner, key, request)) => {
                    if owner.upgrade().is_some_and(|owner| {
                        owner
                            .pending
                            .lock()
                            .expect("JavaScript replies poisoned")
                            .contains_key(&key)
                    }) {
                        return request;
                    }
                }
                Some(FamilyRequest::Retired { thread, instance }) => {
                    return json!({
                        "id": "", "subagent_id": thread, "subagent_incarnation": instance,
                        "msg": { "type": "shutdown_complete" }
                    });
                }
                None => std::future::pending::<()>().await,
            }
        }
    }

    // Take the live sender only once. The binding retains it while its writer
    // commits the real result; a failed commit cannot be mistaken for success.
    pub(crate) fn take_reply(
        &self,
        owner: &str,
        key: &PendingKey,
    ) -> Result<Option<oneshot::Sender<DynamicToolResponse>>> {
        if key.reply.thread != owner {
            return Ok(None);
        }
        let mut pending = self.pending.lock().expect("JavaScript replies poisoned");
        Ok(pending.remove(key).map(|call| call.sender))
    }

    fn enqueue(
        self: &Arc<Self>,
        thread: &str,
        generation: &Generation,
        slot: usize,
        turn: &str,
        call: &str,
        arguments: Value,
        source: &ToolCallSource,
        model: &str,
    ) -> Result<(PendingKey, oneshot::Receiver<DynamicToolResponse>)> {
        let entry = &generation.entries[slot];
        let key = PendingKey {
            reply: ReplyKey {
                thread: thread.to_owned(),
                generation: generation.id,
                slot,
                instance: self.instance.clone(),
                // Live manual requests bind capability identity, including
                // equal wire IDs in one native turn. Automatic calls keep
                // their original duplicate-call rejection.
                manual_grant: self
                    .is_manual(&entry.name)
                    .then(|| codex_core_api::ThreadId::new().to_string()),
            },
            turn: turn.to_owned(),
            call: call.to_owned(),
        };
        let (sender, receiver) = oneshot::channel();
        let code_origin = match source {
            ToolCallSource::Direct => Value::Null,
            ToolCallSource::CodeMode {
                cell_id,
                runtime_tool_call_id,
            } => json!({"cell_id":cell_id, "nested_call_id":runtime_tool_call_id}),
        };
        let tracing = codex_otel::sdk_trace::ContextLease::capture();
        let mut request = json!({
            "id": call,
            "msg": {
                "type":"dynamic_tool_call_request", "turnId": turn, "callId": call,
                "namespace": entry.name.namespace, "tool": entry.name.name,
                "arguments": arguments, "_sdk_python_tool": key.reply,
                "_sdk_code_origin":code_origin, "_sdk_model":model,
                "_sdk_trace_context": codex_otel::current_span_w3c_trace_context()
            }
        });
        if let Some(context) = &tracing {
            request["msg"]["tracing_context"] = json!(context.token());
        }
        if let Some(instance) = &self.instance {
            request["subagent_id"] = json!(thread);
            request["subagent_incarnation"] = json!(instance);
            request["subagent_managed_tools"] = json!(true);
        }
        {
            let mut pending = self.pending.lock().expect("JavaScript replies poisoned");
            ensure!(
                !pending.contains_key(&key),
                "Duplicate JavaScript tool call"
            );
            pending.insert(
                key.clone(),
                PendingCall {
                    _tracing: tracing,
                    sender,
                    manual_request: key.reply.manual_grant.as_ref().map(|_| request.clone()),
                },
            );
        }
        if self
            .family
            .requests
            .send(FamilyRequest::Call(
                Arc::downgrade(self),
                key.clone(),
                request,
            ))
            .is_err()
        {
            self.pending
                .lock()
                .expect("JavaScript replies poisoned")
                .remove(&key);
            anyhow::bail!("JavaScript tool session closed");
        }
        Ok((key, receiver))
    }
}

// Removing the sender on any future drop also expires already queued requests.
struct PendingReply<'a> {
    tools: &'a PythonTools,
    key: PendingKey,
}

impl Drop for PendingReply<'_> {
    fn drop(&mut self) {
        self.tools
            .pending
            .lock()
            .expect("JavaScript replies poisoned")
            .remove(&self.key);
    }
}

#[derive(Default)]
pub struct PythonContributor {
    pub(crate) manager: Weak<ThreadManager>,
    pub(crate) models_config: codex_models_manager::ModelsManagerConfig,
    pub(crate) code_mode_enabled: bool,
}

// Presentation follows the current model; it never grants a tool.
struct ModelPresentation {
    use_deferred_specs: bool,
}

impl ThreadLifecycleContributor<Config> for PythonContributor {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(control) = input
                .thread_store
                .get::<crate::native_interception::Control>()
                && let Some(parent) = control.inherited_parent(&self.manager).await
            {
                if let Some(progress) = parent
                    .thread_extension_data()
                    .get::<manual::ManualProgress>()
                {
                    input.thread_store.get_or_init(|| (*progress).clone());
                }
                if let Some(hosted) = parent
                    .thread_extension_data()
                    .get::<codex_extension_api::HostedModelTools>()
                {
                    input.thread_store.get_or_init(|| (*hosted).clone());
                }
                if let Some(parent_tools) = parent.thread_extension_data().get::<PythonTools>()
                    && parent_tools.inherit_children
                {
                    let policy = input
                        .thread_store
                        .get::<ToolPolicy>()
                        .unwrap_or_else(|| parent_tools.policy.clone());
                    if let Ok(child) =
                        PythonTools::descendant(&parent_tools, control.incarnation.clone(), policy)
                    {
                        let tools = input.thread_store.get_or_init(|| child);
                        parent_tools
                            .family
                            .members
                            .write()
                            .expect("JavaScript family poisoned")
                            .insert(
                                input.thread_store.level_id().to_owned(),
                                Arc::downgrade(&tools),
                            );
                    }
                }
            }
        })
    }
    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(progress) = input.thread_store.get::<manual::ManualProgress>() {
                progress.0.send_replace(());
            }
        })
    }
    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(progress) = input.thread_store.get::<manual::ManualProgress>() {
                progress.0.send_replace(());
            }
            if let Some(tools) = input.thread_store.get::<PythonTools>() {
                tools.retire_preparation(None);
                tools.retire_manual_wait();
                tools
                    .step_replies
                    .lock()
                    .expect("JavaScript step replies poisoned")
                    .clear();
            }
            if let Some(tools) = input.thread_store.get::<PythonTools>()
                && let Some(instance) = &tools.instance
            {
                tools
                    .pending
                    .lock()
                    .expect("JavaScript replies poisoned")
                    .clear();
                let id = input.thread_store.level_id();
                let mut members = tools
                    .family
                    .members
                    .write()
                    .expect("JavaScript family poisoned");
                if members
                    .get(id)
                    .and_then(Weak::upgrade)
                    .is_some_and(|current| Arc::ptr_eq(&current, &tools))
                {
                    members.remove(id);
                }
                drop(members);
                let _ = tools.family.requests.send(FamilyRequest::Retired {
                    thread: input.thread_store.level_id().to_owned(),
                    instance: instance.clone(),
                });
            }
        })
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OperationSelection {
    pub generation: String,
    // Omitted slots preserve opening defaults; an explicit empty list clears JS tools.
    pub slots: Option<Vec<usize>>,
    // Names select across all native families; slots remain the legacy JS ceiling.
    pub names: Option<Vec<ToolName>>,
    pub before_step: bool,
    #[serde(default)]
    pub prepare_request: bool,
}
#[derive(Clone)]
struct ActiveSelection {
    turn: String,
    generation: Arc<Generation>,
    slots: Option<Vec<usize>>,
    names: Option<Vec<ToolName>>,
    before_step: bool,
    prepare_request: bool,
}
struct PendingStep {
    turn: String,
    generation: u64,
    allowed: Vec<ToolName>,
    reply: oneshot::Sender<Option<Vec<ToolName>>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StepReply {
    pub(crate) thread: String,
    pub(crate) instance: Option<String>,
    turn_id: String,
    generation: String,
    request_id: String,
    slots: Option<Vec<usize>>,
    names: Option<Vec<ToolName>>,
}
struct StepCatalog {
    generation: Arc<Generation>,
    use_deferred_specs: bool,
    slots: Vec<usize>,
}
fn validate_selection(slots: &[usize], allowed: &[usize]) -> Result<()> {
    let mut seen = HashSet::new();
    ensure!(
        slots
            .iter()
            .all(|slot| allowed.contains(slot) && seen.insert(*slot)),
        "Duplicate or unadmitted JavaScript tool slot"
    );
    Ok(())
}
// Compare the default namespace canonically, including legacy unqualified refs.
fn validate_names(names: &[ToolName], allowed: &[ToolName]) -> Result<()> {
    let allowed = allowed
        .iter()
        .cloned()
        .map(ToolName::with_default_namespace)
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    ensure!(
        names
            .iter()
            .cloned()
            .map(ToolName::with_default_namespace)
            .all(|name| allowed.contains(&name) && seen.insert(name)),
        "Duplicate or unadmitted step tool name"
    );
    Ok(())
}

// Helpers expose selected leaves without granting any additional leaf runtime.
// Only retain helpers present in Core's candidates (or the pending step ceiling).
fn expand_step_helpers(mut names: Vec<ToolName>, allowed: &[ToolName]) -> Vec<ToolName> {
    if names.is_empty() {
        return names;
    }
    // Match Python's CodeMode rule: execution wrappers alone need no sibling
    // wrapper. Any other selected identity can use the admitted exec/wait pair.
    let needs_code_mode = names
        .iter()
        .any(|name| !name.is_default_namespace() || !matches!(name.name.as_str(), "exec" | "wait"));
    let mut seen = names
        .iter()
        .cloned()
        .map(ToolName::with_default_namespace)
        .collect::<HashSet<_>>();
    for helper in ["exec", "wait", "tool_search"] {
        if (helper == "tool_search" || needs_code_mode)
            && let Some(candidate) = allowed
                .iter()
                .find(|candidate| candidate.is_default_namespace() && candidate.name == helper)
            && seen.insert(candidate.clone().with_default_namespace())
        {
            names.push(candidate.clone());
        }
    }
    names
}

// Core retains the executable plan in its step store. This guard only owns the
// callback nonce, so cancelling a sampling step cannot leave a live JS receipt.
struct StepWait {
    tools: Arc<PythonTools>,
    id: u64,
}
impl Drop for StepWait {
    fn drop(&mut self) {
        self.tools
            .step_replies
            .lock()
            .expect("JavaScript step replies poisoned")
            .remove(&self.id);
    }
}

impl PythonTools {
    fn retire_selection(&self, turn: &str) {
        self.retire_preparation(Some(turn));
        let mut active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        if active
            .as_ref()
            .is_some_and(|selection| selection.turn == turn)
        {
            *active = None;
        }
        self.step_replies
            .lock()
            .expect("JavaScript step replies poisoned")
            .retain(|_, pending| pending.turn != turn);
    }

    pub(crate) fn continuation_selection(&self, previous: &str) -> Option<OperationSelection> {
        self.selection
            .lock()
            .expect("JavaScript selection poisoned")
            .as_ref()
            .filter(|selection| selection.turn == previous)
            .map(|selection| OperationSelection {
                generation: selection.generation.id.to_string(),
                slots: selection.slots.clone(),
                names: selection.names.clone(),
                before_step: selection.before_step,
                prepare_request: selection.prepare_request,
            })
    }

    pub(crate) fn validate_operation(&self, selection: &OperationSelection) -> Result<()> {
        ensure!(self.instance.is_none(), "Selection requires a root Session");
        let generation = self.snapshot();
        ensure!(
            selection.generation == generation.id.to_string(),
            "Expired selection generation"
        );
        ensure!(
            selection.names.is_none() || selection.slots.as_ref().is_none_or(Vec::is_empty),
            "Selection cannot combine slots and names"
        );
        if let Some(names) = &selection.names {
            // The complete native ceiling is available only in Core's async hook.
            validate_names(names, names)?;
        }
        if let Some(slots) = &selection.slots {
            validate_selection(slots, &(0..generation.entries.len()).collect::<Vec<_>>())?;
        }
        Ok(())
    }

    fn step_matches(
        &self,
        owner: &str,
        response: &StepReply,
        active: Option<&ActiveSelection>,
        pending: &PendingStep,
    ) -> bool {
        response.thread == owner
            && response.instance == self.instance
            && response.turn_id == pending.turn
            && response.generation == pending.generation.to_string()
            && self.snapshot().id == pending.generation
            && !pending.reply.is_closed()
            && active.is_some_and(|active| {
                active.turn == pending.turn && active.generation.id == pending.generation
            })
    }

    pub(crate) fn check_step(&self, owner: &str, response: &StepReply) -> Result<bool> {
        let id = response.request_id.parse::<u64>()?;
        let active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        let replies = self
            .step_replies
            .lock()
            .expect("JavaScript step replies poisoned");
        Ok(replies
            .get(&id)
            .is_some_and(|pending| self.step_matches(owner, response, active.as_ref(), pending)))
    }

    pub(crate) fn reply_child_step(&self, owner: &str, response: StepReply) -> Result<bool> {
        ensure!(
            self.instance.is_some(),
            "Child step reply requires a native child"
        );
        let id = response.request_id.parse::<u64>()?;
        let pending = {
            let active = self
                .selection
                .lock()
                .expect("JavaScript selection poisoned");
            let mut replies = self
                .step_replies
                .lock()
                .expect("JavaScript step replies poisoned");
            if !replies.get(&id).is_some_and(|pending| {
                self.step_matches(owner, &response, active.as_ref(), pending)
            }) {
                return Ok(false);
            }
            replies.remove(&id).expect("checked step reply")
        };
        self.finish_step_reply(response, pending)
    }

    fn turn_selection(
        &self,
        turn: &str,
        operation: Option<&OperationSelection>,
    ) -> Option<ActiveSelection> {
        if self.instance.is_some() {
            return self.child_before_step.then(|| ActiveSelection {
                turn: turn.to_owned(),
                generation: self.snapshot(),
                slots: None,
                names: None,
                before_step: true,
                prepare_request: false,
            });
        }
        operation.map(|selection| ActiveSelection {
            turn: turn.to_owned(),
            generation: self.snapshot(),
            slots: selection.slots.clone(),
            names: selection.names.clone(),
            before_step: selection.before_step,
            prepare_request: selection.prepare_request,
        })
    }

    pub(crate) fn reply_step(&self, owner: &str, response: StepReply) -> Result<()> {
        let id = response.request_id.parse::<u64>()?;
        let pending = self
            .step_replies
            .lock()
            .expect("JavaScript step replies poisoned")
            .remove(&id)
            .ok_or_else(|| anyhow::anyhow!("Expired step selection"))?;
        // Taking the sender consumes this receipt even when validation fails.
        ensure!(
            response.thread == owner
                && response.instance == self.instance
                && response.turn_id == pending.turn
                && response.generation == pending.generation.to_string()
                && self.snapshot().id == pending.generation,
            "Expired step selection owner or generation"
        );
        ensure!(
            self.finish_step_reply(response, pending)?,
            "Expired step selection"
        );
        Ok(())
    }

    fn finish_step_reply(&self, response: StepReply, pending: PendingStep) -> Result<bool> {
        ensure!(
            response.slots.is_none() || response.names.is_none(),
            "Step reply cannot combine slots and names"
        );
        let names = if let Some(slots) = response.slots {
            let generation = self.snapshot();
            validate_selection(&slots, &(0..generation.entries.len()).collect::<Vec<_>>())?;
            Some(
                slots
                    .into_iter()
                    .map(|slot| generation.entries[slot].name.clone())
                    .collect(),
            )
        } else {
            response.names
        };
        if let Some(names) = &names {
            validate_names(names, &pending.allowed)?;
        }
        let names = names.map(|names| expand_step_helpers(names, &pending.allowed));
        Ok(pending.reply.send(names).is_ok())
    }
}

impl ContextContributor for PythonContributor {
    fn contribute_world_state<'a>(
        &'a self,
        _input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move { Vec::new() })
    }
}

impl PythonContributor {
    fn executors(
        &self,
        thread: &ExtensionData,
        tools: Arc<PythonTools>,
        generation: Arc<Generation>,
        use_deferred_specs: bool,
        slots: &[usize],
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        slots
            .iter()
            .copied()
            .map(|slot| {
                Arc::new(PythonExecutor {
                    thread: thread.level_id().to_string(),
                    tools: tools.clone(),
                    generation: generation.clone(),
                    slot,
                    use_deferred_specs,
                    code_mode_enabled: self.code_mode_enabled,
                }) as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>
            })
            .collect()
    }
}

impl ToolContributor for PythonContributor {
    fn tools(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Some(tools) = thread.get::<PythonTools>() else {
            return Vec::new();
        };
        let generation = tools.snapshot();
        let use_deferred_specs = thread
            .get::<ModelPresentation>()
            .is_some_and(|presentation| presentation.use_deferred_specs);
        self.executors(
            thread,
            tools,
            generation.clone(),
            use_deferred_specs,
            &generation.defaults,
        )
    }

    fn tools_for_step(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
        step: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Some(tools) = thread.get::<PythonTools>() else {
            return Vec::new();
        };
        let snapshot = step.get_or_init(|| {
            let active = tools
                .selection
                .lock()
                .expect("JavaScript selection poisoned")
                .clone();
            let generation = active
                .as_ref()
                .map(|active| active.generation.clone())
                .unwrap_or_else(|| tools.snapshot());
            let slots = match active {
                // Register the stable executors before Core assembles candidates.
                // Core's selected plan narrows every family after the async hook.
                Some(active) if active.names.is_some() => (0..generation.entries.len()).collect(),
                Some(active) => active.slots.unwrap_or_else(|| generation.defaults.clone()),
                None => generation.defaults.clone(),
            };
            StepCatalog {
                generation,
                slots,
                use_deferred_specs: thread
                    .get::<ModelPresentation>()
                    .is_some_and(|presentation| presentation.use_deferred_specs),
            }
        });
        self.executors(
            thread,
            tools,
            snapshot.generation.clone(),
            snapshot.use_deferred_specs,
            &snapshot.slots,
        )
    }

    fn select_tools_for_step<'a>(
        &'a self,
        _: &'a ExtensionData,
        thread: &'a ExtensionData,
        turn: &'a ExtensionData,
        step: &'a ExtensionData,
        candidates: &'a [ToolName],
    ) -> ExtensionFuture<'a, std::result::Result<Option<Vec<ToolName>>, String>> {
        Box::pin(async move {
            let Some(tools) = thread.get::<PythonTools>() else {
                return Ok(None);
            };
            let active = tools
                .selection
                .lock()
                .expect("JavaScript selection poisoned")
                .clone();
            let Some(active) = active else {
                return Ok(None);
            };
            if active.turn != turn.level_id() || tools.snapshot().id != active.generation.id {
                return Err("Expired step selection owner or generation".into());
            }
            let catalog = step.get::<StepCatalog>().ok_or("Missing step catalog")?;
            if !Arc::ptr_eq(&catalog.generation, &active.generation) {
                return Err("Expired step catalog generation".into());
            }
            let allowed = if let Some(names) = &active.names {
                validate_names(names, candidates).map_err(|error| error.to_string())?;
                expand_step_helpers(names.clone(), candidates)
            } else {
                // Legacy slots narrow managed tools; other admitted families keep
                // their opening policy. Native-aware callers use explicit names.
                candidates.to_vec()
            };
            if !active.before_step {
                return Ok(Some(allowed));
            }
            let id = tools.family.next_step.fetch_add(1, Ordering::Relaxed);
            let (reply, receive) = oneshot::channel();
            {
                // Retirement uses this same lock order. Install the nonce only
                // while its original root still owns the active selection.
                let current = tools
                    .selection
                    .lock()
                    .expect("JavaScript selection poisoned");
                if !current.as_ref().is_some_and(|current| {
                    current.turn == active.turn
                        && Arc::ptr_eq(&current.generation, &active.generation)
                }) {
                    return Err("Expired step selection owner".into());
                }
                tools
                    .step_replies
                    .lock()
                    .expect("JavaScript step replies poisoned")
                    .insert(
                        id,
                        PendingStep {
                            turn: active.turn.clone(),
                            generation: active.generation.id,
                            allowed: allowed.clone(),
                            reply,
                        },
                    );
            }
            let _wait = StepWait {
                tools: tools.clone(),
                id,
            };
            let tracing = if tools.instance.is_some() {
                turn.get::<codex_otel::sdk_trace::CapturedContext>()
                    .and_then(|captured| captured.context.clone())
            } else {
                codex_otel::sdk_trace::ContextLease::capture().map(Arc::new)
            };
            let mut request = json!({"id": active.turn, "msg": {
                "type": "_sdk_select_step", "turn_id": turn.level_id(),
                "thread": thread.level_id(), "native_step": step.level_id(),
                "request_id": id.to_string(), "generation": active.generation.id.to_string(),
                "candidates": allowed
            }});
            if let Some(context) = &tracing {
                request["msg"]["tracing_context"] = json!(context.token());
            }
            if let Some(instance) = &tools.instance {
                request["subagent_id"] = json!(thread.level_id());
                request["subagent_incarnation"] = json!(instance);
                request["subagent_managed_tools"] = json!(true);
            }
            tools
                .family
                .requests
                .send(FamilyRequest::Step(Arc::downgrade(&tools), id, request))
                .map_err(|_| "Step reader closed")?;
            let names = receive
                .await
                .map_err(|_| "Step selection cancelled")?
                .ok_or("Step selection failed")?;
            let current = tools
                .selection
                .lock()
                .expect("JavaScript selection poisoned");
            if tools.snapshot().id != active.generation.id
                || !current.as_ref().is_some_and(|current| {
                    current.turn == active.turn
                        && Arc::ptr_eq(&current.generation, &active.generation)
                })
            {
                return Err("Expired step selection owner or generation".into());
            }
            Ok(Some(names))
        })
    }
}

struct PythonExecutor {
    thread: String,
    tools: Arc<PythonTools>,
    generation: Arc<Generation>,
    slot: usize,
    use_deferred_specs: bool,
    code_mode_enabled: bool,
}

impl<'call> ToolExecutor<ToolCall<'call>> for PythonExecutor {
    fn tool_name(&self) -> ToolName {
        self.generation.entries[self.slot].name.clone()
    }

    fn spec(&self) -> ToolSpec {
        self.generation.entries[self.slot].spec.clone()
    }

    fn exposure(&self) -> ToolExposure {
        match (
            self.generation.entries[self.slot].exposure,
            self.use_deferred_specs,
            self.code_mode_enabled,
        ) {
            (ToolExposure::Deferred, true, false) => ToolExposure::DeferredModelOnly,
            (ToolExposure::Deferred, false, false) => ToolExposure::DirectModelOnly,
            (ToolExposure::Deferred, false, true) => ToolExposure::Direct,
            (exposure, _, _) => exposure,
        }
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        // Core admits each callback independently. A waiting callback must not
        // prevent an automatic or manual sibling from producing its result.
        true
    }

    fn search_info(&self) -> Option<ToolSearchInfo> {
        let info = ToolSearchInfo::from_tool_spec(
            self.spec(),
            Some(ToolSearchSourceInfo {
                name: "Dynamic tools".to_string(),
                description: Some("Tools provided by the current Codex thread.".to_string()),
            }),
        );
        if info.is_some() && self.exposure().is_deferred() {
            // Core caches this schema without retaining the executor. History may
            // keep it even when the turn ends before another provider request.
            self.tools
                .schema_receipts
                .retain_search_schema(&self.generation);
        }
        info
    }

    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        ToolCall<'call>: 'a,
    {
        Box::pin(async move {
            let arguments: Value = serde_json::from_str(call.function_arguments()?)
                .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
            if let Some(store) = &self.tools.local_store {
                let id = codex_protocol::ThreadId::from_string(&self.thread)
                    .map_err(|_| FunctionCallError::Fatal("invalid local tool thread".into()))?;
                store
                    .register_call(id, &call.turn_id, &call.call_id)
                    .await
                    .map_err(|error| FunctionCallError::Fatal(error.to_string()))?;
            }
            if let Some(store) = &self.tools.custom_store {
                let id = codex_protocol::ThreadId::from_string(&self.thread)
                    .map_err(|_| FunctionCallError::Fatal("invalid canonical thread".into()))?;
                store
                    .register_call(id, &call.turn_id, &call.call_id)
                    .await
                    .map_err(|e| FunctionCallError::Fatal(e.to_string()))?;
            }
            let (key, receiver) = self
                .tools
                .enqueue(
                    &self.thread,
                    &self.generation,
                    self.slot,
                    &call.turn_id,
                    &call.call_id,
                    arguments,
                    &call.source,
                    &call.model,
                )
                .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
            let _reply = PendingReply {
                tools: &self.tools,
                key: key.clone(),
            };
            let response = match receiver.await {
                Ok(response) => response,
                Err(_) if self.tools.local_store.is_some() || self.tools.custom_store.is_some() => {
                    // No real receipt can certify the external effect. Keep
                    // this call unresolved until Core cancels its owned future;
                    // returning a synthetic result would allow another sample.
                    std::future::pending().await
                }
                Err(_) => {
                    return Err(FunctionCallError::RespondToModel(
                        "JavaScript tool call cancelled before reply".into(),
                    ));
                }
            };
            Ok(Box::new(PythonOutput(response)) as Box<dyn ToolOutput>)
        })
    }
}

pub(crate) struct PythonOutput(pub(crate) DynamicToolResponse);

impl ToolLifecycleContributor for PythonContributor {
    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if input.source == ToolCallSource::Direct
                && let Some(tools) = input.thread_store.get::<PythonTools>()
            {
                // Record settlement so failed/aborted siblings cannot leave a
                // save waiting forever. Only Completed certifies a result.
                // Stored native results are sole authority for its body.
                tools.record_native_manual_completion(input);
            }
        })
    }
}

impl TurnLifecycleContributor for PythonContributor {
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(tools) = input.thread_store.get::<PythonTools>() {
                let deferred = tools
                    .snapshot()
                    .entries
                    .iter()
                    .any(|entry| entry.exposure == ToolExposure::Deferred);
                let use_deferred_specs = if deferred && let Some(manager) = self.manager.upgrade() {
                    let model = manager
                        .get_models_manager()
                        .get_model_info(input.collaboration_mode.model(), &self.models_config)
                        .await;
                    model.supports_search_tool
                        && (self.code_mode_enabled
                            || model.tool_mode != Some(ToolMode::CodeModeOnly))
                } else {
                    false
                };
                input
                    .thread_store
                    .insert(ModelPresentation { use_deferred_specs });
                let operation = input.turn_store.get::<Option<OperationSelection>>();
                let selection = tools
                    .turn_selection(input.turn_id, operation.as_deref().and_then(Option::as_ref));
                *tools
                    .selection
                    .lock()
                    .expect("JavaScript selection poisoned") = selection;
                tools.begin_preparation(&input);
                tools.begin_native_manual_turn(input);
            }
        })
    }
    fn on_turn_abort<'a>(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(tools) = input.thread_store.get::<PythonTools>() {
                tools.retire_selection(input.turn_store.level_id());
            }
        })
    }
    fn on_turn_stop<'a>(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(tools) = input.thread_store.get::<PythonTools>() {
                tools
                    .step_replies
                    .lock()
                    .expect("JavaScript step replies poisoned")
                    .retain(|_, pending| pending.turn != input.turn_store.level_id());
                tools.retire_preparation(Some(input.turn_store.level_id()));
                tools.stop_native_manual_turn(input);
            }
        })
    }
}

impl PythonOutput {
    pub(crate) fn receipt(&self, key: &PendingKey) -> ResponseItem {
        let mut item: ResponseItem = self
            .to_response_item(
                &key.call,
                &ToolPayload::Function {
                    arguments: String::new(),
                },
            )
            .into();
        if let ResponseItem::FunctionCallOutput {
            internal_chat_message_metadata_passthrough,
            ..
        } = &mut item
        {
            *internal_chat_message_metadata_passthrough = Some(
                codex_protocol::models::InternalChatMessageMetadataPassthrough {
                    turn_id: Some(key.turn.clone()),
                    ..Default::default()
                },
            );
        }
        item
    }
}

impl ToolOutput for PythonOutput {
    fn log_output(&self) -> String {
        FunctionCallOutputBody::ContentItems(
            self.0
                .content_items
                .iter()
                .cloned()
                .map(Into::into)
                .collect(),
        )
        .to_text()
        .unwrap_or_default()
    }

    fn success_for_logging(&self) -> bool {
        self.0.success
    }

    fn to_response_item(&self, call_id: &str, _: &ToolPayload) -> ResponseInputItem {
        let content: Vec<FunctionCallOutputContentItem> = self
            .0
            .content_items
            .iter()
            .cloned()
            .map(Into::into)
            .collect();
        let body = match content.as_slice() {
            [FunctionCallOutputContentItem::InputText { text }] => {
                FunctionCallOutputBody::Text(text.clone())
            }
            _ => FunctionCallOutputBody::ContentItems(content),
        };
        ResponseInputItem::FunctionCallOutput {
            call_id: call_id.to_string(),
            output: FunctionCallOutputPayload {
                body,
                success: Some(self.0.success),
            },
        }
    }
}

#[cfg(test)]
mod pending_tests {
    use super::*;

    // Exercise the actual registry and its lifetime owners without starting Core,
    // a runtime, a network service, or a native thread.
    pub(super) fn tools() -> Arc<PythonTools> {
        let tools = Arc::new(PythonTools {
            local_store: None,
            custom_store: None,
            preserve_schemas: false,
            schema_receipts: Default::default(),
            current: RwLock::new(Arc::new(Generation {
                id: 0,
                schema_token: None,
                entries: Vec::new(),
                specs: Vec::new(),
                defaults: Vec::new(),
            })),
            fixed: HashSet::new(),
            policy: Arc::default(),
            pending: Mutex::default(),
            family: Arc::default(),
            instance: None,
            inherit_children: true,
            child_before_step: false,
            manual: Mutex::default(),
            selection: Mutex::new(None),
            step_replies: Mutex::new(HashMap::new()),
            prepared: Mutex::new(None),
        });
        let specs = vec![DynamicToolSpec::Function(DynamicToolFunctionSpec {
            name: "decision".into(),
            description: "Choose.".into(),
            input_schema: json!({"type":"object","properties":{}}),
            defer_loading: false,
        })];
        *tools.current.write().unwrap() = Arc::new(tools.prepare(0, specs).unwrap());
        configure(&tools);
        tools
    }

    fn configure(tools: &PythonTools) {
        tools
            .configure_manual(serde_json::from_value(json!([{"name":"decision"}])).unwrap())
            .unwrap();
    }

    fn owner() -> ManualOwner {
        ManualOwner {
            thread: "root".into(),
            instance: None,
            turn: "turn".into(),
        }
    }

    #[test]
    fn equal_wire_ids_keep_distinct_live_grants_and_independent_senders() {
        let tools = tools();
        let generation = tools.snapshot();
        let (a, mut a_receiver) = tools
            .enqueue(
                "root",
                &generation,
                0,
                "turn",
                "same",
                json!({"value":"a"}),
                &ToolCallSource::Direct,
                "fixture-model",
            )
            .unwrap();
        let (b, _b_receiver) = tools
            .enqueue(
                "root",
                &generation,
                0,
                "turn",
                "same",
                json!({"value":"b"}),
                &ToolCallSource::Direct,
                "fixture-model",
            )
            .unwrap();
        assert_eq!(a.call, b.call);
        assert_ne!(a.reply.manual_grant, b.reply.manual_grant);
        let events = tools.pending_manual_tools(&owner());
        assert_eq!(events.len(), 2);
        for key in [&a, &b] {
            assert!(tools.manual_tool_current("root", key));
            assert!(events.iter().any(|event| event["msg"]["_sdk_python_tool"]
                == serde_json::to_value(&key.reply).unwrap()));
        }
        drop(tools.take_reply("root", &a).unwrap().unwrap());
        assert!(matches!(
            a_receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(!tools.manual_tool_current("root", &a));
        assert!(tools.manual_tool_current("root", &b));
        assert_eq!(
            tools.pending_manual_tools(&owner())[0]["msg"]["arguments"],
            json!({"value":"b"})
        );
        assert_eq!(tools.pending.lock().unwrap().len(), 1);
    }

    #[test]
    fn cancelled_reply_guard_removes_the_sender_and_snapshot_payload() {
        let tools = tools();
        let (key, receiver) = tools
            .enqueue(
                "root",
                &tools.snapshot(),
                0,
                "turn",
                "call",
                json!({"value":"original"}),
                &ToolCallSource::Direct,
                "fixture-model",
            )
            .unwrap();
        let guard = PendingReply {
            tools: &tools,
            key: key.clone(),
        };
        assert_eq!(tools.pending_manual_tools(&owner()).len(), 1);
        drop(receiver);
        assert!(tools.pending_manual_tools(&owner()).is_empty());
        assert!(!tools.manual_tool_current("root", &key));
        drop(guard);
        assert!(tools.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn closed_family_enqueue_removes_its_unpublished_sender_and_payload() {
        let tools = tools();
        tools.family.receiver.try_lock().unwrap().close();
        let result = tools.enqueue(
            "root",
            &tools.snapshot(),
            0,
            "turn",
            "call",
            json!({"value":"never published"}),
            &ToolCallSource::Direct,
            "fixture-model",
        );
        assert!(result.is_err());
        assert!(tools.pending.lock().unwrap().is_empty());
        assert!(tools.pending_manual_tools(&owner()).is_empty());
    }

    #[test]
    fn replacement_generation_cannot_reuse_a_retired_snapshot_grant() {
        let tools = tools();
        let (old, mut receiver) = tools
            .enqueue(
                "root",
                &tools.snapshot(),
                0,
                "turn",
                "same",
                json!({"value":"old"}),
                &ToolCallSource::Direct,
                "fixture-model",
            )
            .unwrap();
        drop(PendingReply {
            tools: &tools,
            key: old.clone(),
        });
        assert!(matches!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(tools.pending.lock().unwrap().is_empty());
        let specs = tools.snapshot().specs.clone();
        tools.publish(tools.prepare(1, specs).unwrap()).unwrap();
        configure(&tools);
        let (new, _receiver) = tools
            .enqueue(
                "root",
                &tools.snapshot(),
                0,
                "turn",
                "same",
                json!({"value":"new"}),
                &ToolCallSource::Direct,
                "fixture-model",
            )
            .unwrap();
        assert!(!tools.manual_tool_current("root", &old));
        assert!(tools.manual_tool_current("root", &new));
        let events = tools.pending_manual_tools(&owner());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["msg"]["_sdk_python_tool"]["generation"], 1);
        assert_eq!(events[0]["msg"]["arguments"], json!({"value":"new"}));
    }

    #[test]
    fn replacement_child_owner_rejects_the_previous_incarnation_and_grant() {
        let root = tools();
        let old = Arc::new(PythonTools::descendant(&root, "old".into(), Arc::default()).unwrap());
        root.family
            .members
            .write()
            .unwrap()
            .insert("child".into(), Arc::downgrade(&old));
        let (old_key, _old_receiver) = old
            .enqueue(
                "child",
                &old.snapshot(),
                0,
                "turn",
                "same",
                json!({"value":"old"}),
                &ToolCallSource::Direct,
                "fixture-model",
            )
            .unwrap();
        assert!(root.owner("root", &old_key).is_some());
        let new = Arc::new(PythonTools::descendant(&root, "new".into(), Arc::default()).unwrap());
        root.family
            .members
            .write()
            .unwrap()
            .insert("child".into(), Arc::downgrade(&new));
        let (new_key, _new_receiver) = new
            .enqueue(
                "child",
                &new.snapshot(),
                0,
                "turn",
                "same",
                json!({"value":"new"}),
                &ToolCallSource::Direct,
                "fixture-model",
            )
            .unwrap();
        // Keep the old Arc and receiver alive: family selection, not memory
        // reclamation or a closed channel, must exclude the old incarnation.
        assert!(root.owner("root", &old_key).is_none());
        assert!(!new.manual_tool_current("child", &old_key));
        assert!(
            new.pending_manual_tools(&ManualOwner {
                thread: "child".into(),
                instance: Some("old".into()),
                turn: "turn".into(),
            })
            .is_empty()
        );
        let selected = root.owner("root", &new_key).unwrap();
        let events = selected.pending_manual_tools(&ManualOwner {
            thread: "child".into(),
            instance: Some("new".into()),
            turn: "turn".into(),
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["msg"]["arguments"], json!({"value":"new"}));
    }

    fn step_reply(turn: &str, generation: &str, slots: Option<Vec<usize>>) -> StepReply {
        StepReply {
            thread: "root".into(),
            instance: None,
            turn_id: turn.into(),
            generation: generation.into(),
            request_id: "7".into(),
            slots,
            names: None,
        }
    }

    fn pending_step(tools: &PythonTools) -> oneshot::Receiver<Option<Vec<ToolName>>> {
        let (reply, receive) = oneshot::channel();
        tools.step_replies.lock().unwrap().insert(
            7,
            PendingStep {
                turn: "turn".into(),
                generation: 0,
                allowed: vec![tools.snapshot().entries[0].name.clone()],
                reply,
            },
        );
        receive
    }

    fn selector_fixture(names: Option<Vec<ToolName>>) -> (ExtensionData, Arc<PythonTools>) {
        let thread = ExtensionData::new("root");
        let tools = thread.get_or_init(|| match Arc::try_unwrap(tools()) {
            Ok(tools) => tools,
            Err(_) => panic!("unexpected fixture owner"),
        });
        *tools.selection.lock().unwrap() = Some(ActiveSelection {
            turn: "turn".into(),
            generation: tools.snapshot(),
            slots: None,
            names,
            before_step: true,
            prepare_request: false,
        });
        (thread, tools)
    }

    fn child_selector_fixture() -> (Arc<PythonTools>, ExtensionData, Arc<PythonTools>) {
        let mut root = tools();
        Arc::get_mut(&mut root).unwrap().child_before_step = true;
        let thread = ExtensionData::new("child");
        let child = thread.get_or_init(|| {
            PythonTools::descendant(&root, "incarnation".into(), Arc::default()).unwrap()
        });
        root.family
            .members
            .write()
            .unwrap()
            .insert("child".into(), Arc::downgrade(&child));
        let root_operation = OperationSelection {
            generation: "0".into(),
            slots: Some(Vec::new()),
            names: None,
            before_step: false,
            prepare_request: false,
        };
        *child.selection.lock().unwrap() =
            child.turn_selection("child-turn", Some(&root_operation));
        (root, thread, child)
    }

    #[test]
    fn child_selection_preserves_own_defaults_and_ignores_root_operation() {
        let (root, thread, child) = child_selector_fixture();
        let active = child.selection.lock().unwrap().clone().unwrap();
        assert_eq!(active.turn, "child-turn");
        assert!(active.before_step);
        assert!(active.slots.is_none());
        assert!(active.names.is_none());
        assert!(Arc::ptr_eq(&active.generation, &child.snapshot()));
        let contributor = PythonContributor::default();
        let executors = contributor.tools_for_step(
            &ExtensionData::new("session"),
            &thread,
            &ExtensionData::new("step"),
        );
        assert_eq!(executors.len(), 1);
        assert_eq!(executors[0].tool_name(), ToolName::plain("decision"));
        let disabled =
            PythonTools::descendant(&tools(), "disabled".into(), Arc::default()).unwrap();
        assert!(disabled.turn_selection("turn", None).is_none());
        assert!(root.selection.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn child_step_admission_and_reply_keep_exact_incarnation_and_original_turn() {
        let (root, thread, child) = child_selector_fixture();
        let contributor = PythonContributor::default();
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("child-turn");
        let step = ExtensionData::new("child-step");
        let candidates = vec![ToolName::plain("decision")];
        contributor.tools_for_step(&session, &thread, &step);
        let mut selecting =
            contributor.select_tools_for_step(&session, &thread, &turn, &step, &candidates);
        assert!(futures_util::poll!(&mut selecting).is_pending());
        let event = root.next_request().await;
        assert_eq!(event["id"], "child-turn");
        assert_eq!(event["subagent_id"], "child");
        assert_eq!(event["subagent_incarnation"], "incarnation");
        assert_eq!(event["msg"]["turn_id"], "child-turn");
        let mut response = StepReply {
            thread: "child".into(),
            instance: Some("old".into()),
            turn_id: "child-turn".into(),
            generation: "0".into(),
            request_id: event["msg"]["request_id"].as_str().unwrap().into(),
            slots: None,
            names: Some(Vec::new()),
        };
        assert!(
            root.exact_owner("root", &response.thread, &response.instance)
                .is_none()
        );
        assert!(!child.check_step("child", &response).unwrap());
        assert!(!child.reply_child_step("child", response).unwrap());
        response = serde_json::from_value(json!({
            "thread":"child", "instance":"incarnation", "turn_id":"child-turn",
            "generation":"0", "request_id":event["msg"]["request_id"], "names":[]
        }))
        .unwrap();
        assert!(child.check_step("child", &response).unwrap());
        assert!(child.check_step("child", &response).unwrap());
        let owner = root
            .exact_owner("root", &response.thread, &response.instance)
            .unwrap();
        assert!(owner.reply_child_step("child", response).unwrap());
        assert_eq!(selecting.await.unwrap(), Some(Vec::new()));
        assert!(child.step_replies.lock().unwrap().is_empty());
    }

    #[test]
    fn expired_child_reply_is_quiet_but_invalid_selection_fails() {
        let (_root, _thread, child) = child_selector_fixture();
        let (reply, mut receive) = oneshot::channel();
        child.step_replies.lock().unwrap().insert(
            7,
            PendingStep {
                turn: "child-turn".into(),
                generation: 0,
                allowed: vec![ToolName::plain("decision")],
                reply,
            },
        );
        let mut response = StepReply {
            thread: "child".into(),
            instance: Some("incarnation".into()),
            turn_id: "child-turn".into(),
            generation: "0".into(),
            request_id: "expired".into(),
            slots: None,
            names: None,
        };
        assert!(child.check_step("child", &response).is_err());
        response.request_id = "8".into();
        assert!(!child.reply_child_step("child", response).unwrap());
        response = serde_json::from_value(json!({
            "thread":"child", "instance":"incarnation", "turn_id":"child-turn",
            "generation":"0", "request_id":"7", "names":[{"name":"outside"}]
        }))
        .unwrap();
        assert!(child.reply_child_step("child", response).is_err());
        assert!(matches!(
            receive.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(child.step_replies.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replaced_child_cannot_publish_a_queued_step_or_enter_after_dequeue() {
        let (root, thread, child) = child_selector_fixture();
        let contributor = PythonContributor::default();
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("child-turn");
        let step = ExtensionData::new("child-step");
        let candidates = vec![ToolName::plain("decision")];
        contributor.tools_for_step(&session, &thread, &step);
        let mut selecting =
            contributor.select_tools_for_step(&session, &thread, &turn, &step, &candidates);
        assert!(futures_util::poll!(&mut selecting).is_pending());
        let successor =
            Arc::new(PythonTools::descendant(&root, "successor".into(), Arc::default()).unwrap());
        root.family
            .members
            .write()
            .unwrap()
            .insert("child".into(), Arc::downgrade(&successor));
        let _root_receive = pending_step(&root);
        root.family
            .requests
            .send(FamilyRequest::Step(
                Arc::downgrade(&root),
                7,
                json!({"id":"root-successor"}),
            ))
            .unwrap();
        assert_eq!(root.next_request().await, json!({"id":"root-successor"}));
        let response = StepReply {
            thread: "child".into(),
            instance: Some("incarnation".into()),
            turn_id: "child-turn".into(),
            generation: "0".into(),
            request_id: "1".into(),
            slots: None,
            names: None,
        };
        assert!(
            root.exact_owner("root", &response.thread, &response.instance)
                .is_none()
        );
        assert!(child.check_step("child", &response).unwrap());
        child.retire_selection("child-turn");
        assert!(!child.check_step("child", &response).unwrap());
        assert!(!child.reply_child_step("child", response).unwrap());
        drop(selecting);
        assert!(child.step_replies.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn async_selector_yields_until_reply_and_preserves_native_names_and_empty_plan() {
        let candidates = vec![
            ToolName::plain("decision"),
            ToolName::plain("exec_command"),
            ToolName::namespaced("mcp", "lookup"),
            ToolName::plain("web_search"),
            ToolName::plain("exec"),
            ToolName::plain("wait"),
            ToolName::plain("tool_search"),
        ];
        let (thread, tools) = selector_fixture(Some(candidates.clone()));
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("turn");
        let contributor = PythonContributor::default();
        for selected in [vec![ToolName::namespaced("mcp", "lookup")], Vec::new()] {
            // A step ID is deliberately distinct from its issuing root turn.
            let step = ExtensionData::new("sampling-step");
            let executors = contributor.tools_for_step(&session, &thread, &step);
            assert_eq!(executors.len(), 1);
            let mut selection =
                contributor.select_tools_for_step(&session, &thread, &turn, &step, &candidates);
            assert!(futures_util::poll!(&mut selection).is_pending());
            let event = tools.next_request().await;
            assert_eq!(event["msg"]["turn_id"], "turn");
            assert_eq!(event["msg"]["thread"], "root");
            assert_eq!(event["msg"]["native_step"], "sampling-step");
            assert_eq!(event["msg"]["candidates"], json!(candidates));
            tools
                .reply_step(
                    "root",
                    StepReply {
                        request_id: event["msg"]["request_id"].as_str().unwrap().into(),
                        names: Some(selected.clone()),
                        ..step_reply("turn", "0", None)
                    },
                )
                .unwrap();
            let expected = if selected.is_empty() {
                Vec::new()
            } else {
                vec![
                    ToolName::namespaced("mcp", "lookup"),
                    ToolName::plain("exec"),
                    ToolName::plain("wait"),
                    ToolName::plain("tool_search"),
                ]
            };
            assert_eq!(selection.await.unwrap(), Some(expected));
            assert!(tools.step_replies.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn cancelled_async_selector_retires_nonce_before_a_late_reply() {
        let candidates = vec![ToolName::plain("exec_command")];
        let (thread, tools) = selector_fixture(Some(candidates.clone()));
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("turn");
        let step = ExtensionData::new("step");
        let contributor = PythonContributor::default();
        contributor.tools_for_step(&session, &thread, &step);
        let mut selection =
            contributor.select_tools_for_step(&session, &thread, &turn, &step, &candidates);
        assert!(futures_util::poll!(&mut selection).is_pending());
        let event = tools.next_request().await;
        drop(selection);
        assert!(tools.step_replies.lock().unwrap().is_empty());
        assert!(
            tools
                .reply_step(
                    "root",
                    StepReply {
                        request_id: event["msg"]["request_id"].as_str().unwrap().into(),
                        names: Some(candidates),
                        ..step_reply("turn", "0", None)
                    }
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn selector_rejects_unknown_operation_names_and_superseded_root_after_reply() {
        let candidates = vec![ToolName::plain("exec_command")];
        let (thread, tools) = selector_fixture(Some(vec![ToolName::plain("outside")]));
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("turn");
        let step = ExtensionData::new("step");
        let contributor = PythonContributor::default();
        contributor.tools_for_step(&session, &thread, &step);
        assert!(
            contributor
                .select_tools_for_step(&session, &thread, &turn, &step, &candidates)
                .await
                .is_err()
        );
        assert!(tools.step_replies.lock().unwrap().is_empty());
        tools.selection.lock().unwrap().as_mut().unwrap().names = Some(candidates.clone());
        let mut selection =
            contributor.select_tools_for_step(&session, &thread, &turn, &step, &candidates);
        assert!(futures_util::poll!(&mut selection).is_pending());
        let event = tools.next_request().await;
        tools
            .reply_step(
                "root",
                StepReply {
                    request_id: event["msg"]["request_id"].as_str().unwrap().into(),
                    names: Some(candidates.clone()),
                    ..step_reply("turn", "0", None)
                },
            )
            .unwrap();
        tools.selection.lock().unwrap().as_mut().unwrap().turn = "successor".into();
        assert!(selection.await.is_err());
    }

    #[test]
    fn step_catalog_keeps_its_original_executors_when_successor_changes_slots() {
        let (thread, tools) = selector_fixture(Some(vec![ToolName::plain("decision")]));
        let session = ExtensionData::new("session");
        let original = ExtensionData::new("original-step");
        let contributor = PythonContributor::default();
        let executors = contributor.tools_for_step(&session, &thread, &original);
        assert_eq!(executors[0].tool_name(), ToolName::plain("decision"));
        *tools.selection.lock().unwrap() = Some(ActiveSelection {
            turn: "successor".into(),
            generation: tools.snapshot(),
            slots: Some(Vec::new()),
            names: None,
            before_step: false,
            prepare_request: false,
        });
        let successor = ExtensionData::new("successor-step");
        assert!(
            contributor
                .tools_for_step(&session, &thread, &successor)
                .is_empty()
        );
        let retained = contributor.tools_for_step(&session, &thread, &original);
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].tool_name(), executors[0].tool_name());
    }

    #[test]
    fn named_reply_rejects_namespace_widening_alias_duplicates_and_mixed_modes() {
        let tools = tools();
        for names in [
            vec![ToolName::namespaced("foreign", "decision")],
            vec![
                ToolName::plain("decision"),
                ToolName::namespaced("functions", "decision"),
            ],
        ] {
            let mut receive = pending_step(&tools);
            assert!(
                tools
                    .reply_step(
                        "root",
                        StepReply {
                            names: Some(names),
                            ..step_reply("turn", "0", None)
                        }
                    )
                    .is_err()
            );
            assert!(matches!(
                receive.try_recv(),
                Err(oneshot::error::TryRecvError::Closed)
            ));
        }
        let mut receive = pending_step(&tools);
        assert!(
            tools
                .reply_step(
                    "root",
                    StepReply {
                        names: Some(Vec::new()),
                        ..step_reply("turn", "0", Some(Vec::new()))
                    }
                )
                .is_err()
        );
        assert!(matches!(
            receive.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        let mut receive = pending_step(&tools);
        tools
            .reply_step(
                "root",
                StepReply {
                    names: Some(vec![ToolName::namespaced("functions", "decision")]),
                    ..step_reply("turn", "0", None)
                },
            )
            .unwrap();
        assert_eq!(
            receive.try_recv().unwrap().unwrap()[0],
            ToolName::namespaced("functions", "decision")
        );
    }

    #[tokio::test]
    async fn before_step_wire_preserves_defaults_distinct_from_explicit_empty_slots_and_names() {
        let (thread, tools) = selector_fixture(None);
        // A registered but non-default tool must not leak into an omitted roster.
        let mut specs = tools.snapshot().specs.clone();
        specs.push(DynamicToolSpec::Function(DynamicToolFunctionSpec {
            name: "hidden".into(),
            description: "Optional tool.".into(),
            input_schema: json!({"type":"object","properties":{}}),
            defer_loading: false,
        }));
        let mut generation = tools.prepare(0, specs).unwrap();
        generation.defaults = vec![0];
        *tools.current.write().unwrap() = Arc::new(generation);
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("turn");
        let contributor = PythonContributor::default();
        for (fields, expected_slots, expected_executors, expected_names) in [
            (json!({}), None, 1, vec!["decision", "exec_command"]),
            (
                json!({"names":null}),
                None,
                1,
                vec!["decision", "exec_command"],
            ),
            (
                json!({"names":null,"slots":null}),
                None,
                1,
                vec!["decision", "exec_command"],
            ),
            (
                json!({"slots":[]}),
                Some(Vec::new()),
                0,
                vec!["exec_command"],
            ),
            (
                json!({"slots":[0]}),
                Some(vec![0]),
                1,
                vec!["decision", "exec_command"],
            ),
            (json!({"names":[]}), None, 2, Vec::new()),
        ] {
            let mut wire = json!({"generation":"0","before_step":true});
            wire.as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            let operation: OperationSelection = serde_json::from_value(wire).unwrap();
            tools.validate_operation(&operation).unwrap();
            *tools.selection.lock().unwrap() = Some(ActiveSelection {
                turn: "turn".into(),
                generation: tools.snapshot(),
                slots: operation.slots,
                names: operation.names,
                before_step: operation.before_step,
                prepare_request: operation.prepare_request,
            });
            let continued = tools.continuation_selection("turn").unwrap();
            assert_eq!(continued.slots, expected_slots);
            let step = ExtensionData::new("sampling-step");
            let executors = contributor.tools_for_step(&session, &thread, &step);
            assert_eq!(executors.len(), expected_executors);
            // Assemble the same complete candidate shape that Core supplies:
            // contributed executors plus another admitted native family.
            let mut candidates = executors
                .iter()
                .map(|executor| executor.tool_name())
                .collect::<Vec<_>>();
            candidates.push(ToolName::plain("exec_command"));
            let mut selection =
                contributor.select_tools_for_step(&session, &thread, &turn, &step, &candidates);
            assert!(futures_util::poll!(&mut selection).is_pending());
            let event = tools.next_request().await;
            let expected = expected_names
                .into_iter()
                .map(ToolName::plain)
                .collect::<Vec<_>>();
            assert_eq!(event["msg"]["candidates"], json!(expected));
            tools
                .reply_step(
                    "root",
                    StepReply {
                        request_id: event["msg"]["request_id"].as_str().unwrap().into(),
                        names: Some(expected.clone()),
                        ..step_reply("turn", "0", None)
                    },
                )
                .unwrap();
            assert_eq!(selection.await.unwrap(), Some(expected));
        }
    }

    #[test]
    fn helper_expansion_uses_only_admitted_default_namespace_helpers() {
        let leaf = ToolName::namespaced("mcp", "lookup");
        let allowed = vec![
            leaf.clone(),
            ToolName::namespaced("functions", "exec"),
            ToolName::plain("wait"),
            ToolName::plain("tool_search"),
            ToolName::namespaced("mcp", "unselected"),
        ];
        assert_eq!(
            expand_step_helpers(vec![leaf.clone()], &allowed),
            vec![
                leaf.clone(),
                ToolName::namespaced("functions", "exec"),
                ToolName::plain("wait"),
                ToolName::plain("tool_search")
            ]
        );
        assert!(expand_step_helpers(Vec::new(), &allowed).is_empty());
        assert_eq!(
            expand_step_helpers(vec![ToolName::plain("exec")], &allowed),
            vec![ToolName::plain("exec"), ToolName::plain("tool_search")]
        );
        // A partial helper roster cannot authorize a missing helper, and an
        // identically named MCP leaf is not a Core execution/search helper.
        let partial = vec![
            leaf.clone(),
            ToolName::plain("wait"),
            ToolName::namespaced("mcp", "exec"),
            ToolName::namespaced("mcp", "tool_search"),
        ];
        assert_eq!(
            expand_step_helpers(vec![leaf.clone()], &partial),
            vec![leaf.clone(), ToolName::plain("wait")]
        );
        assert_eq!(
            expand_step_helpers(vec![leaf.clone()], &[leaf.clone()]),
            vec![leaf.clone()]
        );
        assert_eq!(
            expand_step_helpers(vec![leaf.clone(), ToolName::plain("exec")], &allowed),
            vec![
                leaf,
                ToolName::plain("exec"),
                ToolName::plain("wait"),
                ToolName::plain("tool_search")
            ]
        );
    }

    #[tokio::test]
    async fn root_and_reply_leaf_selections_keep_helpers_without_reopening_other_leaves() {
        let candidates = vec![
            ToolName::plain("decision"),
            ToolName::namespaced("mcp", "unselected"),
            ToolName::plain("exec"),
            ToolName::plain("wait"),
            ToolName::plain("tool_search"),
        ];
        let expected = vec![
            ToolName::plain("decision"),
            ToolName::plain("exec"),
            ToolName::plain("wait"),
            ToolName::plain("tool_search"),
        ];
        let (thread, tools) = selector_fixture(Some(vec![ToolName::plain("decision")]));
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("turn");
        let contributor = PythonContributor::default();
        tools
            .selection
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .before_step = false;
        let step = ExtensionData::new("without-callback");
        contributor.tools_for_step(&session, &thread, &step);
        assert_eq!(
            contributor
                .select_tools_for_step(&session, &thread, &turn, &step, &candidates)
                .await
                .unwrap(),
            Some(expected.clone())
        );
        tools
            .selection
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .before_step = true;
        for (raw, accepted) in [
            (vec![ToolName::plain("decision")], expected.clone()),
            (Vec::new(), Vec::new()),
            (
                vec![ToolName::plain("exec")],
                vec![ToolName::plain("exec"), ToolName::plain("tool_search")],
            ),
            (
                vec![ToolName::plain("tool_search")],
                vec![
                    ToolName::plain("tool_search"),
                    ToolName::plain("exec"),
                    ToolName::plain("wait"),
                ],
            ),
        ] {
            let step = ExtensionData::new("with-callback");
            contributor.tools_for_step(&session, &thread, &step);
            let mut selection =
                contributor.select_tools_for_step(&session, &thread, &turn, &step, &candidates);
            assert!(futures_util::poll!(&mut selection).is_pending());
            let event = tools.next_request().await;
            assert_eq!(event["msg"]["candidates"], json!(expected));
            tools
                .reply_step(
                    "root",
                    StepReply {
                        request_id: event["msg"]["request_id"].as_str().unwrap().into(),
                        names: Some(raw),
                        ..step_reply("turn", "0", None)
                    },
                )
                .unwrap();
            assert_eq!(selection.await.unwrap(), Some(accepted));
        }
        // Empty root selection must not acquire even admitted helpers.
        tools.selection.lock().unwrap().as_mut().unwrap().names = Some(Vec::new());
        tools
            .selection
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .before_step = false;
        let step = ExtensionData::new("empty-root");
        contributor.tools_for_step(&session, &thread, &step);
        assert_eq!(
            contributor
                .select_tools_for_step(&session, &thread, &turn, &step, &candidates)
                .await
                .unwrap(),
            Some(Vec::new())
        );
        // Helpers cannot launder an unadmitted root identity into a valid plan.
        tools.selection.lock().unwrap().as_mut().unwrap().names =
            Some(vec![ToolName::plain("outside")]);
        let step = ExtensionData::new("invalid-root");
        contributor.tools_for_step(&session, &thread, &step);
        assert!(
            contributor
                .select_tools_for_step(&session, &thread, &turn, &step, &candidates)
                .await
                .is_err()
        );
    }

    #[test]
    fn reply_helpers_stay_inside_the_pending_ceiling_and_do_not_launder_invalid_names() {
        let tools = tools();
        for raw in [
            vec![ToolName::plain("outside")],
            vec![
                ToolName::plain("decision"),
                ToolName::namespaced("functions", "decision"),
            ],
            vec![ToolName::plain("exec")],
        ] {
            let mut receive = pending_step(&tools);
            assert!(
                tools
                    .reply_step(
                        "root",
                        StepReply {
                            names: Some(raw),
                            ..step_reply("turn", "0", None)
                        }
                    )
                    .is_err()
            );
            assert!(matches!(
                receive.try_recv(),
                Err(oneshot::error::TryRecvError::Closed)
            ));
        }
        // No helper exists in this pending ceiling even if another sampling
        // step or the full opening catalog could have admitted it.
        let mut receive = pending_step(&tools);
        tools
            .reply_step(
                "root",
                StepReply {
                    names: Some(vec![ToolName::plain("decision")]),
                    ..step_reply("turn", "0", None)
                },
            )
            .unwrap();
        assert_eq!(
            receive.try_recv().unwrap(),
            Some(vec![ToolName::plain("decision")])
        );
    }

    #[test]
    fn operation_wire_keeps_legacy_slots_and_accepts_an_explicit_empty_native_plan() {
        let tools = tools();
        for wire in [
            json!({"generation":"0","slots":[0],"before_step":true}),
            json!({"generation":"0","names":[],"before_step":false}),
        ] {
            let selection: OperationSelection = serde_json::from_value(wire).unwrap();
            tools.validate_operation(&selection).unwrap();
        }
        let mixed: OperationSelection = serde_json::from_value(json!({
            "generation":"0","slots":[0],"names":[],"before_step":true
        }))
        .unwrap();
        assert!(tools.validate_operation(&mixed).is_err());
    }

    #[test]
    fn selected_step_reply_is_one_use_and_bound_to_owner_generation_and_ceiling() {
        let tools = tools();
        let mut receive = pending_step(&tools);
        tools
            .reply_step("root", step_reply("turn", "0", Some(vec![0])))
            .unwrap();
        assert_eq!(
            receive.try_recv().unwrap(),
            Some(vec![tools.snapshot().entries[0].name.clone()])
        );
        assert!(
            tools
                .reply_step("root", step_reply("turn", "0", Some(vec![0])))
                .is_err()
        );
        for response in [
            step_reply("other", "0", Some(vec![0])),
            step_reply("turn", "1", Some(vec![0])),
            step_reply("turn", "0", Some(vec![1])),
            step_reply("turn", "0", Some(vec![0, 0])),
        ] {
            let mut receive = pending_step(&tools);
            assert!(tools.reply_step("root", response).is_err());
            assert!(matches!(
                receive.try_recv(),
                Err(oneshot::error::TryRecvError::Closed)
            ));
        }
    }

    #[test]
    fn retired_step_reply_cannot_wake_a_successor_with_old_authority() {
        let tools = tools();
        let mut receive = pending_step(&tools);
        tools.retire_selection("turn");
        assert!(matches!(
            receive.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(
            tools
                .reply_step("root", step_reply("turn", "0", Some(vec![0])))
                .is_err()
        );
    }

    #[test]
    fn checkpoint_specs_include_defaults_only_and_keep_hidden_current_bindings_live() {
        let tools = tools();
        let mut generation = tools.prepare(1, tools.snapshot().specs.clone()).unwrap();
        generation.defaults.clear();
        tools.publish(generation).unwrap();
        assert_eq!(tools.current_specs().unwrap(), json!([]));
        assert_eq!(tools.snapshot().entries.len(), 1);
    }

    #[test]
    fn dropped_step_receiver_retires_the_reply_without_reuse() {
        let tools = tools();
        drop(pending_step(&tools));
        assert!(
            tools
                .reply_step("root", step_reply("turn", "0", Some(vec![0])))
                .is_err()
        );
        assert!(tools.step_replies.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn next_request_skips_a_retired_step_before_delivering_its_successor() {
        let tools = tools();
        let old = pending_step(&tools);
        assert!(
            tools
                .family
                .requests
                .send(FamilyRequest::Step(
                    Arc::downgrade(&tools),
                    7,
                    json!({"id":"retired"})
                ))
                .is_ok()
        );
        tools.retire_selection("turn");
        drop(old);
        let (_receive, id) = {
            let (reply, receive) = oneshot::channel();
            tools.step_replies.lock().unwrap().insert(
                8,
                PendingStep {
                    turn: "next".into(),
                    generation: 0,
                    allowed: vec![tools.snapshot().entries[0].name.clone()],
                    reply,
                },
            );
            (receive, 8)
        };
        assert!(
            tools
                .family
                .requests
                .send(FamilyRequest::Step(
                    Arc::downgrade(&tools),
                    id,
                    json!({"id":"successor"})
                ))
                .is_ok()
        );
        assert_eq!(tools.next_request().await, json!({"id":"successor"}));
    }
}

#[cfg(test)]
mod declaration_validation_tests {
    use super::*;

    #[test]
    fn local_policy_requires_the_current_planning_grant_and_an_exact_ceiling() {
        let managed = HashSet::from([ToolName::plain("lookup").with_default_namespace()]);
        let mut policy = ToolPolicy::default();
        assert!(validate_local_policy(&policy, &managed, false, None).is_err());
        for (planning, allowed, accepted) in [
            (false, vec!["lookup"], true),
            (true, vec!["lookup"], false),
            (true, vec!["lookup", "update_plan"], true),
            (false, vec!["lookup", "update_plan"], false),
            (true, vec!["update_plan", "exec_command"], false),
            (false, vec!["exec_command"], false),
        ] {
            policy.allowed_tools = Some(
                allowed
                    .into_iter()
                    .map(|name| ToolName::plain(name).with_default_namespace())
                    .collect(),
            );
            assert_eq!(
                validate_local_policy(&policy, &managed, planning, None).is_ok(),
                accepted
            );
        }
        for (namespace, accepted) in [
            (None, true),
            (Some(""), true),
            (Some("functions"), true),
            (Some("foreign"), false),
        ] {
            policy.allowed_tools = Some(vec![ToolName::new(
                namespace.map(|value| value.to_owned()),
                "update_plan".to_owned(),
            )]);
            assert_eq!(
                validate_local_policy(&policy, &managed, true, None).is_ok(),
                accepted
            );
            assert!(validate_local_policy(&policy, &managed, false, None).is_err());
        }
        let managed = HashSet::from([ToolName::plain("update_plan").with_default_namespace()]);
        policy.allowed_tools = Some(managed.iter().cloned().collect());
        assert!(validate_local_policy(&policy, &managed, false, None).is_ok());
    }

    fn declaration(name: &str, schema: Value) -> DynamicToolSpec {
        serde_json::from_value(json!({
            "type": "function", "name": name, "description": "Test.",
            "inputSchema": schema, "deferLoading": false,
        }))
        .expect("valid declaration envelope")
    }

    #[test]
    fn validates_without_runtime_state() {
        let lookup = declaration("lookup", json!({"type": "object", "properties": {}}));
        assert!(validate_declarations(std::slice::from_ref(&lookup)).is_ok());
        assert!(validate_declarations(&[]).is_ok());
        let duplicate = validate_declarations(&[lookup.clone(), lookup]).unwrap_err();
        assert!(duplicate.to_string().contains("Duplicate JavaScript tool"));
        let reserved = declaration("exec_command", json!({"type": "object"}));
        assert!(
            validate_declarations(&[reserved])
                .unwrap_err()
                .to_string()
                .contains("reserved name")
        );
    }

    #[test]
    fn search_names_are_valid_application_declarations() {
        for name in ["project_glob", "project_grep"] {
            let function = json!({
                "type": "function", "name": name, "description": "Application tool.",
                "inputSchema": {"type": "object", "properties": {}}, "deferLoading": false,
            });
            for specs in [
                json!([function.clone()]),
                json!([{"type": "namespace", "name": "functions", "description": "Default namespace.", "tools": [function]}]),
            ] {
                let specs: Vec<DynamicToolSpec> = serde_json::from_value(specs).unwrap();
                assert!(validate_declarations(&specs).is_ok());
            }
        }
    }

    #[test]
    fn rejects_native_conversion_failures() {
        let invalid = declaration("lookup", json!({"type": "null"}));
        assert!(validate_declarations(&[invalid]).is_err());
    }
}

#[cfg(test)]
#[path = "web_search_tests.rs"]
mod web_search_tests;

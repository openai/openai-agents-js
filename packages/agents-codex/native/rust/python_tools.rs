use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};

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

#[path = "recovered_completion.rs"]
mod recovered_completion;
#[path = "terminal_completion.rs"]
mod terminal_completion;
pub(crate) use recovered_completion::RecoveredToolCompletionSeed;
pub(crate) use terminal_completion::{CompletionReply, TerminalProposal, TerminalSlots};

#[path = "context_callbacks.rs"]
pub(crate) mod context_callbacks;

#[path = "prepared_requests.rs"]
pub(crate) mod prepared_requests;

#[derive(Clone)]
struct Entry {
    name: ToolName,
    spec: ToolSpec,
    exposure: ToolExposure,
}

#[derive(Clone)]
pub(crate) struct Generation {
    pub(crate) id: u64,
    manual_slots: Option<HashSet<usize>>,
    schema_token: Option<String>,
    entries: Vec<Entry>,
    specs: Vec<DynamicToolSpec>,
    defaults: Vec<usize>,
    terminal_slots: HashSet<usize>,
}

/// Exact manual classification from the same retained declaration capture.
struct CapturedManualTools {
    generation: Arc<Generation>,
    slots: HashSet<usize>,
}

/// Exact immutable declarations belonging to one captured native Agent step.
#[derive(Clone)]
pub(crate) struct ProfileCatalog {
    pub(crate) generation: Arc<Generation>,
    pub(crate) defaults: Option<Vec<ToolName>>,
    pub(crate) selecting_steps: bool,
    pub(crate) transform_context: bool,
    pub(crate) before_compact: bool,
    pub(crate) before_complete: bool,
}
impl ProfileCatalog {
    pub(crate) fn slot_specs(&self) -> Result<Value> {
        checkpoint_specs(&self.generation.specs)
    }
    pub(crate) fn checkpoint_specs(&self) -> Result<Value> {
        checkpoint_specs(
            &self
                .generation
                .defaults
                .iter()
                .map(|&slot| self.generation.specs[slot].clone())
                .collect::<Vec<_>>(),
        )
    }
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

#[derive(Clone)]
pub(crate) struct NativeMediaContext {
    pub(crate) model_info: Arc<codex_protocol::openai_models::ModelInfo>,
    pub(crate) profile: codex_protocol::provider_reference_profile::ProviderImageReferencePolicy,
    pub(crate) inline_data_url_low_detail_supported: bool,
}

/// Physical callback ownership attached to an existing native pending entry.
struct CallbackRelease {
    receipt: Value,
    entered: std::sync::atomic::AtomicBool,
    cancelled: std::sync::atomic::AtomicBool,
    released: std::sync::atomic::AtomicBool,
    changed: tokio::sync::Notify,
}
impl CallbackRelease {
    fn new(receipt: Value) -> Arc<Self> {
        Arc::new(Self {
            receipt,
            entered: std::sync::atomic::AtomicBool::new(false),
            cancelled: std::sync::atomic::AtomicBool::new(false),
            released: std::sync::atomic::AtomicBool::new(false),
            changed: tokio::sync::Notify::new(),
        })
    }
    fn release(&self) -> bool {
        let first = !self.released.swap(true, Ordering::AcqRel);
        self.changed.notify_waiters();
        first
    }
    async fn wait(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.released.load(Ordering::Acquire) {
                return;
            }
            changed.await;
        }
    }
}
fn closed_tool_sender() -> oneshot::Sender<ToolReply> {
    let (sender, receiver) = oneshot::channel();
    drop(receiver);
    sender
}

struct PendingCall {
    // Captured by native enqueue, never reconstructed from a host reply.
    computer_arguments: Option<String>,
    apply_patch_arguments: Option<String>,
    media: Option<NativeMediaContext>,
    deadline: Option<Arc<codex_extension_api::ModelInvocationDeadlineState>>,
    invocation: u64,
    retired: bool,
    callback: Option<Arc<CallbackRelease>>,
    _tracing: Option<codex_otel::sdk_trace::ContextLease>,
    sender: oneshot::Sender<ToolReply>,
    manual_request: Option<Value>,
    _approval_receiver: Option<oneshot::Receiver<ToolReply>>,
}

pub(crate) struct ChildStepSelection;

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct ContextCallbacks {
    pub(crate) model_producer: bool,
    pub(crate) before_compact: bool,
    pub(crate) transform_context: bool,
    pub(crate) before_complete: bool,
}

#[derive(Clone)]
struct InheritedProfileSource {
    receipt: codex_extension_api::AgentProfileReceipt,
    catalog: ProfileCatalog,
    mcp_selection: Option<crate::mcp_result_control::Selection>,
    mcp_policy: Option<Arc<crate::native_interception::ProfileMcpPolicy>>,
}

pub struct PythonTools {
    local_store: Option<Arc<crate::local_storage::LocalChecklistStore>>,
    custom_store: Option<Arc<crate::custom_storage::CustomThreadStore>>,
    preserve_schemas: bool,
    schema_receipts: schema_fidelity::Receipts,
    current: RwLock<Arc<Generation>>,
    generation_high_water: AtomicU64,
    profile_catalogs: RwLock<HashMap<u64, Weak<Generation>>>,
    managed_profiles: AtomicBool,
    inherited_source: Option<InheritedProfileSource>,
    fixed: HashSet<ToolName>,
    policy: Arc<ToolPolicy>,
    pending: Mutex<HashMap<PendingKey, PendingCall>>,
    family: Arc<Family>,
    instance: Option<String>,
    pub(crate) inherit_children: bool,
    child_before_step: bool,
    context_callbacks: ContextCallbacks,
    context_control: OnceLock<Weak<crate::native_interception::Control>>,
    manual: Mutex<ManualLedger>,
    selection: Mutex<Option<ActiveSelection>>,
    step_replies: Mutex<HashMap<u64, PendingStep>>,
    prepared: Mutex<Option<Arc<prepared_requests::Owner>>>,
    completion_replies: Mutex<HashMap<u64, terminal_completion::Pending>>,
}

// The family inbox transports requests; reply authority stays with each issuer.
enum FamilyRequest {
    Step(Weak<PythonTools>, u64, Value),
    Completion(Weak<PythonTools>, u64, Value),
    CompletionFailed(Weak<PythonTools>, Weak<crate::turn_settlement::Turn>, Value),
    Prepared(Weak<prepared_requests::Owner>, u64, Value),
    Call(Weak<PythonTools>, PendingKey, Value),
    Callback(Value),
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
    #[serde(default = "request_response_by_default")]
    pub(crate) start_response: bool,
}

fn request_response_by_default() -> bool {
    true
}

#[derive(Debug)]
pub(crate) struct ToolReply {
    pub(crate) response: DynamicToolResponse,
    pub(crate) start_response: bool,
    pub(crate) acceptance: Option<oneshot::Sender<()>>,
}
impl From<DynamicToolResponse> for ToolReply {
    fn from(response: DynamicToolResponse) -> Self {
        Self {
            response,
            start_response: true,
            acceptance: None,
        }
    }
}

fn functions(
    specs: &[DynamicToolSpec],
) -> Vec<(
    Option<&DynamicToolNamespaceSpec>,
    Cow<'_, DynamicToolFunctionSpec>,
)> {
    let mut functions = Vec::new();
    for spec in specs {
        match spec {
            DynamicToolSpec::Function(tool) => functions.push((None, Cow::Borrowed(tool))),
            DynamicToolSpec::ApplyPatch => functions.push((None, Cow::Owned(DynamicToolFunctionSpec {
                strict: false, output_schema: None, name: "apply_patch".into(),
                description: "Native application patch callback".into(), input_schema: json!({"type":"object"}), defer_loading: false,
            }))),
            DynamicToolSpec::Computer(tool) => {
                functions.push((None, Cow::Owned(tool.callback_spec())))
            }
            DynamicToolSpec::Namespace(namespace) => {
                for DynamicToolNamespaceTool::Function(tool) in &namespace.tools {
                    functions.push((Some(namespace), Cow::Borrowed(tool)));
                }
            }
        }
    }
    functions
}

fn validate_slots(specs: &[DynamicToolSpec]) -> Result<()> {
    ensure!(
        specs.iter().all(|spec| match spec {
            DynamicToolSpec::ApplyPatch | DynamicToolSpec::Function(_) | DynamicToolSpec::Computer(_) => true,
            DynamicToolSpec::Namespace(ns) => ns.tools.len() == 1,
        }),
        "invalid JavaScript tool slot projection"
    );
    Ok(())
}

/// Validate declarations without acquiring runtime resources or consulting live policy.
pub(crate) fn validate_declarations(specs: &[DynamicToolSpec]) -> Result<()> {
    validate_slots(specs)?;
    for declaration in specs {
        if let DynamicToolSpec::Computer(computer) = declaration {
            codex_tools::computer_tool_spec(computer).map_err(anyhow::Error::msg)?;
        }
    }
    let mut seen = HashSet::new();
    for (declaration, (namespace, tool)) in specs.iter().zip(functions(specs)) {
        let key = ToolName::new(namespace.map(|ns| ns.name.clone()), tool.name.clone())
            .with_default_namespace();
        ensure!(seen.insert(key.clone()), "Duplicate JavaScript tool: {key}");
        ensure!(
            !(key.is_default_namespace()
                && !matches!(declaration, DynamicToolSpec::ApplyPatch)
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
        dynamic_tool_to_responses_api_tool(&tool)?;
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

pub(crate) fn tool_names(specs: &[DynamicToolSpec]) -> HashSet<ToolName> {
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
        } else if spec.get("type").and_then(Value::as_str) == Some("function") {
            spec.as_object_mut()
                .expect("serialized tool")
                .entry("deferLoading")
                .or_insert(Value::Bool(false));
        }
    }
    Ok(value)
}

fn preparation_callback_claim(
    callback: &Arc<CallbackRelease>,
    operation: &str,
    closed: bool,
    cancelled: bool,
) -> bool {
    match operation {
        "enter" => {
            !closed
                && !cancelled
                && !callback.cancelled.load(Ordering::Acquire)
                && !callback.released.load(Ordering::Acquire)
                && callback
                    .entered
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
        }
        "cancelled" => cancelled || callback.cancelled.load(Ordering::Acquire),
        "release" => callback.release(),
        _ => false,
    }
}

impl PythonTools {
    fn preparation_callback_operation(
        self: &Arc<Self>,
        root: &str,
        receipt: &Value,
        operation: &str,
    ) -> bool {
        if receipt.get("kind").and_then(Value::as_str) != Some("preparation") {
            return false;
        }
        let Some(thread) = receipt.get("thread").and_then(Value::as_str) else {
            return false;
        };
        let instance = receipt
            .get("instance")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(id) = receipt
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| id.parse::<u64>().ok())
        else {
            return false;
        };
        let Some(owner) = self.exact_owner(root, thread, &instance) else {
            return false;
        };
        let mut replies = owner.step_replies.lock().expect("Step replies poisoned");
        let Some(pending) = replies.get_mut(&id) else {
            drop(replies);
            return owner.terminal_callback_operation(id, receipt, operation);
        };
        let Some(callback) = pending
            .callback
            .as_ref()
            .filter(|callback| callback.receipt == *receipt)
        else {
            return false;
        };
        preparation_callback_claim(
            callback,
            operation,
            pending.reply.is_closed(),
            pending
                .source_cancellation
                .as_ref()
                .is_some_and(|token| token.is_cancelled()),
        )
    }

    fn cancel_step_callback(&self, turn: &str, callback: &Arc<CallbackRelease>) {
        if !callback.cancelled.swap(true, Ordering::AcqRel) {
            let mut notice =
                json!({"id":turn,"msg":{"type":"_sdk_callback_cancel","receipt":callback.receipt}});
            if let Some(instance) = &self.instance {
                notice["subagent_id"] = callback.receipt["thread"].clone();
                notice["subagent_incarnation"] = json!(instance);
                notice["subagent_managed_tools"] = json!(true);
            }
            let _ = self.family.requests.send(FamilyRequest::Callback(notice));
        }
        if !callback.entered.load(Ordering::Acquire) {
            callback.release();
        }
    }
    fn retire_step_callback(&self, id: u64) {
        let mut replies = self.step_replies.lock().expect("Step replies poisoned");
        let Some(pending) = replies.get_mut(&id) else {
            return;
        };
        let Some(callback) = pending.callback.clone() else {
            replies.remove(&id);
            return;
        };
        drop(std::mem::replace(&mut pending.reply, closed_step_sender()));
        self.cancel_step_callback(&pending.turn, &callback);
        if !callback.entered.load(Ordering::Acquire) {
            replies.remove(&id);
        }
    }
    async fn finish_step_callbacks(&self, turn: Option<&str>, cancel: bool) {
        let callbacks: Vec<_> = {
            let mut replies = self.step_replies.lock().expect("Step replies poisoned");
            replies
                .iter_mut()
                .filter(|(_, pending)| turn.is_none_or(|turn| pending.turn == turn))
                .filter_map(|(id, pending)| {
                    pending.callback.clone().map(|callback| {
                        if cancel {
                            drop(std::mem::replace(&mut pending.reply, closed_step_sender()));
                            self.cancel_step_callback(&pending.turn, &callback);
                        }
                        if !callback.entered.load(Ordering::Acquire) {
                            callback.release();
                        }
                        (*id, callback)
                    })
                })
                .collect()
        };
        for (id, callback) in callbacks {
            callback.wait().await;
            let mut replies = self.step_replies.lock().expect("Step replies poisoned");
            if replies
                .get(&id)
                .and_then(|pending| pending.callback.as_ref())
                .is_some_and(|current| Arc::ptr_eq(current, &callback))
            {
                replies.remove(&id);
            }
        }
        self.finish_terminal_callbacks(turn, cancel).await;
    }

    pub(crate) fn callback_operation(
        self: &Arc<Self>,
        root: &str,
        receipt: &Value,
        operation: &str,
    ) -> bool {
        if receipt.get("kind").and_then(Value::as_str) != Some("tool") {
            return self.preparation_callback_operation(root, receipt, operation);
        }
        let Ok(key) = serde_json::from_value::<PendingKey>(
            receipt.get("request").cloned().unwrap_or(Value::Null),
        ) else {
            return false;
        };
        let Some(owner) = self.owner(root, &key) else {
            return false;
        };
        let mut pending = owner.pending.lock().expect("callback pending poisoned");
        let Some(call) = pending.get_mut(&key) else {
            return false;
        };
        let Some(callback) = call
            .callback
            .as_ref()
            .filter(|callback| callback.receipt == *receipt)
        else {
            return false;
        };
        match operation {
            "enter" => {
                if call.sender.is_closed()
                    || callback.cancelled.load(Ordering::Acquire)
                    || callback.released.load(Ordering::Acquire)
                {
                    return false;
                }
                callback
                    .entered
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            }
            "cancelled" => callback.cancelled.load(Ordering::Acquire),
            "release" => {
                let released = callback.release();
                // A restored approval owns a synthetic waiter, not a live Core
                // PendingReply. Retire it after receipt and physical callback release.
                if call._approval_receiver.is_some() && call.sender.is_closed() {
                    pending.remove(&key);
                }
                released
            }
            _ => false,
        }
    }
    fn cancel_callback(&self, key: &PendingKey, callback: &Arc<CallbackRelease>) {
        if !callback.cancelled.swap(true, Ordering::AcqRel) {
            let mut notice = json!({"id":key.turn,"msg":{"type":"_sdk_callback_cancel","receipt":callback.receipt}});
            if let Some(instance) = &key.reply.instance {
                notice["subagent_id"] = json!(key.reply.thread);
                notice["subagent_incarnation"] = json!(instance);
                notice["subagent_managed_tools"] = json!(true);
            }
            let _ = self.family.requests.send(FamilyRequest::Callback(notice));
        }
        if !callback.entered.load(Ordering::Acquire) {
            callback.release();
        }
    }
    fn retire_callback(&self, key: &PendingKey, invocation: u64, completed: bool) {
        let mut pending = self.pending.lock().expect("callback pending poisoned");
        let Some(call) = pending.get_mut(key) else {
            return;
        };
        if call.invocation != invocation {
            return;
        }
        call.retired = true;
        let Some(callback) = call.callback.clone() else {
            pending.remove(key);
            return;
        };
        if !completed {
            drop(std::mem::replace(&mut call.sender, closed_tool_sender()));
            self.cancel_callback(key, &callback);
        }
        if !callback.entered.load(Ordering::Acquire) {
            callback.release();
            pending.remove(key);
        }
    }
    async fn finish_callbacks(&self, turn: Option<&str>, call_id: Option<&str>, cancel: bool) {
        let callbacks: Vec<_> = {
            let mut pending = self.pending.lock().expect("callback pending poisoned");
            pending
                .iter_mut()
                .filter(|(key, call)| {
                    turn.is_none_or(|turn| key.turn == turn)
                        && call_id.is_none_or(|id| key.call == id)
                        && (cancel || call.retired)
                })
                .filter_map(|(key, call)| {
                    call.callback.clone().map(|callback| {
                        if cancel {
                            drop(std::mem::replace(&mut call.sender, closed_tool_sender()));
                            self.cancel_callback(key, &callback);
                        }
                        if !callback.entered.load(Ordering::Acquire) {
                            callback.release();
                        }
                        (key.clone(), callback)
                    })
                })
                .collect()
        };
        for (key, callback) in callbacks {
            callback.wait().await;
            let mut pending = self.pending.lock().expect("callback pending poisoned");
            if pending
                .get(&key)
                .and_then(|call| call.callback.as_ref())
                .is_some_and(|current| Arc::ptr_eq(current, &callback))
            {
                pending.remove(&key);
            }
        }
    }

    pub(crate) fn generation_high_water(&self) -> u64 {
        self.generation_high_water
            .load(Ordering::Acquire)
            .max(self.snapshot().id)
    }

    fn allocate_generation(&self) -> Result<u64> {
        let current = self.snapshot().id;
        let previous = self
            .generation_high_water
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.max(current).checked_add(1)
            })
            .map_err(|_| anyhow::anyhow!("Python tool generation counter exhausted"))?;
        Ok(previous.max(current) + 1)
    }

    pub(crate) fn resolve_generation(&self, id: u64) -> Option<Arc<Generation>> {
        let captured = self
            .profile_catalogs
            .read()
            .expect("Profile catalogs poisoned")
            .get(&id)
            .and_then(Weak::upgrade);
        captured.or_else(|| {
            let current = self.snapshot();
            (current.id == id).then_some(current)
        })
    }

    fn admits_generation(&self, generation: &Arc<Generation>) -> bool {
        self.resolve_generation(generation.id)
            .is_some_and(|admitted| Arc::ptr_eq(&admitted, generation))
    }

    fn register_generation(&self, generation: &Arc<Generation>) -> Result<()> {
        let mut catalogs = self
            .profile_catalogs
            .write()
            .expect("Profile catalogs poisoned");
        catalogs.retain(|_, generation| generation.strong_count() != 0);
        ensure!(
            catalogs
                .get(&generation.id)
                .and_then(Weak::upgrade)
                .is_none_or(|existing| Arc::ptr_eq(&existing, generation)),
            "Conflicting source catalog generation"
        );
        catalogs.insert(generation.id, Arc::downgrade(generation));
        Ok(())
    }

    pub(crate) fn profile_catalog(
        &self,
        specs: Vec<DynamicToolSpec>,
        manual_slots: &[usize],
        terminal_slots: &[usize],
        defaults: Option<&[usize]>,
        flags: [bool; 4],
        _reuse_initial: bool,
    ) -> Result<ProfileCatalog> {
        self.allocate_profile_catalog(specs, manual_slots, terminal_slots, defaults, flags, true)
    }

    pub(crate) fn voice_profile_catalog(
        &self,
        specs: Vec<DynamicToolSpec>,
        manual_slots: &[usize],
        terminal_slots: &[usize],
        defaults: Option<&[usize]>,
        flags: [bool; 4],
    ) -> Result<ProfileCatalog> {
        self.allocate_profile_catalog(specs, manual_slots, terminal_slots, defaults, flags, false)
    }

    fn allocate_profile_catalog(
        &self,
        specs: Vec<DynamicToolSpec>,
        manual_slots: &[usize],
        terminal_slots: &[usize],
        defaults: Option<&[usize]>,
        flags: [bool; 4],
        durable: bool,
    ) -> Result<ProfileCatalog> {
        let id = self.allocate_generation()?;
        // An explicitly admitted voice Agent supplies its own callback catalog.
        // The opening policy still governs all durable profiles and turns.
        let policy = durable.then_some(self.policy.as_ref());
        let mut generation = self.prepare_catalog(id, specs, policy)?;
        let mut manual = HashSet::new();
        for &slot in manual_slots {
            ensure!(
                slot < generation.entries.len() && manual.insert(slot),
                "Invalid or duplicate manual tool slot"
            );
        }
        generation.manual_slots = Some(manual);
        for &slot in terminal_slots {
            ensure!(
                slot < generation.entries.len() && generation.terminal_slots.insert(slot),
                "Invalid or duplicate terminal tool slot"
            );
        }
        generation.defaults = defaults
            .map(Vec::from)
            .unwrap_or_else(|| (0..generation.entries.len()).collect());
        let defaults = defaults
            .map(|slots| {
                let mut seen = HashSet::new();
                slots
                    .iter()
                    .map(|slot| {
                        ensure!(seen.insert(*slot), "Duplicate profile default tool slot");
                        generation
                            .entries
                            .get(*slot)
                            .map(|entry| entry.name.clone())
                            .context("Invalid profile default tool slot")
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?;
        let generation = Arc::new(generation);
        self.schema_receipts.register(&generation);
        self.register_generation(&generation)?;
        Ok(ProfileCatalog {
            generation,
            defaults,
            selecting_steps: flags[0],
            transform_context: flags[1],
            before_compact: flags[2],
            before_complete: flags[3],
        })
    }

    pub(crate) fn startup_profile_catalog(
        &self,
        flags: [bool; 4],
        source: &ProfileCatalog,
    ) -> Result<ProfileCatalog> {
        let generation = self.snapshot();
        let rebind = |slots: &HashSet<usize>| {
            let names = slots
                .iter()
                .map(|&slot| {
                    source.generation.entries[slot]
                        .name
                        .clone()
                        .with_default_namespace()
                })
                .collect::<HashSet<_>>();
            generation
                .entries
                .iter()
                .enumerate()
                .filter_map(|(slot, entry)| {
                    names
                        .contains(&entry.name.clone().with_default_namespace())
                        .then_some(slot)
                })
                .collect::<Vec<_>>()
        };
        let manual = source
            .generation
            .manual_slots
            .as_ref()
            .map(&rebind)
            .unwrap_or_default();
        let terminal = rebind(&source.generation.terminal_slots);
        self.profile_catalog(
            generation.specs.clone(),
            &manual,
            &terminal,
            Some(&generation.defaults),
            flags,
            false,
        )
    }

    fn realtime_catalog(
        &self,
        profile: Option<&codex_extension_api::CapturedAgentProfile>,
    ) -> Result<ProfileCatalog> {
        if let Some(profile) = profile {
            let catalog = profile
                .profile
                .data
                .get::<ProfileCatalog>()
                .context("Captured Agent has no admitted JavaScript tool catalog")?;
            return Ok((*catalog).clone());
        }
        if let Some(source) = &self.inherited_source {
            return Ok(source.catalog.clone());
        }
        ensure!(
            !self.managed_profiles.load(Ordering::Acquire),
            "Managed Realtime source has no captured Agent profile"
        );
        let generation = self.snapshot();
        Ok(ProfileCatalog {
            defaults: Some(
                generation
                    .defaults
                    .iter()
                    .map(|&slot| generation.entries[slot].name.clone())
                    .collect(),
            ),
            generation,
            selecting_steps: false,
            transform_context: false,
            before_compact: false,
            before_complete: false,
        })
    }

    pub(crate) async fn realtime_tool_selection(&self, thread: &CodexThread) -> Result<Value> {
        let captured = thread.captured_agent_profile().await?;
        let catalog = self.realtime_catalog(captured.as_deref())?;
        let profile = captured
            .as_ref()
            .map(|source| source.receipt.clone())
            .or_else(|| {
                self.inherited_source
                    .as_ref()
                    .map(|source| source.receipt.clone())
            });
        let (selection_id, function_tools) =
            thread.realtime_agent_source_selection(None, None).await?;
        Ok(json!({
            "selection_id": selection_id,
            "function_tools": function_tools,
            "profile_receipt":profile,
            "catalog_generation":catalog.generation.id.to_string(),
        }))
    }

    pub(crate) fn source_catalog(
        &self,
        step: Option<&ExtensionData>,
    ) -> Result<Option<ProfileCatalog>> {
        self.generation_for_step(step)?;
        Ok(step
            .and_then(|step| step.get::<ProfileCatalog>())
            .map(|catalog| (*catalog).clone())
            .or_else(|| {
                self.inherited_source
                    .as_ref()
                    .map(|source| source.catalog.clone())
            }))
    }

    pub(crate) fn source_profile(
        &self,
        step: Option<&ExtensionData>,
    ) -> Result<Option<codex_extension_api::AgentProfileReceipt>> {
        self.generation_for_step(step)?;
        let profile = step
            .and_then(|step| step.get::<codex_extension_api::CapturedAgentProfile>())
            .map(|profile| profile.receipt.clone())
            .or_else(|| {
                self.inherited_source
                    .as_ref()
                    .map(|source| source.receipt.clone())
            });
        if self.managed_profiles.load(Ordering::Acquire) {
            ensure!(profile.is_some(), "Missing captured Agent profile source");
        }
        Ok(profile)
    }

    pub(crate) fn generation_for_step(
        &self,
        step: Option<&ExtensionData>,
    ) -> Result<Arc<Generation>> {
        if let Some(catalog) = step.and_then(|step| step.get::<ProfileCatalog>()) {
            ensure!(
                self.admits_generation(&catalog.generation),
                "Expired captured profile catalog"
            );
            return Ok(catalog.generation.clone());
        }
        if let Some(source) = &self.inherited_source {
            let generation = step
                .and_then(|step| step.get::<StepCatalog>())
                .map(|catalog| catalog.generation.clone())
                .unwrap_or_else(|| source.catalog.generation.clone());
            ensure!(
                self.admits_generation(&generation),
                "Expired captured child source catalog"
            );
            return Ok(generation);
        }
        if let Some(catalog) = step.and_then(|step| step.get::<StepCatalog>()) {
            ensure!(
                self.admits_generation(&catalog.generation),
                "Expired captured native step catalog"
            );
            return Ok(catalog.generation.clone());
        }
        ensure!(
            !self.managed_profiles.load(Ordering::Acquire),
            "Managed Agent callback requires its captured native step profile"
        );
        Ok(self.snapshot())
    }

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
                            codex_tools::HostedToolSpec::Shell(_) => "shell",
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
            if let Some(opening) = startup
                .thread_extension_init
                .get::<crate::agent_profiles::OpeningProfiles>()
            {
                names.extend(opening.admitted_tool_names());
            }
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
                manual_slots: None,
                entries: Vec::new(),
                specs: Vec::new(),
                defaults: Vec::new(),
                terminal_slots: HashSet::new(),
            })),
            generation_high_water: AtomicU64::new(0),
            profile_catalogs: RwLock::new(HashMap::new()),
            managed_profiles: AtomicBool::new(false),
            inherited_source: None,
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
            context_control: OnceLock::new(),
            context_callbacks: startup
                .thread_extension_init
                .get::<ContextCallbacks>()
                .map_or_else(ContextCallbacks::default, |flags| *flags),
            manual: Mutex::new(ManualLedger::default()),
            selection: Mutex::new(None),
            step_replies: Mutex::new(HashMap::new()),
            prepared: Mutex::new(None),
            completion_replies: Mutex::default(),
        };
        let seed = Arc::new(tools.prepare(0, specs)?);
        tools.schema_receipts.register(&seed);
        *tools.current.write().expect("JavaScript catalog poisoned") = seed;
        startup
            .thread_extension_init
            .insert(tools.family.manual_progress.clone());
        tools.managed_profiles.store(
            startup
                .thread_extension_init
                .get::<crate::agent_profiles::OpeningProfiles>()
                .is_some(),
            Ordering::Release,
        );
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

    fn descendant(
        parent: &Self,
        instance: String,
        policy: Arc<ToolPolicy>,
        spawning_step: Option<&ExtensionData>,
    ) -> Result<Self> {
        let managed = parent.managed_profiles.load(Ordering::Acquire);
        ensure!(
            !managed || spawning_step.is_some(),
            "Managed child requires its actual spawning step source"
        );
        let source_catalog = spawning_step
            .map(|step| parent.source_catalog(Some(step)))
            .transpose()?
            .flatten();
        let source_receipt = spawning_step
            .map(|step| parent.source_profile(Some(step)))
            .transpose()?
            .flatten();
        let mut child = Self {
            // Receipt ownership stays with each child writer/turn/call, not the root.
            local_store: parent.local_store.clone(),
            custom_store: parent.custom_store.clone(),
            preserve_schemas: parent.preserve_schemas,
            schema_receipts: Default::default(),
            current: RwLock::new(parent.snapshot()),
            generation_high_water: AtomicU64::new(parent.generation_high_water()),
            profile_catalogs: RwLock::new(HashMap::new()),
            managed_profiles: AtomicBool::new(managed),
            inherited_source: None,
            fixed: parent.fixed.clone(),
            policy,
            pending: Mutex::default(),
            family: parent.family.clone(),
            instance: Some(instance),
            inherit_children: parent.inherit_children,
            child_before_step: parent.child_before_step,
            context_control: OnceLock::new(),
            context_callbacks: parent.context_callbacks,
            manual: Mutex::new(parent.child_manual_ledger()),
            selection: Mutex::new(None),
            step_replies: Mutex::new(HashMap::new()),
            prepared: Mutex::new(None),
            completion_replies: Mutex::default(),
        };
        // Validate the inherited catalog against this child's current ceiling.
        let parent_generation = spawning_step
            .map(|step| parent.generation_for_step(Some(step)))
            .transpose()?
            .unwrap_or_else(|| parent.snapshot());
        let mut generation =
            child.prepare(parent_generation.id, parent_generation.specs.clone())?;
        generation.defaults = parent_generation.defaults.clone();
        generation.terminal_slots = parent_generation.terminal_slots.clone();
        generation.manual_slots = parent_generation.manual_slots.clone();
        let generation = Arc::new(generation);
        child.schema_receipts.register(&generation);
        *child.current.write().expect("JavaScript catalog poisoned") = generation.clone();
        if let Some(receipt) = source_receipt {
            let mut catalog = source_catalog.context("Managed child source catalog is absent")?;
            catalog.generation = generation.clone();
            child.register_generation(&generation)?;
            child.child_before_step = true;
            child.inherited_source = Some(InheritedProfileSource {
                receipt,
                catalog,
                mcp_policy: spawning_step
                    .and_then(|step| step.get::<crate::native_interception::ProfileMcpPolicy>()),
                mcp_selection: spawning_step
                    .and_then(|step| step.get::<crate::mcp_result_control::Selection>())
                    .map(|selection| (*selection).clone()),
            });
        }
        Ok(child)
    }

    pub(crate) fn response_receipt(
        &self,
        key: &PendingKey,
        response: DynamicToolResponse,
    ) -> Result<Option<ResponseItem>> {
        let (computer, patch) = {
            let pending = self.pending.lock().expect("tool replies poisoned");
            let Some(call) = pending.get(key) else { return Ok(None); };
            (call.computer_arguments.clone(), call.apply_patch_arguments.clone())
        };
        let mut item: ResponseItem = if let Some(arguments) = patch {
            codex_tools::ApplyPatchToolOutput::from_dynamic_response(&arguments, response)
                .map_err(|_| anyhow::anyhow!("Invalid native application patch response"))?
                .to_response_item(&key.call, &ToolPayload::ApplyPatch { arguments }).into()
        } else if let Some(arguments) = computer {
            codex_tools::ComputerToolOutput::from_dynamic_response(&arguments, response)
                .map_err(|_| anyhow::anyhow!("Invalid native computer response"))?
                .to_response_item(&key.call, &ToolPayload::Computer { arguments }).into()
        } else { return Ok(Some(PythonOutput(response).receipt(key))); };
        item.set_turn_id_if_missing(&key.turn);
        Ok(Some(item))
    }

    fn prepare(&self, id: u64, specs: Vec<DynamicToolSpec>) -> Result<Generation> {
        self.prepare_catalog(id, specs, Some(self.policy.as_ref()))
    }

    fn prepare_catalog(
        &self,
        id: u64,
        specs: Vec<DynamicToolSpec>,
        policy: Option<&ToolPolicy>,
    ) -> Result<Generation> {
        let mut entries = Vec::new();
        let schema_token = self
            .preserve_schemas
            .then(|| codex_protocol::ThreadId::new().to_string());
        validate_declarations(&specs)?;
        for (declaration, (namespace, tool)) in specs.iter().zip(functions(&specs)) {
            let name = ToolName::new(namespace.map(|ns| ns.name.clone()), tool.name.clone());
            let key = name.clone().with_default_namespace();
            ensure!(
                !self.fixed.contains(&key) || matches!(declaration, DynamicToolSpec::ApplyPatch),
                "JavaScript tool collides with fixed tool: {key}"
            );
            ensure!(
                policy.is_none_or(|policy| policy.allows(&key)),
                "JavaScript tool is excluded by ToolPolicy: {key}"
            );
            let mut function = dynamic_tool_to_responses_api_tool(&tool)?;
            function.defer_loading = None;
            if let Some(token) = &schema_token {
                function.description =
                    schema_fidelity::Receipts::description(&tool.description, token, entries.len());
            }
            let spec = if matches!(declaration, DynamicToolSpec::ApplyPatch) {
                ToolSpec::ApplyPatch {}
            } else if let DynamicToolSpec::Computer(computer) = declaration {
                codex_tools::computer_tool_spec(computer).map_err(anyhow::Error::msg)?
            } else {
                match namespace.filter(|_| !key.is_default_namespace()) {
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
                }
            };
            entries.push(Entry {
                name,
                spec,
                exposure: if matches!(declaration, DynamicToolSpec::ApplyPatch | DynamicToolSpec::Computer(_)) {
                    ToolExposure::DirectModelOnly
                } else if tool.defer_loading {
                    ToolExposure::Deferred
                } else {
                    ToolExposure::Direct
                },
            });
        }
        Ok(Generation {
            id,
            schema_token,
            manual_slots: None,
            defaults: (0..entries.len()).collect(),
            entries,
            specs,
            terminal_slots: HashSet::new(),
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
        seed.terminal_slots = current.terminal_slots.clone();
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
        mut terminal: Option<TerminalSlots>,
        allocate_generation: bool,
    ) -> Result<u64> {
        // SDK callers hold the native mutation transaction across allocation and
        // publication. Voice admissions may have consumed intervening IDs.
        let id = if allocate_generation {
            if let Some(config) = terminal.as_ref() {
                ensure!(
                    config.generation == id.to_string(),
                    "Expired terminal replacement generation"
                );
            }
            let next = self
                .generation_high_water()
                .checked_add(1)
                .context("Python tool generation counter exhausted")?;
            if let Some(config) = terminal.as_mut() {
                config.generation = next.to_string();
            }
            next
        } else {
            id
        };
        let terminal_slots = if let Some(config) = terminal {
            ensure!(
                config.generation == id.to_string(),
                "Expired terminal replacement generation"
            );
            config.slots
        } else {
            Vec::new()
        };
        if let Some(id) = crate::agent_profiles::replace_tools(
            thread,
            id,
            specs.clone(),
            defaults.clone(),
            &terminal_slots,
        )
        .await?
        {
            return Ok(id);
        }
        let mut candidate = self.prepare(id, specs)?;
        for slot in terminal_slots {
            ensure!(
                slot < candidate.entries.len() && candidate.terminal_slots.insert(slot),
                "Invalid terminal tool slot"
            );
        }
        if let Some(defaults) = defaults {
            validate_selection(&defaults, &(0..candidate.entries.len()).collect::<Vec<_>>())?;
            candidate.defaults = defaults;
        }
        self.check_idle(thread).await?;
        self.check_family_idle()?;
        ensure!(
            id == self.allocate_generation()?,
            "JavaScript tool generation is out of sequence"
        );
        self.publish(candidate)
    }

    fn publish(&self, candidate: Generation) -> Result<u64> {
        let id = candidate.id;
        let high_water = self.generation_high_water.load(Ordering::Acquire);
        let mut current = self.current.write().expect("JavaScript catalog poisoned");
        ensure!(
            id > current.id && id <= high_water,
            "JavaScript tool generation is out of sequence"
        );
        let candidate = Arc::new(candidate);
        self.schema_receipts.register(&candidate);
        self.register_generation(&candidate)?;
        *current = candidate;
        *self.manual.lock().expect("manual tools poisoned") = ManualLedger::default();
        Ok(id)
    }

    pub async fn check_idle(&self, thread: &CodexThread) -> Result<()> {
        self.check_native_idle(thread).await?;
        ensure!(
            !self.has_restored_manual(),
            "Manual continuation still owns the native batch"
        );
        Ok(())
    }

    pub(crate) async fn check_restored_manual_idle(&self, thread: &CodexThread) -> Result<()> {
        self.check_native_idle(thread).await?;
        ensure!(
            self.has_restored_manual(),
            "No restored manual continuation owns the snapshot"
        );
        Ok(())
    }

    async fn check_native_idle(&self, thread: &CodexThread) -> Result<()> {
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
                && self.resolve_generation(key.reply.generation).is_some()
                && self
                    .pending
                    .lock()
                    .expect("JavaScript replies poisoned")
                    .get(key)
                    .is_some_and(|call| !call.sender.is_closed()),
            "Expired or invalid managed JavaScript tool request"
        );
        Ok(())
    }

    // Private callback delivery/admission may deny ended work. Strict checkpoint checks above remain unchanged.
    pub(crate) fn admit_callback(&self, owner: &str, key: &PendingKey) -> Result<bool> {
        ensure!(
            key.reply.thread == owner
                && key.reply.instance == self.instance
                && self.resolve_generation(key.reply.generation).is_some(),
            "Expired or invalid managed JavaScript tool request"
        );
        let pending = self.pending.lock().expect("JavaScript replies poisoned");
        let Some(call) = pending.get(key) else {
            return Ok(false);
        };
        if call.retired || call.sender.is_closed() {
            return Ok(false);
        }
        Ok(match &call.deadline {
            Some(state) => state.admit(|| true).unwrap_or(false),
            None => true,
        })
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
                Some(FamilyRequest::CompletionFailed(owner, turn, request)) => {
                    if let (Some(owner), Some(turn)) = (owner.upgrade(), turn.upgrade())
                        && owner.failed_tool_notice_current(&turn, &request)
                    {
                        turn.deliver_tool_failure();
                        return request;
                    }
                }
                Some(FamilyRequest::Completion(owner, id, request)) => {
                    if owner
                        .upgrade()
                        .is_some_and(|owner| owner.completion_queued(id))
                    {
                        return request;
                    }
                }
                Some(FamilyRequest::Callback(request)) => return request,
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
                            .get(&key)
                            .is_some_and(|call| !call.sender.is_closed())
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

    /// Data from the exact native pending receipt, never SDK-observed call metadata.
    // Match take_reply liveness without consuming the exact sender. Some(None)
    // is a valid pending text reply; None is a missing or already-taken reply.
    // Entered effects may still settle after a model deadline, so this is not
    // the callback admission gate.
    pub(crate) fn native_media(&self, key: &PendingKey) -> Option<Option<NativeMediaContext>> {
        self.pending
            .lock()
            .expect("managed replies poisoned")
            .get(key)
            .filter(|call| call.callback.is_none() || !call.sender.is_closed())
            .map(|call| call.media.clone())
    }

    // Take the live sender only once. The binding retains it while its writer
    // commits the real result; a failed commit cannot be mistaken for success.
    pub(crate) fn take_reply(
        &self,
        owner: &str,
        key: &PendingKey,
    ) -> Result<Option<oneshot::Sender<ToolReply>>> {
        if key.reply.thread != owner {
            return Ok(None);
        }
        let mut pending = self.pending.lock().expect("JavaScript replies poisoned");
        Ok(match pending.get_mut(key) {
            Some(call) if call.callback.is_some() && !call.sender.is_closed() => {
                Some(std::mem::replace(&mut call.sender, closed_tool_sender()))
            }
            Some(call) if call.callback.is_some() => None,
            Some(_) => pending.remove(key).map(|call| call.sender),
            None => None,
        })
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
        media: Option<NativeMediaContext>,
        admission: Option<Arc<crate::turn_settlement::Turn>>,
    ) -> Result<(PendingKey, oneshot::Receiver<ToolReply>)> {
        self.enqueue_profile(
            thread, generation, slot, turn, call, arguments, source, model, media, admission, None,
            None, None,
        )
    }

    fn enqueue_profile(
        self: &Arc<Self>,
        thread: &str,
        generation: &Generation,
        slot: usize,
        turn: &str,
        call: &str,
        arguments: Value,
        source: &ToolCallSource,
        model: &str,
        media: Option<NativeMediaContext>,
        admission: Option<Arc<crate::turn_settlement::Turn>>,
        profile: Option<&codex_extension_api::AgentProfileReceipt>,
        manual: Option<bool>,
        realtime_tool_call: Option<Value>,
    ) -> Result<(PendingKey, oneshot::Receiver<ToolReply>)> {
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
                manual_grant: manual
                    .or_else(|| {
                        generation
                            .manual_slots
                            .as_ref()
                            .map(|slots| slots.contains(&slot))
                    })
                    .unwrap_or_else(|| self.is_manual(&entry.name))
                    .then(|| codex_core_api::ThreadId::new().to_string()),
            },
            turn: turn.to_owned(),
            call: call.to_owned(),
        };
        let invocation = self
            .family
            .next_step
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .map_err(|_| anyhow::anyhow!("Callback nonce exhausted"))?;
        let callback = key.reply.manual_grant.is_none().then(|| {
            CallbackRelease::new(
                json!({"kind":"tool","request":key,"invocation":invocation.to_string()}),
            )
        });
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
                "_sdk_realtime_tool_call":realtime_tool_call,
                "_sdk_realtime_tool_name":codex_extension_api::realtime_tool_wire_name(&entry.name),
                "_sdk_trace_context": codex_otel::current_span_w3c_trace_context()
            }
        });
        if let Some(callback) = &callback {
            request["msg"]["_sdk_callback"] = callback.receipt.clone();
        }
        if let Some(profile) = profile {
            request["msg"]["profile_id"] = json!(profile.profile_id);
            request["msg"]["profile_epoch"] = json!(profile.epoch);
        }
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
                    apply_patch_arguments: matches!(entry.spec, ToolSpec::ApplyPatch {}).then(|| request["msg"]["arguments"].to_string()),
                    computer_arguments: matches!(
                        entry.spec,
                        ToolSpec::Computer { .. } | ToolSpec::ComputerUsePreview { .. }
                    )
                    .then(|| request["msg"]["arguments"].to_string()),
                    media,
                    invocation,
                    retired: false,
                    callback,
                    _tracing: tracing,
                    deadline: admission.and_then(|turn| turn.capture_model_deadline()),
                    sender,
                    manual_request: key.reply.manual_grant.as_ref().map(|_| request.clone()),
                    _approval_receiver: None,
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
    completed: bool,
    invocation: u64,
}

impl Drop for PendingReply<'_> {
    fn drop(&mut self) {
        self.tools
            .retire_callback(&self.key, self.invocation, self.completed);
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
    // Captured from the original turn before model preparation, never resolved by wire ID.
    admission: Option<Arc<crate::turn_settlement::Turn>>,
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
                    if let Ok(child) = PythonTools::descendant(
                        &parent_tools,
                        control.incarnation.clone(),
                        policy,
                        input.spawning_step_store,
                    ) {
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
                    } else {
                        control.revoke();
                    }
                }
            }
            if let (Some(control), Some(tools)) = (
                input
                    .thread_store
                    .get::<crate::native_interception::Control>(),
                input.thread_store.get::<PythonTools>(),
            ) {
                control.bind_context_tools(&tools);
                let _ = tools.context_control.set(Arc::downgrade(&control));
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
                tools.finish_callbacks(None, None, true).await;
                tools.finish_step_callbacks(None, true).await;
                tools.retire_preparation(None);
                tools.retire_tool_completion(None);
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
    #[serde(default)]
    pub operation_declaration_source: Option<codex_extension_api::AgentProfileReceipt>,
}
#[derive(Clone)]
struct ActiveSelection {
    turn: String,
    generation: Arc<Generation>,
    slots: Option<Vec<usize>>,
    names: Option<Vec<ToolName>>,
    before_step: bool,
    prepare_request: bool,
    operation_declaration_source: Option<codex_extension_api::AgentProfileReceipt>,
}
struct PendingStep {
    source_cancellation: Option<tokio_util::sync::CancellationToken>,
    callback: Option<Arc<CallbackRelease>>,
    operation_generation: u64,
    turn: String,
    generation: u64,
    allowed: Vec<ToolName>,
    reply: context_callbacks::PreparationReply,
}
fn closed_step_sender() -> context_callbacks::PreparationReply {
    let (sender, receiver) = oneshot::channel();
    drop(receiver);
    context_callbacks::PreparationReply::Selection(sender)
}
fn take_pending_step(replies: &mut HashMap<u64, PendingStep>, id: u64) -> Option<PendingStep> {
    let pending = replies.remove(&id)?;
    if let Some(callback) = &pending.callback {
        replies.insert(
            id,
            PendingStep {
                source_cancellation: pending.source_cancellation.clone(),
                callback: Some(callback.clone()),
                operation_generation: pending.operation_generation,
                turn: pending.turn.clone(),
                generation: pending.generation,
                allowed: pending.allowed.clone(),
                reply: closed_step_sender(),
            },
        );
    }
    Some(pending)
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
    receipts: Arc<Mutex<HashSet<PendingKey>>>,
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
        self.tools.retire_step_callback(self.id);
    }
}

impl PythonTools {
    fn retire_selection(&self, turn: &str) {
        self.retire_preparation(Some(turn));
        self.retire_tool_completion(Some(turn));
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
            .retain(|_, pending| {
                if pending.turn != turn {
                    return true;
                }
                if let Some(callback) = &pending.callback {
                    drop(std::mem::replace(&mut pending.reply, closed_step_sender()));
                    self.cancel_step_callback(&pending.turn, callback);
                    !callback.released.load(Ordering::Acquire)
                } else {
                    false
                }
            });
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
                operation_declaration_source: selection.operation_declaration_source.clone(),
            })
    }

    pub(crate) fn validate_operation(&self, selection: &OperationSelection) -> Result<()> {
        ensure!(self.instance.is_none(), "Selection requires a root Session");
        let generation = self
            .resolve_generation(selection.generation.parse()?)
            .context("Expired selection generation")?;
        ensure!(
            !self.managed_profiles.load(Ordering::Acquire) || selection.before_step,
            "Managed Agent selection requires the source-aware SDK callback"
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
            && self.resolve_generation(pending.generation).is_some()
            && !pending.reply.is_closed()
            && if let Some(cancellation) = &pending.source_cancellation {
                !cancellation.is_cancelled()
                    && (active.is_none()
                        || (!pending.reply.is_selection()
                            && active.is_some_and(|active| {
                                active.turn == pending.turn
                                    && active.generation.id == pending.operation_generation
                            })))
            } else {
                active.is_some_and(|active| {
                    active.turn == pending.turn
                        && active.generation.id == pending.operation_generation
                })
            }
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

    pub(crate) fn stop_step(&self, owner: &str, response: StepReply) -> Result<bool> {
        let id = response.request_id.parse::<u64>()?;
        // Capture is inert and must not hold preparation locks while inspecting
        // the original turn's existing cancellation and cleanup ownership.
        let Ok(stop) = self.context_stop(&response.turn_id) else {
            return Ok(false);
        };
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
                pending.reply.is_selection()
                    && self.step_matches(owner, &response, active.as_ref(), pending)
            }) {
                return Ok(false);
            }
            take_pending_step(&mut replies, id).expect("checked step reply")
        };
        let context_callbacks::PreparationReply::Selection(reply) = pending.reply else {
            unreachable!()
        };
        // Claim the live preparation before cancellation can drop its receiver.
        // Native still joins the admitted callback before settling this turn.
        if reply.send(None).is_err() {
            return Ok(false);
        }
        stop.stop();
        Ok(true)
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
                pending.reply.is_selection()
                    && self.step_matches(owner, &response, active.as_ref(), pending)
            }) {
                return Ok(false);
            }
            take_pending_step(&mut replies, id).expect("checked step reply")
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
                operation_declaration_source: None,
            });
        }
        operation.and_then(|selection| {
            Some(ActiveSelection {
                turn: turn.to_owned(),
                generation: selection
                    .generation
                    .parse()
                    .ok()
                    .and_then(|id| self.resolve_generation(id))?,
                slots: selection.slots.clone(),
                names: selection.names.clone(),
                before_step: selection.before_step,
                prepare_request: selection.prepare_request,
                operation_declaration_source: selection.operation_declaration_source.clone(),
            })
        })
    }

    pub(crate) fn reply_step(&self, owner: &str, response: StepReply) -> Result<()> {
        let id = response.request_id.parse::<u64>()?;
        let pending = {
            let mut replies = self
                .step_replies
                .lock()
                .expect("JavaScript step replies poisoned");
            // A legacy selection reply must never consume another callback kind.
            ensure!(
                !replies
                    .get(&id)
                    .is_some_and(|pending| !pending.reply.is_selection()),
                "Invalid selection reply kind"
            );
            take_pending_step(&mut replies, id)
                .ok_or_else(|| anyhow::anyhow!("Expired step selection"))?
        };
        // Taking the sender consumes this receipt even when validation fails.
        ensure!(
            response.thread == owner
                && response.instance == self.instance
                && response.turn_id == pending.turn
                && response.generation == pending.generation.to_string()
                && self.resolve_generation(pending.generation).is_some()
                && pending
                    .source_cancellation
                    .as_ref()
                    .is_none_or(|token| !token.is_cancelled()
                        && self
                            .selection
                            .lock()
                            .expect("JavaScript selection poisoned")
                            .is_none()),
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
            let generation = self
                .resolve_generation(pending.generation)
                .context("Expired step source catalog")?;
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
        let context_callbacks::PreparationReply::Selection(reply) = pending.reply else {
            anyhow::bail!("Invalid selection reply kind");
        };
        Ok(reply.send(names).is_ok())
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
        receipts: Option<Arc<Mutex<HashSet<PendingKey>>>>,
        profile: Option<codex_extension_api::AgentProfileReceipt>,
        manual: Option<Arc<CapturedManualTools>>,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        slots
            .iter()
            .copied()
            .map(|slot| {
                let callback = Arc::new(PythonExecutor {
                    admission: thread
                        .get::<ModelPresentation>()
                        .and_then(|state| state.admission.clone()),
                    profile: profile.clone(),
                    manual: manual.clone(),
                    thread: thread.level_id().to_string(),
                    tools: tools.clone(),
                    generation: generation.clone(),
                    slot,
                    receipts: receipts.clone(),
                    use_deferred_specs,
                    code_mode_enabled: self.code_mode_enabled,
                })
                    as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>;
                crate::agent_profiles::wrap_handoff_callback(
                    thread,
                    profile.as_ref(),
                    slot,
                    callback,
                )
            })
            .collect()
    }
}

impl ToolContributor for PythonContributor {
    fn capture_realtime_tools(
        &self,
        input: codex_extension_api::RealtimeToolCaptureInput<'_>,
    ) -> std::result::Result<Option<codex_extension_api::RealtimeToolDeclarations>, String> {
        let Some(tools) = input.thread_store.get::<PythonTools>() else {
            return Ok(None);
        };
        let catalog = if let Some(retained) = input.retained_execution_data {
            retained
                .get::<ProfileCatalog>()
                .ok_or("Missing retained Realtime source catalog")?
                .as_ref()
                .clone()
        } else {
            if let Some(instructions) = input
                .thread_store
                .get::<crate::options::ThreadInstructions>()
            {
                instructions
                    .check_usable()
                    .map_err(|error| error.to_string())?;
            }
            tools
                .realtime_catalog(input.profile)
                .map_err(|error| error.to_string())?
        };
        tools
            .register_generation(&catalog.generation)
            .map_err(|error| error.to_string())?;
        let profile = if let Some(retained) = input.retained_execution_data {
            retained
                .get::<crate::native_interception::ProfileMcpSource>()
                .and_then(|source| source.receipt.clone())
        } else {
            input
                .profile
                .map(|source| source.receipt.clone())
                .or_else(|| {
                    tools
                        .inherited_source
                        .as_ref()
                        .map(|source| source.receipt.clone())
                })
        };
        let voice = input.profile.is_some_and(|profile| {
            profile
                .profile
                .data
                .get::<codex_extension_api::RealtimeVoiceProfileScope>()
                .is_some()
        });
        let allows = |name: &ToolName| voice || tools.policy.allows(name);
        let mut declarations = Vec::new();
        for (slot, (namespace, raw)) in functions(&catalog.generation.specs).into_iter().enumerate()
        {
            let entry = &catalog.generation.entries[slot];
            if !catalog.generation.defaults.contains(&slot)
                || catalog
                    .defaults
                    .as_ref()
                    .is_some_and(|names| !names.contains(&entry.name))
                || !allows(&entry.name)
                || entry.exposure == ToolExposure::Deferred
            {
                continue;
            }
            declarations.push(codex_extension_api::RealtimeToolDeclaration {
                native_name: entry.name.clone(),
                spec: codex_extension_api::PreparedToolPresentation {
                    namespace: namespace.map(|namespace| namespace.name.clone()),
                    name: raw.name.clone(),
                    kind: "function".into(),
                    strict: match &entry.spec {
                        ToolSpec::Function(function) => function.strict,
                        ToolSpec::Namespace(namespace) => match namespace.tools.as_slice() {
                            [ResponsesApiNamespaceTool::Function(function)] => function.strict,
                            _ => return Err("Unsupported Realtime namespace declaration".into()),
                        },
                        _ => return Err("Unsupported Realtime function declaration".into()),
                    },
                    defer_loading: Some(raw.defer_loading),
                    description: raw.description.clone(),
                    parameters: raw.input_schema.clone(),
                },
            });
        }
        if let Some(handoffs) = input.profile.and_then(|profile| {
            profile
                .profile
                .data
                .get::<codex_extension_api::AgentProfileHandoffTools>()
        }) {
            declarations.extend(
                crate::agent_profiles::realtime_handoff_declarations(
                    &handoffs,
                    input.thread_store,
                    profile.as_ref(),
                )
                .map_err(|error| error.to_string())?
                .into_iter()
                .filter(|declaration| allows(&declaration.native_name)),
            );
        }
        if let Some(binding) = input.mcp {
            for info in binding.tools() {
                let native_name = info.canonical_tool_name();
                let admitted = voice
                    || match &tools.policy.allowed_mcp_tools {
                        Some(selectors) => selectors.iter().any(|(server, raw, declared)| {
                            info.server_name == *server
                                && info.tool.name.as_ref() == raw.as_str()
                                && tools.policy.allows(declared)
                        }),
                        None => tools.policy.allows(&native_name),
                    };
                if !admitted {
                    continue;
                }
                let server = binding
                    .config()
                    .mcp_server_catalog
                    .server(&info.server_name)
                    .ok_or("Captured MCP declaration has no admitted server")?;
                if info.server_name == codex_mcp::CODEX_APPS_MCP_SERVER_NAME
                    && server.config().is_local_environment()
                    && matches!(
                        server.source(),
                        codex_mcp::McpServerSource::Compatibility { .. }
                            | codex_mcp::McpServerSource::Extension {
                                host_owned_apps: true,
                                ..
                            }
                    )
                {
                    return Err(
                        "Hosted Apps MCP is unavailable for native Realtime tool dispatch".into(),
                    );
                }
                if server
                    .config()
                    .omit_tools_from
                    .as_deref()
                    .unwrap_or_default()
                    .contains(&codex_protocol::config_types::ToolExposureSurface::Direct)
                {
                    continue;
                }
                let native = codex_tools::mcp_tool_to_responses_api_tool(
                    &native_name,
                    &info.tool,
                    server
                        .config()
                        .tool_input_schema_max_bytes
                        .map(|limit| limit.get()),
                )
                .map_err(|error| error.to_string())?;
                declarations.push(codex_extension_api::RealtimeToolDeclaration {
                    native_name: native_name.clone(),
                    spec: codex_extension_api::PreparedToolPresentation {
                        namespace: native_name.namespace.clone(),
                        name: native.name,
                        kind: "function".into(),
                        strict: native.strict,
                        defer_loading: None,
                        description: native.description,
                        parameters: Value::Object(info.tool.input_schema.as_ref().clone()),
                    },
                });
            }
        }
        let selection_id = codex_extension_api::realtime_tool_selection_id(
            input.thread_store.level_id(),
            catalog.generation.id,
            profile.as_ref(),
        );
        if let Some(retained) = input.retained_execution_data {
            let application_instructions = retained
                .get::<codex_extension_api::AgentProfileInstructions>()
                .ok_or("Missing retained Realtime instruction projection")?
                .text
                .clone();
            return Ok(Some(codex_extension_api::RealtimeToolDeclarations {
                selection_id,
                tools: declarations,
                execution_data: retained.clone(),
                application_instructions,
            }));
        }
        let mut execution_data = codex_extension_api::ExtensionDataInit::new();
        let manual_slots = catalog.generation.manual_slots.clone().unwrap_or_else(|| {
            catalog
                .generation
                .entries
                .iter()
                .enumerate()
                .filter_map(|(slot, entry)| tools.is_manual(&entry.name).then_some(slot))
                .collect()
        });
        execution_data.insert(CapturedManualTools {
            generation: catalog.generation.clone(),
            slots: manual_slots,
        });
        let catalog_generation = catalog.generation.id;
        execution_data.insert(catalog);
        let mut captured_mcp_source = None;
        if let Some(source) = input.profile {
            let policy = source
                .profile
                .data
                .get::<crate::native_interception::ProfileMcpPolicy>()
                .ok_or("Managed Realtime source has no captured MCP policy")?;
            execution_data.insert((*policy).clone());
            captured_mcp_source = Some(crate::native_interception::ProfileMcpSource {
                result_selection: None,
                receipt: Some(source.receipt.clone()),
                policy: Some(policy),
            });
            let selection = source
                .profile
                .data
                .get::<crate::mcp_result_control::Selection>()
                .ok_or("Managed Realtime source has no captured MCP result selection")?;
            execution_data.insert((*selection).clone());
        } else if let Some(source) = &tools.inherited_source {
            let policy = source
                .mcp_policy
                .clone()
                .ok_or("Managed child Realtime source has no captured MCP policy")?;
            execution_data.insert((*policy).clone());
            captured_mcp_source = Some(crate::native_interception::ProfileMcpSource {
                result_selection: None,
                receipt: Some(source.receipt.clone()),
                policy: Some(policy),
            });
            let selection = source
                .mcp_selection
                .clone()
                .ok_or("Managed child Realtime source has no captured MCP result selection")?;
            execution_data.insert(selection);
        } else {
            let inherited_mcp_source = input
                .thread_store
                .get::<crate::native_interception::ProfileMcpSource>();
            let source_bound = inherited_mcp_source.is_some();
            if let Some(source) = inherited_mcp_source {
                captured_mcp_source = Some((*source).clone());
            } else if let Some(control) = input
                .thread_store
                .get::<crate::native_interception::Control>()
            {
                captured_mcp_source = Some(control.capture_mcp_source());
            } else if input.mcp.is_some_and(|binding| !binding.tools().is_empty()) {
                return Err("Realtime MCP source has no admitted SDK policy owner".into());
            }
            if let Some(selection) = input
                .thread_store
                .get::<crate::mcp_result_control::Selection>()
            {
                execution_data.insert((*selection).clone());
            } else if !source_bound {
                if let Some(control) = input
                    .thread_store
                    .get::<crate::mcp_result_control::McpResultControl>()
                {
                    if let Some(selection) = control.capture_source_selection() {
                        execution_data.insert(selection);
                    }
                }
            }
        }
        if let Some(mut source) = captured_mcp_source {
            let additional = if source.receipt.is_none() {
                input
                    .thread_store
                    .get::<crate::native_interception::RealtimeMcpPolicy>()
            } else {
                None
            };
            if let Some(policy) = &source.policy {
                let generation = source
                    .result_selection
                    .as_ref()
                    .map_or(catalog_generation, |selection| selection.generation);
                let policy = policy.for_realtime(generation, additional.as_deref());
                execution_data.insert(policy.clone());
                source.policy = Some(Arc::new(policy));
            }
            execution_data.insert(source);
        }
        let accepted = if let Some(profile) = input.profile {
            Some(
                profile
                    .profile
                    .data
                    .get::<crate::application_instructions::Accepted>()
                    .ok_or("Managed Realtime source has no captured application instructions")?
                    .as_ref()
                    .clone(),
            )
        } else {
            input
                .thread_store
                .get::<crate::options::ThreadInstructions>()
                .and_then(|instructions| instructions.accepted())
        };
        let application_instructions = accepted.as_ref().map(|accepted| accepted.text.clone());
        if let Some(accepted) = accepted {
            execution_data.insert(accepted);
        }
        execution_data.insert(codex_extension_api::AgentProfileInstructions {
            text: application_instructions.clone(),
        });
        Ok(Some(codex_extension_api::RealtimeToolDeclarations {
            selection_id,
            tools: declarations,
            execution_data,
            application_instructions,
        }))
    }

    fn tools(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Some(tools) = thread.get::<PythonTools>() else {
            return Vec::new();
        };
        if tools.managed_profiles.load(Ordering::Acquire) {
            return Vec::new();
        }
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
            None,
            None,
            None,
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
        if let Some(source) = &tools.inherited_source {
            if let Some(selection) = &source.mcp_selection {
                step.insert(selection.clone());
            }
            if let Some(policy) = &source.mcp_policy {
                step.insert((**policy).clone());
            }
        }
        let Ok(generation) = tools.generation_for_step(Some(step)) else {
            return Vec::new();
        };
        let Ok(profile) = tools.source_profile(Some(step)) else {
            return Vec::new();
        };
        if let Some(receipt) = &profile {
            step.insert(crate::native_interception::ProfileMcpSource {
                result_selection: None,
                receipt: Some(receipt.clone()),
                policy: step.get::<crate::native_interception::ProfileMcpPolicy>(),
            });
        }
        if profile.is_none() {
            let binding = step.get::<Arc<codex_mcp::McpBinding>>();
            if let Some(source) = step.get::<crate::native_interception::ProfileMcpSource>() {
                // The Realtime draft captures policy before resolving its peer binding.
                if source.receipt.is_none()
                    && step
                        .get::<codex_extension_api::ToolsOnlyWorkCancellation>()
                        .is_some()
                    && let Some(binding) = &binding
                {
                    let source = (*source).clone().for_binding(binding, &tools.policy);
                    if let Some(policy) = &source.policy {
                        step.insert((**policy).clone());
                    }
                    step.insert(source);
                }
            } else if let Some(source) =
                thread.get::<crate::native_interception::ProfileMcpSource>()
            {
                step.insert((*source).clone());
            } else if let Some(control) = thread.get::<crate::native_interception::Control>() {
                step.insert(match binding {
                    Some(binding) => {
                        control.capture_mcp_source_for_binding(&binding, &tools.policy)
                    }
                    None => control.capture_mcp_source(),
                });
            }
        }
        let snapshot = step.get_or_init(|| {
            let active = tools
                .selection
                .lock()
                .expect("JavaScript selection poisoned")
                .clone();
            let slots = if profile.is_some() {
                (0..generation.entries.len()).collect()
            } else {
                match active {
                    // Register the stable executors before Core assembles candidates.
                    // Core's selected plan narrows every family after the async hook.
                    Some(active) if active.names.is_some() => {
                        (0..generation.entries.len()).collect()
                    }
                    Some(active) => active.slots.unwrap_or_else(|| generation.defaults.clone()),
                    None => generation.defaults.clone(),
                }
            };
            StepCatalog {
                receipts: Arc::default(),
                generation,
                slots,
                use_deferred_specs: thread
                    .get::<ModelPresentation>()
                    .is_some_and(|presentation| presentation.use_deferred_specs),
            }
        });
        if tools.register_generation(&snapshot.generation).is_err() {
            return Vec::new();
        }
        let manual = step.get::<CapturedManualTools>();
        if manual
            .as_ref()
            .is_some_and(|manual| !Arc::ptr_eq(&manual.generation, &snapshot.generation))
        {
            return Vec::new();
        }
        self.executors(
            thread,
            tools,
            snapshot.generation.clone(),
            snapshot.use_deferred_specs,
            &snapshot.slots,
            Some(snapshot.receipts.clone()),
            profile,
            manual,
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
            let profile = tools
                .source_profile(Some(step))
                .map_err(|error| error.to_string())?;
            let generation = tools
                .generation_for_step(Some(step))
                .map_err(|error| error.to_string())?;
            let active = tools
                .selection
                .lock()
                .expect("JavaScript selection poisoned")
                .clone();
            let cancellation = step.get::<codex_extension_api::ToolsOnlyWorkCancellation>();
            let resolves_mcp_names = tools
                .policy
                .allowed_mcp_tools
                .as_ref()
                .is_some_and(|tools| !tools.is_empty());
            let source_owned = active.is_none()
                && cancellation.is_some()
                && step.get::<ProfileCatalog>().is_some_and(|catalog| {
                    catalog.selecting_steps || (profile.is_some() && resolves_mcp_names)
                });
            if let Some(active) = &active {
                if active.turn != turn.level_id() || !tools.admits_generation(&active.generation) {
                    return Err("Expired step selection owner or generation".into());
                }
            } else if !source_owned && profile.is_none() {
                return Ok(None);
            }
            let catalog = step.get::<StepCatalog>().ok_or("Missing step catalog")?;
            if !Arc::ptr_eq(&catalog.generation, &generation) {
                return Err("Expired step catalog generation".into());
            }
            let allowed = if profile.is_some() {
                candidates.to_vec()
            } else if let Some(names) = active.as_ref().and_then(|active| active.names.as_ref()) {
                let names = match step.get::<Arc<codex_mcp::McpBinding>>() {
                    Some(binding) => names
                        .iter()
                        .filter_map(|name| tools.policy.resolve_mcp_reference(name, &binding))
                        .collect::<Vec<_>>(),
                    None => names.clone(),
                };
                validate_names(&names, candidates).map_err(|error| error.to_string())?;
                expand_step_helpers(names, candidates)
            } else {
                // Legacy slots narrow managed tools; other admitted families keep
                // their opening policy. Native-aware callers use explicit names.
                candidates.to_vec()
            };
            // Idle defaults choose the inherited tool set, not the ceiling for an
            // explicit beforeStep choice from this captured catalog.
            let defaults = (profile.is_some()
                && active.as_ref().is_none_or(|active| active.names.is_none()))
            .then(|| {
                let nondefault = generation
                    .entries
                    .iter()
                    .enumerate()
                    .filter(|(slot, _)| !generation.defaults.contains(slot))
                    .map(|(_, entry)| entry.name.clone().with_default_namespace())
                    .collect::<HashSet<_>>();
                allowed
                    .iter()
                    .filter(|name| !nondefault.contains(&(*name).clone().with_default_namespace()))
                    .cloned()
                    .collect::<Vec<_>>()
            });
            if !source_owned
                && !active.as_ref().is_some_and(|active| active.before_step)
                && !resolves_mcp_names
            {
                return Ok(Some(defaults.unwrap_or(allowed)));
            }
            let id = tools
                .family
                .next_step
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                    value.checked_add(1)
                })
                .map_err(|_| "Callback nonce exhausted")?;
            let callback = cancellation.as_ref().map(|_| {
                let mut receipt =
                    json!({"kind":"preparation","thread":thread.level_id(),"id":id.to_string()});
                if let Some(instance) = &tools.instance {
                    receipt["instance"] = json!(instance);
                }
                CallbackRelease::new(receipt)
            });
            let (reply, receive) = oneshot::channel();
            {
                // Retirement uses this same lock order. Install the nonce only
                // while its original root still owns the active selection.
                let current = tools
                    .selection
                    .lock()
                    .expect("JavaScript selection poisoned");
                let admitted = if let Some(active) = &active {
                    current.as_ref().is_some_and(|current| {
                        current.turn == active.turn
                            && Arc::ptr_eq(&current.generation, &active.generation)
                    })
                } else {
                    source_owned
                        && current.is_none()
                        && cancellation
                            .as_ref()
                            .is_some_and(|token| !token.0.is_cancelled())
                };
                if !admitted {
                    return Err("Expired step selection owner".into());
                }
                tools
                    .step_replies
                    .lock()
                    .expect("JavaScript step replies poisoned")
                    .insert(
                        id,
                        PendingStep {
                            source_cancellation: source_owned.then(|| {
                                cancellation
                                    .as_ref()
                                    .expect("source cancellation")
                                    .0
                                    .clone()
                            }),
                            callback: callback.clone(),
                            turn: turn.level_id().to_owned(),
                            operation_generation: active
                                .as_ref()
                                .map_or(generation.id, |active| active.generation.id),
                            generation: generation.id,
                            allowed: allowed.clone(),
                            reply: context_callbacks::PreparationReply::Selection(reply),
                        },
                    );
            }
            let _wait = StepWait {
                tools: tools.clone(),
                id,
            };
            let mcp_names = step
                .get::<Arc<codex_mcp::McpBinding>>()
                .map(|binding| {
                    binding
                        .tools()
                        .iter()
                        .filter_map(|tool| {
                            let name = tool.canonical_tool_name();
                            allowed.contains(&name).then(|| {
                                json!({
                                    "server": tool.server_name, "tool": tool.tool.name,
                                    "namespace": name.namespace, "name": name.name,
                                })
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let tracing = if tools.instance.is_some() {
                turn.get::<codex_otel::sdk_trace::CapturedContext>()
                    .and_then(|captured| captured.context.as_ref().map(|lease| lease.retain()))
            } else {
                codex_otel::sdk_trace::ContextLease::capture()
            };
            let mut request = json!({"id": turn.level_id(), "msg": {
                "type": "_sdk_select_step", "turn_id": turn.level_id(),
                "thread": thread.level_id(), "native_step": step.level_id(),
                "request_id": id.to_string(), "generation": generation.id.to_string(),
                "candidates": allowed, "mcp_names": mcp_names
            }});
            if let Some(defaults) = defaults {
                request["msg"]["defaults"] = json!(defaults);
            }
            if let Some(callback) = &callback {
                request["msg"]["_sdk_callback"] = callback.receipt.clone();
            }
            if let Some(initial) = turn.get::<codex_extension_api::InitialTurnInput>() {
                if let Some(records) = &initial.0 {
                    request["msg"]["initial_input"] = json!(records);
                }
            }
            if let Some(profile) = profile {
                request["msg"]["profile_id"] = json!(profile.profile_id);
                request["msg"]["profile_epoch"] = json!(profile.epoch);
            }
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
            let received = if let Some(cancellation) = &cancellation {
                tokio::select! {biased;
                    _=cancellation.0.cancelled()=>{tools.retire_step_callback(id);Err("Step selection cancelled")},
                    result=receive=>result.map_err(|_|"Step selection cancelled"),
                }
            } else {
                receive.await.map_err(|_| "Step selection cancelled")
            };
            if let Some(callback) = &callback {
                // A native-only consumer can reply without claiming an SDK callback.
                // The closed reply fences any later claim under this same mutex.
                {
                    let replies = tools.step_replies.lock().expect("Step replies poisoned");
                    if replies
                        .get(&id)
                        .is_some_and(|pending| pending.reply.is_closed())
                        && !callback.entered.load(Ordering::Acquire)
                    {
                        callback.release();
                    }
                }
                if received.is_err() {
                    tools.retire_step_callback(id);
                }
                if let Some(cancellation) = &cancellation {
                    tokio::select! {biased;
                        _=cancellation.0.cancelled()=>{tools.retire_step_callback(id);callback.wait().await;},
                        _=callback.wait()=>{},
                    }
                } else {
                    callback.wait().await;
                }
                tools
                    .step_replies
                    .lock()
                    .expect("Step replies poisoned")
                    .remove(&id);
            }
            if cancellation
                .as_ref()
                .is_some_and(|token| token.0.is_cancelled())
            {
                return Err("Step selection cancelled".into());
            }
            let names = received
                .map_err(|_| "Step selection cancelled")?
                .ok_or("Step selection failed")?;
            let current = tools
                .selection
                .lock()
                .expect("JavaScript selection poisoned");
            let admitted = if let Some(active) = &active {
                tools.admits_generation(&active.generation)
                    && current.as_ref().is_some_and(|current| {
                        current.turn == active.turn
                            && Arc::ptr_eq(&current.generation, &active.generation)
                    })
            } else {
                source_owned
                    && current.is_none()
                    && tools.admits_generation(&generation)
                    && cancellation
                        .as_ref()
                        .is_some_and(|token| !token.0.is_cancelled())
            };
            if !admitted {
                return Err("Expired step selection owner or generation".into());
            }
            Ok(Some(names))
        })
    }
}

struct PythonExecutor {
    admission: Option<Arc<crate::turn_settlement::Turn>>,
    manual: Option<Arc<CapturedManualTools>>,
    profile: Option<codex_extension_api::AgentProfileReceipt>,
    thread: String,
    tools: Arc<PythonTools>,
    generation: Arc<Generation>,
    slot: usize,
    use_deferred_specs: bool,
    code_mode_enabled: bool,
    receipts: Option<Arc<Mutex<HashSet<PendingKey>>>>,
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

    fn on_result_accepted(
        &self,
        _: &str,
        _: &str,
        result: &dyn ToolOutput,
    ) -> codex_tools::AcceptedToolOutcome {
        codex_tools::AcceptedToolOutcome {
            start_response: result.realtime_response_requested(),
            ..Default::default()
        }
    }

    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        ToolCall<'call>: 'a,
    {
        Box::pin(async move {
            if matches!(self.spec(), ToolSpec::ApplyPatch {})
                && (!matches!(call.payload, ToolPayload::ApplyPatch { .. }) || call.source != ToolCallSource::Direct)
            {
                return Err(FunctionCallError::Fatal("Application patch requires its native direct call payload".into()));
            }

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
                .enqueue_profile(
                    &self.thread,
                    &self.generation,
                    self.slot,
                    &call.turn_id,
                    &call.call_id,
                    arguments,
                    &call.source,
                    &call.model,
                    Some(NativeMediaContext {
                        model_info: Arc::clone(&call.model_info),
                        profile: call.provider_reference_profile,
                        inline_data_url_low_detail_supported: call
                            .inline_data_url_low_detail_supported,
                    }),
                    self.admission.clone(),
                    self.profile.as_ref(),
                    self.manual
                        .as_ref()
                        .map(|manual| manual.slots.contains(&self.slot)),
                    call.conversation_history.realtime_tool_call().cloned(),
                )
                .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
            let mut reply_guard = PendingReply {
                tools: &self.tools,
                key: key.clone(),
                completed: false,
                invocation: self
                    .tools
                    .pending
                    .lock()
                    .expect("Callback pending poisoned")
                    .get(&key)
                    .map_or(0, |call| call.invocation),
            };
            let response = match receiver.await {
                Ok(response) => {
                    reply_guard.completed = true;
                    response
                }
                Err(_) if matches!(call.payload, ToolPayload::ApplyPatch { .. } | ToolPayload::Computer { .. }) => {
                    return Err(FunctionCallError::Fatal(
                        "Computer call cancelled before reply".into(),
                    ));
                }
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
            if response.response.success
                && call.source == ToolCallSource::Direct
                && self.tools.admits_generation(&self.generation)
                && self.tools.current_completion_owner(&self.thread)
                && let Some(receipts) = &self.receipts
            {
                receipts
                    .lock()
                    .expect("JavaScript completion receipts poisoned")
                    .insert(key);
            }
            if let ToolPayload::ApplyPatch { arguments } = &call.payload {
                return Ok(Box::new(codex_tools::ApplyPatchToolOutput::from_dynamic_response(arguments, response.response)?) as Box<dyn ToolOutput>);
            }
            if let ToolPayload::Computer { arguments } = &call.payload {
                return Ok(Box::new(RealtimeToolOutput {
                    output: codex_tools::ComputerToolOutput::from_dynamic_response(
                        arguments,
                        response.response,
                    )?,
                    start_response: response.start_response,
                    acceptance: response.acceptance,
                }) as Box<dyn ToolOutput>);
            }
            Ok(Box::new(RealtimeToolOutput {
                output: PythonOutput(response.response),
                start_response: response.start_response,
                acceptance: response.acceptance,
            }) as Box<dyn ToolOutput>)
        })
    }
}

pub(crate) struct PythonOutput(pub(crate) DynamicToolResponse);

struct RealtimeToolOutput<T: ToolOutput> {
    output: T,
    start_response: bool,
    acceptance: Option<oneshot::Sender<()>>,
}
impl<T: ToolOutput> ToolOutput for RealtimeToolOutput<T> {
    fn log_output(&self) -> String {
        self.output.log_output()
    }
    fn success_for_logging(&self) -> bool {
        self.output.success_for_logging()
    }
    fn contains_external_context(&self) -> bool {
        self.output.contains_external_context()
    }
    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        self.output.to_response_item(call_id, payload)
    }
    fn realtime_response_requested(&self) -> bool {
        self.start_response
    }
    fn mark_accepted(&mut self) {
        self.output.mark_accepted();
        if let Some(acceptance) = self.acceptance.take() {
            let _ = acceptance.send(());
        }
    }
}

impl ToolLifecycleContributor for PythonContributor {
    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if let Some(tools) = input.thread_store.get::<PythonTools>() {
                // A rejected duplicate shares a call ID, not the original invocation.
                // PendingReply already retires and cancels its exact owner on drop.
                tools
                    .finish_callbacks(Some(input.turn_id), Some(input.call_id), false)
                    .await;
            }
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
    fn hold_tool_completion(&self, input: codex_extension_api::ToolCompletionInput<'_>) -> bool {
        terminal_completion::hold(input)
    }

    fn before_turn_complete<'a>(
        &'a self,
        input: codex_extension_api::TurnCompletionInput<'a>,
    ) -> ExtensionFuture<'a, std::result::Result<Option<String>, String>> {
        Box::pin(async move {
            let Some(tools) = input.thread_store.get::<PythonTools>() else {
                return Ok(None);
            };
            tools
                .before_complete(input)
                .await
                .map_err(|_| "Completion callback failed".to_owned())
        })
    }

    fn propose_tool_completion<'a>(
        &'a self,
        input: codex_extension_api::ToolCompletionInput<'a>,
    ) -> ExtensionFuture<
        'a,
        std::result::Result<Option<codex_extension_api::ToolCompletionDecision>, String>,
    > {
        Box::pin(terminal_completion::propose(input))
    }
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(seed) = input.turn_store.get::<RecoveredToolCompletionSeed>() {
                seed.consume(&input);
            }

            if let Some(tools) = input.thread_store.get::<PythonTools>() {
                if tools.instance.is_some() && tools.child_before_step {
                    input
                        .turn_store
                        .get_or_init(codex_extension_api::InitialTurnInput::default);
                }

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
                input.thread_store.insert(ModelPresentation {
                    admission: input.turn_store.get::<crate::turn_settlement::Turn>(),
                    use_deferred_specs,
                });
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
                    .finish_step_callbacks(Some(input.turn_store.level_id()), true)
                    .await;
                tools
                    .step_replies
                    .lock()
                    .expect("JavaScript step replies poisoned")
                    .retain(|_, pending| pending.turn != input.turn_store.level_id());
                tools.retire_preparation(Some(input.turn_store.level_id()));
                tools.retire_tool_completion(Some(input.turn_store.level_id()));
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

    #[test]
    fn computer_output_preserves_external_context_and_acceptance() {
        let arguments = json!({"type":"computer_call","call_id":"computer-data","actions":[{"type":"screenshot"}],"pending_safety_checks":[]}).to_string();
        let response = serde_json::from_value(json!({"success":true,"contentItems":[{"type":"inputText","text":json!({"output":{"type":"computer_screenshot","image_url":"data:image/png;base64,aA=="},"acknowledged_safety_checks":[]}).to_string()}]})).unwrap();
        let (acceptance, mut accepted) = oneshot::channel();
        let mut output = RealtimeToolOutput {
            output: codex_tools::ComputerToolOutput::from_dynamic_response(&arguments, response)
                .unwrap(),
            start_response: true,
            acceptance: Some(acceptance),
        };
        assert!(output.contains_external_context());
        assert!(matches!(
            accepted.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        output.mark_accepted();
        assert_eq!(accepted.try_recv(), Ok(()));
    }

    #[test]
    fn response_scheduling_flag_stays_out_of_user_content() {
        let request = json!({"_sdk_python_tool":{"thread":"root","generation":0,"slot":0},"turnId":"turn","callId":"call"});
        let response = json!({"contentItems":[{"type":"inputText","text":"{\"start_response\":false}"}],"success":true});
        let default_reply: Reply =
            serde_json::from_value(json!({"request":request,"response":response})).unwrap();
        assert!(default_reply.start_response);
        let background: Reply = serde_json::from_value(
            json!({"request":request,"response":response,"start_response":false}),
        )
        .unwrap();
        let output = RealtimeToolOutput {
            output: PythonOutput(background.response),
            start_response: background.start_response,
            acceptance: None,
        };
        assert!(!output.realtime_response_requested());
        assert_eq!(output.log_output(), "{\"start_response\":false}");
        let foreground: ToolReply = default_reply.response.into();
        assert!(foreground.start_response);
    }

    // Exercise the actual registry and its lifetime owners without starting Core,
    // a runtime, a network service, or a native thread.
    #[test]
    fn realtime_capture_keeps_raw_default_declaration_and_original_generation_after_replace() {
        let mut owned = Arc::try_unwrap(tools()).ok().expect("exclusive fixture");
        owned.preserve_schemas = true;
        let raw_schema = json!({"type":"object","properties":{"email":{"type":"string","format":"email","examples":["a@example.com"]}},"required":["email"],"additionalProperties":false});
        let declaration = |name: &str, deferred: bool| {
            DynamicToolSpec::Function(DynamicToolFunctionSpec {
                strict: false,
                output_schema: None,
                name: name.into(),
                description: "Original clean description".into(),
                input_schema: raw_schema.clone(),
                defer_loading: deferred,
            })
        };
        let mut initial = owned
            .prepare(
                0,
                vec![
                    declaration("decision", false),
                    declaration("hidden", false),
                    declaration("deferred", true),
                ],
            )
            .unwrap();
        initial.defaults = vec![0, 2];
        assert!(initial.schema_token.is_some());
        *owned.current.write().unwrap() = Arc::new(initial);
        let thread = ExtensionData::new("root");
        thread.insert(owned);
        let instructions =
            crate::options::ThreadInstructions::for_test(Some("Accepted text".into()), true);
        instructions
            .confirm(crate::application_instructions::Accepted {
                id: codex_protocol::ResponseItemId::new("msg_sdk_application_capture"),
                text: "Accepted text".into(),
                files: Vec::new(),
            })
            .unwrap();
        thread.insert(instructions);
        let session = ExtensionData::new("session");
        let contributor = PythonContributor {
            manager: Weak::new(),
            models_config: Default::default(),
            code_mode_enabled: false,
        };
        let captured = contributor
            .capture_realtime_tools(codex_extension_api::RealtimeToolCaptureInput {
                session_store: &session,
                thread_store: &thread,
                profile: None,
                mcp: None,
                retained_execution_data: None,
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            captured.application_instructions.as_deref(),
            Some("Accepted text")
        );
        assert_eq!(captured.tools.len(), 1);
        assert_eq!(captured.tools[0].spec.name, "decision");
        assert_eq!(
            captured.tools[0].spec.description,
            "Original clean description"
        );
        assert_eq!(captured.tools[0].spec.parameters, raw_schema);
        let tools = thread.get::<PythonTools>().unwrap();
        assert!(tools.pending.lock().unwrap().is_empty());
        assert!(tools.step_replies.lock().unwrap().is_empty());
        let original = tools.snapshot();
        let next = tools.allocate_generation().unwrap();
        tools
            .publish(
                tools
                    .prepare(next, vec![declaration("replacement", false)])
                    .unwrap(),
            )
            .unwrap();
        thread
            .get::<crate::options::ThreadInstructions>()
            .unwrap()
            .confirm(crate::application_instructions::Accepted {
                id: codex_protocol::ResponseItemId::new("msg_sdk_application_replacement"),
                text: "Replacement text".into(),
                files: Vec::new(),
            })
            .unwrap();
        tools.configure_manual(Vec::new()).unwrap();
        assert!(!tools.is_manual(&original.entries[0].name));
        let projected = contributor
            .capture_realtime_tools(codex_extension_api::RealtimeToolCaptureInput {
                session_store: &session,
                thread_store: &thread,
                profile: None,
                mcp: None,
                retained_execution_data: Some(&captured.execution_data),
            })
            .unwrap()
            .unwrap();
        assert_eq!(projected.selection_id, captured.selection_id);
        assert_eq!(
            projected.application_instructions.as_deref(),
            Some("Accepted text")
        );
        assert_eq!(projected.tools[0].spec.name, "decision");
        let step = ExtensionData::new_with_init("original-source", captured.execution_data);
        assert_eq!(
            step.get::<crate::application_instructions::Accepted>()
                .unwrap()
                .text,
            "Accepted text"
        );
        let executors = contributor.tools_for_step(&session, &thread, &step);
        assert_eq!(
            executors
                .iter()
                .map(|executor| executor.tool_name().name)
                .collect::<Vec<_>>(),
            vec!["decision", "deferred"]
        );
        assert!(Arc::ptr_eq(
            &tools.generation_for_step(Some(&step)).unwrap(),
            &original
        ));
        assert_eq!(tools.source_profile(Some(&step)).unwrap(), None);
        assert!(!tools.managed_profiles.load(Ordering::Acquire));
        assert_eq!(tools.snapshot().entries[0].name.name, "replacement");
        let manual = step.get::<CapturedManualTools>().unwrap();
        let (key, mut waiting) = tools
            .enqueue_profile(
                "root",
                &original,
                0,
                "turn",
                "captured-manual",
                json!({}),
                &ToolCallSource::Direct,
                "fixture-model",
                None,
                None,
                None,
                Some(manual.slots.contains(&0)),
                None,
            )
            .unwrap();
        assert!(key.reply.manual_grant.is_some());
        assert!(tools.manual_tool_current("root", &key));
        assert_eq!(tools.pending_manual_tools(&owner()).len(), 1);
        assert!(matches!(
            waiting.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        tools
            .take_reply("root", &key)
            .unwrap()
            .unwrap()
            .send(
                DynamicToolResponse {
                    content_items: Vec::new(),
                    success: true,
                }
                .into(),
            )
            .unwrap();
        assert!(waiting.try_recv().unwrap().response.success);
    }

    pub(super) fn tools() -> Arc<PythonTools> {
        let tools = Arc::new(PythonTools {
            local_store: None,
            custom_store: None,
            preserve_schemas: false,
            schema_receipts: Default::default(),
            current: RwLock::new(Arc::new(Generation {
                id: 0,
                schema_token: None,
                manual_slots: None,
                entries: Vec::new(),
                specs: Vec::new(),
                defaults: Vec::new(),
                terminal_slots: HashSet::new(),
            })),
            generation_high_water: AtomicU64::new(0),
            profile_catalogs: RwLock::new(HashMap::new()),
            managed_profiles: AtomicBool::new(false),
            inherited_source: None,
            fixed: HashSet::new(),
            policy: Arc::default(),
            pending: Mutex::default(),
            family: Arc::default(),
            instance: None,
            inherit_children: true,
            child_before_step: false,
            context_control: OnceLock::new(),
            context_callbacks: ContextCallbacks::default(),
            manual: Mutex::default(),
            selection: Mutex::new(None),
            step_replies: Mutex::new(HashMap::new()),
            prepared: Mutex::new(None),
            completion_replies: Mutex::default(),
        });
        let specs = vec![DynamicToolSpec::Function(DynamicToolFunctionSpec {
            strict: false,
            output_schema: None,
            name: "decision".into(),
            description: "Choose.".into(),
            input_schema: json!({"type":"object","properties":{}}),
            defer_loading: false,
        })];
        *tools.current.write().unwrap() = Arc::new(tools.prepare(0, specs).unwrap());
        configure(&tools);
        tools
    }

    #[tokio::test]
    async fn native_receipt_metadata_does_not_reopen_a_consumed_sender() {
        let tools = tools();
        let model = Arc::new(codex_models_manager::model_info::model_info_from_slug(
            "gpt-5.5",
        ));
        let context = NativeMediaContext {
            model_info: Arc::clone(&model),
            profile: codex_protocol::provider_reference_profile::ProviderImageReferencePolicy::QualifiedStandardResponses,
            inline_data_url_low_detail_supported: true,
        };
        let source = ToolCallSource::CodeMode {
            cell_id: "1".into(),
            runtime_tool_call_id: "nested".into(),
        };
        let (key, _receive) = tools
            .enqueue(
                "root",
                &tools.snapshot(),
                0,
                "turn",
                "call",
                json!({}),
                &source,
                "gpt-5.5",
                Some(context),
                None,
            )
            .unwrap();
        // The existing pending owner retains data without a live root-turn query.
        let captured = tools.native_media(&key).unwrap().unwrap();
        assert!(Arc::ptr_eq(&captured.model_info, &model));
        assert!(captured.inline_data_url_low_detail_supported);
        let _sender = tools.take_reply("root", &key).unwrap().unwrap();
        assert!(tools.native_media(&key).is_none());
        assert!(tools.take_reply("root", &key).unwrap().is_none());
        // A detached metadata clone still carries no publication capability.
        assert_eq!(captured.model_info.slug, "gpt-5.5");
    }

    #[tokio::test]
    async fn pending_text_media_is_distinct_from_an_expired_media_reply() {
        let tools = tools();
        let (key, _receiver) = tools
            .enqueue(
                "root",
                &tools.snapshot(),
                0,
                "turn",
                "call",
                json!({}),
                &ToolCallSource::Direct,
                "gpt-5.5",
                None,
                None,
            )
            .unwrap();
        assert!(matches!(tools.native_media(&key), Some(None)));
        let sender = tools.take_reply("root", &key).unwrap().unwrap();
        assert!(tools.native_media(&key).is_none());
        assert!(tools.take_reply("root", &key).unwrap().is_none());
        drop(sender);

        let (cancelled, receiver) = tools
            .enqueue(
                "root",
                &tools.snapshot(),
                0,
                "turn",
                "cancelled",
                json!({}),
                &ToolCallSource::Direct,
                "gpt-5.5",
                None,
                None,
            )
            .unwrap();
        tools
            .pending
            .lock()
            .unwrap()
            .get_mut(&cancelled)
            .unwrap()
            .callback = Some(CallbackRelease::new(json!({})));
        assert!(matches!(tools.native_media(&cancelled), Some(None)));
        drop(receiver);
        assert!(tools.native_media(&cancelled).is_none());
        assert!(tools.take_reply("root", &cancelled).unwrap().is_none());
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

    #[tokio::test]
    async fn rejected_duplicate_finish_preserves_the_original_callback() {
        let (thread, tools) = selector_fixture(None);
        tools.configure_manual(Vec::new()).unwrap();
        let generation = tools.snapshot();
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("turn");
        let (key, mut receive) = tools
            .enqueue(
                "root",
                &generation,
                0,
                "turn",
                "call",
                json!({}),
                &ToolCallSource::Direct,
                "model",
                None,
                None,
            )
            .unwrap();
        assert!(
            tools
                .enqueue(
                    "root",
                    &generation,
                    0,
                    "turn",
                    "call",
                    json!({}),
                    &ToolCallSource::Direct,
                    "model",
                    None,
                    None,
                )
                .is_err()
        );
        let (invocation, receipt) = {
            let pending = tools.pending.lock().unwrap();
            let call = &pending[&key];
            (
                call.invocation,
                call.callback.as_ref().unwrap().receipt.clone(),
            )
        };
        for outcome in [
            ToolCallOutcome::Completed { success: false },
            ToolCallOutcome::Failed {
                handler_executed: true,
            },
            ToolCallOutcome::Aborted,
        ] {
            PythonContributor::default()
                .on_tool_finish(ToolFinishInput {
                    session_store: &session,
                    thread_store: &thread,
                    turn_store: &turn,
                    turn_id: "turn",
                    call_id: "call",
                    tool_name: &generation.entries[0].name,
                    source: ToolCallSource::Direct,
                    outcome,
                })
                .await;
            assert!(matches!(
                receive.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            assert!(!tools.callback_operation("root", &receipt, "cancelled"));
        }
        assert!(tools.callback_operation("root", &receipt, "enter"));
        tools.retire_callback(&key, invocation, false);
        assert!(receive.await.is_err());
        assert!(tools.callback_operation("root", &receipt, "release"));
        tools
            .finish_callbacks(Some("turn"), Some("call"), false)
            .await;
        assert!(tools.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn scoped_automatic_callback_waits_for_physical_release_and_keeps_sibling_live() {
        let tools = tools();
        tools.configure_manual(Vec::new()).unwrap();
        let generation = tools.snapshot();
        let (a, mut a_receive) = tools
            .enqueue(
                "root",
                &generation,
                0,
                "turn",
                "a",
                json!({}),
                &ToolCallSource::Direct,
                "model",
                None,
                None,
            )
            .unwrap();
        let first = tools.next_request().await;
        let receipt = first["msg"]["_sdk_callback"].clone();
        assert_eq!(receipt["kind"], "tool");
        assert!(tools.callback_operation("root", &receipt, "enter"));
        assert!(!tools.callback_operation("root", &receipt, "enter"));
        let (b, _b_receive) = tools
            .enqueue(
                "root",
                &generation,
                0,
                "turn",
                "b",
                json!({}),
                &ToolCallSource::Direct,
                "model",
                None,
                None,
            )
            .unwrap();
        let _ = tools.next_request().await;
        let owned = tools.clone();
        let join = tokio::spawn(async move {
            owned.finish_callbacks(Some("turn"), Some("a"), true).await;
        });
        let cancelled = tools.next_request().await;
        assert_eq!(cancelled["msg"]["type"], "_sdk_callback_cancel");
        assert_eq!(cancelled["msg"]["receipt"], receipt);
        assert!(tools.callback_operation("root", &receipt, "cancelled"));
        assert!(matches!(
            a_receive.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(tools.check_pending("root", &a).is_err());
        assert!(tools.check_pending("root", &b).is_ok());
        assert!(!join.is_finished());
        assert!(tools.callback_operation("root", &receipt, "release"));
        join.await.unwrap();
        assert!(!tools.callback_operation("root", &receipt, "enter"));
        tools.finish_callbacks(None, None, true).await;
    }

    #[tokio::test]
    async fn realtime_source_selector_without_root_selection_joins_reply_and_cancellation() {
        for cancel in [false, true] {
            let (thread, tools) = selector_fixture(None);
            *tools.selection.lock().unwrap() = None;
            let generation = tools.snapshot();
            let cancellation = tokio_util::sync::CancellationToken::new();
            let token = cancellation.clone();
            let join = tokio::spawn(async move {
                let session = ExtensionData::new("session");
                let turn = ExtensionData::new("turn");
                let step = ExtensionData::new("realtime-source-step");
                step.insert(ProfileCatalog {
                    generation: generation.clone(),
                    defaults: None,
                    selecting_steps: true,
                    transform_context: false,
                    before_compact: false,
                    before_complete: false,
                });
                step.insert(StepCatalog {
                    generation,
                    slots: vec![0],
                    use_deferred_specs: false,
                    receipts: Default::default(),
                });
                let candidates = vec![ToolName::plain("decision")];
                let contributor = PythonContributor::default();
                // A source catalog alone does not change ordinary root admission.
                assert!(
                    contributor
                        .select_tools_for_step(&session, &thread, &turn, &step, &candidates)
                        .await
                        .unwrap()
                        .is_none()
                );
                step.insert(codex_extension_api::ToolsOnlyWorkCancellation(token));
                contributor
                    .select_tools_for_step(&session, &thread, &turn, &step, &candidates)
                    .await
            });
            let request =
                tokio::time::timeout(std::time::Duration::from_secs(1), tools.next_request())
                    .await
                    .expect("Realtime source selector did not dispatch");
            assert_eq!(request["msg"]["type"], "_sdk_select_step");
            let receipt = request["msg"]["_sdk_callback"].clone();
            assert!(receipt.get("instance").is_none());
            assert!(tools.callback_operation("root", &receipt, "enter"));
            let response = StepReply {
                request_id: request["msg"]["request_id"].as_str().unwrap().to_owned(),
                names: Some(vec![ToolName::plain("decision")]),
                ..step_reply("turn", "0", None)
            };
            assert!(tools.check_step("root", &response).unwrap());
            if cancel {
                cancellation.cancel();
                // This test runs on the current-thread runtime: the selector has
                // not polled cancellation or emitted its cancel notice yet.
                assert!(tools.callback_operation("root", &receipt, "cancelled"));
                let notice =
                    tokio::time::timeout(std::time::Duration::from_secs(1), tools.next_request())
                        .await
                        .unwrap();
                assert_eq!(notice["msg"]["receipt"], receipt);
                assert!(tools.callback_operation("root", &receipt, "cancelled"));
                assert!(!tools.check_step("root", &response).unwrap());
            } else {
                tools.reply_step("root", response).unwrap();
            }
            assert!(!join.is_finished());
            assert!(tools.callback_operation("root", &receipt, "release"));
            let result = join.await.unwrap();
            if cancel {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap(), Some(vec![ToolName::plain("decision")]));
            }
            assert!(tools.step_replies.lock().unwrap().is_empty());
            assert!(tools.selection.lock().unwrap().is_none());
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
                None,
                None,
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
                None,
                None,
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
                None,
                None,
            )
            .unwrap();
        let guard = PendingReply {
            tools: &tools,
            key: key.clone(),
            completed: false,
            invocation: tools.pending.lock().unwrap().get(&key).unwrap().invocation,
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
            None,
            None,
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
                None,
                None,
            )
            .unwrap();
        let invocation = tools.pending.lock().unwrap().get(&old).unwrap().invocation;
        drop(PendingReply {
            tools: &tools,
            key: old.clone(),
            completed: false,
            invocation,
        });
        assert!(matches!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(tools.pending.lock().unwrap().is_empty());
        let specs = tools.snapshot().specs.clone();
        assert_eq!(tools.allocate_generation().unwrap(), 1);
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
                None,
                None,
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
        let old =
            Arc::new(PythonTools::descendant(&root, "old".into(), Arc::default(), None).unwrap());
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
                None,
                None,
            )
            .unwrap();
        assert!(root.owner("root", &old_key).is_some());
        let new =
            Arc::new(PythonTools::descendant(&root, "new".into(), Arc::default(), None).unwrap());
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
                None,
                None,
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
                source_cancellation: None,
                callback: None,
                operation_generation: 0,
                turn: "turn".into(),
                generation: 0,
                allowed: vec![tools.snapshot().entries[0].name.clone()],
                reply: context_callbacks::PreparationReply::Selection(reply),
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
            operation_declaration_source: None,
        });
        (thread, tools)
    }

    fn child_selector_fixture() -> (Arc<PythonTools>, ExtensionData, Arc<PythonTools>) {
        let mut root = tools();
        Arc::get_mut(&mut root).unwrap().child_before_step = true;
        let thread = ExtensionData::new("child");
        let child = thread.get_or_init(|| {
            PythonTools::descendant(&root, "incarnation".into(), Arc::default(), None).unwrap()
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
            operation_declaration_source: None,
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
            PythonTools::descendant(&tools(), "disabled".into(), Arc::default(), None).unwrap();
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
                source_cancellation: None,
                callback: None,
                operation_generation: 0,
                turn: "child-turn".into(),
                generation: 0,
                allowed: vec![ToolName::plain("decision")],
                reply: context_callbacks::PreparationReply::Selection(reply),
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
        let successor = Arc::new(
            PythonTools::descendant(&root, "successor".into(), Arc::default(), None).unwrap(),
        );
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
            operation_declaration_source: None,
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
            strict: false,
            output_schema: None,
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
                operation_declaration_source: operation.operation_declaration_source.clone(),
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
        assert_eq!(tools.allocate_generation().unwrap(), generation.id);
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
                    source_cancellation: None,
                    callback: None,
                    operation_generation: 0,
                    turn: "next".into(),
                    generation: 0,
                    allowed: vec![tools.snapshot().entries[0].name.clone()],
                    reply: context_callbacks::PreparationReply::Selection(reply),
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

    #[test]
    fn callback_admission_accepts_only_a_live_captured_profile_and_exact_pending_owner() {
        let tools = tools();
        let source = tools
            .profile_catalog(
                tools.snapshot().specs.clone(),
                &[],
                &[],
                None,
                [false; 4],
                false,
            )
            .unwrap();
        assert_ne!(source.generation.id, tools.snapshot().id);
        let (key, receive) = tools
            .enqueue(
                "root",
                &source.generation,
                0,
                "turn",
                "call",
                json!({}),
                &ToolCallSource::Direct,
                "model",
                None,
                None,
            )
            .unwrap();
        assert!(tools.admit_callback("root", &key).unwrap());
        assert!(tools.admit_callback("another-root", &key).is_err());
        let mut changed = key.clone();
        changed.reply.generation = source.generation.id + 1;
        assert!(tools.admit_callback("root", &changed).is_err());
        drop(receive);
        assert!(!tools.admit_callback("root", &key).unwrap());
        tools.pending.lock().unwrap().remove(&key);
        assert!(!tools.admit_callback("root", &key).unwrap());
        drop(source);
        assert!(tools.admit_callback("root", &key).is_err());
    }

    #[test]
    fn captured_profile_terminal_slots_survive_startup_and_idempotent_configuration() {
        let tools = tools();
        let source = tools
            .profile_catalog(
                tools.snapshot().specs.clone(),
                &[],
                &[0],
                None,
                [false; 4],
                false,
            )
            .unwrap();
        let default = tools.snapshot();
        tools
            .configure_terminal(TerminalSlots {
                generation: source.generation.id.to_string(),
                slots: vec![0],
            })
            .unwrap();
        assert!(Arc::ptr_eq(&default, &tools.snapshot()));
        assert!(
            tools
                .configure_terminal(TerminalSlots {
                    generation: source.generation.id.to_string(),
                    slots: vec![],
                })
                .is_err()
        );
        assert_eq!(source.generation.terminal_slots, HashSet::from([0]));
        *tools.current.write().unwrap() = Arc::clone(&source.generation);
        tools
            .configure_terminal(TerminalSlots {
                generation: source.generation.id.to_string(),
                slots: vec![0],
            })
            .unwrap();
        assert!(Arc::ptr_eq(&source.generation, &tools.snapshot()));
        let startup = tools.startup_profile_catalog([false; 4], &source).unwrap();
        assert_eq!(startup.generation.terminal_slots, HashSet::from([0]));
        assert!(
            tools
                .profile_catalog(
                    tools.snapshot().specs.clone(),
                    &[],
                    &[1],
                    None,
                    [false; 4],
                    false
                )
                .is_err()
        );
        assert!(
            tools
                .profile_catalog(
                    tools.snapshot().specs.clone(),
                    &[],
                    &[0, 0],
                    None,
                    [false; 4],
                    false
                )
                .is_err()
        );
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

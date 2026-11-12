// Narrow native boundaries. No handler registry, interpreter, or policy is
// reproduced here. Core owns routing; a live cell owns its retained delegate.
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use codex_code_mode::{
    CellId, CodeModeNestedToolCall, CodeModeSession, CodeModeSessionCellExecutionLimits,
    CodeModeSessionDelegate, CodeModeSessionProvider, CodeModeSessionProviderFuture,
    CodeModeSessionResultFuture, ExecuteRequest, NotificationFuture, RuntimeResponse, StartedCell,
    ToolInvocationFuture, WaitOutcome, WaitRequest,
};
use codex_core_api::{CodexThread, Config, Feature, ThreadManager};
use codex_extension_api::{
    BuiltinToolResultInput, ContextContributor, ExtensionData, ExtensionFuture, McpToolResultInput,
    ModelRequestContributor, ModelRequestInput, ModelRequestKind, ModelResponseError,
    ModelResponseInterceptor, ModelResponseStream, ModelToolAdmission, ResponseEvent,
    ThreadLifecycleContributor, ThreadStartInput, ThreadStopInput, ToolContributor,
    ToolFinishInput, ToolLifecycleContributor, ToolLifecycleFuture, ToolPolicy, ToolStartInput,
    TurnAbortInput, TurnLifecycleContributor, TurnStartInput, TurnStopInput,
    WorldStateContributionInput, WorldStateSectionContribution,
};
use codex_protocol::models::{
    FunctionCallOutputBody, ResponseInputItem, ResponseItem, SearchToolCallParams,
};
use codex_protocol::openai_models::ConfigShellToolType;
use codex_protocol::protocol::{EnvironmentConfigState, SessionSource};
use codex_tools::{
    FunctionCallError, ToolCall, ToolCallSource, ToolExecutor, ToolExecutorFuture, ToolExposure,
    ToolName, ToolOutput, ToolPayload, ToolSearchInfo, ToolSpec,
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::environment::StrictExecutorWrites;

const FAILURE: &str = "Native tool interception failed or was denied";
const MAX_PENDING: usize = 128;
const MAX_PAYLOAD_BYTES: usize = 128 * 1024 * 1024;

// Only the serialized bridge representation is counted, not native tool
// execution or the first projection of an opaque pinned ToolOutput.
struct Counter {
    bytes: usize,
    limit: usize,
}
impl Write for Counter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let bytes = self
            .bytes
            .checked_add(data.len())
            .filter(|n| *n <= self.limit)
            .ok_or_else(|| io::Error::other(FAILURE))?;
        self.bytes = bytes;
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Serialize)]
struct Name<'a> {
    namespace: Option<&'a str>,
    name: &'a str,
}
#[derive(Serialize)]
#[serde(untagged)]
enum Input<'a> {
    Text(&'a str),
    Json(&'a Value),
    JsonText(#[serde(serialize_with = "json_text")] &'a Value),
}

// MCP's public bridge input is JSON *inside a string*. serde_json's writer
// streams collect_str through its escaping formatter, so account() can reject
// the complete encoded notice without first allocating arguments.to_string().
fn json_text<S: serde::Serializer>(value: &Value, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(value)
}

// Borrow every potentially large field until its measured lease exists.
#[derive(Serialize)]
struct Request<'a, I, R, K> {
    #[serde(skip_serializing_if = "Option::is_none")]
    tracing_context: Option<&'a str>,
    phase: &'static str,
    route: &'static str,
    boundary: &'static str,
    turn_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
    call_id: Option<&'a str>,
    outer_call_id: Option<&'a str>,
    cell_id: Option<&'a CellId>,
    runtime_tool_call_id: Option<&'a str>,
    tool_name: Name<'a>,
    tool_kind: K,
    input: I,
    result: R,
}

// Retain native authority in the existing reservation, never in serialized input.
#[derive(Serialize)]
struct OwnedRequest<'a, T> {
    #[serde(flatten)]
    request: T,
    #[serde(skip)]
    owner: &'a Arc<DirectTurn>,
    #[serde(skip)]
    retained: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cell_owner_id: Option<String>,
}
impl<T: DecisionRequest> DecisionRequest for OwnedRequest<'_, T> {
    fn profile_source(&self) -> Option<&Arc<ProfileMcpSource>> {
        self.request.profile_source()
    }
    fn tool_identity(&self) -> Option<(Option<&str>, &str)> {
        self.request.tool_identity()
    }
    fn phase(&self) -> Option<&str> {
        self.request.phase()
    }
    fn boundary(&self) -> Option<&str> {
        self.request.boundary()
    }
    fn owner(&self) -> Option<&Arc<DirectTurn>> {
        Some(self.owner)
    }
    fn retained(&self) -> bool {
        self.retained
    }
    fn binding(&self) -> Option<&CellOwnerMetadata> {
        self.request.binding()
    }
}

#[derive(Serialize)]
struct CellOwnerMetadata {
    owner_id: String,
    thread_id: String,
    incarnation: String,
    turn_id: String,
    outer_call_id: String,
    cell_id: CellId,
}
impl DecisionRequest for CellOwnerMetadata {
    fn tool_identity(&self) -> Option<(Option<&str>, &str)> {
        None
    }
    fn binding(&self) -> Option<&CellOwnerMetadata> {
        Some(self)
    }
}

// The existing cell/delegate owns this lease. No second cell or callback index.
struct CellPolicyOwner {
    id: String,
    control: Arc<Control>,
    turn: Arc<DirectTurn>,
    outer_call_id: String,
    cell_id: std::sync::OnceLock<CellId>,
}
impl CellPolicyOwner {
    fn identify(&self, id: &CellId) -> Result<(), String> {
        let actual = self.cell_id.get_or_init(|| id.clone());
        if actual != id {
            return Err(FAILURE.into());
        }
        Ok(())
    }
    async fn bind(&self, id: &CellId) -> Result<(), String> {
        self.identify(id)?;
        let request = CellOwnerMetadata {
            owner_id: self.id.clone(),
            thread_id: self.control.id.clone(),
            incarnation: self.control.incarnation.clone(),
            turn_id: self.turn.id.clone(),
            outer_call_id: self.outer_call_id.clone(),
            cell_id: id.clone(),
        };
        let token = CancellationToken::new();
        match self
            .control
            .decide(
                OwnedRequest {
                    request,
                    owner: &self.turn,
                    retained: self.control.root,
                    cell_owner_id: None,
                },
                &token,
            )
            .await?
        {
            Decision::Continue => Ok(()),
            _ => Err(FAILURE.into()),
        }
    }
}
impl Drop for CellPolicyOwner {
    fn drop(&mut self) {
        let _ = self
            .control
            .channel
            .sender
            .send(Message::CellOwnerRetired(self.id.clone()));
    }
}

trait DecisionRequest: Serialize {
    fn profile_source(&self) -> Option<&Arc<ProfileMcpSource>> {
        None
    }
    fn owner(&self) -> Option<&Arc<DirectTurn>> {
        None
    }
    fn retained(&self) -> bool {
        false
    }
    fn binding(&self) -> Option<&CellOwnerMetadata> {
        None
    }
    fn tool_identity(&self) -> Option<(Option<&str>, &str)>;
    fn phase(&self) -> Option<&str> {
        None
    }
    fn boundary(&self) -> Option<&str> {
        None
    }
}

impl<I: Serialize, R: Serialize, K: Serialize> DecisionRequest for Request<'_, I, R, K> {
    fn phase(&self) -> Option<&str> {
        Some(self.phase)
    }
    fn boundary(&self) -> Option<&str> {
        Some(self.boundary)
    }
    fn tool_identity(&self) -> Option<(Option<&str>, &str)> {
        Some((self.tool_name.namespace, self.tool_name.name))
    }
}

impl<T: DecisionRequest> DecisionRequest for &T {
    fn profile_source(&self) -> Option<&Arc<ProfileMcpSource>> {
        (*self).profile_source()
    }
    fn owner(&self) -> Option<&Arc<DirectTurn>> {
        (*self).owner()
    }
    fn retained(&self) -> bool {
        (*self).retained()
    }
    fn binding(&self) -> Option<&CellOwnerMetadata> {
        (*self).binding()
    }
    fn phase(&self) -> Option<&str> {
        (*self).phase()
    }
    fn boundary(&self) -> Option<&str> {
        (*self).boundary()
    }
    fn tool_identity(&self) -> Option<(Option<&str>, &str)> {
        (*self).tool_identity()
    }
}

#[cfg(test)]
impl DecisionRequest for Value {
    fn phase(&self) -> Option<&str> {
        self["phase"].as_str()
    }
    fn boundary(&self) -> Option<&str> {
        self["boundary"].as_str()
    }
    fn tool_identity(&self) -> Option<(Option<&str>, &str)> {
        Some((
            self["tool_name"]["namespace"].as_str(),
            self["tool_name"]["name"].as_str()?,
        ))
    }
}

#[derive(Serialize)]
struct Identified<'a, T> {
    thread_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_role: Option<&'a str>,
    incarnation: &'a str,
    #[serde(flatten)]
    request: T,
}
#[derive(Serialize)]
struct Notice<'a, T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    mcp_identity: Option<&'a (String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_epoch: Option<u64>,
    nonce: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    realtime_tool_name: Option<String>,
    request: Identified<'a, T>,
}

type CancellationProbe = Arc<dyn Fn() -> bool + Send + Sync + 'static>;

struct Pending {
    profile_source: Option<Arc<ProfileMcpSource>>,
    owner: Option<Arc<DirectTurn>>,
    retained: bool,
    generation: Option<u64>,
    stop_allowed: bool,
    stopped: CancellationToken,
    request_cancelled: CancellationToken,
    is_cancelled: Option<CancellationProbe>,
    deadline: Option<Instant>,
    reply: Option<oneshot::Sender<Reply>>,
    control: Weak<Control>,
    payload: Payload,
    _bytes: OwnedSemaphorePermit,
    // Drop after charged bytes, only when the physical callback owner returns.
    _released: Option<oneshot::Sender<()>>,
}
type NoticeRelease = oneshot::Receiver<()>;
enum Reply {
    Decision(Decision),
    HoldForStop,
}

enum Payload {
    Queued(String),
    InFlight,
    Callback,
    // Physical callback returned first; dispatch still owns reply/request.
    Returned,
}
enum Message {
    Payload(u64),
    Cancel(u64),
    CellOwnerRetired(String),
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Decision {
    Continue,
    Replace { value: Value },
    Deny,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Scope {
    Root,
    ThreadTree,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolRule {
    name: String,
    namespace: Option<String>,
    timeout: Option<f64>,
    scope: Scope,
    #[serde(default)]
    pub(crate) generation: Option<String>,
    #[serde(default)]
    result: bool,
    #[serde(default)]
    executor_before: bool,
    #[serde(default)]
    mcp_identity: Option<(String, String)>,
}

type Rules = HashMap<
    ToolName,
    (
        Option<Duration>,
        Scope,
        Option<u64>,
        bool,
        bool,
        Option<(String, String)>,
    ),
>;

/// Immutable MCP callback policy from the same native Agent profile as its tool router.
#[derive(Clone, Default)]
pub(crate) struct ProfileMcpPolicy {
    identities: HashMap<ToolName, (String, String)>,
    names: HashSet<ToolName>,
    rules: Rules,
}
impl ProfileMcpPolicy {
    fn identities(binding: &codex_mcp::McpBinding) -> HashMap<ToolName, (String, String)> {
        binding
            .tools()
            .iter()
            .map(|tool| {
                (
                    tool.canonical_tool_name().with_default_namespace(),
                    (tool.server_name.clone(), tool.tool.name.to_string()),
                )
            })
            .collect()
    }

    /// Realtime captures an additional dispatch check without changing backend policy.
    pub(crate) fn for_realtime(
        &self,
        generation: u64,
        additional: Option<&RealtimeMcpPolicy>,
    ) -> Self {
        let mut policy = self.clone();
        if let Some(additional) = additional {
            policy.names.extend(additional.names.iter().cloned());
        }
        for name in &policy.names {
            policy.rules.entry(name.clone()).or_insert((
                Some(Duration::from_secs(30)),
                Scope::ThreadTree,
                Some(generation),
                false,
                false,
                policy.identities.get(name).cloned(),
            ));
        }
        policy
    }

    pub(crate) fn has_pre_policy(&self) -> bool {
        self.rules.values().any(|rule| rule.2.is_some())
    }

    pub(crate) fn prepare(
        binding: &codex_mcp::McpBinding,
        declarations: &std::collections::BTreeMap<
            String,
            crate::agent_profiles::McpToolDeclaration,
        >,
        generation: u64,
    ) -> Result<Self> {
        let mut names = HashSet::new();
        let mut rules = Vec::new();
        for tool in binding.tools() {
            let name = ToolName::new(
                Some(tool.callable_namespace.clone()),
                tool.callable_name.clone(),
            )
            .with_default_namespace();
            names.insert(name.clone());
            let Some(declaration) = declarations.get(&tool.server_name) else {
                continue;
            };
            if !(declaration.before || declaration.approval)
                || !declaration
                    .tools
                    .iter()
                    .any(|name| name.as_str() == tool.tool.name.as_ref())
            {
                continue;
            }
            rules.push(ToolRule {
                name: name.name,
                namespace: name.namespace,
                timeout: (!declaration.approval).then_some(30.0),
                scope: Scope::ThreadTree,
                generation: Some(generation.to_string()),
                result: false,
                executor_before: false,
                mcp_identity: Some((tool.server_name.clone(), tool.tool.name.to_string())),
            });
        }
        Ok(Self {
            identities: Self::identities(binding),
            names,
            rules: Control::compile_rules(rules)?,
        })
    }
}

/// Mono Session MCP declarations, enrolled only for captured Realtime dispatch.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RealtimeMcpPolicy {
    names: Vec<ToolName>,
}

/// Callback attribution only; it carries no Session, environment, or callable executor.
#[derive(Clone)]
pub(crate) struct ProfileMcpSource {
    pub(crate) result_selection: Option<Arc<crate::mcp_result_control::Selection>>,
    pub(crate) receipt: Option<codex_extension_api::AgentProfileReceipt>,
    pub(crate) policy: Option<Arc<ProfileMcpPolicy>>,
}
impl ProfileMcpSource {
    pub(crate) fn for_binding(
        mut self,
        binding: &codex_mcp::McpBinding,
        policy: &codex_extension_api::ToolPolicy,
    ) -> Self {
        let (Some(selectors), Some(captured)) = (&policy.allowed_mcp_tools, &self.policy) else {
            return self;
        };
        let mut rules = captured.rules.clone();
        let mut names = captured.names.clone();
        for (_, _, declared) in selectors {
            rules.remove(&declared.clone().with_default_namespace());
            names.remove(&declared.clone().with_default_namespace());
        }
        for tool in binding.tools() {
            let actual = tool.canonical_tool_name().with_default_namespace();
            names.insert(actual.clone());
            if let Some((_, _, declared)) = selectors.iter().find(|(server, raw, _)| {
                tool.server_name == *server && tool.tool.name.as_ref() == raw
            }) {
                if let Some(rule) = captured
                    .rules
                    .get(&declared.clone().with_default_namespace())
                {
                    rules.insert(actual, rule.clone());
                }
            }
        }
        self.policy = Some(Arc::new(ProfileMcpPolicy {
            identities: ProfileMcpPolicy::identities(binding),
            names,
            rules,
        }));
        self
    }
}
fn capture_mcp_source(
    step: Option<&ExtensionData>,
) -> Result<Option<Arc<ProfileMcpSource>>, String> {
    let source = step.and_then(|step| step.get::<ProfileMcpSource>());
    if source
        .as_ref()
        .is_some_and(|source| source.policy.is_none())
        || (source.is_none()
            && step.is_some_and(|step| {
                step.get::<codex_extension_api::CapturedAgentProfile>()
                    .is_some()
            }))
    {
        return Err(FAILURE.into());
    }
    Ok(source)
}

#[derive(Serialize)]
struct ProfiledRequest<T> {
    #[serde(flatten)]
    request: T,
    #[serde(skip)]
    source: Option<Arc<ProfileMcpSource>>,
}
impl<T: DecisionRequest> DecisionRequest for ProfiledRequest<T> {
    fn owner(&self) -> Option<&Arc<DirectTurn>> {
        self.request.owner()
    }
    fn retained(&self) -> bool {
        self.request.retained()
    }
    fn binding(&self) -> Option<&CellOwnerMetadata> {
        self.request.binding()
    }
    fn tool_identity(&self) -> Option<(Option<&str>, &str)> {
        self.request.tool_identity()
    }
    fn phase(&self) -> Option<&str> {
        self.request.phase()
    }
    fn boundary(&self) -> Option<&str> {
        self.request.boundary()
    }
    fn profile_source(&self) -> Option<&Arc<ProfileMcpSource>> {
        self.source.as_ref()
    }
}

struct State {
    tools: Option<Rules>,
    // Some records a claimed MCP transition; true records a concurrent birth.
    mcp_publication: Option<bool>,
    mcp_poisoned: bool,
    timeout: Option<Duration>,
    scope: Scope,
    revoked: bool,
    nonce: u64,
    pending: HashMap<u64, Pending>,
}

// The public turn store owns this identity. A model request retains this exact
// scope, never a mutable "current turn" lookup when the provider returns.
struct DirectTurn {
    policy_stopped: AtomicBool,
    id: String,
    model: Mutex<Option<Arc<str>>>,
    command_admission: Mutex<Option<CommandAdmission>>,
    cancelled: CancellationToken,
    settlement: Option<Weak<crate::turn_settlement::Turn>>,
    core_task: Option<Arc<codex_core_api::OwnedTurnTask>>,
    // Core starts, processes the result and finishes inside one spawned
    // dispatch task. The model's call_id can repeat across live invocations.
    mcp_calls: Mutex<HashSet<tokio::task::Id>>,
}

impl DirectTurn {
    fn admits_policy(&self, retained: bool) -> bool {
        !self.policy_stopped.load(Ordering::Acquire) && (retained || !self.cancelled.is_cancelled())
    }

    fn settlement(&self) -> Option<Arc<crate::turn_settlement::Turn>> {
        self.settlement.as_ref().and_then(Weak::upgrade)
    }
}

// Reuse the exact captured publication owner for final MCP assignment.
pub(crate) fn publish_mcp_result(
    thread: &ExtensionData,
    turn: &ExtensionData,
    publish: impl FnOnce(),
) {
    if let (Some(control), Some(owner)) = (thread.get::<Control>(), turn.get::<DirectTurn>()) {
        let _ = control.publish_result(&owner, &control.stopped, true, None, publish);
    }
}

// Stop only the captured task. Its existing host stop/join owner retains
// physical settlement; joining here would wait on this very MCP hook.
pub(crate) fn expire_mcp_result(
    thread_store: &ExtensionData,
    turn_store: &ExtensionData,
    claim: impl FnOnce() -> bool,
) {
    if let (Some(control), Some(owner)) = (
        thread_store.get::<Control>(),
        turn_store.get::<DirectTurn>(),
    ) {
        let _state = control
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        if !control.stopped.is_cancelled() && owner.admits_policy(true) && claim() {
            owner.policy_stopped.store(true, Ordering::Release);
            if let Some(task) = &owner.core_task {
                task.request_stop();
            }
        }
    } else {
        claim();
    }
}

// Reuse the existing exact-turn publication fence for pre-send application metadata.
pub(crate) fn publish_mcp_metadata(
    thread: &ExtensionData,
    turn: &ExtensionData,
    retained: bool,
    is_cancelled: &CancellationProbe,
    publish: impl FnOnce(),
) {
    if let (Some(control), Some(owner)) = (thread.get::<Control>(), turn.get::<DirectTurn>()) {
        let _ = control.publish_result(
            &owner,
            &control.stopped,
            retained,
            Some(is_cancelled),
            publish,
        );
    }
}

struct LastCompletion {
    response_id: String,
    model: String,
    output: Vec<ResponseItem>,
}

// Only options::build's eager native Environment may seed command admission.
// Raw selections, including ready selections named "remote", keep Core semantics.
pub(crate) struct EagerCommandEnvironment(pub(crate) bool);

#[derive(Clone, Copy)]
struct CommandAdmission {
    login: bool,
    tty: bool,
}

/// Original native turn and its existing cell ownership, captured before
/// cancellation clears the live pointer. No request data or later current turn
/// can retarget this receipt. A failed join can be retried on the same receipt.
pub(crate) struct CapturedTurnStop {
    control: Arc<Control>,
    owner: Option<Arc<DirectTurn>>,
    // A successor can replace the current native receipt while cleanup waits.
    settlement: Option<Arc<crate::turn_settlement::Turn>>,
    sessions: Mutex<Vec<Arc<Session>>>,
}
impl CapturedTurnStop {
    pub(crate) fn callback_cancellation(&self) -> Option<CancellationToken> {
        self.owner.as_ref().map(|owner| owner.cancelled.clone())
    }
    pub(crate) fn local_exec_cancel_confirmed(&self) -> bool {
        self.settlement
            .as_ref()
            .is_some_and(|turn| turn.terminal() && !turn.local_exec_cancel_failed())
    }

    // The caller already owns channel.state during an admitted policy claim.
    fn stop_locked(&self) {
        if let Some(owner) = &self.owner {
            owner.policy_stopped.store(true, Ordering::Release);
            if let Some(task) = &owner.core_task {
                task.request_stop();
            }
        }
    }

    pub(crate) fn stop(&self) {
        {
            let _state = self
                .control
                .channel
                .state
                .lock()
                .expect("interception control poisoned");
            self.stop_locked();
        }
        self.retain_sessions();
    }

    fn retain_sessions(&self) -> Vec<Arc<Session>> {
        let linked: Vec<_> = self
            .control
            .code_mode_sessions
            .lock()
            .expect("code mode session links poisoned")
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        let mut retained = self.sessions.lock().expect("captured sessions poisoned");
        for session in linked {
            if !retained.iter().any(|saved| Arc::ptr_eq(saved, &session)) {
                retained.push(session);
            }
        }
        retained.clone()
    }

    async fn join_cells(&self, sessions: Vec<Arc<Session>>) -> Vec<String> {
        let Some(owner) = &self.owner else {
            return vec!["Native turn cleanup owner is unavailable".to_owned()];
        };
        let mut errors = Vec::new();
        for session in sessions {
            if let Err(error) = session
                .interrupt_exact_cells(&self.control, Some(owner))
                .await
            {
                errors.push(error);
            }
        }
        errors
    }

    /// Call only after confirmed cancellation. This joins the captured cells
    /// and original physical task; it never interrupts a thread found by ID.
    pub(crate) async fn finish(&self, _manager: &ThreadManager) -> Result<()> {
        let owner = self
            .owner
            .as_ref()
            .context("Native turn cleanup owner is unavailable")?;
        let mut errors = self.join_cells(self.retain_sessions()).await;
        if let Some(task) = &owner.core_task {
            if let Err(error) = task.join().await {
                errors.push(error.to_string());
            }
        } else {
            errors.push("Native turn cleanup task is unavailable".to_owned());
        }
        ensure!(errors.is_empty(), "{}", errors.join("; "));
        Ok(())
    }
}

pub(crate) struct HeldPolicyStop {
    captured: Arc<CapturedTurnStop>,
}
impl HeldPolicyStop {
    pub(crate) async fn finish(self, manager: &ThreadManager) -> Result<()> {
        let control = &self.captured.control;
        let owner = self.captured.owner.as_ref().context(FAILURE)?;
        let core_task = owner.core_task.as_ref().context(FAILURE)?;
        // Retain session handles before asynchronous retirement can drop a
        // running task's session reference.
        let sessions = self.captured.retain_sessions();
        let id = codex_core_api::ThreadId::from_string(&control.id)?;
        let thread = manager.get_thread(id).await?;
        ensure!(
            thread
                .thread_extension_data()
                .get::<Control>()
                .is_some_and(|registered| Arc::ptr_eq(&registered, control)),
            FAILURE
        );
        let settlement = match (
            control.settlement.get().and_then(Weak::upgrade),
            owner.settlement(),
        ) {
            (Some(settlement), Some(receipt)) if settlement.is_current(&receipt) => {
                receipt.reject_model();
                Some((settlement, receipt))
            }
            _ => None,
        };
        // Capture/retire only the original Core task, preserving accepted input.
        // Retirement runs independently while its held cells are physically joined.
        let retirement = thread.stop_owned_turn(core_task).await?;
        let mut errors = Vec::new();
        errors.extend(self.captured.join_cells(sessions).await);
        if let Err(error) = retirement.join().await {
            errors.push(error.to_string());
        }
        if let Some((settlement, receipt)) = settlement {
            if let Err(error) = settlement.finish_interrupted(&thread, &receipt).await {
                errors.push(error.to_string());
            }
            if !receipt.terminal() {
                errors.push("Native policy stop did not retire its original turn".to_owned());
            }
        }
        ensure!(errors.is_empty(), "{}", errors.join("; "));

        Ok(())
    }
}

pub struct Control {
    context_tools: OnceLock<Weak<crate::python_tools::PythonTools>>,
    mcp_results: OnceLock<Weak<crate::mcp_result_control::McpResultControl>>,
    profile_policies: AtomicU8,
    id: String,
    pub(crate) incarnation: String,
    root: bool,
    native_depth: usize,
    native_agents: std::sync::OnceLock<Arc<crate::native_agents::Policy>>,
    strict_executor_writes: std::sync::OnceLock<()>,
    agent_role: std::sync::OnceLock<Option<String>>,
    managed_response: std::sync::OnceLock<bool>,
    // Core starts Review delegates directly, outside ThreadManager.
    review_delegate: std::sync::OnceLock<bool>,
    native_ancestor: Option<Weak<Control>>,
    stopped: CancellationToken,
    creation_tracing: OnceLock<Option<Arc<codex_otel::sdk_trace::ContextLease>>>,
    creation_trace: OnceLock<Option<codex_protocol::protocol::W3cTraceContext>>,
    direct_turn: Mutex<Option<Arc<DirectTurn>>>,
    code_mode_sessions: Mutex<Vec<Weak<Session>>>,
    pending_code_import: Mutex<Option<Weak<PendingCodeImport>>>,
    import_cleanup_failure: std::sync::OnceLock<Arc<Mutex<Option<String>>>>,
    pub(crate) settlement: std::sync::OnceLock<Weak<crate::turn_settlement::Settlement>>,
    sentinel_provider: std::sync::OnceLock<(String, bool)>,
    collaboration_namespace: std::sync::OnceLock<Option<String>>,
    websocket_drivers: Mutex<Option<tokio_util::task::TaskTracker>>,
    stdin_admission: std::sync::OnceLock<()>,
    command_tty: std::sync::OnceLock<bool>,
    sentinel_request: Mutex<SentinelState>,
    channel: Arc<Channel>,
}

// One bounded callback owner per explicit root. Native ThreadSpawn ancestry
// may share it, but never the parent's turn or thread-stop lifetime.
struct Channel {
    observe_raw_provider_events: AtomicBool,
    state: Mutex<State>,
    raw_usage: Mutex<Option<Arc<codex_core::SdkRawUsageLink>>>,
    request_attempts: Mutex<Option<Arc<codex_core::SdkRequestAttemptsLink>>>,
    graph: crate::graph_stop::Graph,
    // At most MAX_PENDING live requests. Cancellation messages must not be
    // dropped when that bound is full, hence the unbounded control channel.
    sender: mpsc::UnboundedSender<Message>,
    receiver: AsyncMutex<mpsc::UnboundedReceiver<Message>>,
    bytes: Arc<Semaphore>,
}

// Boundary owns every unpublished receiver. Control's weak slot names only
// current authority, and cannot orphan a receiver when its index is retired.
struct PendingCodeImport {
    thread_id: codex_protocol::ThreadId,
    control: Weak<Control>,
    session: Arc<dyn CodeModeSession>,
    turn: Option<Weak<DirectTurn>>,
    operation: AsyncMutex<CodeImportState>,
}

#[derive(PartialEq, Eq)]
enum CodeImportState {
    Pending,
    Closed,
    Published,
}

impl Control {
    pub(crate) fn seal_request_attempts(&self, turn_id: &str) {
        if self.root {
            if let Some(capture) = self
                .channel
                .request_attempts
                .lock()
                .expect("request attempts link poisoned")
                .as_ref()
            {
                capture.seal(turn_id);
            }
        }
    }

    pub(crate) fn bind_request_attempts(&self, link: codex_core::SdkRequestAttemptsLink) {
        *self
            .channel
            .request_attempts
            .lock()
            .expect("request attempts link poisoned") = Some(Arc::new(link));
    }

    pub(crate) fn raw_usage_active(&self) -> bool {
        self.channel
            .raw_usage
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .is_some_and(|link| link.is_active())
    }

    pub(crate) fn bind_raw_usage(&self, link: codex_core::SdkRawUsageLink) {
        *self
            .channel
            .raw_usage
            .lock()
            .expect("raw usage link poisoned") = Some(Arc::new(link));
    }

    pub(crate) fn bind_context_tools(&self, tools: &Arc<crate::python_tools::PythonTools>) {
        let _ = self.context_tools.set(Arc::downgrade(tools));
    }
    pub(crate) fn bind_mcp_results(
        &self,
        results: &Arc<crate::mcp_result_control::McpResultControl>,
    ) {
        let _ = self.mcp_results.set(Arc::downgrade(results));
    }

    pub(crate) fn creation_tracing(&self) -> Option<Arc<codex_otel::sdk_trace::ContextLease>> {
        self.creation_tracing.get().cloned().flatten()
    }

    pub(crate) fn creation_trace(
        &self,
    ) -> Result<Option<codex_protocol::protocol::W3cTraceContext>> {
        match self.creation_tracing() {
            Some(tracing) => codex_otel::sdk_trace::trace_carrier(tracing.token())
                .map(Some)
                .map_err(anyhow::Error::msg),
            None => Ok(self.raw_creation_trace()),
        }
    }

    pub(crate) fn raw_creation_trace(&self) -> Option<codex_protocol::protocol::W3cTraceContext> {
        self.creation_trace.get().cloned().flatten()
    }

    pub(crate) fn tracing_context(&self) -> codex_otel::sdk_trace::CapturedContext {
        if self.native_ancestor.is_some() {
            // A child created without tracing keeps that choice on later turns.
            codex_otel::sdk_trace::CapturedContext {
                context: self
                    .creation_tracing()
                    .map(|lease| Arc::new(lease.retain())),
            }
        } else {
            codex_otel::sdk_trace::CapturedContext::capture()
        }
    }

    pub(crate) fn code_import_poisoned(&self) -> bool {
        self.import_cleanup_failure.get().is_some_and(|failure| {
            failure
                .lock()
                .expect("code import failure poisoned")
                .is_some()
        })
    }

    pub(crate) fn has_unsettled_code_cells(self: &Arc<Self>) -> bool {
        // A closed cell with an unread result still belongs to this owner.
        let sessions: Vec<_> = self
            .code_mode_sessions
            .lock()
            .expect("code mode session links poisoned")
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        sessions.iter().any(|session| {
            session
                .cells
                .lock()
                .expect("interception cells poisoned")
                .values()
                .any(|cell| Arc::ptr_eq(&cell.control, self))
        })
    }

    pub(crate) fn check_context_idle(&self) -> anyhow::Result<()> {
        let state = self
            .channel
            .state
            .try_lock()
            .map_err(|_| anyhow::anyhow!("native interception mutation is in progress"))?;
        anyhow::ensure!(
            state.pending.is_empty(),
            "supplied compaction requires settled native interception callbacks"
        );
        Ok(())
    }

    pub(crate) fn active_turn_id(&self) -> Option<String> {
        self.direct_turn
            .lock()
            .expect("interception turn poisoned")
            .as_ref()
            .map(|turn| turn.id.clone())
    }
    pub(crate) fn has_native_agents(&self) -> bool {
        self.native_agents.get().is_some()
    }
    pub(crate) fn graph(&self) -> &crate::graph_stop::Graph {
        &self.channel.graph
    }

    pub(crate) fn thread_id(&self) -> &str {
        &self.id
    }

    pub(crate) fn is_root(&self) -> bool {
        self.root
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped.is_cancelled()
    }

    pub(crate) fn stopped_token(&self) -> &CancellationToken {
        &self.stopped
    }

    pub(crate) fn track_websocket_driver(
        &self,
        driver: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> anyhow::Result<tokio::task::JoinHandle<()>> {
        let mut slot = self.websocket_drivers.lock().expect("websocket drivers poisoned");
        anyhow::ensure!(!self.is_stopped(), "Native thread ended");
        let tasks = slot.get_or_insert_with(tokio_util::task::TaskTracker::new);
        Ok(tasks.spawn(driver))
    }

    async fn join_websocket_drivers(&self) {
        let tasks = self.websocket_drivers.lock().expect("websocket drivers poisoned").clone();
        if let Some(tasks) = tasks {
            tasks.close();
            tasks.wait().await;
        }
    }

    pub(crate) fn new(id: String, root: bool) -> Self {
        Self::with_budget(id, root, MAX_PAYLOAD_BYTES)
    }

    fn with_budget(id: String, root: bool, bytes: usize) -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            id,
            incarnation: codex_protocol::ThreadId::new().to_string(),
            mcp_results: OnceLock::new(),
            context_tools: OnceLock::new(),
            profile_policies: AtomicU8::new(0),
            root,
            native_depth: if root { 0 } else { usize::MAX },
            native_agents: std::sync::OnceLock::new(),
            strict_executor_writes: std::sync::OnceLock::new(),
            agent_role: std::sync::OnceLock::new(),
            managed_response: std::sync::OnceLock::new(),
            review_delegate: std::sync::OnceLock::new(),
            native_ancestor: None,
            stopped: CancellationToken::new(),
            creation_tracing: OnceLock::new(),
            creation_trace: OnceLock::new(),
            direct_turn: Mutex::new(None),
            code_mode_sessions: Mutex::default(),
            pending_code_import: Mutex::default(),
            import_cleanup_failure: std::sync::OnceLock::new(),
            settlement: std::sync::OnceLock::new(),
            sentinel_provider: std::sync::OnceLock::new(),
            collaboration_namespace: std::sync::OnceLock::new(),
            websocket_drivers: Mutex::default(),
            stdin_admission: std::sync::OnceLock::new(),
            command_tty: std::sync::OnceLock::new(),
            sentinel_request: Mutex::new(SentinelState::default()),
            channel: Arc::new(Channel {
                raw_usage: Mutex::new(None),
                request_attempts: Mutex::new(None),
                observe_raw_provider_events: AtomicBool::new(false),
                graph: crate::graph_stop::Graph::default(),
                state: Mutex::new(State {
                    timeout: None,
                    scope: Scope::Root,
                    revoked: false,
                    nonce: 0,
                    pending: HashMap::new(),
                    tools: None,
                    mcp_publication: None,
                    mcp_poisoned: false,
                }),
                sender,
                receiver: AsyncMutex::new(receiver),
                bytes: Arc::new(Semaphore::new(bytes)),
            }),
        }
    }

    pub(crate) fn enable_raw_provider_events(&self) {
        self.channel
            .observe_raw_provider_events
            .store(true, Ordering::Release);
    }

    fn descendant(id: String, parent: &Arc<Control>) -> Self {
        Self {
            id,
            incarnation: codex_protocol::ThreadId::new().to_string(),
            mcp_results: OnceLock::new(),
            context_tools: OnceLock::new(),
            profile_policies: AtomicU8::new(parent.profile_policies.load(Ordering::Acquire)),
            root: false,
            native_depth: parent.native_depth.saturating_add(1),
            native_agents: parent.native_agents.clone(),
            strict_executor_writes: std::sync::OnceLock::new(),
            agent_role: std::sync::OnceLock::new(),
            managed_response: std::sync::OnceLock::new(),
            review_delegate: std::sync::OnceLock::new(),
            native_ancestor: Some(Arc::downgrade(parent)),
            stopped: CancellationToken::new(),
            creation_tracing: OnceLock::new(),
            creation_trace: OnceLock::new(),
            direct_turn: Mutex::new(None),
            code_mode_sessions: Mutex::default(),
            pending_code_import: Mutex::default(),
            import_cleanup_failure: std::sync::OnceLock::new(),
            settlement: std::sync::OnceLock::new(),
            sentinel_provider: std::sync::OnceLock::new(),
            collaboration_namespace: std::sync::OnceLock::new(),
            websocket_drivers: Mutex::default(),
            stdin_admission: std::sync::OnceLock::new(),
            command_tty: std::sync::OnceLock::new(),
            sentinel_request: Mutex::new(SentinelState::default()),
            channel: parent.channel.clone(),
        }
    }

    pub(crate) fn inherited_instruction_files(
        &self,
    ) -> Option<Arc<codex_extension_api::SdkInheritedApplicationInstructions>> {
        self.native_ancestor.as_ref()?;
        let policy = self.native_agents.get()?;
        // Declared roles supply their own instructions, even when the bytes match.
        if self
            .agent_role
            .get()?
            .as_ref()
            .is_some_and(|role| policy.roles.contains(role))
        {
            return None;
        }
        policy.inherited_instructions.clone()
    }

    /// Capture is inert: a declined/failed conditional cancellation must not
    /// revoke callbacks. Retained cell owners also cover terminal delivery,
    /// which removes direct_turn before physical cleanup necessarily finishes.
    pub(crate) fn capture_turn_stop(
        self: &Arc<Self>,
        expected_turn: &str,
    ) -> Option<Arc<CapturedTurnStop>> {
        let mut owner = self
            .direct_turn
            .lock()
            .expect("interception turn poisoned")
            .as_ref()
            .filter(|turn| turn.id == expected_turn)
            .cloned();
        let sessions: Vec<_> = self
            .code_mode_sessions
            .lock()
            .expect("code mode session links poisoned")
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        let mut ambiguous = false;
        let mut unattributed = false;
        for session in &sessions {
            let cells = session.cells.lock().expect("interception cells poisoned");
            for cell in cells
                .values()
                .filter(|cell| Arc::ptr_eq(&cell.control, self))
            {
                if cell.turn.is_none() {
                    // Missing attribution is not evidence of finished cleanup.
                    // Keep an explicit failed receipt without guessing an owner.
                    unattributed = true;
                }
                if let Some(original) = cell.turn.as_ref().filter(|turn| turn.id == expected_turn) {
                    if owner
                        .as_ref()
                        .is_some_and(|saved| !Arc::ptr_eq(saved, original))
                    {
                        ambiguous = true;
                    } else {
                        owner = Some(original.clone());
                    }
                }
            }
        }
        if owner.is_none() && !ambiguous && !unattributed {
            return None;
        }
        // An inconsistent owner is an explicit failed cleanup receipt, never
        // "no cleanup needed" and never authority to stop a guessed owner.
        if ambiguous || unattributed {
            owner = None;
        }
        Some(Arc::new(CapturedTurnStop {
            control: self.clone(),
            settlement: owner.as_ref().and_then(|owner| owner.settlement()),
            owner,
            sessions: Mutex::new(sessions),
        }))
    }

    /// Call after the selected turn(s) have settled, with SDK submissions still
    /// excluded. No model/tool callback is run by this administrative operation.
    pub(crate) async fn interrupt_code_mode_cells(self: &Arc<Self>) -> Result<()> {
        let sessions: Vec<_> = {
            let mut links = self
                .code_mode_sessions
                .lock()
                .expect("code mode session links poisoned");
            links.retain(|session| session.strong_count() != 0);
            links.iter().filter_map(Weak::upgrade).collect()
        };
        let mut failure = None;
        for session in sessions {
            if let Err(error) = session.interrupt_owned_cells(self).await {
                // Best effort for other exact sessions, but never report a full
                // force stop if any native termination was not acknowledged.
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            anyhow::bail!(error);
        }
        Ok(())
    }

    pub(crate) fn enable(&self, timeout: f64, scope: Scope) -> Result<()> {
        let mut state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        ensure!(
            self.root,
            "Native interception supports explicit root sessions only"
        );
        ensure!(
            state.timeout.is_none() && !state.revoked,
            "Native interception already enabled or revoked"
        );
        ensure!(
            timeout.is_finite() && timeout > 0.0 && timeout <= 3600.0,
            "Native interception timeout must be in (0, 3600]"
        );
        state.timeout = Some(Duration::from_secs_f64(timeout));
        state.scope = scope;
        Ok(())
    }

    // Response provenance may follow actual native ThreadSpawn ancestry, but
    // never grants the child its parent's turn or managed steering authority.
    pub(crate) fn managed_response(&self) -> bool {
        self.managed_response.get().copied().unwrap_or(false)
    }

    pub(crate) fn strict_executor_writes(&self) -> bool {
        self.strict_executor_writes.get().is_some()
    }

    fn compile_rules(rules: Vec<ToolRule>) -> Result<Rules> {
        let mut tools = HashMap::new();
        let mut identities = HashSet::new();
        for rule in rules {
            ensure!(
                rule.mcp_identity.as_ref().is_none_or(|identity| {
                    rule.generation.is_some()
                        && !identity.0.is_empty()
                        && !identity.1.is_empty()
                        && !identity.0.contains('\0')
                        && !identity.1.contains('\0')
                        && identities.insert(identity.clone())
                }),
                "Invalid or duplicate native MCP policy identity"
            );
            ensure!(
                !rule.name.is_empty()
                    && rule.timeout.is_none_or(|timeout| timeout.is_finite()
                        && timeout > 0.0
                        && timeout <= 3600.0),
                "Invalid native tool interception rule"
            );
            ensure!(
                tools
                    .insert(
                        ToolName::new(rule.namespace, rule.name).with_default_namespace(),
                        (
                            rule.timeout.map(Duration::from_secs_f64),
                            rule.scope,
                            rule.generation
                                .as_deref()
                                .map(crate::native_id)
                                .transpose()
                                .map_err(|_| anyhow::anyhow!("Invalid MCP policy generation"))?,
                            rule.result,
                            rule.executor_before,
                            rule.mcp_identity,
                        ),
                    )
                    .is_none(),
                "Duplicate native tool interception selection"
            );
        }
        Ok(tools)
    }

    fn cell_policy_owner(
        self: &Arc<Self>,
        turn: Option<&Arc<DirectTurn>>,
        outer: &str,
    ) -> Result<Option<Arc<CellPolicyOwner>>, String> {
        let mut state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        let selected = state.tools.as_ref().is_some_and(|tools| {
            tools.iter().any(|(name, rule)| {
                name.is_default_namespace()
                    && matches!(
                        name.name.as_str(),
                        "exec_command"
                            | "write_stdin"
                            | "apply_patch"
                            | "project_glob"
                            | "project_grep"
                    )
                    && rule.2.is_none()
                    && (self.root || rule.1 == Scope::ThreadTree)
                    && ((self.root && rule.3) || rule.4)
            })
        });
        if !selected {
            return Ok(None);
        }
        let turn = turn.ok_or(FAILURE)?;
        if state.revoked || self.stopped.is_cancelled() || !turn.admits_policy(false) {
            return Err(FAILURE.into());
        }
        state.nonce = state.nonce.checked_add(1).ok_or(FAILURE)?;
        Ok(Some(Arc::new(CellPolicyOwner {
            id: state.nonce.to_string(),
            control: self.clone(),
            turn: turn.clone(),
            outer_call_id: outer.to_owned(),
            cell_id: std::sync::OnceLock::new(),
        })))
    }

    fn builtin_controls(&self, name: &ToolName) -> (bool, bool) {
        if !name.is_default_namespace()
            || !matches!(
                name.name.as_str(),
                "exec_command" | "write_stdin" | "apply_patch" | "project_glob" | "project_grep"
            )
        {
            return (false, false);
        }
        let state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        if !self.configured_in(&state) {
            return (false, false);
        }
        state
            .tools
            .as_ref()
            .and_then(|rules| rules.get(&name.clone().with_default_namespace()))
            .filter(|rule| rule.2.is_none() && (self.root || rule.1 == Scope::ThreadTree))
            .map_or((false, false), |rule| (rule.3, rule.4))
    }

    fn controls_builtin_result(&self, name: &ToolName) -> bool {
        self.builtin_controls(name).0
    }

    fn controls_executor_before(&self, name: &ToolName) -> bool {
        self.builtin_controls(name).1
    }

    fn publish_result<T>(
        &self,
        owner: &DirectTurn,
        token: &CancellationToken,
        retained: bool,
        is_cancelled: Option<&CancellationProbe>,
        publish: impl FnOnce() -> T,
    ) -> Result<T, String> {
        let state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        if state.revoked
            || state.mcp_poisoned
            || state.mcp_publication.is_some()
            || self.stopped.is_cancelled()
            || token.is_cancelled()
            || is_cancelled.is_some_and(|probe| probe())
            || !owner.admits_policy(retained)
        {
            return Err(FAILURE.into());
        }
        Ok(publish())
    }

    fn has_legacy_policy(&self) -> bool {
        let state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        self.configured_in(&state)
            && state.tools.as_ref().is_none_or(|rules| {
                rules
                    .values()
                    .any(|rule| rule.2.is_none() && (self.root || rule.1 == Scope::ThreadTree))
            })
    }
    fn mcp_selected_for(
        &self,
        name: &ToolName,
        source: Option<&Arc<ProfileMcpSource>>,
    ) -> Result<bool, String> {
        let global = self.mcp_selected(name)?;
        let Some(source) = source else {
            return Ok(global);
        };
        let policy = source.policy.as_ref().ok_or(FAILURE)?;
        Ok(policy
            .rules
            .contains_key(&name.clone().with_default_namespace()))
    }

    fn mcp_selected(&self, name: &ToolName) -> Result<bool, String> {
        let state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        if state.revoked
            || state.mcp_poisoned
            || state.mcp_publication.is_some()
            || self.stopped.is_cancelled()
        {
            return Err(FAILURE.into());
        }
        Ok(state
            .tools
            .as_ref()
            .and_then(|rules| rules.get(&name.clone().with_default_namespace()))
            .is_some_and(|rule| rule.2.is_some() && (self.root || rule.1 == Scope::ThreadTree)))
    }

    pub(crate) fn has_mcp_policy(&self) -> bool {
        self.channel
            .state
            .lock()
            .expect("interception control poisoned")
            .tools
            .as_ref()
            .is_some_and(|rules| rules.values().any(|rule| rule.2.is_some()))
    }

    pub(crate) fn configure_tools(&self, rules: Vec<ToolRule>) -> Result<()> {
        let tools = Self::compile_rules(rules)?;
        ensure!(
            !tools
                .values()
                .any(|(_, _, generation, _, _, _)| generation.is_some()),
            "MCP pre-policy rules require roster publication"
        );
        let mut state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        ensure!(
            self.root
                && state.timeout.is_some()
                && !state.revoked
                && state.mcp_publication.is_none()
                && !state.mcp_poisoned,
            "Native interception is not active"
        );
        state.tools = Some(tools);
        Ok(())
    }

    pub(crate) fn capture_mcp_source_for_binding(
        &self,
        binding: &codex_mcp::McpBinding,
        policy: &codex_extension_api::ToolPolicy,
    ) -> ProfileMcpSource {
        self.capture_mcp_source().for_binding(binding, policy)
    }

    fn configured_in(&self, state: &State) -> bool {
        state.timeout.is_some() && (self.root || state.scope == Scope::ThreadTree)
    }

    fn capture_mcp_rules(&self) -> Rules {
        let state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        state
            .tools
            .as_ref()
            .map(|rules| {
                rules
                    .iter()
                    .filter(|(_, rule)| rule.2.is_some())
                    .map(|(name, rule)| (name.clone(), rule.clone()))
                    .collect::<Rules>()
            })
            .unwrap_or_default()
    }

    pub(crate) fn capture_mcp_policy(&self, binding: &codex_mcp::McpBinding) -> ProfileMcpPolicy {
        let names = binding
            .tools()
            .into_iter()
            .map(|tool| {
                ToolName::new(
                    Some(tool.callable_namespace.clone()),
                    tool.callable_name.clone(),
                )
                .with_default_namespace()
            })
            .collect::<HashSet<_>>();
        let tools = binding.tools();
        let mut rules = HashMap::new();
        for (declared, rule) in self.capture_mcp_rules() {
            let actual = match &rule.5 {
                Some((server, raw)) => tools
                    .iter()
                    .find(|tool| tool.server_name == *server && tool.tool.name.as_ref() == raw)
                    .map(|tool| tool.canonical_tool_name().with_default_namespace()),
                None => names.get(&declared).cloned(),
            };
            if let Some(actual) = actual {
                rules.insert(actual, rule);
            }
        }
        ProfileMcpPolicy {
            identities: ProfileMcpPolicy::identities(binding),
            names,
            rules,
        }
    }

    pub(crate) fn capture_mcp_source(&self) -> ProfileMcpSource {
        self.profile_policies.fetch_max(1, Ordering::AcqRel);
        let rules = self.capture_mcp_rules();
        ProfileMcpSource {
            result_selection: self
                .mcp_results
                .get()
                .and_then(Weak::upgrade)
                .and_then(|results| results.capture_source_selection())
                .map(Arc::new),
            receipt: None,
            policy: Some(Arc::new(ProfileMcpPolicy {
                identities: HashMap::new(),
                names: rules.keys().cloned().collect(),
                rules,
            })),
        }
    }

    pub(crate) fn enable_profile_policies(&self) {
        self.profile_policies.store(2, Ordering::Release);
    }

    fn configured(&self) -> bool {
        if self.profile_policies.load(Ordering::Acquire) != 0 {
            return true;
        }
        // Revocation must fail closed for an opted-in owner, never convert it
        // to a new opted-out owner while native work is being cancelled.
        self.configured_in(
            &self
                .channel
                .state
                .lock()
                .expect("interception control poisoned"),
        )
    }

    pub(crate) async fn inherited_parent(
        &self,
        manager: &Weak<ThreadManager>,
    ) -> Option<Arc<CodexThread>> {
        let selected = self.native_ancestor.as_ref()?;
        let parent = async {
            let expected = selected.upgrade()?;
            let thread = manager
                .upgrade()?
                .get_thread(codex_core_api::ThreadId::from_string(&expected.id).ok()?)
                .await
                .ok()?;
            let actual = thread.thread_extension_data().get::<Control>()?;
            let revoked = actual
                .channel
                .state
                .lock()
                .expect("interception control poisoned")
                .revoked;
            (Arc::ptr_eq(&expected, &actual)
                && Arc::ptr_eq(&self.channel, &actual.channel)
                && !actual.stopped.is_cancelled()
                && !self.stopped.is_cancelled()
                && !revoked)
                .then_some(thread)
        }
        .await;
        if parent.is_none() {
            self.revoke();
        }
        parent
    }

    pub fn revoke(&self) {
        {
            let mut state = self
                .channel
                .state
                .lock()
                .expect("interception control poisoned");
            // Serialize stop against allocation and resolve. A child's stale
            // reply must be rejected even before its decide future is polled.
            self.stopped.cancel();
            if self.root {
                state.revoked = true;
                state.pending.retain(|_, pending| {
                    pending.reply.take();
                    // In-flight JavaScript storage is still owned after revocation.
                    matches!(pending.payload, Payload::InFlight | Payload::Callback)
                });
            }
        }
        if let Some(owner) = self
            .direct_turn
            .lock()
            .expect("interception turn poisoned")
            .take()
        {
            owner.policy_stopped.store(true, Ordering::Release);
            owner.cancelled.cancel();
        }
        self.sentinel_request
            .lock()
            .expect("sentinel request poisoned")
            .completion = None;
    }

    fn end_direct_turn(&self, store: &ExtensionData) {
        let Some(owner) = store.get::<DirectTurn>() else {
            return;
        };
        owner.cancelled.cancel();
        let mut current = self.direct_turn.lock().expect("interception turn poisoned");
        if current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &owner))
        {
            *current = None;
        }
    }

    pub async fn next_wire(&self) -> Option<String> {
        let mut receiver = self.channel.receiver.lock().await;
        loop {
            match receiver.recv().await? {
                Message::Cancel(nonce) => return Some(format!("{{\"cancel\":{nonce}}}")),
                Message::CellOwnerRetired(id) => {
                    return Some(json!({"cell_owner_retired": id}).to_string());
                }
                Message::Payload(nonce) => {
                    let mut state = self
                        .channel
                        .state
                        .lock()
                        .expect("interception control poisoned");
                    if let Some(pending) = state.pending.get_mut(&nonce)
                        && matches!(pending.payload, Payload::Queued(_))
                    {
                        if let Payload::Queued(wire) =
                            std::mem::replace(&mut pending.payload, Payload::InFlight)
                        {
                            return Some(wire);
                        }
                    }
                    // Retired before transfer: the native queue no longer
                    // retains any request and cannot confer reply authority.
                }
            }
        }
    }

    #[cfg(test)]
    async fn next(&self) -> Option<Value> {
        self.next_wire()
            .await
            .map(|wire| serde_json::from_str(&wire).unwrap())
    }

    pub fn can_enter(&self, nonce: u64) -> bool {
        let state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        !state.revoked
            && !state.mcp_poisoned
            && state.mcp_publication.is_none()
            && state.pending.get(&nonce).is_some_and(|pending| {
                pending.reply.is_some()
                    && pending.generation.is_none_or(|generation| {
                        if let Some(source) = &pending.profile_source {
                            source.policy.as_ref().is_some_and(|policy| {
                                policy.rules.values().any(|rule| rule.2 == Some(generation))
                            })
                        } else {
                            state.tools.as_ref().is_some_and(|rules| {
                                rules.values().any(|rule| rule.2 == Some(generation))
                            })
                        }
                    })
                    && pending
                        .owner
                        .as_ref()
                        .is_none_or(|owner| owner.admits_policy(pending.retained))
                    && !pending.stopped.is_cancelled()
                    && !pending.request_cancelled.is_cancelled()
                    && pending.is_cancelled.as_ref().is_none_or(|probe| !probe())
                    && pending
                        .deadline
                        .is_none_or(|deadline| Instant::now() < deadline)
            })
    }

    pub fn release(&self, nonce: u64) -> bool {
        let mut state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        let Some(pending) = state.pending.get_mut(&nonce) else {
            return false;
        };
        if !matches!(pending.payload, Payload::InFlight | Payload::Callback) {
            return false;
        }
        pending.payload = Payload::Returned;
        if pending.reply.is_none() {
            state.pending.remove(&nonce);
        }
        true
    }

    // Storage handoff only. This never grants reply authority: a retired
    // sender remains retired even when JavaScript must finish cancelling its task.
    pub fn handoff(&self, nonce: u64) -> bool {
        let mut state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        let Some(pending) = state.pending.get_mut(&nonce) else {
            return false;
        };
        if !matches!(pending.payload, Payload::InFlight) {
            return false;
        }
        pending.payload = Payload::Callback;
        true
    }

    // The joined reader cannot still deliver these frames. A worker running a
    // sync callback has a separate physical owner and must keep its permit.
    pub fn reader_finished(&self) {
        let mut state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        state
            .pending
            .retain(|_, pending| !matches!(pending.payload, Payload::InFlight));
    }

    pub fn resolve(&self, nonce: u64, reply: &str) -> bool {
        let decision = serde_json::from_str::<Decision>(reply).unwrap_or(Decision::Deny);
        self.reply(nonce, Reply::Decision(decision)).is_some()
    }

    pub(crate) fn hold_for_stop(&self, nonce: u64) -> Option<HeldPolicyStop> {
        self.reply(nonce, Reply::HoldForStop).flatten()
    }

    fn reply(&self, nonce: u64, reply: Reply) -> Option<Option<HeldPolicyStop>> {
        let mut state = self
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        if state.revoked || state.mcp_poisoned || state.mcp_publication.is_some() {
            return None;
        }
        if state.pending.get(&nonce).is_some_and(|pending| {
            pending.generation.is_some_and(|generation| {
                if let Some(source) = &pending.profile_source {
                    !source.policy.as_ref().is_some_and(|policy| {
                        policy.rules.values().any(|rule| rule.2 == Some(generation))
                    })
                } else {
                    !state
                        .tools
                        .as_ref()
                        .is_some_and(|rules| rules.values().any(|rule| rule.2 == Some(generation)))
                }
            })
        }) {
            return None;
        }
        let Some(pending) = state.pending.get_mut(&nonce) else {
            return None;
        };
        let deadline = pending.deadline;
        if pending
            .owner
            .as_ref()
            .is_some_and(|owner| !owner.admits_policy(pending.retained))
            || pending.stopped.is_cancelled()
            || pending.request_cancelled.is_cancelled()
            || pending.is_cancelled.as_ref().is_some_and(|probe| probe())
            || deadline.is_some_and(|deadline| Instant::now() >= deadline)
        {
            return None;
        }
        let stopping = matches!(reply, Reply::HoldForStop);
        let held = if stopping {
            if !pending.stop_allowed || !matches!(pending.payload, Payload::Callback) {
                return None;
            }
            let owner = pending.owner.clone()?;
            owner.core_task.as_ref()?;
            Some(HeldPolicyStop {
                captured: Arc::new(CapturedTurnStop {
                    settlement: owner.settlement(),
                    owner: Some(owner),
                    control: pending.control.upgrade()?,
                    sessions: Mutex::default(),
                }),
            })
        } else {
            None
        };
        let Some(tx) = pending.reply.take() else {
            return None;
        };
        if matches!(pending.payload, Payload::Returned) {
            state.pending.remove(&nonce);
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) || tx.send(reply).is_err() {
            return None;
        }
        if let Some(held) = &held {
            held.captured.stop_locked();
        }
        Some(held)
    }

    // A retained input whose native consumer takes ownership also uses this
    // budget. Merge it into the complete notice rather than charging it twice.
    fn account<T: Serialize>(
        &self,
        value: &T,
        previous: Option<OwnedSemaphorePermit>,
    ) -> Result<OwnedSemaphorePermit, String> {
        let mut permit = previous.unwrap_or(
            self.channel
                .bytes
                .clone()
                .try_acquire_many_owned(0)
                .map_err(|_| FAILURE)?,
        );
        let have = permit.num_permits();
        let mut counter = Counter {
            bytes: 0,
            limit: self.channel.bytes.available_permits() + have,
        };
        serde_json::to_writer(&mut counter, value).map_err(|_| FAILURE)?;
        if counter.bytes > have {
            let extra = self
                .channel
                .bytes
                .clone()
                .try_acquire_many_owned((counter.bytes - have).try_into().map_err(|_| FAILURE)?)
                .map_err(|_| FAILURE)?;
            permit.merge(extra);
        } else if have > counter.bytes {
            drop(
                permit
                    .split(have - counter.bytes)
                    .expect("measured surplus"),
            );
        }
        Ok(permit)
    }

    async fn decide<T: DecisionRequest + Send>(
        self: &Arc<Self>,
        request: T,
        token: &CancellationToken,
    ) -> Result<Decision, String> {
        self.decide_retained(request, token, None, None).await
    }

    async fn decide_retained<T: DecisionRequest + Send>(
        self: &Arc<Self>,
        request: T,
        token: &CancellationToken,
        previous: Option<OwnedSemaphorePermit>,
        is_cancelled: Option<CancellationProbe>,
    ) -> Result<Decision, String> {
        self.decide_released(request, token, previous, is_cancelled, None)
            .await
    }

    async fn decide_released<T: DecisionRequest + Send>(
        self: &Arc<Self>,
        request: T,
        token: &CancellationToken,
        previous: Option<OwnedSemaphorePermit>,
        is_cancelled: Option<CancellationProbe>,
        physical_release: Option<&mut Option<NoticeRelease>>,
    ) -> Result<Decision, String> {
        let profile_source = request.profile_source().cloned();
        let source_policy = profile_source
            .as_ref()
            .map(|source| source.policy.as_ref().ok_or(FAILURE))
            .transpose()?;
        let identity = request.tool_identity().map(|(namespace, name)| {
            ToolName::new(namespace.map(str::to_owned), name).with_default_namespace()
        });
        let source_rule = source_policy
            .and_then(|policy| identity.as_ref().and_then(|key| policy.rules.get(key)))
            .map(|rule| (rule.0, rule.1, rule.2, rule.3, rule.4));
        let owner = request.owner().cloned();
        let retained = request.retained();
        let binding = request.binding().is_some();
        let (nonce, deadline, rx) = {
            let mut state = self
                .channel
                .state
                .lock()
                .expect("interception control poisoned");
            if state.mcp_poisoned
                || state.mcp_publication.is_some()
                || is_cancelled.as_ref().is_some_and(|probe| probe())
            {
                return Err(FAILURE.into());
            }
            if !self.configured_in(&state) && source_rule.is_none() {
                return Ok(Decision::Continue);
            }
            let (timeout, generation, stop_allowed) = if binding {
                (state.timeout, None, false)
            } else if state.tools.is_some() || source_policy.is_some() {
                let Some(key) = identity.as_ref() else {
                    return Ok(Decision::Continue);
                };
                let global = state
                    .tools
                    .as_ref()
                    .and_then(|tools| tools.get(key))
                    .map(|rule| (rule.0, rule.1, rule.2, rule.3, rule.4));
                let rule = if source_policy.is_some_and(|policy| policy.names.contains(key))
                    || (source_policy.is_some() && global.is_some_and(|rule| rule.2.is_some()))
                {
                    source_rule
                } else {
                    global
                };
                let Some((timeout, scope, generation, _, executor_before)) = rule else {
                    return Ok(Decision::Continue);
                };
                if !self.root && scope != Scope::ThreadTree {
                    return Ok(Decision::Continue);
                }
                if generation.is_some() && request.phase() != Some("before") {
                    return Ok(Decision::Continue);
                }
                let stop_allowed = generation.is_some()
                    || (executor_before
                        && key.is_default_namespace()
                        && matches!(
                            key.name.as_str(),
                            "exec_command"
                                | "write_stdin"
                                | "apply_patch"
                                | "project_glob"
                                | "project_grep"
                        )
                        && request.phase() == Some("before")
                        && request.boundary() == Some("pre_dispatch"));
                (timeout, generation, stop_allowed)
            } else {
                (state.timeout, None, false)
            };
            if state.revoked
                || self.stopped.is_cancelled()
                || state.pending.len() >= MAX_PENDING
                || owner
                    .as_ref()
                    .is_some_and(|owner| !owner.admits_policy(retained))
            {
                return Err(FAILURE.into());
            }
            state.nonce = state.nonce.checked_add(1).ok_or(FAILURE)?;
            let nonce = state.nonce;
            let deadline = timeout.map(|timeout| Instant::now() + timeout);
            let notice = Notice {
                mcp_identity: source_policy.and_then(|policy| {
                    identity
                        .as_ref()
                        .and_then(|name| policy.identities.get(name))
                }),
                profile_id: profile_source
                    .as_ref()
                    .and_then(|source| source.receipt.as_ref())
                    .map(|receipt| receipt.profile_id.as_str()),
                profile_epoch: profile_source
                    .as_ref()
                    .and_then(|source| source.receipt.as_ref())
                    .map(|receipt| receipt.epoch),
                nonce,
                generation,
                realtime_tool_name: identity
                    .as_ref()
                    .map(codex_extension_api::realtime_tool_wire_name),
                request: Identified {
                    thread_id: &self.id,
                    agent_role: self.agent_role.get().and_then(|role| role.as_deref()),
                    incarnation: &self.incarnation,
                    request,
                },
            };
            let (bytes, wire) = if let Some(cell_owner) = notice.request.request.binding() {
                #[derive(Serialize)]
                struct BindingNotice<'a> {
                    nonce: u64,
                    cell_owner: &'a CellOwnerMetadata,
                }
                let binding = BindingNotice { nonce, cell_owner };
                let bytes = self.account(&binding, previous)?;
                (bytes, serde_json::to_string(&binding).map_err(|_| FAILURE)?)
            } else {
                let bytes = self.account(&notice, previous)?;
                (bytes, serde_json::to_string(&notice).map_err(|_| FAILURE)?)
            };
            let (tx, rx) = oneshot::channel();
            let released = physical_release.map(|receipt| {
                let (released, returned) = oneshot::channel();
                *receipt = Some(returned);
                released
            });
            state.pending.insert(
                nonce,
                Pending {
                    profile_source: profile_source.clone(),
                    owner: owner.clone(),
                    retained,
                    generation,
                    stop_allowed,
                    stopped: self.stopped.clone(),
                    request_cancelled: token.clone(),
                    is_cancelled: is_cancelled.clone(),
                    deadline,
                    reply: Some(tx),
                    control: Arc::downgrade(self),
                    payload: Payload::Queued(wire),
                    _bytes: bytes,
                    _released: released,
                },
            );
            if self.channel.sender.send(Message::Payload(nonce)).is_err() {
                state.pending.remove(&nonce);
                return Err(FAILURE.into());
            }
            (nonce, deadline, rx)
        };
        let _reservation = Reservation {
            control: self.clone(),
            nonce,
        };
        let mut rx = rx;
        let reply = tokio::select! {
            biased;
            _ = self.stopped.cancelled() => return Err(FAILURE.into()),
            _ = token.cancelled() => return Err(FAILURE.into()),
            reply = &mut rx => reply,
            () = async {
                tokio::time::sleep_until(deadline.expect("finite deadline guard").into()).await;
            }, if deadline.is_some() => {
                // A claimed sender wins the deadline even if the receiver was delayed.
                {
                    let mut state = self.channel.state.lock().expect("interception control poisoned");
                    if let Some(pending) = state.pending.get_mut(&nonce) { pending.reply.take(); }
                }
                rx.await
            },
        };
        match reply {
            Ok(Reply::HoldForStop) => {
                tokio::select! {
                    _ = self.stopped.cancelled() => {},
                    _ = token.cancelled() => {},
                }
                Err(FAILURE.into())
            }
            reply => {
                // Resolve may have delivered and removed this reservation
                // before root revoke. Accept under the same lock as revoke,
                // including when this Control belongs to a still-live child.
                let state = self
                    .channel
                    .state
                    .lock()
                    .expect("interception control poisoned");
                match reply {
                    Ok(Reply::Decision(
                        decision @ (Decision::Continue | Decision::Replace { .. }),
                    )) if !state.revoked
                        && !state.mcp_poisoned
                        && state.mcp_publication.is_none()
                        && is_cancelled.as_ref().is_none_or(|probe| !probe())
                        && owner
                            .as_ref()
                            .is_none_or(|owner| owner.admits_policy(retained)) =>
                    {
                        Ok(decision)
                    }
                    _ => Err(FAILURE.into()),
                }
            }
        }
    }
}

/// An opted-in MCP update owns its combined rule and roster publication.
/// Dropping uncertain work keeps admission fenced until joined Session close.
pub(crate) struct McpPublication {
    control: Arc<Control>,
    previous: Option<Rules>,
    settled: bool,
}
impl McpPublication {
    #[cfg(test)]
    pub(crate) fn begin(
        boundary: &Boundary,
        control: Arc<Control>,
        rules: Vec<ToolRule>,
        generation: u64,
    ) -> Result<Option<Self>> {
        Self::begin_with_profile(boundary, control, rules, generation, None)
    }

    pub(crate) fn begin_with_profile(
        boundary: &Boundary,
        control: Arc<Control>,
        rules: Vec<ToolRule>,
        generation: u64,
        captured: Option<&ProfileMcpPolicy>,
    ) -> Result<Option<Self>> {
        let next = Control::compile_rules(rules)?;
        ensure!(
            next.values()
                .all(|rule| rule.2.is_none_or(|g| g == generation)),
            "MCP pre-policy generation mismatch"
        );
        let mut state = control
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        let policy = |rules: &Option<Rules>| {
            rules
                .as_ref()
                .is_some_and(|rules| rules.values().any(|rule| rule.2.is_some()))
        };
        if !policy(&state.tools)
            && !captured.is_some_and(ProfileMcpPolicy::has_pre_policy)
            && !next.values().any(|rule| rule.2.is_some())
        {
            return Ok(None);
        }
        ensure!(
            control.root
                && state.timeout.is_some()
                && !state.revoked
                && !state.mcp_poisoned
                && state.mcp_publication.is_none(),
            "MCP policy publication is unavailable"
        );
        ensure!(
            state.pending.is_empty(),
            "MCP policy update requires released native callbacks"
        );
        ensure!(
            boundary
                .graph_members(&control, crate::graph_stop::Scope::Tree)
                .iter()
                .all(|owner| Arc::ptr_eq(owner, &control)),
            "MCP policy update requires no live native descendants"
        );
        state.mcp_publication = Some(false);
        let previous = state.tools.replace(next);
        drop(state);
        Ok(Some(Self {
            control,
            previous,
            settled: false,
        }))
    }
    pub(crate) fn rollback(mut self) {
        let mut state = self
            .control
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        state.tools = self.previous.take();
        state.mcp_publication = None;
        self.settled = true;
    }
    pub(crate) fn commit(mut self) -> Result<()> {
        let mut state = self
            .control
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        ensure!(
            state.mcp_publication == Some(false)
                && !state.revoked
                && !self.control.stopped.is_cancelled(),
            "MCP policy publication lost native ownership"
        );
        state.mcp_publication = None;
        self.settled = true;
        Ok(())
    }
}
impl Drop for McpPublication {
    fn drop(&mut self) {
        if !self.settled {
            let mut state = self
                .control
                .channel
                .state
                .lock()
                .expect("interception control poisoned");
            state.mcp_poisoned = true;
            // Do not restore old rules after a possible native publication.
        }
    }
}

// Drop covers native cancellation even when the future is dropped from outside
// select!, plus timeouts and successful completion. Nonces are never reused.
struct Reservation {
    control: Arc<Control>,
    nonce: u64,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let mut state = self
            .control
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        if let Some(pending) = state.pending.get_mut(&self.nonce) {
            pending.reply.take();
            if !matches!(pending.payload, Payload::InFlight | Payload::Callback) {
                state.pending.remove(&self.nonce);
            }
        }
        let _ = self
            .control
            .channel
            .sender
            .send(Message::Cancel(self.nonce));
    }
}

// Pinned native dispatch awaits lifecycle start and Session.execute within one
// tokio::spawn (parallel.rs); abort notification may run in the joining task.
// Only the short start-to-session handoff lives here. Cells retain their owner
// separately, never in this index. Register opt-out starts too so even
// reuse of a completed native task id cannot adopt a stale opted-in owner.
struct StartedExec {
    profile_source: Result<Option<Arc<ProfileMcpSource>>, String>,
    rules: Option<crate::canonical_rules::CellImageOrigin>,
    turn: Option<Arc<DirectTurn>>,
    control: Arc<Control>,
    turn_id: String,
    model: Option<Arc<str>>,
    call_id: String,
    name: &'static str,
}

impl StartedExec {
    async fn edit_response(
        &self,
        mut response: RuntimeResponse,
        input: Value,
        outer_call_id: Option<&str>,
        bytes: OwnedSemaphorePermit,
    ) -> Result<RuntimeResponse, String> {
        let (cell_id, content_items) = match &mut response {
            // Native failures (including their partial output) are not successes.
            RuntimeResponse::Result {
                error_text: Some(_),
                ..
            } => return Ok(response),
            RuntimeResponse::Result {
                cell_id,
                content_items,
                ..
            }
            | RuntimeResponse::Yielded {
                cell_id,
                content_items,
                ..
            }
            | RuntimeResponse::Terminated {
                cell_id,
                content_items,
                ..
            } => (cell_id, content_items),
        };
        let tracing = codex_otel::sdk_trace::ContextLease::capture();
        let request = Request {
            tracing_context: tracing.as_ref().map(|context| context.token()),
            phase: "after",
            route: "code_mode",
            boundary: "cell_return",
            turn_id: &self.turn_id,
            model: self.model.as_deref(),
            call_id: Some(&self.call_id),
            outer_call_id,
            cell_id: Some(cell_id),
            runtime_tool_call_id: None,
            tool_name: Name {
                namespace: None,
                name: self.name,
            },
            tool_kind: if self.name == codex_code_mode::PUBLIC_TOOL_NAME {
                "freeform"
            } else {
                "function_json"
            },
            input: &input,
            result: &*content_items,
        };
        // A dropped observation revokes only its callback reservation. Native
        // preemption is a yield signal, never a cell-cancellation token.
        let token = CancellationToken::new();
        if let Decision::Replace { value } = self
            .control
            .decide_retained(request, &token, Some(bytes), None)
            .await?
        {
            *content_items = serde_json::from_value(value).map_err(|_| FAILURE.to_owned())?;
        }
        Ok(response)
    }
}

pub struct Boundary {
    engine: std::sync::OnceLock<Weak<crate::engine::EngineState>>,
    // Historical failure fences admission even after every receiver is joined.
    import_cleanup_failure: Arc<Mutex<Option<String>>>,
    code_imports: Mutex<Vec<Arc<PendingCodeImport>>>,
    restored_code: Mutex<HashMap<codex_protocol::ThreadId, Arc<codex_code_mode::CodeModeSnapshot>>>,
    starts: Mutex<HashMap<tokio::task::Id, StartedExec>>,
    numeric_forks: Mutex<HashMap<tokio::task::Id, NumericFork>>,
    threads: Mutex<HashMap<String, Weak<Control>>>,
    graph: Arc<crate::storage::MemoryAgentGraph>,
    sentinel: Arc<RwLock<Option<(String, String, Option<String>)>>>,
}

// One source read in the actual native spawn dispatch, never indexed by the
// model's path. Weak owners cannot keep an aborted turn or retired root alive.
struct NumericFork {
    control: Weak<Control>,
    turn: Weak<DirectTurn>,
    call_id: String,
}

impl Boundary {
    pub(crate) fn bind_engine(&self, engine: Weak<crate::engine::EngineState>) {
        assert!(
            self.engine.set(engine).is_ok(),
            "native HTTP engine already bound"
        );
    }

    // Capture the exact managed generation receipt when creating a request
    // interceptor; callers must not look up the latest turn on response events.
    pub(crate) fn response_admission(
        &self,
        thread: &str,
    ) -> Option<Arc<crate::turn_settlement::Turn>> {
        let control = self
            .threads
            .lock()
            .expect("interception index poisoned")
            .get(thread)?
            .upgrade()?;
        control
            .direct_turn
            .lock()
            .expect("interception turn poisoned")
            .as_ref()?
            .settlement()
    }

    pub fn new(
        graph: Arc<crate::storage::MemoryAgentGraph>,
        sentinel: Arc<RwLock<Option<(String, String, Option<String>)>>>,
    ) -> Self {
        Self {
            engine: std::sync::OnceLock::new(),
            import_cleanup_failure: Arc::default(),
            code_imports: Mutex::default(),
            restored_code: Mutex::default(),
            starts: Mutex::default(),
            numeric_forks: Mutex::default(),
            threads: Mutex::default(),
            graph,
            sentinel,
        }
    }

    pub(crate) fn check_code_import_admission(&self) -> Result<()> {
        if let Some(error) = self.code_import_diagnostic() {
            anyhow::bail!(error);
        }
        Ok(())
    }

    // This barrier measures outstanding receivers, never historical errors.
    pub(crate) fn check_code_import_cleanup(&self) -> Result<()> {
        ensure!(
            self.code_imports
                .lock()
                .expect("code imports poisoned")
                .is_empty(),
            "Native CodeMode import cleanup is incomplete"
        );
        Ok(())
    }

    fn code_import_diagnostic(&self) -> Option<String> {
        self.import_cleanup_failure
            .lock()
            .expect("code import failure poisoned")
            .clone()
    }

    fn record_code_import_failure(&self, error: &str) {
        self.import_cleanup_failure
            .lock()
            .expect("code import failure poisoned")
            .get_or_insert_with(|| format!("Native CodeMode import cleanup failed: {error}"));
        // Publish poison before collecting owners. Registration checks the same
        // marker after insertion, covering owners born during this sweep.
        let controls: Vec<_> = self
            .threads
            .lock()
            .expect("interception index poisoned")
            .values()
            .filter_map(Weak::upgrade)
            .collect();
        for control in controls {
            control.revoke();
            control.graph().changed.send_replace(());
        }
    }

    fn retain_code_import(
        &self,
        thread_id: codex_protocol::ThreadId,
        control: &Arc<Control>,
        turn: Option<&Arc<DirectTurn>>,
        session: Arc<dyn CodeModeSession>,
    ) -> Arc<PendingCodeImport> {
        let pending = Arc::new(PendingCodeImport {
            thread_id,
            control: Arc::downgrade(control),
            session,
            turn: turn.map(Arc::downgrade),
            operation: AsyncMutex::new(CodeImportState::Pending),
        });
        self.code_imports
            .lock()
            .expect("code imports poisoned")
            .push(pending.clone());
        pending
    }

    fn forget_code_import(&self, pending: &Arc<PendingCodeImport>) {
        self.code_imports
            .lock()
            .expect("code imports poisoned")
            .retain(|current| !Arc::ptr_eq(current, pending));
        if let Some(control) = pending.control.upgrade() {
            let mut current = control
                .pending_code_import
                .lock()
                .expect("pending code import poisoned");
            if current
                .as_ref()
                .is_some_and(|current| Weak::ptr_eq(current, &Arc::downgrade(pending)))
            {
                current.take();
            }
        }
    }

    // Import, publication and shutdown share one receipt lock. Cancelled
    // waiters leave Pending; only an acknowledged success consumes a receiver.
    async fn close_code_import(&self, pending: &Arc<PendingCodeImport>) -> Result<()> {
        let mut operation = pending.operation.lock().await;
        if *operation != CodeImportState::Pending {
            return Ok(());
        }
        if let Err(error) = pending.session.shutdown().await {
            self.record_code_import_failure(&error);
            anyhow::bail!(error);
        }
        *operation = CodeImportState::Closed;
        self.forget_code_import(pending);
        Ok(())
    }

    async fn join_code_imports(
        &self,
        pending: Vec<Arc<PendingCodeImport>>,
        deadline: tokio::time::Instant,
    ) -> Result<Option<String>> {
        let mut failure = None;
        for receiver in &pending {
            let result = tokio::time::timeout_at(deadline, self.close_code_import(receiver)).await;
            let error = match result {
                Ok(Ok(())) => continue,
                Ok(Err(error)) => error,
                Err(_) => {
                    let error = "Native CodeMode import cleanup timed out";
                    self.record_code_import_failure(error);
                    anyhow::anyhow!(error)
                }
            };
            failure.get_or_insert(error);
        }
        // Another joiner may have acknowledged a failed/timed-out receiver
        // before this sweep ends. Only receipts still outstanding block close.
        if let Some(error) = failure
            && self
                .code_imports
                .lock()
                .expect("code imports poisoned")
                .iter()
                .any(|current| {
                    pending
                        .iter()
                        .any(|selected| Arc::ptr_eq(current, selected))
                })
        {
            return Err(error);
        }
        Ok(self.code_import_diagnostic())
    }

    // Engine supplies its existing absolute close deadline. None joins all
    // threads; Some joins one native ID, including retired incarnations.
    pub(crate) async fn cleanup_code_imports(
        &self,
        thread_id: Option<codex_protocol::ThreadId>,
        deadline: tokio::time::Instant,
    ) -> Result<Option<String>> {
        let pending = self
            .code_imports
            .lock()
            .expect("code imports poisoned")
            .iter()
            .filter(|pending| thread_id.is_none_or(|id| pending.thread_id == id))
            .cloned()
            .collect();
        let diagnostic = self.join_code_imports(pending, deadline).await?;
        ensure!(
            !self
                .code_imports
                .lock()
                .expect("code imports poisoned")
                .iter()
                .any(|pending| thread_id.is_none_or(|id| pending.thread_id == id)),
            "Native CodeMode import cleanup is incomplete"
        );
        Ok(diagnostic)
    }

    async fn close_pending_code_import(
        &self,
        control: &Arc<Control>,
        turn: Option<&Arc<DirectTurn>>,
    ) -> Result<Option<String>> {
        let pending = self
            .code_imports
            .lock()
            .expect("code imports poisoned")
            .iter()
            .filter(|pending| {
                Weak::ptr_eq(&pending.control, &Arc::downgrade(control))
                    && turn.is_none_or(|turn| {
                        pending
                            .turn
                            .as_ref()
                            .is_some_and(|owner| Weak::ptr_eq(owner, &Arc::downgrade(turn)))
                    })
            })
            .cloned()
            .collect();
        self.join_code_imports(
            pending,
            tokio::time::Instant::now() + crate::engine::CLOSE_TIMEOUT,
        )
        .await
    }

    pub(crate) fn stage_code_state(
        &self,
        id: codex_protocol::ThreadId,
        state: codex_code_mode::CodeModeSnapshot,
    ) {
        self.restored_code
            .lock()
            .expect("restored code state poisoned")
            .insert(id, Arc::new(state));
    }

    pub(crate) fn pending_code_state(
        &self,
        id: codex_protocol::ThreadId,
    ) -> Option<Arc<codex_code_mode::CodeModeSnapshot>> {
        self.restored_code
            .lock()
            .expect("restored code state poisoned")
            .get(&id)
            .cloned()
    }

    pub(crate) fn clear_code_state(&self, id: codex_protocol::ThreadId) {
        self.restored_code
            .lock()
            .expect("restored code state poisoned")
            .remove(&id);
    }

    async fn parent_control(&self, source: &SessionSource) -> Option<Arc<Control>> {
        // Only ThreadSpawn supplies this identity. Fork history and other
        // internal SubAgent sources never authorize graph traversal.
        let mut id = source.parent_thread_id()?;
        let mut visited = HashSet::new();
        while visited.insert(id) {
            let live = self
                .threads
                .lock()
                .expect("interception index poisoned")
                .get(&id.to_string())
                .and_then(Weak::upgrade);
            if live.is_some() {
                // Never skip an opted-out or revoked live owner to find a
                // different root. Its current choice governs descendants.
                return live;
            }
            // On cold V2 resume only the target may be loaded. The engine's
            // native graph retains intermediate ThreadSpawn edges after eviction.
            // No index lock is held while awaiting the graph's own lock.
            id = self.graph.edge(id).await?.parent;
        }
        None
    }

    fn start_exec(&self, control: Arc<Control>, turn_id: &str, call_id: &str, name: &'static str) {
        self.start_exec_source(control, turn_id, call_id, name, None)
    }
    fn start_exec_source(
        &self,
        control: Arc<Control>,
        turn_id: &str,
        call_id: &str,
        name: &'static str,
        step: Option<&ExtensionData>,
    ) {
        // A retained cell keeps its issuing model across later generations.
        let turn = control
            .direct_turn
            .lock()
            .expect("interception turn poisoned")
            .as_ref()
            .filter(|turn| turn.id == turn_id)
            .cloned();
        let model = turn.as_ref().and_then(|turn| {
            turn.model
                .lock()
                .expect("interception model poisoned")
                .clone()
        });
        self.starts
            .lock()
            .expect("interception boundary poisoned")
            .insert(
                tokio::task::id(),
                StartedExec {
                    profile_source: capture_mcp_source(step),
                    rules: None,
                    turn,
                    control,
                    turn_id: turn_id.to_owned(),
                    model,
                    call_id: call_id.to_owned(),
                    name,
                },
            );
    }

    fn take_exec(&self, call_id: &str) -> Result<Option<StartedExec>, String> {
        let owner = self.take_start(codex_code_mode::PUBLIC_TOOL_NAME);
        match owner {
            Some(owner) if owner.call_id != call_id => Err(FAILURE.into()),
            // Even an opted-out start retains its exact task owner for Core's
            // execute_owned handoff. It cannot acquire a later policy.
            other => Ok(other),
        }
    }

    fn register_control(&self, control: &Arc<Control>) {
        let _ = control
            .import_cleanup_failure
            .set(self.import_cleanup_failure.clone());
        let mut channel = control
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        if let Some(conflict) = channel.mcp_publication.as_mut() {
            *conflict = true;
        }
        self.threads
            .lock()
            .expect("interception index poisoned")
            .insert(control.id.clone(), Arc::downgrade(control));
        drop(channel);
        if control.code_import_poisoned() {
            control.revoke();
            control.graph().changed.send_replace(());
        }
    }

    pub(crate) fn graph_members(
        &self,
        root: &Arc<Control>,
        scope: crate::graph_stop::Scope,
    ) -> Vec<Arc<Control>> {
        self.threads
            .lock()
            .expect("interception index poisoned")
            .values()
            .filter_map(Weak::upgrade)
            .filter(|owner| {
                !owner.is_stopped()
                    && Arc::ptr_eq(&root.channel, &owner.channel)
                    && (scope == crate::graph_stop::Scope::Tree || Arc::ptr_eq(root, owner))
            })
            .collect()
    }

    fn take_start(&self, name: &str) -> Option<StartedExec> {
        tokio::task::try_id().and_then(|id| {
            let mut starts = self.starts.lock().expect("interception boundary poisoned");
            // Core also calls terminate on interrupt without dispatching a wait
            // tool. It must never consume another task's unrelated handoff.
            if starts.get(&id).is_some_and(|owner| owner.name == name) {
                starts.remove(&id)
            } else {
                None
            }
        })
    }

    fn finish_exec(&self, thread_id: &str, turn_id: &str, call_id: &str) {
        // Normal completion has already consumed the handoff. Parse/availability
        // failure or abort can finish elsewhere; never use the finishing task id.
        self.starts
            .lock()
            .expect("interception boundary poisoned")
            .retain(|_, owner| {
                owner.control.id != thread_id
                    || owner.turn_id != turn_id
                    || owner.call_id != call_id
            });
    }

    pub(crate) fn take_numeric_fork_source(&self, thread_id: codex_protocol::ThreadId) -> bool {
        let Some(task) = tokio::task::try_id() else {
            return false;
        };
        let mut forks = self.numeric_forks.lock().expect("numeric forks poisoned");
        let Some(fork) = forks.get(&task) else {
            return false;
        };
        let (Some(control), Some(turn)) = (fork.control.upgrade(), fork.turn.upgrade()) else {
            forks.remove(&task);
            return false;
        };
        if control.id != thread_id.to_string() {
            return false;
        }
        let current = control
            .direct_turn
            .lock()
            .expect("interception turn poisoned");
        let active = !control.stopped.is_cancelled()
            && !turn.cancelled.is_cancelled()
            && current
                .as_ref()
                .is_some_and(|live| Arc::ptr_eq(live, &turn));
        forks.remove(&task);
        active
    }

    fn finish_numeric_forks(
        &self,
        control: &Arc<Control>,
        turn_id: Option<&str>,
        call_id: Option<&str>,
    ) {
        // Core may finish an aborted dispatch from a different task.
        self.numeric_forks
            .lock()
            .expect("numeric forks poisoned")
            .retain(|_, fork| {
                let (Some(owner), Some(turn)) = (fork.control.upgrade(), fork.turn.upgrade())
                else {
                    return false;
                };
                !Arc::ptr_eq(&owner, control)
                    || turn_id.is_some_and(|id| turn.id != id)
                    || call_id.is_some_and(|id| fork.call_id != id)
            });
    }
}

impl std::fmt::Debug for Boundary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeInterceptionBoundary")
            .finish_non_exhaustive()
    }
}

impl ThreadLifecycleContributor<Config> for Boundary {
    fn on_thread_execution_revoked(&self, thread_store: &ExtensionData) {
        if let Some(control) = thread_store.get::<Control>() {
            control.revoke();
        }
    }

    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let creation_tracing = codex_otel::sdk_trace::CapturedContext::capture().context;
            let creation_trace = if creation_tracing.is_none() {
                codex_otel::current_span_w3c_trace_context()
            } else {
                None
            };
            let root = !matches!(
                input.session_source,
                SessionSource::Internal(_) | SessionSource::SubAgent(_)
            );
            // parent_thread_id is native and returns Some only for ThreadSpawn.
            // Start is awaited before the first turn, unlike UI creation notices.
            let parent = self.parent_control(input.session_source).await;
            // The root's canonical cwd is authority for root write changes.
            // A child carries receipt provenance, and Core reads its cwd and
            // policy from the executor actually selected for each sample.
            let strict_executor_writes = input.thread_store.get::<StrictExecutorWrites>().is_some()
                || (matches!(input.environments, [selection]
                    if matches!(selection.config, EnvironmentConfigState::Ready(_)))
                    && parent.as_ref().is_some_and(|owner| {
                        !owner.stopped.is_cancelled() && owner.strict_executor_writes()
                    }));
            let has_parent = parent.is_some();
            let managed_response = input
                .thread_store
                .get::<crate::options::ThreadInstructions>()
                .is_some_and(|instructions| instructions.managed())
                || parent
                    .as_ref()
                    .is_some_and(|owner| owner.managed_response());
            let control = input.thread_store.get_or_init(|| {
                let id = input.thread_store.level_id().to_owned();
                match parent {
                    Some(parent) => Control::descendant(id, &parent),
                    None => Control::new(id, root),
                }
            });
            if input
                .thread_store
                .get::<crate::agent_profiles::OpeningProfiles>()
                .is_some()
            {
                control.enable_profile_policies();
            }
            if let Some(step) = input.spawning_step_store {
                match capture_mcp_source(Some(step)) {
                    Ok(Some(source)) => {
                        input.thread_store.insert((*source).clone());
                        if let Some(selection) = step.get::<crate::mcp_result_control::Selection>()
                        {
                            input.thread_store.insert((*selection).clone());
                        }
                    }
                    Ok(None) if control.profile_policies.load(Ordering::Acquire) == 2 => {
                        control.revoke()
                    }
                    Err(_) => control.revoke(),
                    _ => {}
                }
            } else if !root && control.profile_policies.load(Ordering::Acquire) == 2 {
                // Runtime-only spawn authority is absent on an unvalidated managed restart.
                control.revoke();
            }
            let _ = control.creation_tracing.set(creation_tracing);
            let _ = control.creation_trace.set(creation_trace);
            if strict_executor_writes {
                let _ = control.strict_executor_writes.set(());
            }
            let _ = control.review_delegate.set(matches!(
                input.session_source,
                SessionSource::SubAgent(codex_protocol::protocol::SubAgentSource::Review)
            ));
            let _ = control
                .agent_role
                .set(input.session_source.get_agent_role());
            if let Some(policy) = input.thread_store.get::<crate::native_agents::Policy>() {
                if let Some(allowed) = input.thread_store.get::<ToolPolicy>() {
                    let _ = policy.allowed.set(allowed);
                }
                let _ = control.native_agents.set(policy);
            }
            let _ = control.managed_response.set(managed_response);
            let settlement = input
                .thread_store
                .get_or_init(crate::turn_settlement::Settlement::default);
            let _ = control.settlement.set(Arc::downgrade(&settlement));
            if root
                && let Some(policy) = input.thread_store.get::<ToolPolicy>()
                && policy.allowed_tools.is_some()
                && policy.require_managed_sandbox
                && policy.require_unified_exec
                && !policy.expose_additional_permissions
            {
                if policy.allows(&ToolName::plain("write_stdin")) {
                    let _ = control.stdin_admission.set(());
                }
                if policy.allows(&ToolName::plain("exec_command"))
                    && input
                        .thread_store
                        .get::<EagerCommandEnvironment>()
                        .is_some_and(|origin| origin.0)
                    && input.config.features.enabled(Feature::ShellTool)
                    && input.config.features.enabled(Feature::UnifiedExec)
                    // WorldState exposes ready selections only. Stable tools
                    // count pending selections too, so Core must own that mode.
                    && !input.config.features.enabled(Feature::StableEnvironmentTools)
                {
                    let _ = control
                        .command_tty
                        .set(input.config.features.enabled(Feature::UnifiedExecTty));
                }
            }
            let _ = control
                .collaboration_namespace
                .set(input.config.multi_agent_v2.tool_namespace.clone());
            let is_bound = self
                .sentinel
                .read()
                .expect("sentinel poisoned")
                .as_ref()
                .and_then(|(_, _, excluded)| excluded.as_ref())
                .is_some_and(|base| input.config.model_provider.base_url.as_ref() == Some(base));
            if (has_parent || !is_bound)
                && input
                    .config
                    .model_provider
                    .http_headers
                    .as_ref()
                    .is_some_and(|headers| headers.contains_key("x-sdk-sentinel-grant"))
            {
                let _ = control.sentinel_provider.set((
                    input.config.model_provider_id.clone(),
                    input
                        .config
                        .features
                        .enabled(codex_core_api::Feature::ContentItemKinds),
                ));
            }
            self.register_control(&control);
        })
    }

    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(control) = input.thread_store.get::<Control>() {
                {
                    let mut threads = self.threads.lock().expect("interception index poisoned");
                    if threads
                        .get(&control.id)
                        .is_some_and(|current| Weak::ptr_eq(current, &Arc::downgrade(&control)))
                    {
                        threads.remove(&control.id);
                    }
                }
                control.revoke();
                control.join_websocket_drivers().await;
                control.graph().changed.send_replace(());
                self.finish_numeric_forks(&control, None, None);
                self.starts
                    .lock()
                    .expect("interception boundary poisoned")
                    .retain(|_, owner| !Arc::ptr_eq(&owner.control, &control));
                let _ = self.close_pending_code_import(&control, None).await;
                if let Some(tracing) = control.creation_tracing() {
                    tracing.release_callback_ownership();
                }
            }
        })
    }
}

impl TurnLifecycleContributor for Boundary {
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(control) = input.thread_store.get::<Control>() {
                if !control.root {
                    if let Some(link) = control
                        .channel
                        .request_attempts
                        .lock()
                        .expect("request attempts link poisoned")
                        .as_ref()
                    {
                        link.attach(input.thread_store);
                    }
                    if let Some(link) = control
                        .channel
                        .raw_usage
                        .lock()
                        .expect("raw usage link poisoned")
                        .as_ref()
                    {
                        link.attach(input.thread_store);
                    }
                }
                if !control.stopped.is_cancelled()
                    && control
                        .channel
                        .observe_raw_provider_events
                        .load(Ordering::Acquire)
                {
                    input
                        .thread_store
                        .insert(codex_core::ObserveRawProviderEvents);
                }
                let settlement = input
                    .turn_store
                    .get::<crate::turn_settlement::Turn>()
                    .map(|turn| Arc::downgrade(&turn));
                let core_task = input.turn_store.get::<codex_core_api::OwnedTurnTask>();
                let owner = input.turn_store.get_or_init(|| DirectTurn {
                    policy_stopped: AtomicBool::new(false),
                    id: input.turn_id.to_owned(),
                    model: Mutex::new(None),
                    command_admission: Mutex::new(None),
                    cancelled: CancellationToken::new(),
                    settlement,
                    core_task,
                    mcp_calls: Mutex::default(),
                });
                let mut current = control
                    .direct_turn
                    .lock()
                    .expect("interception turn poisoned");
                if let Some(previous) = current.replace(owner.clone())
                    && !Arc::ptr_eq(&previous, &owner)
                {
                    previous.cancelled.cancel();
                }
            }
        })
    }
    fn on_turn_stop<'a>(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            crate::request_metadata::retire(input.turn_store);
            if let Some(control) = input.thread_store.get::<Control>() {
                control.end_direct_turn(input.turn_store);
                if let Some(owner) = input.turn_store.get::<DirectTurn>() {
                    self.finish_numeric_forks(&control, Some(&owner.id), None);
                    let _ = self.close_pending_code_import(&control, Some(&owner)).await;
                }
            }
        })
    }
    fn on_turn_abort<'a>(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            crate::request_metadata::retire(input.turn_store);
            if let Some(control) = input.thread_store.get::<Control>() {
                control.end_direct_turn(input.turn_store);
                if let Some(owner) = input.turn_store.get::<DirectTurn>() {
                    self.finish_numeric_forks(&control, Some(&owner.id), None);
                    let _ = self.close_pending_code_import(&control, Some(&owner)).await;
                }
            }
        })
    }
}

impl ContextContributor for Boundary {
    fn contribute_world_state<'a>(
        &'a self,
        input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move {
            if input.step_store.get::<ProfileMcpSource>().is_none() {
                if let Some(source) = input.thread_store.get::<ProfileMcpSource>() {
                    input.step_store.insert((*source).clone());
                    if let Some(selection) = input
                        .thread_store
                        .get::<crate::mcp_result_control::Selection>()
                    {
                        input.step_store.insert((*selection).clone());
                    }
                }
            }

            if let Some(turn) = input.turn_store.get::<DirectTurn>() {
                let selected = match (
                    input.thread_store.get::<Control>(),
                    input.environments,
                    &input.model_info.shell_type,
                ) {
                    (Some(control), [selection], ConfigShellToolType::UnifiedExec)
                        if matches!(
                            selection.environment_id.as_str(),
                            codex_exec_server::LOCAL_ENVIRONMENT_ID
                                | codex_exec_server::REMOTE_ENVIRONMENT_ID
                        ) =>
                    {
                        match (&selection.config, control.command_tty.get()) {
                            (EnvironmentConfigState::Ready(environment), Some(tty)) => {
                                Some(CommandAdmission {
                                    login: environment.allow_login_shell,
                                    tty: *tty,
                                })
                            }
                            _ => None,
                        }
                    }
                    _ => None,
                };
                *turn
                    .command_admission
                    .lock()
                    .expect("command admission poisoned") = selected;
            }
            // No prompt text, checkpoint state or independent receipt: this
            // gate uses the same environments as Core's current tool plan.
            Vec::new()
        })
    }
}

impl ModelRequestContributor for Boundary {
    fn model_attempt(&self, input: codex_extension_api::ModelAttemptInput) -> Result<(), String> {
        let Some(tools) = input
            .admission
            .turn_store()
            .get::<Weak<crate::python_tools::PythonTools>>()
            .and_then(|tools| tools.upgrade())
        else {
            return Ok(());
        };
        tools
            .publish_model_attempt(input)
            .map_err(|error| error.to_string())
    }
    fn retire_model_attempt(
        &self,
        admission: Arc<dyn ModelToolAdmission>,
    ) -> futures_util::future::BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let Some(attempt) = admission.model_attempt() else {
                return Ok(());
            };
            if let Some(tools) = admission
                .turn_store()
                .get::<Weak<crate::python_tools::PythonTools>>()
                .and_then(|tools| tools.upgrade())
            {
                tools
                    .retire_model_attempt_callbacks(&attempt)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }
    fn decide_model_retry(
        &self,
        input: codex_extension_api::ModelRetryInput,
    ) -> Option<
        futures_util::future::BoxFuture<
            '_,
            Result<codex_protocol::model_retry::ModelRetryResolution, String>,
        >,
    > {
        let tools = input
            .admission
            .turn_store()
            .get::<Weak<crate::python_tools::PythonTools>>()
            .and_then(|tools| tools.upgrade())?;
        if !input.context.policy_enabled && !tools.produces_model_response() {
            return None;
        }
        Some(Box::pin(async move {
            tools
                .decide_model_retry(input)
                .await
                .map_err(|_| "Model retry callback failed".to_owned())
        }))
    }

    fn uses_chatgpt_plan(&self) -> bool {
        self.engine
            .get()
            .and_then(Weak::upgrade)
            .is_some_and(|engine| engine.plan_authorization.is_some())
    }

    fn customizes_compaction(&self, thread_id: &str) -> bool {
        self.context_tools(thread_id)
            .is_some_and(|tools| tools.customizes_compaction())
    }
    fn schedules_post_turn_compaction(
        &self,
        thread_id: &str,
        step_store: &codex_extension_api::ExtensionData,
    ) -> bool {
        self.context_tools(thread_id)
            .is_some_and(|tools| tools.schedules_post_turn_compaction(step_store))
    }
    fn post_turn_compaction<'a>(
        &'a self,
        input: codex_extension_api::CompactionInput<'a>,
    ) -> ExtensionFuture<'a, std::result::Result<Option<bool>, String>> {
        Box::pin(async move {
            self.context_tools(input.thread_id)
                .ok_or("Expired compaction policy owner")?
                .post_turn_compaction(input)
                .await
                .map_err(|_| "Compaction policy callback failed".to_owned())
        })
    }
    fn before_compact_result<'a>(
        &'a self,
        input: codex_extension_api::CompactionInput<'a>,
    ) -> ExtensionFuture<
        'a,
        std::result::Result<Option<codex_extension_api::CompactionResult>, String>,
    > {
        Box::pin(async move {
            if self.uses_chatgpt_plan() {
                return Err("Sign in with ChatGPT does not support beforeCompact callbacks".into());
            }
            self.context_tools(input.thread_id)
                .ok_or("Expired compaction callback owner")?
                .before_compact(input)
                .await
                .map_err(|_| "Compaction callback failed".to_owned())
        })
    }

    fn transforms_context(&self, thread_id: &str) -> bool {
        self.context_tools(thread_id)
            .is_some_and(|tools| tools.transforms_context())
    }
    fn transform_context<'a>(
        &'a self,
        input: codex_extension_api::ModelContextInput<'a>,
    ) -> ExtensionFuture<'a, std::result::Result<(), String>> {
        Box::pin(async move {
            self.context_tools(input.thread_id)
                .ok_or("Expired model context owner")?
                .transform_context(input)
                .await
                .map_err(|_| "Model context transformation failed".to_owned())
        })
    }

    fn admit_tools_only_call(
        &self,
        input: codex_extension_api::ToolsOnlyCallInput,
    ) -> futures_util::future::BoxFuture<'_, Result<ResponseItem, String>> {
        Box::pin(async move {
            let control = self
                .threads
                .lock()
                .expect("interception index poisoned")
                .get(input.admission.thread_id())
                .and_then(Weak::upgrade)
                .ok_or_else(|| FAILURE.to_owned())?;
            let owner = input
                .admission
                .turn_store()
                .get::<DirectTurn>()
                .ok_or_else(|| FAILURE.to_owned())?;
            let command_admission = *owner
                .command_admission
                .lock()
                .expect("command admission poisoned");
            let request = DirectRequest {
                tool_admission: Some(input.admission),
                control,
                owner,
                model: input.model,
                command_admission,
            };
            request
                .admit_tools_only(input.item, &input.cancellation)
                .await
        })
    }

    fn preserves_provider_request_window(&self, url: &str) -> bool {
        // This exact native route validates the provider/grant/one-use ticket,
        // restores tool schemas, and sends input/model/store through Reqwest.
        self.engine
            .get()
            .and_then(Weak::upgrade)
            .is_some_and(|engine| {
                engine
                    .sentinel
                    .read()
                    .expect("sentinel poisoned")
                    .as_ref()
                    .is_some_and(|(base, _, _)| {
                        url.starts_with(&format!("{}/p-", base.trim_end_matches('/')))
                    })
            })
    }

    fn http_stream(&self, url: &str) -> Option<codex_extension_api::ModelHttpStream> {
        let engine = self.engine.get()?.upgrade()?;
        let base = engine
            .sentinel
            .read()
            .expect("sentinel poisoned")
            .as_ref()?
            .0
            .clone();
        // Claim the entire private namespace, including malformed private paths.
        // Claiming never permits fallback after validation fails.
        if !url.starts_with(&format!("{}/p-", base.trim_end_matches('/'))) {
            return None;
        }
        let expected_url = url.to_owned();
        let engine = Arc::downgrade(&engine);
        Some(Arc::new(move |request, request_transport| {
            let engine = engine.clone();
            let expected_url = expected_url.clone();
            Box::pin(async move {
                let engine =
                    engine
                        .upgrade()
                        .ok_or_else(|| codex_client::TransportError::Http {
                            status: http::StatusCode::UNAUTHORIZED,
                            url: Some(expected_url.clone()),
                            headers: Some(http::HeaderMap::new()),
                            body: Some(String::new()),
                            retry_after: None,
                        })?;
                crate::direct_sentinel_stream(
                    &engine,
                    &expected_url,
                    request,
                    request_transport.as_ref(),
                )
                .await
            })
        }))
    }

    fn websocket_connect(
        &self,
        url: &str,
        thread_id: &str,
    ) -> Option<codex_api::ResponsesWebsocketConnect> {
        let engine = self.engine.get()?.upgrade()?;
        if engine.plan_authorization.is_some()
            || engine.manager.auth_manager().auth_mode()
                != Some(codex_protocol::auth::AuthMode::ApiKey)
        {
            return None;
        }
        let private_origin = {
            let binding = engine.sentinel.read().expect("sentinel poisoned");
            let (base, _, excluded) = binding.as_ref()?;
            if excluded.is_some() {
                return None;
            }
            base.strip_prefix("http://127.0.0.1:")?.trim_end_matches('/').to_owned()
        };
        if !url.starts_with(&format!("ws://127.0.0.1:{private_origin}/p-")) {
            return None;
        }
        let control = self.threads.lock().expect("interception index poisoned")
            .get(thread_id)?.upgrade()?;
        control.sentinel_provider.get()?;
        let control = Arc::downgrade(&control);
        let engine = Arc::downgrade(&engine);
        let expected_url = url.to_owned();
        Some(Arc::new(move |request| {
            let control = control.clone();
            let engine = engine.clone();
            let expected_url = expected_url.clone();
            Box::pin(async move {
                let retired = || codex_api::ApiError::Stream("Native WebSocket owner ended".into());
                let control = control.upgrade().ok_or_else(retired)?;
                let engine = engine.upgrade().ok_or_else(retired)?;
                crate::model_websocket_bridge::connect(engine, control, expected_url, request).await
            })
        }))
    }

    fn request(&self, input: ModelRequestInput<'_>) -> Option<Box<dyn ModelResponseInterceptor>> {
        let control = self
            .threads
            .lock()
            .expect("interception index poisoned")
            .get(input.thread_id)?
            .upgrade()?;
        let owner = control
            .direct_turn
            .lock()
            .expect("interception turn poisoned")
            .clone();
        if input.kind == ModelRequestKind::Generation
            && let Some(owner) = owner.as_ref()
        {
            *owner.model.lock().expect("interception model poisoned") = Some(input.model.into());
        }
        // A real model request samples prior completed steering, even without
        // sentinel or policy interception configured.
        if input.kind == ModelRequestKind::Generation
            && let Some(turn) = owner.as_ref().and_then(|owner| owner.settlement())
        {
            turn.begin_generation();
        }
        let command_admission = owner.as_ref().and_then(|turn| {
            *turn
                .command_admission
                .lock()
                .expect("command admission poisoned")
        });
        if control.sentinel_provider.get().is_some() {
            let ticket = Arc::new(SentinelTicket {
                attempts: input.attempts.clone(),
                nonce: codex_protocol::ThreadId::new().to_string(),
                kind: input.kind,
                model: input.model.to_owned(),
                model_omitted: input.model_omitted,
                admitted: AtomicBool::new(false),
                owner,
                failure: Mutex::new(None),
                command_admission,
            });
            let mut current = control
                .sentinel_request
                .lock()
                .expect("sentinel request poisoned");
            if current.request.is_some() {
                return Some(Box::new(RevokedRequest));
            }
            current.request = Some(ticket.clone());
            drop(current);
            let meta = input.client_metadata.get_or_insert_default();
            meta.insert("sdk_sentinel_thread".into(), control.id.clone());
            meta.insert("sdk_sentinel_nonce".into(), ticket.nonce.clone());
            return Some(Box::new(SentinelRequest {
                control,
                ticket,
                tool_admission: None,
            }));
        }
        if input.kind != ModelRequestKind::Generation {
            return None;
        }
        {
            let state = control
                .channel
                .state
                .lock()
                .expect("interception control poisoned");
            if !control.configured_in(&state)
                && control.profile_policies.load(Ordering::Acquire) == 0
                && control.stdin_admission.get().is_none()
                && command_admission.is_none()
                && !control.has_native_agents()
            {
                return None;
            }
            if state.revoked
                || state.mcp_poisoned
                || state.mcp_publication.is_some()
                || control.stopped.is_cancelled()
            {
                return Some(Box::new(RevokedRequest));
            }
        }
        let Some(owner) = owner else {
            return Some(Box::new(RevokedRequest));
        };
        Some(Box::new(DirectRequest {
            tool_admission: None,
            control,
            owner,
            model: input.model.to_owned(),
            command_admission,
        }))
    }
}

struct SentinelTicket {
    attempts: Option<Arc<dyn codex_extension_api::ModelRequestAttemptsObserver>>,
    nonce: String,
    kind: ModelRequestKind,
    model: String,
    model_omitted: bool,
    admitted: AtomicBool,
    owner: Option<Arc<DirectTurn>>,
    failure: Mutex<Option<SentinelFailure>>,
    command_admission: Option<CommandAdmission>,
}

pub(crate) enum SentinelFailure {
    Transport(codex_api::TransportError),
    WebSocket { oversized: bool },
}

impl SentinelFailure {
    pub(crate) fn into_response_error(self) -> ModelResponseError {
        match self {
            Self::Transport(error) => ModelResponseError::Transport(error),
            Self::WebSocket { oversized } => ModelResponseError::InvalidRequest {
                message: if oversized {
                    "Native WebSocket request exceeds the 64 MiB UTF-8 transport limit; model context limits are separate."
                } else {
                    "Native WebSocket request outcome is unknown after a send or disconnect; it will not be replayed."
                }.into(),
            },
        }
    }
}

#[derive(Default)]
struct SentinelState {
    request: Option<Arc<SentinelTicket>>,
    completion: Option<LastCompletion>,
}

struct SentinelRequest {
    tool_admission: Option<Arc<dyn ModelToolAdmission>>,
    control: Arc<Control>,
    ticket: Arc<SentinelTicket>,
}

impl Drop for SentinelRequest {
    fn drop(&mut self) {
        let mut current = self
            .control
            .sentinel_request
            .lock()
            .expect("sentinel request poisoned");
        if current
            .request
            .as_ref()
            .is_some_and(|ticket| Arc::ptr_eq(ticket, &self.ticket))
        {
            current.request = None;
        }
    }
}

impl SentinelRequest {
    fn take_failure(&self, decoded_integrity: bool) -> Option<ModelResponseError> {
        {
            let state = self
                .control
                .channel
                .state
                .lock()
                .expect("interception control poisoned");
            let turn = self
                .control
                .direct_turn
                .lock()
                .expect("interception turn poisoned");
            let current = self
                .control
                .sentinel_request
                .lock()
                .expect("sentinel request poisoned");
            self.ticket
                .failure
                .lock()
                .expect("sentinel failure poisoned")
                .take()
                .and_then(|error| {
                    if self.ticket.admitted.load(Ordering::Acquire)
                        && !state.revoked
                        && !self.control.stopped.is_cancelled()
                        && current
                            .request
                            .as_ref()
                            .is_some_and(|now| Arc::ptr_eq(now, &self.ticket))
                        && (self.ticket.kind == ModelRequestKind::Warmup
                            || self.ticket.owner.as_ref().is_some_and(|owner| {
                                !owner.cancelled.is_cancelled()
                                    && turn.as_ref().is_some_and(|now| Arc::ptr_eq(now, owner))
                            }))
                    {
                        match error {
                            // An admitted, decoded protocol error stays terminal even
                            // if the local WebSocket receiver closes before its poll.
                            SentinelFailure::WebSocket { oversized: false }
                                if decoded_integrity
                                    && self.ticket.kind == ModelRequestKind::Generation =>
                            {
                                None
                            }
                            error => Some(error.into_response_error()),
                        }
                    } else {
                        Some(rejected())
                    }
                })
        }
    }
}

impl ModelResponseInterceptor for SentinelRequest {
    fn preserves_provider_message_window(&self) -> bool {
        // Admission may edit tool calls, but passes messages, reasoning and
        // the physical response ID unchanged. Core excludes tool output here.
        true
    }

    fn intercept_with_tool_admission(
        mut self: Box<Self>,
        stream: ModelResponseStream,
        admission: Option<Arc<dyn ModelToolAdmission>>,
    ) -> ModelResponseStream {
        self.tool_admission = admission;
        self.intercept(stream)
    }

    fn intercept(self: Box<Self>, upstream: ModelResponseStream) -> ModelResponseStream {
        if let Some(error) = self.take_failure(false) {
            drop(upstream);
            return Box::pin(futures_util::stream::once(async move {
                let _guard = self;
                Err(error)
            }));
        }
        let stream = match &self.ticket.owner {
            Some(owner) if self.ticket.kind == ModelRequestKind::Generation => {
                Box::new(DirectRequest {
                    tool_admission: self.tool_admission.clone(),
                    control: self.control.clone(),
                    owner: owner.clone(),
                    model: self.ticket.model.clone(),
                    command_admission: self.ticket.command_admission,
                })
                .intercept(upstream)
            }
            _ => upstream,
        };
        Box::pin(futures_util::stream::unfold(
            Some((self, stream, Some(Vec::new()))),
            |state| async {
                let (guard, mut stream, mut output) = state?;
                let next = stream.next().await;
                // A WebSocket opens its response stream before it receives
                // the provider's terminal. The issued ticket may fail while
                // this poll is pending; apply that decision before Core retries.
                let decoded_integrity = matches!(
                    &next,
                    Some(Err(ModelResponseError::ResponseIntegrity { .. }))
                );
                let next = match guard.take_failure(decoded_integrity) {
                    Some(error) => Err(error),
                    None => next?,
                };
                match &next {
                    Ok(ResponseEvent::OutputItemDone(item)) => {
                        if guard.ticket.kind == ModelRequestKind::Generation
                            && let Some(output) = &mut output
                        {
                            output.push(item.clone());
                        }
                    }
                    Ok(ResponseEvent::Completed { .. })
                        if guard.ticket.kind == ModelRequestKind::Warmup =>
                    {
                        // Core can start generation as soon as it reads this event.
                        drop(stream);
                        drop(guard);
                        return Some((next, None));
                    }
                    Ok(ResponseEvent::Completed { response_id, .. }) => {
                        let state = guard
                            .control
                            .channel
                            .state
                            .lock()
                            .expect("interception control poisoned");
                        let current = guard
                            .control
                            .direct_turn
                            .lock()
                            .expect("interception turn poisoned");
                        let mut request = guard
                            .control
                            .sentinel_request
                            .lock()
                            .expect("sentinel request poisoned");
                        if let (Some(owner), Some(items)) = (&guard.ticket.owner, output.take())
                            && guard.ticket.kind == ModelRequestKind::Generation
                            && guard.ticket.admitted.load(Ordering::Acquire)
                            && !state.revoked
                            && !guard.control.stopped.is_cancelled()
                            && !owner.cancelled.is_cancelled()
                            && current.as_ref().is_some_and(|now| Arc::ptr_eq(now, owner))
                            && request
                                .request
                                .as_ref()
                                .is_some_and(|now| Arc::ptr_eq(now, &guard.ticket))
                        {
                            request.completion = Some(LastCompletion {
                                response_id: response_id.clone(),
                                model: guard.ticket.model.clone(),
                                output: items,
                            });
                        }
                    }
                    Err(_) => output = None,
                    _ => {}
                }
                Some((next, Some((guard, stream, output))))
            },
        ))
    }
}

fn sentinel_control(engine: &crate::engine::EngineState, id: &str) -> Result<Arc<Control>> {
    engine
        .interception
        .threads
        .lock()
        .expect("interception index poisoned")
        .get(id)
        .and_then(Weak::upgrade)
        .context("Missing native control")
}

pub(crate) async fn sentinel_admit(
    engine: &crate::engine::EngineState,
    provider_id: &str,
    meta: &Value,
) -> anyhow::Result<String> {
    use anyhow::{Context, ensure};
    let id = meta["sdk_sentinel_thread"]
        .as_str()
        .context("Missing sentinel owner")?;
    let nonce = meta["sdk_sentinel_nonce"]
        .as_str()
        .context("Missing sentinel ticket")?;
    let control = sentinel_control(engine, id)?;
    let ticket = control
        .sentinel_request
        .lock()
        .expect("sentinel request poisoned")
        .request
        .clone()
        .context("No live sentinel request")?;
    let (selected, content_item_kinds) = control
        .sentinel_provider
        .get()
        .context("No routed provider")?;
    ensure!(
        ticket.nonce == nonce && selected == provider_id,
        "Invalid sentinel owner"
    );
    if ticket.kind == ModelRequestKind::Generation {
        let owner = ticket
            .owner
            .as_ref()
            .context("Missing native generation owner")?;
        if control.review_delegate.get() != Some(&true) {
            // Managed threads retain Core's immediate task-cancellation check.
            let thread = engine
                .manager
                .get_thread(codex_protocol::ThreadId::from_string(id)?)
                .await?;
            let native_control = thread
                .thread_extension_data()
                .get::<Control>()
                .context("Native thread ended")?;
            let native = thread
                .current_turn_extension_data::<DirectTurn>(&owner.id)
                .await
                .context("Native turn ended")?;
            ensure!(
                Arc::ptr_eq(&native_control, &control) && Arc::ptr_eq(&native, owner),
                "Native sentinel generation ended"
            );
        }
        // Direct Review Sessions still require their original native turn and
        // request ticket. No parent, current-root or failed-lookup fallback.
        let current = control
            .direct_turn
            .lock()
            .expect("interception turn poisoned")
            .clone();
        ensure!(
            current
                .as_ref()
                .is_some_and(|turn| Arc::ptr_eq(turn, owner))
                && !owner.cancelled.is_cancelled(),
            "Native sentinel generation ended"
        );
    }
    let state = control
        .channel
        .state
        .lock()
        .expect("interception control poisoned");
    let turn = control
        .direct_turn
        .lock()
        .expect("interception turn poisoned");
    let mut current = control
        .sentinel_request
        .lock()
        .expect("sentinel request poisoned");
    ensure!(
        !control.stopped.is_cancelled()
            && !state.revoked
            && current
                .request
                .as_ref()
                .is_some_and(|now| Arc::ptr_eq(now, &ticket))
            && (ticket.kind == ModelRequestKind::Warmup
                || ticket
                    .owner
                    .as_ref()
                    .is_some_and(|owner| !owner.cancelled.is_cancelled()
                        && turn.as_ref().is_some_and(|now| Arc::ptr_eq(now, owner)))),
        "Sentinel request retired"
    );
    ticket.admitted.store(true, Ordering::Release);
    let completion = if ticket.kind == ModelRequestKind::Generation {
        current.completion.take()
    } else {
        None
    };
    drop(current);
    drop(turn);
    drop(state);
    let completion = completion
        .map(|completion| -> anyhow::Result<Value> {
            let projected = crate::model_websocket::project_items(
                &serde_json::to_string(&completion.output)?,
                *content_item_kinds,
            )
            .map_err(|_| anyhow::anyhow!("Invalid completed native output"))?;
            Ok(json!({
                "response_id": completion.response_id, "model": completion.model,
                "output": serde_json::from_str::<Value>(&projected)?,
            }))
        })
        .transpose()?;
    let mut receipt = json!({
        "control": control.incarnation,
        "kind": if ticket.kind == ModelRequestKind::Warmup { "warmup" } else { "generation" },
        "model": ticket.model,
        "model_omitted": ticket.model_omitted,
        "content_item_kinds": content_item_kinds,
        "completion": completion,
    });
    if ticket.attempts.is_some() {
        receipt["request_attempts"] = Value::Bool(true);
    }
    Ok(serde_json::to_string(&receipt)?)
}

pub(crate) async fn sentinel_restore_schemas(
    engine: &crate::engine::EngineState,
    provider_id: &str,
    meta: &Value,
    body: &mut Value,
) -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    let id = meta["sdk_sentinel_thread"]
        .as_str()
        .context("Missing sentinel owner")?;
    let nonce = meta["sdk_sentinel_nonce"]
        .as_str()
        .context("Missing sentinel ticket")?;
    let control = sentinel_control(engine, id)?;
    let review_delegate = control.review_delegate.get() == Some(&true);
    let tools = if review_delegate {
        // Core creates review delegates with no dynamic tools. They do not
        // inherit a parent's SDK schema catalog merely by sharing a provider.
        None
    } else {
        let thread = engine
            .manager
            .get_thread(codex_protocol::ThreadId::from_string(id)?)
            .await?;
        let current = thread
            .thread_extension_data()
            .get::<Control>()
            .context("Native thread ended")?;
        ensure!(Arc::ptr_eq(&current, &control), "Native thread ended");
        thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
    };
    let review_turn = review_delegate
        .then(|| {
            control
                .direct_turn
                .lock()
                .expect("interception turn poisoned")
                .clone()
        })
        .flatten();
    let request = control
        .sentinel_request
        .lock()
        .expect("sentinel request poisoned");
    let ticket = request
        .request
        .as_ref()
        .context("No live sentinel request")?;
    ensure!(
        !control.stopped.is_cancelled()
            && ticket.nonce == nonce
            && ticket.admitted.load(Ordering::Acquire)
            && control
                .sentinel_provider
                .get()
                .is_some_and(|(id, _)| id == provider_id)
            && ticket
                .owner
                .as_ref()
                .is_none_or(|owner| !owner.cancelled.is_cancelled()),
        "Sentinel request retired"
    );
    if review_delegate && ticket.kind == ModelRequestKind::Generation {
        ensure!(
            ticket.owner.as_ref().is_some_and(|owner| review_turn
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, owner))),
            "Native review generation ended"
        );
    }
    if let Some(tools) = tools {
        tools.restore_schema_request(body)?;
    }
    Ok(())
}

pub(crate) fn sentinel_http_turn(
    engine: &crate::engine::EngineState,
    provider_id: &str,
    meta: &Value,
) -> Result<(
    Option<Arc<crate::turn_settlement::Turn>>,
    Option<Arc<dyn codex_extension_api::ModelRequestAttemptsObserver>>,
)> {
    let id = meta["sdk_sentinel_thread"]
        .as_str()
        .context("Missing sentinel owner")?;
    let nonce = meta["sdk_sentinel_nonce"]
        .as_str()
        .context("Missing sentinel ticket")?;
    let control = sentinel_control(engine, id)?;
    let current = control
        .sentinel_request
        .lock()
        .expect("sentinel request poisoned");
    let ticket = current
        .request
        .as_ref()
        .context("No live sentinel request")?;
    ensure!(
        ticket.nonce == nonce
            && ticket.admitted.load(Ordering::Acquire)
            && control
                .sentinel_provider
                .get()
                .is_some_and(|(selected, _)| selected == provider_id),
        "Sentinel request retired"
    );
    let settlement = ticket
        .owner
        .as_ref()
        .and_then(|owner| owner.settlement.as_ref());
    let turn = settlement
        .map(|turn| turn.upgrade().context("Native sentinel turn ended"))
        .transpose()?;
    Ok((turn, ticket.attempts.clone()))
}

// Only the originally admitted native request may retain its settled error.
// Auth and HTTP outcomes continue through Core; no wire response can create
// this receipt. Retirement/drop removes the ticket and its pending failure.
pub(crate) fn sentinel_failed(
    engine: &crate::engine::EngineState,
    provider_id: &str,
    meta: &Value,
    error: SentinelFailure,
) -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    let id = meta["sdk_sentinel_thread"]
        .as_str()
        .context("Missing sentinel owner")?;
    let nonce = meta["sdk_sentinel_nonce"]
        .as_str()
        .context("Missing sentinel ticket")?;
    let control = sentinel_control(engine, id)?;
    let (selected, _) = control
        .sentinel_provider
        .get()
        .context("No routed provider")?;
    let state = control
        .channel
        .state
        .lock()
        .expect("interception control poisoned");
    let turn = control
        .direct_turn
        .lock()
        .expect("interception turn poisoned");
    let current = control
        .sentinel_request
        .lock()
        .expect("sentinel request poisoned");
    let ticket = current
        .request
        .as_ref()
        .context("No live sentinel request")?;
    ensure!(
        selected == provider_id
            && ticket.nonce == nonce
            && ticket.admitted.load(Ordering::Acquire)
            && !control.stopped.is_cancelled()
            && !state.revoked
            && (ticket.kind == ModelRequestKind::Warmup
                || ticket
                    .owner
                    .as_ref()
                    .is_some_and(|owner| !owner.cancelled.is_cancelled()
                        && turn.as_ref().is_some_and(|now| Arc::ptr_eq(now, owner)))),
        "Sentinel request retired"
    );
    let mut failure = ticket.failure.lock().expect("sentinel failure poisoned");
    ensure!(failure.is_none(), "Sentinel failure already settled");
    *failure = Some(error);
    Ok(())
}

// Revocation is permanent for a configured owner. A later generation must
// not reinterpret a failed reader as an unconfigured tool policy.
struct RevokedRequest;

impl ModelResponseInterceptor for RevokedRequest {
    fn intercept(self: Box<Self>, upstream: ModelResponseStream) -> ModelResponseStream {
        drop(upstream);
        Box::pin(futures_util::stream::once(async { Err(rejected()) }))
    }
}

struct DirectRequest {
    tool_admission: Option<Arc<dyn ModelToolAdmission>>,
    control: Arc<Control>,
    owner: Arc<DirectTurn>,
    model: String,
    command_admission: Option<CommandAdmission>,
}

fn rejected() -> ModelResponseError {
    // Nonretryable, no callback/model payload reflected in errors. Core's
    // mapper can continue polling after Err, so only OUR denial ends the stream.
    ModelResponseError::InvalidRequest {
        message: FAILURE.into(),
    }
}

impl DirectRequest {
    async fn admit_tools_only(
        &self,
        item: ResponseItem,
        cancellation: &CancellationToken,
    ) -> Result<ResponseItem, String> {
        if cancellation.is_cancelled() || self.owner.cancelled.is_cancelled() {
            return Err(FAILURE.to_owned());
        }
        let mut release = None;
        let result = {
            let before = self.before_scoped(item, None, cancellation, Some(&mut release));
            tokio::pin!(before);
            tokio::select! {biased;
                _=cancellation.cancelled()=>Err(rejected()),
                _=self.owner.cancelled.cancelled()=>Err(rejected()),
                result=&mut before=>result,
            }
        };
        // Fencing the nonce only prevents publication. The charged notice owns
        // the callback until release(), including cancellation and timeout.
        if let Some(released) = release {
            let _ = released.await;
        }
        let (item, _) = result.map_err(|_| FAILURE.to_owned())?;
        if self.owner.cancelled.is_cancelled() {
            return Err(FAILURE.to_owned());
        }
        self.control
            .publish_result(&self.owner, cancellation, false, None, || item)
    }

    #[cfg(test)]
    async fn before(&self, item: ResponseItem) -> Result<ResponseItem, ModelResponseError> {
        self.before_edited(item, None).await.map(|(item, _)| item)
    }

    async fn before_edited(
        &self,
        item: ResponseItem,
        previous: Option<OwnedSemaphorePermit>,
    ) -> Result<(ResponseItem, bool), ModelResponseError> {
        self.before_scoped(item, previous, &self.owner.cancelled, None)
            .await
    }

    async fn before_scoped(
        &self,
        mut item: ResponseItem,
        previous: Option<OwnedSemaphorePermit>,
        cancellation: &CancellationToken,
        physical_release: Option<&mut Option<NoticeRelease>>,
    ) -> Result<(ResponseItem, bool), ModelResponseError> {
        if self.control.code_import_poisoned() {
            return Err(rejected());
        }
        let admitted = if matches!(
            &item,
            ResponseItem::FunctionCall { .. }
                | ResponseItem::CustomToolCall { .. }
                | ResponseItem::ToolSearchCall { .. }
        ) {
            // Core binds the actual issuing router for HTTP, WebSocket and
            // compaction. Advertised specs and a later turn confer no authority.
            let admission = self.tool_admission.as_ref().ok_or_else(rejected)?;
            if admission.thread_id() != self.control.id
                || !admission
                    .turn_store()
                    .get::<DirectTurn>()
                    .is_some_and(|owner| Arc::ptr_eq(&owner, &self.owner))
            {
                return Err(rejected());
            }
            admission.admits(&item)
        } else {
            true
        };
        if let Some(policy) = self.control.native_agents.get()
            && matches!(
                &item,
                ResponseItem::FunctionCall { .. }
                    | ResponseItem::CustomToolCall { .. }
                    | ResponseItem::ToolSearchCall { .. }
            )
            && (!policy.admits(self.control.native_depth, &item)
                || self.control.stopped.is_cancelled()
                || self.owner.cancelled.is_cancelled())
        {
            return Err(rejected());
        }
        if !admitted {
            // Preserve NativeAgents terminal denial before allowing Core's
            // ordinary unsupported result. No application callback is entered.
            return Ok((item, false));
        }
        let (call_id, name, kind, input) = match &item {
            ResponseItem::FunctionCall {
                call_id,
                name,
                namespace,
                arguments,
                ..
            } => (
                call_id,
                Name {
                    namespace: namespace.as_deref(),
                    name,
                },
                "function_json",
                Input::Text(arguments),
            ),
            ResponseItem::CustomToolCall {
                call_id,
                name,
                namespace,
                input,
                ..
            } => (
                call_id,
                Name {
                    namespace: namespace.as_deref(),
                    name,
                },
                "freeform",
                Input::Text(input),
            ),
            ResponseItem::ToolSearchCall {
                call_id: Some(call_id),
                execution,
                arguments,
                ..
            } if execution == "client" && SearchToolCallParams::deserialize(arguments).is_ok() => (
                call_id,
                Name {
                    namespace: None,
                    name: "tool_search",
                },
                "tool_search",
                Input::Json(arguments),
            ),
            // Matches only actual router input shapes. Server search, hosted
            // web/image, missing ids and malformed search are not client calls.
            _ => return Ok((item, false)),
        };
        // Model output can arrive on another task. Keep the turn that issued
        // the request, including an expired or untraced owner's empty context.
        let tracing = match &self.owner.settlement {
            Some(receipt) => receipt
                .upgrade()
                .and_then(|turn| turn.tracing.as_ref().map(|lease| Arc::new(lease.retain()))),
            None => self.control.tracing_context().context,
        };
        let request = Request {
            tracing_context: tracing.as_ref().map(|context| context.token()),
            phase: "before",
            route: "direct",
            boundary: "pre_dispatch",
            turn_id: &self.owner.id,
            model: Some(&self.model),
            call_id: Some(call_id),
            outer_call_id: None,
            cell_id: None,
            runtime_tool_call_id: None,
            tool_name: name,
            tool_kind: kind,
            input,
            result: (),
        };
        let source = capture_mcp_source(
            self.tool_admission
                .as_ref()
                .and_then(|admission| admission.step_store()),
        )
        .map_err(|_| rejected())?;
        let decision = self
            .control
            .decide_released(
                ProfiledRequest {
                    source,
                    request: OwnedRequest {
                        request,
                        owner: &self.owner,
                        retained: false,
                        cell_owner_id: None,
                    },
                },
                cancellation,
                previous,
                None,
                physical_release,
            )
            .await
            .map_err(|_| rejected())?;
        if cancellation.is_cancelled() || self.owner.cancelled.is_cancelled() {
            return Err(rejected());
        }
        let mut changed = false;
        if let Decision::Replace { value } = decision {
            changed = match &mut item {
                ResponseItem::FunctionCall {
                    arguments,
                    encrypted_function_args,
                    namespace,
                    name,
                    ..
                } if value.is_object() => {
                    // Core's router additionally treats collaboration messages as
                    // encrypted unless the provider explicitly marked ALL args
                    // plaintext (Some([])). None is not equivalent to Some([]).
                    let encrypted_message = namespace.as_deref() == Some("collaboration")
                        && matches!(
                            name.as_str(),
                            "spawn_agent" | "send_message" | "followup_task"
                        )
                        && !encrypted_function_args.as_ref().is_some_and(Vec::is_empty);
                    let fields = encrypted_function_args.as_deref().unwrap_or_default();
                    if encrypted_message || !fields.is_empty() {
                        let original: Value =
                            serde_json::from_str(arguments).map_err(|_| rejected())?;
                        if !original.is_object()
                            || fields
                                .iter()
                                .map(String::as_str)
                                .chain(encrypted_message.then_some("message"))
                                .any(|field| original.get(field) != value.get(field))
                        {
                            return Err(rejected());
                        }
                    }
                    let changed =
                        serde_json::from_str::<Value>(arguments).ok().as_ref() != Some(&value);
                    if changed {
                        *arguments = value.to_string();
                    }
                    changed
                }
                ResponseItem::CustomToolCall { input, .. } => {
                    let replacement = value.as_str().ok_or_else(rejected)?;
                    let changed = input != replacement;
                    if changed {
                        *input = replacement.to_owned();
                    }
                    changed
                }
                ResponseItem::ToolSearchCall { arguments, .. } => {
                    serde_json::from_value::<SearchToolCallParams>(value.clone())
                        .map_err(|_| rejected())?;
                    let changed = *arguments != value;
                    if changed {
                        *arguments = value;
                    }
                    changed
                }
                _ => return Err(rejected()),
            };
            // Changed contents are local history, never the old provider item.
            if changed {
                item.set_id(None);
            }
        }
        if self
            .tool_admission
            .as_ref()
            .is_some_and(|admission| !admission.admits(&item))
        {
            return Err(rejected());
        }
        self.admit_executor(&item)?;
        if let Some(policy) = self.control.native_agents.get()
            && !policy.admits(self.control.native_depth, &item)
        {
            return Err(rejected());
        }
        Ok((item, changed))
    }

    fn admit_executor(&self, item: &ResponseItem) -> Result<(), ModelResponseError> {
        let ResponseItem::FunctionCall {
            name,
            namespace,
            arguments,
            call_id,
            ..
        } = item
        else {
            return Ok(());
        };
        if !ToolName::new(namespace.clone(), name.clone()).is_default_namespace() {
            return Ok(());
        }
        let valid = match name.as_str() {
            "write_stdin" if self.control.stdin_admission.get().is_some() => {
                valid_stdin_arguments(arguments)
            }
            "exec_command" => self
                .command_admission
                .is_none_or(|schema| schema.valid(arguments)),
            _ => true,
        };
        if valid {
            return Ok(());
        }
        Err(ModelResponseError::InvalidRequest {
            message: format!(
                "Native executor rejected invalid arguments before dispatch: tool={name}; call_id_sha256={:x}",
                Sha256::digest(call_id.as_bytes()),
            ),
        })
    }
}

// Pinned interactive exec schema for the one eager ready remote selection.
// Preserve schema numbers and original bytes; Core owns integer/range semantics.
impl CommandAdmission {
    fn valid(self, arguments: &str) -> bool {
        let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(arguments) else {
            return false;
        };
        fields.get("cmd").is_some_and(Value::is_string)
            && fields.iter().all(|(key, value)| match key.as_str() {
                "cmd" | "workdir" | "shell" | "justification" => value.is_string(),
                "login" => self.login && value.is_boolean(),
                "tty" => self.tty && value.is_boolean(),
                "yield_time_ms" | "max_output_tokens" => value.is_number(),
                "sandbox_permissions" => {
                    matches!(value.as_str(), Some("use_default" | "require_escalated"))
                }
                "prefix_rule" => value
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string)),
                _ => false,
            })
    }
}

// The pinned Core write_stdin schema is invariant across model/config choices.
// Validate its JSON schema, leaving integer ranges and execution semantics to Core.
// Do not deserialize into Core's argument struct: it ignores unknown fields.
fn valid_stdin_arguments(arguments: &str) -> bool {
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(arguments) else {
        return false;
    };
    fields.get("session_id").is_some_and(Value::is_number)
        && fields.iter().all(|(key, value)| match key.as_str() {
            "session_id" | "yield_time_ms" | "max_output_tokens" => value.is_number(),
            "chars" => value.is_string(),
            _ => false,
        })
}

impl ModelResponseInterceptor for DirectRequest {
    fn preserves_provider_message_window(&self) -> bool {
        // Admission may edit tool calls, but passes messages, reasoning and
        // the physical response ID unchanged. Core excludes tool output here.
        true
    }

    fn intercept_with_tool_admission(
        mut self: Box<Self>,
        stream: ModelResponseStream,
        admission: Option<Arc<dyn ModelToolAdmission>>,
    ) -> ModelResponseStream {
        self.tool_admission = admission;
        self.intercept(stream)
    }

    fn intercept(self: Box<Self>, stream: ModelResponseStream) -> ModelResponseStream {
        Box::pin(stream::unfold(
            (
                stream,
                self,
                false,
                false,
                VecDeque::<(ResponseItem, bool, OwnedSemaphorePermit)>::new(),
            ),
            |(mut upstream, request, failed, mut active, mut pending)| async move {
                if failed {
                    return None;
                }
                loop {
                    if !active && let Some((item, decided, permit)) = pending.pop_front() {
                        let result = if decided {
                            let admitted = {
                                let state = request
                                    .control
                                    .channel
                                    .state
                                    .lock()
                                    .expect("interception control poisoned");
                                !state.revoked
                                    && !state.mcp_poisoned
                                    && state.mcp_publication.is_none()
                                    && !request.control.stopped.is_cancelled()
                                    && !request.owner.cancelled.is_cancelled()
                            };
                            drop(permit);
                            if admitted {
                                Ok(ResponseEvent::OutputItemDone(item))
                            } else {
                                Err(rejected())
                            }
                        } else {
                            request
                                .before_edited(item, Some(permit))
                                .await
                                .map(|(item, _)| ResponseEvent::OutputItemDone(item))
                        };
                        let failed = result.is_err();
                        if failed {
                            pending.clear();
                        }
                        return Some((result, (upstream, request, failed, active, pending)));
                    }
                    // Never wait for the peer after a queued call's owner ended.
                    let next = if pending.is_empty() {
                        upstream.next().await
                    } else {
                        let stopped = request.control.stopped.clone();
                        let cancelled = request.owner.cancelled.clone();
                        let polled = tokio::select! {
                            biased;
                            _ = stopped.cancelled() => None,
                            _ = cancelled.cancelled() => None,
                            next = upstream.next() => Some(next),
                        };
                        match polled {
                            Some(next) => next,
                            None => {
                                pending.clear();
                                return Some((
                                    Err(rejected()),
                                    (upstream, request, true, active, pending),
                                ));
                            }
                        }
                    };
                    let Some(next) = next else {
                        if pending.is_empty() {
                            return None;
                        }
                        pending.clear();
                        return Some((Err(rejected()), (upstream, request, true, active, pending)));
                    };
                    let (event, failed) = match next {
                        Ok(ResponseEvent::OutputItemAdded(item)) => {
                            if matches!(
                                &item,
                                ResponseItem::Message { .. }
                                    | ResponseItem::Reasoning { .. }
                                    | ResponseItem::WebSearchCall { .. }
                            ) {
                                active = true;
                            }
                            (Ok(ResponseEvent::OutputItemAdded(item)), false)
                        }
                        Ok(ResponseEvent::OutputItemDone(item)) => {
                            let following = !pending.is_empty()
                                && matches!(
                                    &item,
                                    ResponseItem::FunctionCall { .. }
                                        | ResponseItem::CustomToolCall { .. }
                                        | ResponseItem::ToolSearchCall { .. }
                                        | ResponseItem::LocalShellCall { .. }
                                );
                            let result = if following {
                                Ok((item, false))
                            } else {
                                request.before_edited(item, None).await
                            };
                            match result {
                                Ok((item, changed)) if following || (changed && active) => {
                                    // No semaphore await: a queue which cannot fit fails now,
                                    // never waits for the active Done needed to release it.
                                    if pending.len() >= MAX_PENDING {
                                        (Err(rejected()), true)
                                    } else {
                                        match request.control.account(&item, None) {
                                            Ok(permit) => {
                                                pending.push_back((item, !following, permit));
                                                continue;
                                            }
                                            Err(_) => (Err(rejected()), true),
                                        }
                                    }
                                }
                                Ok((item, _)) => {
                                    if matches!(
                                        &item,
                                        ResponseItem::Message { .. }
                                            | ResponseItem::Reasoning { .. }
                                            | ResponseItem::WebSearchCall { .. }
                                    ) {
                                        active = false;
                                    }
                                    (Ok(ResponseEvent::OutputItemDone(item)), false)
                                }
                                Err(error) => (Err(error), true),
                            }
                        }
                        Ok(ResponseEvent::Completed { .. }) if !pending.is_empty() => {
                            (Err(rejected()), true)
                        }
                        Err(error) => (Err(error), !pending.is_empty()),
                        other => (other, false),
                    };
                    if failed {
                        pending.clear();
                    }
                    return Some((event, (upstream, request, failed, active, pending)));
                }
            },
        ))
    }
}

impl ToolLifecycleContributor for Boundary {
    fn controls_builtin_result(&self, thread: &ExtensionData, name: &ToolName) -> bool {
        thread
            .get::<Control>()
            .is_some_and(|control| control.controls_builtin_result(name))
    }

    fn on_builtin_tool_result<'a>(
        &'a self,
        input: BuiltinToolResultInput<'a>,
    ) -> ExtensionFuture<'a, Result<Value, ()>> {
        Box::pin(async move {
            let control = input.thread_store.get::<Control>().ok_or(())?;
            let owner = input.turn_store.get::<DirectTurn>().ok_or(())?;
            if owner.id != input.turn_id || !control.controls_builtin_result(input.tool_name) {
                return Err(());
            }
            let (route, cell_id, runtime_id) = match &input.source {
                ToolCallSource::CodeMode {
                    cell_id,
                    runtime_tool_call_id,
                } => (
                    "code_mode",
                    Some(CellId::new(cell_id.clone())),
                    Some(runtime_tool_call_id.as_str()),
                ),
                _ => ("direct", None, None),
            };
            let (kind, arguments) = match input.payload {
                ToolPayload::Function { arguments } => ("function_json", arguments.as_str()),
                ToolPayload::Custom { input } => ("freeform", input.as_str()),
                _ => return Err(()),
            };
            if route == "code_mode" && input.outer_call_id.is_none() {
                return Err(());
            }
            let retained = control.root && route == "code_mode";
            let tracing = control.tracing_context().context;
            let request = Request {
                tracing_context: tracing.as_ref().map(|context| context.token()),
                phase: "after",
                route,
                boundary: "executor_return",
                turn_id: &owner.id,
                model: Some(input.model),
                call_id: (route == "direct").then_some(input.call_id),
                outer_call_id: input.outer_call_id,
                cell_id: cell_id.as_ref(),
                runtime_tool_call_id: runtime_id,
                tool_name: Name {
                    namespace: input.tool_name.namespace.as_deref(),
                    name: &input.tool_name.name,
                },
                tool_kind: kind,
                input: arguments,
                result: input.result,
            };
            // Core's owned probe revokes authority before the cancellation
            // future is repolled. Normal terminal still permits retained work.
            let token = CancellationToken::new();
            let decision = tokio::select! {
                biased;
                _ = input.cancelled => return Err(()),
                result = control.decide_retained(OwnedRequest { request, owner: &owner,
                    retained, cell_owner_id: None }, &token, None,
                    Some(input.is_cancelled.clone())) => result.map_err(|_| ())?,
            };
            let Decision::Replace { value } = decision else {
                return Err(());
            };
            control
                .publish_result(&owner, &token, retained, Some(&input.is_cancelled), || {
                    value
                })
                .map_err(|_| ())
        })
    }

    fn on_tool_start<'a>(&'a self, input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            // Finalized by Core after pre-tool hooks, on the native dispatch
            // task. A V1 fork_context or MCP tool never opts into this scope.
            if input.mcp_tool.is_none()
                && input.tool_name.name == "spawn_agent"
                && let ToolPayload::Function { arguments } = input.payload
                && let Ok(value) = serde_json::from_str::<Value>(arguments)
                && value["fork_context"].is_null()
                && value["fork_turns"]
                    .as_str()
                    .and_then(|mode| mode.trim().parse::<usize>().ok())
                    .is_some_and(|n| n > 0)
                && let Some(control) = input.thread_store.get::<Control>()
                && control
                    .collaboration_namespace
                    .get()
                    .is_some_and(|namespace| {
                        namespace.as_deref() == input.tool_name.namespace.as_deref()
                    })
                && let Some(turn) = input.turn_store.get::<DirectTurn>()
                && let Some(task) = tokio::task::try_id()
            {
                self.numeric_forks
                    .lock()
                    .expect("numeric forks poisoned")
                    .insert(
                        task,
                        NumericFork {
                            control: Arc::downgrade(&control),
                            turn: Arc::downgrade(&turn),
                            call_id: input.call_id.to_owned(),
                        },
                    );
            }
            if input.source == ToolCallSource::Direct
                && input.mcp_tool.is_some()
                && input
                    .thread_store
                    .get::<Control>()
                    .is_some_and(|control| control.configured())
                && let Some(owner) = input.turn_store.get::<DirectTurn>()
                && let Some(dispatch) = tokio::task::try_id()
            {
                owner
                    .mcp_calls
                    .lock()
                    .expect("MCP dispatch sources poisoned")
                    .insert(dispatch);
            }
            if input.source == ToolCallSource::Direct
                && input.tool_name.is_default_namespace()
                && matches!(
                    input.tool_name.name.as_str(),
                    codex_code_mode::PUBLIC_TOOL_NAME | codex_code_mode::WAIT_TOOL_NAME
                )
            {
                if let Some(control) = input.thread_store.get::<Control>() {
                    let name = if input.tool_name.name == codex_code_mode::PUBLIC_TOOL_NAME {
                        codex_code_mode::PUBLIC_TOOL_NAME
                    } else {
                        codex_code_mode::WAIT_TOOL_NAME
                    };
                    self.start_exec_source(
                        control,
                        input.turn_id,
                        input.call_id,
                        name,
                        input.step_store,
                    );
                    if name == codex_code_mode::PUBLIC_TOOL_NAME {
                        let origin = input
                            .thread_store
                            .get::<crate::canonical_rules::Rules>()
                            .and_then(|rules| rules.cell_image_origin(input.turn_id));
                        if let Some(start) = self
                            .starts
                            .lock()
                            .expect("interception boundary poisoned")
                            .get_mut(&tokio::task::id())
                        {
                            start.rules = origin;
                        }
                    }
                }
            }
        })
    }
    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if let Some(turn) = input.turn_store.get::<crate::turn_settlement::Turn>()
                && input
                    .thread_store
                    .get::<crate::turn_settlement::Settlement>()
                    .is_some_and(|settlement| settlement.is_current(&turn))
            {
                // A finished model-selected tool proves initial input was
                // consumed, including native mail with no UserMessage item.
                turn.record_input();
            }
            if let Some(control) = input.thread_store.get::<Control>() {
                self.finish_numeric_forks(&control, Some(input.turn_id), Some(input.call_id));
            }
            if input.source == ToolCallSource::Direct
                && let Some(owner) = input.turn_store.get::<DirectTurn>()
                && let Some(dispatch) = tokio::task::try_id()
            {
                owner
                    .mcp_calls
                    .lock()
                    .expect("MCP dispatch sources poisoned")
                    .remove(&dispatch);
            }
            if input.source == ToolCallSource::Direct
                && input.tool_name.is_default_namespace()
                && matches!(
                    input.tool_name.name.as_str(),
                    codex_code_mode::PUBLIC_TOOL_NAME | codex_code_mode::WAIT_TOOL_NAME
                )
            {
                self.finish_exec(input.thread_store.level_id(), input.turn_id, input.call_id);
            }
        })
    }

    fn on_mcp_tool_result<'a>(&'a self, input: McpToolResultInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            let Some(owner) = input.turn_store.get::<DirectTurn>() else {
                return;
            };
            let Some(dispatch) = tokio::task::try_id() else {
                return;
            };
            if !owner
                .mcp_calls
                .lock()
                .expect("MCP dispatch sources poisoned")
                .remove(&dispatch)
            {
                return;
            }
            // Preserve the dedicated editor's existing ownership and failure
            // semantics when callers have already selected it for this thread.
            if input
                .thread_store
                .get::<crate::mcp_result_control::McpResultControl>()
                .is_some_and(|control| {
                    let tool = input.mcp_tool.tool_info();
                    control.owns_result(
                        input.thread_store,
                        input.step_store,
                        &tool.server_name,
                        &tool.tool.name,
                        matches!(
                            input.mcp_tool.source(),
                            codex_extension_api::McpToolSource::Config
                        ),
                    )
                })
            {
                return;
            }
            let Some(control) = input.thread_store.get::<Control>() else {
                return;
            };
            let original = std::mem::replace(input.result, crate::mcp_result_control::withheld());
            let tool = input.mcp_tool.tool_info();
            let tracing = codex_otel::sdk_trace::ContextLease::capture();
            let request = Request {
                tracing_context: tracing.as_ref().map(|context| context.token()),
                phase: "after",
                route: "mcp",
                boundary: "executor_return",
                turn_id: input.turn_id,
                model: None,
                call_id: Some(input.call_id),
                outer_call_id: None,
                cell_id: None,
                runtime_tool_call_id: None,
                tool_name: Name {
                    namespace: Some(&tool.callable_namespace),
                    name: &tool.callable_name,
                },
                tool_kind: "function_json",
                input: Input::JsonText(input.arguments),
                result: &original,
            };
            let source = match capture_mcp_source(input.step_store) {
                Ok(source) => source,
                Err(_) => return,
            };
            let edited = match control
                .decide(ProfiledRequest { request, source }, &owner.cancelled)
                .await
            {
                Ok(Decision::Continue) => Some(original),
                Ok(Decision::Replace { value }) => {
                    crate::mcp_result_control::validated(&value.to_string())
                }
                _ => None,
            };
            let state = control
                .channel
                .state
                .lock()
                .expect("interception control poisoned");
            if !state.revoked
                && !control.stopped.is_cancelled()
                && !owner.cancelled.is_cancelled()
                && let Some(edited) = edited
            {
                *input.result = edited;
            }
        })
    }
}

pub struct Provider {
    pub inner: Arc<dyn CodeModeSessionProvider>,
    pub boundary: Arc<Boundary>,
}
impl CodeModeSessionProvider for Provider {
    fn create_session_for_thread(
        &self,
        id: codex_protocol::ThreadId,
    ) -> CodeModeSessionProviderFuture<'_> {
        self.create_session_for_thread_with_reference_profile(
            id,
            codex_protocol::provider_reference_profile::ProviderImageReferencePolicy::PrepareInline,
        )
    }

    fn create_session_for_thread_with_reference_profile(
        &self,
        id: codex_protocol::ThreadId,
        profile: codex_protocol::provider_reference_profile::ProviderImageReferencePolicy,
    ) -> CodeModeSessionProviderFuture<'_> {
        Box::pin(async move {
            self.boundary
                .check_code_import_admission()
                .map_err(|error| error.to_string())?;
            let Some(state) = self.boundary.pending_code_state(id) else {
                let session = self
                    .inner
                    .create_session_for_thread_with_reference_profile(id, profile)
                    .await?;
                return Ok(Session::new(session, self.boundary.clone()) as Arc<dyn CodeModeSession>);
            };
            let control = self
                .boundary
                .threads
                .lock()
                .expect("interception index poisoned")
                .get(&id.to_string())
                .and_then(Weak::upgrade)
                .ok_or("code-mode import requires a current thread owner")?;
            let turn = control
                .direct_turn
                .lock()
                .expect("interception turn poisoned")
                .clone();
            self.boundary
                .close_pending_code_import(&control, None)
                .await
                .map_err(|error| error.to_string())?;
            self.boundary
                .check_code_import_admission()
                .map_err(|error| error.to_string())?;
            let session = self
                .inner
                .create_session_for_thread_with_reference_profile(id, profile)
                .await?;
            // No await or fallible operation may precede retention of this raw
            // receiver, even when Control admission below has already expired.
            let pending = self
                .boundary
                .retain_code_import(id, &control, turn.as_ref(), session);
            let mut operation = pending.operation.lock().await;
            let admitted = {
                let owner = control
                    .direct_turn
                    .lock()
                    .expect("interception turn poisoned");
                let same_turn = match (owner.as_ref(), turn.as_ref()) {
                    (None, None) => true,
                    (Some(current), Some(expected)) => Arc::ptr_eq(current, expected),
                    _ => false,
                };
                let mut current = control
                    .pending_code_import
                    .lock()
                    .expect("pending code import poisoned");
                if *operation != CodeImportState::Pending
                    || self.boundary.check_code_import_admission().is_err()
                    || !same_turn
                    || control.stopped.is_cancelled()
                    || turn
                        .as_ref()
                        .is_some_and(|owner| owner.cancelled.is_cancelled())
                    || current.as_ref().and_then(Weak::upgrade).is_some()
                {
                    false
                } else {
                    *current = Some(Arc::downgrade(&pending));
                    true
                }
            };
            let result = if !admitted {
                Err("code-mode import owner is no longer active".to_string())
            } else {
                pending.session.import_state(state.as_ref().clone()).await
            };
            if let Err(error) = result {
                drop(operation);
                let _ = self
                    .boundary
                    .join_code_imports(
                        vec![pending],
                        tokio::time::Instant::now() + crate::engine::CLOSE_TIMEOUT,
                    )
                    .await;
                return Err(error);
            }
            let current = {
                let owner = control
                    .direct_turn
                    .lock()
                    .expect("interception turn poisoned");
                let same_turn = match (owner.as_ref(), turn.as_ref()) {
                    (None, None) => true,
                    (Some(current), Some(expected)) => Arc::ptr_eq(current, expected),
                    _ => false,
                };
                let mut import = control
                    .pending_code_import
                    .lock()
                    .expect("pending code import poisoned");
                let mut snapshots = self
                    .boundary
                    .restored_code
                    .lock()
                    .expect("restored code state poisoned");
                let current = same_turn
                    && self.boundary.check_code_import_admission().is_ok()
                    && import
                        .as_ref()
                        .is_some_and(|owner| Weak::ptr_eq(owner, &Arc::downgrade(&pending)))
                    && snapshots
                        .get(&id)
                        .is_some_and(|current| Arc::ptr_eq(current, &state))
                    && !control.stopped.is_cancelled()
                    && !turn
                        .as_ref()
                        .is_some_and(|owner| owner.cancelled.is_cancelled());
                if current {
                    import.take();
                    snapshots.remove(&id);
                }
                current
            };
            if !current {
                drop(operation);
                let _ = self
                    .boundary
                    .join_code_imports(
                        vec![pending],
                        tokio::time::Instant::now() + crate::engine::CLOSE_TIMEOUT,
                    )
                    .await;
                return Err("code-mode import owner changed".to_string());
            }
            let session = Session::new(pending.session.clone(), self.boundary.clone());
            *operation = CodeImportState::Published;
            self.boundary.forget_code_import(&pending);
            Ok(session as Arc<dyn CodeModeSession>)
        })
    }

    fn availability(&self) -> Result<(), String> {
        self.inner.availability()
    }
    fn create_session(&self) -> CodeModeSessionProviderFuture<'_> {
        Box::pin(async move {
            Ok(
                Session::new(self.inner.create_session().await?, self.boundary.clone())
                    as Arc<dyn CodeModeSession>,
            )
        })
    }
    fn create_session_with_limits<'a>(
        &'a self,
        limits: CodeModeSessionCellExecutionLimits,
    ) -> CodeModeSessionProviderFuture<'a> {
        Box::pin(async move {
            Ok(Session::new(
                self.inner.create_session_with_limits(limits).await?,
                self.boundary.clone(),
            ) as Arc<dyn CodeModeSession>)
        })
    }
}
struct Session {
    inner: Arc<dyn CodeModeSession>,
    boundary: Arc<Boundary>,
    self_link: Weak<Session>,
    // One owner from native start through the last observation. A starting
    // future may retain its delegate only until it is admitted, stopped, or
    // closed. Yielded/completed entries never retain a StepContext.
    cells: Arc<Mutex<HashMap<CellKey, Arc<Cell>>>>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum CellKey {
    Starting(codex_protocol::ThreadId),
    Started(CellId),
}

struct Cell {
    turn: Option<Arc<DirectTurn>>,
    control: Arc<Control>,
    live: Arc<AtomicBool>,
    // An originally opted-out cell cannot acquire a later policy.
    interception_origin: Option<String>,
    operation: AsyncMutex<CellOperation>,
}

enum CellOperation {
    // Poll by borrow, never take this future before it resolves. If Core drops
    // the execute caller, a scope stop can still join its actual host start.
    Starting(CodeModeSessionResultFuture<'static, StartedCell>),
    Running,
    Saved(RuntimeResponse),
    Consumed,
}

#[derive(Serialize)]
struct WaitInput<'a> {
    cell_id: &'a CellId,
    #[serde(skip_serializing_if = "Option::is_none")]
    yield_time_ms: Option<u64>,
    terminate: bool,
}

impl Session {
    fn execute_with_owner<'a>(
        &'a self,
        request: ExecuteRequest,
        delegate: Arc<dyn CodeModeSessionDelegate>,
        preempt: Option<CancellationToken>,
        owner: Result<Option<StartedExec>, String>,
    ) -> CodeModeSessionResultFuture<'a, StartedCell> {
        Box::pin(async move {
            let Some(owner) = owner? else {
                return self.inner.execute(request, delegate, preempt).await;
            };
            let profile_source = owner.profile_source.clone()?;
            let configured = owner.control.configured();
            let accounted = if configured && owner.control.has_legacy_policy() {
                let bytes = owner.control.account(&request.source, None)?;
                Some((json!(request.source), bytes))
            } else {
                None
            };
            // Host closure may happen before the caller receives the ID.
            let live = Arc::new(AtomicBool::new(true));
            let cell_owner = owner
                .control
                .cell_policy_owner(owner.turn.as_ref(), &request.tool_call_id)?;
            let delegate = Arc::new(Delegate {
                profile_source,
                rules: owner.rules.clone(),
                cell_owner: Mutex::new(cell_owner.clone()),
                turn: owner.turn.clone(),
                inner: delegate,
                live: live.clone(),
                control: configured.then(|| owner.control.clone()),
                native_control: owner
                    .control
                    .has_native_agents()
                    .then(|| owner.control.clone()),
                turn_id: owner.turn_id.clone(),
                model: owner.model.clone(),
                outer_call_id: request.tool_call_id.clone(),
            });
            {
                let mut links = owner
                    .control
                    .code_mode_sessions
                    .lock()
                    .expect("code mode session links poisoned");
                links.retain(|session| session.strong_count() != 0);
                if !links
                    .iter()
                    .any(|session| Weak::ptr_eq(session, &self.self_link))
                {
                    links.push(self.self_link.clone());
                }
            }
            let inner = self.inner.clone();
            let start = Box::pin(async move { inner.execute(request, delegate, preempt).await });
            let key = CellKey::Starting(codex_protocol::ThreadId::new());
            let cell = Arc::new(Cell {
                turn: owner.turn.clone(),
                control: owner.control.clone(),
                live,
                interception_origin: owner
                    .control
                    .has_legacy_policy()
                    .then(|| owner.call_id.clone()),
                operation: AsyncMutex::new(CellOperation::Starting(start)),
            });
            self.cells
                .lock()
                .expect("interception cells poisoned")
                .insert(key.clone(), cell.clone());
            let mut operation = cell.operation.lock().await;
            let CellOperation::Starting(start) = &mut *operation else {
                return Err("Code mode execution stopped before it was admitted".into());
            };
            let result = start.as_mut().await;
            *operation = CellOperation::Running;
            let started = match result {
                Ok(started) => started,
                Err(error) => {
                    *operation = CellOperation::Consumed;
                    self.remove_cell(&key, &cell);
                    return Err(error);
                }
            };
            let cell_id = started.cell_id.clone();
            let key = {
                let mut cells = self.cells.lock().expect("interception cells poisoned");
                if !cells
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &cell))
                {
                    *operation = CellOperation::Consumed;
                    return Err("Code mode session closed during execute".into());
                }
                cells.remove(&key);
                let key = CellKey::Started(cell_id.clone());
                cells.insert(key.clone(), cell.clone());
                key
            };
            drop(operation);
            let cells = self.cells.clone();
            // Core must mark the cell ready before polling nested dispatch.
            let started_id = cell_id.clone();
            Ok(StartedCell::from_future(cell_id, async move {
                let response = started.initial_response().await?;
                if let Some(lease) = &cell_owner {
                    lease.bind(&started_id).await?;
                }
                if !matches!(&response, RuntimeResponse::Yielded { .. }) {
                    let mut operation = cell.operation.lock().await;
                    *operation = CellOperation::Consumed;
                    let mut cells = cells.lock().expect("interception cells poisoned");
                    if cells
                        .get(&key)
                        .is_some_and(|current| Arc::ptr_eq(current, &cell))
                    {
                        cells.remove(&key);
                    }
                }
                match accounted {
                    Some((input, bytes)) => owner.edit_response(response, input, None, bytes).await,
                    None => Ok(response),
                }
            }))
        })
    }

    fn new(inner: Arc<dyn CodeModeSession>, boundary: Arc<Boundary>) -> Arc<Self> {
        Arc::new_cyclic(|self_link| Self {
            inner,
            boundary,
            self_link: self_link.clone(),
            cells: Arc::default(),
        })
    }

    fn remove_cell(&self, key: &CellKey, cell: &Arc<Cell>) {
        let mut cells = self.cells.lock().expect("interception cells poisoned");
        if cells
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, cell))
        {
            cells.remove(key);
        }
    }

    // Caller holds the cell operation until its genuine terminate ACK arrives.
    // Core also calls terminate directly during task abort and discards that
    // outcome: preserve a completed, unread Result for a later genuine wait.
    async fn terminate_cell(
        &self,
        key: &CellKey,
        cell: &Arc<Cell>,
        operation: &mut CellOperation,
        observation: CodeModeSessionResultFuture<'_, WaitOutcome>,
    ) -> Result<WaitOutcome, String> {
        if let CellOperation::Saved(result) = operation {
            return Ok(WaitOutcome::LiveCell(result.clone()));
        }
        let outcome = observation.await?;
        match &outcome {
            WaitOutcome::LiveCell(result @ RuntimeResponse::Result { .. }) => {
                *operation = CellOperation::Saved(result.clone());
            }
            WaitOutcome::LiveCell(RuntimeResponse::Yielded { .. }) => {
                return Err("Code mode termination yielded instead of stopping".to_owned());
            }
            _ => {
                *operation = CellOperation::Consumed;
                self.remove_cell(key, cell);
            }
        }
        Ok(outcome)
    }

    async fn interrupt_owned_cells(&self, control: &Arc<Control>) -> Result<(), String> {
        self.interrupt_exact_cells(control, None).await
    }

    async fn interrupt_exact_cells(
        &self,
        control: &Arc<Control>,
        owner: Option<&Arc<DirectTurn>>,
    ) -> Result<(), String> {
        let selected: Vec<_> = self
            .cells
            .lock()
            .expect("interception cells poisoned")
            .values()
            .filter(|cell| {
                Arc::ptr_eq(&cell.control, control)
                    && owner.is_none_or(|owner| {
                        cell.turn
                            .as_ref()
                            .is_some_and(|turn| Arc::ptr_eq(turn, owner))
                    })
            })
            .cloned()
            .collect();
        let mut failure = None;
        // Revoke policy authority before awaiting any cell operation or ACK.
        {
            let _state = control
                .channel
                .state
                .lock()
                .expect("interception control poisoned");
            for cell in &selected {
                if let Some(turn) = &cell.turn {
                    turn.policy_stopped.store(true, Ordering::Release);
                }
            }
        }
        for cell in selected {
            // Release a passive waiter on this exact Started cell before
            // joining its operation lock. Other turns' cells stay untouched.
            let eager_id = if owner.is_some() {
                self.cells
                    .lock()
                    .expect("interception cells poisoned")
                    .iter()
                    .find(|(_, current)| Arc::ptr_eq(current, &cell))
                    .and_then(|(key, _)| match key {
                        CellKey::Started(id) => Some(id.clone()),
                        _ => None,
                    })
            } else {
                None
            };
            let eager = if let Some(id) = eager_id {
                Some(self.inner.terminate(id).await)
            } else {
                None
            };
            let mut operation = cell.operation.lock().await;
            // Execute may have changed Starting to Started while this sweep
            // waited. Only the sole map's current identity is authoritative.
            let key = self
                .cells
                .lock()
                .expect("interception cells poisoned")
                .iter()
                .find(|(_, current)| Arc::ptr_eq(current, &cell))
                .map(|(key, _)| key.clone());
            let Some(key) = key else {
                continue;
            };
            if let Some(outcome) = eager {
                if let Err(error) = self
                    .terminate_cell(
                        &key,
                        &cell,
                        &mut operation,
                        Box::pin(async move { outcome }),
                    )
                    .await
                {
                    failure.get_or_insert(error);
                }
                continue;
            }
            // This is after the lock: CellClosed may arrive before another
            // termination caller has received its acknowledgment.
            if let CellOperation::Starting(start) = &mut *operation {
                let result = start.as_mut().await;
                match result {
                    Ok(started) => {
                        // No caller received an ID, so a result has no public
                        // reader. Keep it indexed until termination is joined.
                        let new_key = CellKey::Started(started.cell_id.clone());
                        {
                            let mut cells = self.cells.lock().expect("interception cells poisoned");
                            if !cells
                                .get(&key)
                                .is_some_and(|current| Arc::ptr_eq(current, &cell))
                            {
                                // Only joined shutdown can remove Starting
                                // while this cell's operation lock is held.
                                *operation = CellOperation::Consumed;
                                continue;
                            }
                            cells.remove(&key);
                            cells.insert(new_key.clone(), cell.clone());
                        }
                        *operation = CellOperation::Running;
                        match self.inner.terminate(started.cell_id).await {
                            Ok(WaitOutcome::LiveCell(RuntimeResponse::Yielded { .. })) => {
                                failure.get_or_insert_with(|| {
                                    "Code mode termination yielded instead of stopping".to_owned()
                                });
                            }
                            Ok(_) => {
                                *operation = CellOperation::Consumed;
                                self.remove_cell(&new_key, &cell);
                            }
                            Err(error) => {
                                failure.get_or_insert(error);
                            }
                        }
                    }
                    Err(error) => {
                        *operation = CellOperation::Consumed;
                        self.remove_cell(&key, &cell);
                        failure.get_or_insert(error);
                    }
                }
                continue;
            }
            let CellKey::Started(id) = &key else {
                continue;
            };
            if !matches!(*operation, CellOperation::Running) || !cell.live.load(Ordering::Acquire) {
                continue;
            }
            if let Err(error) = self
                .terminate_cell(
                    &key,
                    &cell,
                    &mut operation,
                    self.inner.terminate(id.clone()),
                )
                .await
            {
                failure.get_or_insert(error);
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn observe_wait(
        &self,
        cell_id: CellId,
        yield_time_ms: Option<u64>,
        terminate: bool,
        observation: CodeModeSessionResultFuture<'_, WaitOutcome>,
    ) -> Result<WaitOutcome, String> {
        let current = self.boundary.take_start(codex_code_mode::WAIT_TOOL_NAME);
        let key = CellKey::Started(cell_id.clone());
        let cell = self
            .cells
            .lock()
            .expect("interception cells poisoned")
            .get(&key)
            .cloned();
        let Some(cell) = cell else {
            return observation.await;
        };
        let mut operation = cell.operation.lock().await;
        if terminate && current.is_none() {
            return self
                .terminate_cell(&key, &cell, &mut operation, observation)
                .await;
        }
        let mut outcome = if let CellOperation::Saved(result) = &*operation {
            WaitOutcome::LiveCell(result.clone())
        } else {
            observation.await?
        };
        if !matches!(
            &outcome,
            WaitOutcome::LiveCell(RuntimeResponse::Yielded { .. })
        ) {
            *operation = CellOperation::Consumed;
            self.remove_cell(&key, &cell);
        }
        // JavaScript policies may be indefinite; native abort drops the observation
        // before stop sweeps, so release the per-cell lock before any policy.
        drop(operation);
        if let (Some(current), Some(exec_id)) = (current, &cell.interception_origin) {
            if Arc::ptr_eq(&current.control, &cell.control) {
                if let WaitOutcome::LiveCell(response) = outcome {
                    let wait = WaitInput {
                        cell_id: &cell_id,
                        yield_time_ms,
                        terminate,
                    };
                    let bytes = current.control.account(&wait, None)?;
                    let input = Value::String(
                        serde_json::to_value(&wait)
                            .map_err(|_| FAILURE)?
                            .to_string(),
                    );
                    outcome = WaitOutcome::LiveCell(
                        current
                            .edit_response(response, input, Some(exec_id), bytes)
                            .await?,
                    );
                }
            }
        }
        Ok(outcome)
    }
}

impl CodeModeSession for Session {
    fn export_state(&self) -> CodeModeSessionResultFuture<'_, codex_code_mode::CodeModeSnapshot> {
        Box::pin(async move {
            let cells = self
                .cells
                .lock()
                .expect("code-mode cells poisoned")
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for cell in cells {
                let operation = cell
                    .operation
                    .try_lock()
                    .map_err(|_| "code-mode observation is active")?;
                if matches!(
                    *operation,
                    CellOperation::Starting(_) | CellOperation::Saved(_)
                ) {
                    return Err("code-mode observation is unsettled".to_string());
                }
            }
            self.inner.export_state().await
        })
    }
    fn import_state(
        &self,
        state: codex_code_mode::CodeModeSnapshot,
    ) -> CodeModeSessionResultFuture<'_, ()> {
        self.inner.import_state(state)
    }

    fn execute<'a>(
        &'a self,
        request: ExecuteRequest,
        delegate: Arc<dyn CodeModeSessionDelegate>,
        preempt: Option<CancellationToken>,
    ) -> CodeModeSessionResultFuture<'a, StartedCell> {
        let owner = self.boundary.take_exec(&request.tool_call_id);
        self.execute_with_owner(request, delegate, preempt, owner)
    }
    fn execute_owned(
        self: Arc<Self>,
        request: ExecuteRequest,
        delegate: Arc<dyn CodeModeSessionDelegate>,
        preempt: Option<CancellationToken>,
    ) -> CodeModeSessionResultFuture<'static, StartedCell> {
        // Core moves startup to another task after this synchronous admission handoff.
        let owner = self.boundary.take_exec(&request.tool_call_id);
        Box::pin(async move {
            self.execute_with_owner(request, delegate, preempt, owner)
                .await
        })
    }
    fn wait<'a>(
        &'a self,
        request: WaitRequest,
        preempt: Option<CancellationToken>,
    ) -> CodeModeSessionResultFuture<'a, WaitOutcome> {
        Box::pin(async move {
            let cell_id = request.cell_id.clone();
            let yield_time_ms = request.yield_time_ms;
            self.observe_wait(
                cell_id,
                Some(yield_time_ms),
                false,
                self.inner.wait(request, preempt),
            )
            .await
        })
    }
    fn terminate<'a>(&'a self, cell_id: CellId) -> CodeModeSessionResultFuture<'a, WaitOutcome> {
        Box::pin(async move {
            self.observe_wait(cell_id.clone(), None, true, self.inner.terminate(cell_id))
                .await
        })
    }
    fn shutdown<'a>(&'a self) -> CodeModeSessionResultFuture<'a, ()> {
        Box::pin(async move {
            let result = self.inner.shutdown().await;
            if result.is_ok() {
                self.cells
                    .lock()
                    .expect("interception cells poisoned")
                    .clear();
            }
            result
        })
    }
}
struct Delegate {
    profile_source: Option<Arc<ProfileMcpSource>>,
    rules: Option<crate::canonical_rules::CellImageOrigin>,
    cell_owner: Mutex<Option<Arc<CellPolicyOwner>>>,
    turn: Option<Arc<DirectTurn>>,
    inner: Arc<dyn CodeModeSessionDelegate>,
    live: Arc<AtomicBool>,
    control: Option<Arc<Control>>,
    native_control: Option<Arc<Control>>,
    turn_id: String,
    model: Option<Arc<str>>,
    outer_call_id: String,
}
impl Delegate {
    fn check_native(&self, invocation: &CodeModeNestedToolCall) -> Result<(), String> {
        if let Some(control) = &self.native_control
            && (control.stopped.is_cancelled()
                || !control
                    .native_agents
                    .get()
                    .is_some_and(|policy| policy.admits_nested(control.native_depth, invocation)))
        {
            return Err(FAILURE.into());
        }
        Ok(())
    }
}
impl CodeModeSessionDelegate for Delegate {
    fn invoke_tool<'a>(
        &'a self,
        mut invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a> {
        Box::pin(async move {
            let _image_origin = self
                .rules
                .as_ref()
                .and_then(|rules| rules.track(&self.turn_id, &invocation));
            self.check_native(&invocation)?;
            let Some(control) = &self.control else {
                return self.inner.invoke_tool(invocation, cancellation_token).await;
            };
            let mcp =
                control.mcp_selected_for(&invocation.tool_name, self.profile_source.as_ref())?;
            if !mcp && !control.has_legacy_policy() {
                // Empty MCP enrollment must not add post-effect byte failures
                // to ordinary, unselected native calls.
                return self.inner.invoke_tool(invocation, cancellation_token).await;
            }
            let tracing = control.tracing_context().context;
            let request = Request {
                tracing_context: tracing.as_ref().map(|context| context.token()),
                phase: "before",
                route: "code_mode",
                boundary: "pre_dispatch",
                turn_id: &self.turn_id,
                model: self.model.as_deref(),
                call_id: None,
                outer_call_id: Some(&self.outer_call_id),
                cell_id: Some(&invocation.cell_id),
                runtime_tool_call_id: Some(&invocation.runtime_tool_call_id),
                tool_name: Name {
                    namespace: invocation.tool_name.namespace.as_deref(),
                    name: &invocation.tool_name.name,
                },
                tool_kind: invocation.tool_kind,
                input: &invocation.input,
                result: (),
            };
            let lease = self
                .cell_owner
                .lock()
                .expect("cell policy owner poisoned")
                .clone();
            let builtin = control.controls_builtin_result(&invocation.tool_name);
            let executor_before = control.controls_executor_before(&invocation.tool_name);
            if (builtin && control.root || executor_before) && lease.is_none() {
                // An originally opted-out cell cannot acquire callback authority.
                return Err(FAILURE.into());
            }
            let request = ProfiledRequest {
                request,
                source: self.profile_source.clone(),
            };
            let decision = if builtin || executor_before {
                if let Some(lease) = &lease {
                    lease.identify(&invocation.cell_id)?;
                    control
                        .decide(
                            OwnedRequest {
                                request,
                                owner: &lease.turn,
                                retained: control.root,
                                cell_owner_id: Some(lease.id.clone()),
                            },
                            &cancellation_token,
                        )
                        .await?
                } else {
                    control.decide(request, &cancellation_token).await?
                }
            } else if let (true, Some(owner)) = (mcp, self.turn.as_ref()) {
                // This delegate retains its issuing turn, including a retained
                // cell. A later current-turn lookup cannot grant stop authority.
                control
                    .decide_retained(
                        OwnedRequest {
                            request,
                            owner,
                            retained: control.root,
                            cell_owner_id: None,
                        },
                        &cancellation_token,
                        None,
                        None,
                    )
                    .await?
            } else {
                control.decide(request, &cancellation_token).await?
            };
            if let Decision::Replace { value } = decision {
                invocation.input = Some(value);
            }
            self.check_native(&invocation)?;
            if builtin {
                let turn = self.turn.as_ref().ok_or(FAILURE)?;
                control.publish_result(turn, &cancellation_token, control.root, None, || ())?;
            }
            if mcp {
                // Native MCP result control owns the result transform. This
                // rule is pre-effect only, not a second result interceptor.
                return self.inner.invoke_tool(invocation, cancellation_token).await;
            }
            // Pass the original token; observation preemption must never cancel
            // nested work. Original errors propagate as errors, not editable JSON.
            // Hold the effective input/identity for the after notice before
            // passing the actual invocation by value to native dispatch.
            let bytes = if builtin {
                None
            } else {
                Some(control.account(&invocation, None)?)
            };
            let retained = (!builtin).then(|| invocation.clone());
            let result = self
                .inner
                .invoke_tool(invocation, cancellation_token.clone())
                .await?;
            if builtin {
                let turn = self.turn.as_ref().ok_or(FAILURE)?;
                return control.publish_result(
                    turn,
                    &cancellation_token,
                    control.root,
                    None,
                    || result,
                );
            }
            let retained = retained.expect("non-builtin after input was retained");
            let tracing = codex_otel::sdk_trace::ContextLease::capture();
            let request = Request {
                tracing_context: tracing.as_ref().map(|context| context.token()),
                phase: "after",
                route: "code_mode",
                boundary: "nested_return",
                turn_id: &self.turn_id,
                model: self.model.as_deref(),
                call_id: None,
                outer_call_id: Some(&self.outer_call_id),
                cell_id: Some(&retained.cell_id),
                runtime_tool_call_id: Some(&retained.runtime_tool_call_id),
                tool_name: Name {
                    namespace: retained.tool_name.namespace.as_deref(),
                    name: &retained.tool_name.name,
                },
                tool_kind: retained.tool_kind,
                input: &retained.input,
                result: &result,
            };
            let decision = if let Some(lease) = lease.filter(|_| {
                executor_before
                    && matches!(
                        retained.tool_name.name.as_str(),
                        "project_glob" | "project_grep"
                    )
            }) {
                control
                    .decide_retained(
                        OwnedRequest {
                            request,
                            owner: &lease.turn,
                            retained: control.root,
                            cell_owner_id: None,
                        },
                        &cancellation_token,
                        bytes,
                        None,
                    )
                    .await?
            } else {
                control
                    .decide_retained(request, &cancellation_token, bytes, None)
                    .await?
            };
            match decision {
                Decision::Replace { value } => Ok(value),
                _ => Ok(result),
            }
        })
    }
    fn notify<'a>(
        &'a self,
        call_id: String,
        cell_id: CellId,
        text: String,
        cancellation_token: CancellationToken,
    ) -> NotificationFuture<'a> {
        self.inner
            .notify(call_id, cell_id, text, cancellation_token)
    }
    fn cell_closed(&self, cell_id: &CellId) {
        self.live.store(false, Ordering::Release);
        self.cell_owner
            .lock()
            .expect("cell policy owner poisoned")
            .take();
        self.inner.cell_closed(cell_id);
    }
}

/// Only for the audited native extension owners in extensions::build.
/// Nested results already pass through the RPC policy.
pub struct DirectContributor(pub Arc<dyn ToolContributor>, pub DirectOutput);

#[derive(Clone, Copy)]
pub enum DirectOutput {
    /// Board and skills return JsonToolOutput, including to PostToolUse.
    Json,
    /// Web search and image generation return structured model bodies and opt
    /// out of PostToolUse. Never flatten image/audio/encrypted items to logs.
    ResponseBody,
}
impl DirectContributor {
    fn wrap(
        &self,
        tools: Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>>,
        thread: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Some(control) = thread.get::<Control>() else {
            return tools;
        };
        tools
            .into_iter()
            .map(|inner| {
                Arc::new(Executor {
                    inner,
                    control: control.clone(),
                    direct: self.1,
                }) as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>
            })
            .collect()
    }
}
impl ToolContributor for DirectContributor {
    fn tools(
        &self,
        session: &ExtensionData,
        thread: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        self.wrap(self.0.tools(session, thread), thread)
    }
    fn tools_for_step(
        &self,
        session: &ExtensionData,
        thread: &ExtensionData,
        step: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        self.wrap(self.0.tools_for_step(session, thread, step), thread)
    }
}
struct Executor {
    inner: Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>,
    control: Arc<Control>,
    direct: DirectOutput,
}
#[derive(Serialize)]
#[serde(untagged)]
enum Projected {
    Body(FunctionCallOutputBody),
    Json(Value),
}
impl<'call> ToolExecutor<ToolCall<'call>> for Executor {
    fn is_native_environment_tool(&self) -> bool {
        self.inner.is_native_environment_tool()
    }
    fn tool_name(&self) -> ToolName {
        self.inner.tool_name()
    }
    fn spec(&self) -> ToolSpec {
        self.inner.spec()
    }
    fn exposure(&self) -> ToolExposure {
        self.inner.exposure()
    }
    fn search_info(&self) -> Option<ToolSearchInfo> {
        self.inner.search_info()
    }
    fn supports_parallel_tool_calls(&self) -> bool {
        self.inner.supports_parallel_tool_calls()
    }
    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        ToolCall<'call>: 'a,
    {
        Box::pin(async move {
            if !self.control.configured() || !matches!(&call.source, ToolCallSource::Direct) {
                return self.inner.handle(call).await;
            }
            let token = CancellationToken::new(); // Core cancels by dropping this future.
            let ToolPayload::Function { arguments } = &call.payload else {
                return self.inner.handle(call).await;
            };
            let failed = || FunctionCallError::RespondToModel(FAILURE.into());
            let bytes = self
                .control
                .account(
                    &(&call.turn_id, &call.call_id, &call.tool_name, arguments),
                    None,
                )
                .map_err(|_| failed())?;
            let arguments = arguments.clone();
            let payload = ToolPayload::Function { arguments };
            let call_id = call.call_id.clone();
            let turn_id = call.turn_id.clone();
            let model = call.model.clone();
            let name = call.tool_name.clone();
            let result = self.inner.handle(call).await?;
            let projection = match self.direct {
                DirectOutput::ResponseBody => {
                    // These audited owners return FunctionCallOutput and do
                    // not participate in PostToolUse. Fail closed if the pin's
                    // contract unexpectedly changes; never silently emit O
                    // while acknowledging R to a result policy.
                    if result.post_tool_use_response(&call_id, &payload).is_some() {
                        return Err(failed());
                    }
                    match result.to_response_item(&call_id, &payload) {
                        ResponseInputItem::FunctionCallOutput { output, .. } => {
                            Projected::Body(output.body)
                        }
                        _ => return Err(failed()),
                    }
                }
                _ => Projected::Json(result.code_mode_result(&payload)), // audited JsonToolOutput only
            };
            let ToolPayload::Function { arguments } = &payload else {
                unreachable!()
            };
            let tracing = codex_otel::sdk_trace::ContextLease::capture();
            let request = Request {
                tracing_context: tracing.as_ref().map(|context| context.token()),
                phase: "after",
                route: "extension",
                boundary: "executor_return",
                turn_id: &turn_id,
                model: Some(&model),
                call_id: Some(&call_id),
                outer_call_id: None,
                cell_id: None,
                runtime_tool_call_id: None,
                tool_name: Name {
                    namespace: name.namespace.as_deref(),
                    name: &name.name,
                },
                tool_kind: "function_json",
                input: arguments,
                result: &projection,
            };
            match self
                .control
                .decide_retained(request, &token, Some(bytes), None)
                .await
                .map_err(|_| failed())?
            {
                Decision::Replace { value } => {
                    let body = if matches!(self.direct, DirectOutput::ResponseBody) {
                        Some(
                            serde_json::from_value::<FunctionCallOutputBody>(value.clone())
                                .map_err(|_| failed())?,
                        )
                    } else {
                        None
                    };
                    Ok(Box::new(EditedOutput {
                        original: result,
                        value,
                        body,
                    }) as Box<dyn ToolOutput>)
                }
                _ => Ok(result),
            }
        })
    }
}
struct EditedOutput {
    original: Box<dyn ToolOutput>,
    value: Value,
    body: Option<FunctionCallOutputBody>,
}
impl ToolOutput for EditedOutput {
    fn log_output(&self) -> String {
        self.original.log_output()
    }
    fn success_for_logging(&self) -> bool {
        self.original.success_for_logging()
    }
    fn set_handler_duration_ms(&mut self, ms: u64) {
        self.original.set_handler_duration_ms(ms);
    }
    fn contains_external_context(&self) -> bool {
        self.original.contains_external_context()
    }
    fn fallback_token_limit_override(&self) -> Option<usize> {
        self.original.fallback_token_limit_override()
    }
    fn post_tool_use_id(&self, id: &str) -> String {
        self.original.post_tool_use_id(id)
    }
    fn post_tool_use_input(&self, payload: &ToolPayload) -> Option<Value> {
        self.original.post_tool_use_input(payload)
    }
    fn post_tool_use_response(&self, id: &str, payload: &ToolPayload) -> Option<Value> {
        self.original
            .post_tool_use_response(id, payload)
            .map(|_| self.value.clone())
    }
    fn code_mode_result(&self, _: &ToolPayload) -> Value {
        self.value.clone()
    }
    fn tool_result_metadata(&self) -> Option<&Value> {
        self.original.tool_result_metadata()
    }
    fn to_response_item(&self, id: &str, payload: &ToolPayload) -> ResponseInputItem {
        let mut response = self.original.to_response_item(id, payload);
        match &mut response {
            ResponseInputItem::FunctionCallOutput { output, .. }
            | ResponseInputItem::CustomToolCallOutput { output, .. } => {
                output.body = self
                    .body
                    .clone()
                    .unwrap_or_else(|| FunctionCallOutputBody::Text(self.value.to_string()));
            }
            _ => {}
        }
        response
    }
}

#[cfg(test)]
struct TestToolAdmission {
    thread: String,
    turn_store: Arc<ExtensionData>,
    selected: Option<Vec<(ToolName, bool)>>,
}
#[cfg(test)]
impl std::fmt::Debug for TestToolAdmission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TestToolAdmission")
    }
}
#[cfg(test)]
impl ModelToolAdmission for TestToolAdmission {
    fn thread_id(&self) -> &str {
        &self.thread
    }
    fn turn_store(&self) -> &ExtensionData {
        &self.turn_store
    }
    fn admits(&self, item: &ResponseItem) -> bool {
        self.selected.as_ref().is_none_or(|selected| {
            let (name, function) = match item {
                ResponseItem::FunctionCall {
                    name, namespace, ..
                } => (
                    ToolName::new(namespace.clone(), name.clone()).with_default_namespace(),
                    true,
                ),
                ResponseItem::CustomToolCall {
                    name, namespace, ..
                } => (
                    ToolName::new(namespace.clone(), name.clone()).with_default_namespace(),
                    false,
                ),
                _ => return false,
            };
            selected
                .iter()
                .any(|entry| entry == &(name.clone(), function))
        })
    }
}
#[cfg(test)]
fn test_tool_admission(
    thread: &str,
    turn: &str,
    selected: Option<Vec<(ToolName, bool)>>,
) -> Arc<TestToolAdmission> {
    let turn_store = Arc::new(ExtensionData::new(turn));
    turn_store.get_or_init(|| DirectTurn {
        policy_stopped: AtomicBool::new(false),
        id: turn.into(),
        model: Mutex::new(None),
        command_admission: Mutex::new(None),
        cancelled: CancellationToken::new(),
        settlement: None,
        core_task: Some(Arc::new(codex_core_api::OwnedTurnTask::default())),
        mcp_calls: Mutex::default(),
    });
    Arc::new(TestToolAdmission {
        thread: thread.into(),
        turn_store,
        selected,
    })
}

#[cfg(test)]
pub(crate) fn test_mcp_result_owner(
    thread: &ExtensionData,
    turn: &ExtensionData,
    ended: bool,
) -> impl FnOnce() {
    let control = thread.get_or_init(|| Control::new(thread.level_id().into(), true));
    let owner = turn.get_or_init(|| DirectTurn {
        policy_stopped: AtomicBool::new(false),
        id: turn.level_id().into(),
        model: Mutex::new(None),
        command_admission: Mutex::new(None),
        cancelled: CancellationToken::new(),
        settlement: None,
        core_task: None,
        mcp_calls: Mutex::default(),
    });
    if ended {
        owner.cancelled.cancel();
    }
    move || {
        let _state = control
            .channel
            .state
            .lock()
            .expect("interception control poisoned");
        owner.policy_stopped.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_code_mode::CodeModeToolKind;
    use codex_code_mode::RuntimeResponse;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // These exercise boundary receipt bookkeeping, not host retirement proof.
    struct ImportCleanupProbe(mpsc::UnboundedSender<oneshot::Sender<Result<(), String>>>);

    impl CodeModeSession for ImportCleanupProbe {
        fn execute<'a>(
            &'a self,
            _: ExecuteRequest,
            _: Arc<dyn CodeModeSessionDelegate>,
            _: Option<CancellationToken>,
        ) -> CodeModeSessionResultFuture<'a, StartedCell> {
            Box::pin(async { Err("unused".into()) })
        }
        fn wait<'a>(
            &'a self,
            _: WaitRequest,
            _: Option<CancellationToken>,
        ) -> CodeModeSessionResultFuture<'a, WaitOutcome> {
            Box::pin(async { Err("unused".into()) })
        }
        fn terminate<'a>(&'a self, _: CellId) -> CodeModeSessionResultFuture<'a, WaitOutcome> {
            Box::pin(async { Err("unused".into()) })
        }
        fn shutdown<'a>(&'a self) -> CodeModeSessionResultFuture<'a, ()> {
            Box::pin(async move {
                let (tx, rx) = oneshot::channel();
                self.0.send(tx).map_err(|_| "cleanup probe closed")?;
                rx.await
                    .map_err(|_| "cleanup probe response closed".to_string())?
            })
        }
    }

    fn import_cleanup_boundary() -> Boundary {
        Boundary::new(
            Arc::new(crate::storage::MemoryAgentGraph::default()),
            Arc::new(RwLock::new(None)),
        )
    }

    #[tokio::test]
    async fn import_cleanup_survives_index_removal_and_distinguishes_history_from_outstanding() {
        let boundary = import_cleanup_boundary();
        let first_id = codex_protocol::ThreadId::new();
        let second_id = codex_protocol::ThreadId::new();
        let first_control = Arc::new(Control::new(first_id.to_string(), true));
        let second_control = Arc::new(Control::new(second_id.to_string(), true));
        let (first_tx, mut first_rx) = mpsc::unbounded_channel();
        let (second_tx, mut second_rx) = mpsc::unbounded_channel();
        let first = boundary.retain_code_import(
            first_id,
            &first_control,
            None,
            Arc::new(ImportCleanupProbe(first_tx)),
        );
        boundary.retain_code_import(
            second_id,
            &second_control,
            None,
            Arc::new(ImportCleanupProbe(second_tx)),
        );
        let retained = Arc::downgrade(&first);
        boundary
            .threads
            .lock()
            .unwrap()
            .insert(first_id.to_string(), Arc::downgrade(&first_control));
        boundary
            .threads
            .lock()
            .unwrap()
            .remove(&first_id.to_string());
        // No Control slot was admitted. Only Boundary retains this receiver.
        drop(first);
        drop(first_control);
        assert!(retained.upgrade().is_some());
        let deadline = tokio::time::Instant::now() + crate::engine::CLOSE_TIMEOUT;
        let mut failed = Box::pin(boundary.cleanup_code_imports(Some(first_id), deadline));
        assert!(futures_util::poll!(&mut failed).is_pending());
        first_rx
            .try_recv()
            .unwrap()
            .send(Err("first shutdown failed".into()))
            .unwrap();
        assert_eq!(
            failed.await.unwrap_err().to_string(),
            "first shutdown failed"
        );
        assert!(boundary.check_code_import_cleanup().is_err());
        assert!(boundary.check_code_import_admission().is_err());
        assert!(second_rx.try_recv().is_err());

        let mut recovered = Box::pin(boundary.cleanup_code_imports(Some(first_id), deadline));
        assert!(futures_util::poll!(&mut recovered).is_pending());
        first_rx.try_recv().unwrap().send(Ok(())).unwrap();
        let diagnostic = recovered.await.unwrap().unwrap();
        assert!(diagnostic.contains("first shutdown failed"));
        assert!(retained.upgrade().is_none());
        // One success neither clears another receiver nor resets admission.
        assert!(boundary.check_code_import_cleanup().is_err());
        assert!(boundary.check_code_import_admission().is_err());
        for _ in 0..2 {
            let mut sticky = Box::pin(boundary.cleanup_code_imports(None, deadline));
            assert!(futures_util::poll!(&mut sticky).is_pending());
            second_rx
                .try_recv()
                .unwrap()
                .send(Err("unacknowledged".into()))
                .unwrap();
            assert_eq!(sticky.await.unwrap_err().to_string(), "unacknowledged");
            assert!(boundary.check_code_import_cleanup().is_err());
        }
        let mut finished = Box::pin(boundary.cleanup_code_imports(None, deadline));
        assert!(futures_util::poll!(&mut finished).is_pending());
        second_rx.try_recv().unwrap().send(Ok(())).unwrap();
        assert_eq!(finished.await.unwrap(), Some(diagnostic));
        assert!(boundary.check_code_import_cleanup().is_ok());
        assert!(boundary.check_code_import_admission().is_err());
    }

    #[tokio::test]
    async fn import_cleanup_deadline_and_dropped_joiner_retain_serialized_receiver() {
        let boundary = import_cleanup_boundary();
        let id = codex_protocol::ThreadId::new();
        let control = Arc::new(Control::new(id.to_string(), true));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let pending =
            boundary.retain_code_import(id, &control, None, Arc::new(ImportCleanupProbe(tx)));
        let importing = pending.operation.lock().await;
        assert!(
            boundary
                .cleanup_code_imports(
                    Some(id),
                    tokio::time::Instant::now() + Duration::from_millis(1),
                )
                .await
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
        assert!(rx.try_recv().is_err());
        assert!(boundary.check_code_import_cleanup().is_err());
        drop(importing);

        let deadline = tokio::time::Instant::now() + crate::engine::CLOSE_TIMEOUT;
        let mut first = Box::pin(boundary.cleanup_code_imports(None, deadline));
        assert!(futures_util::poll!(&mut first).is_pending());
        let abandoned = rx.try_recv().unwrap();
        let mut second = Box::pin(boundary.cleanup_code_imports(None, deadline));
        assert!(futures_util::poll!(&mut second).is_pending());
        assert!(rx.try_recv().is_err());
        drop(first);
        assert!(abandoned.send(Ok(())).is_err());
        assert!(boundary.check_code_import_cleanup().is_err());
        assert!(futures_util::poll!(&mut second).is_pending());
        rx.try_recv().unwrap().send(Ok(())).unwrap();
        assert!(second.await.unwrap().unwrap().contains("timed out"));
        assert!(boundary.check_code_import_cleanup().is_ok());
    }

    #[tokio::test]
    async fn request_cancellation_rejects_callback_entry_before_waiter_repoll() {
        let root = Arc::new(Control::new("root".into(), true));
        root.enable(5.0, Scope::ThreadTree).unwrap();
        let child = Arc::new(Control::descendant("leaf".into(), &root));
        let initial_bytes = root.channel.bytes.available_permits();
        let cancelled_token = CancellationToken::new();
        let sibling_token = CancellationToken::new();
        let mut cancelled =
            Box::pin(child.decide(json!({"input":"cancelled request"}), &cancelled_token));
        let mut sibling = Box::pin(child.decide(json!({"input":"live sibling"}), &sibling_token));
        assert!(futures_util::poll!(&mut cancelled).is_pending());
        let cancelled_wire = root.next_wire().await.unwrap();
        let cancelled_notice: Value = serde_json::from_str(&cancelled_wire).unwrap();
        let cancelled_nonce = cancelled_notice["nonce"].as_u64().unwrap();
        assert!(root.handoff(cancelled_nonce));
        assert!(futures_util::poll!(&mut sibling).is_pending());
        let sibling_wire = root.next_wire().await.unwrap();
        let sibling_notice: Value = serde_json::from_str(&sibling_wire).unwrap();
        let sibling_nonce = sibling_notice["nonce"].as_u64().unwrap();
        assert_ne!(cancelled_nonce, sibling_nonce);
        assert!(root.handoff(sibling_nonce));
        assert!(root.can_enter(cancelled_nonce));
        assert!(root.can_enter(sibling_nonce));
        let held_bytes = initial_bytes - cancelled_wire.len() - sibling_wire.len();
        assert_eq!(root.channel.bytes.available_permits(), held_bytes);

        // Core may cancel this invocation before the deciding future runs again.
        // The same still-live child and a different request keep their rights.
        cancelled_token.cancel();
        assert!(!root.can_enter(cancelled_nonce));
        assert!(!root.resolve(cancelled_nonce, r#"{"action":"continue"}"#));
        assert!(!root.resolve(cancelled_nonce, r#"{"action":"replace","value":{}}"#));
        assert_eq!(root.channel.bytes.available_permits(), held_bytes);
        assert!(root.can_enter(sibling_nonce));
        assert!(root.resolve(sibling_nonce, r#"{"action":"continue"}"#));
        assert!(matches!(sibling.await, Ok(Decision::Continue)));
        assert!(root.release(sibling_nonce));
        assert_eq!(
            root.channel.bytes.available_permits(),
            initial_bytes - cancelled_wire.len()
        );
        assert!(cancelled.await.is_err());
        // Revoked authority is distinct from the callback's physical storage.
        assert_eq!(
            root.channel.bytes.available_permits(),
            initial_bytes - cancelled_wire.len()
        );
        assert!(root.release(cancelled_nonce));
        assert_eq!(root.channel.bytes.available_permits(), initial_bytes);
        assert!(root.channel.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn native_deadline_rejects_queued_and_handed_callbacks_before_waiter_repoll() {
        for handed_off in [false, true] {
            let root = Arc::new(Control::new("root".into(), true));
            root.enable(0.1, Scope::Root).unwrap();
            let initial_bytes = root.channel.bytes.available_permits();
            let token = CancellationToken::new();
            let mut decision = Box::pin(root.decide(json!({"input":"expired"}), &token));
            assert!(futures_util::poll!(&mut decision).is_pending());
            let early_wire = if handed_off {
                let wire = root.next_wire().await.unwrap();
                let notice: Value = serde_json::from_str(&wire).unwrap();
                let nonce = notice["nonce"].as_u64().unwrap();
                assert!(root.can_enter(nonce));
                assert!(root.handoff(nonce));
                Some(wire)
            } else {
                None
            };

            // Use real time: admission uses std::time::Instant, and a queued
            // decision need not get a second poll before its host reader runs.
            std::thread::sleep(Duration::from_millis(150));
            let wire = match early_wire {
                Some(wire) => wire,
                None => root.next_wire().await.unwrap(),
            };
            let notice: Value = serde_json::from_str(&wire).unwrap();
            let nonce = notice["nonce"].as_u64().unwrap();
            assert!(!root.can_enter(nonce), "handed_off={handed_off}");
            assert!(
                !root.resolve(nonce, r#"{"action":"continue"}"#),
                "handed_off={handed_off}"
            );
            if !handed_off {
                // Handoff transfers storage only; it cannot revive admission.
                assert!(root.handoff(nonce));
            }
            assert!(decision.await.is_err());
            assert_eq!(
                root.channel.bytes.available_permits(),
                initial_bytes - wire.len()
            );
            assert!(root.release(nonce));
            assert_eq!(root.channel.bytes.available_permits(), initial_bytes);
            assert!(root.channel.state.lock().unwrap().pending.is_empty());
        }
    }

    #[tokio::test]
    async fn native_on_time_reply_survives_delayed_waiter_consumption() {
        let root = Arc::new(Control::new("root".into(), true));
        root.enable(1.0, Scope::Root).unwrap();
        let initial_bytes = root.channel.bytes.available_permits();
        let token = CancellationToken::new();
        let mut decision = Box::pin(root.decide(json!({"input":"on time"}), &token));
        assert!(futures_util::poll!(&mut decision).is_pending());
        let wire = root.next_wire().await.unwrap();
        let notice: Value = serde_json::from_str(&wire).unwrap();
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(root.can_enter(nonce));
        assert!(root.handoff(nonce));
        assert!(root.resolve(nonce, r#"{"action":"continue"}"#));
        assert!(!root.can_enter(nonce));
        assert_eq!(
            root.channel.bytes.available_permits(),
            initial_bytes - wire.len()
        );
        // Only delivery must beat the deadline; scheduler latency after native
        // acceptance cannot invalidate a host decision already received.
        std::thread::sleep(Duration::from_millis(1100));
        assert!(matches!(decision.await, Ok(Decision::Continue)));
        assert_eq!(
            root.channel.bytes.available_permits(),
            initial_bytes - wire.len()
        );
        assert!(root.release(nonce));
        assert_eq!(root.channel.bytes.available_permits(), initial_bytes);
        assert!(root.channel.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn cancelled_callbacks_count_until_release_without_corrupting_live_sibling() {
        let root = Arc::new(Control::new("root".into(), true));
        root.enable(3.0, Scope::ThreadTree).unwrap();
        let child = Arc::new(Control::descendant("leaf".into(), &root));
        let initial_bytes = root.channel.bytes.available_permits();
        let mut retained = Vec::new();
        for _ in 0..127 {
            let token = CancellationToken::new();
            let mut held = Box::pin(child.decide(json!({"input":"held"}), &token));
            assert!(futures_util::poll!(&mut held).is_pending());
            let wire = root.next_wire().await.unwrap();
            let notice: Value = serde_json::from_str(&wire).unwrap();
            let nonce = notice["nonce"].as_u64().unwrap();
            assert_eq!(
                notice["request"],
                json!({"thread_id":"leaf","incarnation":child.incarnation,"input":"held"})
            );
            assert!(root.handoff(nonce));
            token.cancel();
            assert!(held.await.is_err());
            assert!(!root.resolve(nonce, r#"{"action":"continue"}"#));
            assert_eq!(
                root.next_wire().await.unwrap(),
                format!(r#"{{"cancel":{nonce}}}"#)
            );
            retained.push((nonce, wire.len()));
        }

        let live_token = CancellationToken::new();
        let mut live = Box::pin(root.decide(json!({"input":"survivor"}), &live_token));
        assert!(futures_util::poll!(&mut live).is_pending());
        let live_wire = root.next_wire().await.unwrap();
        let live_notice: Value = serde_json::from_str(&live_wire).unwrap();
        let live_nonce = live_notice["nonce"].as_u64().unwrap();
        assert_eq!(
            live_notice["request"],
            json!({"thread_id":"root","incarnation":root.incarnation,"input":"survivor"})
        );
        assert!(root.handoff(live_nonce));
        let held_bytes: usize = retained.iter().map(|(_, size)| size).sum();
        let free_at_capacity = initial_bytes - held_bytes - live_wire.len();
        assert_eq!(root.channel.bytes.available_permits(), free_at_capacity);

        let denied_token = CancellationToken::new();
        let mut denied =
            Box::pin(child.decide(json!({"input":"must not dispatch"}), &denied_token));
        assert!(matches!(
            futures_util::poll!(&mut denied),
            std::task::Poll::Ready(Err(error)) if error == FAILURE
        ));
        assert_eq!(root.channel.bytes.available_permits(), free_at_capacity);
        let (released, size) = retained.remove(0);
        assert!(root.release(released));
        assert!(!root.release(released));
        assert_eq!(
            root.channel.bytes.available_permits(),
            free_at_capacity + size
        );
        assert!(futures_util::poll!(&mut live).is_pending());

        let next_token = CancellationToken::new();
        let mut next = Box::pin(child.decide(json!({"input":"replacement"}), &next_token));
        assert!(futures_util::poll!(&mut next).is_pending());
        let wire = root.next_wire().await.unwrap();
        let notice: Value = serde_json::from_str(&wire).unwrap();
        let nonce = notice["nonce"].as_u64().unwrap();
        assert_ne!(nonce, released);
        assert_eq!(
            notice["request"],
            json!({"thread_id":"leaf","incarnation":child.incarnation,"input":"replacement"})
        );
        assert!(root.handoff(nonce));
        assert!(!root.resolve(released, r#"{"action":"deny"}"#));
        assert!(root.release(nonce));
        assert!(root.resolve(nonce, r#"{"action":"continue"}"#));
        assert!(matches!(next.await, Ok(Decision::Continue)));
        assert_eq!(
            root.channel.bytes.available_permits(),
            free_at_capacity + size
        );
        assert!(root.resolve(
            live_nonce,
            r#"{"action":"replace","value":"only-survivor"}"#
        ));
        assert!(matches!(
            live.await,
            Ok(Decision::Replace { value }) if value == json!("only-survivor")
        ));
        assert!(root.release(live_nonce));
        for (nonce, _) in retained {
            assert!(root.release(nonce));
        }
        assert_eq!(root.channel.bytes.available_permits(), initial_bytes);
        assert!(root.channel.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn budget_retires_reply_but_holds_handed_payload_until_physical_release() {
        const BUDGET: usize = 256;
        let root = Arc::new(Control::with_budget("root".into(), true, BUDGET));
        root.enable(3.0, Scope::ThreadTree).unwrap();
        let child = Arc::new(Control::descendant("leaf".into(), &root));
        let first = {
            let child = child.clone();
            tokio::spawn(async move {
                child
                    .decide(json!({"input":"one"}), &CancellationToken::new())
                    .await
            })
        };
        let wire = root.next_wire().await.unwrap();
        // Full request, including receipt and origin metadata, rather than
        // just the length of the payload. No dynamic production constants.
        assert_eq!(
            serde_json::from_str::<Value>(&wire).unwrap(),
            json!({
                "nonce": 1,
                "request": {
                    "thread_id": "leaf",
                    "incarnation": child.incarnation,
                    "input": "one",
                }
            })
        );
        assert_eq!(root.channel.bytes.available_permits(), BUDGET - wire.len());
        let second = {
            let root = root.clone();
            tokio::spawn(async move {
                root.decide(json!({"input":"two"}), &CancellationToken::new())
                    .await
            })
        };
        let other = root.next_wire().await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&other).unwrap(),
            json!({
                "nonce": 2,
                "request": {
                    "thread_id": "root",
                    "incarnation": root.incarnation,
                    "input": "two",
                }
            })
        );
        let free_with_both = BUDGET - wire.len() - other.len();
        assert_eq!(root.channel.bytes.available_permits(), free_with_both);
        // A reply and native return alone must not free callback data.
        assert!(root.resolve(1, r#"{"action":"continue"}"#));
        assert!(matches!(first.await.unwrap(), Ok(Decision::Continue)));
        assert_eq!(root.channel.bytes.available_permits(), free_with_both);
        assert!(!root.resolve(1, r#"{"action":"continue"}"#));
        assert!(
            root.decide(
                json!({"input":"ordinary third notice"}),
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        assert!(root.release(1));
        assert!(!root.release(1));
        assert_eq!(root.channel.bytes.available_permits(), BUDGET - other.len());
        // Physical return may win before dispatch resolves. Keep charged and
        // reply-capable until the last owner drops its reference.
        assert!(root.release(2));
        assert_eq!(root.channel.bytes.available_permits(), BUDGET - other.len());
        assert!(root.resolve(2, r#"{"action":"continue"}"#));
        assert!(matches!(second.await.unwrap(), Ok(Decision::Continue)));
        assert_eq!(root.channel.bytes.available_permits(), BUDGET);
    }

    #[tokio::test]
    async fn budget_queued_abort_releases_payload() {
        let root = Arc::new(Control::with_budget("root".into(), true, 256));
        root.enable(3.0, Scope::Root).unwrap();
        // Admission and queue publication are synchronous through the first
        // pending poll; abort before any receiver claims the body.
        let token = CancellationToken::new();
        let mut queued = Box::pin(root.decide(json!({"input":"queued"}), &token));
        assert!(futures_util::poll!(&mut queued).is_pending());
        assert!(root.channel.bytes.available_permits() < 256);
        drop(queued);
        assert_eq!(root.channel.bytes.available_permits(), 256);
        // A stale queue nonce must not deliver the retired body.
        assert_eq!(root.next_wire().await.unwrap(), r#"{"cancel":1}"#);
    }

    #[tokio::test]
    async fn budget_retained_effective_input_merges_and_failed_growth_releases_it() {
        let control = Arc::new(Control::with_budget("root".into(), true, 96));
        control.enable(3.0, Scope::Root).unwrap();
        let input = json!({"quoted":"a\\b\n\"c"});
        let bytes = control.account(&input, None).unwrap();
        assert!(control.channel.bytes.available_permits() < 96);
        let result = control.decide_retained(
            json!({"input":input,"result":"projected result does not fit the tiny fixture budget"}),
            &CancellationToken::new(),
            Some(bytes),
            None,
        ).await;
        assert!(result.is_err());
        assert_eq!(control.channel.bytes.available_permits(), 96);
        assert!(control.channel.state.lock().unwrap().pending.is_empty());
        // Error doesn't poison the owner or make the next small notice free.
        let small = {
            let control = control.clone();
            tokio::spawn(async move { control.decide(json!({}), &CancellationToken::new()).await })
        };
        let wire = control.next_wire().await.unwrap();
        let nonce = serde_json::from_str::<Value>(&wire).unwrap()["nonce"]
            .as_u64()
            .unwrap();
        assert_eq!(control.channel.bytes.available_permits(), 96 - wire.len());
        assert!(control.resolve(nonce, r#"{"action":"continue"}"#));
        assert!(matches!(small.await.unwrap(), Ok(Decision::Continue)));
        assert!(control.release(nonce));
        assert_eq!(control.channel.bytes.available_permits(), 96);
    }

    #[tokio::test]
    async fn shared_mcp_borrowed_concrete_result_exceeding_budget_is_never_queued() {
        let root = Arc::new(Control::with_budget("root".into(), true, 384));
        root.enable(3.0, Scope::ThreadTree).unwrap();
        let result = codex_protocol::mcp::CallToolResult {
            content: vec![json!({"type":"text", "text":"large".repeat(1024)})],
            structured_content: Some(json!({"receipt":"original"})),
            is_error: Some(false),
            meta: Some(json!({"fixture":"shared"})),
        };
        let arguments = json!({"query":"escaped\n\t\"and backslash\\"});
        let tracing = codex_otel::sdk_trace::ContextLease::capture();
        let request = Request {
            tracing_context: tracing.as_ref().map(|context| context.token()),
            phase: "after",
            route: "mcp",
            boundary: "executor_return",
            turn_id: "turn",
            model: None,
            call_id: Some("first"),
            outer_call_id: None,
            cell_id: None,
            runtime_tool_call_id: None,
            tool_name: Name {
                namespace: Some("mcp__fixture"),
                name: "lookup",
            },
            tool_kind: "function_json",
            input: Input::JsonText(&arguments),
            result: &result,
        };
        assert!(
            root.decide(request, &CancellationToken::new())
                .await
                .is_err()
        );
        assert_eq!(root.channel.bytes.available_permits(), 384);
        assert!(root.channel.state.lock().unwrap().pending.is_empty());
        assert!(root.channel.receiver.lock().await.try_recv().is_err());
        // The failing bridge never takes or rewrites the concrete native result.
        assert_eq!(result.content[0]["text"].as_str().unwrap().len(), 5120);
        assert_eq!(
            result.structured_content,
            Some(json!({"receipt":"original"}))
        );
    }

    #[tokio::test]
    async fn shared_mcp_remaining_budget_is_retained_until_physical_callback_returns() {
        let root = Arc::new(Control::with_budget("root".into(), true, 600));
        root.enable(3.0, Scope::ThreadTree).unwrap();
        let child = Arc::new(Control::descendant("child".into(), &root));
        let result = codex_protocol::mcp::CallToolResult {
            content: vec![json!({"type":"text", "text":"borrowed normal MCP response"})],
            structured_content: Some(json!({"receipt":"original"})),
            is_error: Some(false),
            meta: Some(json!({"marker":"ordinary\nmetadata"})),
        };
        let arguments = json!({"query":"a\nb\"c\\tail"});
        let tracing = codex_otel::sdk_trace::ContextLease::capture();
        let request = Request {
            tracing_context: tracing.as_ref().map(|context| context.token()),
            phase: "after",
            route: "mcp",
            boundary: "executor_return",
            turn_id: "turn",
            model: None,
            call_id: Some("mcp-call"),
            outer_call_id: None,
            cell_id: None,
            runtime_tool_call_id: None,
            tool_name: Name {
                namespace: Some("mcp__fixture"),
                name: "lookup",
            },
            tool_kind: "function_json",
            input: Input::JsonText(&arguments),
            result: &result,
        };
        let token = CancellationToken::new();
        let mut live = Box::pin(child.decide(&request, &token));
        assert!(futures_util::poll!(&mut live).is_pending());
        let wire = root.next_wire().await.unwrap();
        let value: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(value["request"]["thread_id"], "child");
        assert_eq!(value["request"]["input"], arguments.to_string());
        assert_eq!(
            value["request"]["result"],
            serde_json::to_value(&result).unwrap()
        );
        assert_eq!(root.channel.bytes.available_permits(), 600 - wire.len());
        assert!(root.handoff(1));
        // Fits by itself; does not fit what remains of the shared channel.
        let remaining = root.channel.bytes.available_permits();
        assert!(remaining < wire.len());
        assert!(
            root.decide(&request, &CancellationToken::new())
                .await
                .is_err()
        );
        assert_eq!(root.channel.state.lock().unwrap().pending.len(), 1);
        assert!(root.channel.receiver.lock().await.try_recv().is_err());
        token.cancel();
        assert!(live.await.is_err());
        assert_eq!(root.channel.bytes.available_permits(), remaining);
        assert!(!root.resolve(1, r#"{"action":"continue"}"#));
        assert!(root.release(1));
        assert_eq!(root.channel.bytes.available_permits(), 600);
        let next_token = CancellationToken::new();
        let mut next = Box::pin(root.decide(&request, &next_token));
        assert!(futures_util::poll!(&mut next).is_pending());
        assert_eq!(root.next_wire().await.unwrap(), r#"{"cancel":1}"#);
        let recovered = root.next_wire().await.unwrap();
        let recovered: Value = serde_json::from_str(&recovered).unwrap();
        let nonce = recovered["nonce"].as_u64().unwrap();
        assert!(root.resolve(nonce, r#"{"action":"continue"}"#));
        assert!(matches!(next.await, Ok(Decision::Continue)));
        assert!(root.release(nonce));
        assert_eq!(root.channel.bytes.available_permits(), 600);
    }

    #[tokio::test]
    async fn finished_reader_releases_unclaimed_but_not_physical_callback() {
        let control = Arc::new(Control::with_budget("root".into(), true, 256));
        control.enable(3.0, Scope::Root).unwrap();
        let token = CancellationToken::new();
        let mut active = Box::pin(control.decide(json!({"input":"callback"}), &token));
        assert!(futures_util::poll!(&mut active).is_pending());
        let wire = control.next_wire().await.unwrap();
        assert!(control.handoff(1));
        assert!(!control.handoff(1));
        let mut lost = Box::pin(control.decide(json!({"input":"reader lost"}), &token));
        assert!(futures_util::poll!(&mut lost).is_pending());
        control.next_wire().await.unwrap();
        control.revoke();
        assert!(active.await.is_err());
        assert!(lost.await.is_err());
        control.reader_finished();
        assert_eq!(control.channel.bytes.available_permits(), 256 - wire.len());
        assert!(!control.release(2));
        assert!(control.release(1));
        assert_eq!(control.channel.bytes.available_permits(), 256);
        assert!(!control.release(1));
    }

    struct CapturingSession {
        delegates: mpsc::UnboundedSender<Arc<dyn CodeModeSessionDelegate>>,
    }
    impl CodeModeSession for CapturingSession {
        fn execute<'a>(
            &'a self,
            _: ExecuteRequest,
            delegate: Arc<dyn CodeModeSessionDelegate>,
            _: Option<CancellationToken>,
        ) -> CodeModeSessionResultFuture<'a, StartedCell> {
            Box::pin(async move {
                self.delegates.send(delegate).unwrap();
                let cell_id = CellId::new("cell".into());
                let result_id = cell_id.clone();
                Ok(StartedCell::from_future(cell_id, async move {
                    Ok(RuntimeResponse::Result {
                        cell_id: result_id,
                        content_items: Vec::new(),
                        error_text: None,
                        code_mode_host_duration: None,
                    })
                }))
            })
        }
        fn wait<'a>(
            &'a self,
            _: WaitRequest,
            _: Option<CancellationToken>,
        ) -> CodeModeSessionResultFuture<'a, WaitOutcome> {
            Box::pin(async { Err("unused".into()) })
        }
        fn terminate<'a>(&'a self, _: CellId) -> CodeModeSessionResultFuture<'a, WaitOutcome> {
            Box::pin(async { Err("unused".into()) })
        }
        fn shutdown<'a>(&'a self) -> CodeModeSessionResultFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    fn exec_request() -> ExecuteRequest {
        ExecuteRequest {
            tool_call_id: "same-model-id".into(),
            enabled_tools: Vec::new(),
            source: "text(1)".into(),
            yield_time_ms: None,
            max_output_tokens: None,
        }
    }

    // This drives the actual SDK lifecycle receipt contributors with the
    // native ownership index held here. It does not claim a public Core race:
    // its purpose is reservation-before-poll and exact-incarnation admission.
    #[tokio::test]
    async fn graph_stop_reserves_members_and_fences_birth_before_settlement_poll() {
        use crate::graph_stop::{self, Request as GraphRequest};
        use crate::turn_settlement::{Contributor as TurnContributor, Settlement, Turn};
        use codex_protocol::items::{TurnItem, UserMessageItem};
        use codex_protocol::user_input::UserInput;

        for scope in [graph_stop::Scope::Root, graph_stop::Scope::Tree] {
            let boundary = Boundary::new(
                Arc::new(crate::storage::MemoryAgentGraph::default()),
                Arc::new(RwLock::new(None)),
            );
            let root_store = ExtensionData::new("root");
            let root = root_store.get_or_init(|| Control::new("root".into(), true));
            root.managed_response.set(true).unwrap();
            let child_store = ExtensionData::new("child");
            let child = child_store.get_or_init(|| Control::descendant("child".into(), &root));
            child.managed_response.set(true).unwrap();
            let unrelated_store = ExtensionData::new("other");
            let unrelated = unrelated_store.get_or_init(|| Control::new("other".into(), true));
            unrelated.managed_response.set(true).unwrap();
            for (store, owner) in [
                (&root_store, &root),
                (&child_store, &child),
                (&unrelated_store, &unrelated),
            ] {
                let settlement = store.get_or_init(Settlement::default);
                owner.settlement.set(Arc::downgrade(&settlement)).unwrap();
                boundary
                    .threads
                    .lock()
                    .unwrap()
                    .insert(owner.id.clone(), Arc::downgrade(owner));
            }
            let session = ExtensionData::new("session");
            let root_turn_store = ExtensionData::new("same");
            let child_turn_store = ExtensionData::new("same");
            let unrelated_turn_store = ExtensionData::new("same");
            let mode = serde_json::from_value(json!({
                "mode":"default",
                "settings":{"model":"gpt-5.1-codex","reasoning_effort":null,"developer_instructions":null}
            })).unwrap();
            for (store, turn_store) in [
                (&root_store, &root_turn_store),
                (&child_store, &child_turn_store),
                (&unrelated_store, &unrelated_turn_store),
            ] {
                TurnContributor
                    .on_turn_start(TurnStartInput {
                        turn_id: "same",
                        collaboration_mode: &mode,
                        token_usage_at_turn_start: None,
                        session_store: &session,
                        thread_store: store,
                        turn_store,
                    })
                    .await;
            }
            let first = root_turn_store.get::<Turn>().unwrap();
            let previous_child = child_turn_store.get::<Turn>().unwrap();
            let other = unrelated_turn_store.get::<Turn>().unwrap();
            assert!(!first.graceful_ready(false));
            // begin is sync; do not poll a graph settlement future before any
            // assertions, native receipts, or the next native birth.
            let stop = GraphRequest::begin(&boundary, root.clone(), scope, false).unwrap();
            assert!(graph_stop::check_input(&root, false).is_err());
            assert_eq!(
                graph_stop::check_input(&root, true).is_ok(),
                scope == graph_stop::Scope::Root
            );
            assert!(graph_stop::check_input(&unrelated, false).is_ok());

            let item = TurnItem::UserMessage(UserMessageItem::new(&[UserInput::Text {
                text: "accepted and actually recorded".into(),
                text_elements: vec![],
            }]));
            for (store, turn_store) in [
                (&root_store, &root_turn_store),
                (&child_store, &child_turn_store),
                (&unrelated_store, &unrelated_turn_store),
            ] {
                TurnContributor
                    .on_item_completed(store, turn_store, &item)
                    .await;
            }
            assert!(first.graceful_ready(false));
            assert_eq!(
                previous_child.graceful_ready(false),
                scope == graph_stop::Scope::Tree
            );
            assert!(!other.graceful_ready(false));

            let late_store = ExtensionData::new("same");
            TurnContributor
                .on_turn_start(TurnStartInput {
                    turn_id: "same",
                    collaboration_mode: &mode,
                    token_usage_at_turn_start: None,
                    session_store: &session,
                    thread_store: &child_store,
                    turn_store: &late_store,
                })
                .await;
            let late = late_store.get::<Turn>().unwrap();
            assert!(!Arc::ptr_eq(&previous_child, &late));
            assert_eq!(late.born_fenced(), scope == graph_stop::Scope::Tree);
            late.request_graceful();
            // A late old ItemCompleted must not credit a replacement with
            // identical public turn ID. Only its own native receipt can.
            TurnContributor
                .on_item_completed(&child_store, &child_turn_store, &item)
                .await;
            assert!(!late.graceful_ready(false));
            TurnContributor
                .on_item_completed(&child_store, &late_store, &item)
                .await;
            assert!(late.graceful_ready(false));
            assert!(graph_stop::check_input(&unrelated, false).is_ok());
            // Abandoning a reservation without its owned settle must fail
            // closed on just this graph, not silently permit a new start.
            drop(stop);
            assert!(graph_stop::check_input(&root, false).is_err());
            assert!(graph_stop::check_input(&unrelated, false).is_ok());
        }
    }

    // The provider owns these acknowledgments. A stop has to wait for them,
    // even when Core cancelled its execute before receiving the host CellId.
    enum CellProbe {
        Start(
            Arc<dyn CodeModeSessionDelegate>,
            oneshot::Sender<Result<StartedCell, String>>,
        ),
        Wait(CellId, oneshot::Sender<Result<WaitOutcome, String>>),
        Terminate(CellId, oneshot::Sender<Result<WaitOutcome, String>>),
    }

    struct ProbedSession(mpsc::UnboundedSender<CellProbe>);
    impl CodeModeSession for ProbedSession {
        fn execute<'a>(
            &'a self,
            _: ExecuteRequest,
            delegate: Arc<dyn CodeModeSessionDelegate>,
            _: Option<CancellationToken>,
        ) -> CodeModeSessionResultFuture<'a, StartedCell> {
            Box::pin(async move {
                let (tx, rx) = oneshot::channel();
                self.0
                    .send(CellProbe::Start(delegate, tx))
                    .map_err(|_| "probe closed")?;
                rx.await.map_err(|_| "start response closed".to_owned())?
            })
        }
        fn wait<'a>(
            &'a self,
            request: WaitRequest,
            _: Option<CancellationToken>,
        ) -> CodeModeSessionResultFuture<'a, WaitOutcome> {
            Box::pin(async move {
                let (tx, rx) = oneshot::channel();
                self.0
                    .send(CellProbe::Wait(request.cell_id, tx))
                    .map_err(|_| "probe closed")?;
                rx.await.map_err(|_| "wait response closed".to_owned())?
            })
        }
        fn terminate<'a>(&'a self, id: CellId) -> CodeModeSessionResultFuture<'a, WaitOutcome> {
            Box::pin(async move {
                let (tx, rx) = oneshot::channel();
                self.0
                    .send(CellProbe::Terminate(id, tx))
                    .map_err(|_| "probe closed")?;
                rx.await
                    .map_err(|_| "termination response closed".to_owned())?
            })
        }
        fn shutdown<'a>(&'a self) -> CodeModeSessionResultFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn confirmed_child_cancel_failure_retains_original_session_for_cell_retry() {
        let home = tempfile::tempdir().unwrap();
        let config = json!({
            "model": "gpt-5.1-codex", "model_provider": "cleanup_probe",
            "model_providers.cleanup_probe": {
                "name": "Child cleanup probe", "base_url": "http://127.0.0.1:9/v1",
                "wire_api": "responses", "requires_openai_auth": false,
                "supports_websockets": false
            },
            "approval_policy": "never", "sandbox_mode": "read-only",
            "web_search": "disabled", "features.code_mode": false,
            "features.shell_snapshot": false
        });
        let runtime = json!({"codex_home": home.path(), "cwd": home.path()});
        // The manager is only the existing finish API's context. No model, shell,
        // MCP server or Core task is started by this controlled cell-owner test.
        let engine =
            crate::engine::EngineState::new(config.to_string(), runtime.to_string(), false, None)
                .await
                .unwrap();
        let (session, mut calls) = probed_session();
        let weak_session = Arc::downgrade(&session);
        let child = Arc::new(Control::new("child".into(), false));
        let original = direct_request(child.clone(), "turn");
        *child.direct_turn.lock().unwrap() = Some(original.owner.clone());
        let caller = start_managed_cell(session.clone(), child.clone());
        let CellProbe::Start(_, ready) = calls.recv().await.unwrap() else {
            panic!("expected real owned cell start");
        };
        ready
            .send(Ok(yielded_start("original-child-cell")))
            .unwrap_or_else(|_| panic!("start owner lost"));
        let started = caller.await.unwrap().unwrap();
        assert!(matches!(
            started.initial_response().await.unwrap(),
            RuntimeResponse::Yielded { .. }
        ));
        let captured = child.capture_turn_stop("turn").expect("original receipt");
        let identity = Arc::as_ptr(&captured);
        let mut retained = Some(captured);
        // Terminal delivery clears the current pointer. The wrapper and ambient
        // session references are gone; only the child receipt may keep it alive.
        child.direct_turn.lock().unwrap().take();
        drop(original);
        drop(session);
        let mut first = Box::pin(crate::subagents::finish_confirmed_child_cancel(
            &mut retained,
            &engine.manager,
        ));
        assert!(futures_util::poll!(&mut first).is_pending());
        let CellProbe::Terminate(id, reply) = calls.recv().await.unwrap() else {
            panic!("expected exact original cell termination");
        };
        assert_eq!(id.as_str(), "original-child-cell");
        reply
            .send(Err("private-native-termination-error".into()))
            .unwrap();
        assert_eq!(first.await, None);
        assert!(
            weak_session.upgrade().is_some(),
            "failed finish must retain the strong session owner"
        );
        assert_eq!(Arc::as_ptr(retained.as_ref().unwrap()), identity);
        // A successor must not become the retry owner or be stopped by that retry.
        let successor = direct_request(child.clone(), "successor");
        *child.direct_turn.lock().unwrap() = Some(successor.owner.clone());
        assert!(!successor.owner.policy_stopped.load(Ordering::Acquire));
        let mut retry = Box::pin(crate::subagents::finish_confirmed_child_cancel(
            &mut retained,
            &engine.manager,
        ));
        assert!(futures_util::poll!(&mut retry).is_pending());
        let CellProbe::Terminate(id, reply) = calls.recv().await.unwrap() else {
            panic!("retry lost the retained original cell");
        };
        assert_eq!(id.as_str(), "original-child-cell");
        reply.send(Ok(terminated(id))).unwrap();
        // The established delegate fixture carries an unregistered Core task.
        // A successful cell ACK alone MUST NOT claim a physical Core join.
        assert_eq!(retry.await, None);
        assert_eq!(Arc::as_ptr(retained.as_ref().unwrap()), identity);
        assert!(
            weak_session
                .upgrade()
                .unwrap()
                .cells
                .lock()
                .unwrap()
                .is_empty()
        );
        assert!(!successor.owner.policy_stopped.load(Ordering::Acquire));
        assert!(calls.try_recv().is_err());
        let mut absent = None;
        assert_eq!(
            crate::subagents::finish_confirmed_child_cancel(&mut absent, &engine.manager).await,
            None
        );
        // The only cell is joined and this fixture has no physical Core task.
        // Drop its intentionally failed test receipt during fixture teardown.
        drop(retained);
        assert!(weak_session.upgrade().is_none());
        engine.close().await.unwrap();
    }

    fn probed_session() -> (Arc<Session>, mpsc::UnboundedReceiver<CellProbe>) {
        let boundary = Arc::new(Boundary::new(
            Arc::new(crate::storage::MemoryAgentGraph::default()),
            Arc::new(RwLock::new(None)),
        ));
        let (tx, rx) = mpsc::unbounded_channel();
        (Session::new(Arc::new(ProbedSession(tx)), boundary), rx)
    }

    fn terminated(id: CellId) -> WaitOutcome {
        WaitOutcome::LiveCell(RuntimeResponse::Terminated {
            cell_id: id,
            content_items: Vec::new(),
            code_mode_host_duration: None,
        })
    }

    fn yielded_start(id: &str) -> StartedCell {
        let id = CellId::new(id.to_owned());
        let response = RuntimeResponse::Yielded {
            cell_id: id.clone(),
            content_items: Vec::new(),
            code_mode_host_duration: None,
        };
        StartedCell::from_future(id, async { Ok(response) })
    }

    fn start_managed_cell(
        session: Arc<Session>,
        control: Arc<Control>,
    ) -> tokio::task::JoinHandle<Result<StartedCell, String>> {
        // The real thread contributor inherits this bit from managed ThreadInstructions.
        let _ = control.managed_response.set(true);
        tokio::spawn(async move {
            session.boundary.start_exec(
                control,
                "turn",
                "same-model-id",
                codex_code_mode::PUBLIC_TOOL_NAME,
            );
            session
                .execute(exec_request(), Arc::new(Actual(AtomicUsize::new(0))), None)
                .await
        })
    }

    #[tokio::test]
    async fn code_mode_owned_start_captures_issuing_task_before_poll_or_drop() {
        for drop_before_poll in [true, false] {
            let (session, mut calls) = probed_session();
            let root = Arc::new(Control::new("root".into(), true));
            let _ = root.managed_response.set(true);
            let future = tokio::spawn({
                let session = session.clone();
                let root = root.clone();
                async move {
                    session.boundary.start_exec(
                        root,
                        "turn",
                        "same-model-id",
                        codex_code_mode::PUBLIC_TOOL_NAME,
                    );
                    let future = session.clone().execute_owned(
                        exec_request(),
                        Arc::new(Actual(AtomicUsize::new(0))),
                        None,
                    );
                    assert!(session.boundary.starts.lock().unwrap().is_empty());
                    future
                }
            })
            .await
            .unwrap();
            assert!(
                calls.try_recv().is_err(),
                "unpolled startup must not call the host"
            );
            assert!(!root.has_unsettled_code_cells());
            if drop_before_poll {
                drop(future);
                assert!(calls.try_recv().is_err());
                assert!(!root.has_unsettled_code_cells());
                continue;
            }
            let caller = tokio::spawn(future);
            let CellProbe::Start(_, ready) = calls.recv().await.unwrap() else {
                panic!("execute")
            };
            ready
                .send(Ok(yielded_start("owned-cell")))
                .unwrap_or_else(|_| panic!("start caller closed"));
            let started = caller.await.unwrap().unwrap();
            assert!(matches!(
                started.initial_response().await.unwrap(),
                RuntimeResponse::Yielded { .. }
            ));
            assert!(
                root.has_unsettled_code_cells(),
                "moved startup must retain its issuing owner"
            );
        }
    }

    #[tokio::test]
    async fn code_mode_scoped_stop_joins_start_cancelled_before_id_and_early_close() {
        let (session, mut calls) = probed_session();
        let root = Arc::new(Control::new("root".into(), true));
        let caller = start_managed_cell(session.clone(), root.clone());
        let CellProbe::Start(delegate, start_reply) = calls.recv().await.unwrap() else {
            panic!("execute")
        };
        caller.abort();
        assert!(matches!(caller.await, Err(error) if error.is_cancelled()));

        let mut first = Box::pin(root.interrupt_code_mode_cells());
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(
            calls.try_recv().is_err(),
            "no cell ID exists to terminate yet"
        );
        start_reply
            .send(Ok(yielded_start("root-cell")))
            .unwrap_or_else(|_| panic!("start owner was lost"));
        assert!(futures_util::poll!(&mut first).is_pending());
        let CellProbe::Terminate(id, reply) = calls.try_recv().unwrap() else {
            panic!("terminate")
        };
        assert_eq!(id.as_str(), "root-cell");

        // Closure can precede the termination ACK. A second force must join it,
        // even though the current live flag is already false.
        delegate.cell_closed(&id);
        let mut second = Box::pin(root.interrupt_code_mode_cells());
        assert!(futures_util::poll!(&mut second).is_pending());
        reply.send(Ok(terminated(id))).unwrap();
        first.await.unwrap();
        second.await.unwrap();
        assert!(calls.try_recv().is_err());
    }

    #[tokio::test]
    async fn code_mode_scoped_stop_keeps_other_control_cells_and_saved_core_result() {
        let (session, mut calls) = probed_session();
        let root = Arc::new(Control::new("root".into(), true));
        let child = Arc::new(Control::descendant("child".into(), &root));
        for (control, id) in [(root.clone(), "root-cell"), (child.clone(), "child-cell")] {
            let caller = start_managed_cell(session.clone(), control);
            let CellProbe::Start(_, ready) = calls.recv().await.unwrap() else {
                panic!("execute")
            };
            ready
                .send(Ok(yielded_start(id)))
                .unwrap_or_else(|_| panic!("start caller closed"));
            let started = caller.await.unwrap().unwrap();
            assert!(matches!(
                started.initial_response().await.unwrap(),
                RuntimeResponse::Yielded { .. }
            ));
        }

        assert!(root.has_unsettled_code_cells());
        assert!(child.has_unsettled_code_cells());

        // Emulate Core's abort cleanup: no tool wait handoff, and it discards
        // the returned value. It must remain available to a later real wait.
        let id = CellId::new("root-cell".into());
        let mut core_stop = Box::pin(session.terminate(id.clone()));
        assert!(futures_util::poll!(&mut core_stop).is_pending());
        let CellProbe::Terminate(actual, reply) = calls.try_recv().unwrap() else {
            panic!("terminate")
        };
        assert_eq!(actual, id);
        let completed = RuntimeResponse::Result {
            cell_id: id.clone(),
            content_items: Vec::new(),
            error_text: Some("original completed result".into()),
            code_mode_host_duration: None,
        };
        reply
            .send(Ok(WaitOutcome::LiveCell(completed.clone())))
            .unwrap();
        assert!(matches!(
            core_stop.await.unwrap(),
            WaitOutcome::LiveCell(RuntimeResponse::Result { .. })
        ));
        assert!(
            root.has_unsettled_code_cells(),
            "saved unread result must refuse fork"
        );
        root.interrupt_code_mode_cells().await.unwrap();
        assert!(
            calls.try_recv().is_err(),
            "root sweep must spare child and saved result"
        );
        // Originally unconfigured cells must not enroll in a controller later.
        root.enable(3.0, Scope::Root).unwrap();
        let waiter = tokio::spawn({
            let session = session.clone();
            let root = root.clone();
            let id = id.clone();
            async move {
                session.boundary.start_exec(
                    root,
                    "next",
                    "wait-one",
                    codex_code_mode::WAIT_TOOL_NAME,
                );
                session
                    .wait(
                        WaitRequest {
                            cell_id: id,
                            yield_time_ms: 1,
                        },
                        None,
                    )
                    .await
            }
        });
        assert_eq!(
            RuntimeResponse::from(waiter.await.unwrap().unwrap()),
            completed
        );
        assert!(
            !root.has_unsettled_code_cells(),
            "consuming the result settles the root"
        );
        assert!(
            child.has_unsettled_code_cells(),
            "root capture must leave child cells alone"
        );
        assert!(
            calls.try_recv().is_err(),
            "saved response already came from Core"
        );
        // A second wait reaches the real provider; the saved result was consumed.
        let mut again = Box::pin(session.wait(
            WaitRequest {
                cell_id: id.clone(),
                yield_time_ms: 1,
            },
            None,
        ));
        assert!(futures_util::poll!(&mut again).is_pending());
        let CellProbe::Wait(actual, reply) = calls.try_recv().unwrap() else {
            panic!("wait")
        };
        assert_eq!(actual, id);
        reply
            .send(Ok(WaitOutcome::MissingCell(RuntimeResponse::from(
                terminated(id),
            ))))
            .unwrap();
        assert!(matches!(again.await.unwrap(), WaitOutcome::MissingCell(_)));

        let mut child_stop = Box::pin(child.interrupt_code_mode_cells());
        assert!(futures_util::poll!(&mut child_stop).is_pending());
        let CellProbe::Terminate(actual, reply) = calls.try_recv().unwrap() else {
            panic!("child terminate")
        };
        assert_eq!(actual.as_str(), "child-cell");
        reply.send(Ok(terminated(actual))).unwrap();
        child_stop.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_task_handoff_mixed_child_and_root_same_call_no_cross_owner_or_lock() {
        let boundary = Arc::new(Boundary::new(
            Arc::new(crate::storage::MemoryAgentGraph::default()),
            Arc::new(RwLock::new(None)),
        ));
        let root = Arc::new(Control::new("root".into(), true));
        root.enable(3.0, Scope::Root).unwrap();
        let child = Arc::new(Control::descendant("child".into(), &root));
        // Both starts must be held concurrently. Serializing owners deadlocks
        // this barrier. Each real native dispatch task retains its own Id.
        let ready = Arc::new(tokio::sync::Barrier::new(3));
        let actual = Arc::new(Actual(AtomicUsize::new(0)));
        let original: Arc<dyn CodeModeSessionDelegate> = actual.clone();
        let run = |control: Arc<Control>| {
            let boundary = boundary.clone();
            let ready = ready.clone();
            let original = original.clone();
            tokio::spawn(async move {
                let (tx, mut rx) = mpsc::unbounded_channel();
                let session = Session::new(
                    Arc::new(CapturingSession { delegates: tx }),
                    boundary.clone(),
                );
                boundary.start_exec(
                    control.clone(),
                    "same-turn",
                    "same-model-id",
                    codex_code_mode::PUBLIC_TOOL_NAME,
                );
                ready.wait().await;
                session
                    .execute(exec_request(), original.clone(), None)
                    .await
                    .unwrap();
                let forwarded = rx.recv().await.unwrap();
                (control, Arc::ptr_eq(&original, &forwarded), forwarded)
            })
        };
        let parent_task = run(root);
        let child_task = run(child);
        tokio::time::timeout(Duration::from_secs(3), ready.wait())
            .await
            .unwrap();
        let (parent, child) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(parent_task, child_task)
        })
        .await
        .unwrap();
        let (root, parent_unchanged, retained) = parent.unwrap();
        let (child, _child_unchanged, forwarded) = child.unwrap();
        assert_eq!(root.id, "root");
        assert!(!parent_unchanged);
        assert_eq!(child.id, "child");
        // Native ownership may wrap an opted-out child; the invocation below proves bypass.

        assert!(boundary.starts.lock().unwrap().is_empty());

        // The dispatch task is gone and native finish may have run. Only the
        // retained delegate owns this cell; it cannot adopt the next turn.
        boundary.finish_exec("root", "same-turn", "same-model-id");
        let invocation = CodeModeNestedToolCall {
            cell_id: CellId::new("retained".into()),
            runtime_tool_call_id: "rpc".into(),
            tool_name: ToolName::plain("update_plan"),
            tool_kind: CodeModeToolKind::Function,
            input: Some(json!({"plan":"effective"})),
        };
        let owner = async {
            let before = root.next().await.unwrap();
            assert_eq!(before["request"]["thread_id"], "root");
            assert_eq!(before["request"]["turn_id"], "same-turn");
            assert_eq!(before["request"]["outer_call_id"], "same-model-id");
            assert!(root.resolve(before["nonce"].as_u64().unwrap(), r#"{"action":"deny"}"#));
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(
                retained.invoke_tool(invocation.clone(), CancellationToken::new()),
                owner
            )
        })
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(actual.0.load(Ordering::SeqCst), 0);
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(3),
                forwarded.invoke_tool(invocation, CancellationToken::new()),
            )
            .await
            .unwrap()
            .unwrap(),
            json!({"from_actual":true})
        );
        assert_eq!(actual.0.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn tree_channel_nonces_stops_and_isolates_explicit_roots() {
        let root = Arc::new(Control::new("root".into(), true));
        // Ancestry may be registered before enable; never copy a timeout.
        let child = Arc::new(Control::descendant("a".into(), &root));
        let sibling = Arc::new(Control::descendant("b".into(), &root));
        let leaf = Arc::new(Control::descendant("leaf".into(), &child));
        let unrelated = Arc::new(Control::new("unrelated".into(), true));
        assert!(!child.configured());
        root.enable(3.0, Scope::ThreadTree).unwrap();
        unrelated.enable(3.0, Scope::Root).unwrap();
        assert!(leaf.configured());
        assert!(child.enable(3.0, Scope::ThreadTree).is_err());
        let run = |control: Arc<Control>| {
            tokio::spawn(async move {
                control
                    .decide(json!({"call_id":"collision"}), &CancellationToken::new())
                    .await
            })
        };
        let a = run(child.clone());
        let b = run(sibling);
        let g = run(leaf);
        let other = run(unrelated.clone());
        let mut notices = HashMap::new();
        for _ in 0..3 {
            let notice = root.next().await.unwrap();
            notices.insert(
                notice["request"]["thread_id"].as_str().unwrap().to_owned(),
                notice["nonce"].as_u64().unwrap(),
            );
        }
        assert_eq!(notices.len(), 3);
        let unique: std::collections::HashSet<_> = notices.values().collect();
        assert_eq!(unique.len(), 3);
        let isolated = unrelated.next().await.unwrap()["nonce"].as_u64().unwrap();
        assert_eq!(isolated, 1);
        child.revoke();
        // Must reject immediately, even before decide is scheduled to cancel.
        assert!(!root.resolve(notices["a"], r#"{"action":"continue"}"#));
        assert!(a.await.unwrap().is_err());
        assert!(root.resolve(notices["b"], r#"{"action":"continue"}"#));
        assert!(matches!(b.await.unwrap(), Ok(Decision::Continue)));
        root.revoke();
        assert!(!root.resolve(notices["leaf"], r#"{"action":"continue"}"#));
        assert!(g.await.unwrap().is_err());
        assert!(unrelated.resolve(isolated, r#"{"action":"continue"}"#));
        assert!(matches!(other.await.unwrap(), Ok(Decision::Continue)));
    }

    #[tokio::test]
    async fn delivered_child_decision_cannot_outlive_root_revoke() {
        // Poll by hand: resolving must NOT allow the child future to consume
        // its ready oneshot until the owning root has already been revoked.
        for decision in [
            json!({"action":"continue"}),
            json!({"action":"replace","value":{"quantity":7}}),
        ] {
            let root = Arc::new(Control::new("root".into(), true));
            let child = Arc::new(Control::descendant("child".into(), &root));
            let independent = Arc::new(Control::new("independent".into(), true));
            root.enable(3.0, Scope::ThreadTree).unwrap();
            independent.enable(3.0, Scope::Root).unwrap();
            let item = response(json!({
                "type":"function_call","call_id":"same-id","name":"record",
                "arguments":r#"{"quantity":2}"#,
            }));
            let child_request = direct_request(child, "child-turn");
            let other_request = direct_request(independent.clone(), "other-turn");
            let mut waiting = Box::pin(child_request.before(item.clone()));
            let mut other_waiting = Box::pin(other_request.before(item));
            assert!(futures_util::poll!(waiting.as_mut()).is_pending());
            assert!(futures_util::poll!(other_waiting.as_mut()).is_pending());
            let child_notice = root.next().await.unwrap();
            let other_notice = independent.next().await.unwrap();
            assert_eq!(child_notice["request"]["thread_id"], "child");
            assert_eq!(other_notice["request"]["thread_id"], "independent");
            assert!(root.resolve(
                child_notice["nonce"].as_u64().unwrap(),
                &decision.to_string()
            ));
            assert!(independent.resolve(
                other_notice["nonce"].as_u64().unwrap(),
                &decision.to_string()
            ));
            root.revoke();
            assert!(
                matches!(waiting.await, Err(ModelResponseError::InvalidRequest { message }) if message == FAILURE)
            );
            let admitted = serde_json::to_value(other_waiting.await.unwrap()).unwrap();
            assert_eq!(admitted["call_id"], "same-id");
            assert_eq!(
                serde_json::from_str::<Value>(admitted["arguments"].as_str().unwrap()).unwrap(),
                if decision["action"] == "replace" {
                    json!({"quantity":7})
                } else {
                    json!({"quantity":2})
                }
            );
        }
    }

    #[tokio::test]
    async fn cold_spawn_ancestry_stops_at_the_nearest_live_control() {
        use codex_agent_graph_store::ThreadSpawnEdgeStatus;
        use codex_protocol::ThreadId;
        use codex_protocol::protocol::SubAgentSource;

        let graph = Arc::new(crate::storage::MemoryAgentGraph::default());
        let boundary = Boundary::new(graph.clone(), Arc::new(RwLock::new(None)));
        let root_id = ThreadId::new();
        let parent_id = ThreadId::new();
        let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
            parent_thread_id: parent_id,
            depth: 2,
            agent_path: None,
            agent_nickname: None,
            agent_role: None,
        });
        let root = Arc::new(Control::new(root_id.to_string(), true));
        boundary
            .threads
            .lock()
            .unwrap()
            .insert(root.id.clone(), Arc::downgrade(&root));
        // Missing graph ancestry cannot select even the only live root.
        assert!(boundary.parent_control(&source).await.is_none());
        graph
            .restore_edge(
                parent_id,
                crate::storage::SpawnEdge {
                    parent: root_id,
                    status: ThreadSpawnEdgeStatus::Open,
                    closed_at: None,
                },
            )
            .await;
        let ancestor = boundary.parent_control(&source).await.unwrap();
        assert!(Arc::ptr_eq(&ancestor, &root));
        let cold_leaf = Arc::new(Control::descendant("leaf".into(), &ancestor));
        assert!(!cold_leaf.configured());
        // A live enable, not the restored edge, is what grants callbacks.
        root.enable(3.0, Scope::ThreadTree).unwrap();
        assert!(cold_leaf.configured());
        for unrelated_source in [
            SessionSource::Exec,
            SessionSource::SubAgent(SubAgentSource::Review),
            SessionSource::SubAgent(SubAgentSource::Compact),
            SessionSource::SubAgent(SubAgentSource::Other("not a spawn".into())),
        ] {
            assert!(boundary.parent_control(&unrelated_source).await.is_none());
        }
        let opted_out = Arc::new(Control::new(parent_id.to_string(), false));
        boundary
            .threads
            .lock()
            .unwrap()
            .insert(opted_out.id.clone(), Arc::downgrade(&opted_out));
        // The graph may lead to an enabled root, but it cannot override the
        // current intermediate owner (including a revoked one).
        let first = boundary.parent_control(&source).await.unwrap();
        assert!(Arc::ptr_eq(&first, &opted_out));
        assert!(!Control::descendant("other-leaf".into(), &first).configured());
        root.revoke();
        boundary.threads.lock().unwrap().remove(&opted_out.id);
        let revoked = boundary.parent_control(&source).await.unwrap();
        assert!(Arc::ptr_eq(&revoked, &root));
        let after_revoke = Arc::new(Control::descendant("last-leaf".into(), &revoked));
        assert!(after_revoke.configured());
        assert!(
            after_revoke
                .decide(json!({}), &CancellationToken::new())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn abort_before_execute_cleans_native_tuple_from_different_task() {
        let boundary = Arc::new(Boundary::new(
            Arc::new(crate::storage::MemoryAgentGraph::default()),
            Arc::new(RwLock::new(None)),
        ));
        let ready = Arc::new(tokio::sync::Barrier::new(3));
        let survivor_release = Arc::new(tokio::sync::Notify::new());
        let first = {
            let boundary = boundary.clone();
            let ready = ready.clone();
            tokio::spawn(async move {
                let owner = Arc::new(Control::new("abort-root".into(), true));
                owner.enable(3.0, Scope::Root).unwrap();
                boundary.start_exec(
                    owner,
                    "turn",
                    "same-model-id",
                    codex_code_mode::PUBLIC_TOOL_NAME,
                );
                ready.wait().await;
                std::future::pending::<()>().await;
            })
        };
        let survivor = {
            let boundary = boundary.clone();
            let ready = ready.clone();
            let release = survivor_release.clone();
            tokio::spawn(async move {
                let owner = Arc::new(Control::new("survivor".into(), true));
                owner.enable(3.0, Scope::Root).unwrap();
                boundary.start_exec(
                    owner,
                    "turn",
                    "same-model-id",
                    codex_code_mode::PUBLIC_TOOL_NAME,
                );
                ready.wait().await;
                release.notified().await;
                boundary
                    .take_exec("same-model-id")
                    .unwrap()
                    .unwrap()
                    .control
                    .id
                    .clone()
            })
        };
        tokio::time::timeout(Duration::from_secs(3), ready.wait())
            .await
            .unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        boundary.finish_exec("abort-root", "turn", "same-model-id");
        assert_eq!(boundary.starts.lock().unwrap().len(), 1);
        survivor_release.notify_one();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), survivor)
                .await
                .unwrap()
                .unwrap(),
            "survivor"
        );
        assert!(boundary.starts.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn tools_only_policy_join_waits_for_callback_release_after_scoped_stop() {
        const BUDGET: usize = 8192;
        // Advance the paused Tokio clock only after all real-Instant deadlines.
        for finish in ["call", "root", "decision", "timeout"] {
            let control = Arc::new(Control::with_budget("root".into(), true, BUDGET));
            control.enable(3.0, Scope::Root).unwrap();
            let request = direct_request(control.clone(), "turn");
            let cancellation = CancellationToken::new();
            let item=serde_json::from_value(json!({"type":"function_call","call_id":"policy-call","name":"lookup","arguments":"{}"})).unwrap();
            let mut joined = Box::pin(request.admit_tools_only(item, &cancellation));
            assert!(
                futures_util::poll!(&mut joined).is_pending(),
                "Premature completion in {finish} case"
            );
            let wire = control.next_wire().await.unwrap();
            let nonce = serde_json::from_str::<Value>(&wire).unwrap()["nonce"]
                .as_u64()
                .unwrap();
            assert!(control.handoff(nonce));
            match finish {
                "call" => cancellation.cancel(),
                "root" => request.owner.cancelled.cancel(),
                "timeout" => tokio::time::advance(Duration::from_secs(4)).await,
                _ => assert!(control.resolve(nonce, r#"{"action":"continue"}"#)),
            }
            assert!(futures_util::poll!(&mut joined).is_pending());
            // Cancellation must actively reach the SDK callback before joining
            // its finally cleanup; nonce fencing alone cannot wake that task.
            let cancel = control.next_wire().await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&cancel).unwrap()["cancel"],
                json!(nonce)
            );
            assert!(control.channel.bytes.available_permits() < BUDGET);
            if finish != "root" {
                assert!(!request.owner.cancelled.is_cancelled());
            }
            assert!(!control.resolve(nonce, r#"{"action":"continue"}"#));
            assert!(control.release(nonce));
            assert_eq!(joined.await.is_ok(), finish == "decision");
            assert_eq!(control.channel.bytes.available_permits(), BUDGET);
            assert!(control.channel.state.lock().unwrap().pending.is_empty());
        }
    }

    #[tokio::test]
    async fn cancelling_one_tools_only_policy_keeps_its_sibling_live() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let request = direct_request(control.clone(), "turn");
        let token = CancellationToken::new();
        let sibling_token = CancellationToken::new();
        let item = |id: &str| {
            serde_json::from_value(
                json!({"type":"function_call","call_id":id,"name":"lookup","arguments":"{}"}),
            )
            .unwrap()
        };
        let mut first = Box::pin(request.admit_tools_only(item("cancelled"), &token));
        let mut sibling = Box::pin(request.admit_tools_only(item("sibling"), &sibling_token));
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(futures_util::poll!(&mut sibling).is_pending());
        let mut nonces = Vec::new();
        for _ in 0..2 {
            let wire = control.next_wire().await.unwrap();
            let nonce = serde_json::from_str::<Value>(&wire).unwrap()["nonce"]
                .as_u64()
                .unwrap();
            assert!(control.handoff(nonce));
            nonces.push(nonce);
        }
        token.cancel();
        assert!(futures_util::poll!(&mut first).is_pending());
        let cancel = control.next_wire().await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&cancel).unwrap()["cancel"],
            json!(nonces[0])
        );
        assert!(!request.owner.cancelled.is_cancelled() && !sibling_token.is_cancelled());
        assert!(control.resolve(nonces[1], r#"{"action":"continue"}"#));
        assert!(futures_util::poll!(&mut sibling).is_pending());
        assert!(control.release(nonces[1]));
        assert!(sibling.await.is_ok());
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(control.release(nonces[0]));
        assert!(first.await.is_err());
    }

    fn direct_request(control: Arc<Control>, turn: &str) -> DirectRequest {
        let admission = test_tool_admission(&control.id, turn, None);
        DirectRequest {
            owner: admission.turn_store().get::<DirectTurn>().unwrap(),
            tool_admission: Some(admission),
            control,
            model: "test-model".into(),
            command_admission: None,
        }
    }

    #[tokio::test]
    async fn owned_startup_captures_before_poll_and_drops_without_native_work() {
        tokio::spawn(async {
            let (session, mut calls) = probed_session();
            // Opted-out starts still have an exact owner, without enrolling callbacks.
            let control = Arc::new(Control::new("root".into(), true));
            session.boundary.start_exec(
                control,
                "turn",
                "same-model-id",
                codex_code_mode::PUBLIC_TOOL_NAME,
            );
            let captured = session.clone().execute_owned(
                exec_request(),
                Arc::new(Actual(AtomicUsize::new(0))),
                None,
            );
            assert!(session.boundary.starts.lock().unwrap().is_empty());
            assert!(calls.try_recv().is_err());
            drop(captured);
            assert!(calls.try_recv().is_err());
            assert!(session.cells.lock().unwrap().is_empty());
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn missing_or_mismatched_router_owner_never_enters_public_policy() {
        for mismatch in ["missing", "thread", "same-id-other-store"] {
            let control = Arc::new(Control::new("root".into(), true));
            control.enable(3.0, Scope::Root).unwrap();
            let mut request = direct_request(control.clone(), "same-turn-id");
            request.tool_admission = match mismatch {
                "missing" => None,
                "thread" => Some(test_tool_admission("other-thread", "same-turn-id", None)),
                _ => Some(test_tool_admission("root", "same-turn-id", None)),
            };
            let item = response(
                json!({"type":"function_call", "call_id":"call", "name":"exec_command", "arguments":"{}"}),
            );
            assert!(request.before(item).await.is_err());
            assert!(control.channel.state.lock().unwrap().pending.is_empty());
        }
    }

    #[tokio::test]
    async fn unselected_or_wrong_kind_calls_keep_core_handling_without_policy_callbacks() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let admission = test_tool_admission(
            "root",
            "turn",
            Some(vec![(
                ToolName::plain("apply_patch").with_default_namespace(),
                false,
            )]),
        );
        let mut request = direct_request(control.clone(), "turn");
        request.owner = admission.turn_store().get::<DirectTurn>().unwrap();
        request.tool_admission = Some(admission);
        for item in [
            response(
                json!({"type":"function_call", "call_id":"call", "name":"exec_command", "arguments":"{}"}),
            ),
            response(
                json!({"type":"function_call", "call_id":"call", "name":"apply_patch", "arguments":"{}"}),
            ),
            response(
                json!({"type":"custom_tool_call", "call_id":"call", "name":"apply_patch", "namespace":"mcp__other", "input":"patch"}),
            ),
        ] {
            let original = serde_json::to_value(&item).unwrap();
            let forwarded = request.before(item).await.unwrap();
            assert_eq!(serde_json::to_value(&forwarded).unwrap(), original);
            assert!(control.channel.state.lock().unwrap().pending.is_empty());
        }
    }

    #[tokio::test]
    async fn unselected_calls_preserve_native_agents_terminal_denial() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        assert!(
            control
                .native_agents
                .set(Arc::new(crate::native_agents::Policy {
                    roles: Vec::new(),
                    managed_tools: Vec::new(),
                    max_depth: 1,
                    inherited_instructions: None,
                    allowed: Default::default(),
                }))
                .is_ok()
        );
        let admission = test_tool_admission("root", "turn", Some(Vec::new()));
        let mut request = direct_request(control.clone(), "turn");
        request.owner = admission.turn_store().get::<DirectTurn>().unwrap();
        request.tool_admission = Some(admission);
        let item = response(json!({
            "type":"function_call", "call_id":"denied-plan", "name":"update_plan",
            "arguments":"{\"plan\":[]}"
        }));
        assert!(request.before(item).await.is_err());
        assert!(control.channel.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn completed_warmup_releases_ticket_before_the_stream_is_dropped() {
        let boundary = import_cleanup_boundary();
        let control = Arc::new(Control::new("root".into(), true));
        control
            .sentinel_provider
            .set(("fixture".into(), false))
            .unwrap();
        boundary
            .threads
            .lock()
            .unwrap()
            .insert(control.id.clone(), Arc::downgrade(&control));
        let issue = |kind, client_metadata: &mut Option<_>| {
            boundary
                .request(ModelRequestInput {
                    attempts: None,
                    kind,
                    thread_id: &control.id,
                    client_metadata,
                    model: "test-model",
                    model_omitted: false,
                })
                .unwrap()
        };

        let mut warmup_metadata = None;
        let warmup = issue(ModelRequestKind::Warmup, &mut warmup_metadata);
        let mut stream = warmup.intercept(Box::pin(stream::iter([Ok(ResponseEvent::Completed {
            response_id: "fixture-warmup".into(),
            token_usage: None,
            usage_metadata: None,
            end_turn: None,
        })])));
        assert!(matches!(
            stream.next().await,
            Some(Ok(ResponseEvent::Completed { .. }))
        ));

        // Core may resume generation while the mapper still owns the completed stream.
        let mut generation_metadata = None;
        let generation = issue(ModelRequestKind::Generation, &mut generation_metadata);
        let generation_nonce = &generation_metadata
            .as_ref()
            .expect("generation must receive a carrier ticket before the warmup stream drops")["sdk_sentinel_nonce"];
        assert_ne!(
            generation_nonce,
            &warmup_metadata.unwrap()["sdk_sentinel_nonce"]
        );

        assert!(stream.next().await.is_none());
        drop(stream);
        let current = control.sentinel_request.lock().unwrap();
        assert_eq!(current.request.as_ref().unwrap().nonce, *generation_nonce);
        drop(current);
        drop(generation);
    }

    #[tokio::test]
    async fn admitted_websocket_failure_keeps_already_decoded_integrity() {
        use codex_protocol::error::ResponseIntegrityReason;

        for (kind, decoded, retains_integrity) in [
            (ModelRequestKind::Generation, false, false),
            (ModelRequestKind::Generation, true, true),
            (ModelRequestKind::Warmup, true, false),
        ] {
            let control = Arc::new(Control::new("root".into(), true));
            let owner = (kind == ModelRequestKind::Generation)
                .then(|| direct_request(control.clone(), "turn").owner);
            *control.direct_turn.lock().unwrap() = owner.clone();
            let ticket = Arc::new(SentinelTicket {
                attempts: None,
                nonce: "ticket".into(),
                kind,
                model: "model".into(),
                model_omitted: false,
                admitted: AtomicBool::new(true),
                owner,
                failure: Mutex::new(None),
                command_admission: None,
            });
            control.sentinel_request.lock().unwrap().request = Some(ticket.clone());
            let request = Box::new(SentinelRequest {
                control,
                ticket: ticket.clone(),
                tool_admission: None,
            });
            let upstream = Box::pin(stream::once(async move {
                *ticket.failure.lock().unwrap() =
                    Some(SentinelFailure::WebSocket { oversized: false });
                if decoded {
                    Err(ModelResponseError::ResponseIntegrity {
                        reason: ResponseIntegrityReason::UndecodableOutputItem,
                    })
                } else {
                    Err(ModelResponseError::Stream("disconnected".into()))
                }
            }));
            let error = request.intercept(upstream).next().await;
            if retains_integrity {
                assert!(matches!(
                    error,
                    Some(Err(ModelResponseError::ResponseIntegrity {
                        reason: ResponseIntegrityReason::UndecodableOutputItem,
                    }))
                ));
            } else {
                assert!(matches!(
                    error,
                    Some(Err(ModelResponseError::InvalidRequest { message }))
                        if message.contains("it will not be replayed")
                ));
            }
        }
    }

    #[tokio::test]
    async fn sentinel_and_direct_wrappers_keep_the_exact_bound_request_router() {
        for sentinel in [false, true] {
            let control = Arc::new(Control::new("root".into(), true));
            control.enable(3.0, Scope::Root).unwrap();
            let admission = test_tool_admission(
                "root",
                "original",
                Some(vec![(
                    ToolName::plain("apply_patch").with_default_namespace(),
                    false,
                )]),
            );
            let owner = admission.turn_store().get::<DirectTurn>().unwrap();
            // A mutable later owner is not this request's routing evidence.
            let successor = test_tool_admission(
                "root",
                "successor",
                Some(vec![(
                    ToolName::plain("exec_command").with_default_namespace(),
                    true,
                )]),
            );
            *control.direct_turn.lock().unwrap() = successor.turn_store().get::<DirectTurn>();
            let request: Box<dyn ModelResponseInterceptor> = if sentinel {
                Box::new(SentinelRequest {
                    control: control.clone(),
                    tool_admission: None,
                    ticket: Arc::new(SentinelTicket {
                        attempts: None,
                        nonce: "ticket".into(),
                        kind: ModelRequestKind::Generation,
                        model: "issuing-model".into(),
                        model_omitted: false,
                        admitted: AtomicBool::new(false),
                        owner: Some(owner),
                        failure: Mutex::new(None),
                        command_admission: None,
                    }),
                })
            } else {
                Box::new(DirectRequest {
                    control: control.clone(),
                    owner,
                    model: "issuing-model".into(),
                    command_admission: None,
                    tool_admission: None,
                })
            };
            let item = response(
                json!({"type":"function_call", "call_id":"call", "name":"exec_command", "arguments":"{}"}),
            );
            let original = serde_json::to_value(&item).unwrap();
            let mut stream = request.intercept_with_tool_admission(
                Box::pin(stream::iter([Ok(ResponseEvent::OutputItemDone(item))])),
                Some(admission),
            );
            let next = stream.next();
            tokio::pin!(next);
            let std::task::Poll::Ready(Some(Ok(ResponseEvent::OutputItemDone(item)))) =
                futures_util::poll!(&mut next)
            else {
                panic!("unselected original router must not wait for a successor's policy");
            };
            assert_eq!(serde_json::to_value(&item).unwrap(), original);
            assert!(control.channel.state.lock().unwrap().pending.is_empty());
        }
    }

    fn result_rules() -> Vec<ToolRule> {
        serde_json::from_value(json!([
            {"name":"exec_command","namespace":"functions","timeout":1.0,
             "scope":"thread_tree","result":true},
            {"name":"lookup","namespace":"mcp__fixture","timeout":1.0,
             "scope":"thread_tree","generation":"7"}
        ]))
        .unwrap()
    }

    #[tokio::test]
    async fn executor_stop_admits_only_selected_before_and_holds_until_interruption() {
        for root in [true, false] {
            for before in [true, false] {
                let parent = Arc::new(Control::new("root".into(), true));
                parent.enable(3.0, Scope::ThreadTree).unwrap();
                parent
                    .configure_tools(
                        serde_json::from_value(json!([{
                            "name":"exec_command", "namespace":"functions",
                            "scope":"thread_tree", "timeout":3.0, "executor_before":true
                        }]))
                        .unwrap(),
                    )
                    .unwrap();
                let control = if root {
                    parent.clone()
                } else {
                    Arc::new(Control::descendant("child".into(), &parent))
                };
                let owner = direct_request(control.clone(), "original").owner;
                let token = CancellationToken::new();
                let mut decision = Box::pin(control.decide(
                    OwnedRequest {
                        request: json!({
                            "phase": if before { "before" } else { "after" },
                            "boundary": if before { "pre_dispatch" } else { "executor_return" },
                            "tool_name":{"namespace":"functions", "name":"exec_command"}
                        }),
                        owner: &owner,
                        retained: root,
                        cell_owner_id: None,
                    },
                    &token,
                ));
                assert!(futures_util::poll!(&mut decision).is_pending());
                let notice = parent.next().await.unwrap();
                let nonce = notice["nonce"].as_u64().unwrap();
                assert!(parent.handoff(nonce));
                if before {
                    let held = parent.hold_for_stop(nonce).unwrap();
                    assert!(Arc::ptr_eq(held.captured.owner.as_ref().unwrap(), &owner));
                    assert!(owner.policy_stopped.load(Ordering::Acquire));
                    assert!(!parent.resolve(nonce, r#"{"action":"continue"}"#));
                    // A held stop is not a catchable ordinary denial.
                    assert!(futures_util::poll!(&mut decision).is_pending());
                    token.cancel();
                    assert!(decision.await.is_err());
                } else {
                    assert!(parent.hold_for_stop(nonce).is_none());
                    assert!(!owner.policy_stopped.load(Ordering::Acquire));
                    assert!(parent.resolve(nonce, r#"{"action":"continue"}"#));
                    assert!(decision.await.is_ok());
                }
                assert!(parent.release(nonce));
            }
        }
    }

    #[test]
    fn captured_mono_mcp_hook_selection_survives_later_policy_replacement() {
        let control = Control::new("root".into(), true);
        control.enable(3.0, Scope::Root).unwrap();
        let rules = Control::compile_rules(result_rules()).unwrap();
        control.channel.state.lock().unwrap().tools = Some(rules.clone());
        let original = Arc::new(control.capture_mcp_source());
        assert!(original.receipt.is_none());
        let lookup = ToolName::new(Some("mcp__fixture".into()), "lookup");
        assert_eq!(original.policy.as_ref().unwrap().rules[&lookup].2, Some(7));
        assert!(
            !original
                .policy
                .as_ref()
                .unwrap()
                .rules
                .contains_key(&ToolName::plain("exec_command").with_default_namespace())
        );
        control.channel.state.lock().unwrap().tools = Some(HashMap::new());
        assert!(control.mcp_selected_for(&lookup, Some(&original)).unwrap());
        let unselected = Arc::new(control.capture_mcp_source());
        control.channel.state.lock().unwrap().tools = Some(rules);
        assert!(control.mcp_selected(&lookup).unwrap());
        assert!(
            !control
                .mcp_selected_for(&lookup, Some(&unselected))
                .unwrap()
        );
        control.revoke();
        assert!(control.mcp_selected_for(&lookup, Some(&original)).is_err());
    }

    #[test]
    fn missing_captured_mcp_policy_fails_closed() {
        let step = ExtensionData::new("invalid-source");
        step.insert(ProfileMcpSource {
            result_selection: None,
            receipt: None,
            policy: None,
        });
        assert!(capture_mcp_source(Some(&step)).is_err());
    }

    #[test]
    fn builtin_result_enrollment_preserves_mcp_generation_and_namespace() {
        let compiled = Control::compile_rules(result_rules()).unwrap();
        let builtin = compiled
            .get(&ToolName::plain("exec_command").with_default_namespace())
            .unwrap();
        assert_eq!(builtin.2, None);
        assert!(builtin.3);
        let mcp = compiled
            .get(&ToolName::new(Some("mcp__fixture".into()), "lookup"))
            .unwrap();
        assert_eq!(mcp.2, Some(7));
        assert!(!mcp.3);
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let mut rules = result_rules();
        rules.pop();
        control.configure_tools(rules).unwrap();
        assert!(control.controls_builtin_result(&ToolName::plain("exec_command")));
        assert!(!control.controls_builtin_result(&ToolName::plain("write_stdin")));
        assert!(
            !control.controls_builtin_result(&ToolName::new(
                Some("mcp__fixture".into()),
                "exec_command"
            ))
        );
        control.revoke();
        assert!(control.controls_builtin_result(&ToolName::plain("exec_command")));
    }

    #[tokio::test]
    async fn native_builtin_result_retains_only_original_root_nested_owner() {
        for (nested, root, ended, replace, valid, cancel_before_repoll) in [
            (false, true, false, true, true, false),
            (false, true, false, false, true, false),
            (false, true, true, true, false, false),
            (true, true, true, true, true, false),
            (true, false, true, true, false, false),
            // Real invocation cancellation: direct, retained root, live child.
            (false, true, false, true, true, true),
            (false, true, false, false, true, true),
            (true, true, true, true, true, true),
            (true, true, true, false, true, true),
            (true, false, false, true, true, true),
            (true, false, false, false, true, true),
        ] {
            let boundary = Boundary::new(
                Arc::new(crate::storage::MemoryAgentGraph::default()),
                Arc::new(RwLock::new(None)),
            );
            let thread = ExtensionData::new("original-thread");
            let control = thread.get_or_init(|| Control::new("original-thread".into(), root));
            // Set fixture enrollment without granting an application a child enable API.
            {
                let mut state = control.channel.state.lock().unwrap();
                state.timeout = Some(Duration::from_secs(3));
                state.scope = Scope::ThreadTree;
                let mut rules = result_rules();
                rules.pop();
                state.tools = Some(Control::compile_rules(rules).unwrap());
            }
            let turn = ExtensionData::new("original-turn");
            let owner = turn.get_or_init(|| DirectTurn {
                policy_stopped: AtomicBool::new(false),
                id: "original-turn".into(),
                model: Mutex::new(None),
                command_admission: Mutex::new(None),
                cancelled: CancellationToken::new(),
                settlement: None,
                core_task: Some(Arc::new(codex_core_api::OwnedTurnTask::default())),
                mcp_calls: Mutex::default(),
            });
            if ended {
                owner.cancelled.cancel();
            } // Normal terminal, not a policy stop.
            let name = ToolName::plain("exec_command");
            let payload = ToolPayload::Function {
                arguments: "{}".into(),
            };
            let raw = json!({"output":"private-original"});
            let token = CancellationToken::new();
            let source = if nested {
                ToolCallSource::CodeMode {
                    cell_id: "original-cell".into(),
                    runtime_tool_call_id: "runtime".into(),
                }
            } else {
                ToolCallSource::Direct
            };
            let mut hook = Box::pin(boundary.on_builtin_tool_result(BuiltinToolResultInput {
                model: "issuing-model",
                thread_store: &thread,
                turn_store: &turn,
                turn_id: "original-turn",
                call_id: "actual-native",
                outer_call_id: nested.then_some("original-outer"),
                tool_name: &name,
                payload: &payload,
                source,
                result: &raw,
                cancelled: Box::pin(token.cancelled()),
                is_cancelled: Arc::new({
                    let token = token.clone();
                    move || token.is_cancelled()
                }),
            }));
            if !valid {
                assert!(hook.await.is_err());
                assert!(control.channel.state.lock().unwrap().pending.is_empty());
                continue;
            }
            assert!(futures_util::poll!(&mut hook).is_pending());
            let notice = control.next().await.unwrap();
            assert_eq!(notice["request"]["boundary"], "executor_return");
            assert_eq!(notice["request"]["model"], "issuing-model");
            assert_eq!(notice["request"]["turn_id"], "original-turn");
            assert_eq!(
                notice["request"]["outer_call_id"],
                if nested {
                    json!("original-outer")
                } else {
                    Value::Null
                }
            );
            assert_eq!(
                notice["request"]["call_id"],
                if nested {
                    Value::Null
                } else {
                    json!("actual-native")
                }
            );
            assert_eq!(notice["request"]["result"], raw);
            let nonce = notice["nonce"].as_u64().unwrap();
            assert!(control.can_enter(nonce) && control.handoff(nonce));
            if cancel_before_repoll {
                let held = control.channel.bytes.available_permits();
                // Cancel the token supplied to BuiltinToolResultInput, not the
                // turn's normal-terminal token or a stand-in decide token.
                token.cancel();
                // No await, poll, yield, or hook drop between cancellation and
                // these checks: both must reject before the hook runs again.
                let can_enter = control.can_enter(nonce);
                let accepted_reply = control.resolve(
                    nonce,
                    if replace {
                        r#"{"action":"replace","value":{"output":"late"}}"#
                    } else {
                        r#"{"action":"continue"}"#
                    },
                );
                assert_eq!(
                    (can_enter, accepted_reply),
                    (false, false),
                    "cancelled builtin: nested={nested}, root={root}, ended={ended}, replace={replace}"
                );
                assert_eq!(control.channel.bytes.available_permits(), held);
                assert!(hook.await.is_err());
                // Cancellation revokes authority without releasing JS storage.
                assert_eq!(control.channel.bytes.available_permits(), held);
                assert!(control.release(nonce));
                assert!(control.channel.state.lock().unwrap().pending.is_empty());
                continue;
            }
            assert!(control.resolve(
                nonce,
                if replace {
                    r#"{"action":"replace","value":{"output":"accepted"}}"#
                } else {
                    r#"{"action":"continue"}"#
                }
            ));
            if replace {
                assert_eq!(hook.await.unwrap(), json!({"output":"accepted"}));
            } else {
                assert!(hook.await.is_err());
            }
            assert!(control.release(nonce));
        }
    }

    #[tokio::test]
    async fn builtin_result_stop_fences_delivered_reply_without_releasing_callback_storage() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let owner = direct_request(control.clone(), "original").owner;
        let token = CancellationToken::new();
        let mut after = Box::pin(control.decide(
            OwnedRequest {
                request: json!({"phase":"after","result":"private"}),
                owner: &owner,
                retained: true,
                cell_owner_id: None,
            },
            &token,
        ));
        assert!(futures_util::poll!(&mut after).is_pending());
        let notice = control.next().await.unwrap();
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(control.handoff(nonce));
        let held = control.channel.bytes.available_permits();
        assert!(control.resolve(nonce, r#"{"action":"replace","value":"late"}"#));
        {
            let _state = control.channel.state.lock().unwrap();
            owner.policy_stopped.store(true, Ordering::Release);
        }
        assert!(after.await.is_err());
        assert!(!control.can_enter(nonce));
        assert_eq!(control.channel.bytes.available_permits(), held);
        assert!(
            control
                .publish_result(&owner, &token, true, None, || "late")
                .is_err()
        );
        assert!(control.release(nonce));
        assert_eq!(control.channel.bytes.available_permits(), MAX_PAYLOAD_BYTES);
    }

    #[test]
    fn rejected_mcp_policy_stops_only_captured_owner_before_publication() {
        let thread = ExtensionData::new("root");
        let control = thread.get_or_init(|| Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let old = direct_request(control.clone(), "same-id");
        let successor = direct_request(control.clone(), "same-id");
        *control.direct_turn.lock().unwrap() = Some(successor.owner.clone());
        let old_turn = old.tool_admission.as_ref().unwrap().turn_store();
        let successor_turn = successor.tool_admission.as_ref().unwrap().turn_store();
        old.owner.cancelled.cancel(); // Natural completion still owns retained work.
        expire_mcp_result(&thread, old_turn, || false); // Cancelled/revoked call cannot claim.
        assert!(!old.owner.policy_stopped.load(Ordering::Acquire));
        expire_mcp_result(&thread, old_turn, || true);
        assert!(old.owner.policy_stopped.load(Ordering::Acquire));
        assert!(!successor.owner.policy_stopped.load(Ordering::Acquire));
        let probe: CancellationProbe = Arc::new(|| false);
        let mut publications = 0;
        publish_mcp_metadata(&thread, old_turn, true, &probe, || publications += 1);
        assert_eq!(publications, 0);
        publish_mcp_metadata(&thread, successor_turn, true, &probe, || publications += 1);
        assert_eq!(
            publications, 1,
            "same-id successor retains its own authority"
        );
    }

    #[test]
    fn metadata_publication_keeps_retained_root_completion_and_fences_exact_call_cancel() {
        let thread = ExtensionData::new("root");
        let control = thread.get_or_init(|| Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let request = direct_request(control, "original");
        let turn = request.tool_admission.as_ref().unwrap().turn_store();
        request.owner.cancelled.cancel(); // Ordinary root completion retains the cell.
        let invocation = CancellationToken::new();
        let is_cancelled: CancellationProbe = Arc::new({
            let invocation = invocation.clone();
            move || invocation.is_cancelled()
        });
        let mut publications = 0;
        publish_mcp_metadata(&thread, turn, true, &is_cancelled, || publications += 1);
        assert_eq!(publications, 1);
        invocation.cancel(); // The cell's actual call now ends independently.
        publish_mcp_metadata(&thread, turn, true, &is_cancelled, || publications += 1);
        assert_eq!(publications, 1, "cancelled call must not accept metadata");
    }

    #[tokio::test]
    async fn builtin_invocation_cancellation_fences_delivered_reply_and_publication() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let owner = direct_request(control.clone(), "original").owner;
        // Retained work survives normal root completion, but not cancellation
        // of its particular native invocation.
        owner.cancelled.cancel();
        let invocation_token = CancellationToken::new();
        let is_cancelled: CancellationProbe = Arc::new({
            let token = invocation_token.clone();
            move || token.is_cancelled()
        });
        let token = CancellationToken::new();
        assert_eq!(
            control
                .publish_result(&owner, &token, true, Some(&is_cancelled), || "accepted")
                .unwrap(),
            "accepted"
        );
        let mut after = Box::pin(control.decide_retained(
            OwnedRequest {
                request: json!({"phase":"after","result":"private"}),
                owner: &owner,
                retained: true,
                cell_owner_id: None,
            },
            &token,
            None,
            Some(is_cancelled.clone()),
        ));
        assert!(futures_util::poll!(&mut after).is_pending());
        let notice = control.next().await.unwrap();
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(control.handoff(nonce));
        let held = control.channel.bytes.available_permits();
        assert!(control.resolve(nonce, r#"{"action":"replace","value":"late"}"#));
        invocation_token.cancel();
        // The reservation token remains live: acceptance must inspect Core's
        // actual invocation signal even after resolve delivered its decision.
        assert!(!token.is_cancelled());
        assert!(after.await.is_err());
        let mut published = false;
        assert!(
            control
                .publish_result(&owner, &token, true, Some(&is_cancelled), || {
                    published = true;
                })
                .is_err()
        );
        assert!(!published);
        assert_eq!(control.channel.bytes.available_permits(), held);
        assert!(control.release(nonce));
        assert_eq!(control.channel.bytes.available_permits(), MAX_PAYLOAD_BYTES);
        assert!(control.channel.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn cell_owner_binding_and_retirement_share_existing_channel_and_exact_identity() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let mut rules = result_rules();
        rules.pop();
        control.configure_tools(rules).unwrap();
        let turn = direct_request(control.clone(), "original").owner;
        let lease = control
            .cell_policy_owner(Some(&turn), "outer")
            .unwrap()
            .unwrap();
        let cell = CellId::new("cell".into());
        let mut binding = Box::pin(lease.bind(&cell));
        assert!(futures_util::poll!(&mut binding).is_pending());
        let notice = control.next().await.unwrap();
        assert!(notice.get("request").is_none());
        assert_eq!(notice["cell_owner"]["owner_id"], lease.id);
        assert_eq!(notice["cell_owner"]["turn_id"], "original");
        assert_eq!(notice["cell_owner"]["cell_id"], "cell");
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(control.handoff(nonce));
        assert!(control.hold_for_stop(nonce).is_none());
        assert!(control.resolve(nonce, r#"{"action":"continue"}"#));
        binding.await.unwrap();
        assert!(control.release(nonce));
        assert!(lease.identify(&CellId::new("another".into())).is_err());
        // Skip the existing reservation's cancellation receipt.
        assert!(control.next().await.unwrap().get("cancel").is_some());
        let in_flight = lease.clone();
        let id = lease.id.clone();
        drop(lease);
        assert!(control.channel.state.lock().unwrap().pending.is_empty());
        drop(in_flight);
        assert_eq!(
            control.next().await.unwrap(),
            json!({"cell_owner_retired":id})
        );
    }

    fn response(value: Value) -> ResponseItem {
        serde_json::from_value(value).expect("test ResponseItem")
    }

    #[tokio::test]
    async fn import_poison_rejects_entered_requests_and_later_controls_without_policy_opt_in() {
        let boundary = import_cleanup_boundary();
        let control = Arc::new(Control::new("root".into(), true));
        boundary.register_control(&control);
        let request = direct_request(control.clone(), "entered");
        *control.direct_turn.lock().unwrap() = Some(request.owner.clone());
        let item = || {
            response(json!({
                "type":"function_call", "call_id":"call", "name":"echo", "arguments":"{}",
            }))
        };
        assert!(request.before(item()).await.is_ok());
        assert!(!control.code_import_poisoned());
        boundary.record_code_import_failure("uncertain receiver shutdown");
        assert!(control.is_stopped());
        assert!(request.owner.cancelled.is_cancelled());
        assert!(request.before(item()).await.is_err());
        assert!(boundary.check_code_import_cleanup().is_ok());

        let later = Arc::new(Control::new("later".into(), true));
        boundary.register_control(&later);
        assert!(later.code_import_poisoned());
        assert!(later.is_stopped());
        // Even a fresh request owner cannot regain admission from this Control.
        assert!(
            direct_request(later, "later-turn")
                .before(item())
                .await
                .is_err()
        );
        let unrelated = Arc::new(Control::new("other-boundary".into(), true));
        import_cleanup_boundary().register_control(&unrelated);
        assert!(
            direct_request(unrelated, "unrelated")
                .before(item())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn native_execution_revoke_rejects_an_entered_callback_before_publication() {
        let boundary = import_cleanup_boundary();
        let thread_store = ExtensionData::new("root");
        let control = thread_store.get_or_init(|| Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        boundary.register_control(&control);
        let request = direct_request(control.clone(), "entered");
        *control.direct_turn.lock().unwrap() = Some(request.owner.clone());
        let mut before = Box::pin(request.before(response(json!({
            "type":"function_call", "call_id":"call", "name":"echo", "arguments":"{}",
        }))));
        assert!(futures_util::poll!(&mut before).is_pending());
        let notice = control.next().await.unwrap();
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(control.handoff(nonce));
        boundary.on_thread_execution_revoked(&thread_store);
        assert!(!control.can_enter(nonce));
        assert!(!control.resolve(nonce, r#"{"action":"continue"}"#));
        assert!(before.await.is_err());
        assert!(request.owner.cancelled.is_cancelled());
        assert!(control.release(nonce));
    }

    #[tokio::test]
    async fn import_poison_revokes_an_entered_callback_before_its_reply_can_dispatch() {
        let boundary = import_cleanup_boundary();
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        boundary.register_control(&control);
        let request = direct_request(control.clone(), "entered");
        *control.direct_turn.lock().unwrap() = Some(request.owner.clone());
        let mut before = Box::pin(request.before(response(json!({
            "type":"function_call", "call_id":"call", "name":"echo", "arguments":"{}",
        }))));
        assert!(futures_util::poll!(&mut before).is_pending());
        let notice = control.next().await.unwrap();
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(control.handoff(nonce));
        boundary.record_code_import_failure("uncertain receiver shutdown");
        assert!(!control.can_enter(nonce));
        assert!(!control.resolve(nonce, r#"{"action":"continue"}"#));
        assert!(before.await.is_err());
        assert!(request.owner.cancelled.is_cancelled());
        assert!(control.release(nonce));
    }

    #[tokio::test]
    async fn direct_stream_preserves_identity_shape_and_native_event_sequence() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let item = response(json!({
            "type":"function_call", "id":"fc_server", "call_id":"real-native-call",
            "name":"update_plan", "namespace":"functions",
            "arguments":"{\"plan\":[]}", "encrypted_function_args":[],
        }));
        let original = serde_json::to_value(&item).unwrap();
        let upstream = Box::pin(stream::iter(vec![
            Ok(ResponseEvent::Created {
                response_id: Some("real-provider".into()),
            }),
            Ok(ResponseEvent::OutputItemDone(item)),
            Ok(ResponseEvent::Created {
                response_id: Some("next-provider-event".into()),
            }),
        ]));
        let request = direct_request(control.clone(), "turn-a");
        // Later generations cannot relabel an in-flight model response.
        *request.owner.model.lock().unwrap() = Some("later-model".into());
        let mut intercepted = Box::new(request).intercept(upstream);
        assert!(matches!(
            intercepted.next().await,
            Some(Ok(ResponseEvent::Created { .. }))
        ));
        let edit = async {
            let req = control.next().await.unwrap();
            assert_eq!(req["request"]["route"], "direct");
            assert_eq!(req["request"]["turn_id"], "turn-a");
            assert_eq!(req["request"]["model"], "test-model");
            assert!(req["request"].get("agent_role").is_none());
            assert_eq!(req["request"]["call_id"], "real-native-call");
            assert!(control.resolve(
                req["nonce"].as_u64().unwrap(),
                r#"{"action":"replace","value":{"plan":[],"explanation":"effective"}}"#
            ));
        };
        let (event, ()) = tokio::join!(intercepted.next(), edit);
        let Some(Ok(ResponseEvent::OutputItemDone(item))) = event else {
            panic!("missing actual item")
        };
        let mut actual = serde_json::to_value(item).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(actual["arguments"].as_str().unwrap()).unwrap(),
            json!({"plan":[],"explanation":"effective"})
        );
        assert!(actual["id"].is_null());
        actual["id"] = original["id"].clone();
        actual["arguments"] = original["arguments"].clone();
        assert_eq!(actual, original); // Preserve encrypted flags, call id, name, namespace and metadata.
        assert!(matches!(
            intercepted.next().await,
            Some(Ok(ResponseEvent::Created { .. }))
        ));
        assert!(intercepted.next().await.is_none());
    }

    // The boundary cannot produce real provider ciphertext. Exercise native
    // metadata semantics here with opaque stand-ins that never reach a handler.
    // Native integration covers actual plaintext [] dispatch and rejected
    // collaboration edits without a plaintext marker.
    #[tokio::test]
    async fn encrypted_function_replacements_preserve_named_and_implicit_fields() {
        for (metadata, value, accepted) in [
            (
                json!(["message"]),
                json!({"task_name":"new","message":"opaque"}),
                true,
            ),
            (
                json!(["message"]),
                json!({"task_name":"old","message":"edited"}),
                false,
            ),
            (json!(["message"]), json!({"task_name":"old"}), false),
            (
                json!(["message"]),
                json!({"task_name":"old","message":null}),
                false,
            ),
            // Core assumes message encryption even if only another arg is
            // listed. Never infer message plaintext from a nonempty list.
            (
                json!(["task_name"]),
                json!({"task_name":"old","message":"edited"}),
                false,
            ),
            (
                json!(["task_name"]),
                json!({"task_name":"new","message":"opaque"}),
                false,
            ),
            (
                Value::Null,
                json!({"task_name":"new","message":"opaque"}),
                true,
            ),
            (
                Value::Null,
                json!({"task_name":"old","message":"edited"}),
                false,
            ),
            (
                json!([]),
                json!({"task_name":"new","message":"edited"}),
                true,
            ),
        ] {
            let control = Arc::new(Control::new("root".into(), true));
            control.enable(3.0, Scope::Root).unwrap();
            let item = response(json!({
                "type":"function_call", "id":"fc_original", "call_id":"original",
                "name":"spawn_agent", "namespace":"collaboration",
                "arguments":r#"{"task_name":"old","message":"opaque"}"#,
                "encrypted_function_args":metadata,
            }));
            let original = serde_json::to_value(&item).unwrap();
            let request = direct_request(control.clone(), "turn");
            let edit = async {
                let req = control.next().await.unwrap();
                assert!(control.resolve(
                    req["nonce"].as_u64().unwrap(),
                    &json!({"action":"replace","value":value}).to_string(),
                ));
            };
            let (result, ()) = tokio::join!(request.before(item), edit);
            if accepted {
                let mut actual = serde_json::to_value(result.unwrap()).unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(actual["arguments"].as_str().unwrap()).unwrap(),
                    value
                );
                assert!(actual["id"].is_null());
                actual["id"] = original["id"].clone();
                actual["arguments"] = original["arguments"].clone();
                assert_eq!(actual, original);
            } else {
                assert!(
                    matches!(result, Err(ModelResponseError::InvalidRequest { message })
                    if message == FAILURE)
                );
            }
        }
    }

    #[tokio::test]
    async fn continue_never_parses_protected_arguments() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let item = response(json!({
            "type":"function_call","call_id":"unchanged","name":"send_message",
            "namespace":"collaboration", "arguments":"not JSON",
            "encrypted_function_args":["message"],
        }));
        let original = serde_json::to_value(&item).unwrap();
        let request = direct_request(control.clone(), "turn");
        let proceed = async {
            let req = control.next().await.unwrap();
            assert!(control.resolve(req["nonce"].as_u64().unwrap(), r#"{"action":"continue"}"#));
        };
        let (result, ()) = tokio::join!(request.before(item), proceed);
        assert_eq!(serde_json::to_value(result.unwrap()).unwrap(), original);
    }

    #[tokio::test]
    async fn deny_stops_only_our_stream_original_errors_do_not_invent_completion() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let upstream = Box::pin(stream::iter(vec![
            Err(ModelResponseError::InvalidRequest {
                message: "original-provider-error".into(),
            }),
            Ok(ResponseEvent::OutputItemDone(response(json!({
                "type":"custom_tool_call", "call_id":"cm", "name":"exec", "input":"text(1)",
            })))),
            Ok(ResponseEvent::Created {
                response_id: Some("must-not-surface".into()),
            }),
        ]));
        let mut intercepted =
            Box::new(direct_request(control.clone(), "turn-a")).intercept(upstream);
        assert!(
            matches!(intercepted.next().await, Some(Err(ModelResponseError::InvalidRequest { message }))
            if message == "original-provider-error")
        );
        let deny = async {
            let req = control.next().await.unwrap();
            assert_eq!(req["request"]["tool_kind"], "freeform");
            assert!(control.resolve(req["nonce"].as_u64().unwrap(), r#"{"action":"deny"}"#));
        };
        let (event, ()) = tokio::join!(intercepted.next(), deny);
        assert!(
            matches!(event, Some(Err(ModelResponseError::InvalidRequest { message })) if message == FAILURE)
        );
        assert!(intercepted.next().await.is_none());
    }

    #[tokio::test]
    async fn turn_retirement_and_dropped_stream_cancel_python_reservations() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let request = direct_request(control.clone(), "old-turn");
        let retired = request.owner.cancelled.clone();
        let upstream = Box::pin(stream::iter(vec![Ok(ResponseEvent::OutputItemDone(
            response(json!({
                "type":"function_call", "call_id":"same-id", "name":"update_plan", "arguments":"{}"
            })),
        ))]));
        let mut intercepted = Box::new(request).intercept(upstream);
        let cancel = async {
            let req = control.next().await.unwrap();
            retired.cancel();
            let end = control.next().await.unwrap();
            let nonce = req["nonce"].as_u64().unwrap();
            assert_eq!(end["cancel"], nonce);
            assert!(!control.resolve(nonce, r#"{"action":"replace","value":{}}"#));
        };
        let (event, ()) = tokio::join!(intercepted.next(), cancel);
        assert!(matches!(
            event,
            Some(Err(ModelResponseError::InvalidRequest { .. }))
        ));

        let next_request = direct_request(control.clone(), "next-turn");
        let upstream = Box::pin(stream::iter(vec![Ok(ResponseEvent::OutputItemDone(
            response(json!({
                "type":"function_call", "call_id":"same-id", "name":"update_plan", "arguments":"{}"
            })),
        ))]));
        let mut fresh = Box::new(next_request).intercept(upstream);
        let mut in_progress = Box::pin(fresh.next());
        let nonce = tokio::select! {
            _ = &mut in_progress => panic!("callback did not await"),
            msg = control.next() => {
                let msg = msg.unwrap();
                assert_eq!(msg["request"]["turn_id"], "next-turn");
                msg["nonce"].as_u64().unwrap()
            }
        };
        drop(in_progress);
        drop(fresh); // same as native mapper cancelling on consumer drop
        assert_eq!(control.next().await.unwrap()["cancel"], nonce);
        assert!(!control.resolve(nonce, r#"{"action":"continue"}"#));
    }

    #[tokio::test]
    async fn client_search_validates_replacement_but_does_not_gate_server_or_missing_id() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let request = direct_request(control.clone(), "turn-search");
        for value in [
            json!({"type":"tool_search_call","call_id":"server","execution":"server","arguments":{"query":"x"}}),
            json!({"type":"tool_search_call","execution":"client","arguments":{"query":"x"}}),
            json!({"type":"web_search_call","status":"completed","action":{"type":"search","query":"x"}}),
        ] {
            let input = response(value);
            let before = serde_json::to_value(&input).unwrap();
            let out = request.before(input).await.unwrap();
            assert_eq!(serde_json::to_value(out).unwrap(), before);
        }
        let client = response(json!({
            "type":"tool_search_call","call_id":"real-search","execution":"client",
            "arguments":{"query":"old","limit":1}
        }));
        let edit = async {
            let req = control.next().await.unwrap();
            assert_eq!(req["request"]["tool_kind"], "tool_search");
            assert_eq!(req["request"]["input"], json!({"query":"old","limit":1}));
            assert!(control.resolve(
                req["nonce"].as_u64().unwrap(),
                r#"{"action":"replace","value":{"query":23,"limit":-1}}"#
            ));
        };
        let (event, ()) = tokio::join!(request.before(client), edit);
        assert!(matches!(
            event,
            Err(ModelResponseError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn direct_edit_keeps_native_success_identity_and_external_context() {
        let payload = ToolPayload::Function {
            arguments: r#"{"path":"file"}"#.into(),
        };
        let output = EditedOutput {
            original: Box::new(
                codex_tools::JsonToolOutput::with_success(json!("original"), Some(false))
                    .with_external_context(),
            ),
            value: json!("edited"),
            body: None,
        };
        assert!(!output.success_for_logging());
        assert!(output.contains_external_context());
        // Logging remains the original diagnostic, and is never the edited
        // authoritative value supplied to Core.
        assert_eq!(output.log_output(), r#""original""#);
        let ResponseInputItem::FunctionCallOutput {
            call_id,
            output: response,
        } = output.to_response_item("native-call-id", &payload)
        else {
            panic!("wrong response kind");
        };
        assert_eq!(call_id, "native-call-id");
        assert_eq!(response.success, Some(false));
        assert_eq!(response.body.to_text().unwrap(), r#""edited""#);
        assert_eq!(
            output.post_tool_use_response("native-call-id", &payload),
            Some(json!("edited"))
        );
    }

    struct Actual(AtomicUsize);
    impl CodeModeSessionDelegate for Actual {
        fn invoke_tool<'a>(
            &'a self,
            inv: CodeModeNestedToolCall,
            _: CancellationToken,
        ) -> ToolInvocationFuture<'a> {
            Box::pin(async move {
                self.0.fetch_add(1, Ordering::SeqCst);
                assert_eq!(inv.input, Some(json!({"plan":"effective"})));
                Ok(json!({"from_actual":true}))
            })
        }
        fn notify<'a>(
            &'a self,
            _: String,
            _: CellId,
            _: String,
            _: CancellationToken,
        ) -> NotificationFuture<'a> {
            Box::pin(async { Ok(()) })
        }
        fn cell_closed(&self, _: &CellId) {}
    }

    #[tokio::test]
    async fn empty_mcp_enrollment_does_not_add_post_effect_byte_accounting() {
        let control = Arc::new(Control::with_budget("ordinary".into(), true, 1));
        control.enable(3.0, Scope::ThreadTree).unwrap();
        control.configure_tools(Vec::new()).unwrap();
        let actual = Arc::new(Actual(AtomicUsize::new(0)));
        let delegate = Delegate {
            profile_source: None,
            rules: None,
            cell_owner: Mutex::new(None),
            turn: None,
            live: Arc::new(AtomicBool::new(true)),
            inner: actual.clone(),
            control: Some(control.clone()),
            native_control: None,
            turn_id: "turn".into(),
            model: None,
            outer_call_id: "outer".into(),
        };
        let result = delegate
            .invoke_tool(
                CodeModeNestedToolCall {
                    cell_id: CellId::new("cell".into()),
                    runtime_tool_call_id: "nested".into(),
                    tool_name: ToolName::new(Some("mcp__fixture".to_owned()), "lookup"),
                    tool_kind: CodeModeToolKind::Function,
                    input: Some(json!({"plan":"effective"})),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result, json!({"from_actual":true}));
        assert_eq!(actual.0.load(Ordering::SeqCst), 1);
        assert_eq!(control.channel.bytes.available_permits(), 1);
        assert!(control.channel.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn delegate_awaits_actual_once_before_returning_edited_result() {
        let control = Arc::new(Control::new("thread-a".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let actual = Arc::new(Actual(AtomicUsize::new(0)));
        control.agent_role.set(Some("researcher".into())).unwrap();
        let delegate = Delegate {
            profile_source: None,
            rules: None,
            cell_owner: Mutex::new(None),
            turn: None,
            live: Arc::new(AtomicBool::new(true)),
            inner: actual.clone(),
            control: Some(control.clone()),
            native_control: None,
            turn_id: "turn-a".into(),
            model: Some("cell-model".into()),
            outer_call_id: "model-exec".into(),
        };
        let invocation = CodeModeNestedToolCall {
            cell_id: CellId::new("cell-a".into()),
            runtime_tool_call_id: "rpc-a".into(),
            tool_name: ToolName::plain("update_plan"),
            tool_kind: CodeModeToolKind::Function,
            input: Some(json!({"plan":"old"})),
        };
        let owner = async {
            let before = control.next().await.unwrap();
            assert_eq!(before["request"]["boundary"], "pre_dispatch");
            assert_eq!(before["request"]["call_id"], Value::Null);
            assert_eq!(before["request"]["runtime_tool_call_id"], "rpc-a");
            assert_eq!(before["request"]["model"], "cell-model");
            assert_eq!(before["request"]["agent_role"], "researcher");
            assert_eq!(actual.0.load(Ordering::SeqCst), 0);
            assert!(control.resolve(
                before["nonce"].as_u64().unwrap(),
                r#"{"action":"replace","value":{"plan":"effective"}}"#
            ));
            let cancel = control.next().await.unwrap();
            assert!(cancel.get("cancel").is_some());
            let after = control.next().await.unwrap();
            assert_eq!(actual.0.load(Ordering::SeqCst), 1);
            assert_eq!(after["request"]["result"], json!({"from_actual":true}));
            assert_eq!(after["request"]["input"], json!({"plan":"effective"}));
            assert_eq!(after["request"]["model"], "cell-model");
            assert_eq!(after["request"]["agent_role"], "researcher");
            assert!(control.resolve(
                after["nonce"].as_u64().unwrap(),
                r#"{"action":"replace","value":{"receipt":"consumer"}}"#
            ));
        };
        let token = CancellationToken::new();
        let (result, ()) = tokio::join!(delegate.invoke_tool(invocation, token), owner);
        assert_eq!(result.unwrap(), json!({"receipt":"consumer"}));
        assert_eq!(actual.0.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_and_revoke_reject_stale_replies() {
        let control = Arc::new(Control::new("thread-a".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let token = CancellationToken::new();
        let owner = async {
            let request = control.next().await.unwrap();
            token.cancel();
            let cancel = control.next().await.unwrap();
            let nonce = request["nonce"].as_u64().unwrap();
            assert_eq!(cancel["cancel"], nonce);
            assert!(!control.resolve(nonce, r#"{"action":"replace","value":"late"}"#));
        };
        let (result, ()) = tokio::join!(control.decide(json!({}), &token), owner);
        assert!(result.is_err());
        control.revoke();
        assert!(control.decide(json!({}), &token).await.is_err());
    }
}

#[cfg(test)]
mod mcp_policy_tests {
    use super::*;

    fn setup() -> (Boundary, Arc<Control>) {
        let boundary = Boundary::new(
            Arc::new(crate::storage::MemoryAgentGraph::default()),
            Arc::new(RwLock::new(None)),
        );
        let root = Arc::new(Control::new("root".into(), true));
        root.enable(3.0, Scope::ThreadTree).unwrap();
        root.configure_tools(Vec::new()).unwrap();
        boundary.register_control(&root);
        (boundary, root)
    }
    fn rules(generation: u64) -> Vec<ToolRule> {
        serde_json::from_value(json!([{"name":"lookup", "namespace":"mcp__fixture",
            "timeout":null,"scope":"thread_tree","generation":generation.to_string()}]))
        .unwrap()
    }
    fn input() -> Value {
        json!({"phase":"before","tool_name":{"namespace":"mcp__fixture","name":"lookup"},"input":{"key":"old"}})
    }
    #[tokio::test]
    async fn mcp_reservation_captures_exact_generation_and_blocks_rebinding_until_physical_release()
    {
        let (boundary, root) = setup();
        let generation = 9_007_199_254_740_993;
        McpPublication::begin(&boundary, root.clone(), rules(generation), generation)
            .unwrap()
            .unwrap()
            .commit()
            .unwrap();
        let token = CancellationToken::new();
        let mut call = Box::pin(root.decide(input(), &token));
        assert!(futures_util::poll!(&mut call).is_pending());
        let notice = root.next().await.unwrap();
        assert_eq!(notice["generation"].as_u64(), Some(generation));
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(root.handoff(nonce));
        assert!(root.resolve(nonce, r#"{"action":"continue"}"#));
        assert!(matches!(call.await, Ok(Decision::Continue)));
        assert!(
            McpPublication::begin(
                &boundary,
                root.clone(),
                rules(generation + 1),
                generation + 1
            )
            .is_err()
        );
        assert!(root.release(nonce));
        assert!(!root.resolve(nonce, r#"{"action":"continue"}"#));
        McpPublication::begin(
            &boundary,
            root.clone(),
            rules(generation + 1),
            generation + 1,
        )
        .unwrap()
        .unwrap()
        .commit()
        .unwrap();
    }
    #[tokio::test]
    async fn policy_free_publication_keeps_legacy_admission_with_live_child_and_physical_callback()
    {
        let (boundary, root) = setup();
        root.configure_tools(serde_json::from_value(json!([{"name":"exec_command","namespace":"functions","timeout":null,"scope":"root"}])).unwrap()).unwrap();
        let child = Arc::new(Control::descendant("child".into(), &root));
        boundary.register_control(&child);
        let token = CancellationToken::new();
        let mut call = Box::pin(root.decide(
            json!({"tool_name":{"name":"exec_command","namespace":"functions"}}),
            &token,
        ));
        assert!(futures_util::poll!(&mut call).is_pending());
        let notice = root.next().await.unwrap();
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(root.handoff(nonce));
        assert!(
            McpPublication::begin(&boundary, root.clone(), Vec::new(), 1)
                .unwrap()
                .is_none()
        );
        assert!(root.has_legacy_policy());
        assert!(!root.has_mcp_policy());
        assert!(root.resolve(nonce, r#"{"action":"continue"}"#));
        assert!(matches!(call.await, Ok(Decision::Continue)));
        assert!(root.release(nonce));
    }
    #[test]
    fn captured_old_policy_clear_keeps_publication_fencing_and_rollback() {
        let (boundary, root) = setup();
        let rules = Control::compile_rules(rules(1)).unwrap();
        let policy = Arc::new(ProfileMcpPolicy {
            identities: HashMap::new(),
            names: rules.keys().cloned().collect(),
            rules,
        });
        let source = Arc::new(ProfileMcpSource {
            result_selection: None,
            receipt: None,
            policy: Some(policy.clone()),
        });
        let name = policy.names.iter().next().unwrap();
        assert!(!root.has_mcp_policy());
        assert!(root.mcp_selected_for(name, Some(&source)).unwrap());
        let guard = McpPublication::begin_with_profile(
            &boundary,
            root.clone(),
            Vec::new(),
            2,
            Some(&policy),
        )
        .unwrap()
        .unwrap();
        assert!(root.mcp_selected_for(name, Some(&source)).is_err());
        guard.rollback();
        assert!(
            root.channel
                .state
                .lock()
                .unwrap()
                .tools
                .as_ref()
                .is_some_and(|rules| rules.is_empty())
        );
        assert!(root.mcp_selected_for(name, Some(&source)).unwrap());
        let child = Arc::new(Control::descendant("child".into(), &root));
        boundary.register_control(&child);
        assert!(
            McpPublication::begin_with_profile(
                &boundary,
                root.clone(),
                Vec::new(),
                2,
                Some(&policy),
            )
            .is_err()
        );
        child.revoke();
        McpPublication::begin_with_profile(&boundary, root.clone(), Vec::new(), 2, Some(&policy))
            .unwrap()
            .unwrap()
            .commit()
            .unwrap();
        assert!(!root.has_mcp_policy());
        assert!(root.mcp_selected_for(name, Some(&source)).unwrap());
        drop(
            McpPublication::begin_with_profile(
                &boundary,
                root.clone(),
                Vec::new(),
                3,
                Some(&policy),
            )
            .unwrap()
            .unwrap(),
        );
        assert!(root.mcp_selected_for(name, Some(&source)).is_err());
    }

    #[test]
    fn removal_of_last_policy_is_guarded_then_returns_to_legacy_admission() {
        let (boundary, root) = setup();
        McpPublication::begin(&boundary, root.clone(), rules(1), 1)
            .unwrap()
            .unwrap()
            .commit()
            .unwrap();
        let child = Arc::new(Control::descendant("child".into(), &root));
        boundary.register_control(&child);
        assert!(McpPublication::begin(&boundary, root.clone(), Vec::new(), 2).is_err());
        assert!(root.has_mcp_policy());
        child.revoke();
        McpPublication::begin(&boundary, root.clone(), Vec::new(), 2)
            .unwrap()
            .unwrap()
            .commit()
            .unwrap();
        assert!(!root.has_mcp_policy());
        assert!(
            McpPublication::begin(&boundary, root, Vec::new(), 3)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn native_agents_policies_can_be_added_replaced_and_removed_without_children() {
        let (boundary, root) = setup();
        assert!(
            root.native_agents
                .set(Arc::new(crate::native_agents::Policy {
                    roles: Vec::new(),
                    managed_tools: Vec::new(),
                    max_depth: 1,
                    inherited_instructions: None,
                    allowed: Default::default(),
                }))
                .is_ok()
        );
        assert!(
            McpPublication::begin(&boundary, root.clone(), Vec::new(), 0)
                .unwrap()
                .is_none()
        );
        for generation in [1, 2] {
            McpPublication::begin(&boundary, root.clone(), rules(generation), generation)
                .unwrap()
                .unwrap()
                .commit()
                .unwrap();
            assert!(root.has_mcp_policy());
        }
        McpPublication::begin(&boundary, root.clone(), Vec::new(), 3)
            .unwrap()
            .unwrap()
            .commit()
            .unwrap();
        assert!(!root.has_mcp_policy());
    }

    #[tokio::test]
    async fn mcp_rules_do_not_reenter_before_on_generated_after_notice() {
        let (boundary, root) = setup();
        McpPublication::begin(&boundary, root.clone(), rules(1), 1)
            .unwrap()
            .unwrap()
            .commit()
            .unwrap();
        let mut request = input();
        request["phase"] = json!("after");
        assert!(matches!(
            root.decide(request, &CancellationToken::new()).await,
            Ok(Decision::Continue)
        ));
        assert!(root.channel.state.lock().unwrap().pending.is_empty());
    }
    #[tokio::test]
    async fn rollback_restores_rules_but_dropped_or_conflicted_publication_stays_fenced() {
        let (boundary, root) = setup();
        McpPublication::begin(&boundary, root.clone(), rules(1), 1)
            .unwrap()
            .unwrap()
            .rollback();
        assert!(!root.has_mcp_policy());
        let guard = McpPublication::begin(&boundary, root.clone(), rules(2), 2)
            .unwrap()
            .unwrap();
        let child = Arc::new(Control::descendant("birth".into(), &root));
        boundary.register_control(&child);
        assert!(guard.commit().is_err());
        assert!(
            root.decide(input(), &CancellationToken::new())
                .await
                .is_err()
        );
        let (other_boundary, other) = setup();
        drop(
            McpPublication::begin(&other_boundary, other.clone(), rules(1), 1)
                .unwrap()
                .unwrap(),
        );
        assert!(
            other
                .decide(json!({"unmatched":true}), &CancellationToken::new())
                .await
                .is_err()
        );
    }
    fn request(control: Arc<Control>) -> DirectRequest {
        let admission = test_tool_admission(&control.id, "turn", None);
        DirectRequest {
            owner: admission.turn_store().get::<DirectTurn>().unwrap(),
            tool_admission: Some(admission),
            control,
            model: "fixture-model".into(),
            command_admission: None,
        }
    }
    fn call(arguments: &str) -> ResponseItem {
        serde_json::from_value(
            json!({"type":"function_call","id":"provider-item","call_id":"provider-call",
            "name":"lookup","namespace":"mcp__fixture","arguments":arguments}),
        )
        .unwrap()
    }
    fn active() -> ResponseItem {
        serde_json::from_value(
            json!({"type":"message","id":"active-message","role":"assistant",
            "content":[{"type":"output_text","text":"display"}]}),
        )
        .unwrap()
    }
    async fn edit(control: &Control, replacement: Value) {
        let notice = control.next().await.unwrap();
        let nonce = notice["nonce"].as_u64().unwrap();
        assert!(control.handoff(nonce));
        assert!(control.resolve(
            nonce,
            &json!({"action":"replace","value":replacement}).to_string()
        ));
        assert!(control.release(nonce));
    }
    #[tokio::test]
    async fn equal_replacement_preserves_provider_id_and_argument_bytes() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let original = call("{ \"key\" : \"old\" }");
        let expected = serde_json::to_value(&original).unwrap();
        let req = request(control.clone());
        let (actual, ()) = tokio::join!(req.before(original), edit(&control, json!({"key":"old"})));
        assert_eq!(serde_json::to_value(actual.unwrap()).unwrap(), expected);
    }
    #[tokio::test]
    async fn edited_done_waits_for_real_active_done_then_keeps_call_id_and_order() {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let initial = control.channel.bytes.available_permits();
        control.configure_tools(serde_json::from_value(json!([{"name":"lookup","namespace":"mcp__fixture","timeout":3,"scope":"root"}])).unwrap()).unwrap();
        let unrelated = serde_json::from_value(json!({"type":"function_call","id":"unrelated-item","call_id":"unrelated-call","name":"unselected","arguments":"{}"})).unwrap();
        let upstream = Box::pin(stream::iter(vec![
            Ok(ResponseEvent::OutputItemAdded(active())),
            Ok(ResponseEvent::OutputItemDone(unrelated)),
            Ok(ResponseEvent::OutputItemDone(call(r#"{"key":"old"}"#))),
            Ok(ResponseEvent::OutputItemDone(active())),
        ]));
        let mut output = Box::new(request(control.clone())).intercept(upstream);
        assert!(matches!(
            output.next().await,
            Some(Ok(ResponseEvent::OutputItemAdded(_)))
        ));
        let Some(Ok(ResponseEvent::OutputItemDone(unrelated))) = output.next().await else {
            panic!("unselected call missing")
        };
        assert_eq!(
            serde_json::to_value(unrelated).unwrap()["id"],
            "unrelated-item"
        );
        // An unrelated Done must not mark the display item's active slot complete.
        let (done, ()) = tokio::join!(output.next(), edit(&control, json!({"key":"new"})));
        let Some(Ok(ResponseEvent::OutputItemDone(item))) = done else {
            panic!("active Done missing")
        };
        assert_eq!(serde_json::to_value(item).unwrap()["id"], "active-message");
        let Some(Ok(ResponseEvent::OutputItemDone(item))) = output.next().await else {
            panic!("edited call missing")
        };
        let item = serde_json::to_value(item).unwrap();
        assert!(item["id"].is_null());
        assert_eq!(item["call_id"], "provider-call");
        assert_eq!(
            serde_json::from_str::<Value>(item["arguments"].as_str().unwrap()).unwrap(),
            json!({"key":"new"})
        );
        assert_eq!(control.channel.bytes.available_permits(), initial);
    }
    #[tokio::test]
    async fn deferred_byte_and_count_overflow_reject_without_waiting_for_active_done() {
        for count_overflow in [false, true] {
            let control = Arc::new(Control::with_budget(
                "root".into(),
                true,
                if count_overflow { 1_000_000 } else { 2048 },
            ));
            control.enable(3.0, Scope::Root).unwrap();
            let initial = control.channel.bytes.available_permits();
            let (tx, rx) = mpsc::unbounded_channel();
            tx.send(Ok(ResponseEvent::OutputItemAdded(active())))
                .unwrap();
            tx.send(Ok(ResponseEvent::OutputItemDone(call(r#"{"key":"old"}"#))))
                .unwrap();
            for _ in 0..if count_overflow { MAX_PENDING } else { 1 } {
                tx.send(Ok(ResponseEvent::OutputItemDone(call(&json!({"key":if count_overflow { "small".to_owned() } else { "x".repeat(4096) }}).to_string())))).unwrap();
            }
            // Keep tx open: no active Done, EOF or capacity release can unblock a wait.
            let upstream = Box::pin(stream::unfold(rx, |mut rx| async move {
                rx.recv().await.map(|item| (item, rx))
            }));
            let mut output = Box::new(request(control.clone())).intercept(upstream);
            output.next().await.unwrap().unwrap();
            let (failed, ()) = tokio::time::timeout(Duration::from_secs(3), async {
                tokio::join!(output.next(), edit(&control, json!({"key":"new"})))
            })
            .await
            .expect("capacity must fail, not wait for active Done");
            assert!(failed.unwrap().is_err());
            assert_eq!(control.channel.bytes.available_permits(), initial);
            drop(tx);
        }
    }
    #[tokio::test]
    async fn queued_stream_cancellation_wakes_a_pending_peer_and_borrowed_next_does_not_release_storage()
     {
        let control = Arc::new(Control::new("root".into(), true));
        control.enable(3.0, Scope::Root).unwrap();
        let initial = control.channel.bytes.available_permits();
        let req = request(control.clone());
        let cancelled = req.owner.cancelled.clone();
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(Ok(ResponseEvent::OutputItemAdded(active())))
            .unwrap();
        tx.send(Ok(ResponseEvent::OutputItemDone(call(r#"{"key":"old"}"#))))
            .unwrap();
        let upstream = Box::pin(stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        }));
        let mut output = Box::new(req).intercept(upstream);
        output.next().await.unwrap().unwrap();
        let mut next = Box::pin(output.next());
        assert!(futures_util::poll!(&mut next).is_pending());
        edit(&control, json!({"key":"new"})).await;
        assert!(futures_util::poll!(&mut next).is_pending());
        drop(next);
        assert!(control.channel.bytes.available_permits() < initial);
        cancelled.cancel();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), output.next())
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_eq!(control.channel.bytes.available_permits(), initial);
        drop(output);
        drop(tx);
    }
    #[test]
    fn child_creation_trace_retains_raw_parent_without_sdk_policy() {
        for flags in ["02", "03"] {
            let original = codex_protocol::protocol::W3cTraceContext {
                traceparent: Some(format!(
                    "00-11111111111111111111111111111111-2222222222222222-{flags}"
                )),
                tracestate: Some("tenant=original".into()),
            };
            let attached = codex_otel::context_from_w3c_trace_context(&original)
                .unwrap()
                .attach();
            let control = Control::new("original-child".into(), false);
            let _ = control
                .creation_trace
                .set(codex_otel::current_span_w3c_trace_context());
            assert!(control.creation_tracing().is_none());
            drop(attached);
            let unrelated = codex_protocol::protocol::W3cTraceContext {
                traceparent: Some("00-33333333333333333333333333333333-4444444444444444-01".into()),
                tracestate: Some("tenant=unrelated".into()),
            };
            let _attached = codex_otel::context_from_w3c_trace_context(&unrelated)
                .unwrap()
                .attach();
            let retained = control.creation_trace().unwrap().unwrap();
            assert_eq!(retained.traceparent, original.traceparent);
            assert_eq!(retained.tracestate, original.tracestate);
            assert!(
                Control::new("another-child".into(), false)
                    .creation_trace()
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[tokio::test]
    async fn child_receipt_retains_original_tracing_after_origin_scope_ends() {
        const CHILD: &str = "AGENTS_CHILD_RECEIPT_TRACE_TEST";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "native_interception::mcp_policy_tests::child_receipt_retains_original_tracing_after_origin_scope_ends"]).env(CHILD, "1").status().unwrap();
            assert!(status.success());
            return;
        }
        codex_otel::sdk_trace::configure_pipeline(false);
        let original: serde_json::Value = serde_json::from_str(&codex_otel::sdk_trace::start_trace_span(
            r#"{"name":"origin","kind":"workflow","trace_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","disabled":true,"include_sensitive_data":false}"#,
        ).unwrap()).unwrap();
        let handle = original["handle"].as_str().unwrap();
        let attached = codex_otel::sdk_trace::context(handle).unwrap().attach();
        let thread = ExtensionData::new("thread");
        let turn = ExtensionData::new("original");
        let session = ExtensionData::new("session");
        let control = thread.get_or_init(|| Control::new("thread".into(), false));
        let _ = control
            .creation_tracing
            .set(codex_otel::sdk_trace::CapturedContext::capture().context);
        let _ = control
            .creation_trace
            .set(Some(codex_protocol::protocol::W3cTraceContext {
                traceparent: Some("00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-03".into()),
                tracestate: None,
            }));
        let mode = serde_json::from_value(serde_json::json!({"mode":"default", "settings":{"model":"test","reasoning_effort":null,"developer_instructions":null}})).unwrap();
        crate::turn_settlement::Contributor
            .on_turn_start(TurnStartInput {
                turn_id: "original",
                collaboration_mode: &mode,
                token_usage_at_turn_start: None,
                session_store: &session,
                thread_store: &thread,
                turn_store: &turn,
            })
            .await;
        let receipt = turn.get::<crate::turn_settlement::Turn>().unwrap();
        let creation = control.creation_tracing().unwrap();
        let tracing = receipt.tracing.as_ref().unwrap().clone();
        drop(attached);
        codex_otel::sdk_trace::end_trace_span(handle, r#"{"status":"ok"}"#).unwrap();
        codex_otel::sdk_trace::release_trace_span(handle);
        let unrelated: serde_json::Value = serde_json::from_str(&codex_otel::sdk_trace::start_trace_span(
            r#"{"name":"unrelated","kind":"workflow","trace_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","include_sensitive_data":true}"#,
        ).unwrap()).unwrap();
        let unrelated_handle = unrelated["handle"].as_str().unwrap();
        let _unrelated = codex_otel::sdk_trace::context(unrelated_handle)
            .unwrap()
            .attach();
        assert!(
            control
                .creation_trace()
                .unwrap()
                .unwrap()
                .traceparent
                .as_deref()
                .unwrap()
                .starts_with("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-")
        );
        for owner in [creation, tracing] {
            let snapshot: serde_json::Value = serde_json::from_str(
                &codex_otel::sdk_trace::trace_span_context(owner.token()).unwrap(),
            )
            .unwrap();
            assert_eq!(snapshot["trace_id"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            assert_eq!(snapshot["disabled"], true);
            assert_eq!(snapshot["include_sensitive_data"], false);
        }
        codex_otel::sdk_trace::release_trace_span(unrelated_handle);
    }
}

#[cfg(test)]
#[path = "direct_transport_tests.rs"]
mod direct_http_transport_tests;

impl Boundary {
    fn context_tools(&self, thread: &str) -> Option<Arc<crate::python_tools::PythonTools>> {
        self.threads
            .lock()
            .expect("interception index poisoned")
            .get(thread)?
            .upgrade()?
            .context_tools
            .get()?
            .upgrade()
    }
}

/// Shares the existing native model callback admission and physical join ledger.
#[derive(Debug)]
pub(crate) struct ModelProducerBoundary(pub(crate) Arc<Boundary>);
impl ModelRequestContributor for ModelProducerBoundary {
    fn request(&self, input: ModelRequestInput<'_>) -> Option<Box<dyn ModelResponseInterceptor>> {
        let tools = self.0.context_tools(input.thread_id)?;
        if !tools.produces_model_response() {
            return None;
        }
        Some(Box::new(ModelProducerRequest(
            tools,
            input.model.to_owned(),
        )))
    }
}
struct ModelProducerRequest(Arc<crate::python_tools::PythonTools>, String);
impl ModelResponseInterceptor for ModelProducerRequest {
    fn produces_response(&self) -> bool {
        true
    }
    fn produce_response<'a>(
        &'a self,
        request: Value,
        admission: Option<Arc<dyn ModelToolAdmission>>,
    ) -> Option<futures_util::future::BoxFuture<'a, Result<ModelResponseStream, String>>> {
        let tools = self.0.clone();
        let model = self.1.clone();
        Some(Box::pin(async move {
            let admission = admission.ok_or("Native model producer requires request admission")?;
            tools
                .produce_model_response(&model, request, admission)
                .await
                .map_err(|_| "Native model producer failed or was cancelled".to_owned())
        }))
    }
    fn intercept(self: Box<Self>, stream: ModelResponseStream) -> ModelResponseStream {
        stream
    }
}

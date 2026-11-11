//! Opt-in native MCP result editing, with exact child reply ownership.
use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use codex_config::McpServerConfig;
use codex_core_api::{Config, SessionSource, ThreadManager};
use codex_extension_api::{
    ExtensionData, ExtensionFuture, McpToolRequestMetadataInput, McpToolResultInput, McpToolSource,
    ThreadLifecycleContributor, ThreadStartInput, ThreadStopInput, ToolLifecycleContributor,
    ToolLifecycleFuture, TurnAbortInput, TurnLifecycleContributor, TurnStartInput, TurnStopInput,
};
use codex_protocol::mcp::CallToolResult;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio::time::Instant;

const MAX_REPLY: usize = 1024 * 1024;
const MAX_PENDING: usize = 32;
// Same private serialized bridge budget as native interception. A single
// notice may use it, but 32 concurrently retained notices must share it.
const MAX_BYTES: usize = 128 * 1024 * 1024;

#[derive(Serialize)]
struct Notice<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    tracing_context: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    route: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cell_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_tool_call_id: Option<&'a str>,
    nonce: u64,
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_epoch: Option<u64>,
    thread_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    incarnation: Option<&'a str>,
    turn_id: &'a str,
    call_id: &'a str,
    source: &'a str,
    server_name: &'a str,
    tool_name: &'a str,
    callable_namespace: &'a str,
    callable_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    realtime_tool_name: Option<String>,
    arguments: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<&'a CallToolResult>,
}

struct Counter {
    bytes: usize,
    limit: usize,
}

impl Write for Counter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(buf.len())
            .filter(|bytes| *bytes <= self.limit)
            .ok_or_else(|| io::Error::other("MCP notice budget exceeded"))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn withheld() -> CallToolResult {
    CallToolResult {
        content: vec![json!({"type":"text","text":"MCP result withheld"})],
        structured_content: None,
        is_error: Some(true),
        meta: None,
    }
}

// Require exactly the public result envelope; rmcp validates the content forms,
// field types and metadata. Keep the protocol fields after validation (no retyping
// arbitrary structured JSON or discarding harmless content extensions).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    content: Vec<Value>,
    #[serde(default)]
    structured_content: Option<Value>,
    #[serde(default)]
    is_error: Option<bool>,
    #[serde(default, rename = "_meta")]
    meta: Option<Value>,
}

pub(crate) fn validated(reply: &str) -> Option<CallToolResult> {
    if reply.len() > MAX_REPLY {
        return None;
    }
    let value: Envelope = serde_json::from_str(reply).ok()?;
    let _: rmcp::model::CallToolResult = serde_json::from_str(reply).ok()?;
    Some(CallToolResult {
        content: value.content,
        structured_content: value.structured_content,
        is_error: value.is_error,
        meta: value.meta,
    })
}

#[derive(Debug)]
enum AcceptedReply {
    Result {
        edited: CallToolResult,
        assignment: Option<oneshot::Sender<()>>,
    },
    Metadata(Result<serde_json::Map<String, Value>, ()>),
}

fn validated_metadata(reply: &str) -> Option<Result<serde_json::Map<String, Value>, ()>> {
    if reply.len() > MAX_REPLY {
        return None;
    }
    let value: Value = serde_json::from_str(reply).ok()?;
    let map = match value {
        Value::Bool(false) => return Some(Err(())),
        Value::Null => serde_json::Map::new(),
        Value::Object(map) => map,
        _ => return None,
    };
    map.keys()
        .all(|key| !codex_extension_api::is_reserved_mcp_request_metadata_key(key))
        .then_some(Ok(map))
}

struct Pending {
    turn_id: String,
    call_id: String,
    deadline: Instant,
    metadata: bool,
    is_cancelled: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    sender: Option<oneshot::Sender<Option<AcceptedReply>>>,
}

// Retaining a transport payload must not retain its native thread or reply
// authority. A callback can keep the serialized bytes after that owner stops.
struct Route {
    owner: Weak<McpResultControl>,
    payload: Payload,
    _bytes: OwnedSemaphorePermit,
    // Retain only the private trace context until exact physical return, never
    // the issuer or its reply authority. Queue discard releases it as well.
    _tracing: Option<codex_otel::sdk_trace::ContextLease>,
}

enum Payload {
    Queued(String),
    InFlight,
    Handed,
    Returned,
}

#[derive(Default)]
struct TurnResults {
    // Existing call nonce floor identifies this insertion without a new lifecycle.
    first_nonce: u64,
    count: usize,
    failed: bool,
}

/// SDK selection captured alongside the idle roster. Never persisted in Core config.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection {
    pub(crate) generation: u64,
    #[serde(default)]
    pub(crate) pre_policy: HashMap<String, Vec<String>>,
    servers: HashMap<String, HashMap<String, f64>>,
    #[serde(default)]
    metadata_servers: HashMap<String, Vec<String>>,
}

impl Selection {
    pub(crate) fn validate(&self, requested: &HashMap<String, McpServerConfig>) -> Result<()> {
        for (name, tools) in &self.pre_policy {
            ensure!(
                !tools.is_empty()
                    && requested
                        .get(name)
                        .is_some_and(|server| !crate::mcp_roster::enterprise(server)
                            && server.enabled
                            && tools.iter().all(|tool| server
                                .enabled_tools
                                .as_ref()
                                .is_some_and(|names| names.contains(tool)))),
                "MCP pre-policy must select admitted ordinary raw tool names"
            );
        }
        for (name, selected) in &self.servers {
            let server = requested.get(name);
            ensure!(
                server.is_some_and(|server| {
                    !crate::mcp_roster::enterprise(server)
                        && server.enabled
                        && selected.keys().all(|tool| {
                            server
                                .enabled_tools
                                .as_ref()
                                .is_some_and(|names| names.contains(tool))
                        })
                }),
                "MCP result policy must select admitted ordinary raw tool names"
            );
            ensure!(
                selected
                    .values()
                    .all(|timeout| timeout.is_finite() && *timeout > 0.0 && *timeout <= 3600.0),
                "Native MCP result timeout must be in (0, 3600] seconds"
            );
        }
        for (name, tools) in &self.metadata_servers {
            ensure!(
                requested.get(name).is_some_and(|server| {
                    !crate::mcp_roster::enterprise(server)
                        && server.enabled
                        && tools.iter().all(|tool| {
                            server
                                .enabled_tools
                                .as_ref()
                                .is_some_and(|names| names.contains(tool))
                        })
                }),
                "MCP metadata policy must select admitted ordinary raw tool names"
            );
        }
        Ok(())
    }
}

// A graph step owns its result policy even if another profile becomes active.
// None preserves the legacy non-graph global editor and selected roster path.
fn source_profile(
    thread: &ExtensionData,
    step: Option<&ExtensionData>,
) -> Result<Option<codex_extension_api::AgentProfileReceipt>> {
    if let Some(source) =
        step.and_then(|step| step.get::<crate::native_interception::ProfileMcpSource>())
    {
        return Ok(source.receipt.clone());
    }
    match thread.get::<crate::python_tools::PythonTools>() {
        Some(tools) => tools.source_profile(step),
        None => Ok(step
            .and_then(|step| step.get::<codex_extension_api::CapturedAgentProfile>())
            .map(|profile| profile.receipt.clone())),
    }
}

fn source_selection(
    thread: &ExtensionData,
    step: Option<&ExtensionData>,
) -> Result<(bool, Option<Arc<Selection>>)> {
    if let Some(source) =
        step.and_then(|step| step.get::<crate::native_interception::ProfileMcpSource>())
    {
        ensure!(
            source.policy.is_some(),
            "Missing captured MCP callback policy"
        );
        let selection = if source.receipt.is_none() {
            source.result_selection.clone()
        } else {
            step.and_then(|step| step.get::<Selection>())
        };
        ensure!(
            source.receipt.is_none() || selection.is_some(),
            "Missing captured Agent MCP result selection"
        );
        return Ok((true, selection));
    }
    if source_profile(thread, step)?.is_some() {
        return Ok((
            true,
            Some(
                step.and_then(|step| step.get::<Selection>())
                    .context("Missing captured Agent MCP result selection")?,
            ),
        ));
    }
    Ok((false, None))
}

fn inherits_result_source(inherits_tools: bool, spawning_step: Option<&ExtensionData>) -> bool {
    inherits_tools
        || spawning_step
            .and_then(|step| step.get::<crate::native_interception::ProfileMcpSource>())
            .is_some_and(|source| source.policy.is_some())
}

struct State {
    selection: Option<Selection>,
    timeout: Option<Duration>,
    revoked: bool,
    turn_seen: bool,
    routes: Arc<Mutex<HashMap<u64, Route>>>,
    pending: HashMap<u64, Pending>,
    // Created before queuing, even when JavaScript never receives a notice.
    // The matching terminal consumes pending or failed obligations.
    // Never clear on native turn-stop (it precedes the event).
    unresolved: HashMap<String, TurnResults>,
}

impl State {
    fn retire(&mut self, nonce: u64) -> Option<oneshot::Sender<Option<AcceptedReply>>> {
        let item = self.pending.get_mut(&nonce)?;
        let sender = item.sender.take();
        let mut routes = self.routes.lock().expect("MCP routes poisoned");
        if routes
            .get(&nonce)
            .is_none_or(|route| matches!(route.payload, Payload::Queued(_) | Payload::Returned))
        {
            self.pending.remove(&nonce);
            routes.remove(&nonce);
        }
        sender
    }
}

impl Drop for State {
    fn drop(&mut self) {
        // Also cover a thread whose stop lifecycle did not finish.
        for nonce in self.pending.keys().copied().collect::<Vec<_>>() {
            self.retire(nonce);
        }
    }
}

pub struct McpResultControl {
    id: String,
    instance: Option<String>,
    root: bool,
    state: Mutex<State>,
    channel: Arc<ResultChannel>,
}

struct ResultChannel {
    next_nonce: AtomicU64,
    routes: Arc<Mutex<HashMap<u64, Route>>>,
    members: RwLock<HashMap<String, Weak<McpResultControl>>>,
    sender: mpsc::Sender<(Weak<McpResultControl>, u64)>,
    receiver: AsyncMutex<mpsc::Receiver<(Weak<McpResultControl>, u64)>>,
    bytes: Arc<Semaphore>,
}

impl McpResultControl {
    pub(crate) fn check_context_idle(&self) -> Result<()> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| anyhow::anyhow!("native MCP result mutation is in progress"))?;
        ensure!(
            state.pending.is_empty() && state.unresolved.is_empty(),
            "supplied compaction requires settled native MCP result callbacks"
        );
        let routes = self
            .channel
            .routes
            .try_lock()
            .map_err(|_| anyhow::anyhow!("native MCP result route mutation is in progress"))?;
        ensure!(
            routes.is_empty(),
            "supplied compaction requires released native MCP result payloads"
        );
        Ok(())
    }

    pub(crate) fn capture_source_selection(&self) -> Option<Selection> {
        self.state
            .lock()
            .expect("MCP result control poisoned")
            .selection
            .clone()
    }

    pub(crate) fn owns_result(
        &self,
        thread: &ExtensionData,
        step: Option<&ExtensionData>,
        server: &str,
        tool: &str,
        configured: bool,
    ) -> bool {
        let (source_bound, captured) = match source_selection(thread, step) {
            Ok(value) => value,
            Err(_) => return true,
        };
        let state = self.state.lock().expect("MCP result control poisoned");
        match captured.as_deref().or_else(|| {
            (!source_bound)
                .then_some(state.selection.as_ref())
                .flatten()
        }) {
            Some(selection) => {
                configured
                    && selection
                        .servers
                        .get(server)
                        .is_some_and(|tools| tools.contains_key(tool))
            }
            None => !source_bound && state.timeout.is_some(),
        }
    }

    pub(crate) fn check_selection(&self, generation: u64) -> Result<()> {
        let state = self.state.lock().expect("MCP result control poisoned");
        ensure!(
            self.root && !state.revoked,
            "Selected MCP results require a live managed root"
        );
        ensure!(
            state
                .selection
                .as_ref()
                .is_none_or(|current| generation > current.generation),
            "MCP result selection generation must advance"
        );
        Ok(())
    }

    pub(crate) fn publish_selection(&self, selection: Selection) {
        self.state
            .lock()
            .expect("MCP result control poisoned")
            .selection = Some(selection);
    }

    fn new(id: String, root: bool) -> Self {
        Self::with_budget(id, root, MAX_BYTES)
    }

    fn with_budget(id: String, root: bool, bytes: usize) -> Self {
        let (sender, receiver) = mpsc::channel(MAX_PENDING);
        let channel = Arc::new(ResultChannel {
            next_nonce: AtomicU64::new(1),
            routes: Arc::default(),
            members: RwLock::default(),
            sender,
            receiver: AsyncMutex::new(receiver),
            bytes: Arc::new(Semaphore::new(bytes)),
        });
        Self {
            id,
            instance: None,
            root,
            state: Mutex::new(State {
                selection: None,
                timeout: None,
                revoked: false,
                turn_seen: false,
                routes: Arc::clone(&channel.routes),
                pending: HashMap::new(),
                unresolved: HashMap::new(),
            }),
            channel,
        }
    }

    fn descendant(parent: &Self, id: String, instance: String) -> Self {
        let state = parent.state.lock().expect("MCP result control poisoned");
        // A stopping owner must not grant a fresh callback route.
        let timeout = (!state.revoked).then_some(state.timeout).flatten();
        Self {
            id,
            instance: Some(instance),
            root: false,
            state: Mutex::new(State {
                selection: state.selection.clone(),
                timeout,
                revoked: state.revoked,
                turn_seen: false,
                routes: Arc::clone(&parent.channel.routes),
                pending: HashMap::new(),
                unresolved: HashMap::new(),
            }),
            channel: Arc::clone(&parent.channel),
        }
    }

    pub(crate) fn owner(&self, nonce: u64) -> Option<Arc<Self>> {
        self.channel
            .routes
            .lock()
            .ok()?
            .get(&nonce)?
            .owner
            .upgrade()
            .filter(|owner| Arc::ptr_eq(&owner.channel, &self.channel))
    }

    pub(crate) fn check_pending(&self, nonce: u64, turn_id: &str, call_id: &str) -> bool {
        let state = self.state.lock().expect("MCP result control poisoned");
        !state.revoked
            && state.pending.get(&nonce).is_some_and(|item| {
                item.sender.is_some()
                    && item.is_cancelled.as_ref().is_none_or(|probe| !probe())
                    && item.turn_id == turn_id
                    && item.call_id == call_id
                    && Instant::now() < item.deadline
                    && state
                        .routes
                        .lock()
                        .expect("MCP routes poisoned")
                        .get(&nonce)
                        .is_some_and(|route| matches!(route.payload, Payload::Handed))
            })
    }

    // A normal abort can still own pending callbacks. Only an admitted policy
    // rejection changes that cancellation into a policy failure.
    pub(crate) fn take_settled_failure(&self, turn_id: &str) -> bool {
        self.state
            .lock()
            .expect("MCP result control poisoned")
            .unresolved
            .remove(turn_id)
            .is_some_and(|entry| entry.failed)
    }

    pub(crate) fn fail_pending(&self, nonce: u64, turn_id: &str, call_id: &str) -> bool {
        let mut state = self.state.lock().expect("MCP result control poisoned");
        if !state.pending.get(&nonce).is_some_and(|item| {
            item.sender.is_some() && item.turn_id == turn_id && item.call_id == call_id
        }) {
            return false;
        }
        drop(state.retire(nonce));
        true
    }

    pub(crate) fn revoke_family(&self) {
        self.revoke();
        let members: Vec<_> = self
            .channel
            .members
            .read()
            .expect("MCP family poisoned")
            .values()
            .filter_map(Weak::upgrade)
            .collect();
        for child in members {
            child.revoke();
        }
    }

    pub fn enable(&self, timeout: f64) -> Result<()> {
        let mut state = self.state.lock().expect("MCP result control poisoned");
        ensure!(self.root, "Native MCP result control supports roots only");
        ensure!(
            !state.turn_seen && !state.revoked && state.timeout.is_none(),
            "Native MCP result control must be enabled before the first turn"
        );
        ensure!(
            timeout.is_finite() && timeout > 0.0 && timeout <= 3600.0,
            "Native MCP result timeout must be in (0, 3600] seconds"
        );
        state.timeout = Some(Duration::from_secs_f64(timeout));
        Ok(())
    }

    pub fn revoke(&self) {
        let mut state = self.state.lock().expect("MCP result control poisoned");
        state.revoked = true;
        // Dropping each sender leaves the result already set to withheld.
        let nonces: Vec<_> = state.pending.keys().copied().collect();
        for nonce in nonces {
            state.retire(nonce);
        }
    }

    fn end_turn(&self, turn_id: &str) {
        let mut state = self.state.lock().expect("MCP result control poisoned");
        let nonces: Vec<_> = state
            .pending
            .iter()
            .filter_map(|(nonce, item)| (item.turn_id == turn_id).then_some(*nonce))
            .collect();
        for nonce in nonces {
            state.retire(nonce);
        }
    }

    pub fn take_unresolved(&self, turn_id: &str) -> bool {
        self.state
            .lock()
            .expect("MCP result control poisoned")
            .unresolved
            .remove(turn_id)
            .is_some_and(|results| results.count != 0)
    }

    // Checked before bridge-owned strings/Values, including all escaped input,
    // result, metadata and identifiers. Upstream's original allocation is not
    // ours. Failure never exposes it or bypasses the unresolved result owner.
    #[cfg(test)]
    fn enqueue(
        self: &Arc<Self>,
        state: &mut State,
        notice: &Notice<'_>,
        deadline: Instant,
    ) -> Option<oneshot::Receiver<Option<AcceptedReply>>> {
        self.enqueue_with_context(state, notice, deadline, None)
    }

    fn enqueue_with_context(
        self: &Arc<Self>,
        state: &mut State,
        notice: &Notice<'_>,
        deadline: Instant,
        tracing: Option<codex_otel::sdk_trace::ContextLease>,
    ) -> Option<oneshot::Receiver<Option<AcceptedReply>>> {
        if state.revoked || state.pending.len() >= MAX_PENDING {
            return None;
        }
        let mut counter = Counter {
            bytes: 0,
            limit: self.channel.bytes.available_permits().min(MAX_BYTES),
        };
        serde_json::to_writer(&mut counter, notice).ok()?;
        let bytes = self
            .channel
            .bytes
            .clone()
            .try_acquire_many_owned(counter.bytes.try_into().ok()?)
            .ok()?;
        let wire = serde_json::to_string(notice).ok()?;
        let (tx, rx) = oneshot::channel();
        state.pending.insert(
            notice.nonce,
            Pending {
                turn_id: notice.turn_id.to_owned(),
                call_id: notice.call_id.to_owned(),
                deadline,
                metadata: notice.phase == Some("metadata"),
                is_cancelled: None,
                sender: Some(tx),
            },
        );
        state.routes.lock().expect("MCP routes poisoned").insert(
            notice.nonce,
            Route {
                owner: Arc::downgrade(self),
                payload: Payload::Queued(wire),
                _bytes: bytes,
                _tracing: tracing,
            },
        );
        if self
            .channel
            .sender
            .try_send((Arc::downgrade(self), notice.nonce))
            .is_err()
        {
            state.retire(notice.nonce);
            return None;
        }
        Some(rx)
    }

    pub async fn next(&self) -> Option<String> {
        let mut rx = self.channel.receiver.lock().await;
        while let Some((owner, nonce)) = rx.recv().await {
            let Some(owner) = owner.upgrade() else {
                continue;
            };
            let mut state = owner.state.lock().expect("MCP result control poisoned");
            if let Some(pending) = state.pending.get_mut(&nonce) {
                if pending.sender.is_some() && Instant::now() < pending.deadline {
                    let mut routes = state.routes.lock().expect("MCP routes poisoned");
                    if let Some(route) = routes.get_mut(&nonce) {
                        if let Payload::Queued(wire) =
                            std::mem::replace(&mut route.payload, Payload::InFlight)
                        {
                            return Some(wire);
                        }
                    }
                }
                state.retire(nonce);
            }
        }
        None
    }

    // Claim only transport delivery. No authority to edit is conveyed here.
    pub fn handoff(&self, nonce: u64) -> bool {
        let state = self.state.lock().expect("MCP result control poisoned");
        let revoked = state.revoked;
        let Some(item) = state.pending.get(&nonce) else {
            return false;
        };
        let mut routes = state.routes.lock().expect("MCP routes poisoned");
        let Some(route) = routes.get_mut(&nonce) else {
            return false;
        };
        if revoked
            || item.sender.is_none()
            || Instant::now() >= item.deadline
            || !matches!(route.payload, Payload::InFlight)
        {
            return false;
        }
        route.payload = Payload::Handed;
        true
    }

    pub fn release(&self, nonce: u64) -> bool {
        let mut state = self.state.lock().expect("MCP result control poisoned");
        let Some(item) = state.pending.get_mut(&nonce) else {
            return false;
        };
        let replied = item.sender.is_none();
        let mut routes = state.routes.lock().expect("MCP routes poisoned");
        let Some(route) = routes.get_mut(&nonce) else {
            return false;
        };
        if !matches!(route.payload, Payload::InFlight | Payload::Handed) {
            return false;
        }
        route.payload = Payload::Returned;
        if replied {
            routes.remove(&nonce);
            drop(routes);
            state.pending.remove(&nonce);
        }
        true
    }

    pub(crate) fn release_family(&self, nonce: u64) -> bool {
        if let Some(owner) = self.owner(nonce) {
            return owner.release(nonce);
        }
        let mut routes = self.channel.routes.lock().expect("MCP routes poisoned");
        let can_release = routes.get(&nonce).is_some_and(|route| {
            route.owner.strong_count() == 0
                && matches!(route.payload, Payload::InFlight | Payload::Handed)
        });
        if can_release {
            routes.remove(&nonce);
        }
        can_release
    }

    // No error strings derived from a reply cross the bridge. Return false on
    // invalid or expired replies, withhold if the original owner is still live.
    pub fn resolve(&self, nonce: u64, turn_id: &str, call_id: &str, reply: &str) -> bool {
        self.resolve_reply(nonce, turn_id, call_id, reply, None)
    }

    pub fn resolve_with_assignment(
        &self,
        nonce: u64,
        turn_id: &str,
        call_id: &str,
        reply: &str,
    ) -> Option<oneshot::Receiver<()>> {
        let (assignment, receiver) = oneshot::channel();
        self.resolve_reply(nonce, turn_id, call_id, reply, Some(assignment))
            .then_some(receiver)
    }

    fn resolve_reply(
        &self,
        nonce: u64,
        turn_id: &str,
        call_id: &str,
        reply: &str,
        assignment: Option<oneshot::Sender<()>>,
    ) -> bool {
        let mut state = self.state.lock().expect("MCP result control poisoned");
        if state.revoked
            || !state.pending.get(&nonce).is_some_and(|p| {
                p.sender.is_some()
                    && p.is_cancelled.as_ref().is_none_or(|probe| !probe())
                    && p.turn_id == turn_id
                    && p.call_id == call_id
                    && Instant::now() < p.deadline
            })
        {
            return false;
        }
        let deadline = state.pending[&nonce].deadline;
        let metadata = state.pending[&nonce].metadata;
        let edited = if metadata {
            validated_metadata(reply).map(AcceptedReply::Metadata)
        } else {
            validated(reply).map(|edited| AcceptedReply::Result { edited, assignment })
        };
        let edited = edited.filter(|_| Instant::now() < deadline);
        let Some(edited) = edited else {
            // The host records its primary failure before finally releasing
            // this sender. Waking Core here could publish TurnAborted first.
            return false;
        };
        let sender = state.retire(nonce).expect("checked owner");
        sender.send(Some(edited)).is_ok()
    }
}

// Also remove a reservation on drop of the native lifecycle future, including
// cancellation while waiting. A later reply cannot edit another turn/call.
struct Reservation<'a> {
    control: Arc<McpResultControl>,
    nonce: u64,
    turn_id: &'a str,
    assigned: bool,
}

impl Reservation<'_> {
    // The receiver owns this still-unassigned obligation even after resolve
    // retires its nonce. Never recreate a turn consumed by its finishing owner.
    fn claim_rejection(&self) -> bool {
        let mut state = self
            .control
            .state
            .lock()
            .expect("MCP result control poisoned");
        if self.assigned || state.revoked {
            return false;
        }
        let Some(results) = state.unresolved.get_mut(self.turn_id) else {
            return false;
        };
        if results.count == 0 || self.nonce < results.first_nonce {
            return false;
        }
        results.failed = true;
        state.retire(self.nonce);
        true
    }

    fn assign_result(
        &mut self,
        thread_store: &ExtensionData,
        turn_store: &ExtensionData,
        result: &mut CallToolResult,
        mut edited: CallToolResult,
        peer_failed: bool,
        assignment: Option<oneshot::Sender<()>>,
    ) {
        crate::native_interception::publish_mcp_result(thread_store, turn_store, || {
            let mut state = self
                .control
                .state
                .lock()
                .expect("MCP result control poisoned");
            if !state.revoked
                && state
                    .unresolved
                    .get(self.turn_id)
                    .is_some_and(|entry| self.nonce >= entry.first_nonce && entry.count > 0)
            {
                // A successful send is insufficient: a cancelled receiver might
                // never apply it. Discharge only at raw assignment.
                if peer_failed {
                    edited.is_error = Some(true);
                }
                *result = edited;
                self.assigned = true;
                if let Some(results) = state.unresolved.get_mut(self.turn_id) {
                    results.count -= 1;
                    if results.count == 0 {
                        state.unresolved.remove(self.turn_id);
                    }
                }
            }
        });
        if self.assigned
            && let Some(assignment) = assignment
        {
            let _ = assignment.send(());
        }
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut state = self
            .control
            .state
            .lock()
            .expect("MCP result control poisoned");
        state.retire(self.nonce);
    }
}

pub struct McpResultContributor(pub(crate) Weak<ThreadManager>);

impl ThreadLifecycleContributor<Config> for McpResultContributor {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let root = !matches!(
                input.session_source,
                SessionSource::Internal(_) | SessionSource::SubAgent(_)
            );
            let id = input.thread_store.level_id().to_owned();
            if let Some(control) = input
                .thread_store
                .get::<crate::native_interception::Control>()
                && let Some(parent) = control.inherited_parent(&self.0).await
                && inherits_result_source(
                    parent
                        .thread_extension_data()
                        .get::<crate::python_tools::PythonTools>()
                        .is_some_and(|tools| tools.inherits_children()),
                    input.spawning_step_store,
                )
                && let Some(parent_control) =
                    parent.thread_extension_data().get::<McpResultControl>()
            {
                let child = input.thread_store.get_or_init(|| {
                    McpResultControl::descendant(
                        &parent_control,
                        id.clone(),
                        control.incarnation.clone(),
                    )
                });
                parent_control
                    .channel
                    .members
                    .write()
                    .expect("MCP family poisoned")
                    .insert(id, Arc::downgrade(&child));
            } else {
                input
                    .thread_store
                    .get_or_init(|| McpResultControl::new(id, root));
            }
            if let (Some(issuer), Some(results)) = (
                input
                    .thread_store
                    .get::<crate::native_interception::Control>(),
                input.thread_store.get::<McpResultControl>(),
            ) {
                issuer.bind_mcp_results(&results);
            }
        })
    }

    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(control) = input.thread_store.get::<McpResultControl>() {
                control.revoke();
            }
        })
    }
}

impl TurnLifecycleContributor for McpResultContributor {
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(control) = input.thread_store.get::<McpResultControl>() {
                control
                    .state
                    .lock()
                    .expect("MCP result control poisoned")
                    .turn_seen = true;
            }
        })
    }

    fn on_turn_stop<'a>(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(control) = input.thread_store.get::<McpResultControl>() {
                control.end_turn(input.turn_store.level_id());
            }
        })
    }

    fn on_turn_abort<'a>(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(control) = input.thread_store.get::<McpResultControl>() {
                control.end_turn(input.turn_store.level_id());
            }
        })
    }
}

impl ToolLifecycleContributor for McpResultContributor {
    fn on_mcp_tool_request_metadata<'a>(
        &'a self,
        input: McpToolRequestMetadataInput<'a>,
    ) -> ExtensionFuture<'a, Result<Option<serde_json::Map<String, Value>>, ()>> {
        Box::pin(async move {
            let Some(control) = input.thread_store.get::<McpResultControl>() else {
                return Ok(None);
            };
            let (source_bound, captured) =
                source_selection(input.thread_store, input.step_store).map_err(|_| ())?;
            let selection = captured.or_else(|| {
                (!source_bound)
                    .then(|| control.capture_source_selection().map(Arc::new))
                    .flatten()
            });
            let Some(selection) = selection else {
                return Ok(None);
            };
            let profile = source_profile(input.thread_store, input.step_store).map_err(|_| ())?;
            let tool = input.mcp_tool.tool_info();
            if !selection
                .metadata_servers
                .get(&tool.server_name)
                .is_some_and(|names| names.iter().any(|name| name == tool.tool.name.as_ref()))
            {
                return Ok(None);
            }
            // A configured declaration owns failure too; never fall through to an unedited send.
            if !matches!(input.mcp_tool.source(), McpToolSource::Config) {
                return Err(());
            }
            if (input.is_cancelled)() {
                return Err(());
            }
            let deadline = Instant::now() + Duration::from_secs(30);
            let (nonce, rx) = {
                let mut state = control.state.lock().expect("MCP result control poisoned");
                let results = state
                    .unresolved
                    .entry(input.turn_id.to_owned())
                    .or_insert_with(|| TurnResults {
                        first_nonce: control.channel.next_nonce.load(Ordering::Relaxed),
                        ..Default::default()
                    });
                results.count = results.count.saturating_add(1);
                let nonce = control
                    .channel
                    .next_nonce
                    .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |nonce| {
                        nonce.checked_add(1)
                    })
                    .map_err(|_| {})?;
                let (route, cell_id, runtime_id) = match &input.source {
                    codex_tools::ToolCallSource::Direct => ("direct", None, None),
                    codex_tools::ToolCallSource::CodeMode {
                        cell_id,
                        runtime_tool_call_id,
                    } => (
                        "code",
                        Some(cell_id.as_str()),
                        Some(runtime_tool_call_id.as_str()),
                    ),
                };
                let tracing = codex_otel::sdk_trace::ContextLease::capture();
                let token = tracing.as_ref().map(|context| context.token().to_owned());
                let notice = Notice {
                    phase: Some("metadata"),
                    model: Some(input.model),
                    route: Some(route),
                    cell_id,
                    runtime_tool_call_id: runtime_id,
                    tracing_context: token.as_deref(),
                    nonce,
                    generation: selection.generation,
                    profile_id: profile.as_ref().map(|source| source.profile_id.as_str()),
                    profile_epoch: profile.as_ref().map(|source| source.epoch),
                    thread_id: &control.id,
                    incarnation: control.instance.as_deref(),
                    turn_id: input.turn_id,
                    call_id: input.call_id,
                    source: "config",
                    server_name: &tool.server_name,
                    tool_name: &tool.tool.name,
                    callable_namespace: &tool.callable_namespace,
                    callable_name: &tool.callable_name,
                    realtime_tool_name: Some(codex_extension_api::realtime_tool_wire_name(
                        &tool.canonical_tool_name(),
                    )),
                    arguments: input.arguments,
                    result: None,
                };
                let rx = control.enqueue_with_context(&mut state, &notice, deadline, tracing);
                if let Some(pending) = state.pending.get_mut(&nonce) {
                    pending.is_cancelled = Some(Arc::clone(&input.is_cancelled));
                }
                (nonce, rx)
            };
            let mut reservation = Reservation {
                control,
                nonce,
                turn_id: input.turn_id,
                assigned: false,
            };
            let Some(rx) = rx else {
                crate::native_interception::expire_mcp_result(
                    input.thread_store,
                    input.turn_store,
                    || !(input.is_cancelled)() && reservation.claim_rejection(),
                );
                return Err(());
            };
            let reply = tokio::time::timeout_at(deadline, rx).await;
            let Ok(Ok(Some(AcceptedReply::Metadata(metadata)))) = reply else {
                crate::native_interception::expire_mcp_result(
                    input.thread_store,
                    input.turn_store,
                    || !(input.is_cancelled)() && reservation.claim_rejection(),
                );
                return Err(());
            };
            let mut accepted = None;
            crate::native_interception::publish_mcp_metadata(
                input.thread_store,
                input.turn_store,
                matches!(input.source, codex_tools::ToolCallSource::CodeMode { .. }),
                &input.is_cancelled,
                || {
                    let mut state = reservation
                        .control
                        .state
                        .lock()
                        .expect("MCP result control poisoned");
                    if !state.revoked
                        && state.unresolved.get(input.turn_id).is_some_and(|entry| {
                            reservation.nonce >= entry.first_nonce && entry.count > 0
                        })
                    {
                        if let Some(results) = state.unresolved.get_mut(input.turn_id) {
                            results.count -= 1;
                            if results.count == 0 {
                                state.unresolved.remove(input.turn_id);
                            }
                        }
                        accepted = Some(metadata);
                    }
                },
            );
            accepted.ok_or(())?.map(Some)
        })
    }

    fn on_mcp_tool_result<'a>(&'a self, input: McpToolResultInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            let Some(control) = input.thread_store.get::<McpResultControl>() else {
                return;
            };
            let (source_bound, captured) =
                match source_selection(input.thread_store, input.step_store) {
                    Ok(value) => value,
                    Err(_) => {
                        *input.result = withheld();
                        let mut state = control.state.lock().expect("MCP result control poisoned");
                        let result = state
                            .unresolved
                            .entry(input.turn_id.to_owned())
                            .or_insert_with(|| TurnResults {
                                first_nonce: control.channel.next_nonce.load(Ordering::Relaxed),
                                ..Default::default()
                            });
                        result.count = result.count.saturating_add(1);
                        return;
                    }
                };
            let profile = source_profile(input.thread_store, input.step_store)
                .ok()
                .flatten();
            let peer_failed = input.result.is_error == Some(true);
            let (deadline, nonce, rx) = {
                let mut state = control.state.lock().expect("MCP result control poisoned");
                let tool = input.mcp_tool.tool_info();
                let (generation, timeout) = match captured.as_deref().or_else(|| {
                    (!source_bound)
                        .then_some(state.selection.as_ref())
                        .flatten()
                }) {
                    Some(selection) => (
                        selection.generation,
                        matches!(input.mcp_tool.source(), McpToolSource::Config)
                            .then(|| selection.servers.get(&tool.server_name))
                            .flatten()
                            .and_then(|tools| tools.get(tool.tool.name.as_ref()))
                            .copied()
                            .map(Duration::from_secs_f64),
                    ),
                    None => (0, if source_bound { None } else { state.timeout }),
                };
                let Some(timeout) = timeout else {
                    return; // Unselected calls have no queue or editor.
                };
                let deadline = Instant::now() + timeout;
                // Do this before queuing or awaiting anything. On drop the only
                // value the rest of native can see is this fixed error.
                let original = std::mem::replace(input.result, withheld());
                let results = state
                    .unresolved
                    .entry(input.turn_id.to_owned())
                    .or_insert_with(|| TurnResults {
                        first_nonce: control.channel.next_nonce.load(Ordering::Relaxed),
                        ..Default::default()
                    });
                results.count = results.count.saturating_add(1);
                let nonce = match control.channel.next_nonce.fetch_update(
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                    |value| value.checked_add(1),
                ) {
                    Ok(nonce) => nonce,
                    Err(_) => {
                        return;
                    }
                };
                let tool = input.mcp_tool.tool_info();
                let source = match input.mcp_tool.source() {
                    McpToolSource::Config => "config",
                    McpToolSource::Connector => "connector",
                    McpToolSource::Plugin { .. } => "plugin",
                    McpToolSource::SelectedPlugin => "selected_plugin",
                    McpToolSource::Other => "other",
                };
                let tracing = codex_otel::sdk_trace::ContextLease::capture();
                let tracing_token = tracing.as_ref().map(|context| context.token().to_owned());
                let notice = Notice {
                    phase: None,
                    model: None,
                    route: None,
                    cell_id: None,
                    runtime_tool_call_id: None,
                    tracing_context: tracing_token.as_deref(),
                    nonce,
                    generation,
                    profile_id: profile.as_ref().map(|source| source.profile_id.as_str()),
                    profile_epoch: profile.as_ref().map(|source| source.epoch),
                    thread_id: &control.id,
                    incarnation: control.instance.as_deref(),
                    turn_id: input.turn_id,
                    call_id: input.call_id,
                    source,
                    server_name: &tool.server_name,
                    tool_name: &tool.tool.name,
                    callable_namespace: &tool.callable_namespace,
                    callable_name: &tool.callable_name,
                    realtime_tool_name: None,
                    arguments: input.arguments,
                    result: Some(&original),
                };
                let rx = control.enqueue_with_context(&mut state, &notice, deadline, tracing);
                (deadline, nonce, rx)
            };
            let mut reservation = Reservation {
                control,
                nonce,
                turn_id: input.turn_id,
                assigned: false,
            };
            let Some(rx) = rx else {
                crate::native_interception::expire_mcp_result(
                    input.thread_store,
                    input.turn_store,
                    || reservation.claim_rejection(),
                );
                return;
            };
            if let Ok(Ok(Some(AcceptedReply::Result { edited, assignment }))) =
                tokio::time::timeout_at(deadline, rx).await
            {
                reservation.assign_result(
                    input.thread_store,
                    input.turn_store,
                    input.result,
                    edited,
                    peer_failed,
                    assignment,
                );
            } else {
                crate::native_interception::expire_mcp_result(
                    input.thread_store,
                    input.turn_store,
                    || reservation.claim_rejection(),
                );
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn explicit_metadata_denial_requires_the_matching_metadata_reservation() {
        for metadata in [false, true] {
            let control = Arc::new(McpResultControl::new("root".into(), true));
            let args = json!({});
            let result = withheld();
            let mut request = notice(1, "turn", &args, &result);
            request.phase = metadata.then_some("metadata");
            let mut rx = control
                .enqueue(
                    &mut control.state.lock().unwrap(),
                    &request,
                    Instant::now() + Duration::from_secs(30),
                )
                .unwrap();
            assert!(!control.resolve(1, "other-turn", "call", "false"));
            assert!(!control.resolve(1, "turn", "other-call", "false"));
            assert_eq!(control.resolve(1, "turn", "call", "false"), metadata);
            if metadata {
                assert!(matches!(
                    rx.await,
                    Ok(Some(AcceptedReply::Metadata(Err(()))))
                ));
                assert!(!control.resolve(1, "turn", "call", "false"));
            } else {
                assert!(matches!(
                    rx.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ));
                assert!(control.fail_pending(1, "turn", "call"));
            }
        }
    }

    #[tokio::test]
    async fn invalid_reply_waits_for_host_failure_before_releasing_native_receiver() {
        for metadata in [false, true] {
            let control = Arc::new(McpResultControl::new("root".into(), true));
            let args = json!({});
            let result = withheld();
            let mut request = notice(1, "old", &args, &result);
            request.phase = metadata.then_some("metadata");
            let mut rx = control
                .enqueue(
                    &mut control.state.lock().unwrap(),
                    &request,
                    Instant::now() + Duration::from_secs(30),
                )
                .unwrap();
            assert!(!control.resolve(1, "old", "call", "[]"));
            assert!(matches!(
                rx.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ));
            assert!(!control.fail_pending(1, "new", "call"));
            assert!(control.fail_pending(1, "old", "call"));
            assert!(rx.await.is_err());
        }
    }

    #[tokio::test]
    async fn old_reservation_cannot_reject_or_discharge_reinserted_same_turn_key() {
        let control = Arc::new(McpResultControl::new("root".into(), true));
        let mut old = Reservation {
            control: control.clone(),
            nonce: 1,
            turn_id: "same",
            assigned: false,
        };
        control.state.lock().unwrap().unresolved.insert(
            "same".into(),
            TurnResults {
                first_nonce: 2,
                count: 1,
                ..Default::default()
            },
        );
        assert!(!old.claim_rejection());
        let mut raw = withheld();
        let mut edited = withheld();
        edited.content = vec![json!({"type":"text","text":"stale edit"})];
        let thread = ExtensionData::new("root");
        let turn = ExtensionData::new("same");
        old.assign_result(&thread, &turn, &mut raw, edited, false, None);
        assert_eq!(raw.content, withheld().content);
        drop(old);
        let state = control.state.lock().unwrap();
        assert_eq!(state.unresolved["same"].count, 1);
        assert!(!state.unresolved["same"].failed);
    }

    #[tokio::test]
    async fn bounded_notice_failure_keeps_a_live_rejection_claim() {
        for metadata in [false, true] {
            let control = Arc::new(McpResultControl::with_budget("root".into(), true, 1));
            let args = json!({});
            let result = withheld();
            let mut request = notice(1, "old", &args, &result);
            request.phase = metadata.then_some("metadata");
            let reservation = Reservation {
                control: control.clone(),
                nonce: 1,
                turn_id: "old",
                assigned: false,
            };
            {
                let mut state = control.state.lock().unwrap();
                state.unresolved.insert(
                    "old".into(),
                    TurnResults {
                        first_nonce: 1,
                        count: 1,
                        ..Default::default()
                    },
                );
                assert!(
                    control
                        .enqueue(
                            &mut state,
                            &request,
                            Instant::now() + Duration::from_secs(30)
                        )
                        .is_none()
                );
            }
            assert!(reservation.claim_rejection());
            assert!(control.state.lock().unwrap().unresolved["old"].failed);
        }
    }

    #[test]
    fn rejected_obligation_is_scoped_and_never_recreated() {
        let control = Arc::new(McpResultControl::new("root".into(), true));
        let reservation = Reservation {
            control: control.clone(),
            nonce: 1,
            turn_id: "old",
            assigned: false,
        };
        assert!(!reservation.claim_rejection());
        {
            let mut state = control.state.lock().unwrap();
            state.unresolved.insert(
                "old".into(),
                TurnResults {
                    count: 1,
                    ..Default::default()
                },
            );
            state.unresolved.insert(
                "new".into(),
                TurnResults {
                    count: 1,
                    ..Default::default()
                },
            );
        }
        assert!(
            !control.take_settled_failure("old"),
            "pending alone is not a failed abort"
        );
        assert!(
            !reservation.claim_rejection(),
            "normal abort retired that entry"
        );
        control.state.lock().unwrap().unresolved.insert(
            "old".into(),
            TurnResults {
                count: 1,
                ..Default::default()
            },
        );
        assert!(reservation.claim_rejection());
        assert!(!control.take_settled_failure("new"));
        assert!(control.take_settled_failure("old"));
        {
            let mut state = control.state.lock().unwrap();
            assert!(!state.unresolved.contains_key("new"));
            state.unresolved.remove("old");
        }
        assert!(!reservation.claim_rejection());
        assert!(!control.state.lock().unwrap().unresolved.contains_key("old"));
        control.state.lock().unwrap().unresolved.insert(
            "old".into(),
            TurnResults {
                count: 1,
                ..Default::default()
            },
        );
        control.state.lock().unwrap().revoked = true;
        assert!(!reservation.claim_rejection());
    }

    #[test]
    fn exact_spawning_source_routes_results_without_sdk_tool_inheritance() {
        assert!(!inherits_result_source(false, None));
        assert!(inherits_result_source(true, None));
        let source = ExtensionData::new("actual-spawning-step");
        source.insert(crate::native_interception::ProfileMcpSource {
            result_selection: None,
            receipt: Some(codex_extension_api::AgentProfileReceipt {
                profile_id: "b".into(),
                epoch: 1,
            }),
            policy: Some(Arc::new(
                crate::native_interception::ProfileMcpPolicy::default(),
            )),
        });
        assert!(inherits_result_source(false, Some(&source)));
        let invalid = ExtensionData::new("missing-policy");
        invalid.insert(crate::native_interception::ProfileMcpSource {
            result_selection: None,
            receipt: None,
            policy: None,
        });
        assert!(!inherits_result_source(false, Some(&invalid)));
    }

    #[test]
    fn mono_source_freezes_selected_and_unselected_result_policy_for_children() {
        let control = Arc::new(McpResultControl::new("root".into(), true));
        let issuer = crate::native_interception::Control::new("root".into(), true);
        issuer.bind_mcp_results(&control);
        let unselected = issuer.capture_mcp_source();
        control.publish_selection(
            serde_json::from_value(json!({
                "generation": 7, "servers": {"vault": {"record": 0.25}}
            }))
            .unwrap(),
        );
        let selected = issuer.capture_mcp_source();
        control.publish_selection(
            serde_json::from_value(json!({"generation": 8, "servers": {}})).unwrap(),
        );
        for (source, expected) in [(unselected, None), (selected, Some(7))] {
            // Thread/step inheritance clones the exact captured source, including None.
            let child_thread = ExtensionData::new("child");
            child_thread.insert(source.clone());
            let child_step = ExtensionData::new("child-first-step");
            child_step.insert(
                (*child_thread
                    .get::<crate::native_interception::ProfileMcpSource>()
                    .unwrap())
                .clone(),
            );
            let (bound, actual) = source_selection(&child_thread, Some(&child_step)).unwrap();
            assert!(bound);
            assert_eq!(
                actual.as_ref().map(|selection| selection.generation),
                expected
            );
        }
    }

    #[test]
    fn captured_unselected_mono_source_cannot_inherit_newer_result_policy() {
        let control = McpResultControl::new("root".into(), true);
        let thread = ExtensionData::new("root");
        let step = ExtensionData::new("captured-A");
        assert!(control.capture_source_selection().is_none());
        step.insert(crate::native_interception::ProfileMcpSource {
            result_selection: None,
            receipt: None,
            policy: Some(Arc::new(
                crate::native_interception::ProfileMcpPolicy::default(),
            )),
        });
        control.publish_selection(
            serde_json::from_value(json!({
                "generation": 7, "servers": {"vault": {"record": 0.25}}
            }))
            .unwrap(),
        );

        assert!(!control.owns_result(&thread, Some(&step), "vault", "record", true));
        assert!(control.owns_result(&thread, None, "vault", "record", true));
    }

    #[test]
    fn captured_child_result_policy_keeps_exact_receipt_without_python_tools() {
        let control = McpResultControl::new("child".into(), false);
        let thread = ExtensionData::new("child");
        let step = ExtensionData::new("actual-parent-source");
        let receipt = codex_extension_api::AgentProfileReceipt {
            profile_id: "agent_B".into(),
            epoch: 3,
        };
        step.insert(crate::native_interception::ProfileMcpSource {
            result_selection: None,
            receipt: Some(receipt.clone()),
            policy: Some(Arc::new(
                crate::native_interception::ProfileMcpPolicy::default(),
            )),
        });
        step.insert(
            serde_json::from_value::<Selection>(json!({
                "generation": 5, "servers": {"vault": {"record": 0.25}}
            }))
            .unwrap(),
        );
        control.publish_selection(
            serde_json::from_value(json!({
                "generation": 8, "servers": {}
            }))
            .unwrap(),
        );

        assert!(control.owns_result(&thread, Some(&step), "vault", "record", true));
        assert_eq!(source_profile(&thread, Some(&step)).unwrap(), Some(receipt));
        assert_eq!(
            source_selection(&thread, Some(&step))
                .unwrap()
                .1
                .unwrap()
                .generation,
            5
        );
        let missing_selection = ExtensionData::new("missing-source");
        missing_selection.insert(
            (*step
                .get::<crate::native_interception::ProfileMcpSource>()
                .unwrap())
            .clone(),
        );
        assert!(source_selection(&thread, Some(&missing_selection)).is_err());
    }

    fn notice<'a>(
        nonce: u64,
        turn: &'a str,
        arguments: &'a Value,
        result: &'a CallToolResult,
    ) -> Notice<'a> {
        Notice {
            phase: None,
            model: None,
            route: None,
            cell_id: None,
            runtime_tool_call_id: None,
            tracing_context: None,
            nonce,
            generation: 0,
            profile_id: None,
            profile_epoch: None,
            thread_id: "root",
            incarnation: None,
            turn_id: turn,
            call_id: "call",
            source: "config",
            server_name: "vault",
            tool_name: "record",
            callable_namespace: "mcp__vault",
            callable_name: "record",
            realtime_tool_name: None,
            arguments,
            result: Some(result),
        }
    }

    #[tokio::test]
    async fn application_assignment_ack_requires_final_native_publication() {
        for stopped in [true, false] {
            let thread = ExtensionData::new("root");
            let turn = ExtensionData::new("turn");
            let stop = crate::native_interception::test_mcp_result_owner(&thread, &turn, !stopped);
            let control = Arc::new(McpResultControl::new("root".into(), true));
            let args = json!({});
            let original = withheld();
            let request = notice(1, "turn", &args, &original);
            control.state.lock().unwrap().unresolved.insert(
                "turn".into(),
                TurnResults {
                    first_nonce: 1,
                    count: 1,
                    ..Default::default()
                },
            );
            let receiver = control
                .enqueue(
                    &mut control.state.lock().unwrap(),
                    &request,
                    Instant::now() + Duration::from_secs(30),
                )
                .unwrap();
            assert!(control.next().await.is_some());
            assert!(control.handoff(1));
            let ack = control
                .resolve_with_assignment(
                    1,
                    "turn",
                    request.call_id,
                    r#"{"content":[{"type":"text","text":"accepted"}]}"#,
                )
                .unwrap();
            if stopped {
                stop();
            }
            let AcceptedReply::Result { edited, assignment } = receiver.await.unwrap().unwrap()
            else {
                panic!("result receipt expected");
            };
            let mut output = withheld();
            let mut reservation = Reservation {
                control: control.clone(),
                nonce: 1,
                turn_id: "turn",
                assigned: false,
            };
            reservation.assign_result(&thread, &turn, &mut output, edited, false, assignment);
            assert_eq!(ack.await.is_ok(), !stopped);
            assert_eq!(reservation.assigned, !stopped);
            if stopped {
                assert_eq!(output, withheld());
            } else {
                assert_eq!(
                    output.content,
                    vec![json!({"type":"text","text":"accepted"})]
                );
            }
            drop(reservation);
            assert!(control.release(1));
        }
    }

    #[tokio::test]
    async fn retired_issuer_keeps_charge_until_its_exact_transport_return() {
        for handed in [false, true] {
            let args = json!({"value":"retained by application"});
            let result = withheld();
            let mut first = notice(1, "same-turn", &args, &result);
            first.thread_id = "child";
            first.incarnation = Some("old-child");
            let budget = serde_json::to_vec(&first).unwrap().len();
            let root = Arc::new(McpResultControl::with_budget("root".into(), true, budget));
            let old = Arc::new(McpResultControl::descendant(
                &root,
                "child".into(),
                "old-child".into(),
            ));
            root.channel
                .members
                .write()
                .unwrap()
                .insert("child".into(), Arc::downgrade(&old));
            let deadline = Instant::now() + Duration::from_secs(30);
            let reply = old
                .enqueue(&mut old.state.lock().unwrap(), &first, deadline)
                .unwrap();
            let wire = root.next().await.unwrap();
            assert_eq!(wire.len(), budget);
            if handed {
                assert!(root.owner(1).unwrap().handoff(1));
                assert!(old.check_pending(1, "same-turn", "call"));
            }
            old.revoke();
            assert!(!old.check_pending(1, "same-turn", "call"));
            assert!(reply.await.is_err());
            let weak = Arc::downgrade(&old);
            drop(old);
            assert!(
                weak.upgrade().is_none(),
                "transport cannot retain native authority"
            );
            assert!(root.owner(1).is_none());
            assert_eq!(root.channel.bytes.available_permits(), 0);

            let new = Arc::new(McpResultControl::descendant(
                &root,
                "child".into(),
                "new-child".into(),
            ));
            root.channel
                .members
                .write()
                .unwrap()
                .insert("child".into(), Arc::downgrade(&new));
            let mut second = notice(2, "same-turn", &args, &result);
            second.thread_id = "child";
            second.incarnation = Some("new-child");
            assert_eq!(serde_json::to_vec(&second).unwrap().len(), budget);
            assert!(!new.resolve(1, "same-turn", "call", r#"{"content":[]}"#));
            assert!(
                new.enqueue(&mut new.state.lock().unwrap(), &second, deadline)
                    .is_none()
            );
            assert!(!root.release_family(2));
            assert!(root.release_family(1));
            assert_eq!(root.channel.bytes.available_permits(), budget);
            assert!(!root.release_family(1));

            let next = new
                .enqueue(&mut new.state.lock().unwrap(), &second, deadline)
                .unwrap();
            assert!(root.next().await.is_some());
            assert!(root.owner(2).unwrap().handoff(2));
            assert!(
                !root.release_family(1),
                "late release must not free another request"
            );
            assert_eq!(root.channel.bytes.available_permits(), 0);
            assert!(new.resolve(
                2,
                "same-turn",
                "call",
                r#"{"content":[{"type":"text","text":"accepted"}]}"#
            ));
            assert!(next.await.unwrap().is_some());
            assert!(root.release_family(2));
            assert!(root.channel.routes.lock().unwrap().is_empty());
            assert_eq!(root.channel.bytes.available_permits(), budget);
        }
    }

    #[tokio::test]
    async fn family_cancel_withholds_only_the_addressed_issuer() {
        let root = Arc::new(McpResultControl::new("root".into(), true));
        root.enable(30.0).unwrap();
        let left = Arc::new(McpResultControl::descendant(
            &root,
            "left".into(),
            "left-a".into(),
        ));
        let right = Arc::new(McpResultControl::descendant(
            &root,
            "right".into(),
            "right-b".into(),
        ));
        let args = json!({});
        let result = withheld();
        let mut a = notice(1, "same-turn", &args, &result);
        a.thread_id = "left";
        a.incarnation = Some("left-a");
        let mut b = notice(2, "same-turn", &args, &result);
        b.thread_id = "right";
        b.incarnation = Some("right-b");
        let deadline = Instant::now() + Duration::from_secs(30);
        let (a_reply, b_reply) = (
            left.enqueue(&mut left.state.lock().unwrap(), &a, deadline)
                .unwrap(),
            right
                .enqueue(&mut right.state.lock().unwrap(), &b, deadline)
                .unwrap(),
        );
        for _ in 0..2 {
            let wire: Value = serde_json::from_str(&root.next().await.unwrap()).unwrap();
            let nonce = wire["nonce"].as_u64().unwrap();
            assert!(root.owner(nonce).unwrap().handoff(nonce));
        }
        assert!(left.fail_pending(1, "same-turn", "call"));
        assert!(a_reply.await.is_err());
        assert!(!left.check_pending(1, "same-turn", "call"));
        assert!(right.check_pending(2, "same-turn", "call"));
        assert!(right.resolve(2, "same-turn", "call", r#"{"content":[]}"#));
        assert!(b_reply.await.unwrap().is_some());
        assert!(root.release_family(1));
        assert!(root.release_family(2));
        assert_eq!(root.channel.bytes.available_permits(), MAX_BYTES);
    }

    #[tokio::test]
    async fn bounded_notice_measures_complete_wire_before_queuing() {
        let args = json!({"value":"quote\" line\n tab\t"});
        let result = CallToolResult {
            content: vec![json!({"type":"text","text":"some \\ actual text"})],
            structured_content: Some(json!({"receipt":"complete"})),
            is_error: Some(false),
            meta: Some(json!({"marker":"metadata\n"})),
        };
        let notice = notice(1, "first", &args, &result);
        let expected = json!({
            "nonce":1, "generation":0, "thread_id":"root", "turn_id":"first", "call_id":"call",
            "source":"config", "server_name":"vault", "tool_name":"record",
            "callable_namespace":"mcp__vault", "callable_name":"record",
            "arguments":args, "result":result
        });
        let encoded = serde_json::to_vec(&notice).unwrap();
        let small = Arc::new(McpResultControl::with_budget(
            "root".into(),
            true,
            encoded.len() - 1,
        ));
        let deadline = Instant::now() + Duration::from_secs(30);
        assert!(
            small
                .enqueue(&mut small.state.lock().unwrap(), &notice, deadline)
                .is_none()
        );
        assert!(small.state.lock().unwrap().pending.is_empty());
        assert_eq!(small.channel.bytes.available_permits(), encoded.len() - 1);
        assert!(small.channel.receiver.lock().await.try_recv().is_err());

        let fits = Arc::new(McpResultControl::with_budget(
            "root".into(),
            true,
            encoded.len(),
        ));
        let rx = fits
            .enqueue(&mut fits.state.lock().unwrap(), &notice, deadline)
            .unwrap();
        assert_eq!(fits.channel.bytes.available_permits(), 0);
        let value: Value = serde_json::from_str(&fits.next().await.unwrap()).unwrap();
        assert_eq!(value, expected);
        assert!(fits.handoff(1));
        fits.end_turn("first");
        assert!(rx.await.is_err());
        assert_eq!(fits.channel.bytes.available_permits(), 0);
        assert!(fits.release(1));
        assert_eq!(fits.channel.bytes.available_permits(), encoded.len());
        assert!(!fits.release(1));
    }

    #[tokio::test]
    async fn handed_result_keeps_aggregate_capacity_after_reply_and_turn_exit() {
        let args = json!({"value": "harmless"});
        let result = withheld();
        let first = notice(1, "old", &args, &result);
        let second = notice(2, "new", &args, &result);
        let n = serde_json::to_vec(&first).unwrap().len();
        assert_eq!(serde_json::to_vec(&second).unwrap().len(), n);
        let control = Arc::new(McpResultControl::with_budget("root".into(), true, n));
        let deadline = Instant::now() + Duration::from_secs(30);
        let rx = control
            .enqueue(&mut control.state.lock().unwrap(), &first, deadline)
            .unwrap();
        assert!(control.next().await.is_some());
        assert!(control.handoff(1));
        assert!(!control.resolve(1, "new", "call", "null"));
        assert!(control.resolve(
            1,
            "old",
            "call",
            r#"{"content":[{"type":"text","text":"edited"}]}"#
        ));
        assert!(rx.await.unwrap().is_some());
        control.end_turn("old");
        assert!(
            control
                .enqueue(&mut control.state.lock().unwrap(), &second, deadline)
                .is_none()
        );
        assert!(!control.release(2));
        assert!(control.release(1));
        let next = control
            .enqueue(&mut control.state.lock().unwrap(), &second, deadline)
            .unwrap();
        assert!(control.next().await.is_some());
        assert!(control.handoff(2));
        assert!(
            !control.release(1),
            "late previous release cannot free the new callback"
        );
        control.revoke();
        assert!(next.await.is_err());
        assert_eq!(control.channel.bytes.available_permits(), 0);
        assert!(control.release(2));
        assert_eq!(control.channel.bytes.available_permits(), n);
    }

    #[tokio::test]
    async fn discarded_queue_frees_bytes_but_retains_live_other_read() {
        let args = json!({"value": "harmless"});
        let result = withheld();
        let first = notice(1, "old", &args, &result);
        let second = notice(2, "new", &args, &result);
        let n = serde_json::to_vec(&first).unwrap().len();
        let control = Arc::new(McpResultControl::with_budget("root".into(), true, 2 * n));
        let deadline = Instant::now() + Duration::from_secs(30);
        let rx1 = control
            .enqueue(&mut control.state.lock().unwrap(), &first, deadline)
            .unwrap();
        let rx2 = control
            .enqueue(&mut control.state.lock().unwrap(), &second, deadline)
            .unwrap();
        assert_eq!(control.channel.bytes.available_permits(), 0);
        control.end_turn("old");
        assert!(rx1.await.is_err());
        assert_eq!(
            control.channel.bytes.available_permits(),
            n,
            "discard an unclaimed queue entry now"
        );
        let wire: Value = serde_json::from_str(&control.next().await.unwrap()).unwrap();
        assert_eq!(wire["nonce"], 2);
        control.end_turn("new");
        assert!(rx2.await.is_err());
        assert_eq!(control.channel.bytes.available_permits(), n);
        assert!(control.release(2));
        assert_eq!(control.channel.bytes.available_permits(), 2 * n);
    }

    #[tokio::test]
    async fn dropped_reservation_withholds_and_keeps_bytes_until_physical_return() {
        let args = json!({});
        let result = withheld();
        let notice = notice(1, "old", &args, &result);
        let n = serde_json::to_vec(&notice).unwrap().len();
        let control = Arc::new(McpResultControl::with_budget("root".into(), true, n));
        let deadline = Instant::now() + Duration::from_secs(30);
        let rx;
        {
            let mut state = control.state.lock().unwrap();
            state.unresolved.insert(
                "old".into(),
                TurnResults {
                    count: 1,
                    ..Default::default()
                },
            );
            rx = control.enqueue(&mut state, &notice, deadline).unwrap();
        }
        let reservation = Reservation {
            control: control.clone(),
            nonce: 1,
            turn_id: "old",
            assigned: false,
        };
        assert!(control.next().await.is_some());
        assert!(control.handoff(1));
        drop(reservation);
        assert!(rx.await.is_err());
        assert_eq!(control.channel.bytes.available_permits(), 0);
        assert!(!control.resolve(1, "old", "call", r#"{"content":[]}"#));
        assert!(control.take_unresolved("old"));
        assert!(control.release(1));
        assert_eq!(control.channel.bytes.available_permits(), n);
    }

    #[tokio::test]
    async fn settled_failure_does_not_poison_another_turns_unassigned_valid_reply() {
        let control = Arc::new(McpResultControl::new("root".into(), true));
        let (old_sender, old_receiver) = oneshot::channel();
        let (new_sender, new_receiver) = oneshot::channel();
        {
            let mut state = control.state.lock().unwrap();
            for turn in ["old-turn", "new-turn"] {
                state.unresolved.insert(
                    turn.into(),
                    TurnResults {
                        count: 1,
                        ..Default::default()
                    },
                );
            }
            state.pending.insert(
                1,
                Pending {
                    turn_id: "old-turn".into(),
                    call_id: "old-call".into(),
                    deadline: Instant::now() + Duration::from_secs(30),
                    sender: Some(old_sender),
                    metadata: false,
                    is_cancelled: None,
                },
            );
            state.pending.insert(
                2,
                Pending {
                    turn_id: "new-turn".into(),
                    call_id: "new-call".into(),
                    deadline: Instant::now() + Duration::from_secs(30),
                    sender: Some(new_sender),
                    metadata: false,
                    is_cancelled: None,
                },
            );
        }
        let old = Reservation {
            control: control.clone(),
            nonce: 1,
            turn_id: "old-turn",
            assigned: false,
        };
        let mut new = Reservation {
            control: control.clone(),
            nonce: 2,
            turn_id: "new-turn",
            assigned: false,
        };
        assert!(!control.resolve(1, "old-turn", "old-call", "null"));
        assert!(control.fail_pending(1, "old-turn", "old-call"));
        assert!(old_receiver.await.is_err());
        drop(old);
        assert!(control.resolve(
            2,
            "new-turn",
            "new-call",
            r#"{"content":[{"type":"text","text":"safe edited result"}],"isError":false}"#,
        ));
        let AcceptedReply::Result { edited, assignment } = new_receiver.await.unwrap().unwrap()
        else {
            panic!("expected result reply")
        };
        let mut raw_result = withheld();
        let thread = ExtensionData::new("root");
        let turn = ExtensionData::new("new-turn");
        let _stop = crate::native_interception::test_mcp_result_owner(&thread, &turn, false);
        new.assign_result(&thread, &turn, &mut raw_result, edited, false, assignment);
        assert_eq!(
            raw_result.content,
            vec![json!({"type": "text", "text": "safe edited result"})]
        );
        assert_eq!(raw_result.is_error, Some(false));
        drop(new);
        assert!(!control.take_unresolved("new-turn"));
        assert!(control.take_unresolved("old-turn"));
        assert!(!control.take_unresolved("old-turn"));
    }
    #[tokio::test]
    async fn handed_callback_retains_trace_lease_through_revocation_until_physical_release() {
        let scope: Value = serde_json::from_str(
            &codex_otel::sdk_trace::start_trace_span(
                r#"{"name":"MCP lease test","kind":"workflow","disabled":true}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let handle = scope["handle"].as_str().unwrap();
        let context = codex_otel::sdk_trace::context(handle).unwrap();
        let attached = context.attach();
        let lease = codex_otel::sdk_trace::ContextLease::capture().unwrap();
        let token = lease.token().to_owned();
        drop(attached);
        let args = json!({});
        let result = withheld();
        let mut message = notice(1, "turn", &args, &result);
        message.tracing_context = Some(&token);
        let control = Arc::new(McpResultControl::new("root".into(), true));
        let _reply = control
            .enqueue_with_context(
                &mut control.state.lock().unwrap(),
                &message,
                Instant::now() + Duration::from_secs(30),
                Some(lease),
            )
            .unwrap();
        codex_otel::sdk_trace::release_trace_span(handle);
        let wire: Value = serde_json::from_str(&control.next().await.unwrap()).unwrap();
        assert_eq!(wire["tracing_context"], token);
        assert!(control.handoff(1));
        control.revoke();
        assert!(
            codex_otel::sdk_trace::context(&token).is_ok(),
            "handed callback still owns its context"
        );
        assert!(control.release_family(1));
        assert!(
            codex_otel::sdk_trace::context(&token).is_err(),
            "physical release must retire the token"
        );
    }
}

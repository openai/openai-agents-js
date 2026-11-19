//! Target-neutral Realtime control. Hosts execute effects; they never admit calls.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_CALLS: usize = 256;
const MAX_OBSERVED_ITEMS: usize = 4096;

#[path = "../../.upstream/reviewed-codex/codex-rs/codex-api/src/endpoint/realtime_websocket/session_match.rs"]
mod session_match;
use session_match::contains_expected;

const MAX_CALL_BYTES: usize = 256 * 1024;

#[derive(Default)]
struct PendingDefault {
    sdk_response_id: Option<String>,
    active_default_response: bool,
    pending_create: bool,
}

impl PendingDefault {
    fn mark_started(&mut self) {
        self.active_default_response = true;
    }

    fn raced_active_response(&mut self) {
        self.mark_started();
        self.pending_create = true;
    }

    fn request_create(&mut self) -> bool {
        self.pending_create = self.active_default_response;
        !self.pending_create
    }

    fn finish_and_take_pending(&mut self) -> bool {
        self.active_default_response = false;
        std::mem::take(&mut self.pending_create)
    }
}

#[derive(Debug, Serialize, PartialEq)]
struct FunctionCall {
    namespace: Option<String>,
    call_id: String,
    item_id: String,
    name: String,
    arguments: String,
    response_id: Option<String>,
}

impl FunctionCall {
    fn validate(&self) -> Result<(), String> {
        if self.namespace.is_some() {
            return Err("Namespaced Realtime functions are not supported".into());
        }
        if serde_json::to_vec(self)
            .map_err(|_| "Invalid function request")?
            .len()
            > MAX_CALL_BYTES
        {
            return Err("SDK Realtime function request exceeds capacity".into());
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(default)]
    pub needs_approval: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub model: String,
    pub instructions: String,
    #[serde(default)]
    pub tools: Vec<Tool>,
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    #[serde(default)]
    pub hosted_tools: Vec<Value>,
    #[serde(default)]
    pub profile_id: u64,
    #[serde(default = "default_true")]
    pub hosted_mcp_auto_response: bool,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Start {
        config: Config,
        #[serde(default)]
        clear_output_audio_on_interrupt: bool,
    },
    Update {
        config: Config,
    },
    SendEvent {
        event: Value,
        #[serde(default)]
        validate: bool,
        #[serde(default)]
        history: Vec<Value>,
        #[serde(default)]
        profile_id: u64,
    },
    UpdateSettings {
        session: Value,
        profile_id: u64,
    },
    ClearOutputAudio,
    Retrieve {
        item_id: String,
        event_id: Option<String>,
    },
    Cancel {
        response_id: Option<String>,
    },
    Audio {
        audio: String,
    },
    CommitAudio,
    ClearAudio,
    CreateResponse {
        response: Option<Value>,
        #[serde(default)]
        history: Vec<Value>,
    },
    ApproveMcp {
        request_id: String,
        approved: bool,
    },
    Input {
        item: Value,
        #[serde(default, deserialize_with = "present_value")]
        previous_item_id: Option<Value>,
        #[serde(default = "default_true")]
        create_response: bool,
    },
    Delete {
        item_id: String,
        event_id: Option<String>,
    },
    ValidateCancel {
        response_id: Option<String>,
    },
    ValidateResponse {
        response: Option<Value>,
    },
    ValidateDelete {
        item_id: String,
        event_id: Option<String>,
    },
    ValidateTruncate {
        item_id: String,
        content_index: u32,
        audio_end_ms: u32,
    },
    ValidateHistory {
        delete_ids: Vec<String>,
        items: Vec<Value>,
    },
    Truncate {
        item_id: String,
        content_index: u32,
        audio_end_ms: u32,
    },
    Guardrail {
        response_id: String,
        output: String,
    },
    Provider {
        event: Value,
    },
    Approve {
        call_id: String,
        approved: bool,
        #[serde(default)]
        output: Option<String>,
    },
    ToolResult {
        call_id: String,
        output: String,
        #[serde(default)]
        background: bool,
    },
    Sent {
        id: u64,
    },
    Text {
        text: String,
    },
    Close,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Effect {
    Preflight {
        event: Value,
        immediate: bool,
    },
    Send {
        id: u64,
        event: Value,
    },
    Approve {
        call_id: String,
        name: String,
        arguments: Value,
    },
    Execute {
        call_id: String,
        name: String,
        arguments: Value,
    },
    Event {
        event: Value,
    },
    HistoryRejected {
        item_id: String,
        message: String,
    },
    Ready,
    Configured,
    ConfigurationRejected,
    Retire {
        response_id: String,
    },
    Scope {
        response_id: String,
        profile_id: u64,
        out_of_band: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        history: Option<Vec<Value>>,
    },
    ApproveMcp {
        request_id: String,
        server_label: String,
        name: String,
        arguments: Value,
    },
    AbortMcp {
        request_id: String,
    },
    Abort {
        call_id: String,
    },
    Closed,
}
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    New,
    Configuring,
    Ready,
    Closed,
}
#[derive(Clone, Copy, PartialEq)]
enum CallPhase {
    Discovered,
    Approval,
    Executing,
    Publishing(u64),
    Published,
    Cancelled,
}
struct Call {
    request: FunctionCall,
    phase: CallPhase,
    needs_approval: bool,
    output: Option<String>,
    background: bool,
}
struct HostedApproval {
    response_id: String,
    item: Value,
    phase: CallPhase,
    decision: Option<bool>,
}
#[derive(Clone, Serialize)]
struct ResponseScope {
    profile_id: u64,
    tools: BTreeMap<String, Tool>,
    hosted: BTreeMap<String, Value>,
    request: Value,
    continuation: Value,
    history: Vec<Value>,
}
struct PendingDefaultCreate {
    event_id: String,
    // Scoped requests keep their payload in ResponseScope.
    response: Option<Value>,
}
struct DetachedResponse {
    active: bool,
    scope: Option<ResponseScope>,
    output: Vec<Value>,
}
#[derive(Clone, Copy, PartialEq)]
enum DeletionProof {
    Terminal,
    Active,
    ApprovalDecided,
    ApprovalDecisionOnly,
    ApprovalRequest,
    Nonterminal,
}
struct DeletionEvidence {
    proof: DeletionProof,
    call_id: Option<String>,
    approval_request_id: Option<String>,
}
struct PendingDeletion {
    event_id: String,
    delete_event_id: Option<String>,
    retrieving: bool,
}
struct HostedCall {
    server_label: String,
    terminal: bool,
}
#[derive(Default)]
struct Batch {
    calls: Vec<String>,
    hosted: Vec<String>,
    hosted_calls: BTreeMap<String, HostedCall>,
    admitted: bool,
    out_of_band: bool,
}
/// All mutation is synchronous and serialized by the host's Wasm instance.
/// No OS, executor, socket, callback, filesystem, or ambient credential access.
pub struct Control {
    phase: Phase,
    clear_output_audio_on_interrupt: bool,
    tools: BTreeMap<String, Tool>,
    expected_session: Value,
    accepted_session: Value,
    pending_tools: BTreeMap<String, Tool>,
    calls: BTreeMap<String, Call>,
    hosted: BTreeMap<String, Value>,
    pending_hosted: BTreeMap<String, Value>,
    response_hosted: BTreeMap<String, Value>,
    approvals: BTreeMap<String, HostedApproval>,
    detached: BTreeMap<String, DetachedResponse>,
    pending_detached: Option<ResponseScope>,
    detached_bytes: usize,
    profile_id: u64,
    pending_profile_id: u64,
    response_profile_id: u64,
    pending_response: Option<Value>,
    pending_response_event: Option<String>,
    pending_default: Option<ResponseScope>,
    pending_default_event: Option<PendingDefaultCreate>,
    retired_default_event_ids: VecDeque<String>,
    default_metadata_generated: bool,
    detached_guardrails: BTreeMap<String, (String, bool)>,
    last_completed: Option<String>,
    batches: BTreeMap<String, Batch>,
    responses: PendingDefault,
    next_send: u64,
    next_cancel: u64,
    pending_send: BTreeSet<u64>,
    pending_deletions: BTreeMap<String, PendingDeletion>,
    pending_retrieval: Option<(String, String)>,
    deletion_proofs: BTreeMap<String, DeletionEvidence>,
    deletion_order: VecDeque<String>,
    incoming: VecDeque<(Value, usize)>,
    incoming_bytes: usize,
    startup_send: Option<u64>,
    raw_settings_event: Option<String>,
    startup_sent: bool,
    startup_accepted: bool,
    updating: bool,
    response_tools: BTreeMap<String, Tool>,
    retired_responses: BTreeSet<String>,
    retired_response_order: VecDeque<String>,
    completed_responses: BTreeSet<String>,
    completed_response_order: VecDeque<String>,
    cancel_before_created: bool,
    pending_cancel_event: Option<String>,
    raw_cancel_events: VecDeque<String>,
    cancel_waiting: Option<String>,
    hosted_mcp_auto_response: bool,
    guardrail_output: Option<String>,
}
struct DefaultCancelScope {
    live: bool,
    matches_pending: bool,
    preserves_other: bool,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            phase: Phase::New,
            clear_output_audio_on_interrupt: false,
            tools: BTreeMap::new(),
            expected_session: Value::Null,
            accepted_session: Value::Null,
            pending_tools: BTreeMap::new(),
            calls: BTreeMap::new(),
            hosted: BTreeMap::new(),
            pending_hosted: BTreeMap::new(),
            response_hosted: BTreeMap::new(),
            approvals: BTreeMap::new(),
            detached: BTreeMap::new(),
            pending_detached: None,
            detached_bytes: 0,
            profile_id: 0,
            pending_profile_id: 0,
            response_profile_id: 0,
            pending_response: None,
            pending_response_event: None,
            pending_default: None,
            pending_default_event: None,
            retired_default_event_ids: VecDeque::new(),
            default_metadata_generated: false,
            detached_guardrails: BTreeMap::new(),
            last_completed: None,
            batches: BTreeMap::new(),
            responses: PendingDefault::default(),
            next_send: 0,
            next_cancel: 0,
            pending_send: BTreeSet::new(),
            pending_deletions: BTreeMap::new(),
            pending_retrieval: None,
            deletion_proofs: BTreeMap::new(),
            deletion_order: VecDeque::new(),
            incoming: VecDeque::new(),
            incoming_bytes: 0,
            startup_send: None,
            raw_settings_event: None,
            startup_sent: false,
            startup_accepted: false,
            updating: false,
            response_tools: BTreeMap::new(),
            retired_responses: BTreeSet::new(),
            retired_response_order: VecDeque::new(),
            completed_responses: BTreeSet::new(),
            completed_response_order: VecDeque::new(),
            cancel_before_created: false,
            pending_cancel_event: None,
            raw_cancel_events: VecDeque::new(),
            cancel_waiting: None,
            hosted_mcp_auto_response: true,
            guardrail_output: None,
        }
    }
}
impl Control {
    fn next_cancel_id(&self) -> String {
        format!("cancel_{}", self.next_cancel + 1)
    }
    fn send(&mut self, mut event: Value, effects: &mut Vec<Effect>) -> u64 {
        if event["type"] == "response.cancel" {
            if let Some(event_id) = event["event_id"].as_str() {
                if self.raw_cancel_events.len() == MAX_CALLS {
                    self.raw_cancel_events.pop_front();
                }
                self.raw_cancel_events.push_back(event_id.to_owned());
            } else {
                event["event_id"] = json!(self.next_cancel_id());
                self.next_cancel += 1;
            }
        }
        self.next_send += 1;
        self.pending_send.insert(self.next_send);
        effects.push(Effect::Send {
            id: self.next_send,
            event,
        });
        self.next_send
    }
    fn default_cancel_target(&self) -> Option<String> {
        let mut target = self.responses.sdk_response_id.clone();
        for (event, _) in &self.incoming {
            if self.is_detached_event(event) || self.is_retired_event(event) {
                continue;
            }
            let id = event["response_id"]
                .as_str()
                .or_else(|| event["response"]["id"].as_str());
            match event["type"].as_str() {
                Some("response.created")
                    if !id.is_some_and(|id| self.completed_responses.contains(id)) =>
                {
                    target = id.map(str::to_owned)
                }
                Some("response.done" | "response.cancelled") if id == target.as_deref() => {
                    target = None
                }
                _ => {}
            }
        }
        target
    }
    fn cancel_preflight(&self, response_id: Option<&str>) -> Vec<Effect> {
        // Phase and invalid-owner validation on actual cancellation.
        if self.require_ready().is_err() {
            return vec![];
        }
        let received = self.default_cancel_target();
        let detached = response_id.is_some_and(|id| {
            self.responses.sdk_response_id.as_deref() != Some(id)
                && received.as_deref() != Some(id)
                && !self.has_received_default_response(Some(id))
        });
        let clear_default = !detached
            && response_id.is_none_or(|id| {
                let scope = self.default_cancel_scope(id);
                scope.live || !scope.preserves_other
            });
        let target = match response_id {
            Some(id)
                if self.responses.sdk_response_id.as_deref() != Some(id)
                    && received.as_deref() != Some(id)
                    && !self.has_received_default_response(Some(id)) =>
            {
                self.detached
                    .get(id)
                    .filter(|owner| owner.active)
                    .map(|_| id.to_owned())
            }
            Some(id) => received.filter(|current| current == id),
            None => received,
        };
        let mut effects = target.map(|id| vec![Effect::Preflight {
            event: json!({"type":"response.cancel","response_id":id,"event_id":self.next_cancel_id()}),
            immediate: true,
        }]).unwrap_or_default();
        if self.clear_output_audio_on_interrupt && clear_default {
            effects.push(Effect::Preflight {
                event: json!({"type":"output_audio_buffer.clear"}),
                immediate: true,
            });
        }
        effects
    }
    fn response_preflight(&self, response: Option<&Value>) -> Vec<Effect> {
        // Scope, phase and payload validation on actual response admission.
        if self.require_ready().is_err()
            || response.is_some_and(|value| self.validate_response(value).is_err())
        {
            return vec![];
        }
        let (event, immediate) =
            if let Some(response) = response.filter(|value| value["conversation"] == "none") {
                if self.pending_detached.is_some() || self.detached.len() >= MAX_CALLS {
                    return vec![];
                }
                (json!({"type":"response.create","response":response}), true)
            } else {
                let immediate =
                    !self.defers_default_response() && !self.responses.active_default_response;
                // Native send-counter width for a deferred generated token.
                let send_id = if immediate {
                    self.next_send + 1
                } else {
                    u64::MAX
                };
                let event = match response.or(self.pending_response.as_ref()) {
                    Some(response) => Self::default_response_event(response.clone(), send_id).0,
                    None => json!({"type":"response.create"}),
                };
                (event, immediate)
            };
        vec![Effect::Preflight { event, immediate }]
    }
    fn client_command(
        &self,
        mut event: Value,
        history: Vec<Value>,
        profile_id: u64,
    ) -> Result<(Command, Option<String>), String> {
        self.require_ready()?;
        let fields = event
            .as_object_mut()
            .ok_or("Realtime event must be an object")?;
        let event_id = match fields.remove("event_id") {
            Some(Value::String(id)) if !id.is_empty() && id.len() <= 512 => Some(id),
            None | Some(Value::Null) => None,
            _ => return Err("Invalid Realtime event ID".into()),
        };
        let kind = match fields.get("type").and_then(Value::as_str) {
            Some("input_audio_buffer.append") => "audio",
            Some("input_audio_buffer.commit") => "commit_audio",
            Some("input_audio_buffer.clear") => "clear_audio",
            Some("output_audio_buffer.clear") => "clear_output_audio",
            Some("conversation.item.create") if !fields.contains_key("create_response") => {
                fields.insert("create_response".into(), json!(false));
                "input"
            }
            Some("conversation.item.retrieve") => "retrieve",
            Some("conversation.item.delete") => "delete",
            Some("conversation.item.truncate") => "truncate",
            Some("response.create") if !fields.contains_key("history") => {
                fields.insert("history".into(), json!(history));
                "create_response"
            }
            Some("response.cancel") => "cancel",
            Some("session.update") if !fields.contains_key("profile_id") => {
                fields.insert("profile_id".into(), json!(profile_id));
                "update_settings"
            }
            _ => return Err("Unsupported raw Realtime client event".into()),
        };
        fields.insert("type".into(), json!(kind));
        // Serde unit variants do not inspect leftover object fields.
        if matches!(kind, "commit_audio" | "clear_audio" | "clear_output_audio")
            && fields.len() != 1
        {
            return Err("Invalid raw Realtime client event".into());
        }
        let command =
            serde_json::from_value(event).map_err(|_| "Invalid raw Realtime client event")?;
        match &command {
            Command::Audio { audio } => validate_audio(audio)?,
            Command::Input {
                item,
                previous_item_id,
                ..
            } => {
                Self::validate_input(item)?;
                if previous_item_id.as_ref().is_some_and(|id| {
                    !id.is_null() && id.as_str().is_none_or(|id| id.is_empty() || id.len() > 512)
                }) {
                    return Err("Invalid previous conversation item ID".into());
                }
            }
            Command::Retrieve { item_id, .. }
            | Command::Delete { item_id, .. }
            | Command::Truncate { item_id, .. } => validate_client_id(item_id)?,
            Command::Cancel {
                response_id: Some(id),
            } => {
                validate_client_id(id)?;
                if self.responses.sdk_response_id.as_ref() != Some(id)
                    && self.default_cancel_target().as_ref() != Some(id)
                    && !self.has_received_default_response(Some(id))
                    && self
                        .detached
                        .get(id)
                        .is_none_or(|response| !response.active)
                {
                    return Err("Unknown response cancellation identity".into());
                }
            }
            Command::CreateResponse {
                response: Some(response),
                ..
            } => {
                self.validate_response(response)?;
                if response["conversation"] == "none"
                    && (self.pending_detached.is_some() || self.detached.len() >= MAX_CALLS)
                {
                    return Err("Detached response request exceeds capacity".into());
                }
            }
            Command::UpdateSettings { session, .. } => {
                self.updated_session(session)?;
            }
            _ => {}
        }
        Ok((command, event_id))
    }
    fn client_preflight(
        &self,
        command: &Command,
        event_id: Option<&str>,
    ) -> Result<Vec<Effect>, String> {
        let mut effects = match command {
            Command::Cancel { response_id } => self.cancel_preflight(response_id.as_deref()),
            Command::CreateResponse { response, .. } => self.response_preflight(response.as_ref()),
            Command::UpdateSettings { session, .. } => {
                let id = event_id
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("portable-settings-{}", self.next_send + 1));
                return Ok(vec![Effect::Preflight {
                    event: with_event_id(
                        json!({"type":"session.update","session":self.updated_session(session)?}),
                        Some(&id),
                    ),
                    immediate: true,
                }]);
            }
            _ => vec![],
        };
        for effect in &mut effects {
            if let Effect::Preflight { event, .. } = effect {
                if event["type"] != "output_audio_buffer.clear" {
                    if let Some(id) = event_id {
                        event["event_id"] = json!(id);
                    }
                }
            }
        }
        Ok(effects)
    }
    fn updated_session(&self, changes: &Value) -> Result<Value, String> {
        let fields = changes
            .as_object()
            .ok_or("Realtime session settings must be an object")?;
        for (key, value) in fields {
            match key.as_str() {
                "model" | "tools" if self.accepted_session.get(key) != Some(value) => {
                    return Err("Update the agent to change its model or tool catalog".into());
                }
                "type" if value != "realtime" => {
                    return Err("Expected Realtime session settings".into());
                }
                "instructions" if !value.is_string() => {
                    return Err("Instructions must be a string".into());
                }
                _ => {}
            }
        }
        let mut session = self.accepted_session.clone();
        merge_settings(&mut session, changes);
        Ok(session)
    }
    pub fn apply(&mut self, command: Command) -> Result<Vec<Effect>, String> {
        if let Command::ValidateCancel { response_id } = &command {
            return Ok(self.cancel_preflight(response_id.as_deref()));
        }
        if let Command::ValidateResponse { response } = &command {
            return Ok(self.response_preflight(response.as_ref()));
        }
        if let Command::ValidateDelete { item_id, event_id } = &command {
            let event = if self.require_ready().is_ok()
                && !self.pending_deletions.contains_key(item_id)
                && self.validate_live_deletion(item_id).is_ok()
                && item_id.len() <= 512
                && self.pending_deletions.len() < MAX_CALLS
            {
                let retrieving = self.validate_deletion(item_id).is_err();
                let event = self.deletion_event(item_id, retrieving);
                Some(if retrieving {
                    event
                } else {
                    with_event_id(event, event_id.as_deref())
                })
            } else {
                None
            };
            return Ok(event
                .map(|event| {
                    vec![Effect::Preflight {
                        event,
                        immediate: true,
                    }]
                })
                .unwrap_or_default());
        }
        if let Command::ValidateTruncate {
            item_id,
            content_index,
            audio_end_ms,
        } = &command
        {
            return Ok(if self.require_ready().is_ok() && !item_id.is_empty() {
                vec![Effect::Preflight {
                    event: Self::truncate_event(item_id, *content_index, *audio_end_ms),
                    immediate: true,
                }]
            } else {
                vec![]
            });
        }
        if let Command::ValidateHistory { delete_ids, items } = &command {
            self.require_ready()?;
            if delete_ids.len() + items.len() > MAX_CALLS {
                return Err("History plan exceeds capacity".into());
            }
            for id in delete_ids {
                self.validate_deletion(id)?;
            }
            for item in items {
                Self::validate_input(item)?;
            }
            return Ok(vec![]);
        }
        let (command, event_id) = match command {
            Command::SendEvent {
                event,
                validate,
                history,
                profile_id,
            } => {
                let (command, event_id) = self.client_command(event, history, profile_id)?;
                if validate {
                    return self.client_preflight(&command, event_id.as_deref());
                }
                (command, event_id)
            }
            command => (command, None),
        };
        let result = self.transition(command, event_id.as_deref());
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn retire(&mut self) {
        self.phase = Phase::Closed;
        self.tools.clear();
        self.pending_tools.clear();
        self.expected_session = Value::Null;
        self.accepted_session = Value::Null;
        self.calls.clear();
        self.hosted.clear();
        self.pending_hosted.clear();
        self.response_hosted.clear();
        self.approvals.clear();
        self.detached.clear();
        self.pending_detached = None;
        self.detached_bytes = 0;
        self.pending_response = None;
        self.pending_response_event = None;
        self.raw_settings_event = None;
        self.pending_cancel_event = None;
        self.raw_cancel_events.clear();
        self.pending_default = None;
        self.pending_default_event = None;
        self.retired_default_event_ids.clear();
        self.detached_guardrails.clear();
        self.last_completed = None;
        self.batches.clear();
        self.pending_send.clear();
        self.pending_deletions.clear();
        self.pending_retrieval = None;
        self.deletion_proofs.clear();
        self.deletion_order.clear();
        self.incoming.clear();
        self.incoming_bytes = 0;
        self.responses = PendingDefault::default();
        self.response_tools.clear();
        self.retired_responses.clear();
        self.retired_response_order.clear();
        self.completed_responses.clear();
        self.completed_response_order.clear();
        self.guardrail_output = None;
        self.cancel_waiting = None;
        self.next_cancel = 0;
    }
    fn transition(
        &mut self,
        command: Command,
        event_id: Option<&str>,
    ) -> Result<Vec<Effect>, String> {
        if self.phase == Phase::Closed {
            return if matches!(command, Command::Close) {
                Ok(vec![])
            } else {
                Err("Realtime control is closed".into())
            };
        }
        let mut effects = vec![];
        match command {
            Command::ValidateDelete { .. }
            | Command::ValidateTruncate { .. }
            | Command::ValidateHistory { .. }
            | Command::ValidateCancel { .. }
            | Command::ValidateResponse { .. }
            | Command::SendEvent { .. } => {
                unreachable!("client commands are decoded before transition")
            }
            Command::Start {
                config,
                clear_output_audio_on_interrupt,
            } => {
                if self.phase != Phase::New {
                    return Err("Realtime control already started".into());
                }
                self.hosted_mcp_auto_response = config.hosted_mcp_auto_response;
                self.configure(config, false, &mut effects)?;
                self.clear_output_audio_on_interrupt = clear_output_audio_on_interrupt;
            }
            Command::Update { config } => {
                if self.phase != Phase::Ready {
                    return Err("Realtime configuration is not accepted".into());
                }
                self.configure(config, true, &mut effects)?;
            }
            Command::UpdateSettings {
                session,
                profile_id,
            } => {
                if self.phase != Phase::Ready {
                    return Err("Realtime configuration is not accepted".into());
                }
                let session = self.updated_session(&session)?;
                let id = event_id
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("portable-settings-{}", self.next_send + 1));
                self.pending_tools = self.tools.clone();
                self.pending_hosted = self.hosted.clone();
                self.pending_profile_id = profile_id;
                self.configure_session(session, true, Some(&id), &mut effects);
                self.raw_settings_event = Some(id);
            }
            Command::ClearOutputAudio => {
                self.require_ready()?;
                self.send(
                    with_event_id(json!({"type":"output_audio_buffer.clear"}), event_id),
                    &mut effects,
                );
            }
            Command::Retrieve {
                item_id,
                event_id: retrieve_id,
            } => {
                self.require_ready()?;
                validate_client_id(&item_id)?;
                if self.pending_retrieval.is_some() {
                    return Err("Realtime history retrieval is already pending".into());
                }
                let event_id = event_id
                    .or(retrieve_id.as_deref())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("portable-history-{}", self.next_send + 1));
                self.send(
                    json!({"type":"conversation.item.retrieve","item_id":item_id,"event_id":event_id}),
                    &mut effects,
                );
                self.pending_retrieval = Some((item_id, event_id));
            }
            Command::Cancel { response_id } => {
                self.require_ready()?;
                let target = self.default_cancel_target();
                if let Some(id) = response_id.as_ref().filter(|id| {
                    self.responses.sdk_response_id.as_ref() != Some(id)
                        && target.as_ref() != Some(id)
                        && !self.has_received_default_response(Some(id.as_str()))
                }) {
                    let active = self
                        .detached
                        .get_mut(id)
                        .ok_or("Unknown response cancellation identity")?;
                    if !active.active {
                        return Err("Detached response is already finished".into());
                    }
                    active.active = false;
                    self.abort_scope(&id, &mut effects);
                    self.detached_guardrails.remove(id);
                    self.send(
                        with_event_id(json!({"type":"response.cancel","response_id":id}), event_id),
                        &mut effects,
                    );
                } else {
                    if let Some(id) = response_id {
                        self.cancel_selected_default(&id, event_id, &mut effects);
                    } else {
                        self.interrupt(&mut effects, target, true, event_id)?;
                    }
                }
            }
            Command::Guardrail {
                response_id,
                output,
            } => {
                self.require_ready()?;
                if output.len() > MAX_CALL_BYTES {
                    return Err("Guardrail output exceeds capacity".into());
                }
                if let Some(active) = self.detached.get_mut(&response_id) {
                    if active.scope.is_none() {
                        return Err(
                            "Unmanaged detached response has no SDK guardrail source".into()
                        );
                    }
                    let active = std::mem::replace(&mut active.active, false);
                    if self.detached_guardrails.contains_key(&response_id) {
                        return Err("Detached guardrail already settled".into());
                    }
                    self.detached_guardrails
                        .insert(response_id.clone(), (output, !active));
                    if active {
                        self.send(
                            json!({"type":"response.cancel","response_id":response_id}),
                            &mut effects,
                        );
                    }
                    self.abort_scope(&response_id, &mut effects);
                } else {
                    if self.responses.sdk_response_id.as_ref() != Some(&response_id)
                        && !(self.last_completed.as_ref() == Some(&response_id)
                            && !self.responses.active_default_response)
                    {
                        return Err("Guardrail does not own the active response".into());
                    }
                    self.last_completed = None;
                    self.interrupt(
                        &mut effects,
                        self.responses.sdk_response_id.clone(),
                        false,
                        None,
                    )?;
                    self.guardrail_output = Some(output);
                    self.release_guardrail(&mut effects);
                    if !effects.iter().any(|effect|matches!(effect,Effect::Retire {response_id:id} if id == &response_id)) {
                        effects.push(Effect::Retire {response_id});
                    }
                }
            }
            Command::Audio { audio } => {
                self.require_ready()?;
                validate_audio(&audio)?;
                self.send(
                    with_event_id(
                        json!({"type":"input_audio_buffer.append","audio":audio}),
                        event_id,
                    ),
                    &mut effects,
                );
            }
            Command::CommitAudio => {
                self.require_ready()?;
                self.send(
                    with_event_id(json!({"type":"input_audio_buffer.commit"}), event_id),
                    &mut effects,
                );
            }
            Command::ClearAudio => {
                self.require_ready()?;
                self.send(
                    with_event_id(json!({"type":"input_audio_buffer.clear"}), event_id),
                    &mut effects,
                );
            }
            Command::CreateResponse { response, history } => {
                self.require_ready()?;
                if let Some(response) = response {
                    self.validate_response(&response)?;
                    if response["conversation"] == "none" {
                        let scope = self.new_scope(response, history);
                        self.send_detached(scope, event_id, &mut effects)?;
                    } else {
                        self.pending_response = Some(response);
                        self.pending_response_event = event_id.map(str::to_owned);
                        self.request_response(&mut effects);
                    }
                } else {
                    if event_id.is_some() {
                        self.pending_response_event = event_id.map(str::to_owned);
                    }
                    self.request_response(&mut effects);
                }
            }
            Command::ApproveMcp {
                request_id,
                approved,
            } => {
                self.require_ready()?;
                let request = self
                    .approvals
                    .get(&request_id)
                    .ok_or("Unknown hosted MCP approval")?;
                if request.phase != CallPhase::Approval {
                    return Err("Hosted MCP approval is stale or already settled".into());
                }
                if self.detached.contains_key(&request.response_id) {
                    let request = self.approvals.get_mut(&request_id).unwrap();
                    request.decision = Some(approved);
                    request.phase = CallPhase::Published;
                } else {
                    let id = self.send(json!({"type":"conversation.item.create","item":{"type":"mcp_approval_response","approval_request_id":request_id,"approve":approved}}), &mut effects);
                    self.approvals.get_mut(&request_id).unwrap().phase = CallPhase::Publishing(id);
                }
            }
            Command::Input {
                item,
                previous_item_id,
                create_response,
            } => {
                self.require_ready()?;
                Self::validate_input(&item)?;
                let mut event = json!({"type":"conversation.item.create","item":item});
                if let Some(previous) = previous_item_id {
                    if !previous.is_null() && !previous.is_string() {
                        return Err("Invalid previous item identity".into());
                    }
                    event["previous_item_id"] = previous;
                }
                self.send(with_event_id(event, event_id), &mut effects);
                if create_response {
                    self.request_response(&mut effects);
                }
            }
            Command::Delete {
                item_id,
                event_id: delete_id,
            } => {
                self.require_ready()?;
                self.begin_deletion(&item_id, event_id.or(delete_id.as_deref()), &mut effects);
            }
            Command::Truncate {
                item_id,
                content_index,
                audio_end_ms,
            } => {
                self.require_ready()?;
                if item_id.is_empty() {
                    return Err("Missing conversation item identity".into());
                }
                self.send(
                    with_event_id(
                        Self::truncate_event(&item_id, content_index, audio_end_ms),
                        event_id,
                    ),
                    &mut effects,
                );
            }
            Command::Sent { id } => {
                if !self.pending_send.remove(&id) {
                    return Err("Unknown or already settled send receipt".into());
                }
                if self.startup_send == Some(id) {
                    self.startup_sent = true;
                }
                for approval in self.approvals.values_mut() {
                    if approval.phase == CallPhase::Publishing(id) {
                        approval.phase = CallPhase::Published;
                    }
                }
                for call in self.calls.values_mut() {
                    if call.phase == CallPhase::Publishing(id) {
                        call.phase = CallPhase::Published;
                    }
                }
                while self.pending_send.is_empty() {
                    let Some((event, bytes)) = self.incoming.pop_front() else {
                        break;
                    };
                    self.incoming_bytes -= bytes;
                    // Each queued event remains a canonical transition, including readiness.
                    effects.extend(self.transition(Command::Provider { event }, None)?);
                }
                self.release_guardrail(&mut effects);
            }
            Command::Provider { event } => {
                // Retirement is never delayed by another operation's send receipt.
                let bytes = self.provider_gate(&event)?;
                if self.pending_send.is_empty()
                    || event["type"] == "input_audio_buffer.speech_started"
                    || self.is_retired_event(&event)
                {
                    self.provider(event, &mut effects)?;
                } else {
                    if self.incoming.len() == MAX_CALLS
                        || self.incoming_bytes + bytes > MAX_FRAME_BYTES
                    {
                        return Err("Portable voice ingress exceeds capacity".into());
                    }
                    self.incoming.push_back((event, bytes));
                    self.incoming_bytes += bytes;
                }
            }
            Command::Approve {
                call_id,
                approved,
                output,
            } => {
                self.require_ready()?;
                let call = self.calls.get_mut(&call_id).ok_or("Unknown approval")?;
                if call.phase != CallPhase::Approval {
                    return Err("Approval is stale or already settled".into());
                }
                if approved {
                    call.phase = CallPhase::Executing;
                    effects.push(execute(&call.request)?);
                } else {
                    self.publish(
                        &call_id,
                        output.unwrap_or_else(|| "Tool execution was not approved.".into()),
                        false,
                        &mut effects,
                    )?;
                }
            }
            Command::ToolResult {
                call_id,
                output,
                background,
            } => {
                self.require_ready()?;
                if self
                    .calls
                    .get(&call_id)
                    .is_none_or(|call| call.phase != CallPhase::Executing)
                {
                    return Err("Tool result has no live execution claim".into());
                }
                self.publish(&call_id, output, background, &mut effects)?;
            }
            Command::Text { text } => {
                self.require_ready()?;
                self.send(json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}), &mut effects);
                self.request_response(&mut effects);
            }
            Command::Close => {
                self.retire();
                effects.push(Effect::Closed);
            }
        }
        if self.phase == Phase::Configuring && self.startup_sent && self.startup_accepted {
            self.phase = Phase::Ready;
            self.tools = std::mem::take(&mut self.pending_tools);
            self.hosted = std::mem::take(&mut self.pending_hosted);
            self.profile_id = self.pending_profile_id;
            self.accepted_session = self.expected_session.clone();
            self.raw_settings_event = None;
            effects.push(if self.updating {
                Effect::Configured
            } else {
                Effect::Ready
            });
            self.updating = false;
            self.release_guardrail(&mut effects);
            if self.responses.pending_create && !self.responses.active_default_response {
                self.request_response(&mut effects);
            }
        }
        self.release_detached_guardrails(&mut effects)?;
        self.continue_batches(&mut effects)?;
        if self.pending_send.len() > MAX_CALLS {
            return Err("Portable voice send capacity exceeded".into());
        }
        Ok(effects)
    }
    fn validate_input(item: &Value) -> Result<(), String> {
        if item["type"] != "message"
            || !matches!(item["role"].as_str(), Some("user" | "assistant" | "system"))
            || !item["content"].is_array()
        {
            return Err("Input must be a conversation message".into());
        }
        Ok(())
    }
    fn validate_live_deletion(&self, item_id: &str) -> Result<(), String> {
        if item_id.is_empty() {
            return Err("Missing conversation item identity".into());
        }
        let evidence = self.deletion_proofs.get(item_id);
        if self.calls.values().any(|call| {
            (call.request.item_id == item_id
                || evidence.and_then(|evidence| evidence.call_id.as_deref())
                    == Some(call.request.call_id.as_str()))
                && !matches!(call.phase, CallPhase::Published | CallPhase::Cancelled)
        }) || self.approvals.iter().any(|(request_id, request)| {
            (request_id == item_id
                || evidence.and_then(|evidence| evidence.approval_request_id.as_deref())
                    == Some(request_id.as_str()))
                && !matches!(request.phase, CallPhase::Published | CallPhase::Cancelled)
        }) {
            return Err("Conversation deletion conflicts with live tool ownership".into());
        }
        Ok(())
    }
    fn validate_deletion(&self, item_id: &str) -> Result<(), String> {
        self.validate_live_deletion(item_id)?;
        if self.deletion_proof(item_id) == Some(DeletionProof::Nonterminal) {
            return Err("Conversation deletion requires a settled provider item".into());
        }
        let locally_settled = self.calls.values().any(|call| {
            call.request.item_id == item_id
                && matches!(call.phase, CallPhase::Published | CallPhase::Cancelled)
        }) || self.approvals.get(item_id).is_some_and(|approval| {
            matches!(approval.phase, CallPhase::Published) && approval.decision.is_some()
        });
        if locally_settled
            || matches!(
                self.deletion_proof(item_id),
                Some(DeletionProof::Terminal | DeletionProof::ApprovalDecided)
            )
        {
            Ok(())
        } else {
            Err("Conversation deletion requires a settled provider item".into())
        }
    }
    fn reject_deletion(item_id: &str, effects: &mut Vec<Effect>) {
        effects.push(Effect::HistoryRejected {
            item_id: item_id.into(),
            message: "Conversation deletion requires a settled provider item".into(),
        });
    }
    fn truncate_event(item_id: &str, content_index: u32, audio_end_ms: u32) -> Value {
        json!({"type":"conversation.item.truncate","item_id":item_id,"content_index":content_index,"audio_end_ms":audio_end_ms})
    }
    fn deletion_event(&self, item_id: &str, retrieving: bool) -> Value {
        let kind = if retrieving {
            "conversation.item.retrieve"
        } else {
            "conversation.item.delete"
        };
        json!({"type":kind,"item_id":item_id,"event_id":format!("portable-history-{}", self.next_send + 1)})
    }
    fn send_deletion(
        &mut self,
        item_id: &str,
        retrieving: bool,
        delete_event_id: Option<&str>,
        effects: &mut Vec<Effect>,
    ) {
        let mut event = self.deletion_event(item_id, retrieving);
        if !retrieving {
            event = with_event_id(event, delete_event_id);
        }
        self.pending_deletions.insert(
            item_id.into(),
            PendingDeletion {
                event_id: event["event_id"].as_str().unwrap().to_owned(),
                delete_event_id: delete_event_id.map(str::to_owned),
                retrieving,
            },
        );
        self.send(event, effects);
    }
    fn begin_deletion(&mut self, item_id: &str, event_id: Option<&str>, effects: &mut Vec<Effect>) {
        if self.pending_deletions.contains_key(item_id) {
            return;
        }
        if self.validate_live_deletion(item_id).is_err()
            || item_id.len() > 512
            || self.pending_deletions.len() == MAX_CALLS
        {
            Self::reject_deletion(item_id, effects);
        } else if self.validate_deletion(item_id).is_ok() {
            self.send_deletion(item_id, false, event_id, effects);
        } else {
            self.send_deletion(item_id, true, event_id, effects);
        }
    }
    fn deletion_proof(&self, id: &str) -> Option<DeletionProof> {
        self.deletion_proofs.get(id).map(|evidence| evidence.proof)
    }
    fn remember_deletion_proof(&mut self, id: &str, proof: DeletionProof) {
        if id.is_empty() || id.len() > 512 {
            return;
        }
        if !self.deletion_proofs.contains_key(id) {
            if self.deletion_proofs.len() == MAX_OBSERVED_ITEMS {
                if let Some(oldest) = self.deletion_order.pop_front() {
                    self.deletion_proofs.remove(&oldest);
                }
            }
            self.deletion_order.push_back(id.into());
        }
        self.deletion_proofs
            .entry(id.into())
            .and_modify(|evidence| evidence.proof = proof)
            .or_insert(DeletionEvidence {
                proof,
                call_id: None,
                approval_request_id: None,
            });
    }
    fn observe_deletion_item(&mut self, item: &Value) {
        let Some(id) = item["id"].as_str() else {
            return;
        };
        let kind = item["type"].as_str().unwrap_or("");
        let status = item.get("status");
        let nonterminal =
            status.is_some_and(|status| !status.is_null() && status.as_str() != Some("completed"));
        let terminal = match kind {
            "message" => true,
            "function_call" => status.and_then(Value::as_str) == Some("completed"),
            "function_call_output" => {
                !nonterminal
                    && item["call_id"].as_str().is_some_and(|id| !id.is_empty())
                    && item["output"].is_string()
            }
            "mcp_call" => {
                !nonterminal
                    && (item["output"].is_string()
                        || item["error"].is_string()
                        || item["error"].is_object())
            }
            "mcp_list_tools" => !nonterminal && item["tools"].is_array(),
            "mcp_approval_request" => {
                !nonterminal
                    && matches!(
                        self.deletion_proof(id),
                        Some(DeletionProof::ApprovalDecided | DeletionProof::ApprovalDecisionOnly)
                    )
            }
            "mcp_approval_response" => {
                !nonterminal
                    && item["approve"].is_boolean()
                    && item["approval_request_id"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
            }
            _ => false,
        };
        if kind == "mcp_approval_response" && terminal {
            let request_id = item["approval_request_id"].as_str().unwrap();
            let proof = if matches!(
                self.deletion_proof(request_id),
                Some(DeletionProof::ApprovalRequest | DeletionProof::ApprovalDecided)
            ) {
                DeletionProof::ApprovalDecided
            } else {
                DeletionProof::ApprovalDecisionOnly
            };
            self.remember_deletion_proof(request_id, proof);
        }
        let proof = if nonterminal && kind != "message" {
            DeletionProof::Nonterminal
        } else if kind == "mcp_approval_request" && terminal {
            DeletionProof::ApprovalDecided
        } else if terminal {
            DeletionProof::Terminal
        } else if kind == "mcp_approval_request" {
            DeletionProof::ApprovalRequest
        } else {
            DeletionProof::Active
        };
        self.remember_deletion_proof(id, proof);
        if let Some(evidence) = self.deletion_proofs.get_mut(id) {
            if ["call_id", "approval_request_id"]
                .iter()
                .any(|key| item[*key].as_str().is_some_and(|id| id.len() > 512))
            {
                evidence.proof = DeletionProof::Nonterminal;
            }
            evidence.call_id = item["call_id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 512)
                .map(str::to_owned);
            evidence.approval_request_id = item["approval_request_id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 512)
                .map(str::to_owned);
        }
    }
    fn deletion_error_item(&self, event: &Value) -> Option<String> {
        if event["type"] != "error"
            || event["error"]["type"] != "invalid_request_error"
            || !event["error"]["message"].is_string()
        {
            return None;
        }
        let id = event["error"]["event_id"].as_str()?;
        self.pending_deletions
            .iter()
            .find(|(_, pending)| pending.event_id == id)
            .map(|(item_id, _)| item_id.clone())
    }
    fn configure(
        &mut self,
        config: Config,
        updating: bool,
        effects: &mut Vec<Effect>,
    ) -> Result<(), String> {
        if config.model.is_empty()
            || config.tools.len() > MAX_CALLS
            || config
                .settings
                .keys()
                .any(|key| matches!(key.as_str(), "type" | "model" | "instructions" | "tools"))
        {
            return Err("Invalid Realtime configuration".into());
        }
        let mut tools = BTreeMap::new();
        let mut wire_tools = vec![];
        for tool in config.tools {
            if tool.name.is_empty()
                || !tool.parameters.is_object()
                || tools.contains_key(&tool.name)
            {
                return Err("Invalid or duplicate Realtime tool".into());
            }
            wire_tools.push(json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.parameters}));
            tools.insert(tool.name.clone(), tool);
        }
        let mut hosted = BTreeMap::new();
        if config.hosted_tools.len() + wire_tools.len() > MAX_CALLS {
            return Err("Realtime tool capacity exceeded".into());
        }
        for tool in config.hosted_tools {
            let label = string(&tool, "server_label")?;
            let url = tool["server_url"].as_str().is_some_and(|s| !s.is_empty());
            let connector = tool["connector_id"].as_str().is_some_and(|s| !s.is_empty());
            if tool["type"] != "mcp" || url == connector || hosted.contains_key(&label) {
                return Err("Invalid or duplicate hosted MCP declaration".into());
            }
            hosted.insert(label, tool.clone());
            wire_tools.push(tool);
        }
        self.pending_hosted = hosted;
        self.pending_profile_id = config.profile_id;
        let mut session = json!({"type":"realtime","model":config.model,"instructions":config.instructions,"tools":wire_tools,"tool_choice":"auto"});
        session.as_object_mut().unwrap().extend(config.settings);
        // Catalog changes become observable only after the ordered exact ACK.
        self.pending_tools = tools;
        self.configure_session(session, updating, None, effects);
        Ok(())
    }
    fn configure_session(
        &mut self,
        session: Value,
        updating: bool,
        event_id: Option<&str>,
        effects: &mut Vec<Effect>,
    ) {
        self.phase = Phase::Configuring;
        self.updating = updating;
        self.startup_sent = false;
        self.startup_accepted = false;
        self.expected_session = session.clone();
        self.startup_send = Some(self.send(
            with_event_id(json!({"type":"session.update","session":session}), event_id),
            effects,
        ));
    }
    fn new_scope(&self, mut request: Value, history: Vec<Value>) -> ResponseScope {
        let mut tools = self.tools.clone();
        let mut hosted = self.hosted.clone();
        if let Some(selected) = request["tools"].as_array() {
            tools.retain(|name, _| {
                selected
                    .iter()
                    .any(|tool| tool["type"] == "function" && tool["name"] == *name)
            });
            hosted = selected
                .iter()
                .filter(|tool| tool["type"] == "mcp")
                .map(|tool| {
                    (
                        tool["server_label"].as_str().unwrap().to_owned(),
                        tool.clone(),
                    )
                })
                .collect();
        }
        let wire_request = request.clone();
        if request.get("instructions").is_none() {
            request["instructions"] = self.accepted_session["instructions"].clone();
        }
        if request.get("tools").is_none() {
            request["tools"] = self.accepted_session["tools"].clone();
        }
        // Defaults are captured for continuations; the first provider request remains unchanged.
        ResponseScope {
            profile_id: self.profile_id,
            tools,
            hosted,
            request: wire_request,
            continuation: request,
            history,
        }
    }
    fn send_detached(
        &mut self,
        scope: ResponseScope,
        event_id: Option<&str>,
        effects: &mut Vec<Effect>,
    ) -> Result<(), String> {
        if self.pending_detached.is_some() || self.detached.len() >= MAX_CALLS {
            return Err("Detached response request exceeds capacity".into());
        }
        self.detached_bytes += serde_json::to_vec(&scope)
            .map_err(|_| "Invalid detached scope")?
            .len();
        if self.detached_bytes > MAX_FRAME_BYTES {
            return Err("Detached response context exceeds capacity".into());
        }
        self.send(
            with_event_id(
                json!({"type":"response.create","response":scope.request}),
                event_id,
            ),
            effects,
        );
        self.pending_detached = Some(scope);
        Ok(())
    }
    fn release_detached_guardrails(&mut self, effects: &mut Vec<Effect>) -> Result<(), String> {
        if self.phase != Phase::Ready
            || self.pending_detached.is_some()
            || !self.pending_send.is_empty()
        {
            return Ok(());
        }
        let ready = self
            .detached_guardrails
            .iter()
            .find(|(_, (_, done))| *done)
            .map(|(id, _)| id.clone());
        if let Some(id) = ready {
            let (output, _) = self.detached_guardrails.remove(&id).unwrap();
            let mut scope = self
                .detached
                .get(&id)
                .and_then(|response| response.scope.clone())
                .ok_or("Detached guardrail has no managed source")?;
            let mut request = scope.continuation.clone();
            request["instructions"] = json!(output);
            scope.request = request.clone();
            scope.continuation = request;
            self.send_detached(scope, None, effects)?;
        }
        Ok(())
    }
    fn abort_scope(&mut self, response_id: &str, effects: &mut Vec<Effect>) {
        effects.push(Effect::Retire {
            response_id: response_id.to_owned(),
        });
        for (id, call) in &mut self.calls {
            if call.request.response_id.as_deref() == Some(response_id)
                && !matches!(call.phase, CallPhase::Published | CallPhase::Cancelled)
            {
                call.phase = CallPhase::Cancelled;
                effects.push(Effect::Abort {
                    call_id: id.clone(),
                });
            }
        }
        for (id, request) in &mut self.approvals {
            if request.response_id == response_id
                && !matches!(request.phase, CallPhase::Published | CallPhase::Cancelled)
            {
                request.phase = CallPhase::Cancelled;
                effects.push(Effect::AbortMcp {
                    request_id: id.clone(),
                });
            }
        }
        self.batches.remove(response_id);
    }
    fn validate_response(&self, response: &Value) -> Result<(), String> {
        response.as_object().ok_or("Response options must be an object")?;
        if response
            .get("conversation")
            .is_some_and(|value| value != "auto" && value != "none")
        {
            return Err("Invalid response conversation scope".into());
        }
        if let Some(metadata) = response.get("metadata").filter(|v| !v.is_null()) {
            let metadata = metadata.as_object().ok_or("Invalid response metadata")?;
            if metadata.len() > 16
                || metadata.iter().any(|(key, value)| {
                    key.chars().count() > 64
                        || value
                            .as_str()
                            .is_none_or(|value| value.chars().count() > 512)
                })
            {
                return Err("Invalid or reserved response metadata".into());
            }
        }
        {
            if let Some(tools) = response.get("tools") {
                for tool in tools.as_array().ok_or("Response tools must be an array")? {
                    let expected = if tool["type"] == "function" {
                        let tool = self
                            .tools
                            .get(tool["name"].as_str().unwrap_or_default())
                            .ok_or("Response tool is outside accepted configuration")?;
                        json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.parameters})
                    } else {
                        let url = tool["server_url"].as_str().is_some_and(|s| !s.is_empty());
                        let connector =
                            tool["connector_id"].as_str().is_some_and(|s| !s.is_empty());
                        if tool["type"] != "mcp"
                            || tool["server_label"].as_str().is_none_or(str::is_empty)
                            || url == connector
                        {
                            return Err("Invalid response hosted MCP declaration".into());
                        }
                        tool.clone()
                    };
                    if tool != &expected {
                        return Err("Response tool changed accepted configuration".into());
                    }
                }
            }
        }
        Ok(())
    }
    fn capture_response_tools(&mut self) {
        self.response_tools = self.tools.clone();
        self.response_hosted = self.hosted.clone();
        self.response_profile_id = self.profile_id;
        if let Some(tools) = self
            .pending_response
            .as_ref()
            .and_then(|response| response["tools"].as_array())
        {
            self.response_tools.retain(|name, _| {
                tools
                    .iter()
                    .any(|tool| tool["type"] == "function" && tool["name"] == *name)
            });
            self.response_hosted = tools
                .iter()
                .filter(|tool| tool["type"] == "mcp")
                .map(|tool| {
                    (
                        tool["server_label"].as_str().unwrap().to_owned(),
                        tool.clone(),
                    )
                })
                .collect();
        }
    }
    fn remember_retired_response(&mut self, id: String) {
        if self.retired_responses.insert(id.clone()) {
            self.retired_response_order.push_back(id);
        }
        while self.retired_response_order.len() > MAX_CALLS {
            let oldest = self
                .retired_response_order
                .iter()
                .position(|id| self.cancel_waiting.as_ref() != Some(id))
                .unwrap();
            let id = self.retired_response_order.remove(oldest).unwrap();
            self.retired_responses.remove(&id);
        }
    }
    fn remember_completed_response(&mut self, id: String) {
        if self.completed_responses.insert(id.clone()) {
            self.completed_response_order.push_back(id);
        }
        if self.completed_response_order.len() > MAX_CALLS {
            let oldest = self.completed_response_order.pop_front().unwrap();
            self.completed_responses.remove(&oldest);
        }
    }
    fn is_detached_event(&self, event: &Value) -> bool {
        let response = &event["response"];
        let id = event["response_id"]
            .as_str()
            .or_else(|| response["id"].as_str());
        id.is_some_and(|id| self.detached.contains_key(id))
            || response.get("conversation_id").is_some_and(Value::is_null)
    }
    fn discover_hosted(&mut self, item: &Value, response_id: &str) -> Result<(), String> {
        let hosted = if let Some(response) = self.detached.get(response_id) {
            &response
                .scope
                .as_ref()
                .filter(|_| response.active)
                .ok_or("Hosted MCP response has no live managed source")?
                .hosted
        } else {
            if self.responses.sdk_response_id.as_deref() != Some(response_id) {
                return Err("Hosted MCP request does not own active response".into());
            }
            &self.response_hosted
        };
        let id = string(item, "id")?;
        let label = string(item, "server_label")?;
        let name = string(item, "name")?;
        let declaration = hosted
            .get(&label)
            .ok_or("Hosted MCP server is outside accepted configuration")?;
        if declaration["allowed_tools"]
            .as_array()
            .or_else(|| declaration["allowed_tools"]["tool_names"].as_array())
            .is_some_and(|names| !names.iter().any(|allowed| allowed.as_str() == Some(&name)))
        {
            return Err("Hosted MCP tool is outside accepted configuration".into());
        }
        let encoded = serde_json::to_vec(item).map_err(|_| "Invalid hosted MCP request")?;
        let arguments: Value = serde_json::from_str(&string(item, "arguments")?)
            .map_err(|_| "Invalid hosted MCP arguments")?;
        if encoded.len() > MAX_CALL_BYTES || !arguments.is_object() {
            return Err("Invalid or oversized hosted MCP request".into());
        }
        if let Some(old) = self.approvals.get(&id) {
            if old.response_id != response_id
                || ["id", "server_label", "name", "arguments"]
                    .iter()
                    .any(|key| old.item[*key] != item[*key])
            {
                return Err("Hosted MCP approval identity changed".into());
            }
        } else {
            if self.approvals.len() >= MAX_CALLS {
                return Err("Hosted MCP approval capacity exceeded".into());
            }
            self.approvals.insert(
                id,
                HostedApproval {
                    response_id: response_id.to_owned(),
                    item: item.clone(),
                    phase: CallPhase::Discovered,
                    decision: None,
                },
            );
        }
        Ok(())
    }
    fn observe_hosted_call(&mut self, item: &Value, response_id: &str) -> Result<(), String> {
        let (Some(_), Some(id), Some(label)) = (
            hosted_call_terminal(item),
            item["id"].as_str().filter(|id| !id.is_empty()),
            item["server_label"].as_str(),
        ) else {
            return Ok(());
        };
        let detached = self.detached.get(response_id);
        let hosted = match detached {
            Some(owner) if owner.active => owner.scope.as_ref().map(|scope| &scope.hosted),
            None if self.responses.sdk_response_id.as_deref() == Some(response_id) => {
                Some(&self.response_hosted)
            }
            _ => None,
        };
        if !hosted.is_some_and(|tools| tools.contains_key(label)) {
            return Ok(());
        }
        if let Some((owner, call)) = self
            .batches
            .iter()
            .find_map(|(owner, batch)| batch.hosted_calls.get(id).map(|call| (owner, call)))
        {
            if owner != response_id || call.server_label != label {
                return Err("Hosted MCP call identity changed".into());
            }
            return Ok(());
        }
        if id.len() + label.len() > MAX_CALL_BYTES
            || self
                .batches
                .values()
                .map(|batch| batch.hosted_calls.len())
                .sum::<usize>()
                >= MAX_CALLS
        {
            return Err("Hosted MCP call capacity exceeded".into());
        }
        let batch = self.batches.entry(response_id.into()).or_default();
        batch.out_of_band = detached.is_some();
        batch.hosted_calls.insert(
            id.into(),
            HostedCall {
                server_label: label.into(),
                terminal: false,
            },
        );
        Ok(())
    }
    fn complete_hosted_call(
        &mut self,
        item: &Value,
        response_id: Option<&Value>,
        retain_detached_result: bool,
    ) -> Result<(), String> {
        let (Some(id), Some(true)) = (item["id"].as_str(), hosted_call_terminal(item)) else {
            return Ok(());
        };
        for (owner, batch) in &mut self.batches {
            if response_id.is_some_and(|value| value.as_str() != Some(owner)) {
                continue;
            }
            if let Some(call) = batch.hosted_calls.get_mut(id)
                && !call.terminal
                && item.get("server_label").is_none_or(|label| {
                    label.is_null() || label.as_str() == Some(&call.server_label)
                })
            {
                call.terminal = true;
                if batch.out_of_band && retain_detached_result {
                    let owner = owner.clone();
                    self.update_detached_output(&owner, |output| {
                        merge_hosted_result(output, item)
                    })?;
                }
                break;
            }
        }
        Ok(())
    }
    fn update_detached_output(
        &mut self,
        response_id: &str,
        update: impl FnOnce(&mut Vec<Value>),
    ) -> Result<(), String> {
        let output = &mut self.detached.get_mut(response_id).unwrap().output;
        let encoded_bytes = |items: &[Value]| {
            if items.is_empty() {
                Ok(0)
            } else {
                serde_json::to_vec(items)
                    .map(|bytes| bytes.len())
                    .map_err(|_| "Invalid detached output")
            }
        };
        let before = encoded_bytes(output)?;
        update(output);
        self.detached_bytes = self.detached_bytes - before + encoded_bytes(output)?;
        if self.detached_bytes > MAX_FRAME_BYTES {
            return Err("Detached response context exceeds capacity".into());
        }
        Ok(())
    }
    fn is_retired_event(&self, event: &Value) -> bool {
        event["response_id"]
            .as_str()
            .or_else(|| event["response"]["id"].as_str())
            .is_some_and(|id| self.retired_responses.contains(id))
    }
    fn default_cancel_scope(&self, id: &str) -> DefaultCancelScope {
        let live = self.default_cancel_target().as_deref() == Some(id);
        let matches_pending = self.pending_default.as_ref().is_some_and(|scope| {
            self.incoming.iter().any(|(event, _)| {
                event["type"] == "response.created"
                    && event["response"]["id"].as_str() == Some(id)
                    && event["response"].get("metadata").unwrap_or(&Value::Null)
                        == scope.request.get("metadata").unwrap_or(&Value::Null)
            })
        });
        let predecessor_survives = self
            .responses
            .sdk_response_id
            .as_ref()
            .is_some_and(|owner| {
                owner != id
                    && self.last_completed.as_ref() != Some(owner)
                    && !self.completed_responses.contains(owner)
                    && !self.retired_responses.contains(owner)
            });
        let unrelated_pending = self.pending_default.is_some() && !matches_pending;
        DefaultCancelScope {
            live,
            matches_pending,
            preserves_other: predecessor_survives || unrelated_pending,
        }
    }
    fn clear_output_audio(&mut self, effects: &mut Vec<Effect>) {
        if self.clear_output_audio_on_interrupt {
            self.send(json!({"type":"output_audio_buffer.clear"}), effects);
        }
    }
    fn send_default_cancel(&mut self, id: &str, event_id: Option<&str>, effects: &mut Vec<Effect>) {
        self.send(
            with_event_id(json!({"type":"response.cancel","response_id":id}), event_id),
            effects,
        );
        self.clear_output_audio(effects);
    }
    fn cancel_selected_default(
        &mut self,
        id: &String,
        event_id: Option<&str>,
        effects: &mut Vec<Effect>,
    ) {
        let scope = self.default_cancel_scope(id);
        self.remember_retired_response(id.clone());
        self.abort_scope(id, effects);
        if self.responses.sdk_response_id.as_ref() == Some(id) {
            self.responses.sdk_response_id = None;
        }
        if !scope.preserves_other {
            self.responses.active_default_response = false;
            self.responses.pending_create = false;
            self.pending_response = None;
            self.pending_response_event = None;
            self.cancel_before_created = false;
            self.pending_cancel_event = None;
        }
        if scope.matches_pending {
            self.pending_default = None;
            self.pending_default_event = None;
            self.cancel_before_created = false;
            self.pending_cancel_event = None;
        }
        if scope.live {
            self.cancel_waiting = Some(id.clone());
            if self.pending_default.is_none() {
                self.retire_default_event();
            }
            self.send_default_cancel(id, event_id, effects);
        } else if !scope.preserves_other {
            self.clear_output_audio(effects);
        }
    }
    fn interrupt(
        &mut self,
        effects: &mut Vec<Effect>,
        target: Option<String>,
        fence_received: bool,
        event_id: Option<&str>,
    ) -> Result<(), String> {
        let deferred_event_id = event_id.filter(|_| target.is_none());
        let mut retired = BTreeSet::new();
        if let Some(id) = &self.responses.sdk_response_id {
            retired.insert(id.clone());
        }
        for call in self.calls.values() {
            if !matches!(call.phase, CallPhase::Published | CallPhase::Cancelled) {
                if let Some(id) = &call.request.response_id {
                    if !self.detached.contains_key(id) {
                        retired.insert(id.clone());
                    }
                }
            }
        }
        for request in self.approvals.values() {
            if !self.detached.contains_key(&request.response_id)
                && !matches!(request.phase, CallPhase::Published | CallPhase::Cancelled)
            {
                retired.insert(request.response_id.clone());
            }
        }
        let received_default = self.has_received_default_response(None);
        let unidentified = self.responses.active_default_response
            && self.responses.sdk_response_id.is_none()
            && !received_default;
        if fence_received {
            retired.extend(self.incoming.iter().filter_map(|(event, _)| {
                if event["type"] == "response.created" && !self.is_detached_event(event) {
                    event["response"]["id"].as_str().map(str::to_owned)
                } else {
                    None
                }
            }));
        }
        for id in retired.iter().cloned().collect::<Vec<_>>() {
            self.remember_retired_response(id);
        }
        let pending_arrived = self.pending_default.as_ref().and_then(|scope| {
            self.incoming.iter().find_map(|(event, _)| {
                (event["type"] == "response.created"
                    && !self.is_detached_event(event)
                    && event["response"].get("metadata").unwrap_or(&Value::Null)
                        == scope.request.get("metadata").unwrap_or(&Value::Null))
                .then(|| event["response"]["id"].as_str().map(str::to_owned))
                .flatten()
            })
        });
        if let Some(id) = pending_arrived {
            self.remember_retired_response(id);
            self.pending_default = None;
            self.pending_default_event = None;
        }
        if fence_received && received_default && self.pending_default.is_none() {
            self.cancel_before_created = false;
        }
        self.guardrail_output = None;
        if let Some(previous) = self.responses.sdk_response_id.take() {
            self.remember_retired_response(previous);
        }
        if let Some(id) = target {
            self.cancel_before_created = false;
            retired.insert(id.clone());
            self.remember_retired_response(id.clone());
            self.cancel_waiting = Some(id.clone());
            self.send_default_cancel(&id, event_id, effects);
        } else {
            if unidentified {
                self.cancel_before_created = true;
            }
            self.clear_output_audio(effects);
        }
        for (id, request) in &mut self.approvals {
            if !self.detached.contains_key(&request.response_id)
                && !matches!(request.phase, CallPhase::Published | CallPhase::Cancelled)
            {
                effects.push(Effect::AbortMcp {
                    request_id: id.clone(),
                });
                request.phase = CallPhase::Cancelled;
            }
        }
        self.pending_response = None;
        self.pending_response_event = None;
        if self.pending_default.is_some() {
            self.cancel_before_created = true;
        }
        if self.cancel_before_created {
            if let Some(id) = deferred_event_id {
                self.pending_cancel_event = Some(id.to_owned());
            }
        } else {
            self.retire_default_event();
            self.pending_cancel_event = None;
        }
        for (id, call) in &mut self.calls {
            if !call
                .request
                .response_id
                .as_ref()
                .is_some_and(|id| self.detached.contains_key(id))
                && !matches!(call.phase, CallPhase::Published | CallPhase::Cancelled)
            {
                effects.push(Effect::Abort {
                    call_id: id.clone(),
                });
                call.phase = CallPhase::Cancelled;
            }
        }
        self.batches.retain(|_, batch| batch.out_of_band);
        effects.extend(
            retired
                .into_iter()
                .map(|response_id| Effect::Retire { response_id }),
        );
        self.responses = PendingDefault::default();
        Ok(())
    }
    fn release_guardrail(&mut self, effects: &mut Vec<Effect>) {
        if self.phase != Phase::Ready
            || self.responses.active_default_response
            || !self.pending_send.is_empty()
            || self.cancel_before_created
            || self.cancel_waiting.is_some()
        {
            return;
        }
        if let Some(output) = self.guardrail_output.take() {
            self.pending_response = Some(json!({"instructions":output}));
            self.request_response(effects);
        }
    }
    fn require_ready(&self) -> Result<(), String> {
        if self.phase != Phase::Ready && !(self.phase == Phase::Configuring && self.updating) {
            Err("Realtime configuration is not accepted".into())
        } else {
            Ok(())
        }
    }
    fn provider_gate(&self, event: &Value) -> Result<usize, String> {
        let bytes = serde_json::to_vec(event)
            .map_err(|_| "Invalid provider event")?
            .len();
        if bytes > MAX_FRAME_BYTES {
            return Err("Provider event exceeds capacity".into());
        }
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or("Provider event has no type")?;
        match kind {
            "session.updated" if self.phase == Phase::Configuring || self.phase == Phase::Ready => {
                let session = event
                    .get("session")
                    .ok_or("Invalid accepted configuration")?;
                if !contains_expected(session, &self.expected_session) {
                    return Err("Provider accepted another tool configuration".into());
                }
            }
            "response.done"
                if event["response"]["status"].as_str() != Some("completed")
                    && !self.is_retired_event(event)
                    && !self.is_detached_event(event) =>
            {
                return Err("Incomplete Realtime response cannot admit functions".into());
            }
            "response.cancelled"
                if !self.is_retired_event(event) && !self.is_detached_event(event) =>
            {
                return Err("Portable voice generation was cancelled".into());
            }
            "error"
                if !self.is_response_race(event)
                    && !Self::response_race_event_id(event).is_some_and(|id| {
                        self.retired_default_event_ids.iter().any(|old| old == id)
                    })
                    && !self.is_cancel_race(event)
                    && !self.is_settings_rejection(event)
                    && !self.is_retrieval_error(event)
                    && self.deletion_error_item(event).is_none() =>
            {
                return Err("Realtime provider rejected the operation".into());
            }
            _ => {}
        }
        Ok(bytes)
    }
    fn is_cancel_race(&self, event: &Value) -> bool {
        event["error"]["type"] == "invalid_request_error"
            && event["error"]["event_id"].as_str().is_some_and(|event_id| {
                self.raw_cancel_events.iter().any(|id| id == event_id)
                    || event_id
                        .strip_prefix("cancel_")
                        .and_then(|value| value.parse::<u64>().ok())
                        .is_some_and(|id| {
                            id > 0 && id <= self.next_cancel && event_id == format!("cancel_{id}")
                        })
            })
    }
    fn is_retrieval_error(&self, event: &Value) -> bool {
        self.pending_retrieval
            .as_ref()
            .is_some_and(|(_, id)| event["error"]["event_id"].as_str() == Some(id))
    }
    fn is_settings_rejection(&self, event: &Value) -> bool {
        event["error"]["type"] == "invalid_request_error"
            && self
                .raw_settings_event
                .as_deref()
                .is_some_and(|id| event["error"]["event_id"].as_str() == Some(id))
    }
    fn response_race_event_id(event: &Value) -> Option<&str> {
        if event["error"]["code"] == "conversation_already_has_active_response" {
            event["error"]["event_id"].as_str()
        } else {
            None
        }
    }
    fn is_response_race(&self, event: &Value) -> bool {
        self.pending_default_event.as_ref().is_some_and(|pending| {
            Self::response_race_event_id(event) == Some(pending.event_id.as_str())
        })
    }
    fn retire_default_event(&mut self) {
        if let Some(previous) = self.pending_default_event.take() {
            if self.retired_default_event_ids.len() == MAX_CALLS {
                self.retired_default_event_ids.pop_front();
            }
            self.retired_default_event_ids.push_back(previous.event_id);
        }
    }
    fn default_response_event(mut response: Value, send_id: u64) -> (Value, bool) {
        let needs_identity = response
            .as_object()
            .unwrap()
            .keys()
            .any(|key| key != "conversation" && key != "metadata")
            || response["metadata"]
                .as_object()
                .is_some_and(|metadata| !metadata.is_empty());
        if !needs_identity {
            return (json!({"type":"response.create","response":response}), false);
        }
        let token = format!("portable-{send_id}");
        let generated_metadata = response.get("metadata").is_none_or(|value| {
            value.is_null()
                || value
                    .as_object()
                    .is_some_and(|metadata| metadata.is_empty())
        });
        if generated_metadata {
            response["metadata"] = json!({"codex_response_id":token});
        }
        (
            json!({"type":"response.create","event_id":token,"response":response}),
            generated_metadata,
        )
    }
    fn send_default(
        &mut self,
        response: Option<Value>,
        event_id: Option<&str>,
        effects: &mut Vec<Effect>,
    ) {
        self.responses.mark_started();
        self.retire_default_event();
        let (event, generated_metadata) = match response {
            Some(response) => Self::default_response_event(response, self.next_send + 1),
            None => (json!({"type":"response.create"}), false),
        };
        let scoped = event["event_id"].is_string();
        self.default_metadata_generated = generated_metadata;
        if scoped {
            self.pending_default = Some(self.new_scope(event["response"].clone(), vec![]));
        } else {
            self.capture_response_tools();
        }
        let event = with_event_id(event, event_id);
        self.pending_default_event = event["event_id"].as_str().map(|id| PendingDefaultCreate {
            event_id: id.to_owned(),
            response: if scoped { None } else { event.get("response").cloned() },
        });
        self.send(event, effects);
    }
    fn has_received_default_response(&self, response_id: Option<&str>) -> bool {
        self.incoming.iter().any(|(event, _)| {
            event["type"] == "response.created"
                && response_id.is_none_or(|id| event["response"]["id"].as_str() == Some(id))
                && !self.is_detached_event(event)
                && !self.is_retired_event(event)
                && !event["response"]["id"]
                    .as_str()
                    .is_some_and(|id| self.completed_responses.contains(id))
        })
    }
    fn defers_default_response(&self) -> bool {
        self.cancel_before_created
            || self.cancel_waiting.is_some()
            || self.pending_default.is_some()
            || self.has_received_default_response(None)
            || self.phase != Phase::Ready
            || self
                .batches
                .values()
                .any(|batch| batch.admitted && !batch.out_of_band)
    }
    fn request_response(&mut self, effects: &mut Vec<Effect>) {
        if self.defers_default_response() {
            self.responses.pending_create = true;
        } else if self.responses.request_create() {
            let response = self.pending_response.take();
            let event_id = self.pending_response_event.take();
            self.send_default(response, event_id.as_deref(), effects);
        }
    }
    fn provider(&mut self, event: Value, effects: &mut Vec<Effect>) -> Result<(), String> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or("Provider event has no type")?;
        if matches!(kind, "conversation.item.done" | "response.output_item.done") {
            self.complete_hosted_call(&event["item"], event.get("response_id"), true)?;
        }
        if let Some(item_id) = self.deletion_error_item(&event) {
            self.pending_deletions.remove(&item_id);
            Self::reject_deletion(&item_id, effects);
            effects.push(Effect::Event { event });
            return Ok(());
        }
        if kind == "error" && self.is_retrieval_error(&event) {
            self.pending_retrieval = None;
        }
        if kind == "conversation.item.retrieved" {
            if self
                .pending_retrieval
                .as_ref()
                .is_some_and(|(id, _)| event["item"]["id"].as_str() == Some(id))
            {
                self.pending_retrieval = None;
            }
            if let Some(item_id) = event["item"]["id"].as_str().map(str::to_owned) {
                if self
                    .pending_deletions
                    .get(&item_id)
                    .is_some_and(|pending| pending.retrieving)
                {
                    self.observe_deletion_item(&event["item"]);
                    let pending = self.pending_deletions.remove(&item_id).unwrap();
                    if self.validate_deletion(&item_id).is_ok() {
                        self.send_deletion(
                            &item_id,
                            false,
                            pending.delete_event_id.as_deref(),
                            effects,
                        );
                    } else {
                        Self::reject_deletion(&item_id, effects);
                    }
                    effects.push(Effect::Event { event });
                    return Ok(());
                }
            }
        }
        let mut managed_detached = false;
        if self.is_detached_event(&event) {
            let response = &event["response"];
            let id = event["response_id"]
                .as_str()
                .or_else(|| response["id"].as_str())
                .ok_or("Detached response has no identity")?
                .to_owned();
            if kind == "response.created" {
                if self.detached.contains_key(&id) {
                    effects.push(Effect::Event { event });
                    return Ok(());
                }
                if self.detached.len() >= MAX_CALLS && !self.detached.contains_key(&id) {
                    return Err("Detached response capacity exceeded".into());
                }
                let matches = self.pending_detached.as_ref().is_some_and(|scope| {
                    response.get("metadata").unwrap_or(&Value::Null)
                        == scope.request.get("metadata").unwrap_or(&Value::Null)
                });
                let scope = if matches {
                    self.pending_detached.take()
                } else {
                    None
                };
                if let Some(scope) = &scope {
                    effects.push(Effect::Scope {
                        response_id: id.clone(),
                        profile_id: scope.profile_id,
                        out_of_band: true,
                        history: Some(
                            scope.request["input"]
                                .as_array()
                                .cloned()
                                .unwrap_or_else(|| scope.history.clone()),
                        ),
                    });
                }
                self.detached.entry(id).or_insert(DetachedResponse {
                    active: true,
                    scope,
                    output: vec![],
                });
                effects.push(Effect::Event { event });
                return Ok(());
            }
            let owner = self.detached.get(&id);
            managed_detached = owner.is_some_and(|owner| owner.active && owner.scope.is_some());
            let completed = kind == "response.done";
            let terminal = completed || kind == "response.cancelled";
            if terminal {
                if let Some((_, done)) = self.detached_guardrails.get_mut(&id) {
                    *done = true;
                }
            }
            if !managed_detached || (terminal && response["status"] != "completed") {
                if terminal {
                    if let Some(owner) = self.detached.get_mut(&id) {
                        owner.active = false;
                    }
                    if self
                        .detached
                        .get(&id)
                        .is_some_and(|owner| owner.scope.is_some())
                    {
                        self.abort_scope(&id, effects);
                    }
                }
                effects.push(Effect::Event { event });
                return Ok(());
            }
        }
        let response_id = event["response_id"]
            .as_str()
            .or_else(|| event["response"]["id"].as_str());
        if response_id.is_some_and(|id| self.completed_responses.contains(id))
            && kind != "response.cancelled"
            && !(kind == "response.done" && event["response"]["status"] != "completed")
        {
            effects.push(Effect::Event { event });
            return Ok(());
        }
        if self.is_retired_event(&event) {
            let id = event["response_id"]
                .as_str()
                .or_else(|| event["response"]["id"].as_str());
            if matches!(kind, "response.done" | "response.cancelled")
                && id == self.cancel_waiting.as_deref()
            {
                self.cancel_waiting = None;
                if self.guardrail_output.is_some() {
                    self.release_guardrail(effects);
                } else if self.responses.pending_create {
                    self.request_response(effects);
                }
            }
            effects.push(Effect::Event { event });
            return Ok(());
        }
        let detached_hosted_result = kind == "conversation.item.done"
            && hosted_call_terminal(&event["item"]).is_some()
            && event["item"]["id"].as_str().is_some_and(|id| {
                self.detached.values().any(|response| {
                    response
                        .output
                        .iter()
                        .any(|item| item["id"].as_str() == Some(id))
                })
            });
        if !managed_detached && !detached_hosted_result {
            if matches!(
                kind,
                "conversation.item.created"
                    | "conversation.item.added"
                    | "conversation.item.done"
                    | "conversation.item.retrieved"
                    | "response.output_item.added"
                    | "response.output_item.done"
            ) {
                self.observe_deletion_item(&event["item"]);
            }
            if kind == "response.done" {
                if let Some(items) = event["response"]["output"].as_array() {
                    for item in items {
                        self.observe_deletion_item(item);
                    }
                }
            }
            if kind == "conversation.item.deleted" {
                if let Some(id) = event["item_id"].as_str() {
                    if self
                        .pending_deletions
                        .get(id)
                        .is_some_and(|pending| !pending.retrieving)
                    {
                        self.pending_deletions.remove(id);
                    }
                    self.deletion_proofs.remove(id);
                    self.deletion_order.retain(|item_id| item_id != id);
                }
            }
        }
        match kind {
            "error" if self.is_settings_rejection(&event) => {
                self.phase = Phase::Ready;
                self.updating = false;
                self.raw_settings_event = None;
                self.startup_send = None;
                self.expected_session = self.accepted_session.clone();
                self.pending_tools.clear();
                self.pending_hosted.clear();
                effects.push(Effect::ConfigurationRejected);
                if self.responses.pending_create {
                    self.request_response(effects);
                }
            }
            "error" if self.is_response_race(&event) => {
                let pending = self.pending_default_event.take().unwrap();
                let scope = self.pending_default.take();
                let unscoped = scope.is_none();
                let cancelled =
                    self.cancel_before_created || (unscoped && self.cancel_waiting.is_some());
                if cancelled {
                    self.cancel_before_created = false;
                    self.pending_cancel_event = None;
                } else {
                    if self.pending_response.is_none() && self.pending_response_event.is_none() {
                        self.pending_response = scope.map(|scope| scope.request).or(pending.response);
                        if self.default_metadata_generated {
                            if let Some(response) = &mut self.pending_response {
                                response["metadata"] = json!({});
                            }
                        }
                        if unscoped {
                            self.pending_response_event = Some(pending.event_id);
                        }
                    }
                    if self.responses.active_default_response {
                        self.responses.raced_active_response();
                    } else {
                        self.request_response(effects);
                    }
                }
                self.default_metadata_generated = false;
            }
            "input_audio_buffer.speech_started" => {
                if self.accepted_session["audio"]["input"]["turn_detection"]["interrupt_response"]
                    .as_bool()
                    != Some(false)
                {
                    self.interrupt(effects, self.default_cancel_target(), true, None)?;
                }
            }
            "response.cancelled" => {
                return Err("Portable voice generation was cancelled".into());
            }
            "session.updated" => {
                if self.phase == Phase::Configuring || self.phase == Phase::Ready {
                    self.startup_accepted = true;
                }
            }
            "response.created" => {
                self.require_ready()?;
                let id = string(&event["response"], "id")?;
                if self.responses.sdk_response_id.as_ref() == Some(&id) {
                    effects.push(Effect::Event { event });
                    return Ok(());
                }
                if self
                    .responses
                    .sdk_response_id
                    .as_ref()
                    .is_some_and(|active| active != &id)
                {
                    return Err("Concurrent default responses are not supported".into());
                }
                let matched = self.pending_default.as_ref().is_some_and(|scope| {
                    event["response"].get("metadata").unwrap_or(&Value::Null)
                        == scope.request.get("metadata").unwrap_or(&Value::Null)
                });
                if self.cancel_before_created && (self.pending_default.is_none() || matched) {
                    self.cancel_before_created = false;
                    if matched {
                        self.pending_default_event = None;
                    } else {
                        self.retire_default_event();
                    }
                    self.pending_default = None;
                    self.remember_retired_response(id.clone());
                    self.cancel_waiting = Some(id.clone());
                    let event_id = self.pending_cancel_event.take();
                    self.send_default_cancel(&id, event_id.as_deref(), effects);
                    effects.push(Effect::Retire {
                        response_id: self.cancel_waiting.clone().unwrap(),
                    });
                    effects.push(Effect::Event { event });
                    return Ok(());
                }
                if matched {
                    let scope = self.pending_default.take().unwrap();
                    self.pending_default_event = None;
                    self.response_tools = scope.tools;
                    self.response_hosted = scope.hosted;
                    self.response_profile_id = scope.profile_id;
                } else {
                    self.response_tools = self.tools.clone();
                    self.response_hosted = self.hosted.clone();
                    self.response_profile_id = self.profile_id;
                }
                effects.push(Effect::Scope {
                    response_id: id.clone(),
                    profile_id: self.response_profile_id,
                    out_of_band: false,
                    history: None,
                });
                // A newer default response supersedes any hosted-only follow-up.
                self.batches.retain(|_, batch| {
                    batch.out_of_band
                        || batch.hosted_calls.is_empty()
                        || !batch.calls.is_empty()
                        || !batch.hosted.is_empty()
                });
                self.responses.sdk_response_id = Some(id);
                self.responses.mark_started();
            }
            "response.output_item.added" => {
                if let Some(id) = event["response_id"].as_str() {
                    self.observe_hosted_call(&event["item"], id)?;
                    self.complete_hosted_call(&event["item"], event.get("response_id"), true)?;
                }
            }
            "response.output_item.done" => {
                self.require_ready()?;
                let item = event.get("item").ok_or("Provider item is missing")?;
                if let Some(id) = event["response_id"].as_str() {
                    self.observe_hosted_call(item, id)?;
                    self.complete_hosted_call(item, event.get("response_id"), true)?;
                }
                if item["type"] == "mcp_approval_request" {
                    self.discover_hosted(item, &string(&event, "response_id")?)?;
                }
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    self.discover(FunctionCall {
                        namespace: item
                            .get("namespace")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        call_id: string(item, "call_id")?,
                        item_id: string(item, "id")?,
                        name: string(item, "name")?,
                        arguments: string(item, "arguments")?,
                        response_id: Some(string(&event, "response_id")?),
                    })?;
                }
            }
            "response.done" => {
                self.require_ready()?;
                let response = event.get("response").ok_or("Missing response")?;
                let id = string(response, "id")?;
                if !managed_detached && self.responses.sdk_response_id.as_ref() != Some(&id) {
                    return Err("Completed response does not own the active response".into());
                }
                let output = response
                    .get("output")
                    .and_then(Value::as_array)
                    .ok_or("Missing response output")?;
                let mut ids = vec![];
                let mut hosted_ids = vec![];
                for item in output {
                    self.observe_hosted_call(item, &id)?;
                    self.complete_hosted_call(item, response.get("id"), false)?;
                    if item["type"] == "mcp_approval_request" {
                        self.discover_hosted(item, &id)?;
                        let request_id = string(item, "id")?;
                        if hosted_ids.contains(&request_id) {
                            return Err("Duplicate hosted MCP approval in response".into());
                        }
                        hosted_ids.push(request_id);
                    }
                    if item.get("type").and_then(Value::as_str) == Some("function_call") {
                        let request = FunctionCall {
                            namespace: item
                                .get("namespace")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            call_id: string(item, "call_id")?,
                            item_id: string(item, "id")?,
                            name: string(item, "name")?,
                            arguments: string(item, "arguments")?,
                            response_id: Some(id.clone()),
                        };
                        if ids.contains(&request.call_id) {
                            return Err("Duplicate function in completed response".into());
                        }
                        ids.push(request.call_id.clone());
                        self.discover(request)?;
                    }
                }
                if self.calls.values().any(|call| {
                    call.request.response_id.as_ref() == Some(&id)
                        && !ids.contains(&call.request.call_id)
                }) {
                    return Err("Completed response omitted a discovered function".into());
                }
                if self.approvals.values().any(|request| {
                    request.response_id == id
                        && !hosted_ids.contains(&string(&request.item, "id").unwrap_or_default())
                }) {
                    return Err("Completed response omitted a hosted MCP approval".into());
                }
                let deferred_create = if managed_detached {
                    self.update_detached_output(&id, |early_results| {
                        let mut snapshot = output.clone();
                        for result in early_results.drain(..) {
                            merge_hosted_result(&mut snapshot, &result);
                        }
                        *early_results = snapshot;
                    })?;
                    self.detached.get_mut(&id).unwrap().active = false;
                    false
                } else {
                    self.remember_completed_response(id.clone());
                    self.last_completed = Some(id.clone());
                    self.responses.sdk_response_id = None;
                    if self.pending_default.is_some() {
                        self.responses.mark_started();
                        false
                    } else {
                        // An automatic response may end before its active-response error arrives.
                        self.responses.finish_and_take_pending()
                    }
                };
                if !ids.is_empty() || !hosted_ids.is_empty() || self.batches.contains_key(&id) {
                    let batch = self.batches.entry(id).or_default();
                    if batch.admitted {
                        return Err("Response batch already admitted".into());
                    }
                    batch.calls.clone_from(&ids);
                    batch.hosted.clone_from(&hosted_ids);
                    batch.admitted = true;
                    batch.out_of_band = managed_detached;
                    for request_id in hosted_ids {
                        let request = self.approvals.get_mut(&request_id).unwrap();
                        if request.phase != CallPhase::Discovered {
                            return Err("Hosted MCP approval already admitted".into());
                        }
                        request.phase = CallPhase::Approval;
                        effects.push(Effect::ApproveMcp {
                            request_id,
                            server_label: string(&request.item, "server_label")?,
                            name: string(&request.item, "name")?,
                            arguments: serde_json::from_str(
                                request.item["arguments"].as_str().unwrap(),
                            )
                            .map_err(|_| "Invalid hosted MCP arguments")?,
                        });
                    }
                    for call_id in ids {
                        let call = self.calls.get_mut(&call_id).ok_or("Missing function")?;
                        if call.phase != CallPhase::Discovered {
                            return Err("Function already admitted".into());
                        }
                        if call.needs_approval {
                            call.phase = CallPhase::Approval;
                            effects.push(Effect::Approve {
                                call_id,
                                name: call.request.name.clone(),
                                arguments: arguments(&call.request)?,
                            });
                        } else {
                            call.phase = CallPhase::Executing;
                            effects.push(execute(&call.request)?);
                        }
                    }
                }
                if deferred_create {
                    self.request_response(effects);
                }
                self.release_guardrail(effects);
            }
            _ => {}
        }
        effects.push(Effect::Event { event });
        Ok(())
    }
    fn discover(&mut self, request: FunctionCall) -> Result<(), String> {
        request.validate()?;
        let tools = if let Some(owner) = request
            .response_id
            .as_ref()
            .and_then(|id| self.detached.get(id))
        {
            &owner
                .scope
                .as_ref()
                .filter(|_| owner.active)
                .ok_or("Function has no live managed response source")?
                .tools
        } else {
            if request.response_id != self.responses.sdk_response_id {
                return Err("Function does not own the active response".into());
            }
            &self.response_tools
        };
        let needs_approval = tools
            .get(&request.name)
            .ok_or("Function is outside accepted configuration")?
            .needs_approval;

        if let Some(old) = self.calls.get(&request.call_id) {
            if old.request != request {
                return Err("Realtime function identity changed".into());
            }
            return Ok(());
        }
        if self.calls.len() == MAX_CALLS {
            return Err("SDK Realtime function capacity exceeded".into());
        }
        self.calls.insert(
            request.call_id.clone(),
            Call {
                request,
                phase: CallPhase::Discovered,
                needs_approval,
                output: None,
                background: false,
            },
        );
        Ok(())
    }
    fn publish(
        &mut self,
        call_id: &str,
        output: String,
        background: bool,
        effects: &mut Vec<Effect>,
    ) -> Result<(), String> {
        if output.len() > MAX_CALL_BYTES {
            return Err("Tool output exceeds capacity".into());
        }
        let call = self.calls.get_mut(call_id).ok_or("Unknown function")?;
        call.background = background;
        if call
            .request
            .response_id
            .as_ref()
            .is_some_and(|id| self.detached.contains_key(id))
        {
            call.output = Some(output);
            call.phase = CallPhase::Published;
            return Ok(());
        }
        let id = self.send(json!({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":call_id,"output":output}}), effects);
        self.calls.get_mut(call_id).unwrap().phase = CallPhase::Publishing(id);
        Ok(())
    }
    fn continue_batches(&mut self, effects: &mut Vec<Effect>) -> Result<(), String> {
        if self.phase != Phase::Ready {
            return Ok(());
        }
        let ready: Vec<_> = self
            .batches
            .iter()
            .filter(|(_, batch)| {
                batch.admitted
                    && batch.hosted_calls.values().all(|call| call.terminal)
                    && batch.hosted.iter().all(|id| {
                        self.approvals
                            .get(id)
                            .is_some_and(|request| request.phase == CallPhase::Published)
                    })
                    && batch.calls.iter().all(|id| {
                        self.calls
                            .get(id)
                            .is_some_and(|call| call.phase == CallPhase::Published)
                    })
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ready {
            let batch = &self.batches[&id];
            let hosted_followup = self.hosted_mcp_auto_response
                && !batch.hosted_calls.is_empty()
                && (batch.out_of_band
                    || (self.last_completed.as_ref() == Some(&id)
                        && self.responses.sdk_response_id.is_none()));
            if !hosted_followup
                && batch.hosted.is_empty()
                && batch.calls.iter().all(|id| self.calls[id].background)
            {
                let default = !batch.out_of_band;
                self.batches.remove(&id);
                if default && self.responses.pending_create {
                    self.request_response(effects);
                }
                continue;
            }
            if batch.out_of_band {
                if self.pending_detached.is_some() {
                    continue;
                }
                let owner = &self.detached[&id];
                let mut scope = owner.scope.clone().unwrap();
                let mut request = scope.continuation.clone();
                let mut input = request["input"]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| scope.history.clone());
                input.extend(owner.output.clone());
                for call_id in &self.batches[&id].calls {
                    input.push(json!({"type":"function_call_output","call_id":call_id,"output":self.calls[call_id].output.as_ref().unwrap()}));
                }
                for request_id in &self.batches[&id].hosted {
                    input.push(json!({"type":"mcp_approval_response","approval_request_id":request_id,"approve":self.approvals[request_id].decision.unwrap()}));
                }
                request["input"] = json!(input);
                scope.request = request.clone();
                scope.continuation = request;
                self.send_detached(scope, None, effects)?;
                self.batches.remove(&id);
            } else if !self.responses.active_default_response
                && self.cancel_waiting.is_none()
                && !self.cancel_before_created
                && !self.has_received_default_response(None)
            {
                self.batches.remove(&id);
                self.request_response(effects);
            }
        }
        Ok(())
    }
    pub fn apply_json(&mut self, input: &str) -> String {
        let mut preflight = false;
        let result = if input.len() > MAX_FRAME_BYTES {
            Err("Command exceeds capacity".into())
        } else {
            serde_json::from_str::<Command>(input)
                .map_err(|_| "Invalid control command".into())
                .and_then(|command| {
                    preflight = matches!(
                        command,
                        Command::ValidateDelete { .. }
                            | Command::ValidateTruncate { .. }
                            | Command::ValidateHistory { .. }
                            | Command::ValidateCancel { .. }
                            | Command::ValidateResponse { .. }
                            | Command::SendEvent { validate: true, .. }
                    );
                    self.apply(command)
                })
        };
        match result {
            Ok(effects) => json!({"effects":effects}).to_string(),
            Err(error) => {
                if !preflight {
                    self.retire();
                }
                json!({"error":error}).to_string()
            }
        }
    }
}
fn default_true() -> bool {
    true
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
fn with_event_id(mut event: Value, event_id: Option<&str>) -> Value {
    if let Some(id) = event_id {
        event["event_id"] = json!(id);
    }
    event
}
fn validate_client_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 512 {
        return Err("Invalid Realtime item or response ID".into());
    }
    Ok(())
}
fn validate_audio(audio: &str) -> Result<(), String> {
    if audio.is_empty()
        || audio.len() > MAX_CALL_BYTES
        || audio.len() % 4 != 0
        || !audio
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("Audio must be bounded base64 data".into());
    }
    Ok(())
}
fn merge_settings(target: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            merge_settings(target.entry(key.clone()).or_insert(Value::Null), value);
        }
    } else {
        *target = patch.clone();
    }
}
fn string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Provider event omitted {key}"))
}
fn hosted_call_terminal(item: &Value) -> Option<bool> {
    matches!(item["type"].as_str(), Some("mcp_call" | "mcp_tool_call")).then(|| {
        matches!(
            item["status"].as_str(),
            Some("completed" | "failed" | "incomplete")
        ) || (item["status"].is_null() && (!item["output"].is_null() || !item["error"].is_null()))
    })
}
fn merge_hosted_result(output: &mut Vec<Value>, result: &Value) {
    if let Some(item) = output
        .iter_mut()
        .find(|item| item["id"] == result["id"] && hosted_call_terminal(item).is_some())
    {
        for field in ["status", "output", "error"] {
            if let Some(value) = result.get(field) {
                item[field] = value.clone();
            }
        }
    } else {
        output.push(result.clone());
    }
}
fn arguments(request: &FunctionCall) -> Result<Value, String> {
    let args: Value =
        serde_json::from_str(&request.arguments).map_err(|_| "Invalid function arguments")?;
    if !args.is_object() {
        return Err("Function arguments must be an object".into());
    }
    Ok(args)
}
fn execute(request: &FunctionCall) -> Result<Effect, String> {
    Ok(Effect::Execute {
        call_id: request.call_id.clone(),
        name: request.name.clone(),
        arguments: arguments(request)?,
    })
}

#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(test)]
mod tests {
    use super::*;
    fn command(control: &mut Control, input: Value) -> Value {
        serde_json::from_str(&control.apply_json(&input.to_string())).unwrap()
    }
    fn tool() -> Value {
        json!({"name":"lookup","description":"Look up a value","parameters":{"type":"object"},"needs_approval":true})
    }
    fn startup(control: &mut Control) -> Value {
        command(
            control,
            json!({"type":"start","config":{"model":"test-realtime","instructions":"Help.","tools":[tool()]}}),
        )
    }
    fn accepted(control: &mut Control) -> Value {
        command(
            control,
            json!({"type":"provider","event":{"type":"session.updated","session":{"type":"realtime","model":"test-realtime","instructions":"Help.","tool_choice":"auto","tools":[{"type":"function","name":"lookup","description":"Look up a value","parameters":{"type":"object"}}]}}}),
        )
    }
    fn ready() -> Control {
        let mut control = Control::default();
        startup(&mut control);
        command(&mut control, json!({"type":"sent","id":1}));
        accepted(&mut control);
        control
    }
    fn item() -> Value {
        json!({"type":"function_call","id":"item-1","call_id":"call-1","name":"lookup","arguments":"{\"value\":7}"})
    }
    fn request(control: &mut Control) -> Value {
        command(
            control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"response-1"}}}),
        );
        command(
            control,
            json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"response-1","item":item()}}),
        )
    }
    fn batch(control: &mut Control) -> Value {
        command(
            control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"response-1","status":"completed","output":[item()]}}}),
        )
    }
    fn raw(control: &mut Control, event: Value, validate: bool) -> Value {
        command(
            control,
            json!({"type":"send_event","event":event,"validate":validate}),
        )
    }

    #[test]
    fn raw_client_events_preserve_ids_and_native_ownership() {
        let mut control = ready();
        for event in [
            json!({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":"foreign","output":"bad"}}),
            json!({"type":"conversation.item.create","item":{"type":"mcp_approval_response","approval_request_id":"foreign","approve":true}}),
            json!({"type":"input_audio_buffer.clear","extra":true}),
            json!({"type":"response.cancel","response_id":"foreign"}),
            json!({"type":"session.update","session":{"tools":[]}}),
        ] {
            let rejected = raw(&mut control, event, true);
            assert!(rejected.get("error").is_some(), "{rejected}");
        }
        for event in [
            json!({"type":"input_audio_buffer.append","audio":"AA==","event_id":"audio-1"}),
            json!({"type":"input_audio_buffer.commit","event_id":"commit-1"}),
            json!({"type":"input_audio_buffer.clear","event_id":"clear-1"}),
            json!({"type":"output_audio_buffer.clear","event_id":"playback-1"}),
            json!({"type":"conversation.item.create","event_id":"message-1","previous_item_id":null,
                "item":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}),
            json!({"type":"conversation.item.truncate","event_id":"truncate-1","item_id":"message-1","content_index":0,"audio_end_ms":10}),
        ] {
            let effect = raw(&mut control, event.clone(), false);
            assert_eq!(effect["effects"].as_array().unwrap().len(), 1, "{effect}");
            assert_eq!(effect["effects"][0]["event"], event);
            command(
                &mut control,
                json!({"type":"sent","id":effect["effects"][0]["id"]}),
            );
        }
        let create = raw(
            &mut control,
            json!({"type":"response.create","event_id":"response-request"}),
            false,
        );
        assert_eq!(
            create["effects"][0]["event"]["event_id"],
            "response-request"
        );
        command(
            &mut control,
            json!({"type":"sent","id":create["effects"][0]["id"]}),
        );
        let early = raw(
            &mut control,
            json!({"type":"response.cancel","event_id":"cancel-request"}),
            false,
        );
        assert_eq!(early["effects"], json!([]));
        let cancelled = command(
            &mut control,
            json!({"type":"provider","event":{
                "type":"response.created","response":{"id":"response-1"}
            }}),
        );
        assert!(cancelled["effects"].as_array().unwrap().iter().any(|effect| effect["event"] == json!({
            "type":"response.cancel","response_id":"response-1","event_id":"cancel-request"
        })), "{cancelled}");
    }

    #[test]
    fn raw_settings_rejection_preserves_the_last_accepted_configuration() {
        let mut control = ready();
        let settings = json!({"type":"session.update","event_id":"settings-1","session":{
            "type":"realtime","instructions":"Revised.",
            "audio":{"input":{"transcription":{"model":"gpt-4o-mini-transcribe"}}}
        }});
        let sent = raw(&mut control, settings.clone(), false);
        let event = &sent["effects"][0]["event"];
        assert_eq!(event["event_id"], "settings-1");
        assert_eq!(event["session"]["tools"], control.accepted_session["tools"]);
        command(
            &mut control,
            json!({"type":"sent","id":sent["effects"][0]["id"]}),
        );
        let rejected = command(
            &mut control,
            json!({"type":"provider","event":{
                "type":"error","error":{"type":"invalid_request_error","event_id":"settings-1"}
            }}),
        );
        assert_eq!(rejected["effects"][0]["type"], "configuration_rejected");
        assert_eq!(control.accepted_session["instructions"], "Help.");
        let resent = raw(&mut control, settings, false);
        command(
            &mut control,
            json!({"type":"sent","id":resent["effects"][0]["id"]}),
        );
        let accepted = command(
            &mut control,
            json!({"type":"provider","event":{
                "type":"session.updated","session":resent["effects"][0]["event"]["session"]
            }}),
        );
        assert!(
            accepted["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["type"] == "configured")
        );
        assert_eq!(control.accepted_session["instructions"], "Revised.");
    }

    #[test]
    fn agent_update_reuses_accepted_raw_tool_choice() {
        let mut control = ready();
        let raw_update = raw(
            &mut control,
            json!({"type":"session.update","event_id":"settings-1","session":{
                "tool_choice":"none"
            }}),
            false,
        );
        let effect = &raw_update["effects"][0];
        command(&mut control, json!({"type":"sent","id":effect["id"]}));
        let accepted = command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":effect["event"]["session"]}}),
        );
        assert!(
            accepted["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["type"] == "configured")
        );

        let updated = command(
            &mut control,
            json!({"type":"update","config":{
                "model":"test-realtime","instructions":"Revised.","tools":[tool()],
                "settings":{"tool_choice":"none"}
            }}),
        );
        let session = &updated["effects"][0]["event"]["session"];
        assert_eq!(session["tool_choice"], "none", "{updated}");
        assert_eq!(session["instructions"], "Revised.");
        assert_eq!(session["tools"], effect["event"]["session"]["tools"]);
    }

    #[test]
    fn raw_settings_fails_closed_on_correlated_fatal_errors() {
        for error in [
            json!({"type":"server_error","event_id":"settings-1","message":"internal error"}),
            json!({"type":"rate_limit_error","event_id":"settings-1"}),
            json!({"event_id":"settings-1"}),
        ] {
            let mut control = ready();
            let sent = raw(
                &mut control,
                json!({"type":"session.update","event_id":"settings-1","session":{
                    "instructions":"Revised."
                }}),
                false,
            );
            command(
                &mut control,
                json!({"type":"sent","id":sent["effects"][0]["id"]}),
            );
            let rejected = command(
                &mut control,
                json!({"type":"provider","event":{"type":"error","error":error}}),
            );
            assert!(rejected.get("error").is_some(), "{rejected}");
        }
    }

    #[test]
    fn only_foreground_tool_results_request_a_continuation() {
        for (background, explicit_create, mixed) in [
            (true, false, false),
            (true, true, false),
            (true, false, true),
            (false, false, false),
        ] {
            let mut control = ready();
            request(&mut control);
            let mut items = vec![item()];
            if mixed {
                let mut second = item();
                second["id"] = json!("item-2");
                second["call_id"] = json!("call-2");
                items.push(second);
            }
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"response-1","status":"completed","output":items}}}),
            );
            if explicit_create {
                let deferred = command(&mut control, json!({"type":"create_response"}));
                assert_eq!(deferred["effects"], json!([]));
            }
            for (index, item) in items.iter().enumerate() {
                let call_id = &item["call_id"];
                command(
                    &mut control,
                    json!({"type":"approve","call_id":call_id,"approved":true}),
                );
                let result = command(
                    &mut control,
                    json!({"type":"tool_result","call_id":call_id,"output":"{\"value\":7}","background":background && index == 0}),
                );
                assert_eq!(
                    result["effects"][0]["event"]["item"],
                    json!({
                        "type":"function_call_output", "call_id":call_id, "output":"{\"value\":7}"
                    })
                );
                let receipt = command(
                    &mut control,
                    json!({"type":"sent","id":result["effects"][0]["id"]}),
                );
                let continuation = receipt["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|effect| effect["event"]["type"] == "response.create");
                assert_eq!(
                    continuation,
                    index + 1 == items.len() && (!background || explicit_create || mixed),
                    "{receipt}"
                );
            }
        }
    }

    fn ready_hosted_mcp(automatic: bool) -> Control {
        let mut control = Control::default();
        let start = command(
            &mut control,
            json!({"type":"start","config":{
                "model":"test-realtime","instructions":"Help.","tools":[tool()],
                "hosted_mcp_auto_response":automatic,
                "hosted_tools":[{"type":"mcp","server_label":"docs","server_url":"https://example.com/mcp"}]
            }}),
        );
        command(
            &mut control,
            json!({"type":"sent","id":start["effects"][0]["id"]}),
        );
        command(
            &mut control,
            json!({"type":"provider","event":{
                "type":"session.updated","session":start["effects"][0]["event"]["session"]
            }}),
        );
        control
    }

    fn response_creates(out: &Value) -> usize {
        assert!(out.get("error").is_none(), "{out}");
        out["effects"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|effect| effect["event"]["type"] == "response.create")
            .count()
    }

    #[test]
    fn hosted_mcp_continuation_waits_for_every_late_result() {
        for (automatic, first_completed) in [(true, false), (true, true), (false, false)] {
            let mut control = ready_hosted_mcp(automatic);
            command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.created","response":{"id":"hosted-response"}
                }}),
            );
            let first = json!({"id":"mcp-1","type":"mcp_call","server_label":"docs","name":"search",
                "arguments":"{}","status":if first_completed {"completed"} else {"in_progress"}});
            let second = json!({"id":"mcp-2","type":"mcp_tool_call","server_label":"docs","name":"search",
                "arguments":"{}","status":"in_progress"});
            let done = command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.done","response":{"id":"hosted-response","status":"completed",
                    "output":[first,second]}
                }}),
            );
            assert_eq!(
                response_creates(&done),
                0,
                "continued before hosted siblings completed"
            );

            let mut first = first;
            first["status"] = json!("completed");
            first["output"] = json!("one");
            let complete_first = command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"conversation.item.done","item":first
                }}),
            );
            assert_eq!(response_creates(&complete_first), 0);

            let mut second = second;
            second["status"] = json!("failed");
            second["error"] = json!({"message":"Unavailable"});
            let wrong_scope = command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"conversation.item.done","response_id":"other-response","item":second
                }}),
            );
            assert_eq!(response_creates(&wrong_scope), 0);
            let complete_second = json!({"type":"provider","event":{
                "type":"response.output_item.done","response_id":"hosted-response","item":second
            }});
            let result = command(&mut control, complete_second.clone());
            assert_eq!(response_creates(&result), usize::from(automatic));
            assert_eq!(response_creates(&command(&mut control, complete_second)), 0);
        }
    }

    #[test]
    fn hosted_mcp_completion_respects_response_ownership_and_event_order() {
        for replacement in ["early_completion", "speech", "new_response"] {
            let mut control = ready_hosted_mcp(true);
            command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.created","response":{"id":"hosted-response"}
                }}),
            );
            let pending = json!({"id":"mcp-1","type":"mcp_call","server_label":"docs",
                "name":"search","arguments":"{}","status":"in_progress"});
            let mut result = pending.clone();
            result["status"] = json!("completed");
            result["output"] = json!("one");
            let late =
                json!({"type":"provider","event":{"type":"conversation.item.done","item":result}});
            if replacement == "early_completion" {
                assert_eq!(
                    response_creates(&command(
                        &mut control,
                        json!({"type":"provider","event":{
                            "type":"response.output_item.added","response_id":"hosted-response","item":pending
                        }})
                    )),
                    0
                );
                assert_eq!(response_creates(&command(&mut control, late.clone())), 0);
            }
            let done = command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.done","response":{"id":"hosted-response","status":"completed","output":[pending]}
                }}),
            );
            assert_eq!(
                response_creates(&done),
                usize::from(replacement == "early_completion")
            );
            match replacement {
                "speech" => {
                    command(
                        &mut control,
                        json!({"type":"provider","event":{"type":"input_audio_buffer.speech_started"}}),
                    );
                }
                "new_response" => {
                    command(
                        &mut control,
                        json!({"type":"provider","event":{
                            "type":"response.created","response":{"id":"next-response"}
                        }}),
                    );
                    command(
                        &mut control,
                        json!({"type":"provider","event":{
                            "type":"response.done","response":{"id":"next-response","status":"completed","output":[]}
                        }}),
                    );
                }
                _ => continue,
            }
            assert_eq!(response_creates(&command(&mut control, late)), 0);
        }
    }

    #[test]
    fn hosted_and_local_results_share_the_continuation_barrier() {
        for superseded in [false, true] {
            let mut control = ready_hosted_mcp(superseded);
            command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.created","response":{"id":"mixed-response"}
                }}),
            );
            let pending = json!({"id":"mcp-1","type":"mcp_call","server_label":"docs",
                "name":"search","arguments":"{}","status":"in_progress"});
            command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.done","response":{"id":"mixed-response","status":"completed","output":[item(),pending]}
                }}),
            );
            let approved = command(
                &mut control,
                json!({"type":"approve","call_id":"call-1","approved":true}),
            );
            assert_eq!(approved["effects"][0]["type"], "execute");
            let publish = command(
                &mut control,
                json!({"type":"tool_result","call_id":"call-1","output":"seven","background":superseded}),
            );
            let published = command(
                &mut control,
                json!({"type":"sent","id":publish["effects"][0]["id"]}),
            );
            assert_eq!(response_creates(&published), 0);
            if superseded {
                command(
                    &mut control,
                    json!({"type":"provider","event":{
                        "type":"response.created","response":{"id":"newer"}
                    }}),
                );
                command(
                    &mut control,
                    json!({"type":"provider","event":{
                        "type":"response.done","response":{"id":"newer","status":"completed","output":[]}
                    }}),
                );
            }
            let mut result = pending;
            result["status"] = json!("completed");
            result["output"] = json!("one");
            let settled = command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"conversation.item.done","item":result
                }}),
            );
            assert_eq!(response_creates(&settled), usize::from(!superseded));
        }
    }

    #[test]
    fn detached_hosted_continuation_replays_early_and_late_terminal_results() {
        for arrival in ["before_done", "at_done", "after_done"] {
            let mut control = ready();
            let declaration = json!({"type":"mcp","server_label":"docs",
                "server_url":"https://example.com/mcp","require_approval":"never"});
            let requested = command(
                &mut control,
                json!({"type":"create_response",
                "response":{"conversation":"none","input":[],"tools":[declaration]}}),
            );
            assert_eq!(response_creates(&requested), 1);
            command(
                &mut control,
                json!({"type":"sent","id":requested["effects"][0]["id"]}),
            );
            command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.created","response":{"id":"scoped","conversation_id":null,"metadata":null}
                }}),
            );
            let pending = json!({"id":"mcp-1","type":"mcp_call","server_label":"docs",
                "name":"search","arguments":"{}","status":"in_progress"});
            let mut terminal = pending.clone();
            terminal["status"] = json!("completed");
            terminal["output"] = json!("one");
            let complete = json!({"type":"provider","event":{
                "type":"conversation.item.done","item":terminal
            }});
            if arrival == "before_done" {
                assert_eq!(
                    response_creates(&command(
                        &mut control,
                        json!({"type":"provider","event":{
                            "type":"response.output_item.added","response_id":"scoped","item":pending
                        }})
                    )),
                    0
                );
                assert_eq!(
                    response_creates(&command(&mut control, complete.clone())),
                    0
                );
            }
            let output = if arrival == "at_done" {
                terminal
            } else {
                pending
            };
            let finished = command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.done","response":{"id":"scoped","status":"completed","output":[output]}
                }}),
            );
            let continuation = if arrival == "after_done" {
                assert_eq!(response_creates(&finished), 0);
                command(&mut control, complete.clone())
            } else {
                finished
            };
            assert_eq!(response_creates(&continuation), 1);
            let event = &continuation["effects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|effect| effect["event"]["type"] == "response.create")
                .unwrap()["event"];
            assert_eq!(event["response"]["conversation"], "none");
            assert_eq!(event["response"]["input"][0]["status"], "completed");
            assert_eq!(event["response"]["input"][0]["output"], "one");
            assert_eq!(response_creates(&command(&mut control, complete)), 0);
            assert!(control.deletion_proof("mcp-1").is_none());
            assert!(!control.responses.active_default_response);
        }
    }

    #[test]
    fn accepted_hosted_mcp_completion_respects_followup_option() {
        for enabled in [true, false] {
            let mut control = ready_hosted_mcp(enabled);
            let created = command(
                &mut control,
                json!({"type":"provider","event":{
                    "type":"response.created","response":{"id":"response-1"}
                }}),
            );
            assert!(created.get("error").is_none(), "{created}");
            let terminal = json!({"type":"provider","event":{"type":"response.done","response":{
                "id":"response-1","status":"completed","output":[
                    {"id":"mcp-1","type":"mcp_call","server_label":"docs","name":"search","arguments":"{}","output":"seven","status":"completed"}
                ]
            }}});
            let completed = command(&mut control, terminal.clone());
            assert_eq!(response_creates(&completed), usize::from(enabled));
            if enabled {
                command(
                    &mut control,
                    json!({"type":"sent","id":completed["effects"].as_array().unwrap().iter().find(|effect| effect["type"] == "send").unwrap()["id"]}),
                );
            }
            assert_eq!(response_creates(&command(&mut control, terminal)), 0);
        }
    }

    #[test]
    fn queued_text_waits_for_batch_approval_and_physical_output() {
        for before_completion in [true, false] {
            let mut control = ready();
            request(&mut control);
            if before_completion {
                let text = command(&mut control, json!({"type":"text","text":"queued"}));
                assert_eq!(text["effects"].as_array().unwrap().len(), 1);
                command(
                    &mut control,
                    json!({"type":"sent","id":text["effects"][0]["id"]}),
                );
            }
            let admitted = batch(&mut control);
            assert!(
                !admitted["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|effect| effect["type"] == "send")
            );
            if !before_completion {
                let text = command(&mut control, json!({"type":"text","text":"queued"}));
                assert_eq!(text["effects"].as_array().unwrap().len(), 1);
                command(
                    &mut control,
                    json!({"type":"sent","id":text["effects"][0]["id"]}),
                );
            }
            command(
                &mut control,
                json!({"type":"approve","call_id":"call-1","approved":true}),
            );
            let output = command(
                &mut control,
                json!({"type":"tool_result","call_id":"call-1","output":"seven"}),
            );
            assert_eq!(output["effects"].as_array().unwrap().len(), 1);
            assert_eq!(
                output["effects"][0]["event"]["item"]["type"],
                "function_call_output"
            );
            let receipt = command(
                &mut control,
                json!({"type":"sent","id":output["effects"][0]["id"]}),
            );
            assert_eq!(receipt["effects"].as_array().unwrap().len(), 1);
            assert_eq!(receipt["effects"][0]["event"]["type"], "response.create");
            assert!(!control.responses.pending_create);
        }
    }
    #[test]
    fn retirement_preempts_pending_output_and_unsettled_approval() {
        for event in [
            json!({"type":"response.cancelled","response_id":"response-1"}),
            json!({"type":"response.done","response":{"id":"response-1","status":"cancelled","output":[]}}),
            json!({"type":"response.done","response":{"id":"response-1","status":"failed","output":[]}}),
            json!({"type":"response.done","response":{"id":"response-1","status":"incomplete","output":[]}}),
            json!({"type":"error"}),
            json!({"type":"session.updated","session":{}}),
        ] {
            let mut control = ready();
            request(&mut control);
            let mut second = item();
            second["call_id"] = json!("call-2");
            second["id"] = json!("item-2");
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"response-1","status":"completed","output":[item(),second]}}}),
            );
            command(
                &mut control,
                json!({"type":"approve","call_id":"call-1","approved":true}),
            );
            command(
                &mut control,
                json!({"type":"tool_result","call_id":"call-1","output":"seven"}),
            );
            assert!(!control.pending_send.is_empty());
            let retired = command(&mut control, json!({"type":"provider","event":event}));
            assert!(retired.get("error").is_some());
            assert_eq!(
                command(
                    &mut control,
                    json!({"type":"approve","call_id":"call-2","approved":true})
                )["error"],
                "Realtime control is closed"
            );
            assert!(control.calls.is_empty());
            assert!(control.incoming.is_empty());
        }
    }
    #[test]
    fn rust_ingress_preserves_startup_order_and_retirement_preempts_a_full_inbox() {
        let mut control = Control::default();
        startup(&mut control);
        assert_eq!(accepted(&mut control)["effects"], json!([]));
        assert_eq!(request(&mut control)["effects"], json!([]));
        assert_eq!(batch(&mut control)["effects"], json!([]));
        let released = command(&mut control, json!({"type":"sent","id":1}));
        assert_eq!(released["effects"][1]["type"], "ready");
        assert!(
            released["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["type"] == "approve")
        );
        let mut control = Control::default();
        startup(&mut control);
        for _ in 0..MAX_CALLS {
            assert_eq!(
                command(
                    &mut control,
                    json!({"type":"provider","event":{"type":"response.output_text.delta","delta":"x"}})
                )["effects"],
                json!([])
            );
        }
        assert_eq!(
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.cancelled"}})
            )["error"],
            "Portable voice generation was cancelled"
        );
        assert!(control.incoming.is_empty());
    }
    #[test]
    fn readiness_requires_send_receipt_and_accepted_configuration_in_either_order() {
        for receipt_first in [true, false] {
            let mut c = Control::default();
            let output = startup(&mut c);
            assert_eq!(output["effects"][0]["event"]["session"]["type"], "realtime");
            let first = if receipt_first {
                command(&mut c, json!({"type":"sent","id":1}))
            } else {
                accepted(&mut c)
            };
            assert!(
                !first["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["type"] == "ready")
            );
            let second = if receipt_first {
                accepted(&mut c)
            } else {
                command(&mut c, json!({"type":"sent","id":1}))
            };
            assert!(
                second["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["type"] == "ready")
            );
        }
    }
    #[test]
    fn functions_wait_for_complete_batch_and_single_use_approval() {
        let mut c = ready();
        let discovered = request(&mut c);
        assert_eq!(discovered["effects"].as_array().unwrap().len(), 1);
        let admitted = batch(&mut c);
        assert_eq!(
            admitted["effects"][0],
            json!({"type":"approve","call_id":"call-1","name":"lookup","arguments":{"value":7}})
        );
        let approved = command(
            &mut c,
            json!({"type":"approve","call_id":"call-1","approved":true}),
        );
        assert_eq!(approved["effects"][0]["type"], "execute");
        let reused = command(
            &mut c,
            json!({"type":"approve","call_id":"call-1","approved":true}),
        );
        assert!(
            reused["error"]
                .as_str()
                .unwrap()
                .contains("already settled")
        );
    }
    #[test]
    fn continuation_waits_for_physical_tool_output_receipt() {
        let mut c = ready();
        request(&mut c);
        batch(&mut c);
        command(
            &mut c,
            json!({"type":"approve","call_id":"call-1","approved":true}),
        );
        let output = command(
            &mut c,
            json!({"type":"tool_result","call_id":"call-1","output":"seven"}),
        );
        assert_eq!(
            output["effects"],
            json!([{"type":"send","id":2,"event":{"type":"conversation.item.create","item":{"type":"function_call_output","call_id":"call-1","output":"seven"}}}])
        );
        let sent = command(&mut c, json!({"type":"sent","id":2}));
        assert_eq!(
            sent["effects"],
            json!([{"type":"send","id":3,"event":{"type":"response.create"}}])
        );
        let late = command(
            &mut c,
            json!({"type":"tool_result","call_id":"call-1","output":"duplicate"}),
        );
        assert!(late.get("error").is_some());
    }
    #[test]
    fn denied_approval_never_executes_callback() {
        let mut c = ready();
        request(&mut c);
        batch(&mut c);
        let denied = command(
            &mut c,
            json!({"type":"approve","call_id":"call-1","approved":false}),
        );
        assert_eq!(
            denied["effects"][0]["event"]["item"]["output"],
            "Tool execution was not approved."
        );
        assert!(
            !denied["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "execute")
        );
    }
    #[test]
    fn changed_function_identity_closes_control_before_execution() {
        let mut c = ready();
        request(&mut c);
        let mut changed = item();
        changed["arguments"] = json!("{\"value\":9}");
        let result = command(
            &mut c,
            json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"response-1","item":changed}}),
        );
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("identity changed")
        );
        assert_eq!(
            command(
                &mut c,
                json!({"type":"approve","call_id":"call-1","approved":true})
            )["error"],
            "Realtime control is closed"
        );
    }
    #[test]
    fn unrelated_tools_and_unaccepted_settings_fail_before_execution() {
        let mut c = Control::default();
        startup(&mut c);
        let result = command(
            &mut c,
            json!({"type":"provider","event":{"type":"session.updated","session":{"tools":[{"type":"function","name":"foreign","parameters":{}}]}}}),
        );
        assert_eq!(
            result["error"],
            "Provider accepted another tool configuration"
        );
    }
    #[test]
    fn non_completed_responses_never_admit_functions_and_retire_the_owner() {
        for status in [
            json!("cancelled"),
            json!("failed"),
            json!("incomplete"),
            json!("in_progress"),
            Value::Null,
        ] {
            let mut control = ready();
            request(&mut control);
            let response = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"response-1","status":status,"output":[item()]}}}),
            );
            assert_eq!(
                response["error"],
                "Incomplete Realtime response cannot admit functions"
            );
            assert_eq!(
                command(
                    &mut control,
                    json!({"type":"approve","call_id":"call-1","approved":true})
                )["error"],
                "Realtime control is closed"
            );
        }
    }
    #[test]
    fn provider_cancellation_retires_discovery_approval_execution_and_publication() {
        for stage in 0..4 {
            let mut control = ready();
            request(&mut control);
            if stage >= 1 {
                batch(&mut control);
            }
            if stage >= 2 {
                command(
                    &mut control,
                    json!({"type":"approve","call_id":"call-1","approved":true}),
                );
            }
            if stage >= 3 {
                command(
                    &mut control,
                    json!({"type":"tool_result","call_id":"call-1","output":"late"}),
                );
            }
            let cancelled = control.apply(Command::Provider {
                event: json!({"type":"response.cancelled","response_id":"response-1"}),
            });
            assert_eq!(
                cancelled.unwrap_err(),
                "Portable voice generation was cancelled"
            );
            assert_eq!(
                command(
                    &mut control,
                    json!({"type":"tool_result","call_id":"call-1","output":"late"})
                )["error"],
                "Realtime control is closed"
            );
            assert!(control.calls.is_empty());
            assert!(control.pending_send.is_empty());
        }
    }
    #[test]
    fn user_speech_revokes_live_function_claims_without_closing_the_session() {
        let speech = json!({"type":"provider","event":{"type":"input_audio_buffer.speech_started","item_id":"input-1"}});
        for stage in 0..3 {
            let mut control = ready();
            request(&mut control);
            if stage >= 1 {
                batch(&mut control);
            }
            if stage >= 2 {
                command(
                    &mut control,
                    json!({"type":"approve","call_id":"call-1","approved":true}),
                );
            }
            let interrupted = command(&mut control, speech.clone());
            assert!(interrupted.get("error").is_none());
            assert!(
                interrupted["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["type"] == "abort" && e["call_id"] == "call-1")
            );
            assert!(control.calls["call-1"].phase == CallPhase::Cancelled);
            assert!(control.phase == Phase::Ready);
        }
    }
    #[test]
    fn duplicate_accepted_names_cannot_replace_a_declared_tool() {
        let mut control = Control::default();
        let mut other = tool();
        other["name"] = json!("other");
        command(
            &mut control,
            json!({"type":"start","config":{"model":"test-realtime","instructions":"Help.","tools":[tool(),other]}}),
        );
        command(&mut control, json!({"type":"sent","id":1}));
        let mut wire_tool = tool();
        wire_tool.as_object_mut().unwrap().remove("needs_approval");
        wire_tool["type"] = json!("function");
        let accepted = command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":{"type":"realtime","model":"test-realtime","instructions":"Help.","tool_choice":"auto","tools":[wire_tool,wire_tool]}}}),
        );
        assert_eq!(
            accepted["error"],
            "Provider accepted another tool configuration"
        );
    }
    #[test]
    fn configuration_acceptance_preserves_all_requested_values() {
        let mut control = Control::default();
        startup(&mut control);
        command(&mut control, json!({"type":"sent","id":1}));
        let changed = command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":{"type":"realtime","model":"test-realtime","instructions":"Different instructions","tool_choice":"auto","tools":[{"type":"function","name":"lookup","description":"Look up a value","parameters":{"type":"object"}}]}}}),
        );
        assert_eq!(
            changed["error"],
            "Provider accepted another tool configuration"
        );
    }
    #[test]
    fn settings_and_updates_require_exact_ack_and_physical_receipt() {
        let mut control = ready();
        let updated = command(
            &mut control,
            json!({"type":"update","config":{"model":"test-realtime","instructions":"New profile","tools":[],"settings":{"audio":{"output":{"voice":"marin"}}}}}),
        );
        let effect = &updated["effects"][0];
        assert_eq!(
            effect["event"]["session"]["audio"]["output"]["voice"],
            "marin"
        );
        let accepted = command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":effect["event"]["session"]}}),
        );
        assert_eq!(accepted["effects"], json!([]));
        let receipt = command(&mut control, json!({"type":"sent","id":effect["id"]}));
        assert!(
            receipt["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "configured")
        );
        assert!(control.tools.is_empty());
        let mut invalid = ready();
        assert_eq!(
            command(
                &mut invalid,
                json!({"type":"update","config":{"model":"x","instructions":"x","settings":{"tools":[]}}})
            )["error"],
            "Invalid Realtime configuration"
        );
    }
    #[test]
    fn active_response_retains_accepted_tool_approval_snapshot_across_update() {
        let mut control = ready();
        request(&mut control);
        let updated = command(
            &mut control,
            json!({"type":"update","config":{"model":"test-realtime","instructions":"New profile","tools":[]}}),
        );
        let effect = &updated["effects"][0];
        command(&mut control, json!({"type":"sent","id":effect["id"]}));
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":effect["event"]["session"]}}),
        );
        let admitted = batch(&mut control);
        assert_eq!(admitted["effects"][0]["type"], "approve");
        assert_eq!(admitted["effects"][0]["call_id"], "call-1");
        let executed = command(
            &mut control,
            json!({"type":"approve","call_id":"call-1","approved":true}),
        );
        assert_eq!(executed["effects"][0]["type"], "execute");
    }
    #[test]
    fn external_deletion_requires_exact_terminal_lookup_and_keeps_connection_usable() {
        for item in [
            json!({"id":"external","type":"function_call","status":"in_progress"}),
            json!({"id":"external","type":"function_call"}),
            json!({"id":"external","type":"mcp_call","status":"in_progress","output":"early"}),
            json!({"id":"external","type":"mcp_approval_request"}),
        ] {
            let mut control = ready();
            let lookup = command(&mut control, json!({"type":"delete","item_id":"external"}));
            assert_eq!(
                lookup["effects"][0]["event"]["type"],
                "conversation.item.retrieve"
            );
            command(
                &mut control,
                json!({"type":"sent","id":lookup["effects"][0]["id"]}),
            );
            let foreign = command(
                &mut control,
                json!({"type":"provider","event":{"type":"conversation.item.retrieved","item":{"id":"foreign","type":"message"}}}),
            );
            assert_eq!(foreign["effects"].as_array().unwrap().len(), 1);
            assert!(control.pending_deletions.contains_key("external"));
            let rejected = command(
                &mut control,
                json!({"type":"provider","event":{"type":"conversation.item.retrieved","item":item}}),
            );
            assert_eq!(rejected["effects"][0]["type"], "history_rejected");
            assert_eq!(rejected["effects"][0]["item_id"], "external");
            assert!(control.pending_deletions.is_empty());
            assert!(control.phase == Phase::Ready);
            assert_eq!(
                command(&mut control, json!({"type":"create_response"}))["effects"][0]["event"]["type"],
                "response.create"
            );
        }
    }
    #[test]
    fn lookup_preserves_external_messages_and_schema_terminal_tool_items() {
        for item in [
            json!({"id":"external","type":"message"}),
            json!({"id":"external","type":"function_call","status":"completed"}),
            json!({"id":"external","type":"function_call_output","call_id":"call","output":"result"}),
            json!({"id":"external","type":"mcp_call","output":"result"}),
            json!({"id":"external","type":"mcp_call","error":{"message":"failed"}}),
            json!({"id":"external","type":"mcp_list_tools","tools":[]}),
            json!({"id":"external","type":"mcp_approval_response","approval_request_id":"approval","approve":false}),
        ] {
            let mut control = ready();
            let lookup = command(&mut control, json!({"type":"delete","item_id":"external"}));
            command(
                &mut control,
                json!({"type":"sent","id":lookup["effects"][0]["id"]}),
            );
            let deleted = command(
                &mut control,
                json!({"type":"provider","event":{"type":"conversation.item.retrieved","item":item}}),
            );
            assert_eq!(
                deleted["effects"][0]["event"]["type"],
                "conversation.item.delete"
            );
            assert_eq!(deleted["effects"][0]["event"]["item_id"], "external");
            command(
                &mut control,
                json!({"type":"sent","id":deleted["effects"][0]["id"]}),
            );
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"conversation.item.deleted","item_id":"external"}}),
            );
            assert!(control.pending_deletions.is_empty());
        }
    }
    #[test]
    fn lookup_error_is_exact_recoverable_and_retirement_clears_proofs() {
        let mut control = ready();
        let lookup = command(&mut control, json!({"type":"delete","item_id":"external"}));
        command(
            &mut control,
            json!({"type":"sent","id":lookup["effects"][0]["id"]}),
        );
        let error = json!({"type":"error","error":{"type":"invalid_request_error","message":"private","event_id":lookup["effects"][0]["event"]["event_id"]}});
        let rejected = command(&mut control, json!({"type":"provider","event":error}));
        assert_eq!(rejected["effects"][0]["type"], "history_rejected");
        assert!(control.phase == Phase::Ready);
        assert!(control.pending_deletions.is_empty());
        let unrelated = json!({"type":"provider","event":{"type":"error","error":{"type":"invalid_request_error","message":"private","event_id":"unrelated"}}});
        assert!(command(&mut control, unrelated)["error"].is_string());
        assert!(control.phase == Phase::Closed);
        assert!(control.deletion_proofs.is_empty());
        assert!(control.deletion_order.is_empty());
    }
    #[test]
    fn observed_authority_status_and_accepted_approval_decision_control_preflight() {
        let mut control = ready();
        for item in [
            json!({"id":"active","type":"function_call","status":"in_progress"}),
            json!({"id":"approval","type":"mcp_approval_request"}),
        ] {
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"conversation.item.done","item":item}}),
            );
        }
        let before = control.next_send;
        for id in ["active", "approval"] {
            assert!(
                command(
                    &mut control,
                    json!({"type":"validate_history","delete_ids":[id],"items":[]})
                )["error"]
                    .is_string()
            );
        }
        assert_eq!(control.next_send, before);
        assert!(control.phase == Phase::Ready);
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"conversation.item.created","item":{"id":"decision","type":"mcp_approval_response","approval_request_id":"approval","approve":true}}}),
        );
        assert_eq!(
            command(
                &mut control,
                json!({"type":"validate_history","delete_ids":["approval"],"items":[]})
            )["effects"],
            json!([])
        );
        assert_eq!(
            command(&mut control, json!({"type":"delete","item_id":"approval"}))["effects"][0]["event"]
                ["type"],
            "conversation.item.delete"
        );
    }
    #[test]
    fn lookup_rechecks_live_native_ownership_and_bounded_proof_storage() {
        let mut control = ready();
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"response-1"}}}),
        );
        let lookup = command(&mut control, json!({"type":"delete","item_id":"item-1"}));
        command(
            &mut control,
            json!({"type":"sent","id":lookup["effects"][0]["id"]}),
        );
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"response-1","item":item()}}),
        );
        let rejected = command(
            &mut control,
            json!({"type":"provider","event":{"type":"conversation.item.retrieved","item":{"id":"item-1","type":"function_call","status":"completed"}}}),
        );
        assert_eq!(rejected["effects"][0]["type"], "history_rejected");
        assert!(control.phase == Phase::Ready);
        for index in 0..MAX_OBSERVED_ITEMS + 1 {
            control
                .observe_deletion_item(&json!({"id":format!("history-{index}"),"type":"message"}));
        }
        assert_eq!(control.deletion_proofs.len(), MAX_OBSERVED_ITEMS);
        assert_eq!(control.deletion_order.len(), MAX_OBSERVED_ITEMS);
        assert!(!control.deletion_proofs.contains_key("history-0"));
        assert!(
            control
                .deletion_proofs
                .contains_key(&format!("history-{}", MAX_OBSERVED_ITEMS))
        );
    }
    #[test]
    fn rejected_external_lookup_can_be_retried_after_external_completion() {
        let mut control = ready();
        for (status, expected) in [("in_progress", "history_rejected"), ("completed", "send")] {
            let lookup = command(&mut control, json!({"type":"delete","item_id":"external"}));
            assert_eq!(
                lookup["effects"][0]["event"]["type"],
                "conversation.item.retrieve"
            );
            command(
                &mut control,
                json!({"type":"sent","id":lookup["effects"][0]["id"]}),
            );
            let result = command(
                &mut control,
                json!({"type":"provider","event":{"type":"conversation.item.retrieved","item":{"id":"external","type":"function_call","call_id":"external-call","status":status}}}),
            );
            assert_eq!(result["effects"][0]["type"], expected);
        }
    }
    #[test]
    fn external_aliases_cannot_bypass_live_function_or_mcp_approval_ownership() {
        for item in [
            json!({"id":"alias","type":"function_call","call_id":"call-1","status":"completed"}),
            json!({"id":"alias","type":"function_call_output","call_id":"call-1","output":"done"}),
            json!({"id":"alias","type":"mcp_call","approval_request_id":"approval-1","output":"done"}),
            json!({"id":"alias","type":"mcp_approval_response","approval_request_id":"approval-1","approve":false}),
        ] {
            let mut control = if item["type"].as_str().unwrap().starts_with("mcp_") {
                let mut control = hosted_ready();
                hosted_batch(&mut control);
                control
            } else {
                let mut control = ready();
                request(&mut control);
                control
            };
            let lookup = command(&mut control, json!({"type":"delete","item_id":"alias"}));
            command(
                &mut control,
                json!({"type":"sent","id":lookup["effects"][0]["id"]}),
            );
            let result = command(
                &mut control,
                json!({"type":"provider","event":{"type":"conversation.item.retrieved","item":item}}),
            );
            assert_eq!(result["effects"][0]["type"], "history_rejected");
            assert!(control.phase == Phase::Ready);
            assert!(
                command(
                    &mut control,
                    json!({"type":"validate_history","delete_ids":["alias"],"items":[]})
                )["error"]
                    .is_string()
            );
        }
    }
    #[test]
    fn oversized_external_alias_cannot_bypass_live_native_ownership() {
        let mut control = ready();
        let call_id = "c".repeat(513);
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"response-1"}}}),
        );
        let mut owned = item();
        owned["call_id"] = json!(call_id);
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"response-1","item":owned}}),
        );
        assert!(control.calls.contains_key(&call_id));
        let lookup = command(&mut control, json!({"type":"delete","item_id":"alias"}));
        command(
            &mut control,
            json!({"type":"sent","id":lookup["effects"][0]["id"]}),
        );
        let result = command(
            &mut control,
            json!({"type":"provider","event":{"type":"conversation.item.retrieved","item":{"id":"alias","type":"function_call_output","call_id":call_id,"output":"done"}}}),
        );
        assert_eq!(result["effects"][0]["type"], "history_rejected");
        assert!(
            result["effects"]
                .as_array()
                .unwrap()
                .iter()
                .all(|effect| effect["type"] != "send")
        );
        assert!(control.phase == Phase::Ready);
        assert!(
            command(
                &mut control,
                json!({"type":"validate_history","delete_ids":["alias"],"items":[]})
            )["error"]
                .is_string()
        );
    }
    #[test]
    fn message_and_history_commands_emit_provider_mutations() {
        let mut control = ready();
        let item = json!({"type":"message","id":"message-1","role":"user","content":[{"type":"input_text","text":"hello"}]});
        let input = command(&mut control, json!({"type":"input","item":item}));
        assert_eq!(input["effects"][0]["event"]["item"], item);
        assert_eq!(input["effects"][1]["event"]["type"], "response.create");
        command(&mut control, json!({"type":"sent","id":2}));
        command(&mut control, json!({"type":"sent","id":3}));
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"conversation.item.created","item":item}}),
        );
        let deleted = command(&mut control, json!({"type":"delete","item_id":"message-1"}));
        assert_eq!(
            deleted["effects"][0]["event"],
            json!({"type":"conversation.item.delete","item_id":"message-1","event_id":"portable-history-4"})
        );
        let truncated = command(
            &mut control,
            json!({"type":"truncate","item_id":"audio-1","content_index":0,"audio_end_ms":123}),
        );
        assert_eq!(
            truncated["effects"][0]["event"],
            json!({"type":"conversation.item.truncate","item_id":"audio-1","content_index":0,"audio_end_ms":123})
        );
    }
    #[test]
    fn guardrail_replacement_waits_for_exact_cancellation_and_send_receipt() {
        for terminal_first in [true, false] {
            let mut control = ready();
            request(&mut control);
            let guarded = command(
                &mut control,
                json!({"type":"guardrail","response_id":"response-1","output":"Please use a safe response."}),
            );
            assert_eq!(
                guarded["effects"][0]["event"],
                json!({"type":"response.cancel","response_id":"response-1","event_id":"cancel_1"})
            );
            assert!(
                guarded["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["type"] == "abort")
            );
            let terminal = json!({"type":"provider","event":{"type":"response.done","response":{"id":"response-1","status":"cancelled","output":[item()]}}});
            let receipt = json!({"type":"sent","id":guarded["effects"][0]["id"]});
            let first = command(
                &mut control,
                if terminal_first {
                    terminal.clone()
                } else {
                    receipt.clone()
                },
            );
            assert!(
                !first["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["event"]["type"] == "response.create")
            );
            let second = command(
                &mut control,
                if terminal_first { receipt } else { terminal },
            );
            assert!(
                second["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["event"]["type"] == "response.create"
                        && e["event"]["response"]["instructions"] == "Please use a safe response.")
            );
            assert!(control.calls["call-1"].phase == CallPhase::Cancelled);
        }
    }
    #[test]
    fn cancel_before_response_identity_waits_and_targets_the_created_response() {
        let mut control = ready();
        let text = command(&mut control, json!({"type":"text","text":"hello"}));
        assert_eq!(
            command(&mut control, json!({"type":"cancel"}))["effects"],
            json!([])
        );
        for effect in text["effects"].as_array().unwrap() {
            command(&mut control, json!({"type":"sent","id":effect["id"]}));
        }
        let created = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"cancel-me"}}}),
        );
        assert_eq!(
            created["effects"][0]["event"],
            json!({"type":"response.cancel","response_id":"cancel-me","event_id":"cancel_1"})
        );
        assert!(control.retired_responses.contains("cancel-me"));
        assert!(!control.responses.active_default_response);
    }
    #[test]
    fn pcm_audio_commands_preserve_commit_before_response_and_bound_chunks() {
        let mut control = ready();
        let appended = command(&mut control, json!({"type":"audio","audio":"AQIDBA=="}));
        assert_eq!(
            appended["effects"][0]["event"],
            json!({"type":"input_audio_buffer.append","audio":"AQIDBA=="})
        );
        let committed = command(&mut control, json!({"type":"commit_audio"}));
        assert_eq!(
            committed["effects"][0]["event"]["type"],
            "input_audio_buffer.commit"
        );
        assert_eq!(committed["effects"].as_array().unwrap().len(), 1);
        assert_eq!(
            command(&mut control, json!({"type":"create_response"}))["effects"][0]["event"]["type"],
            "response.create"
        );
        assert_eq!(
            command(&mut control, json!({"type":"clear_audio"}))["effects"][0]["event"]["type"],
            "input_audio_buffer.clear"
        );
        assert_eq!(
            command(&mut control, json!({"type":"create_response"}))["effects"],
            json!([])
        );
        let mut invalid = ready();
        assert_eq!(
            command(
                &mut invalid,
                json!({"type":"audio","audio":"A".repeat(MAX_CALL_BYTES + 4)})
            )["error"],
            "Audio must be bounded base64 data"
        );
    }
    #[test]
    fn invalid_guardrail_identity_cannot_cancel_another_response() {
        let mut control = ready();
        request(&mut control);
        assert_eq!(
            command(
                &mut control,
                json!({"type":"guardrail","response_id":"foreign","output":"stop"})
            )["error"],
            "Guardrail does not own the active response"
        );
    }
    fn detached(control: &mut Control, id: &str) -> Value {
        let requested = command(
            control,
            json!({"type":"create_response","response":{"conversation":"none","instructions":"Independent","metadata":{"purpose":"test"}}}),
        );
        let send = &requested["effects"][0];
        command(control, json!({"type":"sent","id":send["id"]}));
        let response = json!({"id":id,"conversation_id":null,"metadata":send["event"]["response"]["metadata"]});
        let created = command(
            control,
            json!({"type":"provider","event":{"type":"response.created","response":response}}),
        );
        assert!(created.get("error").is_none(), "{created}");
        response
    }
    #[test]
    fn detached_scopes_acknowledge_independently_and_cannot_admit_local_tools() {
        let mut control = ready();
        request(&mut control);
        detached(&mut control, "detached-1");
        detached(&mut control, "detached-2");
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"external","conversation_id":null,"metadata":{"purpose":"external"}}}}),
        );
        let passive = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"external","item":item()}}),
        );
        assert_eq!(passive["effects"].as_array().unwrap().len(), 1);
        assert_eq!(passive["effects"][0]["type"], "event");
        assert_eq!(
            control.responses.sdk_response_id.as_deref(),
            Some("response-1")
        );
        let cancelled = command(
            &mut control,
            json!({"type":"cancel","response_id":"detached-2"}),
        );
        assert!(
            cancelled["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["event"]
                    == json!({"type":"response.cancel","response_id":"detached-2","event_id":"cancel_1"}))
        );
        let done = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"detached-1","status":"failed","output":[item()]}}}),
        );
        assert!(done.get("error").is_none());
        assert_eq!(control.calls.len(), 1);
        assert_eq!(
            control.responses.sdk_response_id.as_deref(),
            Some("response-1")
        );
    }
    #[test]
    fn detached_scope_preserves_all_metadata_keys_and_awaits_matching_ack() {
        let mut control = ready();
        let metadata: BTreeMap<_, _> = (0..16)
            .map(|index| (format!("key-{index}"), json!("value")))
            .collect();
        let requested = command(
            &mut control,
            json!({"type":"create_response","response":{"conversation":"none","metadata":metadata}}),
        );
        assert_eq!(
            requested["effects"][0]["event"]["response"]["metadata"],
            json!(metadata)
        );
        command(
            &mut control,
            json!({"type":"sent","id":requested["effects"][0]["id"]}),
        );
        let foreign = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"foreign","conversation_id":null,"metadata":{}}}}),
        );
        assert!(
            !foreign["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["type"] == "scope")
        );
        assert!(control.pending_detached.is_some());
        let owned = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"owned","conversation_id":null,"metadata":metadata}}}),
        );
        assert_eq!(owned["effects"][0]["type"], "scope");
        assert_eq!(owned["effects"][0]["out_of_band"], true);
        assert!(control.pending_detached.is_none());
    }
    #[test]
    fn detached_guardrail_replacement_keeps_scope_and_default_response_owner() {
        let mut control = ready();
        request(&mut control);
        detached(&mut control, "guarded-detached");
        let guarded = command(
            &mut control,
            json!({"type":"guardrail","response_id":"guarded-detached","output":"Safe independent output"}),
        );
        assert_eq!(
            guarded["effects"][0]["event"]["response_id"],
            "guarded-detached"
        );
        command(
            &mut control,
            json!({"type":"sent","id":guarded["effects"][0]["id"]}),
        );
        let finished = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"guarded-detached","status":"cancelled","output":[]}}}),
        );
        assert!(
            finished["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["type"] == "send"
                    && effect["event"]["response"]["conversation"] == "none"
                    && effect["event"]["response"]["instructions"] == "Safe independent output")
        );
        assert_eq!(
            control.responses.sdk_response_id.as_deref(),
            Some("response-1")
        );
    }
    #[test]
    fn guardrail_can_replace_a_completed_response_without_cancelling_another_owner() {
        let mut control = ready();
        request(&mut control);
        batch(&mut control);
        let guarded = command(
            &mut control,
            json!({"type":"guardrail","response_id":"response-1","output":"Safe final output"}),
        );
        assert!(
            guarded["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["type"] == "abort")
        );
        assert!(
            guarded["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["event"]["type"] == "response.create"
                    && effect["event"]["response"]["instructions"] == "Safe final output")
        );
        assert!(
            !guarded["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["event"]["type"] == "response.cancel")
        );
    }
    #[test]
    fn manual_default_response_options_survive_deferral() {
        let mut control = ready();
        request(&mut control);
        let queued = command(
            &mut control,
            json!({"type":"create_response","response":{"instructions":"Manual response","output_modalities":["text"]}}),
        );
        assert_eq!(queued["effects"], json!([]));
        let completed = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"response-1","status":"completed","output":[item()]}}}),
        );
        assert_eq!(completed["effects"][0]["type"], "approve");
        command(
            &mut control,
            json!({"type":"approve","call_id":"call-1","approved":false}),
        );
        let sent = *control.pending_send.iter().next().unwrap();
        let released = command(&mut control, json!({"type":"sent","id":sent}));
        assert_eq!(
            released["effects"][0]["event"]["response"]["instructions"],
            "Manual response"
        );
    }
    fn hosted_item() -> Value {
        json!({"type":"mcp_approval_request","id":"approval-1","server_label":"docs","name":"search","arguments":"{\"query\":\"Realtime\"}"})
    }
    fn hosted_ready() -> Control {
        let mut control = Control::default();
        let start = command(
            &mut control,
            json!({"type":"start","config":{"model":"test-realtime","instructions":"Help.","hosted_tools":[{"type":"mcp","server_label":"docs","server_url":"https://example.com/mcp","allowed_tools":["search"],"require_approval":"always","authorization":"synthetic"}]}}),
        );
        command(
            &mut control,
            json!({"type":"sent","id":start["effects"][0]["id"]}),
        );
        let mut session = start["effects"][0]["event"]["session"].clone();
        session["tools"][0]
            .as_object_mut()
            .unwrap()
            .remove("authorization");
        let ack = command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":session}}),
        );
        assert!(ack.get("error").is_none(), "{ack}");
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"hosted-response"}}}),
        );
        control
    }
    fn hosted_batch(control: &mut Control) -> Value {
        command(
            control,
            json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"hosted-response","item":hosted_item()}}),
        );
        command(
            control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"hosted-response","status":"completed","output":[hosted_item()]}}}),
        )
    }
    #[test]
    fn hosted_mcp_approval_uses_source_catalog_and_physical_receipt_without_local_execution() {
        let mut control = hosted_ready();
        let update = command(
            &mut control,
            json!({"type":"update","config":{"model":"test-realtime","instructions":"New profile"}}),
        );
        command(
            &mut control,
            json!({"type":"sent","id":update["effects"][0]["id"]}),
        );
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":update["effects"][0]["event"]["session"]}}),
        );
        let batch = hosted_batch(&mut control);
        assert_eq!(
            batch["effects"][0],
            json!({"type":"approve_mcp","request_id":"approval-1","server_label":"docs","name":"search","arguments":{"query":"Realtime"}})
        );
        let approved = command(
            &mut control,
            json!({"type":"approve_mcp","request_id":"approval-1","approved":true}),
        );
        assert_eq!(approved["effects"].as_array().unwrap().len(), 1);
        assert_eq!(
            approved["effects"][0]["event"]["item"],
            json!({"type":"mcp_approval_response","approval_request_id":"approval-1","approve":true})
        );
        let sent = command(
            &mut control,
            json!({"type":"sent","id":approved["effects"][0]["id"]}),
        );
        assert_eq!(sent["effects"][0]["event"]["type"], "response.create");
        assert!(
            command(
                &mut control,
                json!({"type":"approve_mcp","request_id":"approval-1","approved":true})
            )
            .get("error")
            .is_some()
        );
    }
    #[test]
    fn hosted_mcp_approval_revocation_prevents_late_or_foreign_decisions() {
        let mut control = hosted_ready();
        hosted_batch(&mut control);
        let cancelled = command(&mut control, json!({"type":"cancel"}));
        assert!(cancelled["effects"].as_array().unwrap().iter().any(|effect|effect["type"] == "abort_mcp" && effect["request_id"] == "approval-1"));
        assert!(
            cancelled["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["type"] == "retire"
                    && effect["response_id"] == "hosted-response")
        );
        assert!(
            command(
                &mut control,
                json!({"type":"approve_mcp","request_id":"approval-1","approved":true})
            )
            .get("error")
            .is_some()
        );
        for key in ["server_label", "name"] {
            let mut control = hosted_ready();
            let mut foreign = hosted_item();
            foreign[key] = json!("foreign");
            assert!(command(&mut control, json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"hosted-response","item":foreign}})).get("error").is_some());
        }
    }
    #[test]
    fn managed_detached_function_uses_captured_source_and_detached_continuation_input() {
        let mut control = ready();
        request(&mut control);
        let history = json!([{"type":"message","id":"user-1","role":"user","content":[{"type":"input_text","text":"Independent context"}]}]);
        let created = command(
            &mut control,
            json!({"type":"create_response","response":{"conversation":"none","metadata":{"purpose":"managed"}},"history":history}),
        );
        command(
            &mut control,
            json!({"type":"sent","id":created["effects"][0]["id"]}),
        );
        let owned = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"managed","conversation_id":null,"metadata":{"purpose":"managed"}}}}),
        );
        assert_eq!(owned["effects"][0]["type"], "scope");
        assert_eq!(owned["effects"][0]["history"], history);
        let update = command(
            &mut control,
            json!({"type":"update","config":{"profile_id":42,"model":"test-realtime","instructions":"New source","tools":[]}}),
        );
        command(
            &mut control,
            json!({"type":"sent","id":update["effects"][0]["id"]}),
        );
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":update["effects"][0]["event"]["session"]}}),
        );
        let mut call = item();
        call["id"] = json!("managed-item");
        call["call_id"] = json!("managed-call");
        let completed = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"managed","status":"completed","output":[call]}}}),
        );
        assert_eq!(completed["effects"][0]["type"], "approve");
        command(
            &mut control,
            json!({"type":"approve","call_id":"managed-call","approved":true}),
        );
        let result = command(
            &mut control,
            json!({"type":"tool_result","call_id":"managed-call","output":"seven"}),
        );
        assert_eq!(result["effects"].as_array().unwrap().len(), 1);
        let event = &result["effects"][0]["event"];
        assert_eq!(event["type"], "response.create");
        assert_eq!(event["response"]["conversation"], "none");
        assert_eq!(event["response"]["instructions"], "Help.");
        assert_eq!(event["response"]["input"][0], history[0]);
        assert_eq!(
            event["response"]["input"][2]["type"],
            "function_call_output"
        );
        assert_eq!(
            control.responses.sdk_response_id.as_deref(),
            Some("response-1")
        );
        command(
            &mut control,
            json!({"type":"sent","id":result["effects"][0]["id"]}),
        );
        let continuation = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"managed-next","conversation_id":null,"metadata":{"purpose":"managed"}}}}),
        );
        assert_eq!(continuation["effects"][0]["profile_id"], 0);
    }
    #[test]
    fn response_only_hosted_mcp_is_routable_on_managed_detached_scope() {
        let mut control = ready();
        let declaration = json!({"type":"mcp","server_label":"docs","server_url":"https://example.com/mcp","allowed_tools":["search"],"require_approval":"always"});
        let requested = command(
            &mut control,
            json!({"type":"create_response","response":{"conversation":"none","input":[],"tools":[declaration]}}),
        );
        assert!(requested.get("error").is_none(), "{requested}");
        command(
            &mut control,
            json!({"type":"sent","id":requested["effects"][0]["id"]}),
        );
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"scoped-mcp","conversation_id":null,"metadata":null}}}),
        );
        let batch = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"scoped-mcp","status":"completed","output":[hosted_item()]}}}),
        );
        assert_eq!(batch["effects"][0]["type"], "approve_mcp");
        let approved = command(
            &mut control,
            json!({"type":"approve_mcp","request_id":"approval-1","approved":true}),
        );
        assert_eq!(approved["effects"][0]["event"]["type"], "response.create");
        assert_eq!(
            approved["effects"][0]["event"]["response"]["conversation"],
            "none"
        );
        assert_eq!(
            approved["effects"][0]["event"]["response"]["input"][1]["type"],
            "mcp_approval_response"
        );
        assert!(!control.responses.active_default_response);
    }
    #[test]
    fn scoped_default_ack_does_not_let_automatic_vad_consume_response_tool_authority() {
        let mut control = ready();
        let declaration = json!({"type":"mcp","server_label":"docs","server_url":"https://example.com/mcp","require_approval":"always"});
        let metadata: BTreeMap<_, _> = (0..16)
            .map(|index| (format!("key-{index}"), json!("value")))
            .collect();
        let requested = command(
            &mut control,
            json!({"type":"create_response","response":{"instructions":"Scoped","tools":[declaration],"metadata":metadata}}),
        );
        assert_eq!(
            requested["effects"][0]["event"]["response"]["metadata"],
            json!(metadata)
        );
        command(
            &mut control,
            json!({"type":"sent","id":requested["effects"][0]["id"]}),
        );
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"automatic","conversation_id":"default","metadata":null}}}),
        );
        assert!(control.pending_default.is_some());
        assert!(control.response_tools.contains_key("lookup"));
        assert!(control.response_hosted.is_empty());
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"automatic","status":"completed","output":[]}}}),
        );
        assert!(control.pending_default.is_some());
        let acknowledged = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"scoped-default","conversation_id":"default","metadata":metadata}}}),
        );
        assert_eq!(acknowledged["effects"][0]["type"], "scope");
        assert!(control.pending_default.is_none());
        let batch = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"scoped-default","status":"completed","output":[hosted_item()]}}}),
        );
        assert_eq!(batch["effects"][0]["type"], "approve_mcp");
    }
    #[test]
    fn exact_provider_response_rejection_defers_without_replaying_an_accepted_create() {
        let mut control = ready();
        let requested = command(
            &mut control,
            json!({"type":"create_response","response":{"instructions":"Scoped"}}),
        );
        let send = &requested["effects"][0];
        assert!(send["event"]["response"]["metadata"]["codex_response_id"].is_string());
        command(&mut control, json!({"type":"sent","id":send["id"]}));
        let rejected = command(
            &mut control,
            json!({"type":"provider","event":{"type":"error","error":{"event_id":send["event"]["event_id"],"code":"conversation_already_has_active_response"}}}),
        );
        assert_eq!(rejected["effects"][0]["type"], "event");
        assert!(control.pending_default.is_none());
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"raced-vad","metadata":null}}}),
        );
        let done = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"raced-vad","status":"completed","output":[]}}}),
        );
        assert_eq!(done["effects"][0]["event"]["type"], "response.create");
        assert_eq!(
            done["effects"][0]["event"]["response"]["instructions"],
            "Scoped"
        );
    }
    #[test]
    fn inert_history_input_and_preflight_preserve_live_claims_and_recheck_deletes() {
        let mut control = ready();
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"conversation.item.created","item":{"id":"safe","type":"message"}}}),
        );
        request(&mut control);
        batch(&mut control);
        let before = control.next_send;
        let rejected = command(
            &mut control,
            json!({"type":"validate_history","delete_ids":["safe","item-1"],"items":[]}),
        );
        assert_eq!(
            rejected["error"],
            "Conversation deletion conflicts with live tool ownership"
        );
        assert!(control.phase == Phase::Ready);
        assert_eq!(control.next_send, before);
        let invalid = command(
            &mut control,
            json!({"type":"validate_history","delete_ids":["safe"],"items":[item()]}),
        );
        assert_eq!(invalid["error"], "Input must be a conversation message");
        let message = json!({"type":"message","id":"inert","role":"user","content":[{"type":"input_text","text":"Historic"}]});
        assert_eq!(
            command(
                &mut control,
                json!({"type":"validate_history","delete_ids":["safe"],"items":[message]})
            )["effects"],
            json!([])
        );
        let inserted = command(
            &mut control,
            json!({"type":"input","item":message,"previous_item_id":null,"create_response":false}),
        );
        assert_eq!(inserted["effects"].as_array().unwrap().len(), 1);
        assert_eq!(inserted["effects"][0]["event"]["item"]["id"], "inert");
        assert!(
            inserted["effects"][0]["event"]
                .get("previous_item_id")
                .unwrap()
                .is_null()
        );
        assert_eq!(
            command(
                &mut control,
                json!({"type":"approve","call_id":"call-1","approved":true})
            )["effects"][0]["type"],
            "execute"
        );
        assert_eq!(
            command(&mut control, json!({"type":"delete","item_id":"item-1"}))["effects"][0]["type"],
            "history_rejected"
        );
    }
    #[test]
    fn duplicate_created_response_cannot_steal_pending_detached_source() {
        let mut control = ready();
        detached(&mut control, "first");
        let pending = command(
            &mut control,
            json!({"type":"create_response","response":{"conversation":"none","metadata":{"purpose":"test"}}}),
        );
        command(
            &mut control,
            json!({"type":"sent","id":pending["effects"][0]["id"]}),
        );
        let duplicate = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"first","conversation_id":null,"metadata":{"purpose":"test"}}}}),
        );
        assert_eq!(duplicate["effects"].as_array().unwrap().len(), 1);
        assert_eq!(duplicate["effects"][0]["type"], "event");
        assert!(control.pending_detached.is_some());
        let next = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"second","conversation_id":null,"metadata":{"purpose":"test"}}}}),
        );
        assert_eq!(next["effects"][0]["type"], "scope");
    }
    #[test]
    fn duplicate_default_created_does_not_replace_a_live_scope_snapshot() {
        let mut control = ready();
        request(&mut control);
        let duplicate = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"response-1","metadata":{"changed":"provider"}}}}),
        );
        assert_eq!(duplicate["effects"].as_array().unwrap().len(), 1);
        assert_eq!(duplicate["effects"][0]["type"], "event");
        assert_eq!(batch(&mut control)["effects"][0]["type"], "approve");
    }
    #[test]
    fn cancelling_unacknowledged_default_scope_does_not_cancel_unrelated_vad_or_retry() {
        for rejected in [false, true] {
            let mut control = ready();
            let requested = command(
                &mut control,
                json!({"type":"create_response","response":{"instructions":"Scoped"}}),
            );
            let send = &requested["effects"][0];
            command(&mut control, json!({"type":"sent","id":send["id"]}));
            assert_eq!(
                command(&mut control, json!({"type":"cancel"}))["effects"],
                json!([])
            );
            let vad = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":{"id":"unrelated-vad","metadata":null}}}),
            );
            assert_eq!(vad["effects"][0]["type"], "scope");
            assert!(
                !vad["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|effect| effect["event"]["type"] == "response.cancel")
            );
            if rejected {
                command(
                    &mut control,
                    json!({"type":"provider","event":{"type":"error","error":{"event_id":send["event"]["event_id"],"code":"conversation_already_has_active_response"}}}),
                );
            }
            let done = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"unrelated-vad","status":"completed","output":[]}}}),
            );
            assert!(
                !done["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|effect| effect["event"]["type"] == "response.create")
            );
            if !rejected {
                let cancelled = command(
                    &mut control,
                    json!({"type":"provider","event":{"type":"response.created","response":{"id":"cancelled-scope","metadata":send["event"]["response"]["metadata"]}}}),
                );
                assert_eq!(
                    cancelled["effects"][0]["event"],
                    json!({"type":"response.cancel","response_id":"cancelled-scope","event_id":"cancel_1"})
                );
                assert!(control.pending_default.is_none());
            } else {
                assert!(control.pending_response.is_none());
            }
        }
    }
    #[test]
    fn metadata_character_limits_preserve_valid_unicode_values() {
        let mut control = ready();
        let metadata = json!({"海".repeat(64):"豚".repeat(512)});
        let requested = command(
            &mut control,
            json!({"type":"create_response","response":{"conversation":"none","metadata":metadata}}),
        );
        assert_eq!(
            requested["effects"][0]["event"]["response"]["metadata"],
            metadata
        );
        let mut invalid = ready();
        assert_eq!(
            command(
                &mut invalid,
                json!({"type":"create_response","response":{"conversation":"none","metadata":{"key":"豚".repeat(513)}}})
            )["error"],
            "Invalid or reserved response metadata"
        );
    }
    #[test]
    fn cancel_preflight_preserves_unicode_target_and_counter_without_admission() {
        let mut control = ready();
        for index in 1..=9 {
            let id = format!("old-{index}");
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":{"id":id}}}),
            );
            let cancelled = command(&mut control, json!({"type":"cancel"}));
            assert_eq!(
                cancelled["effects"][0]["event"]["event_id"],
                format!("cancel_{index}")
            );
            command(
                &mut control,
                json!({"type":"sent","id":cancelled["effects"][0]["id"]}),
            );
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":id,"status":"cancelled","output":[]}}}),
            );
        }
        let id = "response-海🦈\"\\\n";
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":id}}}),
        );
        let event = json!({"type":"response.cancel","response_id":id,"event_id":"cancel_10"});
        for _ in 0..3 {
            assert_eq!(
                command(&mut control, json!({"type":"validate_cancel"}))["effects"],
                json!([{"type":"preflight","event":event,"immediate":true}])
            );
        }
        // Unconsumed previews, including host-rejected capacity admissions.
        assert_eq!(
            command(&mut control, json!({"type":"cancel"}))["effects"][0]["event"],
            event
        );
    }

    #[test]
    fn cancel_preflight_preserves_idle_deferred_and_invalid_owner_behavior() {
        let mut idle = ready();
        assert_eq!(
            command(&mut idle, json!({"type":"validate_cancel"}))["effects"],
            json!([])
        );
        assert_eq!(
            command(&mut idle, json!({"type":"cancel"}))["effects"],
            json!([])
        );
        let mut deferred = ready();
        let create = command(&mut deferred, json!({"type":"create_response"}));
        command(
            &mut deferred,
            json!({"type":"sent","id":create["effects"][0]["id"]}),
        );
        assert_eq!(
            command(&mut deferred, json!({"type":"validate_cancel"}))["effects"],
            json!([])
        );
        command(&mut deferred, json!({"type":"cancel"}));
        let created = command(
            &mut deferred,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"late-created"}}}),
        );
        assert!(created["effects"].as_array().unwrap().iter().any(|effect| effect["event"] == json!({"type":"response.cancel","response_id":"late-created","event_id":"cancel_1"})));
        let mut invalid = ready();
        assert_eq!(
            command(
                &mut invalid,
                json!({"type":"validate_cancel","response_id":"foreign"})
            )["effects"],
            json!([])
        );
        assert_eq!(
            command(
                &mut invalid,
                json!({"type":"cancel","response_id":"foreign"})
            )["error"],
            "Unknown response cancellation identity"
        );
        assert!(
            command(&mut invalid, json!({"type":"commit_audio"}))
                .get("error")
                .is_some()
        );
        let mut unopened = Control::default();
        assert_eq!(
            command(&mut unopened, json!({"type":"validate_cancel"}))["effects"],
            json!([])
        );
        assert_eq!(
            command(&mut unopened, json!({"type":"cancel"}))["error"],
            "Realtime configuration is not accepted"
        );
    }

    #[test]
    fn detached_cancel_preflight_preserves_sibling_and_exact_target() {
        let mut control = ready();
        request(&mut control);
        detached(&mut control, "detached-海🦈");
        let event =
            json!({"type":"response.cancel","response_id":"detached-海🦈","event_id":"cancel_1"});
        assert_eq!(
            command(
                &mut control,
                json!({"type":"validate_cancel","response_id":"detached-海🦈"})
            )["effects"],
            json!([{"type":"preflight","event":event,"immediate":true}])
        );
        let cancelled = command(
            &mut control,
            json!({"type":"cancel","response_id":"detached-海🦈"}),
        );
        assert!(
            cancelled["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|effect| effect["event"] == event)
        );
        assert_eq!(
            command(&mut control, json!({"type":"cancel"}))["effects"][0]["event"],
            json!({"type":"response.cancel","response_id":"response-1","event_id":"cancel_2"})
        );
    }

    #[test]
    fn full_native_queue_previews_do_not_consume_the_cancellation_owner() {
        let mut control = ready();
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"busy-response"}}}),
        );
        let mut receipts = Vec::new();
        for _ in 0..MAX_CALLS {
            let append = command(&mut control, json!({"type":"audio","audio":"AAAA"}));
            receipts.push(append["effects"][0]["id"].clone());
        }
        let event =
            json!({"type":"response.cancel","response_id":"busy-response","event_id":"cancel_1"});
        for _ in 0..3 {
            assert_eq!(
                command(&mut control, json!({"type":"validate_cancel"}))["effects"],
                json!([{"type":"preflight","event":event,"immediate":true}])
            );
        }
        command(&mut control, json!({"type":"sent","id":receipts[0]}));
        assert_eq!(
            command(&mut control, json!({"type":"cancel"}))["effects"][0]["event"],
            event
        );
    }

    #[test]
    fn response_preflight_matches_actual_default_metadata_and_detached_frames() {
        for response in [
            None,
            Some(json!({"instructions":"海🦈\"\\\n"})),
            Some(json!({"instructions":"Explicit","metadata":{"tag":"kept"}})),
            Some(json!({"conversation":"none","instructions":"Detached"})),
            Some(json!({"conversation":"auto","metadata":{}})),
        ] {
            let mut control = ready();
            let expected = match &response {
                None => json!({"type":"response.create"}),
                Some(value) if value["conversation"] == "none" => {
                    json!({"type":"response.create","response":value})
                }
                Some(value) if value.get("instructions").is_some() => {
                    let mut value = value.clone();
                    if value.get("metadata").is_none() {
                        value["metadata"] = json!({"codex_response_id":"portable-2"});
                    }
                    json!({"type":"response.create","event_id":"portable-2","response":value})
                }
                Some(value) => json!({"type":"response.create","response":value}),
            };
            for _ in 0..2 {
                assert_eq!(
                    command(
                        &mut control,
                        json!({"type":"validate_response","response":response})
                    )["effects"],
                    json!([{"type":"preflight","event":expected,"immediate":true}])
                );
            }
            assert_eq!(
                command(
                    &mut control,
                    json!({"type":"create_response","response":response})
                )["effects"][0]["event"],
                expected
            );
        }
    }

    #[test]
    fn response_preflight_returns_numeric_schema_values_instead_of_rust_byte_estimates() {
        let mut control = Control::default();
        let start = command(
            &mut control,
            json!({"type":"start","config":{"model":"test-realtime","instructions":"Help.","tools":[{"name":"numeric","description":"Numeric schema","needs_approval":false,"parameters":{"type":"object","properties":{"value":{"type":"number","maximum":0.000001}}}}]}}),
        );
        command(
            &mut control,
            json!({"type":"sent","id":start["effects"][0]["id"]}),
        );
        let session = start["effects"][0]["event"]["session"].clone();
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"session.updated","session":session}}),
        );
        let response = json!({"tools":session["tools"]});
        let preview = command(
            &mut control,
            json!({"type":"validate_response","response":response}),
        );
        assert_eq!(preview["effects"][0]["type"], "preflight");
        assert_eq!(
            preview["effects"][0]["event"]["response"]["tools"][0]["parameters"]["properties"]["value"]
                ["maximum"],
            json!(0.000001)
        );
        assert!(preview["effects"][0].get("bytes").is_none());
        let actual = command(
            &mut control,
            json!({"type":"create_response","response":response}),
        );
        assert_eq!(
            actual["effects"][0]["event"],
            preview["effects"][0]["event"]
        );
    }

    #[test]
    fn response_preflight_reserves_native_counter_width_for_coalesced_wire() {
        for metadata in [None, Some(json!({"tag":"kept"}))] {
            let mut control = ready();
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":{"id":"active"}}}),
            );
            let mut response = json!({"instructions":"Next response"});
            if let Some(value) = &metadata {
                response["metadata"] = value.clone();
            }
            let preview = command(
                &mut control,
                json!({"type":"validate_response","response":response}),
            );
            assert_eq!(preview["effects"][0]["immediate"], false);
            let token = format!("portable-{}", u64::MAX);
            assert_eq!(preview["effects"][0]["event"]["event_id"], token);
            assert_eq!(
                preview["effects"][0]["event"]["response"]["metadata"],
                metadata.unwrap_or_else(|| json!({"codex_response_id":token}))
            );
            assert_eq!(
                command(
                    &mut control,
                    json!({"type":"create_response","response":response})
                )["effects"],
                json!([])
            );
            // Later native sends between coalescing and response completion.
            let append = command(&mut control, json!({"type":"audio","audio":"AAAA"}));
            command(
                &mut control,
                json!({"type":"sent","id":append["effects"][0]["id"]}),
            );
            let completed = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"active","status":"completed","output":[]}}}),
            );
            let event = completed["effects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|effect| effect["event"]["type"] == "response.create")
                .unwrap();
            assert_eq!(event["event"]["event_id"], "portable-3");
        }
        let mut invalid = ready();
        assert_eq!(
            command(
                &mut invalid,
                json!({"type":"validate_response","response":[]})
            )["effects"],
            json!([])
        );
        assert_eq!(
            command(
                &mut invalid,
                json!({"type":"create_response","response":[]})
            )["error"],
            "Response options must be an object"
        );
    }
    #[test]
    fn only_issued_exact_canonical_cancel_errors_leave_the_owner_live() {
        for error in [
            json!({"type":"invalid_request_error","event_id":"cancel_1"}),
            json!({"type":"invalid_request_error","event_id":"cancel_0"}),
            json!({"type":"invalid_request_error","event_id":"cancel_01"}),
            json!({"type":"invalid_request_error","event_id":"cancel_+1"}),
            json!({"type":"invalid_request_error","event_id":"cancel_2"}),
            json!({"type":"invalid_request_error","event_id":"cancel_18446744073709551616"}),
            json!({"type":"server_error","event_id":"cancel_1"}),
            json!({"type":"invalid_request_error"}),
        ] {
            let mut control = ready();
            request(&mut control);
            let cancel = command(&mut control, json!({"type":"cancel"}));
            command(
                &mut control,
                json!({"type":"sent","id":cancel["effects"][0]["id"]}),
            );
            let benign = error == json!({"type":"invalid_request_error","event_id":"cancel_1"});
            let result = command(
                &mut control,
                json!({"type":"provider","event":{"type":"error","event_id":"cancel_1","error":error}}),
            );
            assert_eq!(result.get("error").is_none(), benign, "{result}");
            assert_eq!(
                command(&mut control, json!({"type":"commit_audio"}))
                    .get("error")
                    .is_none(),
                benign
            );
        }
        let mut unissued = ready();
        assert!(command(&mut unissued, json!({"type":"provider","event":{"type":"error","error":{"type":"invalid_request_error","event_id":"cancel_1"}}})).get("error").is_some());
    }
    #[test]
    fn partial_function_arguments_remain_inert_until_successful_terminal_admission() {
        for complete in [false, true] {
            let mut control = ready();
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":{"id":"partial-response"}}}),
            );
            let partial = json!({"type":"function_call","id":"partial-item","call_id":"partial-call","name":"lookup","arguments":"{\"value\":"});
            let discovered = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"partial-response","item":partial}}),
            );
            assert!(discovered.get("error").is_none(), "{discovered}");
            assert!(
                !discovered["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|effect| matches!(effect["type"].as_str(), Some("approve" | "execute")))
            );
            if !complete {
                let cancelled = command(&mut control, json!({"type":"cancel"}));
                command(
                    &mut control,
                    json!({"type":"sent","id":cancelled["effects"][0]["id"]}),
                );
            }
            let terminal = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"partial-response","status":if complete {"completed"} else {"cancelled"},"output":[partial]}}}),
            );
            assert_eq!(terminal.get("error").is_some(), complete, "{terminal}");
            if !complete {
                assert!(
                    !terminal["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|effect| matches!(
                            effect["type"].as_str(),
                            Some("approve" | "execute")
                        ))
                );
                assert!(
                    command(&mut control, json!({"type":"commit_audio"}))
                        .get("error")
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn accepted_false_speech_interruption_preserves_explicit_cancel_authority() {
        for automatic in [false, true] {
            let mut control = Control::default();
            let start = command(
                &mut control,
                json!({"type":"start","config":{"model":"test-realtime","instructions":"Help.","settings":{"audio":{"input":{"turn_detection":{"type":"server_vad","interrupt_response":automatic}}}}}}),
            );
            command(
                &mut control,
                json!({"type":"sent","id":start["effects"][0]["id"]}),
            );
            let session = start["effects"][0]["event"]["session"].clone();
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"session.updated","session":session}}),
            );
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":{"id":"speech-response"}}}),
            );
            let speech = command(
                &mut control,
                json!({"type":"provider","event":{"type":"input_audio_buffer.speech_started"}}),
            );
            assert!(speech.get("error").is_none(), "{speech}");
            let cancels = speech["effects"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|effect| effect["event"]["type"] == "response.cancel")
                .count();
            assert_eq!(cancels, usize::from(automatic));
            if !automatic {
                assert_eq!(
                    command(&mut control, json!({"type":"cancel"}))["effects"][0]["event"],
                    json!({"type":"response.cancel","response_id":"speech-response","event_id":"cancel_1"})
                );
            }
        }
    }

    #[test]
    fn received_default_creation_fences_explicit_and_batch_continuation() {
        for continuation in [false, true] {
            let mut control = ready();
            let mut output_receipt = None;
            if continuation {
                request(&mut control);
                batch(&mut control);
                let published = command(
                    &mut control,
                    json!({"type":"approve","call_id":"call-1","approved":false}),
                );
                output_receipt = Some(published["effects"][0]["id"].clone());
            }
            let append = command(&mut control, json!({"type":"audio","audio":"AAAA"}));
            assert_eq!(
                command(
                    &mut control,
                    json!({"type":"provider","event":{"type":"response.created","response":{"id":"received-default"}}})
                )["effects"],
                json!([])
            );
            if let Some(id) = output_receipt {
                let sent = command(&mut control, json!({"type":"sent","id":id}));
                assert!(
                    !sent["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|effect| effect["event"]["type"] == "response.create")
                );
            } else {
                assert_eq!(
                    command(&mut control, json!({"type":"validate_response"}))["effects"][0]["immediate"],
                    false
                );
                assert_eq!(
                    command(&mut control, json!({"type":"create_response"}))["effects"],
                    json!([])
                );
            }
            let admitted = command(
                &mut control,
                json!({"type":"sent","id":append["effects"][0]["id"]}),
            );
            assert!(
                !admitted["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(
                        |effect| matches!(effect["type"].as_str(), Some("approve" | "execute"))
                            || effect["event"]["type"] == "response.create"
                    )
            );
            let completed = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"received-default","status":"completed","output":[]}}}),
            );
            assert_eq!(
                completed["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|effect| effect["event"]["type"] == "response.create")
                    .count(),
                1
            );
        }
        // Unowned detached creation has no default-response scheduling authority.
        let mut control = ready();
        command(&mut control, json!({"type":"audio","audio":"AAAA"}));
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"unowned-detached","conversation_id":null}}}),
        );
        let requested = command(&mut control, json!({"type":"create_response"}));
        assert_eq!(requested["effects"][0]["event"]["type"], "response.create");
    }
    #[test]
    fn healthy_cancel_sessions_outlive_the_retired_window_and_keep_issued_error_correlation() {
        let mut control = ready();
        for index in 1..=300 {
            let id = format!("response-{index}");
            let created = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":{"id":id}}}),
            );
            assert!(created.get("error").is_none(), "{created}");
            let cancelled = command(&mut control, json!({"type":"cancel"}));
            assert_eq!(
                cancelled["effects"][0]["event"]["event_id"],
                format!("cancel_{index}")
            );
            command(
                &mut control,
                json!({"type":"sent","id":cancelled["effects"][0]["id"]}),
            );
            let terminal = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":id,"status":"cancelled","output":[]}}}),
            );
            assert!(terminal.get("error").is_none(), "{terminal}");
        }
        assert_eq!(control.retired_responses.len(), MAX_CALLS);
        assert_eq!(control.retired_response_order.len(), MAX_CALLS);
        assert!(!control.retired_responses.contains("response-1"));
        assert!(command(&mut control, json!({"type":"provider","event":{"type":"error","error":{"type":"invalid_request_error","event_id":"cancel_1"}}})).get("error").is_none());
        assert!(
            command(&mut control, json!({"type":"commit_audio"}))
                .get("error")
                .is_none()
        );
    }

    #[test]
    fn recent_retired_eviction_preserves_the_live_cancellation_receipt() {
        let mut control = ready();
        request(&mut control);
        let cancelled = command(&mut control, json!({"type":"cancel"}));
        command(
            &mut control,
            json!({"type":"sent","id":cancelled["effects"][0]["id"]}),
        );
        for index in 0..300 {
            control.remember_retired_response(format!("terminal-{index}"));
        }
        assert_eq!(control.retired_responses.len(), MAX_CALLS);
        assert!(control.retired_responses.contains("response-1"));
        let terminal = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"response-1","status":"cancelled","output":[]}}}),
        );
        assert!(terminal.get("error").is_none(), "{terminal}");
        assert!(control.cancel_waiting.is_none());
    }

    #[test]
    fn healthy_completed_sessions_keep_a_bounded_recent_identity_window() {
        let mut control = ready();
        for index in 1..=300 {
            let id = format!("completed-{index}");
            assert!(command(&mut control, json!({"type":"provider","event":{"type":"response.created","response":{"id":id}}})).get("error").is_none());
            assert!(command(&mut control, json!({"type":"provider","event":{"type":"response.done","response":{"id":id,"status":"completed","output":[]}}})).get("error").is_none());
        }
        assert_eq!(control.completed_responses.len(), MAX_CALLS);
        assert_eq!(control.completed_response_order.len(), MAX_CALLS);
        assert!(!control.completed_responses.contains("completed-1"));
    }
    #[test]
    fn queued_default_cancel_targets_received_owner_without_grant_or_sticky_future_cancel() {
        for scoped in [false, true] {
            let mut control = ready();
            let send = if scoped {
                command(
                    &mut control,
                    json!({"type":"create_response","response":{"instructions":"Scoped"}}),
                )
            } else {
                command(&mut control, json!({"type":"audio","audio":"AAAA"}))
            };
            let mut response = json!({"id":"queued-owner"});
            if scoped {
                response["metadata"] = send["effects"][0]["event"]["response"]["metadata"].clone();
            }
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":response}}),
            );
            let preview = command(&mut control, json!({"type":"validate_cancel"}));
            assert_eq!(
                preview["effects"][0]["event"]["response_id"],
                "queued-owner"
            );
            let cancelled = command(&mut control, json!({"type":"cancel"}));
            let cancel = cancelled["effects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|effect| effect["type"] == "send")
                .unwrap();
            assert_eq!(cancel["event"], preview["effects"][0]["event"]);
            command(
                &mut control,
                json!({"type":"sent","id":send["effects"][0]["id"]}),
            );
            command(&mut control, json!({"type":"sent","id":cancel["id"]}));
            let item = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.output_item.done","response_id":"queued-owner","item":item()}}),
            );
            assert!(
                item["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|effect| effect["type"] != "execute" && effect["type"] != "approve")
            );
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"queued-owner","status":"cancelled","output":[]}}}),
            );
            let next = command(&mut control, json!({"type":"create_response"}));
            assert!(
                next["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|effect| effect["event"]["type"] == "response.create")
            );
        }
    }
    #[test]
    fn queued_cancel_uses_latest_received_owner_and_idle_cancel_stays_empty() {
        let mut control = ready();
        assert_eq!(
            command(&mut control, json!({"type":"cancel"}))["effects"],
            json!([])
        );
        command(&mut control, json!({"type":"audio","audio":"AAAA"}));
        for event in [
            json!({"type":"response.created","response":{"id":"older"}}),
            json!({"type":"response.done","response":{"id":"older","status":"completed","output":[]}}),
            json!({"type":"response.created","response":{"id":"newest"}}),
        ] {
            command(&mut control, json!({"type":"provider","event":event}));
        }
        let result = command(
            &mut control,
            json!({"type":"cancel","response_id":"newest"}),
        );
        let send = result["effects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|effect| effect["type"] == "send")
            .unwrap();
        assert_eq!(send["event"]["response_id"], "newest");
    }
    #[test]
    fn cancel_fences_received_successful_terminal_before_tool_admission_without_a_wire_cancel() {
        for mode in ["audio", "bare", "scoped"] {
            for early_cancel in [false, true] {
                let mut control = ready();
                let audio = match mode {
                    "audio" => command(&mut control, json!({"type":"audio","audio":"AAAA"})),
                    "bare" => command(&mut control, json!({"type":"create_response"})),
                    _ => command(
                        &mut control,
                        json!({"type":"create_response","response":{"instructions":"Scoped"}}),
                    ),
                };
                if early_cancel {
                    command(&mut control, json!({"type":"cancel"}));
                }
                let mut response = json!({"id":"finished"});
                if mode == "scoped" {
                    response["metadata"] =
                        audio["effects"][0]["event"]["response"]["metadata"].clone();
                }
                for event in [
                    json!({"type":"response.created","response":response}),
                    json!({"type":"response.output_item.done","response_id":"finished","item":item()}),
                    json!({"type":"response.done","response":{"id":"finished","status":"completed","output":[item()]}}),
                ] {
                    assert!(
                        command(&mut control, json!({"type":"provider","event":event}))
                            .get("error")
                            .is_none()
                    );
                }
                assert_eq!(
                    command(&mut control, json!({"type":"validate_cancel"}))["effects"],
                    json!([])
                );
                let cancelled = command(&mut control, json!({"type":"cancel"}));
                assert!(
                    cancelled["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|effect| effect["type"] != "send")
                );
                let drained = command(
                    &mut control,
                    json!({"type":"sent","id":audio["effects"][0]["id"]}),
                );
                assert!(drained.get("error").is_none());
                assert!(
                    drained["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|effect| effect["type"] != "execute" && effect["type"] != "approve")
                );
                let next = command(&mut control, json!({"type":"create_response"}));
                assert!(
                    next["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|effect| effect["event"]["type"] == "response.create")
                );
            }
        }
    }
    #[test]
    fn named_cancel_preserves_queued_predecessor_tool_admission() {
        for terminal_queued in [false, true] {
            for scoped in [false, true] {
                let mut control = ready();
                let created = if scoped {
                    let sent = command(
                        &mut control,
                        json!({"type":"create_response","response":{"instructions":"Scoped A"}}),
                    );
                    let event = sent["effects"][0]["event"]["response"].clone();
                    command(
                        &mut control,
                        json!({"type":"sent","id":sent["effects"][0]["id"]}),
                    );
                    let mut response = event;
                    response["id"] = json!("response-1");
                    response
                } else {
                    json!({"id":"response-1"})
                };
                command(
                    &mut control,
                    json!({"type":"provider","event":{"type":"response.created","response":created}}),
                );
                let audio = command(&mut control, json!({"type":"audio","audio":"AAAA"}));
                batch(&mut control);
                command(
                    &mut control,
                    json!({"type":"provider","event":{"type":"response.created","response":{"id":"B"}}}),
                );
                if terminal_queued {
                    let mut other = item();
                    other["id"] = json!("item-B");
                    other["call_id"] = json!("call-B");
                    command(
                        &mut control,
                        json!({"type":"provider","event":{"type":"response.done","response":{"id":"B","status":"completed","output":[other]}}}),
                    );
                }
                let cancelled = command(&mut control, json!({"type":"cancel","response_id":"B"}));
                assert!(cancelled["error"].is_null(), "{cancelled}");
                assert!(
                    !cancelled["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["type"] == "retire" && e["response_id"] == "response-1")
                );
                let drained = command(
                    &mut control,
                    json!({"type":"sent","id":audio["effects"][0]["id"]}),
                );
                // Cancellation itself also has a physical receipt before provider input drains.
                let cancel_send = cancelled["effects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["type"] == "send");
                assert_eq!(cancel_send.is_none(), terminal_queued);
                let admitted = if let Some(cancel_send) = cancel_send {
                    command(&mut control, json!({"type":"sent","id":cancel_send["id"]}))
                } else {
                    drained.clone()
                };
                assert!(
                    drained["error"].is_null() && admitted["error"].is_null(),
                    "{drained} {admitted}"
                );
                assert!(
                    admitted["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["type"] == "approve" && e["call_id"] == "call-1"),
                    "{admitted}"
                );
                let approved = command(
                    &mut control,
                    json!({"type":"approve","call_id":"call-1","approved":true}),
                );
                assert!(
                    approved["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["type"] == "execute")
                );
            }
        }
    }
    #[test]
    fn named_pending_cancellation_releases_only_its_own_create_state() {
        for predecessor_completed in [false, true] {
            for early_cancel in [false, true] {
                for scoped in [false, true] {
                    let mut control = ready();
                    if predecessor_completed {
                        command(
                            &mut control,
                            json!({"type":"provider","event":{"type":"response.created","response":{"id":"A"}}}),
                        );
                        command(
                            &mut control,
                            json!({"type":"provider","event":{"type":"response.done","response":{"id":"A","status":"completed","output":[]}}}),
                        );
                    }
                    let created = command(
                        &mut control,
                        if scoped {
                            json!({"type":"create_response","response":{"instructions":"B scoped"}})
                        } else {
                            json!({"type":"create_response"})
                        },
                    );
                    if early_cancel {
                        command(&mut control, json!({"type":"cancel"}));
                    }
                    let mut response = created["effects"][0]["event"]
                        .get("response")
                        .cloned()
                        .unwrap_or(json!({}));
                    response["id"] = json!("B");
                    command(
                        &mut control,
                        json!({"type":"provider","event":{"type":"response.created","response":response}}),
                    );
                    let cancelled =
                        command(&mut control, json!({"type":"cancel","response_id":"B"}));
                    command(
                        &mut control,
                        json!({"type":"sent","id":created["effects"][0]["id"]}),
                    );
                    let sent = cancelled["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|e| e["type"] == "send")
                        .unwrap();
                    command(&mut control, json!({"type":"sent","id":sent["id"]}));
                    response["status"] = json!("cancelled");
                    response["output"] = json!([]);
                    command(
                        &mut control,
                        json!({"type":"provider","event":{"type":"response.done","response":response}}),
                    );
                    let next = command(&mut control, json!({"type":"create_response"}));
                    assert!(next["error"].is_null(), "{next}");
                    assert_eq!(
                        next["effects"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(
                                |e| e["type"] == "send" && e["event"]["type"] == "response.create"
                            )
                            .count(),
                        1,
                        "{next}"
                    );
                }
            }
        }
    }
    #[test]
    fn named_vad_cancel_preserves_an_unmatched_pending_sdk_scope() {
        for predecessor_completed in [false, true] {
            let mut control = ready();
            if predecessor_completed {
                command(
                    &mut control,
                    json!({"type":"provider","event":{"type":"response.created","response":{"id":"A"}}}),
                );
                command(
                    &mut control,
                    json!({"type":"provider","event":{"type":"response.done","response":{"id":"A","status":"completed","output":[]}}}),
                );
            }
            let created = command(
                &mut control,
                json!({"type":"create_response","response":{"instructions":"C scoped"}}),
            );
            let mut source = created["effects"][0]["event"]["response"].clone();
            source["id"] = json!("C");
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":{"id":"B"}}}),
            );
            let cancelled = command(&mut control, json!({"type":"cancel","response_id":"B"}));
            assert!(control.pending_default.is_some());
            assert!(control.responses.active_default_response);
            command(
                &mut control,
                json!({"type":"sent","id":created["effects"][0]["id"]}),
            );
            let sent = cancelled["effects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["type"] == "send")
                .unwrap();
            command(&mut control, json!({"type":"sent","id":sent["id"]}));
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":{"id":"B","status":"cancelled","output":[]}}}),
            );
            let admitted = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":source}}),
            );
            assert!(admitted["error"].is_null(), "{admitted}");
            assert!(control.pending_default.is_none());
            assert_eq!(control.responses.sdk_response_id.as_deref(), Some("C"));
            source["status"] = json!("completed");
            source["output"] = json!([]);
            let completed = command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.done","response":source}}),
            );
            assert!(completed["error"].is_null(), "{completed}");
        }
    }
    #[test]
    fn named_vad_cancel_preserves_unmatched_unidentified_cancel_intent() {
        let mut control = ready();
        let created = command(
            &mut control,
            json!({"type":"create_response","response":{"instructions":"C scoped"}}),
        );
        let mut response = created["effects"][0]["event"]["response"].clone();
        response["id"] = json!("C");
        command(&mut control, json!({"type":"cancel"}));
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":{"id":"B"}}}),
        );
        let cancelled = command(&mut control, json!({"type":"cancel","response_id":"B"}));
        assert!(control.pending_default.is_some() && control.cancel_before_created);
        command(
            &mut control,
            json!({"type":"sent","id":created["effects"][0]["id"]}),
        );
        let sent = cancelled["effects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "send")
            .unwrap();
        command(&mut control, json!({"type":"sent","id":sent["id"]}));
        command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.done","response":{"id":"B","status":"cancelled","output":[]}}}),
        );
        let late = command(
            &mut control,
            json!({"type":"provider","event":{"type":"response.created","response":response}}),
        );
        assert!(late["error"].is_null(), "{late}");
        assert!(
            late["effects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "send"
                    && e["event"]["type"] == "response.cancel"
                    && e["event"]["response_id"] == "C"),
            "{late}"
        );
    }
    #[test]
    fn queued_completed_default_identity_can_be_fenced_without_wire_cancel() {
        for named in [false, true] {
            for scoped in [false, true] {
                for detached_sibling in [false, true] {
                    let mut control = ready();
                    if detached_sibling {
                        command(
                            &mut control,
                            json!({"type":"provider","event":{"type":"response.created","response":{"id":"D","conversation_id":null}}}),
                        );
                    }
                    let created = command(
                        &mut control,
                        if scoped {
                            json!({"type":"create_response","response":{"instructions":"B scoped"}})
                        } else {
                            json!({"type":"create_response"})
                        },
                    );
                    let mut response = created["effects"][0]["event"]
                        .get("response")
                        .cloned()
                        .unwrap_or(json!({}));
                    response["id"] = json!("B");
                    command(
                        &mut control,
                        json!({"type":"provider","event":{"type":"response.created","response":response}}),
                    );
                    response["status"] = json!("completed");
                    response["output"] = json!([item()]);
                    command(
                        &mut control,
                        json!({"type":"provider","event":{"type":"response.done","response":response}}),
                    );
                    let preview = command(
                        &mut control,
                        if named {
                            json!({"type":"validate_cancel","response_id":"B"})
                        } else {
                            json!({"type":"validate_cancel"})
                        },
                    );
                    assert!(
                        preview["error"].is_null(),
                        "named={named} scoped={scoped} detached={detached_sibling}: {preview}"
                    );
                    assert_eq!(preview["effects"], json!([]));
                    let cancelled = command(
                        &mut control,
                        if named {
                            json!({"type":"cancel","response_id":"B"})
                        } else {
                            json!({"type":"cancel"})
                        },
                    );
                    assert!(cancelled["error"].is_null(), "{cancelled}");
                    assert!(
                        !cancelled["effects"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|e| e["type"] == "send")
                    );
                    let drained = command(
                        &mut control,
                        json!({"type":"sent","id":created["effects"][0]["id"]}),
                    );
                    assert!(drained["error"].is_null(), "{drained}");
                    assert!(
                        !drained["effects"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|e| e["type"] == "approve" || e["type"] == "execute")
                    );
                    let next = command(&mut control, json!({"type":"create_response"}));
                    assert!(next["effects"].as_array().unwrap().iter().any(|e|e["type"] == "send" && e["event"]["type"] == "response.create"), "{next}");
                    if detached_sibling {
                        assert!(control.detached["D"].active);
                    }
                }
            }
        }
    }
    fn webrtc_ready() -> Control {
        let mut control = Control::default();
        let started = command(
            &mut control,
            json!({"type":"start","clear_output_audio_on_interrupt":true,"config":{"model":"test-realtime","instructions":"Help.","tools":[tool()]}}),
        );
        assert!(started.get("error").is_none(), "{started}");
        command(&mut control, json!({"type":"sent","id":1}));
        accepted(&mut control);
        control
    }
    #[test]
    fn webrtc_cancel_preview_matches_active_and_idle_packets_without_mutation() {
        for named in [false, true] {
            let mut control = webrtc_ready();
            command(
                &mut control,
                json!({"type":"provider","event":{"type":"response.created","response":{"id":"default-a"}}}),
            );
            let input = if named {
                json!({"type":"validate_cancel","response_id":"default-a"})
            } else {
                json!({"type":"validate_cancel"})
            };
            let before = control.next_cancel;
            let preview = command(&mut control, input.clone());
            assert_eq!(preview, command(&mut control, input));
            assert_eq!(control.next_cancel, before);
            let events = preview["effects"]
                .as_array()
                .unwrap()
                .iter()
                .map(|effect| effect["event"].clone())
                .collect::<Vec<_>>();
            assert_eq!(events.len(), 2);
            assert_eq!(events[0]["type"], "response.cancel");
            assert_eq!(events[1], json!({"type":"output_audio_buffer.clear"}));
            let cancel = if named {
                json!({"type":"cancel","response_id":"default-a"})
            } else {
                json!({"type":"cancel"})
            };
            let result = command(&mut control, cancel);
            let sent = result["effects"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|effect| effect["type"] == "send")
                .map(|effect| effect["event"].clone())
                .collect::<Vec<_>>();
            assert_eq!(sent, events);
        }
        let mut idle = webrtc_ready();
        let preview = command(&mut idle, json!({"type":"validate_cancel"}));
        assert_eq!(
            preview["effects"],
            json!([{"type":"preflight","event":{"type":"output_audio_buffer.clear"},"immediate":true}])
        );
        let cancelled = command(&mut idle, json!({"type":"cancel"}));
        assert_eq!(
            cancelled["effects"][0]["event"],
            json!({"type":"output_audio_buffer.clear"})
        );
        assert_eq!(idle.next_cancel, 0);
    }
    #[test]
    fn malformed_webrtc_capability_retires_without_sending() {
        for invalid in [json!("true"), json!(1), Value::Null] {
            let mut control = Control::default();
            let result = command(
                &mut control,
                json!({"type":"start","clear_output_audio_on_interrupt":invalid,"config":{"model":"test-realtime","instructions":"Help.","tools":[tool()]}}),
            );
            assert!(result.get("error").is_some(), "{result}");
            assert!(control.phase == Phase::Closed);
            assert!(control.pending_send.is_empty());
        }
    }
}

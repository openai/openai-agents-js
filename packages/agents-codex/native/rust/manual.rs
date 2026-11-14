use super::recovered_completion::{FreshTerminalReceipts, ToolOutcomes};
use super::*;
use anyhow::Context;
use codex_history::{ResponseItemEnvelope, RolloutItem};
use codex_protocol::protocol::{
    Event, EventMsg, ThreadSettingsOverrides, ThreadSettingsSnapshot, TurnContextItem,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManualSlot {
    #[serde(default)]
    configured: bool,
    name: String,
    namespace: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManualCall {
    call_id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    arguments: String,
    // Only current function, application Shell, or editor declarations can own a grant.
    // Completed custom calls retain their separate native history marker.
    #[serde(default, skip_serializing_if = "is_false")]
    custom: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    shell: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    patch: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    approval_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effective_arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    continuation: Option<Value>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn manual_request(key: &PendingKey, call: &ManualCall, model: Option<&str>) -> Result<Value> {
    let arguments: Value = serde_json::from_str(&call.arguments)?;
    let mut request = json!({"id":call.call_id,"msg":{"type":"dynamic_tool_call_request",
        "turnId":key.turn,"callId":call.call_id,"namespace":call.namespace,
        "tool":call.name,"arguments":arguments,"_sdk_python_tool":key.reply,
        "_sdk_code_origin":null,"_sdk_model":model, "_sdk_restored_approval":true, "_sdk_approval_required":call.approval_required}});
    if !call.custom && !call.shell && !call.patch {
        request["msg"]["_sdk_raw_function_arguments"] = json!(call.arguments);
    }
    if let Some(arguments) = &call.effective_arguments {
        request["msg"]["_sdk_effective_arguments"] = serde_json::from_str(arguments)?;
    }
    Ok(request)
}

/// Canonical results retain their metadata through suspension and reinjection.
#[derive(Clone)]
struct CanonicalResult(ResponseItemEnvelope);

impl Serialize for CanonicalResult {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        RolloutItem::ResponseItem(self.0.clone()).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CanonicalResult {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let row = RolloutItem::deserialize(deserializer)?;
        let RolloutItem::ResponseItem(envelope) = row else {
            return Err(serde::de::Error::custom(
                "manual result must be a response_item",
            ));
        };
        if !matches!(
            envelope.item,
            ResponseItem::FunctionCallOutput { .. }
                | ResponseItem::CustomToolCallOutput { .. }
                | ResponseItem::ShellCallOutput { .. }
                | ResponseItem::ApplyPatchCallOutput { .. }
        ) {
            return Err(serde::de::Error::custom(
                "manual result must be a tool output",
            ));
        }
        Ok(Self(envelope))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum Receipt {
    Text(String),
    Canonical(CanonicalResult),
    Native(ResponseItem),
    // A successful JS send proves its result body, but Core has not yet
    // assigned the history item ID or creation metadata. Never put this
    // transient receipt in a saved frame.
    #[serde(skip)]
    Provisional(ResponseItem),
}

impl Receipt {
    fn item(&self, call: &ManualCall, turn: &str) -> Result<ResponseItem> {
        let item = match self {
            Self::Text(text) => {
                ensure!(
                    !call.custom && !call.shell && !call.patch,
                    "legacy text cannot represent a typed call output"
                );
                let key = PendingKey {
                    reply: ReplyKey {
                        thread: String::new(),
                        generation: 0,
                        slot: 0,
                        instance: None,
                        manual_grant: None,
                    },
                    turn: turn.to_owned(),
                    call: call.call_id.clone(),
                };
                PythonOutput(DynamicToolResponse {
                    success: true,
                    content_items: vec![codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputText { text: text.clone() }],
                }).receipt(&key)
            }
            Self::Native(item) => item.clone(),
            Self::Canonical(item) => item.0.item.clone(),
            Self::Provisional(_) => {
                anyhow::bail!("manual checkpoint result has not reached native history")
            }
        };
        ensure!(
            match (&item, call.custom, call.shell, call.patch) {
                (
                    ResponseItem::FunctionCallOutput {
                        call_id: Some(id), ..
                    },
                    false,
                    false,
                    false,
                )
                | (ResponseItem::CustomToolCallOutput { call_id: id, .. }, true, false, false) =>
                    *id == call.call_id,
                (
                    ResponseItem::ShellCallOutput {
                        provider_fields, ..
                    },
                    false,
                    true,
                    false,
                ) => {
                    let mut output = json!({"output": provider_fields.get("output")});
                    if let Some(limit) = provider_fields.get("max_output_length") {
                        output["max_output_length"] = limit.clone();
                    }
                    let original: ResponseItem = serde_json::from_str(&call.arguments)?;
                    let expected = crate::local_reconciliation::shell_receipt(&original,
                        DynamicToolResponse { success: true, content_items: vec![
                            codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputText {
                                text: serde_json::to_string(&output)?
                            }] }, turn)?;
                    provider_fields.get("call_id").and_then(Value::as_str)
                        == Some(call.call_id.as_str())
                        && crate::local_reconciliation::same_output_payload(&expected, &item)
                }
                (ResponseItem::ApplyPatchCallOutput { call_id, .. }, false, false, true) => {
                    *call_id == call.call_id
                }
                _ => false,
            },
            "manual result does not match original call kind and ID"
        );
        Ok(item)
    }

    fn from_held_terminal(
        &self,
        call: &ManualCall,
        turn: &str,
        held: &ResponseItemEnvelope,
        succeeded: bool,
    ) -> Result<Self> {
        let Self::Provisional(ResponseItem::FunctionCallOutput {
            call_id: Some(sent_id),
            output: sent,
            ..
        }) = self
        else {
            anyhow::bail!("Held promotion requires a live provisional function reply");
        };
        let ResponseItem::FunctionCallOutput {
            call_id: Some(held_id),
            output: written,
            name,
            namespace,
            ..
        } = &held.item
        else {
            anyhow::bail!("Held terminal result is not a function reply");
        };
        // The caller has checked the native turn-store owner. Core has not yet
        // persisted this envelope, so it may lack ordinary history turn metadata.
        ensure!(
            !call.custom
                && !call.shell
                && !call.patch
                && sent_id == &call.call_id
                && held_id == sent_id
                && held.item.turn_id().is_none_or(|value| value == turn)
                && name.is_none()
                && namespace.is_none()
                && sent.body == written.body
                && sent.success == Some(succeeded)
                && written.success.is_none_or(|value| value == succeeded),
            "Held terminal result changed during capture"
        );
        Ok(Self::Canonical(CanonicalResult(held.clone())))
    }
    fn envelope(&self, call: &ManualCall, turn: &str) -> Result<ResponseItemEnvelope> {
        self.item(call, turn)?;
        match self {
            Self::Canonical(envelope) => Ok(envelope.0.clone()),
            _ => Ok(self.item(call, turn)?.into()),
        }
    }

    fn matches(&self, written: &Self, call: &ManualCall, turn: &str) -> Result<bool> {
        if let (Self::Canonical(left), Self::Canonical(right)) = (self, written) {
            self.item(call, turn)?;
            written.item(call, turn)?;
            return Ok(serde_json::to_value(left)? == serde_json::to_value(right)?);
        }
        if let Self::Canonical(left) = self {
            return Self::Native(left.0.item.clone()).matches(written, call, turn);
        }
        if let Self::Canonical(right) = written {
            return self.matches(&Self::Native(right.0.item.clone()), call, turn);
        }

        if call.shell || call.patch {
            let left = match self {
                Self::Provisional(item) => Self::Native(item.clone()).item(call, turn)?,
                _ => self.item(call, turn)?,
            };
            let right = written.item(call, turn)?;
            return Ok(crate::local_reconciliation::same_acknowledged_output(
                &left, &right,
            ));
        }
        match (self, written) {
            // Legacy text frames predate native metadata and success storage.
            (Self::Text(left), Self::Text(right)) => Ok(left == right),
            (Self::Text(text), Self::Native(ResponseItem::FunctionCallOutput { output, .. }))
                if output.success != Some(false) =>
            {
                let only_text = match &output.body {
                    FunctionCallOutputBody::Text(_) => true,
                    FunctionCallOutputBody::ContentItems(items) => items.iter().all(|item| {
                        matches!(item, FunctionCallOutputContentItem::InputText { .. })
                    }),
                };
                Ok(only_text && output.body.to_text().as_ref() == Some(text))
            }
            (
                Self::Provisional(ResponseItem::FunctionCallOutput {
                    call_id: Some(sent_id),
                    output: sent,
                    ..
                }),
                Self::Native(
                    item @ ResponseItem::FunctionCallOutput {
                        call_id: Some(written_id),
                        name,
                        namespace,
                        output: written,
                        ..
                    },
                ),
            ) => Ok(!call.custom
                && sent_id == &call.call_id
                && written_id == sent_id
                && item.turn_id() == Some(turn)
                && name.is_none()
                && namespace.is_none()
                && sent.body == written.body
                // Native history's JSON output payload omits success. Check
                // it when retained in memory, but never infer it from text.
                && written.success.is_none_or(|success| sent.success == Some(success))),
            _ => Ok(serde_json::to_value(self.item(call, turn)?)?
                == serde_json::to_value(written.item(call, turn)?)?),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Continuation {
    #[serde(default, rename = "_sdk_lifecycle_start", skip_serializing_if = "Option::is_none")]
    pub(crate) lifecycle_start_ack: Option<codex_extension_api::AgentLifecycleStartAcknowledgment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) pending_input: Vec<Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) staged_retry: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_settings_override:
        Option<codex_protocol::model_request_controls::RunModelSettingsOverride>,
    pub(crate) turn_id: String,
    pub(crate) reply_order: Vec<String>,
    accepted_replies: HashMap<String, Receipt>,
    pending_manual: Vec<ManualCall>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pending_mcp: Vec<codex_core::McpApprovalCheckpointData>,
    #[serde(skip)]
    pub(crate) native_mcp: Option<codex_core::NativeMcpRecovery>,
    #[serde(skip)]
    native_mcp_source: Option<Arc<crate::native_interception::ProfileMcpSource>>,
    #[serde(skip)]
    generation: Option<Arc<Generation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_outcomes: Option<ToolOutcomes>,
    #[serde(skip)]
    fresh: Option<FreshTerminalReceipts>,
    #[serde(skip)]
    batch_completion: bool,
}

impl Continuation {
    fn record_fresh_completion(&mut self, key: &PendingKey, success: bool) {
        if let Some(generation) = &self.generation
            && (self.batch_completion
                || (success && generation.terminal_slots.contains(&key.reply.slot)))
        {
            FreshTerminalReceipts::record(&mut self.fresh, generation.clone(), key);
        }
    }

    pub(crate) fn staged_items(&self) -> Result<Vec<ResponseItem>> {
        let items = self
            .pending_input
            .iter()
            .cloned()
            .map(serde_json::from_value::<ResponseItem>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for item in &items {
            crate::checkpoint::validate_external_response_item(item)?;
        }
        ensure!(
            !items.iter().any(|item| matches!(item, ResponseItem::Other)),
            "Unsupported staged response item"
        );
        for item in &self.pending_input {
            let identity_field = if item.get("type").and_then(Value::as_str)
                == Some("local_shell_call_output")
            {
                "id"
            } else {
                "call_id"
            };
            if let Some(id) = item.get(identity_field).and_then(Value::as_str) {
                ensure!(
                    !self.reply_order.iter().any(|original| original == id),
                    "Staged input cannot reuse a manual call identity"
                );
            }
        }
        Ok(items)
    }

    pub(crate) fn terminal_seed(
        &mut self,
        raw: &Value,
        reset_tool_choice: bool,
    ) -> Result<Option<RecoveredToolCompletionSeed>> {
        let calls = history(raw)?.calls;
        let mut held = Vec::new();
        if let Some(outcomes) = &self.tool_outcomes {
            let unique: HashSet<_> = outcomes.held_call_ids.iter().collect();
            ensure!(
                unique.len() == outcomes.held_call_ids.len(),
                "Duplicate held terminal identity"
            );
            for id in &outcomes.held_call_ids {
                let call = calls
                    .iter()
                    .find(|call| &call.call_id == id)
                    .context("Held result has no original call")?;
                let receipt = self
                    .accepted_replies
                    .get(id)
                    .context("Held result has no accepted private reply")?;
                let success = outcomes
                    .outcomes
                    .iter()
                    .find(|(call, _)| call == id)
                    .map(|(_, success)| *success)
                    .context("Held result has no captured outcome")?;
                held.push((receipt.envelope(call, &self.turn_id)?, success));
            }
        }
        Ok(match self.tool_outcomes.clone() {
            Some(outcomes) if self.fresh.is_some() || !held.is_empty() || reset_tool_choice => {
                Some(RecoveredToolCompletionSeed::new(
                    self.turn_id.clone(),
                    outcomes,
                    self.fresh.take(),
                    held,
                ))
            }
            _ => None,
        })
    }
}

struct ManualNativeTurn {
    id: String,
    completed: Mutex<HashMap<String, bool>>,
}

impl ManualNativeTurn {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            completed: Mutex::default(),
        }
    }
}

// Propagated only through the actual native parent. Descendants with no
// inherited managed catalog can still make a root manual save ready on idle.
#[derive(Clone)]
pub(crate) struct ManualProgress(pub(crate) watch::Sender<()>);

impl Default for ManualProgress {
    fn default() -> Self {
        Self(watch::channel(()).0)
    }
}

struct ManualWait {
    id: String,
    // Subscribe while registering, before the caller checks readiness.
    progress: watch::Receiver<()>,
    cancelled: CancellationToken,
}

impl Drop for ManualWait {
    fn drop(&mut self) {
        self.cancelled.cancel();
    }
}

#[derive(Default)]
pub(crate) struct ManualLedger {
    slots: HashSet<ToolName>,
    configured_slots: HashSet<ToolName>,
    // Actual successful sends, including outputs not yet flushed behind a
    // pending earlier call.
    receipts: HashMap<PendingKey, Receipt>,
    native_turn: Weak<ManualNativeTurn>,
    held_results: Option<(String, Arc<codex_extension_api::HeldToolCompletionResults>)>,
    waiter: Option<ManualWait>,
    // The continuation retains ManualCall data; each current key keeps the
    // exact event issued at restore, including any captured call metadata.
    restored: Option<(Continuation, HashMap<PendingKey, Value>)>,
    // Actual primary Core events in one physical attempt. Imported history,
    // forwarded events, and the managed request channel cannot mark sampling done.
    attempt: Option<String>,
    observed_calls: HashSet<String>,
    completed_calls: HashSet<String>,
}

impl ManualLedger {
    pub(super) fn restored_contains_key(&self, key: &PendingKey) -> bool {
        self.restored
            .as_ref()
            .is_some_and(|(_, keys)| keys.contains_key(key))
    }
}

#[derive(Clone)]
struct HandoffProof {
    name: ToolName,
    receipt: codex_protocol::agent_profile::AgentProfileHandoff,
    source: (codex_extension_api::AgentProfileReceipt, String),
    result_index: usize,
    next_profile: Option<(codex_extension_api::AgentProfileReceipt, String)>,
}

struct History {
    programmatic: std::collections::HashSet<String>,
    turn: String,
    calls: Vec<ManualCall>,
    outputs: HashMap<String, Receipt>,
    context: Option<TurnContextItem>,
    settings: Option<ThreadSettingsSnapshot>,
    sources: HashMap<String, (codex_extension_api::AgentProfileReceipt, String)>,
    handoffs: Vec<HandoffProof>,
}

fn history(value: &Value) -> Result<History> {
    history_with_staged_retry(value, None)
}

fn history_with_staged_retry(value: &Value, retry: Option<&StagedRetry>) -> Result<History> {
    let items: Vec<RolloutItem> = serde_json::from_value(value.clone())?;
    let mut result = History {
        programmatic: Default::default(),
        turn: String::new(),
        calls: Vec::new(),
        outputs: HashMap::new(),
        context: None,
        settings: None,
        sources: HashMap::new(),
        handoffs: Vec::new(),
    };
    let mut last_output = None;
    let mut searches = HashMap::new();
    let mut completed = false;
    // Import marks the interrupted turn aborted. Snapshots after this marker
    // belong to the fresh Session and cannot replace its original turn settings.
    let mut interrupted = false;
    let mut source = None;
    let mut transitions = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        let canonical = match &item {
            RolloutItem::ResponseItem(envelope) => Some(envelope.clone()),
            _ => None,
        };
        if let Some(envelope) = &canonical {
            if let Some(metadata) = &envelope.metadata {
                if let Some(profile) = &metadata.sdk_agent_profile {
                    let receipt = crate::agent_profiles::profile_receipt(profile)?;
                    let graph = metadata
                        .sdk_agent_graph
                        .clone()
                        .context("Agent source has no graph")?;
                    source = Some((receipt.clone(), graph.clone()));
                    transitions.push((index, receipt, graph));
                }
                if let Some(handoff) = &metadata.sdk_agent_handoff {
                    ensure!(
                        !result.turn.is_empty() && !completed,
                        "Handoff result has no unfinished turn"
                    );
                    let call = result
                        .calls
                        .iter()
                        .find(|call| call.call_id == handoff.call_id)
                        .context("Handoff result has no original call")?;
                    ensure!(
                        !call.custom
                            && matches!(&envelope.item,
                        ResponseItem::FunctionCallOutput { call_id: Some(id), .. } if id == &call.call_id),
                        "Handoff marker does not match its canonical function result"
                    );
                    let original = result
                        .sources
                        .get(&call.call_id)
                        .context("Handoff call has no captured source")?;
                    ensure!(
                        original.0 == handoff.source,
                        "Handoff differs from its original call source"
                    );
                    result.handoffs.push(HandoffProof {
                        name: ToolName::new(call.namespace.clone(), call.name.clone()),
                        receipt: handoff.clone(),
                        source: original.clone(),
                        result_index: index,
                        next_profile: None,
                    });
                }
            }
        }
        match item {
            RolloutItem::EventMsg(EventMsg::TurnStarted(turn)) => {
                // recover_turn_if_idle runs another RegularTask with the same
                // public ID. Earlier committed calls still guard against replay.
                if turn.turn_id != result.turn || completed {
                    result = History {
                        programmatic: Default::default(),
                        turn: turn.turn_id,
                        calls: Vec::new(),
                        outputs: HashMap::new(),
                        context: None,
                        settings: None,
                        sources: HashMap::new(),
                        handoffs: Vec::new(),
                    };
                    last_output = None;
                    searches.clear();
                }
                // Core can omit an unchanged TurnContext on same-ID recovery.
                // Retain that logical turn's last native context and settings;
                // later real in-turn records will supersede them if changed.
                completed = false;
                interrupted = false;
            }
            RolloutItem::EventMsg(EventMsg::TurnComplete(completion)) => {
                // A live staged receipt may retry its same-turn failed preparation.
                // Ordinary manual parsing keeps its existing terminal behavior.
                let failed_retry = retry.is_some_and(|retry|
                    retry.turn == result.turn && completion.turn_id == result.turn
                        && completion.error.is_some());
                completed = !failed_retry;
                interrupted |= failed_retry;
            }
            RolloutItem::TurnContext(context) if !result.turn.is_empty() => {
                ensure!(
                    context
                        .root_turn_id
                        .as_deref()
                        .is_none_or(|root| root == result.turn)
                        && context.realtime_active != Some(true),
                    "manual checkpoint requires an ordinary root turn"
                );
                if !interrupted && context.turn_id.as_deref() == Some(result.turn.as_str()) {
                    result.context = Some(context);
                }
            }
            RolloutItem::EventMsg(EventMsg::TurnAborted(abort))
                if abort.turn_id.as_deref() == Some(result.turn.as_str()) =>
            {
                interrupted = true;
            }
            RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(applied))
                if !result.turn.is_empty() && !interrupted =>
            {
                result.settings = Some(applied.thread_settings);
            }
            RolloutItem::RealtimeItem(_) | RolloutItem::InterAgentCommunication(_)
                if !result.turn.is_empty() =>
            {
                anyhow::bail!("manual checkpoint contains unsupported native interaction");
            }
            RolloutItem::ResponseItem(envelope) => match envelope.item {
                ResponseItem::ToolSearchCall {
                    call_id, execution, ..
                } => {
                    let id = call_id
                        .filter(|id| !id.is_empty())
                        .context("manual checkpoint contains a nonportable search call")?;
                    ensure!(
                        !result.turn.is_empty()
                            && execution == "client"
                            && searches.insert(id, false).is_none(),
                        "manual checkpoint contains a nonportable search call"
                    );
                }
                ResponseItem::ToolSearchOutput {
                    call_id,
                    execution,
                    status,
                    ..
                } => {
                    ensure!(
                        execution == "client" && status == "completed",
                        "manual checkpoint contains a nonportable search receipt"
                    );
                    let id = call_id
                        .context("manual checkpoint contains a nonportable search receipt")?;
                    let settled = searches.get_mut(&id).context(
                        "manual checkpoint contains an unmatched nonportable search receipt",
                    )?;
                    ensure!(
                        !*settled,
                        "manual checkpoint contains a duplicate nonportable search receipt"
                    );
                    *settled = true;
                }
                ResponseItem::FunctionCall {
                    caller,
                    name,
                    namespace,
                    arguments,
                    call_id,
                    ..
                } => {
                    ensure!(
                        !result.turn.is_empty()
                            && !result.calls.iter().any(|call| call.call_id == call_id),
                        "invalid or duplicate manual checkpoint call"
                    );
                    if matches!(
                        caller,
                        Some(codex_protocol::models::ProviderFunctionCaller::Program { .. })
                    ) {
                        result.programmatic.insert(call_id.clone());
                    }
                    if let Some(source) = &source {
                        result.sources.insert(call_id.clone(), source.clone());
                    }
                    result.calls.push(ManualCall {
                        name,
                        namespace,
                        arguments,
                        call_id,
                        custom: false,
                        shell: false,
                        patch: false,
                        approval_required: false,
                        effective_arguments: None,
                        continuation: None,
                    });
                }
                item @ ResponseItem::ApplyPatchCall { .. } => {
                    let envelope = canonical.as_ref().context("Missing canonical patch call")?;
                    ensure!(
                        crate::local_reconciliation::owns_application_patch(envelope),
                        "Provider patch cannot own a manual grant"
                    );
                    let ResponseItem::ApplyPatchCall { call_id, .. } = &item else {
                        unreachable!()
                    };
                    ensure!(
                        !result.turn.is_empty()
                            && !result.calls.iter().any(|call| &call.call_id == call_id),
                        "invalid or duplicate manual checkpoint call"
                    );
                    if let Some(source) = &source {
                        result.sources.insert(call_id.clone(), source.clone());
                    }
                    result.calls.push(ManualCall {
                        call_id: call_id.clone(),
                        name: "apply_patch".into(),
                        namespace: None,
                        arguments: serde_json::to_string(&item)?,
                        custom: false,
                        shell: false,
                        patch: true,
                        approval_required: false,
                        effective_arguments: None,
                        continuation: None,
                    });
                }
                item @ ResponseItem::ShellCall { .. } => {
                    let envelope = canonical.as_ref().context("Missing canonical Shell call")?;
                    ensure!(
                        crate::local_reconciliation::is_application_shell_call(envelope),
                        "Provider Shell cannot own a manual grant"
                    );
                    let data = serde_json::to_value(&item)?;
                    let call_id = data["call_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .context("Manual Shell lacks identity")?
                        .to_owned();
                    ensure!(
                        !result.turn.is_empty()
                            && !result.calls.iter().any(|call| call.call_id == call_id),
                        "invalid or duplicate manual checkpoint call"
                    );
                    if let Some(source) = &source {
                        result.sources.insert(call_id.clone(), source.clone());
                    }
                    result.calls.push(ManualCall {
                        call_id,
                        name: "shell".into(),
                        namespace: None,
                        arguments: serde_json::to_string(&item)?,
                        custom: false,
                        shell: true,
                        patch: false,
                        approval_required: false,
                        effective_arguments: None,
                        continuation: None,
                    });
                }
                ResponseItem::CustomToolCall {
                    name,
                    namespace,
                    input,
                    call_id,
                    ..
                } => {
                    let code_call = matches!(namespace.as_deref(), None | Some("" | "functions"))
                        && matches!(
                            name.as_str(),
                            "exec" | "wait" | "functions.exec" | "functions.wait"
                        );
                    ensure!(
                        !result.turn.is_empty()
                            && (name == "apply_patch" || code_call)
                            && !result.calls.iter().any(|call| call.call_id == call_id),
                        "invalid or duplicate native custom checkpoint call"
                    );
                    result.calls.push(ManualCall {
                        name,
                        namespace,
                        arguments: input,
                        call_id,
                        custom: true,
                        shell: false,
                        patch: false,
                        approval_required: false,
                        effective_arguments: None,
                        continuation: None,
                    });
                }
                item @ (ResponseItem::FunctionCallOutput { .. }
                | ResponseItem::CustomToolCallOutput { .. }
                | ResponseItem::ShellCallOutput { .. }
                | ResponseItem::ApplyPatchCallOutput { .. }) => {
                    let shell = matches!(item, ResponseItem::ShellCallOutput { .. });
                    let patch = matches!(item, ResponseItem::ApplyPatchCallOutput { .. });
                    let (id, custom) = match &item {
                        ResponseItem::FunctionCallOutput { call_id, .. } => (
                            call_id
                                .as_ref()
                                .context("manual checkpoint output has no call ID")?
                                .as_str(),
                            false,
                        ),
                        ResponseItem::ApplyPatchCallOutput { call_id, .. } => {
                            (call_id.as_str(), false)
                        }
                        ResponseItem::CustomToolCallOutput { call_id, .. } => {
                            (call_id.as_str(), true)
                        }
                        ResponseItem::ShellCallOutput {
                            provider_fields, ..
                        } => (
                            provider_fields
                                .get("call_id")
                                .and_then(Value::as_str)
                                .context("Manual Shell output lacks identity")?,
                            false,
                        ),
                        _ => unreachable!(),
                    };
                    let ordinal = result
                        .calls
                        .iter()
                        .position(|call| {
                            call.call_id == id
                                && call.custom == custom
                                && call.shell == shell
                                && call.patch == patch
                        })
                        .context(
                            "manual checkpoint output is orphaned or has the wrong call kind",
                        )?;
                    ensure!(
                        last_output.is_none_or(|previous| previous < ordinal),
                        "manual checkpoint outputs repeat or change the original call order"
                    );
                    ensure!(
                        result
                            .outputs
                            .insert(
                                id.to_owned(),
                                Receipt::Canonical(CanonicalResult(
                                    canonical.context("Missing canonical tool result")?
                                ))
                            )
                            .is_none(),
                        "duplicate manual checkpoint output"
                    );
                    last_output = Some(ordinal);
                }
                // Completed provider File Search is passive sampled data. It never
                // supplies a local pending call, result receipt, or execution grant.
                ResponseItem::FileSearchCall { id: Some(id), status, .. }
                    if status == "completed" && !id.is_empty() => {}
                // Code and other tool protocols cannot certify an ordinary
                // function-only boundary. They retain their existing live route.
                item if !result.turn.is_empty() => {
                    let data = serde_json::to_value(&item)?;
                    ensure!(
                        matches!(
                            data.get("type").and_then(Value::as_str),
                            Some(
                                "message"
                                    | "reasoning"
                                    | "compaction"
                                    | "additional_tools"
                                    | "agent_message"
                                    | "context_compaction"
                                    | "configuration_update"
                            )
                        ),
                        "manual checkpoint contains a non-function tool or unsupported item"
                    );
                }
                _ => {}
            },
            _ => {}
        }
    }
    for proof in &mut result.handoffs {
        proof.next_profile = transitions
            .iter()
            .find(|(index, _, _)| *index > proof.result_index)
            .map(|(_, receipt, graph)| (receipt.clone(), graph.clone()));
    }
    ensure!(
        searches.values().all(|settled| *settled),
        "manual checkpoint contains an incomplete nonportable search receipt"
    );
    ensure!(
        !completed && !result.turn.is_empty(),
        "no unfinished manual tool turn in history"
    );
    ensure!(
        result
            .calls
            .iter()
            .all(|call| !result.programmatic.contains(&call.call_id)
                || result.outputs.contains_key(&call.call_id)),
        "Pending provider programmatic calls require their original live native owner"
    );
    Ok(result)
}

/// Validate canonical sources and distinguish committed from deferred handoffs.
fn restored_profile_plan(
    opening: &crate::agent_profiles::OpeningProfiles,
    frame: &Continuation,
    history: &History,
    raw: &Value,
) -> Result<(
    codex_extension_api::AgentProfileReceipt,
    Vec<(ToolName, codex_protocol::agent_profile::AgentProfileHandoff)>,
)> {
    let rows: Vec<RolloutItem> = serde_json::from_value(raw.clone())?;
    let source = crate::agent_profiles::restore_source(opening, &rows)?;
    opening.validate_pending_source(&source)?;
    let mut pending_ids = HashSet::new();
    for call in &frame.pending_manual {
        ensure!(
            pending_ids.insert(&call.call_id),
            "Duplicate pending manual call"
        );
        let original = history
            .sources
            .get(&call.call_id)
            .context("Pending call has no captured source")?;
        ensure!(
            original.0 == source && original.1 == opening.fingerprint,
            "Pending call differs from the active admitted Agent source"
        );
    }
    for call in &frame.pending_mcp {
        ensure!(
            pending_ids.insert(&call.call_id),
            "Duplicate pending native MCP call"
        );
        let original = history
            .sources
            .get(&call.call_id)
            .context("Pending native MCP call has no captured source")?;
        ensure!(
            original.0 == source && original.1 == opening.fingerprint,
            "Pending native MCP call differs from the admitted Agent source"
        );
    }
    let settled_retry = frame.staged_retry
        && frame.pending_manual.is_empty()
        && frame.turn_id == history.turn
        && !frame.reply_order.is_empty()
        && frame.reply_order.len() == frame.accepted_replies.len()
        && frame
            .reply_order
            .iter()
            .all(|id| frame.accepted_replies.contains_key(id))
        && frame
            .reply_order
            .iter()
            .map(String::as_str)
            .eq(history.calls.iter().map(|call| call.call_id.as_str()));
    ensure!(
        !pending_ids.is_empty() || settled_retry,
        "Manual continuation has no pending calls"
    );
    let mut proofs = history.handoffs.clone();
    // A later completed sibling can be buffered behind the manual output gap.
    // Its full accepted envelope is the canonical pending proof, not a name guess.
    for call in &history.calls {
        if history.outputs.contains_key(&call.call_id) {
            continue;
        }
        let Some(receipt) = frame.accepted_replies.get(&call.call_id) else {
            continue;
        };
        let envelope = receipt.envelope(call, &history.turn)?;
        if let Some(handoff) = envelope
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.sdk_agent_handoff.as_ref())
        {
            ensure!(
                !call.custom && handoff.call_id == call.call_id,
                "Buffered handoff differs from original call"
            );
            let original = history
                .sources
                .get(&call.call_id)
                .context("Buffered handoff has no source")?;
            proofs.push(HandoffProof {
                name: ToolName::new(call.namespace.clone(), call.name.clone()),
                receipt: handoff.clone(),
                source: original.clone(),
                result_index: usize::MAX,
                next_profile: None,
            });
        }
    }
    let mut pending = Vec::new();
    let mut target = None;
    for proof in proofs {
        ensure!(
            proof.source.0 == proof.receipt.source && proof.source.1 == opening.fingerprint,
            "Handoff differs from original call source or admitted graph"
        );
        opening.validate_restored_handoff(
            &proof.name,
            &proof.receipt,
            proof.next_profile.is_none(),
        )?;
        if let Some((next, graph)) = &proof.next_profile {
            ensure!(
                graph == &opening.fingerprint
                    && next.profile_id == proof.receipt.target_profile_id
                    && proof.receipt.source.epoch.checked_add(1) == Some(next.epoch),
                "Handoff does not match its next accepted Agent transition"
            );
            continue;
        }
        ensure!(
            proof.receipt.source == source,
            "Deferred handoff differs from pending source"
        );
        ensure!(
            target
                .as_ref()
                .is_none_or(|target| target == &proof.receipt.target_profile_id),
            "Conflicting deferred Agent handoffs"
        );
        target = Some(proof.receipt.target_profile_id.clone());
        pending.push((proof.name, proof.receipt));
    }
    Ok((source, pending))
}

impl PythonTools {
    pub(crate) fn set_configured_continuation(
        &self,
        owner: &str,
        key: &PendingKey,
        receipt: &Value,
        state: Option<Value>,
    ) -> Result<bool> {
        ensure!(
            key.reply.thread == owner,
            "Configured continuation belongs to another thread"
        );
        let generation = self
            .resolve_generation(key.reply.generation)
            .context("Configured generation expired")?;
        let name = generation
            .entries
            .get(key.reply.slot)
            .context("Configured slot expired")?
            .name
            .clone()
            .with_default_namespace();
        let manual = self.manual.lock().expect("manual tools poisoned");
        ensure!(
            manual.configured_slots.contains(&name),
            "Current configured declaration is absent"
        );
        let mut pending = self.pending.lock().expect("JavaScript replies poisoned");
        let call = pending
            .get_mut(key)
            .context("Configured callback expired")?;
        ensure!(
            !call.retired
                && !call.sender.is_closed()
                && call.callback.as_ref().is_some_and(|callback| {
                    &callback.receipt == receipt
                        && callback.entered.load(Ordering::Acquire)
                        && callback.admits_reply()
                }),
            "Configured callback is not the live entered owner"
        );
        if let Some(state) = state {
            ensure!(
                call.configured.as_ref().is_none_or(|value| !value.parked),
                "Configured callback already parked"
            );
            ensure!(
                state["kind"] == "configured-child-v1" && state["state"].is_object(),
                "Invalid configured continuation data"
            );
            call.configured = Some(ConfiguredContinuation {
                state,
                parked: true,
            });
        } else {
            ensure!(
                call.configured_parked(),
                "Configured callback is not parked"
            );
            call.configured = None;
        }
        Ok(true)
    }

    pub(crate) fn check_context_manual_idle(&self) -> Result<()> {
        let manual = self
            .manual
            .try_lock()
            .map_err(|_| anyhow::anyhow!("manual tool mutation is in progress"))?;
        ensure!(
            manual.waiter.is_none()
                && manual.restored.is_none()
                && manual.native_turn.upgrade().is_none(),
            "supplied compaction requires settled manual tool ownership"
        );
        Ok(())
    }

    pub(crate) fn check_context_manual_bindings(&self, source: &Self) -> Result<()> {
        let (slots, configured_slots) = {
            let manual = source
                .manual
                .try_lock()
                .map_err(|_| anyhow::anyhow!("source manual tool mutation is in progress"))?;
            (manual.slots.clone(), manual.configured_slots.clone())
        };
        let manual = self
            .manual
            .try_lock()
            .map_err(|_| anyhow::anyhow!("candidate manual tool mutation is in progress"))?;
        ensure!(
            manual.slots == slots && manual.configured_slots == configured_slots,
            "compaction candidate must retain current manual tool bindings"
        );
        Ok(())
    }

    pub(crate) fn configure_manual(&self, slots: Vec<ManualSlot>) -> Result<()> {
        let generation = self.snapshot();
        let mut names = HashSet::new();
        let mut configured_names = HashSet::new();
        for slot in slots {
            let name = ToolName::new(slot.namespace, slot.name).with_default_namespace();
            ensure!(
                generation
                    .entries
                    .iter()
                    .any(|entry| entry.name.clone().with_default_namespace() == name),
                "manual tool absent from current native catalog: {name}"
            );
            if slot.configured {
                ensure!(
                    generation.entries.iter().any(|entry| entry
                        .name
                        .clone()
                        .with_default_namespace()
                        == name
                        && matches!(entry.spec, ToolSpec::Function(_) | ToolSpec::Namespace(_))),
                    "Configured continuation requires a current function declaration"
                );
                ensure!(configured_names.insert(name), "duplicate configured slot");
            } else {
                ensure!(names.insert(name), "duplicate manual slot");
            }
        }
        ensure!(
            names.is_disjoint(&configured_names),
            "duplicate manual/configured slot"
        );
        ensure!(
            self.pending
                .lock()
                .expect("JavaScript replies poisoned")
                .is_empty(),
            "cannot configure manual tools during live calls"
        );
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        ensure!(
            manual.restored.is_none(),
            "cannot change restored manual rights"
        );
        *manual = ManualLedger {
            slots: names,
            configured_slots: configured_names,
            ..Default::default()
        };
        Ok(())
    }

    // Children inherit declarations, never the parent's live receipts or continuation.
    pub(crate) fn child_manual_ledger(&self) -> ManualLedger {
        ManualLedger {
            slots: self
                .manual
                .lock()
                .expect("manual tools poisoned")
                .slots
                .clone(),
            ..Default::default()
        }
    }

    pub(crate) fn is_manual(&self, name: &ToolName) -> bool {
        self.manual
            .lock()
            .expect("manual tools poisoned")
            .slots
            .contains(&name.clone().with_default_namespace())
    }

    pub(crate) fn begin_native_manual_turn(&self, input: TurnStartInput<'_>) {
        let turn = input
            .turn_store
            .get_or_init(|| ManualNativeTurn::new(input.turn_id));
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        // Do not let an original-ID recovery keep the old capture waiter.
        manual.waiter = None;
        manual.native_turn = Arc::downgrade(&turn);
        manual.held_results = Some((
            input.turn_id.to_owned(),
            input
                .turn_store
                .get_or_init(codex_extension_api::HeldToolCompletionResults::default),
        ));
    }

    pub(crate) fn record_native_manual_completion(&self, input: ToolFinishInput<'_>) {
        let manual = self.manual.lock().expect("manual tools poisoned");
        if let Some(turn) = input.turn_store.get::<ManualNativeTurn>()
            && Weak::ptr_eq(&manual.native_turn, &Arc::downgrade(&turn))
        {
            turn.completed
                .lock()
                .expect("manual completion receipts poisoned")
                .insert(
                    input.call_id.to_owned(),
                    matches!(input.outcome, ToolCallOutcome::Completed { .. }),
                );
            self.family.manual_progress.0.send_replace(());
        }
    }

    pub(crate) fn stop_native_manual_turn(&self, input: TurnStopInput<'_>) {
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        if let Some(turn) = input.turn_store.get::<ManualNativeTurn>()
            && Weak::ptr_eq(&manual.native_turn, &Arc::downgrade(&turn))
        {
            manual.waiter = None;
            manual.native_turn = Weak::new();
        }
    }

    pub(crate) fn begin_manual_wait(&self, owner: &str, keys: &[PendingKey]) -> Result<String> {
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        ensure!(
            manual.restored.is_none(),
            "restored manual does not have a live native turn"
        );
        ensure!(
            manual.waiter.is_none(),
            "manual checkpoint wait is already active"
        );
        let key = keys.first().context("no pending manual requests")?;
        let pending = self.pending.lock().expect("JavaScript replies poisoned");
        ensure!(
            key.reply.thread == owner
                && self.resolve_generation(key.reply.generation).is_some()
                && (key.reply.manual_grant.is_some()
                    || pending
                        .get(key)
                        .is_some_and(|call| call.configured_parked()))
                && pending
                    .get(key)
                    .is_some_and(|call| !call.sender.is_closed()),
            "manual request is no longer current"
        );
        let turn = manual
            .native_turn
            .upgrade()
            .context("manual native turn expired")?;
        ensure!(
            key.turn == turn.id,
            "manual request belongs to a different native turn"
        );
        let id = codex_core_api::ThreadId::new().to_string();
        manual.waiter = Some(ManualWait {
            id: id.clone(),
            progress: self.family.manual_progress.0.subscribe(),
            cancelled: CancellationToken::new(),
        });
        Ok(id)
    }

    pub(crate) async fn wait_manual_progress(&self, id: &str) -> Result<()> {
        let (mut progress, cancelled) = {
            let manual = self.manual.lock().expect("manual tools poisoned");
            // End/retirement can win before N-API schedules the waiting future.
            let Some(wait) = manual.waiter.as_ref() else {
                return Ok(());
            };
            ensure!(wait.id == id, "foreign manual checkpoint wait");
            (wait.progress.clone(), wait.cancelled.clone())
        };
        let changed = tokio::select! {
            _ = cancelled.cancelled() => false,
            _ = progress.changed() => true,
        };
        if changed {
            let mut manual = self.manual.lock().expect("manual tools poisoned");
            if let Some(wait) = manual.waiter.as_mut()
                && wait.id == id
            {
                // A returned wait is followed by a fresh readiness check. Mark
                // all changes already visible before returning, so the next
                // wait cannot replay the same notification indefinitely.
                let _ = wait.progress.borrow_and_update();
            }
        }
        Ok(())
    }

    pub(crate) fn end_manual_wait(&self, id: &str) -> Result<()> {
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        if let Some(wait) = &manual.waiter {
            ensure!(wait.id == id, "foreign manual checkpoint wait");
            manual.waiter = None;
        }
        Ok(())
    }

    pub(crate) fn retire_manual_wait(&self) {
        self.manual.lock().expect("manual tools poisoned").waiter = None;
    }

    #[cfg(test)]
    pub(crate) fn has_manual_tools(&self) -> bool {
        !self
            .manual
            .lock()
            .expect("manual tools poisoned")
            .slots
            .is_empty()
    }

    pub(crate) fn observe_manual_event(&self, event: &Event) {
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        match &event.msg {
            EventMsg::TurnStarted(start) if start.turn_id == event.id => {
                // Reset even on original-ID recovery. This completion receipt
                // describes a physical sample, not the portable logical turn.
                manual.attempt = Some(start.turn_id.clone());
                manual.observed_calls.clear();
                manual.completed_calls.clear();
            }
            EventMsg::RawResponseItem(item) if manual.attempt.as_ref() == Some(&event.id) => {
                if let ResponseItem::FunctionCall { call_id, .. }
                | ResponseItem::CustomToolCall { call_id, .. }
                | ResponseItem::ApplyPatchCall { call_id, .. } = &item.item
                {
                    manual.observed_calls.insert(call_id.clone());
                } else if let ResponseItem::ShellCall {
                    provider_fields, ..
                } = &item.item
                {
                    if let Some(id) = provider_fields.get("call_id").and_then(Value::as_str) {
                        manual.observed_calls.insert(id.to_owned());
                    }
                }
            }
            EventMsg::RawResponseCompleted(_) if manual.attempt.as_ref() == Some(&event.id) => {
                manual.completed_calls = manual.observed_calls.clone();
                // Core persists the raw event before delivery. Publish only
                // after the live ledger reflects that completed sample too.
                drop(manual);
                self.family.manual_progress.0.send_replace(());
            }
            EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)
                if manual.attempt.as_ref() == Some(&event.id) =>
            {
                manual.attempt = None;
                manual.observed_calls.clear();
                manual.completed_calls.clear();
            }
            _ => {}
        }
    }

    pub(crate) fn record_manual_receipt(
        &self,
        key: &PendingKey,
        response: DynamicToolResponse,
        native: Option<ResponseItem>,
    ) {
        let item = native
            .filter(|item| {
                matches!(
                    item,
                    ResponseItem::ShellCallOutput { .. }
                        | ResponseItem::ApplyPatchCallOutput { .. }
                )
            })
            .unwrap_or_else(|| PythonOutput(response.clone()).receipt(key));
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        if let Some((frame, keys)) = manual.restored.as_mut() {
            if keys.remove(key).is_some() {
                frame.pending_manual.retain(|call| call.call_id != key.call);
                if let Some(outcomes) = &mut frame.tool_outcomes {
                    outcomes.record(&key.call, response.success);
                }
                frame.record_fresh_completion(key, response.success);
                frame
                    .accepted_replies
                    .insert(key.call.clone(), Receipt::Native(item));
                return;
            }
        }
        if manual.slots.is_empty()
            && manual.configured_slots.is_empty()
            && !self
                .resolve_generation(key.reply.generation)
                .is_some_and(|generation| {
                    generation
                        .manual_slots
                        .as_ref()
                        .is_some_and(|slots| !slots.is_empty())
                })
        {
            return;
        }
        manual.receipts.retain(|key_, _| key_.turn == key.turn);
        manual
            .receipts
            .insert(key.clone(), Receipt::Provisional(item));
    }

    pub(crate) fn has_restored_manual(&self) -> bool {
        self.manual
            .lock()
            .expect("manual tools poisoned")
            .restored
            .is_some()
    }

    // Observe the existing reply owner without taking a sender or reading the
    // family inbox. Restored requests reuse their already-issued ledger keys.
    pub(crate) fn pending_manual_tools(&self, owner: &ManualOwner) -> Vec<Value> {
        let current = |key: &PendingKey| {
            key.reply.thread == owner.thread
                && key.reply.instance == owner.instance
                && key.reply.instance == self.instance
                && self.resolve_generation(key.reply.generation).is_some()
                && key.reply.manual_grant.is_some()
                && key.turn == owner.turn
        };
        let manual = self.manual.lock().expect("manual tools poisoned");
        if let Some((_, keys)) = &manual.restored {
            return keys
                .iter()
                .filter(|(key, _)| {
                    current(key)
                        && !self
                            .pending
                            .lock()
                            .expect("approval pending poisoned")
                            .get(*key)
                            .is_some_and(|call| call.callback.is_some())
                })
                .map(|(_, request)| request.clone())
                .collect();
        }
        let pending = self.pending.lock().expect("JavaScript replies poisoned");
        pending
            .iter()
            .filter(|(key, call)| current(key) && !call.sender.is_closed())
            .filter_map(|(_, call)| call.manual_request.clone())
            .collect()
    }

    pub(crate) fn manual_tool_current(&self, owner: &str, key: &PendingKey) -> bool {
        if key.reply.thread != owner
            || key.reply.instance != self.instance
            || self.resolve_generation(key.reply.generation).is_none()
            || key.reply.manual_grant.is_none()
        {
            return false;
        }
        let manual = self.manual.lock().expect("manual tools poisoned");
        if let Some((_, keys)) = &manual.restored {
            return keys.contains_key(key)
                && !self
                    .pending
                    .lock()
                    .expect("approval pending poisoned")
                    .get(key)
                    .is_some_and(|call| call.callback.is_some());
        }
        self.pending
            .lock()
            .expect("JavaScript replies poisoned")
            .get(key)
            .is_some_and(|call| call.manual_request.is_some() && !call.sender.is_closed())
    }

    pub(crate) fn require_approval(
        &self,
        owner: &str,
        key: &PendingKey,
        arguments: Option<Value>,
    ) -> Result<bool> {
        if !self.manual_tool_current(owner, key) {
            return Ok(false);
        }
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        if let Some((frame, keys)) = manual.restored.as_mut() {
            let Some(request) = keys.get_mut(key) else {
                return Ok(false);
            };
            ensure!(
                request["msg"]["_sdk_approval_required"] == true,
                "Saved manual call has no captured approval requirement"
            );
            if let Some(arguments) = arguments {
                request["msg"]["_sdk_effective_arguments"] = arguments.clone();
                if let Some(call) = frame
                    .pending_manual
                    .iter_mut()
                    .find(|call| call.call_id == key.call)
                {
                    call.effective_arguments = Some(serde_json::to_string(&arguments)?);
                }
            }
            return Ok(true);
        }
        let mut pending = self.pending.lock().expect("JavaScript replies poisoned");
        let Some(request) = pending
            .get_mut(key)
            .and_then(|call| call.manual_request.as_mut())
        else {
            return Ok(false);
        };
        request["msg"]["_sdk_approval_required"] = Value::Bool(true);
        if let Some(arguments) = arguments {
            request["msg"]["_sdk_effective_arguments"] = arguments;
        }
        Ok(true)
    }

    pub(crate) fn approve_manual(self: &Arc<Self>, owner: &str, key: &PendingKey) -> Result<bool> {
        if !self.manual_tool_current(owner, key) {
            return Ok(false);
        }
        let manual = self.manual.lock().expect("manual tools poisoned");
        let restored = manual
            .restored
            .as_ref()
            .and_then(|(_, keys)| keys.get(key))
            .cloned();
        let mut pending = self.pending.lock().expect("JavaScript replies poisoned");
        let mut request = match &restored {
            Some(request) => request.clone(),
            None => pending
                .get(key)
                .and_then(|call| call.manual_request.clone())
                .context("Approval invocation expired")?,
        };
        ensure!(
            request["msg"]["_sdk_approval_required"] == true,
            "Tool has no captured approval requirement"
        );
        ensure!(
            request["msg"]["_sdk_code_origin"].is_null(),
            "Managed approvals require direct function calls"
        );
        let invocation = if let Some(call) = pending.get(key) {
            if call
                .deadline
                .as_ref()
                .is_some_and(|deadline| !deadline.admit(|| true).unwrap_or(false))
            {
                return Ok(false);
            }
            call.invocation
        } else {
            self.family
                .next_step
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                    value.checked_add(1)
                })
                .map_err(|_| anyhow::anyhow!("Callback nonce exhausted"))?
        };
        let callback = CallbackRelease::new(
            json!({"kind":"tool","request":key,"invocation":invocation.to_string()}),
        );
        request["msg"]["_sdk_callback"] = callback.receipt.clone();
        request["msg"]["_sdk_managed_approved"] = Value::Bool(true);
        if restored.is_some() {
            let (sender, receiver) = oneshot::channel();
            pending.insert(
                key.clone(),
                PendingCall {
                    configured: None,
                    automatic_function: self.resolve_generation(key.reply.generation).is_some_and(
                        |generation| {
                            generation.entries.get(key.reply.slot).is_some_and(|entry| {
                                matches!(
                                    &entry.spec,
                                    ToolSpec::Function(_) | ToolSpec::Namespace(_)
                                )
                            })
                        },
                    ),
                    executor_tools: None,
                    client_search: None,
                    original_payload: self.resolve_generation(key.reply.generation).and_then(
                        |generation| {
                            generation.entries.get(key.reply.slot).and_then(|entry| {
                                original_tool_payload(&entry.spec, &request["msg"]["arguments"])
                            })
                        },
                    ),
                    media: None,
                    deadline: None,
                    invocation,
                    retired: false,
                    callback: Some(callback),
                    _tracing: None,
                    sender,
                    manual_request: None,
                    _approval_receiver: Some(receiver),
                },
            );
        } else {
            let call = pending
                .get_mut(key)
                .context("Approval invocation expired")?;
            call.manual_request = None;
            call.automatic_function =
                self.resolve_generation(key.reply.generation)
                    .is_some_and(|generation| {
                        generation.entries.get(key.reply.slot).is_some_and(|entry| {
                            matches!(&entry.spec, ToolSpec::Function(_) | ToolSpec::Namespace(_))
                        })
                    });
            call.callback = Some(callback);
        }
        drop(pending);
        drop(manual);
        self.family
            .requests
            .send(FamilyRequest::Call(
                Arc::downgrade(self),
                key.clone(),
                request,
            ))
            .map_err(|_| anyhow::anyhow!("Approval owner closed"))?;
        Ok(true)
    }

    pub(crate) fn check_restored_manual(&self, owner: &str, key: &PendingKey) -> Result<()> {
        let manual = self.manual.lock().expect("manual tools poisoned");
        ensure!(
            key.reply.thread == owner
                && self.resolve_generation(key.reply.generation).is_some()
                && key.reply.manual_grant.is_some()
                && manual
                    .restored
                    .as_ref()
                    .is_some_and(|(_, keys)| keys.contains_key(key)),
            "expired or foreign manual tool reply"
        );
        Ok(())
    }

    fn slot_for_catalog(
        &self,
        manual: &ManualLedger,
        call: &ManualCall,
        generation: &Generation,
    ) -> Result<usize> {
        ensure!(
            !call.custom,
            "native custom calls cannot acquire manual grants"
        );
        let name =
            ToolName::new(call.namespace.clone(), call.name.clone()).with_default_namespace();
        let slot = generation
            .entries
            .iter()
            .position(|entry| entry.name.clone().with_default_namespace() == name)
            .context("manual tool absent from captured source catalog")?;
        ensure!(
            matches!(
                &generation.entries[slot].spec,
                ToolSpec::ApplicationShell { .. }
            ) == call.shell,
            "manual call kind differs from its current declaration"
        );
        ensure!(
            matches!(&generation.entries[slot].spec, ToolSpec::ApplyPatch {}) == call.patch,
            "manual patch kind differs from its current declaration"
        );
        ensure!(
            manual.configured_slots.contains(&name)
                || generation.manual_slots.as_ref().map_or_else(
                    || manual.slots.contains(&name),
                    |slots| slots.contains(&slot)
                ),
            "pending call is not a captured manual tool: {name}"
        );
        Ok(slot)
    }

    pub(crate) fn seal_manual(
        &self,
        owner: &str,
        validated: &[PendingKey],
        raw: &Value,
    ) -> Result<Option<Continuation>> {
        let history = history(raw)?;
        let generation = validated
            .first()
            .and_then(|key| self.resolve_generation(key.reply.generation))
            .context("manual boundary has no admitted source catalog")?;
        let manual = self.manual.lock().expect("manual tools poisoned");
        let unique: HashSet<_> = validated.iter().cloned().collect();
        let ids: HashSet<_> = validated.iter().map(|key| key.call.as_str()).collect();
        ensure!(
            !unique.is_empty() && unique.len() == validated.len() && ids.len() == validated.len(),
            "no validated manual requests or duplicate portable call IDs"
        );
        if let Some((frame, keys)) = &manual.restored {
            let current: HashSet<_> = keys.keys().cloned().collect();
            ensure!(
                unique.is_subset(&current),
                "restored manual request is no longer current"
            );
            if unique.len() != current.len() {
                return Ok(None);
            }
            let mut captured = frame.clone();
            let pending = self.pending.lock().expect("JavaScript replies poisoned");
            for call in &mut captured.pending_manual {
                if let Some(value) = keys
                    .keys()
                    .find(|key| key.call == call.call_id)
                    .and_then(|key| pending.get(key))
                    .and_then(|call| call.configured.as_ref())
                {
                    ensure!(value.parked, "Configured continuation is not sealed");
                    call.continuation = Some(value.state.clone());
                }
            }
            drop(pending);
            self.validate_frame(&manual, &captured, &history)?;
            return Ok(Some(captured));
        }
        let pending = self.pending.lock().expect("JavaScript replies poisoned");
        let native_turn = manual.native_turn.upgrade();
        let current: HashSet<_> = pending.keys().cloned().collect();
        ensure!(
            unique.is_subset(&current),
            "manual request is no longer current"
        );
        ensure!(
            history.sources.is_empty()
                || !unique.iter().any(|key| pending
                    .get(key)
                    .is_some_and(|call| call.configured_parked())),
            "Configured checkpoints with managed profiles are not supported"
        );
        for key in &unique {
            ensure!(
                key.reply.thread == owner
                    && key.reply.generation == generation.id
                    && key.turn == history.turn
                    && (key.reply.manual_grant.is_some()
                        || pending
                            .get(key)
                            .is_some_and(|call| call.configured_parked()))
                    && pending
                        .get(key)
                        .is_some_and(|call| !call.sender.is_closed()),
                "manual request is no longer current"
            );
        }
        ensure!(
            !unique
                .iter()
                .any(|key| history.outputs.contains_key(&key.call)),
            "a pending manual call already has an output"
        );
        if manual.attempt.as_deref() != Some(history.turn.as_str())
            || unique
                .iter()
                .any(|key| !manual.completed_calls.contains(&key.call))
        {
            return Ok(None);
        }
        let mut frame = Continuation {
            lifecycle_start_ack: None,
            pending_input: Vec::new(),
            staged_retry: false,
            model_settings_override: history
                .context
                .as_ref()
                .and_then(|context| context.sdk_model_settings_override.clone()),
            model_override: history
                .context
                .as_ref()
                .and_then(|context| context.sdk_model_override.clone()),
            turn_id: history.turn.clone(),
            reply_order: history
                .calls
                .iter()
                .map(|call| call.call_id.clone())
                .collect(),
            accepted_replies: history.outputs.clone(),
            pending_manual: Vec::new(),
            pending_mcp: Vec::new(),
            native_mcp: None,
            native_mcp_source: None,
            generation: Some(generation.clone()),
            batch_completion: false,
            tool_outcomes: ToolOutcomes::capture(
                &serde_json::from_value::<Vec<RolloutItem>>(raw.clone())?,
                &validated[0].reply.thread,
                &history.turn,
            )?,
            fresh: None,
        };
        if let Some((turn, held)) = &manual.held_results {
            ensure!(
                turn == &history.turn,
                "Held terminal outputs belong to another turn"
            );
            for (output, succeeded, _) in held
                .outputs
                .lock()
                .expect("held terminal outputs poisoned")
                .iter()
            {
                let ResponseItem::FunctionCallOutput {
                    call_id: Some(id), ..
                } = &output.item
                else {
                    anyhow::bail!("Invalid held terminal result");
                };
                ensure!(
                    history.calls.iter().any(|call| &call.call_id == id)
                        && !history.outputs.contains_key(id),
                    "Held terminal result conflicts with accepted history"
                );
                ensure!(
                    frame
                        .accepted_replies
                        .insert(
                            id.clone(),
                            Receipt::Canonical(CanonicalResult(output.clone()))
                        )
                        .is_none(),
                    "Duplicate held terminal result"
                );
                let outcomes = frame
                    .tool_outcomes
                    .as_mut()
                    .context("Held terminal result has no sampled batch")?;
                outcomes.record(id, *succeeded);
                outcomes.held_call_ids.push(id.clone());
            }
        }
        let mut waiting = unique.len() != current.len();
        for call in &history.calls {
            if let Some(key) = unique.iter().find(|key| key.call == call.call_id) {
                ensure!(
                    key.reply.slot == self.slot_for_catalog(&manual, call, &generation)?,
                    "manual request slot mismatch"
                );
                let mut captured = call.clone();
                if let Some(value) = pending.get(key).and_then(|call| call.configured.as_ref()) {
                    captured.continuation = Some(value.state.clone());
                }
                if let Some(request) = pending
                    .get(key)
                    .and_then(|call| call.manual_request.as_ref())
                {
                    captured.approval_required = request["msg"]["_sdk_approval_required"] == true;
                    captured.effective_arguments = request["msg"]
                        .get("_sdk_effective_arguments")
                        .map(serde_json::to_string)
                        .transpose()?;
                }
                frame.pending_manual.push(captured);
            } else if !frame.accepted_replies.contains_key(&call.call_id) {
                let reply = manual
                    .receipts
                    .iter()
                    .find(|(key, _)| key.turn == history.turn && key.call == call.call_id);
                // Paired provider receipts are rejected before managed history
                // by response_integrity. A checked written output is settled,
                // including Core's own unsupported-call result. Only output
                // buffered behind a pending call still needs completion proof.
                let native_finished = native_turn.as_ref().and_then(|turn| {
                    turn.completed
                        .lock()
                        .expect("manual completion receipts poisoned")
                        .get(&call.call_id)
                        .copied()
                });
                ensure!(
                    native_finished != Some(false) || reply.is_some(),
                    "native call ended without a completed portable result"
                );
                if native_finished.is_none() && reply.is_none() {
                    waiting = true;
                } else if let Some((_, reply)) = reply {
                    frame
                        .accepted_replies
                        .insert(call.call_id.clone(), reply.clone());
                }
            }
        }
        if let Some(outcomes) = &mut frame.tool_outcomes {
            for (key, receipt) in &manual.receipts {
                if key.turn != history.turn || key.reply.thread != validated[0].reply.thread {
                    continue;
                }
                let output = match receipt {
                    Receipt::Native(ResponseItem::FunctionCallOutput { output, .. })
                    | Receipt::Provisional(ResponseItem::FunctionCallOutput { output, .. })
                    | Receipt::Native(ResponseItem::CustomToolCallOutput { output, .. })
                    | Receipt::Provisional(ResponseItem::CustomToolCallOutput { output, .. }) => {
                        Some(output)
                    }
                    _ => None,
                };
                if let Some(success) = output.and_then(|output| output.success) {
                    outcomes.record(&key.call, success);
                }
            }
        }
        if frame.pending_manual.len() != unique.len() || waiting {
            return Ok(None);
        }
        // Readiness can lack bodies still buffered behind an earlier manual
        // call. The committed capture supplies and validates them exactly once.
        ensure!(
            history.context.is_some() && history.settings.is_some(),
            "manual checkpoint lacks its original turn settings snapshot"
        );
        Ok(Some(frame))
    }

    fn validate_frame(
        &self,
        manual: &ManualLedger,
        frame: &Continuation,
        history: &History,
    ) -> Result<()> {
        ensure!(
            frame.model_override
                == history
                    .context
                    .as_ref()
                    .and_then(|context| context.sdk_model_override.clone()),
            "manual checkpoint differs from its admitted run model"
        );
        ensure!(
            frame.model_settings_override
                == history
                    .context
                    .as_ref()
                    .and_then(|context| context.sdk_model_settings_override.clone()),
            "manual checkpoint differs from its admitted run model settings"
        );
        let generation = frame.generation.clone().unwrap_or_else(|| self.snapshot());
        ensure!(
            frame.turn_id == history.turn
                && frame.reply_order
                    == history
                        .calls
                        .iter()
                        .map(|call| call.call_id.clone())
                        .collect::<Vec<_>>(),
            "manual checkpoint does not match the original turn and call order"
        );
        ensure!(
            history.context.is_some() && history.settings.is_some(),
            "manual checkpoint lacks its original turn settings snapshot"
        );
        ensure!(
            history
                .calls
                .iter()
                .take(history.outputs.len())
                .all(|call| history.outputs.contains_key(&call.call_id)),
            "manual checkpoint outputs are not an original call prefix"
        );
        let mut native_ids = HashSet::new();
        for data in &frame.pending_mcp {
            ensure!(
                data.turn_id == history.turn
                    && native_ids.insert(data.call_id.clone())
                    && !frame.accepted_replies.contains_key(&data.call_id)
                    && !history.outputs.contains_key(&data.call_id)
                    && !frame
                        .pending_manual
                        .iter()
                        .any(|call| call.call_id == data.call_id),
                "Invalid pending native MCP ownership"
            );
            let original = history
                .calls
                .iter()
                .find(|call| call.call_id == data.call_id)
                .context("Native MCP approval has no canonical call")?;
            let arguments = if original.arguments.trim().is_empty() {
                None
            } else {
                Some(serde_json::from_str::<Value>(&original.arguments)?)
            };
            ensure!(
                !original.custom
                    && !original.shell
                    && !original.patch
                    && original.name == data.callable_name
                    && original.namespace.as_deref() == Some(data.callable_namespace.as_str())
                    && arguments == data.arguments,
                "Native MCP approval differs from its accepted call"
            );
        }
        let mut expected = Vec::new();
        for call in &history.calls {
            if native_ids.contains(&call.call_id) {
                continue;
            }
            if let Some(receipt) = frame.accepted_replies.get(&call.call_id) {
                receipt.item(call, &history.turn)?;
                if let Some(written) = history.outputs.get(&call.call_id) {
                    ensure!(
                        receipt.matches(written, call, &history.turn)?,
                        "accepted output differs from history"
                    );
                }
            } else {
                ensure!(
                    !history.outputs.contains_key(&call.call_id),
                    "a pending grant has recorded output"
                );
                let slot = self.slot_for_catalog(manual, call, &generation)?;
                // Saved specs are descriptive. Only current catalog authority
                // can allow an unanswered direct call to be reissued.
                ensure!(
                    generation
                        .specs
                        .caller_limits(slot)
                        .is_none_or(|callers| callers.contains(codex_tools::ToolExposures::DIRECT)),
                    "manual tool {} does not permit direct calls",
                    generation.entries[slot].name
                );
                expected.push(call);
            }
        }
        ensure!(
            frame
                .accepted_replies
                .keys()
                .all(|id| frame.reply_order.contains(id))
                && !frame.reply_order.is_empty()
                && (expected.is_empty() && native_ids.is_empty()) == frame.staged_retry
                && expected.len() == frame.pending_manual.len(),
            "manual checkpoint has invalid pending/result partition"
        );
        for pending in &frame.pending_manual {
            let name = ToolName::new(pending.namespace.clone(), pending.name.clone())
                .with_default_namespace();
            if let Some(value) = &pending.continuation {
                ensure!(
                    manual.configured_slots.contains(&name)
                        && value["kind"] == "configured-child-v1"
                        && value["state"].is_object(),
                    "Current configured declaration does not admit continuation"
                );
            } else {
                ensure!(
                    !manual.configured_slots.contains(&name),
                    "Configured call requires its saved child continuation"
                );
            }
        }
        for (expected, pending) in expected.iter().zip(&frame.pending_manual) {
            ensure!(
                expected.call_id == pending.call_id
                    && expected.name == pending.name
                    && expected.namespace == pending.namespace
                    && expected.arguments == pending.arguments
                    && expected.custom == pending.custom
                    && expected.shell == pending.shell
                    && expected.patch == pending.patch
                    && (!(pending.shell || pending.patch)
                        || pending
                            .effective_arguments
                            .as_ref()
                            .is_none_or(|arguments| {
                                let Ok(value) = serde_json::from_str::<Value>(arguments) else {
                                    return false;
                                };
                                let Ok(mut original) =
                                    serde_json::from_str::<Value>(&pending.arguments)
                                else {
                                    return false;
                                };
                                if value
                                    .get("internal_chat_message_metadata_passthrough")
                                    .is_none()
                                {
                                    original
                                        .as_object_mut()
                                        .expect("canonical Shell call")
                                        .remove("internal_chat_message_metadata_passthrough");
                                }
                                if pending.patch {
                                    value.get("type") == original.get("type")
                                        && value.get("call_id") == original.get("call_id")
                                        && value.get("operation") == original.get("operation")
                                } else {
                                    value == original
                                }
                            })),
                "manual pending call differs from original history"
            );
        }
        Ok(())
    }

    pub(crate) fn finish_manual_capture(
        &self,
        mut frame: Continuation,
        raw: &mut Value,
    ) -> Result<Continuation> {
        let checked = history(raw)?;
        let manual = self.manual.lock().expect("manual tools poisoned");
        for call in &checked.calls {
            let pending = frame
                .pending_manual
                .iter()
                .any(|key| key.call_id == call.call_id);
            if let Some(written) = checked.outputs.get(&call.call_id) {
                ensure!(!pending, "suspension did not retain the exact manual grant");
                if let Some(receipt) = frame.accepted_replies.get(&call.call_id) {
                    ensure!(
                        receipt.matches(written, call, &checked.turn)?,
                        "native result changed during capture"
                    );
                }
                // Keep the exact persisted ID and metadata, including when
                // readiness knew only that JS had sent this result.
                frame
                    .accepted_replies
                    .insert(call.call_id.clone(), written.clone());
            }
        }
        // Shutdown can settle a terminal sibling into the native held-output
        // owner without persisting it. Promote only the exact live provisional
        // reply; saved receipt data never supplies this capture proof.
        if let Some((turn, held)) = &manual.held_results {
            ensure!(
                turn == &checked.turn && frame.turn_id == checked.turn,
                "Held terminal outputs belong to another capture turn"
            );
            let mut seen = HashSet::new();
            for (output, succeeded, _) in held
                .outputs
                .lock()
                .expect("held terminal outputs poisoned")
                .iter()
            {
                let ResponseItem::FunctionCallOutput {
                    call_id: Some(id), ..
                } = &output.item
                else {
                    anyhow::bail!("Invalid held terminal result");
                };
                ensure!(seen.insert(id.clone()), "Duplicate held terminal result");
                let Some(receipt @ Receipt::Provisional(_)) = frame.accepted_replies.get(id) else {
                    continue;
                };
                ensure!(
                    !checked.outputs.contains_key(id)
                        && !frame.pending_manual.iter().any(|call| &call.call_id == id),
                    "Held terminal result conflicts with the captured grant"
                );
                let call = checked
                    .calls
                    .iter()
                    .find(|call| &call.call_id == id)
                    .context("Held terminal result has no original call")?;
                let canonical = receipt.from_held_terminal(call, &checked.turn, output, *succeeded)?;
                frame.accepted_replies.insert(id.clone(), canonical);
                let outcomes = frame
                    .tool_outcomes
                    .as_mut()
                    .context("Held terminal result has no sampled batch")?;
                outcomes.record(id, *succeeded);
                if !outcomes.held_call_ids.contains(id) {
                    outcomes.held_call_ids.push(id.clone());
                }
            }
        }
        // Core drains completed native calls behind the cancelled manual slot.
        // Keep their exact receipts in format3, but leave only a strict output
        // prefix in saved history. Never remove matching IDs from older turns.
        let later: HashSet<_> = checked
            .calls
            .iter()
            .skip_while(|call| checked.outputs.contains_key(&call.call_id))
            .map(|call| call.call_id.as_str())
            .collect();
        let mut items: Vec<RolloutItem> = serde_json::from_value(raw.clone())?;
        let mut in_turn = false;
        items.retain(|row| {
            match row {
                RolloutItem::EventMsg(EventMsg::TurnStarted(turn)) => {
                    in_turn = turn.turn_id == checked.turn;
                }
                RolloutItem::EventMsg(EventMsg::TurnComplete(_)) => in_turn = false,
                RolloutItem::ResponseItem(item) if in_turn => match &item.item {
                    ResponseItem::FunctionCallOutput {
                        call_id: Some(id), ..
                    }
                    | ResponseItem::CustomToolCallOutput { call_id: id, .. }
                    | ResponseItem::ApplyPatchCallOutput { call_id: id, .. } => {
                        return !later.contains(id.as_str());
                    }
                    ResponseItem::ShellCallOutput {
                        provider_fields, ..
                    } => {
                        return provider_fields
                            .get("call_id")
                            .and_then(Value::as_str)
                            .is_none_or(|id| !later.contains(id));
                    }
                    _ => {}
                },
                _ => {}
            }
            true
        });
        *raw = serde_json::to_value(items)?;
        self.validate_frame(&manual, &frame, &history(raw)?)?;
        Ok(frame)
    }

    pub(crate) async fn restore_manual(
        &self,
        state: &crate::engine::ThreadState,
        mut frame: Continuation,
        raw: &Value,
        operation_tools: Option<&[ToolName]>,
    ) -> Result<Value> {
        frame.staged_items()?;
        let history = history(raw)?;
        if let Some(outcomes) = &frame.tool_outcomes {
            outcomes.validate(
                &serde_json::from_value::<Vec<RolloutItem>>(raw.clone())?,
                &state.id.to_string(),
                &frame.turn_id,
            )?;
        }
        let owner = state.id.to_string();
        let opening = state
            .thread
            .thread_extension_data()
            .get::<crate::agent_profiles::OpeningProfiles>();
        let plan = opening
            .as_ref()
            .map(|opening| restored_profile_plan(opening, &frame, &history, raw))
            .transpose()?;
        // Freeze one actual Core source before taking the synchronous frame mutex.
        let captured = if plan.is_some() {
            Some(
                state
                    .thread
                    .captured_agent_profile()
                    .await?
                    .context("Manual continuation has no committed source")?,
            )
        } else {
            ensure!(
                history.sources.is_empty() && history.handoffs.is_empty(),
                "Graph continuation requires a fresh admitted graph"
            );
            None
        };
        if let Some(ack) = &frame.lifecycle_start_ack {
            ensure!(ack.turn_id == frame.turn_id
                && ack.profile.as_ref() == captured.as_ref().map(|source| &source.receipt),
                "Lifecycle acknowledgment differs from the admitted manual source");
        }
        let generation = if let Some(captured) = &captured {
            ensure!(
                plan.as_ref()
                    .is_some_and(|(source, _)| source == &captured.receipt),
                "Manual source changed before reentry"
            );
            let catalog = captured
                .profile
                .data
                .get::<ProfileCatalog>()
                .context("Captured source has no tool catalog")?;
            ensure!(
                self.admits_generation(&catalog.generation),
                "Manual source catalog is no longer admitted"
            );
            catalog.generation.clone()
        } else {
            self.snapshot()
        };
        frame.batch_completion = captured
            .as_ref()
            .and_then(|source| source.profile.data.get::<ProfileCatalog>())
            .map_or(self.context_callbacks.tool_batch_completion, |catalog| {
                catalog.tool_batch_completion
            });
        if !frame.pending_input.is_empty() {
            let terminal = history.calls.iter().any(|call| {
                let name = ToolName::new(call.namespace.clone(), call.name.clone())
                    .with_default_namespace();
                generation.terminal_slots.iter().any(|slot| {
                    generation.entries[*slot]
                        .name
                        .clone()
                        .with_default_namespace()
                        == name
                })
            });
            ensure!(
                !terminal && !frame.batch_completion,
                "Staged input requires a model continuation after the manual replies"
            );
        }
        frame.generation = Some(generation.clone());
        let root_mcp_binding = if captured.is_none() && !frame.pending_mcp.is_empty() {
            state
                .thread
                .accepted_root_mcp_binding(&frame.pending_mcp[0].server_name)
                .await?
        } else {
            None
        };
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        ensure!(
            manual.restored.is_none(),
            "manual continuation already installed"
        );
        self.validate_frame(&manual, &frame, &history)?;
        if !frame.pending_mcp.is_empty() {
            ensure!(
                frame.pending_mcp.len() == 1
                    && frame.pending_manual.is_empty()
                    && frame.accepted_replies.is_empty()
                    && frame.reply_order.len() == 1
                    && frame.pending_input.is_empty()
                    && plan
                        .as_ref()
                        .is_none_or(|(_, handoffs)| handoffs.is_empty()),
                "Unsupported native MCP continuation shape"
            );
            let data = &frame.pending_mcp[0];
            let (binding, admitted_source) = if let Some(source) = captured.as_ref() {
                ensure!(
                    crate::agent_profiles::native_mcp_checkpoint_source(source),
                    "Native MCP continuation cannot replay host callbacks"
                );
                (
                    source.profile.mcp.clone(),
                    Arc::new(crate::native_interception::ProfileMcpSource {
                        receipt: Some(source.receipt.clone()),
                        policy: source
                            .profile
                            .data
                            .get::<crate::native_interception::ProfileMcpPolicy>(),
                        result_selection: source
                            .profile
                            .data
                            .get::<crate::mcp_result_control::Selection>(),
                    }),
                )
            } else {
                let binding = root_mcp_binding
                    .context("Native MCP restore requires an accepted current root binding")?;
                let current = self.native_mcp_root_source(
                    &state.thread.thread_extension_data(),
                    &binding,
                    &data.server_name,
                    &data.tool_name,
                )?;
                let admitted = current
                    .get::<crate::native_interception::ProfileMcpSource>()
                    .context("Native MCP root has no immutable policy source")?;
                (binding, admitted)
            };
            let prepared = data.prepare(&binding, state.id)?;
            let raw: Vec<RolloutItem> = serde_json::from_value(raw.clone())?;
            let call = raw
                .iter()
                .find_map(|row| match row {
                    RolloutItem::ResponseItem(item) if data.matches_canonical_call(&item.item) => {
                        Some(item.item.clone())
                    }
                    _ => None,
                })
                .context("Native MCP continuation lost its canonical call")?;
            let observation = frame
                .tool_outcomes
                .as_ref()
                .context("Native MCP continuation lacks its completed sample")?
                .response_observation_id
                .clone();
            frame.native_mcp_source = Some(admitted_source);
            frame.native_mcp = Some(codex_core::NativeMcpRecovery::new(
                prepared,
                call,
                observation,
            )?);
            manual.restored = Some((frame, HashMap::new()));
            return Ok(Value::Array(Vec::new()));
        }
        if let Some((_, handoffs)) = &plan {
            let captured = captured.as_deref().context("Missing handoff source")?;
            for (name, handoff) in handoffs {
                crate::agent_profiles::restore_handoff(
                    state,
                    captured,
                    &frame.turn_id,
                    name,
                    handoff,
                )?;
            }
        }
        let mut keys = HashMap::new();
        let mut events = Vec::new();
        // The imported operation can narrow the fresh opening policy only.
        // Portable configured captures exclude callbacks that select per step.
        let executor_tools =
            configured_executor_names(self.policy.allowed_tools.iter().flatten().filter(|tool| {
                operation_tools.is_none_or(|selected| {
                    selected
                        .iter()
                        .any(|name| name.name == tool.name && name.is_default_namespace())
                })
            }));
        for call in &frame.pending_manual {
            let key = PendingKey {
                reply: ReplyKey {
                    thread: owner.clone(),
                    generation: generation.id,
                    slot: self.slot_for_catalog(&manual, call, &generation)?,
                    instance: None,
                    manual_grant: Some(codex_core_api::ThreadId::new().to_string()),
                },
                turn: frame.turn_id.clone(),
                call: call.call_id.clone(),
            };
            let mut request = manual_request(
                &key,
                call,
                history
                    .context
                    .as_ref()
                    .map(|context| context.model.as_str()),
            )?;
            if let Some(captured) = &captured {
                request["msg"]["profile_id"] = json!(captured.receipt.profile_id);
                request["msg"]["profile_epoch"] = json!(captured.receipt.epoch);
            }
            if let Some(value) = &call.continuation {
                ensure!(
                    plan.is_none(),
                    "Configured continuation with managed profiles is not supported"
                );
                let invocation = self
                    .family
                    .next_step
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                        value.checked_add(1)
                    })
                    .map_err(|_| anyhow::anyhow!("Callback nonce exhausted"))?;
                let callback = CallbackRelease::new(
                    json!({"kind":"tool","request":key,"invocation":invocation.to_string()}),
                );
                request["msg"]["_sdk_callback"] = callback.receipt.clone();
                request["msg"]["_sdk_configured_continuation"] = value.clone();
                let (sender, receiver) = oneshot::channel();
                self.pending
                    .lock()
                    .expect("JavaScript replies poisoned")
                    .insert(
                        key.clone(),
                        PendingCall {
                            automatic_function: false,
                            configured: Some(ConfiguredContinuation {
                                state: value.clone(),
                                parked: false,
                            }),
                            executor_tools: Some(executor_tools.clone()),
                            client_search: None,
                            original_payload: original_tool_payload(
                                &generation.entries[key.reply.slot].spec,
                                &request["msg"]["arguments"],
                            ),
                            media: None,
                            deadline: None,
                            invocation,
                            retired: false,
                            callback: Some(callback),
                            _tracing: None,
                            sender,
                            manual_request: None,
                            _approval_receiver: Some(receiver),
                        },
                    );
            }
            events.push(request.clone());
            keys.insert(key, request);
        }
        manual.restored = Some((frame, keys));
        Ok(Value::Array(events))
    }

    /// Model selected by the validated restored native frame, not response JSON.
    pub(crate) fn restored_media_model(&self, owner: &str, key: &PendingKey) -> Result<String> {
        self.check_restored_manual(owner, key)?;
        let manual = self.manual.lock().expect("manual tools poisoned");
        let (_, keys) = manual
            .restored
            .as_ref()
            .context("manual continuation expired")?;
        keys.get(key).context("manual continuation expired")?["msg"]["_sdk_model"]
            .as_str()
            .map(str::to_owned)
            .context("restored file reply lacks its admitted original model")
    }

    pub(crate) fn respond_manual(
        &self,
        owner: &str,
        key: PendingKey,
        response: DynamicToolResponse,
    ) -> Result<()> {
        self.check_restored_manual(owner, &key)?;
        let success = response.success;
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        let (frame, keys) = manual
            .restored
            .as_mut()
            .context("manual continuation expired")?;
        let call = frame
            .pending_manual
            .iter()
            .find(|call| call.call_id == key.call)
            .context("manual request has no original call")?;
        let receipt = Receipt::Native(if call.shell {
            crate::local_reconciliation::shell_receipt(
                &serde_json::from_str::<ResponseItem>(&call.arguments)?,
                response,
                &key.turn,
            )?
        } else if call.patch {
            crate::local_reconciliation::application_patch_receipt(
                &serde_json::from_str::<ResponseItem>(&call.arguments)?,
                response,
                &key.turn,
            )?
        } else {
            PythonOutput(response).receipt(&key)
        });
        ensure!(
            keys.remove(&key).is_some(),
            "manual request already answered"
        );
        frame.pending_manual.retain(|call| call.call_id != key.call);
        ensure!(
            frame
                .accepted_replies
                .insert(key.call.clone(), receipt)
                .is_none(),
            "manual result already present"
        );
        frame.record_fresh_completion(&key, success);
        if let Some(outcomes) = &mut frame.tool_outcomes {
            outcomes.record(&key.call, success);
        }
        Ok(())
    }

    /// Called under the existing thread mutation gate immediately before admission.
    pub(crate) async fn validate_native_mcp_resume(
        &self,
        state: &crate::engine::ThreadState,
        frame: &Continuation,
    ) -> Result<()> {
        let Some(data) = frame.pending_mcp.first() else {
            return Ok(());
        };
        let expected = frame
            .native_mcp_source
            .as_ref()
            .context("Native MCP resume lacks its admitted policy source")?;
        let binding = if let Some(receipt) = &expected.receipt {
            let source = state
                .thread
                .captured_agent_profile()
                .await?
                .context("Native MCP source disappeared before admission")?;
            ensure!(
                &source.receipt == receipt
                    && crate::agent_profiles::native_mcp_checkpoint_source(&source),
                "Native MCP source changed before admission"
            );
            source.profile.mcp.clone()
        } else {
            let binding = state
                .thread
                .accepted_root_mcp_binding(&data.server_name)
                .await?
                .context("Native MCP root changed before admission")?;
            self.native_mcp_root_source(
                &state.thread.thread_extension_data(),
                &binding,
                &data.server_name,
                &data.tool_name,
            )?;
            binding
        };
        data.prepare(&binding, state.id)?;
        Ok(())
    }

    /// Build data only; native MCP requests never acquire a managed/manual grant.
    pub(crate) fn native_mcp_continuation(
        &self,
        data: &codex_core::McpApprovalCheckpointData,
        raw: &Value,
        lifecycle_start_ack: Option<codex_extension_api::AgentLifecycleStartAcknowledgment>,
    ) -> Result<Continuation> {
        let history = history(raw)?;
        ensure!(
            history.turn == data.turn_id
                && history.calls.len() == 1
                && history.calls[0].call_id == data.call_id
                && history.outputs.is_empty(),
            "Unsupported native MCP checkpoint batch"
        );
        if let Some(ack) = &lifecycle_start_ack {
            ensure!(
                ack.turn_id == data.turn_id
                    && ack.profile.as_ref()
                        == history.sources.get(&data.call_id).map(|source| &source.0),
                "Lifecycle acknowledgment differs from the sealed native MCP source"
            );
        }
        let rows: Vec<RolloutItem> = serde_json::from_value(raw.clone())?;
        ensure!(
            rows.iter()
                .any(|row| matches!(row, RolloutItem::ResponseItem(item)
            if data.matches_canonical_call(&item.item))),
            "Native MCP checkpoint call changed"
        );
        let outcomes =
            ToolOutcomes::capture(&rows, &data.source_thread_id.to_string(), &data.turn_id)?
                .context("Native MCP checkpoint lacks its completed sample")?;
        ensure!(
            outcomes.call_ids == [data.call_id.clone()] && outcomes.outcomes.is_empty(),
            "Native MCP checkpoint has an accepted result or unsettled sibling"
        );
        Ok(Continuation {
            lifecycle_start_ack,
            pending_input: Vec::new(),
            staged_retry: false,
            model_override: history
                .context
                .as_ref()
                .and_then(|context| context.sdk_model_override.clone()),
            model_settings_override: history
                .context
                .as_ref()
                .and_then(|context| context.sdk_model_settings_override.clone()),
            turn_id: data.turn_id.clone(),
            reply_order: vec![data.call_id.clone()],
            accepted_replies: HashMap::new(),
            pending_manual: Vec::new(),
            pending_mcp: vec![data.clone()],
            native_mcp: None,
            native_mcp_source: None,
            generation: None,
            tool_outcomes: Some(outcomes),
            fresh: None,
            batch_completion: false,
        })
    }

    pub(crate) fn manual_completion(
        &self,
        raw: &Value,
        owner: &str,
        preserve_accepted_replies: bool,
    ) -> Result<(
        Continuation,
        Vec<ResponseItemEnvelope>,
        ThreadSettingsOverrides,
        Vec<String>,
    )> {
        let history = history(raw)?;
        let manual = self.manual.lock().expect("manual tools poisoned");
        let (frame, keys) = manual.restored.as_ref().context("no manual continuation")?;
        ensure!(
            keys.is_empty()
                && frame.pending_manual.is_empty()
                && frame.reply_order.len()
                    == frame.accepted_replies.len() + frame.pending_mcp.len()
                && (frame.pending_mcp.is_empty() || frame.native_mcp.is_some())
                && frame.turn_id == history.turn
                && frame.reply_order
                    == history
                        .calls
                        .iter()
                        .map(|c| c.call_id.clone())
                        .collect::<Vec<_>>(),
            "manual continuation is not complete"
        );
        if let Some(fresh) = &frame.fresh {
            fresh.check(self)?;
        }
        let generation = frame
            .generation
            .as_ref()
            .context("Manual continuation lost its current catalog")?;
        ensure!(
            self.admits_generation(generation),
            "Expired terminal source catalog"
        );
        let mut held_ids = HashSet::new();
        for call in &history.calls {
            // Earlier accepted siblings already belong to canonical history.
            if history.outputs.contains_key(&call.call_id) {
                continue;
            }
            let name =
                ToolName::new(call.namespace.clone(), call.name.clone()).with_default_namespace();
            let slot = generation
                .entries
                .iter()
                .position(|entry| entry.name.clone().with_default_namespace() == name);
            if slot.is_some_and(|slot| {
                generation.terminal_slots.contains(&slot) || frame.batch_completion
            }) && frame.accepted_replies.contains_key(&call.call_id)
            {
                ensure!(
                    !call.custom,
                    "native custom calls cannot acquire manual grants"
                );
                ensure!(
                    frame
                        .tool_outcomes
                        .as_ref()
                        .is_some_and(|outcomes| outcomes.call_ids.contains(&call.call_id)),
                    "Held terminal reply has no current response facts"
                );
                held_ids.insert(call.call_id.clone());
            } else if slot.is_some_and(|slot| {
                generation.manual_slots.as_ref().map_or_else(
                    || manual.slots.contains(&name),
                    |slots| slots.contains(&slot),
                )
            }) {
                self.slot_for_catalog(&manual, call, generation)?;
            }
            // Captured automatic siblings outside the current completion policy may
            // be absent from the strict history prefix. Their accepted receipts
            // are validated below and do not acquire manual grants.
        }
        ensure!(
            held_ids.is_empty() || frame.tool_outcomes.is_some(),
            "Terminal continuation lacks completed-response facts"
        );
        if let Some(outcomes) = &frame.tool_outcomes {
            let unique: HashSet<_> = outcomes.held_call_ids.iter().collect();
            ensure!(
                unique.len() == outcomes.held_call_ids.len()
                    && unique.iter().all(|id| held_ids.contains(*id)),
                "Invalid held terminal identities"
            );
        }
        if preserve_accepted_replies && let Some(fresh) = &frame.fresh {
            // Only the still-live native PendingKey set can release a held reply.
            // A serialized sibling remains held even beside a fresh live receipt.
            for call in &history.calls {
                if !held_ids.contains(&call.call_id) {
                    continue;
                }
                let name = ToolName::new(call.namespace.clone(), call.name.clone())
                    .with_default_namespace();
                let slot = generation.entries.iter()
                    .position(|entry| entry.name.clone().with_default_namespace() == name)
                    .context("Held result lost its native declaration")?;
                if fresh.has_current_call(self, generation, owner, &frame.turn_id, &call.call_id, slot)? {
                    held_ids.remove(&call.call_id);
                }
            }
        }
        let mut items = Vec::new();
        let mut canonical_call_ids = Vec::new();
        for (id, call) in frame.reply_order.iter().zip(&history.calls) {
            if frame.pending_mcp.iter().any(|data| &data.call_id == id) {
                canonical_call_ids.push(id.clone());
                continue;
            }
            let receipt = frame
                .accepted_replies
                .get(id)
                .context("manual result missing")?;
            let mut item = receipt.envelope(call, &history.turn)?;
            if let Some(written) = history.outputs.get(id) {
                ensure!(
                    receipt.matches(written, call, &history.turn)?,
                    "manual result conflicts with history"
                );
            } else if !held_ids.contains(id) {
                let name =
                    ToolName::new(call.namespace.clone(), call.name.clone()).with_default_namespace();
                let origin = generation
                    .entries
                    .iter()
                    .position(|entry| entry.name.clone().with_default_namespace() == name)
                    .and_then(|slot| generation.specs.configured_agent_role(slot))
                    .map(|role| codex_history::ManagedAgentToolOrigin {
                        name: call.name.clone(),
                        role: role.to_owned(),
                    });
                if let Some(origin) = origin {
                    item.metadata.get_or_insert_with(Default::default).sdk_managed_agent_tool =
                        Some(origin);
                }
                items.push(item);
            } else {
                continue;
            }
            canonical_call_ids.push(id.clone());
        }
        let context = history
            .context
            .context("manual continuation lost original turn context")?;
        let saved = history
            .settings
            .context("manual continuation lost original settings snapshot")?;
        let settings = ThreadSettingsOverrides {
            model: Some(if frame.model_override.is_some() {
                saved.model.clone()
            } else {
                context.model
            }),
            effort: Some(
                if frame
                    .model_settings_override
                    .as_ref()
                    .is_some_and(|settings| settings.effort.is_some())
                {
                    saved.reasoning_effort
                } else {
                    context.effort
                },
            ),
            summary: Some(saved.reasoning_summary.unwrap_or_default()),
            service_tier: Some(saved.service_tier),
            tool_choice: saved.tool_choice,
            request_controls: saved.request_controls.hosted_prompt.map(|prompt| {
                codex_protocol::model_request_controls::ModelRequestControls {
                    hosted_prompt: Some(prompt),
                    ..Default::default()
                }
            }),
            ..Default::default()
        };
        let mut frame = frame.clone();
        if let Some(outcomes) = &mut frame.tool_outcomes {
            outcomes.held_call_ids = frame
                .reply_order
                .iter()
                .filter(|id| held_ids.contains(*id))
                .cloned()
                .collect();
        }
        Ok((frame, items, settings, canonical_call_ids))
    }

    pub(crate) fn retire_manual(&self) {
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        manual.restored = None;
        manual.waiter = None;
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use codex_protocol::protocol::RawResponseCompletedEvent;
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    fn waiting_tools() -> Arc<PythonTools> {
        let tools = super::super::pending_tests::tools();
        tools.manual.lock().unwrap().waiter = Some(ManualWait {
            id: "progress-test".into(),
            progress: tools.family.manual_progress.0.subscribe(),
            cancelled: CancellationToken::new(),
        });
        tools
    }

    async fn pending(mut read: std::pin::Pin<&mut impl Future<Output = Result<()>>>) {
        assert!(matches!(
            poll_fn(|cx| Poll::Ready(read.as_mut().poll(cx))).await,
            Poll::Pending
        ));
    }

    async fn ready(mut read: std::pin::Pin<&mut impl Future<Output = Result<()>>>) {
        assert!(matches!(
            poll_fn(|cx| Poll::Ready(read.as_mut().poll(cx))).await,
            Poll::Ready(Ok(()))
        ));
    }

    #[tokio::test]
    async fn sampled_call_mutation_wakes_without_opening_manual_slots() {
        let tools = waiting_tools();
        {
            let mut manual = tools.manual.lock().unwrap();
            manual.slots.clear();
            manual.attempt = Some("physical-turn".into());
            manual.observed_calls.insert("manual-call".into());
            assert!(!manual.completed_calls.contains("manual-call"));
        }
        let mut waiting = Box::pin(tools.wait_manual_progress("progress-test"));
        pending(waiting.as_mut()).await;
        tools.observe_manual_event(&Event {
            id: "physical-turn".into(),
            msg: EventMsg::RawResponseCompleted(RawResponseCompletedEvent {
                model_attempt_id: None,
                response_id: "response".into(),
                token_usage: None,
                usage_metadata: None,
            }),
        });
        ready(waiting.as_mut()).await;
        assert!(
            tools
                .manual
                .lock()
                .unwrap()
                .completed_calls
                .contains("manual-call")
        );
        tools.end_manual_wait("progress-test").unwrap();
    }

    #[tokio::test]
    async fn each_wait_requires_a_new_change_and_retirement_still_releases_it() {
        let tools = waiting_tools();
        tools.family.manual_progress.0.send_replace(());
        let mut first = Box::pin(tools.wait_manual_progress("progress-test"));
        ready(first.as_mut()).await;
        let mut next = Box::pin(tools.wait_manual_progress("progress-test"));
        pending(next.as_mut()).await;
        tools.family.manual_progress.0.send_replace(());
        ready(next.as_mut()).await;
        let mut last = Box::pin(tools.wait_manual_progress("progress-test"));
        pending(last.as_mut()).await;
        tools.end_manual_wait("progress-test").unwrap();
        ready(last.as_mut()).await;
        tools.wait_manual_progress("progress-test").await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_waits_share_a_change_without_replaying_it_for_later_waits() {
        let tools = waiting_tools();
        let mut one = Box::pin(tools.wait_manual_progress("progress-test"));
        let mut two = Box::pin(tools.wait_manual_progress("progress-test"));
        pending(one.as_mut()).await;
        pending(two.as_mut()).await;
        tools.family.manual_progress.0.send_replace(());
        ready(one.as_mut()).await;
        ready(two.as_mut()).await;
        let mut later = Box::pin(tools.wait_manual_progress("progress-test"));
        pending(later.as_mut()).await;
        tools.end_manual_wait("progress-test").unwrap();
        ready(later.as_mut()).await;
    }

    #[tokio::test]
    async fn dropping_a_woken_wait_keeps_the_change_for_the_next_wait() {
        let tools = waiting_tools();
        let mut abandoned = Box::pin(tools.wait_manual_progress("progress-test"));
        pending(abandoned.as_mut()).await;
        tools.family.manual_progress.0.send_replace(());
        drop(abandoned);
        let mut next = Box::pin(tools.wait_manual_progress("progress-test"));
        ready(next.as_mut()).await;
        tools.end_manual_wait("progress-test").unwrap();
    }

    #[tokio::test]
    async fn a_retired_wait_cannot_consume_a_replacement_tokens_change() {
        let tools = waiting_tools();
        let mut old = Box::pin(tools.wait_manual_progress("progress-test"));
        pending(old.as_mut()).await;
        // Retain the retired registration until the old future resumes, forcing
        // its changed branch rather than letting cancellation mask the ID check.
        let retired = tools
            .manual
            .lock()
            .unwrap()
            .waiter
            .replace(ManualWait {
                id: "replacement".into(),
                progress: tools.family.manual_progress.0.subscribe(),
                cancelled: CancellationToken::new(),
            })
            .unwrap();
        tools.family.manual_progress.0.send_replace(());
        ready(old.as_mut()).await;
        let mut current = Box::pin(tools.wait_manual_progress("replacement"));
        ready(current.as_mut()).await;
        drop(retired);
        let mut next = Box::pin(tools.wait_manual_progress("replacement"));
        pending(next.as_mut()).await;
        tools.end_manual_wait("replacement").unwrap();
        ready(next.as_mut()).await;
    }
}

#[cfg(test)]
mod canonical_result_tests {
    use super::*;

    fn call(id: &str) -> ManualCall {
        ManualCall {
            call_id: id.into(),
            name: "transfer_to_b".into(),
            namespace: None,
            arguments: "{}".into(),
            custom: false,
            shell: false,
            patch: false,
            approval_required: false,
            effective_arguments: None,
            continuation: None,
        }
    }

    fn held_output(
        id: &str,
        text: &str,
        turn: Option<&str>,
        success: bool,
    ) -> ResponseItemEnvelope {
        let mut item: ResponseItem = serde_json::from_value(json!({
            "type":"function_call_output", "call_id":id, "output":text,
            "internal_chat_message_metadata_passthrough": {"turn_id":turn}
        }))
        .unwrap();
        let ResponseItem::FunctionCallOutput { output, .. } = &mut item else {
            unreachable!()
        };
        output.success = Some(success);
        item.into()
    }

    #[test]
    fn held_promotion_preserves_native_false_output_without_fabricating_turn_metadata() {
        let sent = held_output("held", "exact body", Some("turn"), false);
        let held = held_output("held", "exact body", None, false);
        let receipt = Receipt::Provisional(sent.item);
        let promoted = receipt
            .from_held_terminal(&call("held"), "turn", &held, false)
            .unwrap();
        let result = promoted.envelope(&call("held"), "turn").unwrap();
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::to_value(&held).unwrap()
        );
        assert!(result.item.turn_id().is_none());
        let ResponseItem::FunctionCallOutput { output, .. } = &result.item else {
            unreachable!()
        };
        assert_eq!(output.success, Some(false));
    }

    #[test]
    fn held_promotion_rejects_data_receipts_and_changed_body_call_turn_or_success() {
        let sent = held_output("held", "exact body", Some("turn"), true);
        let held = held_output("held", "exact body", None, true);
        let receipt = Receipt::Provisional(sent.item.clone());
        assert!(
            Receipt::Native(sent.item)
                .from_held_terminal(&call("held"), "turn", &held, true)
                .is_err()
        );
        for changed in [
            held_output("other", "exact body", None, true),
            held_output("held", "changed body", None, true),
            held_output("held", "exact body", Some("other-turn"), true),
            held_output("held", "exact body", None, false),
        ] {
            assert!(
                receipt
                    .from_held_terminal(&call("held"), "turn", &changed, true)
                    .is_err()
            );
        }
        assert!(
            receipt
                .from_held_terminal(&call("held"), "turn", &held, false)
                .is_err()
        );
    }
    #[test]
    fn buffered_handoff_receipt_keeps_metadata_through_portable_json() {
        let item: ResponseItem = serde_json::from_value(json!({
            "type":"function_call_output", "call_id":"handoff", "output":"accepted"
        }))
        .unwrap();
        let mut envelope: ResponseItemEnvelope = item.into();
        envelope
            .metadata
            .get_or_insert_with(Default::default)
            .sdk_agent_handoff = Some(codex_protocol::agent_profile::AgentProfileHandoff {
            source: codex_extension_api::AgentProfileReceipt {
                profile_id: "agent_0".into(),
                epoch: 0,
            },
            target_profile_id: "agent_1".into(),
            call_id: "handoff".into(),
        });
        let original = Receipt::Canonical(CanonicalResult(envelope));
        let encoded = serde_json::to_value(&original).unwrap();
        assert_eq!(encoded["type"], "response_item");
        let decoded: Receipt = serde_json::from_value(encoded.clone()).unwrap();
        let restored = decoded.envelope(&call("handoff"), "turn").unwrap();
        assert_eq!(
            serde_json::to_value(RolloutItem::ResponseItem(restored)).unwrap(),
            encoded
        );
        assert!(decoded.envelope(&call("different"), "turn").is_err());
    }

    #[test]
    fn accepted_reply_rejects_non_output_wrapper_and_keeps_legacy_receipts() {
        let item: ResponseItem = serde_json::from_value(json!({
            "type":"message", "role":"assistant", "content":[]
        }))
        .unwrap();
        let wrapped = serde_json::to_value(RolloutItem::ResponseItem(item.into())).unwrap();
        assert!(serde_json::from_value::<CanonicalResult>(wrapped.clone()).is_err());
        // Receipt's forward-compatible Native fallback may decode Other, never reply authority.
        let unsupported: Receipt = serde_json::from_value(wrapped).unwrap();
        assert!(unsupported.envelope(&call("legacy"), "turn").is_err());
        let bare = json!({"type":"function_call_output", "call_id":"legacy", "output":"ok"});
        let legacy: Receipt = serde_json::from_value(bare).unwrap();
        assert!(legacy.envelope(&call("legacy"), "turn").is_ok());
        let text: Receipt = serde_json::from_value(json!("old text")).unwrap();
        assert!(text.envelope(&call("legacy"), "turn").is_ok());
    }
}

#[cfg(test)]
mod staged_input_tests {
    use super::*;
    fn frame(items: Vec<Value>) -> Continuation {
        serde_json::from_value(json!({"turn_id":"turn","reply_order":["pending"],"accepted_replies":{},"pending_manual":[{"call_id":"pending","name":"lookup","arguments":"{}"}],"pending_input":items})).unwrap()
    }
    #[test]
    fn staged_input_keeps_duplicate_occurrences() {
        let item = json!({"type":"message","role":"user","content":[{"type":"input_text","text":"repeat"}]});
        assert_eq!(
            frame(vec![item.clone(), item])
                .staged_items()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn staged_local_shell_outputs_keep_provider_ids_without_manual_authority() {
        let historical = json!({"type":"local_shell_call_output","id":"historical","output":"old result"});
        let items = frame(vec![historical.clone()]).staged_items().unwrap();
        assert_eq!(serde_json::to_value(&items[0]).unwrap(), historical);
        for extra in [None, Some("unrelated-ignored-field")] {
            let mut forged = json!({"type":"local_shell_call_output","id":"pending","output":"forged"});
            if let Some(id) = extra {
                forged["call_id"] = json!(id);
            }
            assert!(frame(vec![forged]).staged_items().is_err());
        }
    }
    #[test]
    fn staged_input_rejects_unknown_items_and_manual_identity_reuse() {
        assert!(
            frame(vec![json!({"type":"unknown_item"})])
                .staged_items()
                .is_err()
        );
        assert!(
            frame(vec![
                json!({"type":"function_call_output","call_id":"pending","output":"forged"})
            ])
            .staged_items()
            .is_err()
        );
    }
}

struct StagedInputData {
    original: Vec<Value>,
    batch_turn: String,
    batch: codex_extension_api::StagedInputBatch,
    current_turn: Arc<std::sync::Mutex<String>>,
}

struct StagedRetry {
    turn: String,
    continuation: Value,
    batch: codex_extension_api::StagedInputBatch,
    // Live native boundary after the accepted reply injection. Portable rows
    // cannot manufacture an abort suffix beyond this captured occurrence count.
    original_history_len: usize,
}
impl PythonTools {
    pub(crate) async fn retain_staged_retry(
        state: &crate::engine::ThreadState,
        frame: &Continuation,
        batch: codex_extension_api::StagedInputBatch,
    ) -> Result<()> {
        let original_history_len = state.engine.load_checkpoint_history(state.id).await?.len();
        if batch.projects_occurrences() {
            state
                .thread
                .thread_extension_data()
                .insert(StagedInputData {
                    original: frame.pending_input.clone(),
                    batch_turn: frame.turn_id.clone(),
                    batch: batch.clone(),
                    current_turn: Arc::new(std::sync::Mutex::new(frame.turn_id.clone())),
                });
        }
        let mut continuation = serde_json::to_value(frame)?;
        continuation["staged_retry"] = Value::Bool(true);
        state.thread.thread_extension_data().insert(StagedRetry {
            turn: frame.turn_id.clone(),
            continuation,
            batch,
            original_history_len,
        });
        Ok(())
    }
    pub(crate) fn staged_input_data(state: &crate::engine::ThreadState) -> Result<Vec<Value>> {
        let Some(data) = state.thread.thread_extension_data().get::<StagedInputData>() else { return Ok(Vec::new()); };
        data.batch.ensure_terminal_settled().map_err(anyhow::Error::msg)?;
        data.batch.pending_occurrences_for(&data.batch_turn).into_iter().map(|(index, _)|
            data.original.get(index).cloned().context("Staged data is outside its native owner")).collect()
    }
    pub(crate) fn remaining_staged_input(
        state: &crate::engine::ThreadState, turn: &str,
    ) -> Result<Option<Vec<Value>>> {
        let Some(data) = state.thread.thread_extension_data().get::<StagedInputData>() else { return Ok(None); };
        if *data.current_turn.lock().unwrap_or_else(std::sync::PoisonError::into_inner) != turn { return Ok(None); }
        Self::staged_input_data(state).map(Some)
    }
    pub(crate) fn restore_staged_input_data(state: &crate::engine::ThreadState, original: Vec<Value>) -> Result<()> {
        let items = original.iter().cloned().map(serde_json::from_value::<ResponseItem>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for item in &items {
            crate::checkpoint::validate_external_response_item(item)?;
            ensure!(matches!(item, ResponseItem::Message { role, content, .. }
                if role == "user" && content.iter().all(|part| matches!(part,
                    codex_protocol::models::ContentItem::InputText { .. }))),
                "Passive staged queue requires text user input");
        }
        state.thread.thread_extension_data().insert(StagedInputData {
            original, batch_turn: String::new(),
            batch: codex_extension_api::StagedInputBatch::selected_before_send(String::new(), items),
            current_turn: Arc::new(std::sync::Mutex::new(String::new())),
        });
        Ok(())
    }
    pub(crate) fn fresh_staged_input(state: &crate::engine::ThreadState)
        -> Result<Option<Arc<codex_extension_api::FreshStagedInput>>> {
        let Some(data) = state.thread.thread_extension_data().get::<StagedInputData>() else { return Ok(None); };
        if !data.batch.is_pending() { return Ok(None); }
        Ok(Some(Arc::new(codex_extension_api::FreshStagedInput::new(state.id.to_string(),
            data.batch.clone(), Arc::clone(&data.current_turn)).map_err(anyhow::Error::msg)?)))
    }
    pub(crate) fn staged_retry(
        state: &crate::engine::ThreadState,
        checkpoint: &Value,
    ) -> Result<Option<Value>> {
        let Some(retry) = state.thread.thread_extension_data().get::<StagedRetry>() else {
            return Ok(None);
        };
        if !retry.batch.is_pending() {
            return Ok(None);
        }
        let Some(last) = checkpoint["history"]
            .as_array()
            .and_then(|rows| {
                rows.iter().rev().find(|record| {
                    record["type"] == "event_msg" && record["payload"]["type"] == "task_started"
                })
            })
            .and_then(|record| record["payload"]["turn_id"].as_str())
        else {
            return Ok(None);
        };
        if last != retry.turn {
            return Ok(None);
        }
        if retry.batch.projects_occurrences() {
            let mut complete = false;
            for row in checkpoint["history"]
                .as_array()
                .context("Staged retry lacks history")?
            {
                if row["type"] != "event_msg" {
                    continue;
                }
                let event = &row["payload"];
                if event["turn_id"].as_str() != Some(last) {
                    continue;
                }
                match event["type"].as_str() {
                    Some("task_started") => complete = false,
                    // Failed preparation can settle as TurnComplete with an error.
                    // Only a successful terminal owns the passive-queue transition.
                    Some("task_complete") => complete = event["error"].is_null(),
                    _ => {}
                }
            }
            if complete {
                return Ok(None);
            }
        }
        let mut frame = retry.continuation.clone();
        if retry.batch.projects_occurrences() {
            // The old receipt remains usable only while that exact sample remains current.
            let current = history_with_staged_retry(&checkpoint["history"], Some(retry.as_ref()))?;
            let rows: Vec<RolloutItem> = serde_json::from_value(checkpoint["history"].clone())?;
            // Core appends its typed abort context after a failed preparation.
            // This is not another accepted caller/model item. Require both its
            // same-turn provenance and a following native interruption event.
            let mut interrupted = false;
            let mut last_item = None;
            for (index, row) in rows.iter().enumerate().rev() {
                match row {
                    RolloutItem::EventMsg(EventMsg::TurnAborted(abort))
                        if abort.turn_id.as_deref() == Some(last) => interrupted = true,
                    RolloutItem::ResponseItem(envelope) => {
                        let native_abort = interrupted
                            && index >= retry.original_history_len
                            && matches!(&envelope.item,
                                ResponseItem::Message {
                                    role, internal_chat_message_metadata_passthrough: Some(metadata), ..
                                } if role == "user" && metadata.turn_id.as_deref() == Some(last)
                                    && metadata.content_item_kinds.as_deref().is_some_and(|kinds|
                                        kinds.len() == 1 && kinds[0].0 == "generic.turn_aborted"));
                        if native_abort { continue; }
                        last_item = Some(&envelope.item);
                        break;
                    }
                    _ => {}
                }
            }
            let last_value = last_item.map(serde_json::to_value).transpose()?;
            let last_id = last_value.as_ref().and_then(|value| {
                matches!(
                    value["type"].as_str(),
                    Some(
                        "function_call_output"
                            | "custom_tool_call_output"
                            | "apply_patch_call_output"
                            | "shell_call_output"
                    )
                )
                .then(|| value["call_id"].as_str())
                .flatten()
            });
            if last_id.is_none_or(|id| frame["accepted_replies"].get(id).is_none()) {
                return Ok(None);
            }
            let old = frame["reply_order"]
                .as_array()
                .context("Staged retry lacks its call roster")?;
            if !old
                .iter()
                .filter_map(Value::as_str)
                .eq(current.calls.iter().map(|call| call.call_id.as_str()))
            {
                return Ok(None);
            }

            frame["pending_input"] = serde_json::to_value(
                Self::remaining_staged_input(state, last)?
                    .context("Staged retry lost its native occurrence owner")?,
            )?;
        }
        Ok(Some(frame))
    }
}


impl PythonTools {
    pub(crate) fn pending_memory_owner(
        &self,
        owner: &str,
        key: &PendingKey,
    ) -> Result<PendingMemoryOwner> {
        ensure!(
            self.instance.is_none() && self.inherited_source.is_none(),
            "Interrupted memory supports a current root only"
        );
        ensure!(
            key.reply.thread == owner
                && key.reply.instance.is_none()
                && key.reply.manual_grant.is_some(),
            "Invalid pending memory owner"
        );
        let generation = self
            .resolve_generation(key.reply.generation)
            .context("Pending memory catalog expired")?;
        let entry = generation
            .entries
            .get(key.reply.slot)
            .context("Pending memory tool expired")?;
        ensure!(
            matches!(&entry.spec, ToolSpec::Function(_)),
            "Interrupted memory requires a function approval"
        );
        let manual = self.manual.lock().expect("manual tools poisoned");
        ensure!(
            manual.restored.is_none(),
            "Interrupted memory requires a fresh approval owner"
        );
        let pending = self.pending.lock().expect("JavaScript replies poisoned");
        ensure!(
            pending.len() == 1,
            "Interrupted memory requires exactly one pending function approval"
        );
        let call = pending
            .get(key)
            .context("Pending memory approval expired")?;
        let request = call
            .manual_request
            .as_ref()
            .context("Pending memory approval already resolved")?;
        ensure!(
            !call.retired
                && !call.sender.is_closed()
                && call.callback.is_none()
                && call.configured.is_none()
                && request["msg"]["_sdk_approval_required"] == true
                && request["msg"]["_sdk_managed_approved"] != true
                && request["msg"]["_sdk_code_origin"].is_null()
                && call
                    .deadline
                    .as_ref()
                    .is_none_or(|deadline| deadline.admit(|| true).unwrap_or(false)),
            "Pending memory approval expired"
        );
        let profile = match (
            request["msg"].get("profile_id"),
            request["msg"].get("profile_epoch"),
        ) {
            (None, None) => None,
            (Some(id), Some(epoch)) => Some(serde_json::from_value::<codex_extension_api::AgentProfileReceipt>(
                json!({"profile_id": id, "epoch": epoch}),
            )?),
            _ => anyhow::bail!("Pending memory profile receipt is incomplete"),
        };
        ensure!(
            self.managed_profiles.load(Ordering::Acquire) == profile.is_some(),
            "Pending memory profile owner changed"
        );
        Ok(PendingMemoryOwner {
            key: key.clone(),
            invocation: call.invocation,
            profile,
            name: entry.name.clone(),
            arguments: request["msg"]["arguments"].clone(),
        })
    }

    pub(crate) fn check_pending_memory_owner(
        &self,
        owner: &str,
        proof: &PendingMemoryOwner,
    ) -> Result<()> {
        let current = self.pending_memory_owner(owner, &proof.key)?;
        ensure!(
            current.invocation == proof.invocation && current.profile == proof.profile,
            "Pending memory invocation changed"
        );
        Ok(())
    }
}

impl Continuation {
    pub(crate) fn retained_native_mcp_owner(&self) -> Option<Self> {
        (self.pending_mcp.len() == 1 && self.native_mcp.is_some()
            && self.native_mcp_source.is_some()
            && self.pending_manual.is_empty() && self.accepted_replies.is_empty())
            .then(|| self.clone())
    }

    /// Re-export only the sampled call held by a validated native MCP recovery.
    pub(crate) fn native_mcp_recapture_sample(&self, next: &Continuation) -> Result<String> {
        ensure!(self.native_mcp.is_some() && self.native_mcp_source.is_some()
            && self.pending_mcp.len() == 1 && next.pending_mcp.len() == 1
            && self.pending_manual.is_empty() && self.accepted_replies.is_empty()
            && self.turn_id == next.turn_id && self.reply_order == next.reply_order
            && self.model_override == next.model_override
            && self.model_settings_override == next.model_settings_override,
            "Native MCP recovery owner changed");
        let old = &self.pending_mcp[0];
        let current = &next.pending_mcp[0];
        ensure!(old.turn_id == current.turn_id && old.call_id == current.call_id
            && old.server_name == current.server_name && old.tool_name == current.tool_name
            && old.callable_namespace == current.callable_namespace
            && old.callable_name == current.callable_name
            && old.declaration_sha256 == current.declaration_sha256
            && old.arguments == current.arguments, "Native MCP recovery call changed");
        let previous = self.tool_outcomes.as_ref().context("Native MCP recovery lost its sample")?;
        let sampled = next.tool_outcomes.as_ref().context("Native MCP recapture lacks its sample")?;
        ensure!(previous.response_observation_id == sampled.response_observation_id
            && previous.call_ids == sampled.call_ids
            && previous.outcomes.is_empty() && sampled.outcomes.is_empty(),
            "Native MCP recovery sample changed");
        Ok(previous.response_observation_id.clone())
    }

}

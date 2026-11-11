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
    // Pending grants remain ordinary function calls. Only a checked, completed
    // native apply_patch call can use this internal history marker.
    #[serde(default, skip_serializing_if = "is_false")]
    custom: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    approval_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effective_arguments: Option<String>,
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
            ResponseItem::FunctionCallOutput { .. } | ResponseItem::CustomToolCallOutput { .. }
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
                    !call.custom,
                    "legacy text cannot represent a custom call output"
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
            matches!((&item, call.custom),
                (ResponseItem::FunctionCallOutput {call_id: Some(id), ..}, false)
                | (ResponseItem::CustomToolCallOutput {call_id: id, ..}, true)
                if *id == call.call_id),
            "manual result does not match original call kind and ID"
        );
        Ok(item)
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
    pub(crate) turn_id: String,
    pub(crate) reply_order: Vec<String>,
    accepted_replies: HashMap<String, Receipt>,
    pending_manual: Vec<ManualCall>,
    #[serde(skip)]
    generation: Option<Arc<Generation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_outcomes: Option<ToolOutcomes>,
    #[serde(skip)]
    fresh: Option<FreshTerminalReceipts>,
}

impl Continuation {
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
        Ok(match self.tool_outcomes.take() {
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

#[derive(Clone)]
struct HandoffProof {
    name: ToolName,
    receipt: codex_protocol::agent_profile::AgentProfileHandoff,
    source: (codex_extension_api::AgentProfileReceipt, String),
    result_index: usize,
    next_profile: Option<(codex_extension_api::AgentProfileReceipt, String)>,
}

struct History {
    turn: String,
    calls: Vec<ManualCall>,
    outputs: HashMap<String, Receipt>,
    context: Option<TurnContextItem>,
    settings: Option<ThreadSettingsSnapshot>,
    sources: HashMap<String, (codex_extension_api::AgentProfileReceipt, String)>,
    handoffs: Vec<HandoffProof>,
}

fn history(value: &Value) -> Result<History> {
    let items: Vec<RolloutItem> = serde_json::from_value(value.clone())?;
    let mut result = History {
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
            RolloutItem::EventMsg(EventMsg::TurnComplete(_)) => {
                completed = true;
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
                    if let Some(source) = &source {
                        result.sources.insert(call_id.clone(), source.clone());
                    }
                    result.calls.push(ManualCall {
                        name,
                        namespace,
                        arguments,
                        call_id,
                        custom: false,
                        approval_required: false,
                        effective_arguments: None,
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
                        approval_required: false,
                        effective_arguments: None,
                    });
                }
                item @ (ResponseItem::FunctionCallOutput { .. }
                | ResponseItem::CustomToolCallOutput { .. }) => {
                    let (id, custom) = match &item {
                        ResponseItem::FunctionCallOutput { call_id, .. } => (
                            call_id
                                .as_ref()
                                .context("manual checkpoint output has no call ID")?,
                            false,
                        ),
                        ResponseItem::CustomToolCallOutput { call_id, .. } => (call_id, true),
                        _ => unreachable!(),
                    };
                    let ordinal = result
                        .calls
                        .iter()
                        .position(|call| call.call_id == *id && call.custom == custom)
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
                                id.clone(),
                                Receipt::Canonical(CanonicalResult(
                                    canonical.context("Missing canonical tool result")?
                                ))
                            )
                            .is_none(),
                        "duplicate manual checkpoint output"
                    );
                    last_output = Some(ordinal);
                }
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
    ensure!(
        !pending_ids.is_empty(),
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
        opening.validate_restored_handoff(&proof.name, &proof.receipt)?;
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
        let slots = source
            .manual
            .try_lock()
            .map_err(|_| anyhow::anyhow!("source manual tool mutation is in progress"))?
            .slots
            .clone();
        let manual = self
            .manual
            .try_lock()
            .map_err(|_| anyhow::anyhow!("candidate manual tool mutation is in progress"))?;
        ensure!(
            manual.slots == slots,
            "compaction candidate must retain current manual tool bindings"
        );
        Ok(())
    }

    pub(crate) fn configure_manual(&self, slots: Vec<ManualSlot>) -> Result<()> {
        let generation = self.snapshot();
        let mut names = HashSet::new();
        for slot in slots {
            let name = ToolName::new(slot.namespace, slot.name).with_default_namespace();
            ensure!(
                generation
                    .entries
                    .iter()
                    .any(|entry| entry.name.clone().with_default_namespace() == name),
                "manual tool absent from current native catalog: {name}"
            );
            ensure!(names.insert(name), "duplicate manual slot");
        }
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
                && key.reply.manual_grant.is_some()
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
                | ResponseItem::CustomToolCall { call_id, .. } = &item.item
                {
                    manual.observed_calls.insert(call_id.clone());
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

    pub(crate) fn record_manual_receipt(&self, key: &PendingKey, response: DynamicToolResponse) {
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        if let Some((frame, keys)) = manual.restored.as_mut() {
            if keys.remove(key).is_some() {
                frame.pending_manual.retain(|call| call.call_id != key.call);
                if let Some(outcomes) = &mut frame.tool_outcomes {
                    outcomes.record(&key.call, response.success);
                }
                if response.success {
                    if let Some(generation) = self.resolve_generation(key.reply.generation) {
                        FreshTerminalReceipts::record(&mut frame.fresh, generation, key);
                    }
                }
                frame.accepted_replies.insert(
                    key.call.clone(),
                    Receipt::Native(PythonOutput(response).receipt(key)),
                );
                return;
            }
        }
        if manual.slots.is_empty()
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
        manual.receipts.insert(
            key.clone(),
            Receipt::Provisional(PythonOutput(response).receipt(key)),
        );
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
                    computer_arguments: None,
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
            generation.manual_slots.as_ref().map_or_else(
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
            self.validate_frame(&manual, frame, &history)?;
            return Ok(Some(frame.clone()));
        }
        let pending = self.pending.lock().expect("JavaScript replies poisoned");
        let native_turn = manual.native_turn.upgrade();
        let current: HashSet<_> = pending.keys().cloned().collect();
        ensure!(
            unique.is_subset(&current),
            "manual request is no longer current"
        );
        for key in &unique {
            ensure!(
                key.reply.thread == owner
                    && key.reply.generation == generation.id
                    && key.turn == history.turn
                    && key.reply.manual_grant.is_some()
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
            turn_id: history.turn.clone(),
            reply_order: history
                .calls
                .iter()
                .map(|call| call.call_id.clone())
                .collect(),
            accepted_replies: history.outputs.clone(),
            pending_manual: Vec::new(),
            generation: Some(generation.clone()),
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
            for (output, succeeded) in held
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
        let mut expected = Vec::new();
        for call in &history.calls {
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
                self.slot_for_catalog(manual, call, &generation)?;
                expected.push(call);
            }
        }
        ensure!(
            frame
                .accepted_replies
                .keys()
                .all(|id| frame.reply_order.contains(id))
                && !expected.is_empty()
                && expected.len() == frame.pending_manual.len(),
            "manual checkpoint has invalid pending/result partition"
        );
        for (expected, pending) in expected.iter().zip(&frame.pending_manual) {
            ensure!(
                expected.call_id == pending.call_id
                    && expected.name == pending.name
                    && expected.namespace == pending.namespace
                    && expected.arguments == pending.arguments,
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
                    | ResponseItem::CustomToolCallOutput { call_id: id, .. } => {
                        return !later.contains(id.as_str());
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
    ) -> Result<Value> {
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
        frame.generation = Some(generation.clone());
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        ensure!(
            manual.restored.is_none(),
            "manual continuation already installed"
        );
        self.validate_frame(&manual, &frame, &history)?;
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
        let receipt = Receipt::Native(PythonOutput(response).receipt(&key));
        let mut manual = self.manual.lock().expect("manual tools poisoned");
        let (frame, keys) = manual
            .restored
            .as_mut()
            .context("manual continuation expired")?;
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
        if let Some(outcomes) = &mut frame.tool_outcomes {
            outcomes.record(&key.call, success);
        }
        Ok(())
    }

    pub(crate) fn manual_completion(
        &self,
        raw: &Value,
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
                && frame.reply_order.len() == frame.accepted_replies.len()
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
            if slot.is_some_and(|slot| generation.terminal_slots.contains(&slot))
                && frame.accepted_replies.contains_key(&call.call_id)
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
            // Captured nonterminal automatic siblings may be absent from the
            // strict history prefix. Their accepted receipts are validated below;
            // they neither acquire manual grants nor become held terminal results.
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
        let mut items = Vec::new();
        let mut canonical_call_ids = Vec::new();
        for (id, call) in frame.reply_order.iter().zip(&history.calls) {
            let receipt = frame
                .accepted_replies
                .get(id)
                .context("manual result missing")?;
            let item = receipt.envelope(call, &history.turn)?;
            if let Some(written) = history.outputs.get(id) {
                ensure!(
                    receipt.matches(written, call, &history.turn)?,
                    "manual result conflicts with history"
                );
            } else if !held_ids.contains(id) {
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
            model: Some(context.model),
            effort: Some(context.effort),
            summary: Some(saved.reasoning_summary.unwrap_or_default()),
            service_tier: Some(saved.service_tier),
            tool_choice: saved.tool_choice,
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
            approval_required: false,
            effective_arguments: None,
        }
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

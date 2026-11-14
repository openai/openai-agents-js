//! Reuse Core recovered terminal settlement with fresh native callback receipts.
use super::*;
use anyhow::Context;
use codex_history::RolloutItem;
use codex_protocol::protocol::EventMsg;

/// Ordinary final outcome data; it never contains a live receipt or capability.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolOutcomes {
    pub response_observation_id: String,
    pub call_ids: Vec<String>,
    pub outcomes: Vec<(String, bool)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held_call_ids: Vec<String>,
}

impl ToolOutcomes {
    pub(super) fn capture(
        history: &[RolloutItem],
        thread: &str,
        turn: &str,
    ) -> Result<Option<Self>> {
        let Some((anchor, record)) =
            history
                .iter()
                .enumerate()
                .rev()
                .find_map(|(index, item)| match item {
                    RolloutItem::ResponseObservationRecord(record)
                        if record.thread_id.to_string() == thread && record.turn_id == turn =>
                    {
                        Some((index, record))
                    }
                    _ => None,
                })
        else {
            return Ok(None);
        };
        if record.compaction == Some(true)
            || record.observation.status
                != codex_protocol::protocol::ResponseObservationStatus::Completed
        {
            return Ok(None);
        }
        let original_start = history[..anchor]
            .iter()
            .rposition(|item| matches!(item, RolloutItem::EventMsg(EventMsg::TurnStarted(_))))
            .context("Recovered tool batch lacks its original turn start")?;
        ensure!(
            matches!(&history[original_start], RolloutItem::EventMsg(EventMsg::TurnStarted(start)) if start.turn_id == turn),
            "Recovered tool batch has wrong original turn"
        );
        let start = history[original_start + 1..anchor]
            .iter()
            .rposition(|item| matches!(item, RolloutItem::ResponseObservationRecord(_)))
            .map_or(original_start + 1, |index| original_start + index + 2);
        let call_ids: Vec<_> = history[start..anchor]
            .iter()
            .filter_map(|item| match item {
                RolloutItem::ResponseItem(item) => match &item.item {
                    ResponseItem::FunctionCall { call_id, .. }
                    | ResponseItem::CustomToolCall { call_id, .. } => Some(call_id.clone()),
                    ResponseItem::ToolSearchCall { call_id, .. } => call_id.clone(),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        if call_ids.is_empty() {
            return Ok(None);
        }
        let unique: HashSet<_> = call_ids.iter().collect();
        ensure!(
            unique.len() == call_ids.len() && !call_ids.iter().any(String::is_empty),
            "Invalid recovered tool batch identities"
        );
        let mut known = HashMap::new();
        for item in &history[anchor + 1..] {
            if let RolloutItem::ResponseItem(item) = item {
                let (id, success) = match &item.item {
                    ResponseItem::FunctionCallOutput {
                        call_id, output, ..
                    } => (call_id.as_deref(), output.success),
                    ResponseItem::CustomToolCallOutput {
                        call_id, output, ..
                    } => (Some(call_id.as_str()), output.success),
                    ResponseItem::ToolSearchOutput {
                        call_id,
                        status,
                        execution,
                        ..
                    } if execution == "client" && status == "completed" => {
                        (call_id.as_deref(), Some(true))
                    }
                    _ => continue,
                };
                if let (Some(id), Some(success)) = (id, success) {
                    if unique.contains(&id.to_owned()) {
                        ensure!(
                            known.insert(id.to_owned(), success).is_none(),
                            "Repeated recovered final outcome"
                        );
                    }
                }
            }
        }
        let outcomes = call_ids
            .iter()
            .filter_map(|id| known.get(id).map(|success| (id.clone(), *success)))
            .collect();
        Ok(Some(Self {
            held_call_ids: Vec::new(),
            response_observation_id: record.id.clone(),
            call_ids,
            outcomes,
        }))
    }
    pub(super) fn validate(&self, history: &[RolloutItem], thread: &str, turn: &str) -> Result<()> {
        let expected = Self::capture(history, thread, turn)?
            .context("Recovered tool outcomes lack a retained completed response")?;
        ensure!(
            self.response_observation_id == expected.response_observation_id
                && self.call_ids == expected.call_ids,
            "Recovered tool outcomes have wrong anchor or call order"
        );
        let mut seen = HashMap::new();
        for (id, success) in &self.outcomes {
            ensure!(
                self.call_ids.contains(id) && seen.insert(id, success).is_none(),
                "Duplicate or unrelated recovered outcome"
            );
        }
        for (id, success) in expected.outcomes {
            ensure!(
                seen.get(&id).is_none_or(|saved| **saved == success),
                "Recovered outcome conflicts with retained native success"
            );
        }
        Ok(())
    }
    pub(super) fn record(&mut self, id: &str, success: bool) {
        if !self.call_ids.iter().any(|call| call == id) {
            return;
        }
        if let Some((_, value)) = self.outcomes.iter_mut().find(|(call, _)| call == id) {
            *value = success;
        } else {
            self.outcomes.push((id.to_owned(), success));
        }
    }
    fn candidates(
        &self,
        turn: &str,
        held_outputs: Vec<(codex_history::ResponseItemEnvelope, bool)>,
    ) -> codex_extension_api::RecoveredToolCompletionCandidates {
        codex_extension_api::RecoveredToolCompletionCandidates {
            held_outputs,
            turn_id: turn.to_owned(),
            response_observation_id: self.response_observation_id.clone(),
            call_ids: self.call_ids.clone(),
            outcomes: self.outcomes.clone(),
        }
    }
}

/// Live accepted receipts are single-use and never serialized in a checkpoint.
#[derive(Clone)]
pub(super) struct FreshTerminalReceipts {
    generation: Arc<Generation>,
    calls: Arc<Mutex<Option<HashSet<PendingKey>>>>,
}
impl FreshTerminalReceipts {
    pub(super) fn record(target: &mut Option<Self>, generation: Arc<Generation>, key: &PendingKey) {
        let fresh = target.get_or_insert_with(|| Self {
            generation: generation.clone(),
            calls: Arc::new(Mutex::new(Some(HashSet::new()))),
        });
        fresh
            .calls
            .lock()
            .expect("recovered terminal receipts poisoned")
            .as_mut()
            .expect("recovered terminal receipts already adopted")
            .insert(key.clone());
    }
    pub(super) fn check(&self, tools: &PythonTools) -> Result<()> {
        ensure!(
            tools.admits_generation(&self.generation),
            "Expired recovered terminal generation"
        );
        Ok(())
    }
    pub(super) fn has_current_call(
        &self,
        tools: &PythonTools,
        generation: &Arc<Generation>,
        thread: &str,
        turn: &str,
        call: &str,
        slot: usize,
    ) -> Result<bool> {
        self.check(tools)?;
        ensure!(
            Arc::ptr_eq(&self.generation, generation),
            "Early reply publication changed its native catalog"
        );
        let pending = self.calls.lock().expect("recovered terminal receipts poisoned");
        Ok(pending.as_ref().is_some_and(|keys| keys.iter().any(|key| {
            key.reply.thread == thread
                && key.reply.instance == tools.instance
                && key.reply.generation == generation.id
                && key.turn == turn
                && key.call == call
                && key.reply.slot == slot
        })))
    }

    pub(super) fn adopt(&self, tools: &PythonTools, step: &StepCatalog) -> Result<()> {
        let mut pending = self
            .calls
            .lock()
            .expect("recovered terminal receipts poisoned");
        if pending.is_none() {
            return Ok(());
        }
        self.check(tools)?;
        ensure!(
            Arc::ptr_eq(&self.generation, &step.generation),
            "Recovered terminal step generation changed"
        );
        step.receipts
            .lock()
            .expect("JavaScript completion receipts poisoned")
            .extend(pending.take().expect("Fresh terminal receipts are pending"));
        Ok(())
    }
}

pub(crate) struct RecoveredToolCompletionSeed {
    turn: String,
    pending: Mutex<
        Option<(
            ToolOutcomes,
            Option<FreshTerminalReceipts>,
            Vec<(codex_history::ResponseItemEnvelope, bool)>,
        )>,
    >,
}
impl RecoveredToolCompletionSeed {
    pub(super) fn new(
        turn: String,
        outcomes: ToolOutcomes,
        fresh: Option<FreshTerminalReceipts>,
        held_outputs: Vec<(codex_history::ResponseItemEnvelope, bool)>,
    ) -> Self {
        Self {
            turn,
            pending: Mutex::new(Some((outcomes, fresh, held_outputs))),
        }
    }
    pub(crate) fn attach(self, init: &mut codex_extension_api::ExtensionDataInit) {
        init.insert(self);
    }
    pub(super) fn consume(&self, input: &TurnStartInput<'_>) {
        if self.turn != input.turn_id {
            return;
        }
        if let Some((outcomes, fresh, held_outputs)) = self
            .pending
            .lock()
            .expect("terminal recovery seed poisoned")
            .take()
        {
            input
                .turn_store
                .insert(outcomes.candidates(input.turn_id, held_outputs));
            if let Some(fresh) = fresh {
                input.turn_store.insert(fresh);
            }
        }
    }
}

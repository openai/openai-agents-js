//! Current-step receipts and owned host conversion for terminal function results.
use super::*;
use codex_extension_api::{ToolCompletionDecision, ToolCompletionInput};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TerminalSlots {
    pub(super) generation: String,
    pub(super) slots: Vec<usize>,
    #[serde(default)]
    pub(super) input_error_slots: Vec<usize>,
}

#[derive(Deserialize)]
pub(crate) struct CompletionReply {
    pub(crate) thread: String,
    pub(crate) instance: Option<String>,
    turn_id: String,
    generation: String,
    request_id: String,
    native_step: String,
    // A JSON null is a valid accepted value. Keep presence separate from value.
    #[serde(flatten)]
    value: HashMap<String, Value>,
}

#[derive(Debug, PartialEq)]
pub(super) enum ReplyValue {
    Accept(Value),
    Continue(Option<String>),
}

#[derive(Clone)]
struct CompletionOwner {
    thread: String,
    instance: Option<String>,
    turn: String,
}

pub(super) struct Pending {
    owner: CompletionOwner,
    generation: Arc<Generation>,
    step: String,
    sender: oneshot::Sender<std::result::Result<ReplyValue, String>>,
    callback: Option<Arc<CallbackRelease>>,
    stop: Option<Arc<crate::native_interception::CapturedTurnStop>>,
}

#[derive(Clone)]
pub(crate) struct TerminalProposal {
    generation: Arc<Generation>,
    owner: CompletionOwner,
    step: String,
    request_id: u64,
    failed: bool,
    settlement: Weak<crate::turn_settlement::Settlement>,
}

struct Wait {
    tools: Arc<PythonTools>,
    id: u64,
}
impl Drop for Wait {
    fn drop(&mut self) {
        self.tools.retire_terminal_callback(self.id);
    }
}

impl PythonTools {
    pub(crate) fn mark_tool_failure(&self, turn: &crate::turn_settlement::Turn) {
        if let Some(proposal) = turn
            .tool_proposal
            .lock()
            .expect("terminal proposal poisoned")
            .as_mut()
            && self.admits_generation(&proposal.generation)
            && self.current_completion_owner(&proposal.owner.thread)
        {
            proposal.failed = true;
        }
    }

    pub(crate) fn queue_tool_failure(self: &Arc<Self>, turn: &Arc<crate::turn_settlement::Turn>) {
        let proposal = turn
            .tool_proposal
            .lock()
            .expect("terminal proposal poisoned")
            .clone();
        let Some(proposal) = proposal.filter(|proposal| proposal.failed) else {
            return;
        };
        if !self.admits_generation(&proposal.generation) {
            return;
        }
        let mut request = json!({"id":proposal.owner.turn,"msg":{
            "type":"_sdk_tool_completion_failed", "thread":proposal.owner.thread,
            "instance":self.instance, "turn_id":proposal.owner.turn,
            "generation":proposal.generation.id.to_string(),
            "request_id":proposal.request_id.to_string(), "native_step":proposal.step
        }});
        if let Some(instance) = &self.instance {
            request["subagent_id"] = json!(proposal.owner.thread);
            request["subagent_incarnation"] = json!(instance);
            request["subagent_managed_tools"] = json!(true);
        }
        let _ = self.family.requests.send(FamilyRequest::CompletionFailed(
            Arc::downgrade(self),
            Arc::downgrade(turn),
            request,
        ));
    }

    pub(super) fn failed_tool_notice_current(
        &self,
        turn: &Arc<crate::turn_settlement::Turn>,
        request: &Value,
    ) -> bool {
        let proposal = turn
            .tool_proposal
            .lock()
            .expect("terminal proposal poisoned")
            .clone();
        let Some(proposal) = proposal.as_ref().filter(|proposal| proposal.failed) else {
            return false;
        };
        self.current_completion_owner(&proposal.owner.thread)
            && self.admits_generation(&proposal.generation)
            && turn.tool_failure_ready()
            && request["msg"]["request_id"] == proposal.request_id.to_string()
            && proposal
                .settlement
                .upgrade()
                .and_then(|owner| owner.matching(&proposal.owner.turn))
                .is_some_and(|current| Arc::ptr_eq(&current, turn))
    }

    pub(crate) fn configure_terminal(&self, config: TerminalSlots) -> Result<()> {
        let current = self.snapshot();
        let configured = self
            .resolve_generation(config.generation.parse()?)
            .filter(|generation| generation.id.to_string() == config.generation)
            .context("Expired terminal configuration generation")?;
        ensure!(
            self.pending
                .lock()
                .expect("JavaScript replies poisoned")
                .is_empty(),
            "Cannot configure terminal tools during live calls"
        );
        ensure!(
            self.completion_replies
                .lock()
                .expect("JavaScript completion replies poisoned")
                .is_empty(),
            "Cannot configure terminal tools during conversion"
        );
        let mut slots = HashSet::new();
        for slot in config.slots {
            ensure!(
                slot < configured.entries.len() && slots.insert(slot),
                "Invalid terminal tool slot"
            );
        }
        let mut input_errors = HashSet::new();
        for slot in config.input_error_slots {
            ensure!(
                slot < configured.entries.len() && input_errors.insert(slot),
                "Invalid input recovery slot"
            );
        }
        if configured.terminal_slots == slots && configured.input_error_slots == input_errors {
            return Ok(());
        }
        // Captured profiles are immutable; replacement creates a new registered catalog.
        ensure!(
            Arc::ptr_eq(&configured, &current),
            "Cannot change captured profile terminal configuration"
        );
        let mut generation = (*current).clone();
        generation.terminal_slots = slots;
        generation.input_error_slots = input_errors;
        let generation = Arc::new(generation);
        self.schema_receipts.register(&generation);
        let mut live = self.current.write().expect("JavaScript catalog poisoned");
        ensure!(
            Arc::ptr_eq(&live, &current),
            "Expired terminal configuration generation"
        );
        *live = generation;
        Ok(())
    }

    pub(super) fn current_completion_owner(&self, thread: &str) -> bool {
        self.instance.is_none()
            || self
                .family
                .members
                .read()
                .expect("JavaScript family poisoned")
                .get(thread)
                .and_then(Weak::upgrade)
                .is_some_and(|current| std::ptr::eq(current.as_ref(), self))
    }

    fn completion_matches(&self, response: &CompletionReply, pending: &Pending) -> bool {
        self.current_completion_owner(&pending.owner.thread)
            && !pending.sender.is_closed()
            && response.thread == pending.owner.thread
            && response.instance == self.instance
            && response.instance == pending.owner.instance
            && response.turn_id == pending.owner.turn
            && response.generation == pending.generation.id.to_string()
            && response.native_step == pending.step
            && self.admits_generation(&pending.generation)
            && !pending.sender.is_closed()
    }

    pub(crate) fn check_tool_completion(&self, response: &CompletionReply) -> Result<bool> {
        let id = response.request_id.parse::<u64>()?;
        Ok(self
            .completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned")
            .get(&id)
            .is_some_and(|pending| self.completion_matches(response, pending)))
    }

    pub(super) fn completion_queued(&self, id: u64) -> bool {
        self.completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned")
            .get(&id)
            .is_some_and(|pending| {
                self.current_completion_owner(&pending.owner.thread)
                    && self.admits_generation(&pending.generation)
                    && !pending.sender.is_closed()
            })
    }

    pub(crate) fn reply_tool_completion(&self, response: CompletionReply) -> Result<bool> {
        let id = response.request_id.parse::<u64>()?;
        let pending = {
            let mut replies = self
                .completion_replies
                .lock()
                .expect("JavaScript completion replies poisoned");
            if !replies
                .get(&id)
                .is_some_and(|pending| self.completion_matches(&response, pending))
            {
                return Ok(false);
            }
            ensure!(
                response.value.len() == 1,
                "Invalid terminal conversion reply"
            );
            let valid = response.value.contains_key("final_output")
                || response.value.get("error").is_some_and(Value::is_string)
                || response.value.get("continue").is_some_and(|value| {
                    value.is_null() || value.as_str().is_some_and(|text| !text.trim().is_empty())
                })
                || response.value.get("stop") == Some(&Value::Bool(true));
            ensure!(valid, "Invalid terminal conversion reply");
            ensure!(
                !response.value.contains_key("stop")
                    || replies
                        .get(&id)
                        .is_some_and(|pending| pending.stop.is_some()),
                "Expired terminal completion stop"
            );
            let pending = replies.remove(&id).expect("checked completion reply");
            if let Some(callback) = &pending.callback {
                let (sender, receive) = oneshot::channel();
                drop(receive);
                replies.insert(
                    id,
                    Pending {
                        owner: pending.owner.clone(),
                        generation: pending.generation.clone(),
                        step: pending.step.clone(),
                        sender,
                        callback: Some(callback.clone()),
                        stop: pending.stop.clone(),
                    },
                );
            }
            pending
        };
        let value = if let Some(value) = response.value.get("final_output") {
            Ok(ReplyValue::Accept(value.clone()))
        } else if response.value.contains_key("continue") {
            Ok(ReplyValue::Continue(
                response
                    .value
                    .get("continue")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ))
        } else if response.value.contains_key("stop") {
            Err("Terminal completion stopped".into())
        } else {
            Err("Terminal output conversion failed".into())
        };
        let stop = response
            .value
            .contains_key("stop")
            .then(|| pending.stop.clone())
            .flatten();
        let sent = pending.sender.send(value).is_ok();
        // Failed admission never grants authority to stop even this captured owner.
        if sent {
            if let Some(stop) = stop {
                stop.stop();
            }
        }
        Ok(sent)
    }

    pub(super) fn terminal_callback_operation(
        &self,
        id: u64,
        receipt: &Value,
        operation: &str,
    ) -> bool {
        let replies = self
            .completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned");
        let Some(pending) = replies.get(&id) else {
            return false;
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
            pending.sender.is_closed(),
            pending
                .stop
                .as_ref()
                .and_then(|stop| stop.callback_cancellation())
                .is_some_and(|token| token.is_cancelled()),
        )
    }

    fn retire_terminal_callback(&self, id: u64) {
        let mut replies = self
            .completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned");
        let Some(pending) = replies.get_mut(&id) else {
            return;
        };
        let Some(callback) = pending.callback.clone() else {
            replies.remove(&id);
            return;
        };
        let (sender, receive) = oneshot::channel();
        drop(receive);
        drop(std::mem::replace(&mut pending.sender, sender));
        self.cancel_step_callback(&pending.owner.turn, &callback);
        if !callback.entered.load(Ordering::Acquire) {
            replies.remove(&id);
        }
    }

    pub(super) fn retire_tool_completion(&self, turn: Option<&str>) {
        let ids: Vec<_> = self
            .completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned")
            .iter()
            .filter(|(_, pending)| turn.is_none_or(|turn| turn == pending.owner.turn))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.retire_terminal_callback(id);
        }
    }

    pub(super) async fn finish_terminal_callbacks(&self, turn: Option<&str>, cancel: bool) {
        if cancel {
            self.retire_tool_completion(turn);
        }
        let callbacks: Vec<_> = self
            .completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned")
            .iter()
            .filter(|(_, pending)| turn.is_none_or(|turn| turn == pending.owner.turn))
            .filter_map(|(id, pending)| pending.callback.clone().map(|callback| (*id, callback)))
            .collect();
        for (id, callback) in callbacks {
            if !callback.entered.load(Ordering::Acquire) {
                callback.release();
            }
            callback.wait().await;
            let mut replies = self
                .completion_replies
                .lock()
                .expect("JavaScript completion replies poisoned");
            if replies
                .get(&id)
                .and_then(|pending| pending.callback.as_ref())
                .is_some_and(|current| Arc::ptr_eq(current, &callback))
            {
                replies.remove(&id);
            }
        }
    }
}

fn resolve_tool(
    input: &ToolCompletionInput<'_>,
    tools: &PythonTools,
    catalog: &StepCatalog,
    name: &ToolName,
) -> std::result::Result<Option<(Arc<Generation>, usize)>, String> {
    let profile = tools
        .source_profile(Some(input.step_store))
        .map_err(|error| error.to_string())?;
    Ok(std::iter::once(catalog.generation.clone())
        .chain(admitted_client_generations(
            input.thread_store,
            &catalog.generation,
            &profile,
        ))
        .find_map(|generation| {
            let slot = generation
                .entries
                .iter()
                .position(|entry| entry.name.clone().with_default_namespace() == *name)?;
            Some((generation, slot))
        }))
}

pub(super) fn hold(input: ToolCompletionInput<'_>) -> bool {
    let Some(tools) = input.thread_store.get::<PythonTools>() else {
        return false;
    };
    let Some(catalog) = input.step_store.get::<StepCatalog>() else {
        return false;
    };
    let ResponseItem::FunctionCall {
        name,
        namespace,
        call_id,
        ..
    } = input.call
    else {
        return false;
    };
    let name = ToolName::new(namespace.clone(), name.clone()).with_default_namespace();
    let Ok(Some((generation, slot))) = resolve_tool(&input, &tools, &catalog, &name) else {
        return false;
    };
    if !generation.terminal_slots.contains(&slot)
        || !tools.current_completion_owner(input.thread_store.level_id())
        || !tools.admits_generation(&generation)
    {
        return false;
    }
    catalog
        .receipts
        .lock()
        .expect("JavaScript completion receipts poisoned")
        .iter()
        .any(|key| {
            key.reply.thread == input.thread_store.level_id()
                && key.reply.instance == tools.instance
                && key.reply.generation == generation.id
                && key.reply.slot == slot
                && key.turn == input.turn_id
                && key.call == *call_id
        })
}

pub(super) async fn propose(
    input: ToolCompletionInput<'_>,
) -> std::result::Result<Option<ToolCompletionDecision>, String> {
    let Some(tools) = input.thread_store.get::<PythonTools>() else {
        return Ok(None);
    };
    let Some(catalog) = input.step_store.get::<StepCatalog>() else {
        return Ok(None);
    };
    if let Some(fresh) = input
        .turn_store
        .get::<super::recovered_completion::FreshTerminalReceipts>()
    {
        fresh
            .adopt(&tools, &catalog)
            .map_err(|error| error.to_string())?;
    }
    let ResponseItem::FunctionCall {
        name,
        namespace,
        call_id,
        ..
    } = input.call
    else {
        return Ok(None);
    };
    let name = ToolName::new(namespace.clone(), name.clone()).with_default_namespace();
    let Some((generation, slot)) = resolve_tool(&input, &tools, &catalog, &name)? else {
        return Ok(None);
    };
    if !generation.terminal_slots.contains(&slot) {
        return Ok(None);
    }
    if !tools.current_completion_owner(input.thread_store.level_id())
        || !tools.admits_generation(&generation)
    {
        return Err("Expired terminal tool generation".into());
    }
    let key = catalog
        .receipts
        .lock()
        .expect("JavaScript completion receipts poisoned")
        .iter()
        .find(|key| {
            key.reply.thread == input.thread_store.level_id()
                && key.reply.instance == tools.instance
                && key.reply.generation == generation.id
                && key.reply.slot == slot
                && key.turn == input.turn_id
                && key.call == *call_id
        })
        .cloned();
    let held = input
        .turn_store
        .get::<codex_extension_api::HeldToolCompletionResults>();
    let is_held = || {
        held.as_ref().is_some_and(|held| {
            held.outputs
                .lock()
                .expect("held terminal outputs poisoned")
                .iter()
                .any(|(item, _)| item.item == *input.output)
        })
    };
    let guard_only = input.guard_only || key.is_none();
    if input.guard_only && !is_held() {
        return Ok(None);
    }
    if guard_only && !is_held() {
        return Err("Missing accepted terminal tool receipt".into());
    }
    // This pending callback identity carries no tool grant or accepted receipt.
    let key = key.unwrap_or_else(|| PendingKey {
        reply: ReplyKey {
            thread: input.thread_store.level_id().to_owned(),
            instance: tools.instance.clone(),
            generation: generation.id,
            slot,
            manual_grant: None,
        },
        turn: input.turn_id.to_owned(),
        call: call_id.clone(),
    });
    let ResponseItem::FunctionCallOutput {
        call_id: output_id,
        output,
        ..
    } = input.output
    else {
        return Err("Invalid settled terminal tool output".into());
    };
    if output_id.as_ref() != Some(call_id) {
        return Err("Mismatched terminal tool output".into());
    }
    let entry = &generation.entries[slot];
    let request = json!({
        "type":"_sdk_tool_completion", "_sdk_python_tool":key.reply,
        "slot":slot, "tool":{"name":entry.name.name,"namespace":entry.name.namespace},
        "call_id":call_id, "output":output.body, "guard_only":guard_only
    });
    let decision = exchange(&input, tools, generation, guard_only, false, request).await?;
    match decision {
        ReplyValue::Accept(final_output) => {
            if guard_only {
                if !is_held() {
                    return Err("Expired held terminal candidate".into());
                }
                Ok(None)
            } else {
                Ok(Some(ToolCompletionDecision::Accept { final_output }))
            }
        }
        ReplyValue::Continue(feedback) => Ok(Some(ToolCompletionDecision::Continue { feedback })),
    }
}

async fn exchange(
    input: &ToolCompletionInput<'_>,
    tools: Arc<PythonTools>,
    generation: Arc<Generation>,
    guard_only: bool,
    batch: bool,
    mut message: Value,
) -> std::result::Result<ReplyValue, String> {
    if !tools.current_completion_owner(input.thread_store.level_id())
        || !tools.admits_generation(&generation)
    {
        return Err("Expired terminal completion generation".into());
    }
    let owner = CompletionOwner {
        thread: input.thread_store.level_id().to_owned(),
        instance: tools.instance.clone(),
        turn: input.turn_id.to_owned(),
    };
    let id = tools.family.next_step.fetch_add(1, Ordering::Relaxed);
    let (sender, receive) = oneshot::channel();
    message["thread"] = json!(owner.thread);
    message["instance"] = json!(owner.instance);
    message["turn_id"] = json!(owner.turn);
    message["generation"] = json!(generation.id.to_string());
    message["request_id"] = json!(id.to_string());
    message["native_step"] = json!(input.step_store.level_id());
    message["model"] = json!(input.model);
    message["continuation_count"] = json!(input.continuation_count);
    let mut request = json!({"id":input.turn_id,"msg":message});
    if let Some(profile) = tools
        .source_profile(Some(input.step_store))
        .map_err(|error| error.to_string())?
    {
        request["msg"]["profile_id"] = json!(profile.profile_id);
        request["msg"]["profile_epoch"] = json!(profile.epoch);
    }
    if let Some(instance) = &tools.instance {
        request["subagent_id"] = json!(input.thread_store.level_id());
        request["subagent_incarnation"] = json!(instance);
        request["subagent_managed_tools"] = json!(true);
    }
    if !guard_only && let Some(turn) = input.turn_store.get::<crate::turn_settlement::Turn>() {
        *turn
            .tool_proposal
            .lock()
            .expect("terminal proposal poisoned") = Some(TerminalProposal {
            generation: generation.clone(),
            owner: owner.clone(),
            step: input.step_store.level_id().to_owned(),
            request_id: id,
            failed: false,
            settlement: input
                .thread_store
                .get::<crate::turn_settlement::Settlement>()
                .map(|owner| Arc::downgrade(&owner))
                .unwrap_or_default(),
        });
    }
    tools
        .completion_replies
        .lock()
        .expect("JavaScript completion replies poisoned")
        .insert(
            id,
            Pending {
                owner,
                generation: generation.clone(),
                step: input.step_store.level_id().to_owned(),
                sender,
                callback: None,
                stop: None,
            },
        );
    let _wait = Wait {
        tools: tools.clone(),
        id,
    };
    let callback_enabled = batch
        || (tools.context_callbacks.before_complete
            && tools
                .source_catalog(Some(input.step_store))
                .map_err(|error| error.to_string())?
                .is_none_or(|source| source.before_complete));
    let stop = tools.context_stop(input.turn_id).ok();
    if callback_enabled && stop.is_none() {
        return Err("Expired terminal completion owner".into());
    }
    let callback = callback_enabled.then(|| {
        let mut receipt = json!({"kind":"preparation", "thread":input.thread_store.level_id(), "id":id.to_string()});
        if let Some(instance) = &tools.instance { receipt["instance"] = json!(instance); }
        CallbackRelease::new(receipt)
    });
    if let Some(callback) = &callback {
        request["msg"]["_sdk_callback"] = callback.receipt.clone();
    }
    {
        let mut replies = tools
            .completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned");
        let pending = replies.get_mut(&id).ok_or("Expired terminal completion")?;
        pending.callback = callback.clone();
        pending.stop = stop;
    }
    tools
        .family
        .requests
        .send(FamilyRequest::Completion(
            Arc::downgrade(&tools),
            id,
            request,
        ))
        .map_err(|_| "Terminal completion reader closed")?;
    let received = receive.await.map_err(|_| "Terminal completion cancelled");
    if let Some(callback) = &callback {
        {
            let replies = tools
                .completion_replies
                .lock()
                .expect("JavaScript completion replies poisoned");
            if replies
                .get(&id)
                .is_some_and(|pending| pending.sender.is_closed())
                && !callback.entered.load(Ordering::Acquire)
            {
                callback.release();
            }
        }
        if received.is_err() {
            tools.retire_terminal_callback(id);
        }
        callback.wait().await;
        tools
            .completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned")
            .remove(&id);
    }
    let decision = received??;
    if !tools.current_completion_owner(input.thread_store.level_id())
        || !tools.admits_generation(&generation)
    {
        return Err("Expired terminal tool generation".into());
    }
    if matches!(decision, ReplyValue::Continue(_)) {
        if let Some(turn) = input.turn_store.get::<crate::turn_settlement::Turn>() {
            let mut proposal = turn
                .tool_proposal
                .lock()
                .expect("terminal proposal poisoned");
            if proposal
                .as_ref()
                .is_some_and(|proposal| proposal.request_id == id)
            {
                proposal.take();
            }
        }
    }
    Ok(decision)
}

pub(super) fn batch_enabled(thread: &ExtensionData, step: &ExtensionData) -> bool {
    if let Some(catalog) = step.get::<ProfileCatalog>() {
        return catalog.tool_batch_completion;
    }
    thread
        .get::<PythonTools>()
        .is_some_and(|tools| tools.context_callbacks.tool_batch_completion)
}

pub(super) async fn propose_batch(
    input: codex_extension_api::ToolBatchCompletionInput<'_>,
) -> std::result::Result<Option<ToolCompletionDecision>, String> {
    let Some(tools) = input.thread_store.get::<PythonTools>() else {
        return Ok(None);
    };
    let Some(catalog) = input.step_store.get::<StepCatalog>() else {
        return Ok(None);
    };
    let first = input.results.first().ok_or("Empty settled tool batch")?;
    let mut results = Vec::with_capacity(input.results.len());
    for result in input.results {
        let (
            ResponseItem::FunctionCall {
                call_id,
                name,
                namespace,
                arguments,
                ..
            },
            ResponseItem::FunctionCallOutput {
                call_id: Some(output_id),
                output,
                ..
            },
        ) = (result.call, result.output)
        else {
            return Err("Invalid settled tool batch".into());
        };
        if call_id != output_id {
            return Err("Mismatched settled tool batch output".into());
        }
        results.push(json!({"call_id":call_id,"name":name,"namespace":namespace,
            "arguments":arguments,"output":output.body,"succeeded":result.succeeded}));
    }
    let direct = ToolCompletionInput {
        guard_only: false,
        continuation_count: input.continuation_count,
        turn_id: input.turn_id,
        model: input.model,
        call: first.call,
        output: first.output,
        thread_store: input.thread_store,
        turn_store: input.turn_store,
        step_store: input.step_store,
    };
    let decision = exchange(
        &direct,
        tools,
        catalog.generation.clone(),
        false,
        true,
        json!({"type":"_sdk_tool_batch_completion","results":results}),
    )
    .await?;
    Ok(Some(match decision {
        ReplyValue::Accept(final_output) => ToolCompletionDecision::Accept { final_output },
        ReplyValue::Continue(feedback) => ToolCompletionDecision::Continue { feedback },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(value: Value) -> CompletionReply {
        serde_json::from_value(value).unwrap()
    }
    fn envelope() -> Value {
        json!({"thread":"root","instance":null,"turn_id":"turn","generation":"0",
            "request_id":"17","native_step":"step"})
    }
    fn pending(tools: &PythonTools) -> oneshot::Receiver<std::result::Result<ReplyValue, String>> {
        let (sender, receive) = oneshot::channel();
        tools.completion_replies.lock().unwrap().insert(
            17,
            Pending {
                owner: CompletionOwner {
                    thread: "root".into(),
                    instance: None,
                    turn: "turn".into(),
                },
                generation: tools.snapshot(),
                step: "step".into(),
                sender,
                callback: None,
                stop: None,
            },
        );
        receive
    }

    #[tokio::test]
    async fn captured_completion_rejects_a_different_arc_even_with_the_same_generation_id() {
        let tools = super::super::pending_tests::tools();
        let source = tools
            .profile_catalog(
                tools.snapshot().specs.clone(),
                &[],
                &[0],
                &[],
                None,
                [false; 6],
                false,
            )
            .unwrap();
        let receive = pending(&tools);
        let mut value = envelope();
        value["generation"] = json!(source.generation.id.to_string());
        value["final_output"] = json!("accepted");
        {
            let mut pending = tools.completion_replies.lock().unwrap();
            let captured = pending.get_mut(&17).unwrap();
            captured.generation = source.generation.clone();
        }
        assert!(tools.completion_queued(17));
        assert!(tools.check_tool_completion(&reply(value.clone())).unwrap());
        tools
            .completion_replies
            .lock()
            .unwrap()
            .get_mut(&17)
            .unwrap()
            .generation = Arc::new((*source.generation).clone());
        assert!(!tools.completion_queued(17));
        assert!(!tools.check_tool_completion(&reply(value.clone())).unwrap());
        assert!(!tools.reply_tool_completion(reply(value.clone())).unwrap());
        tools
            .completion_replies
            .lock()
            .unwrap()
            .get_mut(&17)
            .unwrap()
            .generation = source.generation.clone();
        assert!(tools.reply_tool_completion(reply(value)).unwrap());
        assert_eq!(
            receive.await.unwrap().unwrap(),
            ReplyValue::Accept(json!("accepted"))
        );
        assert_eq!(tools.snapshot().id, 0);
    }

    #[tokio::test]
    async fn proposal_requires_current_step_receipt_and_uses_settled_body() {
        assert_proposal_receipt(false).await;
    }

    #[tokio::test]
    async fn captured_profile_proposal_queues_matches_and_accepts_without_default_catalog_mutation()
    {
        assert_proposal_receipt(true).await;
    }

    async fn assert_proposal_receipt(captured: bool) {
        let thread = ExtensionData::new("root");
        let tools = thread.get_or_init(|| {
            Arc::try_unwrap(super::super::pending_tests::tools())
                .ok()
                .unwrap()
        });

        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("turn");
        let step = ExtensionData::new("step");
        if captured {
            let source = tools
                .profile_catalog(
                    tools.snapshot().specs.clone(),
                    &[],
                    &[0],
                    &[],
                    None,
                    [false; 6],
                    false,
                )
                .unwrap();
            assert_ne!(source.generation.id, tools.snapshot().id);
            step.get_or_init(|| source);
        } else {
            tools
                .configure_terminal(TerminalSlots {
                    generation: "0".into(),
                    slots: vec![0],
                    input_error_slots: Vec::new(),
                })
                .unwrap();
        }
        PythonContributor::default().tools_for_step(&session, &thread, &step);
        let call: ResponseItem = serde_json::from_value(
            json!({"type":"function_call", "name":"decision", "arguments":"{}", "call_id":"call"}),
        )
        .unwrap();
        let output: ResponseItem = serde_json::from_value(json!({"type":"function_call_output", "call_id":"call", "output":"settled after hooks"})).unwrap();
        let input = || ToolCompletionInput {
            guard_only: false,
            continuation_count: 0,
            turn_id: "turn",
            model: "fixture-model",
            call: &call,
            output: &output,
            thread_store: &thread,
            turn_store: &turn,
            step_store: &step,
        };
        assert!(propose(input()).await.err().unwrap().contains("receipt"));
        let catalog = step.get::<StepCatalog>().unwrap();
        let key = PendingKey {
            reply: ReplyKey {
                thread: "root".into(),
                instance: None,
                generation: catalog.generation.id,
                slot: 0,
                manual_grant: None,
            },
            turn: "turn".into(),
            call: "call".into(),
        };
        catalog.receipts.lock().unwrap().insert(key);
        let mut proposing = Box::pin(propose(input()));
        assert!(futures_util::poll!(&mut proposing).is_pending());
        let event = tools.next_request().await;
        assert_eq!(event["msg"]["output"], json!("settled after hooks"));
        let msg = &event["msg"];
        let response = json!({"thread":"root", "instance":null, "turn_id":"turn", "generation":catalog.generation.id.to_string(),
            "request_id":msg["request_id"], "native_step":"step", "final_output":{"answer":7}});
        assert!(tools.reply_tool_completion(reply(response)).unwrap());
        let result = proposing.await.unwrap().unwrap();
        assert!(
            matches!(result, ToolCompletionDecision::Accept { final_output } if final_output == json!({"answer":7}))
        );
        assert!(tools.completion_replies.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn proposal_error_needs_failed_idle_and_exact_native_owner_before_failure_notice() {
        assert_failed_proposal(false).await;
    }

    #[tokio::test]
    async fn captured_profile_failure_is_delivered_only_after_exact_failed_idle() {
        assert_failed_proposal(true).await;
    }

    async fn assert_failed_proposal(captured: bool) {
        let thread = ExtensionData::new("root");
        let tools = thread.get_or_init(|| {
            Arc::try_unwrap(super::super::pending_tests::tools())
                .ok()
                .unwrap()
        });
        let session = ExtensionData::new("session");
        let turn_store = ExtensionData::new("turn");
        let mode = serde_json::from_value(json!({"mode":"default","settings":{"model":"fixture","reasoning_effort":null,"developer_instructions":null}})).unwrap();
        crate::turn_settlement::Contributor
            .on_turn_start(TurnStartInput {
                turn_id: "turn",
                collaboration_mode: &mode,
                token_usage_at_turn_start: None,
                session_store: &session,
                thread_store: &thread,
                turn_store: &turn_store,
            })
            .await;
        let turn = turn_store.get::<crate::turn_settlement::Turn>().unwrap();
        let settlement = thread.get::<crate::turn_settlement::Settlement>().unwrap();
        let generation = if captured {
            tools
                .profile_catalog(
                    tools.snapshot().specs.clone(),
                    &[],
                    &[0],
                    &[],
                    None,
                    [false; 6],
                    false,
                )
                .unwrap()
                .generation
        } else {
            tools.snapshot()
        };
        *turn.tool_proposal.lock().unwrap() = Some(TerminalProposal {
            generation: generation.clone(),
            owner: CompletionOwner {
                thread: "root".into(),
                instance: None,
                turn: "turn".into(),
            },
            step: "step".into(),
            request_id: 17,
            failed: false,
            settlement: Arc::downgrade(&settlement),
        });
        tools.mark_tool_failure(&turn);
        assert!(!tools.has_pending_request());
        crate::turn_settlement::Contributor
            .on_thread_idle(ThreadIdleInput {
                cause: codex_extension_api::ThreadIdleCause::Completed,
                session_store: &session,
                thread_store: &thread,
            })
            .await;
        assert!(!tools.has_pending_request());
        crate::turn_settlement::Contributor
            .on_thread_idle(ThreadIdleInput {
                cause: codex_extension_api::ThreadIdleCause::Failed,
                session_store: &session,
                thread_store: &thread,
            })
            .await;
        let notice = tokio::time::timeout(std::time::Duration::from_secs(1), tools.next_request())
            .await
            .unwrap();
        assert_eq!(notice["msg"]["type"], "_sdk_tool_completion_failed");
        assert_eq!(notice["msg"]["request_id"], "17");
        assert_eq!(notice["msg"]["native_step"], "step");
        assert!(turn.tool_proposal.lock().unwrap().is_none());
        turn.wait().await.unwrap();
        assert!(!settlement.can_continue_id("turn"));
    }

    #[test]
    fn terminal_slots_are_private_default_off_and_inherited_from_current_generation() {
        let tools = super::super::pending_tests::tools();
        assert!(tools.snapshot().terminal_slots.is_empty());
        let specs = tools.current_specs().unwrap();
        tools
            .configure_terminal(TerminalSlots {
                generation: "0".into(),
                slots: vec![0],
                input_error_slots: Vec::new(),
            })
            .unwrap();
        assert_eq!(tools.current_specs().unwrap(), specs);
        assert_eq!(tools.snapshot().terminal_slots, HashSet::from([0]));
        let child = PythonTools::descendant(&tools, "child".into(), Arc::default(), None).unwrap();
        assert_eq!(child.snapshot().terminal_slots, HashSet::from([0]));
        assert!(
            tools
                .configure_terminal(TerminalSlots {
                    generation: "1".into(),
                    slots: vec![0],
                    input_error_slots: Vec::new(),
                })
                .is_err()
        );
        assert!(
            tools
                .configure_terminal(TerminalSlots {
                    generation: "0".into(),
                    slots: vec![1],
                    input_error_slots: Vec::new(),
                })
                .is_err()
        );
        assert!(
            tools
                .configure_terminal(TerminalSlots {
                    generation: "0".into(),
                    slots: vec![0, 0],
                    input_error_slots: Vec::new(),
                })
                .is_err()
        );
    }

    #[tokio::test]
    async fn exact_nonce_accepts_null_once_and_rejects_every_changed_owner_field() {
        let tools = super::super::pending_tests::tools();
        let receive = pending(&tools);
        for field in [
            "thread",
            "instance",
            "turn_id",
            "generation",
            "request_id",
            "native_step",
        ] {
            let mut changed = envelope();
            changed[field] = json!("other");
            // Non-numeric request ids fail parsing rather than yielding authority.
            assert!(
                !tools
                    .check_tool_completion(&reply(changed))
                    .unwrap_or(false)
            );
        }
        assert!(tools.check_tool_completion(&reply(envelope())).unwrap());
        let mut accepted = envelope();
        accepted["final_output"] = Value::Null;
        assert!(
            tools
                .reply_tool_completion(reply(accepted.clone()))
                .unwrap()
        );
        assert_eq!(
            receive.await.unwrap().unwrap(),
            ReplyValue::Accept(Value::Null)
        );
        assert!(!tools.reply_tool_completion(reply(accepted)).unwrap());
    }

    #[tokio::test]
    async fn retirement_drops_original_waiter_and_never_replies_to_successor() {
        let tools = super::super::pending_tests::tools();
        let receive = pending(&tools);
        tools.retire_tool_completion(Some("other"));
        assert!(tools.check_tool_completion(&reply(envelope())).unwrap());
        tools.retire_tool_completion(Some("turn"));
        assert!(receive.await.is_err());
        assert!(!tools.check_tool_completion(&reply(envelope())).unwrap());
    }

    #[test]
    fn generation_identity_and_dropped_future_expire_authority() {
        let tools = super::super::pending_tests::tools();
        let receive = pending(&tools);
        let generation = (*tools.snapshot()).clone();
        *tools.current.write().unwrap() = Arc::new(generation);
        assert!(!tools.check_tool_completion(&reply(envelope())).unwrap());
        let _guard = Wait {
            tools: tools.clone(),
            id: 17,
        };
        drop(_guard);
        assert!(tools.completion_replies.lock().unwrap().is_empty());
        drop(receive);
    }

    #[tokio::test]
    async fn invalid_reply_keeps_failure_channel_and_host_failure_is_terminal_error() {
        let tools = super::super::pending_tests::tools();
        let receive = pending(&tools);
        assert!(tools.reply_tool_completion(reply(envelope())).is_err());
        assert!(tools.check_tool_completion(&reply(envelope())).unwrap());
        let mut failed = envelope();
        failed["error"] = json!("application details remain on owning host");
        assert!(tools.reply_tool_completion(reply(failed)).unwrap());
        assert_eq!(
            receive.await.unwrap().unwrap_err(),
            "Terminal output conversion failed"
        );
    }
}

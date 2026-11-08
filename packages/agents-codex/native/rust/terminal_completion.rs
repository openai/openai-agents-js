//! Current-step receipts and owned host conversion for terminal function results.
use super::*;
use codex_extension_api::{ToolCompletionDecision, ToolCompletionInput};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TerminalSlots {
    generation: String,
    slots: Vec<usize>,
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

pub(super) struct Pending {
    key: PendingKey,
    generation: Arc<Generation>,
    step: String,
    sender: oneshot::Sender<std::result::Result<Value, String>>,
}

#[derive(Clone)]
pub(crate) struct TerminalProposal {
    generation: Arc<Generation>,
    key: PendingKey,
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
        self.tools
            .completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned")
            .remove(&self.id);
    }
}

impl PythonTools {
    pub(crate) fn mark_tool_failure(&self, turn: &crate::turn_settlement::Turn) {
        if let Some(proposal) = turn
            .tool_proposal
            .lock()
            .expect("terminal proposal poisoned")
            .as_mut()
            && Arc::ptr_eq(&self.snapshot(), &proposal.generation)
            && self.current_completion_owner(&proposal.key.reply.thread)
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
        if !Arc::ptr_eq(&self.snapshot(), &proposal.generation) {
            return;
        }
        let mut request = json!({"id":proposal.key.turn,"msg":{
            "type":"_sdk_tool_completion_failed", "thread":proposal.key.reply.thread,
            "instance":self.instance, "turn_id":proposal.key.turn,
            "generation":proposal.generation.id.to_string(),
            "request_id":proposal.request_id.to_string(), "native_step":proposal.step
        }});
        if let Some(instance) = &self.instance {
            request["subagent_id"] = json!(proposal.key.reply.thread);
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
        self.current_completion_owner(&proposal.key.reply.thread)
            && Arc::ptr_eq(&self.snapshot(), &proposal.generation)
            && turn.tool_failure_ready()
            && request["msg"]["request_id"] == proposal.request_id.to_string()
            && proposal
                .settlement
                .upgrade()
                .and_then(|owner| owner.matching(&proposal.key.turn))
                .is_some_and(|current| Arc::ptr_eq(&current, turn))
    }

    pub(crate) fn configure_terminal(&self, config: TerminalSlots) -> Result<()> {
        let current = self.snapshot();
        ensure!(
            current.id.to_string() == config.generation,
            "Expired terminal configuration generation"
        );
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
                slot < current.entries.len() && slots.insert(slot),
                "Invalid terminal tool slot"
            );
        }
        let mut generation = (*current).clone();
        generation.terminal_slots = slots;
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
        self.current_completion_owner(&pending.key.reply.thread)
            && response.thread == pending.key.reply.thread
            && response.instance == self.instance
            && response.instance == pending.key.reply.instance
            && response.turn_id == pending.key.turn
            && response.generation == pending.generation.id.to_string()
            && response.native_step == pending.step
            && Arc::ptr_eq(&self.snapshot(), &pending.generation)
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
                self.current_completion_owner(&pending.key.reply.thread)
                    && Arc::ptr_eq(&self.snapshot(), &pending.generation)
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
            // Invalid payloads leave their original waiter available for a failure reply.
            ensure!(
                response.value.len() == 1
                    && (response.value.contains_key("final_output")
                        || response.value.get("error").is_some_and(Value::is_string)),
                "Invalid terminal conversion reply"
            );
            replies.remove(&id).expect("checked completion reply")
        };
        let value = match response.value.get("final_output") {
            Some(value) => Ok(value.clone()),
            None => Err("Terminal output conversion failed".into()),
        };
        Ok(pending.sender.send(value).is_ok())
    }

    pub(super) fn retire_tool_completion(&self, turn: Option<&str>) {
        self.completion_replies
            .lock()
            .expect("JavaScript completion replies poisoned")
            .retain(|_, pending| turn.is_some_and(|turn| turn != pending.key.turn));
    }
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
    let Some(slot) = catalog
        .generation
        .entries
        .iter()
        .position(|entry| entry.name.clone().with_default_namespace() == name)
    else {
        return Ok(None);
    };
    if !catalog.generation.terminal_slots.contains(&slot) {
        return Ok(None);
    }
    if !tools.current_completion_owner(input.thread_store.level_id())
        || !Arc::ptr_eq(&tools.snapshot(), &catalog.generation)
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
                && key.reply.generation == catalog.generation.id
                && key.reply.slot == slot
                && key.turn == input.turn_id
                && key.call == *call_id
        })
        .cloned()
        .ok_or("Missing accepted terminal tool receipt")?;
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
    let id = tools.family.next_step.fetch_add(1, Ordering::Relaxed);
    let (sender, receive) = oneshot::channel();
    // These are data sent for host conversion. Only the owned nonce can reply.
    let entry = &catalog.generation.entries[slot];
    let mut request = json!({"id":input.turn_id,"msg":{
        "type":"_sdk_tool_completion", "thread":input.thread_store.level_id(),
        "instance":tools.instance, "turn_id":input.turn_id,
        "generation":catalog.generation.id.to_string(), "request_id":id.to_string(),
        "native_step":input.step_store.level_id(), "slot":slot,
        "tool":{"name":entry.name.name,"namespace":entry.name.namespace},
        "call_id":call_id, "output":output.body
    }});
    if let Some(instance) = &tools.instance {
        request["subagent_id"] = json!(input.thread_store.level_id());
        request["subagent_incarnation"] = json!(instance);
        request["subagent_managed_tools"] = json!(true);
    }
    if let Some(turn) = input.turn_store.get::<crate::turn_settlement::Turn>() {
        *turn
            .tool_proposal
            .lock()
            .expect("terminal proposal poisoned") = Some(TerminalProposal {
            generation: catalog.generation.clone(),
            key: key.clone(),
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
                key,
                generation: catalog.generation.clone(),
                step: input.step_store.level_id().to_owned(),
                sender,
            },
        );
    let _wait = Wait {
        tools: tools.clone(),
        id,
    };
    tools
        .family
        .requests
        .send(FamilyRequest::Completion(
            Arc::downgrade(&tools),
            id,
            request,
        ))
        .map_err(|_| "Terminal completion reader closed")?;
    let final_output = receive
        .await
        .map_err(|_| "Terminal completion cancelled")??;
    if !tools.current_completion_owner(input.thread_store.level_id())
        || !Arc::ptr_eq(&tools.snapshot(), &catalog.generation)
    {
        return Err("Expired terminal tool generation".into());
    }
    Ok(Some(ToolCompletionDecision::Accept { final_output }))
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
    fn pending(tools: &PythonTools) -> oneshot::Receiver<std::result::Result<Value, String>> {
        let (sender, receive) = oneshot::channel();
        tools.completion_replies.lock().unwrap().insert(
            17,
            Pending {
                key: PendingKey {
                    reply: ReplyKey {
                        thread: "root".into(),
                        instance: None,
                        generation: 0,
                        slot: 0,
                        manual_grant: None,
                    },
                    turn: "turn".into(),
                    call: "call".into(),
                },
                generation: tools.snapshot(),
                step: "step".into(),
                sender,
            },
        );
        receive
    }

    #[tokio::test]
    async fn proposal_requires_current_step_receipt_and_uses_settled_body() {
        let thread = ExtensionData::new("root");
        let tools = thread.get_or_init(|| {
            Arc::try_unwrap(super::super::pending_tests::tools())
                .ok()
                .unwrap()
        });
        tools
            .configure_terminal(TerminalSlots {
                generation: "0".into(),
                slots: vec![0],
            })
            .unwrap();
        let session = ExtensionData::new("session");
        let turn = ExtensionData::new("turn");
        let step = ExtensionData::new("step");
        PythonContributor::default().tools_for_step(&session, &thread, &step);
        let call: ResponseItem = serde_json::from_value(
            json!({"type":"function_call", "name":"decision", "arguments":"{}", "call_id":"call"}),
        )
        .unwrap();
        let output: ResponseItem = serde_json::from_value(json!({"type":"function_call_output", "call_id":"call", "output":"settled after hooks"})).unwrap();
        let input = || ToolCompletionInput {
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
                generation: 0,
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
        let response = json!({"thread":"root", "instance":null, "turn_id":"turn", "generation":"0",
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
        *turn.tool_proposal.lock().unwrap() = Some(TerminalProposal {
            generation: tools.snapshot(),
            key: PendingKey {
                reply: ReplyKey {
                    thread: "root".into(),
                    instance: None,
                    generation: 0,
                    slot: 0,
                    manual_grant: None,
                },
                turn: "turn".into(),
                call: "call".into(),
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
        let notice = tools.next_request().await;
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
            })
            .unwrap();
        assert_eq!(tools.current_specs().unwrap(), specs);
        assert_eq!(tools.snapshot().terminal_slots, HashSet::from([0]));
        let child = PythonTools::descendant(&tools, "child".into(), Arc::default()).unwrap();
        assert_eq!(child.snapshot().terminal_slots, HashSet::from([0]));
        assert!(
            tools
                .configure_terminal(TerminalSlots {
                    generation: "1".into(),
                    slots: vec![0]
                })
                .is_err()
        );
        assert!(
            tools
                .configure_terminal(TerminalSlots {
                    generation: "0".into(),
                    slots: vec![1]
                })
                .is_err()
        );
        assert!(
            tools
                .configure_terminal(TerminalSlots {
                    generation: "0".into(),
                    slots: vec![0, 0]
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
        assert_eq!(receive.await.unwrap().unwrap(), Value::Null);
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

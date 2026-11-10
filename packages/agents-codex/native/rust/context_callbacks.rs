//! Request-only context edits and natural completion decisions share the preparation ledger.

use super::*;
use crate::native_interception::CapturedTurnStop;
use codex_extension_api::{CompactionInput, ModelContextInput, TurnCompletionInput};
use tokio_util::sync::CancellationToken;

pub(super) enum PreparationReply {
    Selection(oneshot::Sender<Option<Vec<ToolName>>>),
    Context(oneshot::Sender<std::result::Result<Option<Vec<ResponseItem>>, ()>>),
    Compaction(oneshot::Sender<std::result::Result<Option<String>, ()>>),
    Completion {
        reply: oneshot::Sender<std::result::Result<Option<String>, ()>>,
        stop: Arc<CapturedTurnStop>,
    },
}

impl PreparationReply {
    pub(super) fn is_closed(&self) -> bool {
        match self {
            Self::Selection(reply) => reply.is_closed(),
            Self::Context(reply) => reply.is_closed(),
            Self::Compaction(reply) => reply.is_closed(),
            Self::Completion { reply, .. } => reply.is_closed(),
        }
    }
    pub(super) fn is_selection(&self) -> bool {
        matches!(self, Self::Selection(_))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ContextReply {
    pub(crate) owner: StepReply,
    items: Option<Vec<Value>>,
    #[serde(default)]
    failed: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum CompletionDecision {
    Continue { instructions: String },
    Stop,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompletionReply {
    pub(crate) owner: StepReply,
    decision: Option<CompletionDecision>,
    #[serde(default)]
    failed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompactionReply {
    pub(crate) owner: StepReply,
    summary: Option<String>,
    #[serde(default)]
    failed: bool,
}

impl PythonTools {
    pub(crate) fn transforms_context(&self) -> bool {
        self.context_callbacks.transform_context
    }

    pub(crate) fn customizes_compaction(&self) -> bool {
        self.context_callbacks.before_compact
    }

    pub(crate) async fn before_compact(
        self: &Arc<Self>,
        input: CompactionInput<'_>,
    ) -> Result<Option<String>> {
        if !self.customizes_compaction()
            || self
                .source_catalog(input.step_store)?
                .is_some_and(|catalog| !catalog.before_compact)
        {
            return Ok(None);
        }
        let cancellation = self
            .context_stop(input.turn_id)?
            .callback_cancellation()
            .context("Expired compaction callback turn")?;
        self.exchange_context(input.step_store, input.thread_id, input.turn_id, cancellation,
            json!({"type":"_sdk_before_compact", "model":input.model, "automatic":input.automatic, "items":input.items}),
            PreparationReply::Compaction).await
    }

    pub(crate) fn reply_compaction(&self, response: CompactionReply) -> Result<()> {
        ensure!(
            !(response.failed && response.summary.is_some()),
            "Conflicting compaction reply"
        );
        if let Some(summary) = &response.summary {
            ensure!(
                !summary.trim().is_empty(),
                "Compaction summary must be nonempty"
            );
        }
        let active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        let mut replies = self
            .step_replies
            .lock()
            .expect("JavaScript step replies poisoned");
        let id = crate::native_id(&response.owner.request_id)?;
        ensure!(
            replies.get(&id).is_some_and(|pending| self.step_matches(
                &response.owner.thread,
                &response.owner,
                active.as_ref(),
                pending
            ) && matches!(
                pending.reply,
                PreparationReply::Compaction(_)
            )),
            "Expired compaction reply"
        );
        let pending = take_pending_step(&mut replies, id).expect("checked compaction reply");
        let PreparationReply::Compaction(reply) = pending.reply else {
            unreachable!()
        };
        reply
            .send(if response.failed {
                Err(())
            } else {
                Ok(response.summary)
            })
            .map_err(|_| anyhow::anyhow!("Expired compaction reply"))
    }

    pub(super) fn context_stop(&self, turn: &str) -> Result<Arc<CapturedTurnStop>> {
        self.context_control
            .get()
            .and_then(Weak::upgrade)
            .and_then(|control| control.capture_turn_stop(turn))
            .context("Expired model callback turn")
    }

    // Reuse the same nonce, exact owner, cancellation and physical callback join as beforeStep.
    async fn exchange_context<T>(
        self: &Arc<Self>,
        step: Option<&ExtensionData>,
        thread: &str,
        turn: &str,
        cancellation: CancellationToken,
        mut message: Value,
        prepare: impl FnOnce(oneshot::Sender<std::result::Result<T, ()>>) -> PreparationReply,
    ) -> Result<T> {
        let generation = self.generation_for_step(step)?;
        let profile = self.source_profile(step)?;
        let active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned")
            .clone();
        if let Some(active) = &active {
            ensure!(
                active.turn == turn && self.admits_generation(&active.generation),
                "Expired model callback operation"
            );
        }
        ensure!(!cancellation.is_cancelled(), "Model callback cancelled");
        let id = self
            .family
            .next_step
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |id| id.checked_add(1))
            .map_err(|_| anyhow::anyhow!("Callback nonce exhausted"))?;
        let mut receipt = json!({"kind":"preparation", "thread":thread, "id":id.to_string()});
        if let Some(instance) = &self.instance {
            receipt["instance"] = json!(instance);
        }
        let callback = CallbackRelease::new(receipt);
        let (reply, receive) = oneshot::channel();
        {
            let current = self
                .selection
                .lock()
                .expect("JavaScript selection poisoned");
            let admitted = match (&active, &*current) {
                (Some(active), Some(current)) => {
                    current.turn == active.turn
                        && Arc::ptr_eq(&current.generation, &active.generation)
                }
                (None, None) => true,
                _ => false,
            };
            ensure!(
                admitted && !cancellation.is_cancelled(),
                "Expired model callback operation"
            );
            self.step_replies
                .lock()
                .expect("JavaScript step replies poisoned")
                .insert(
                    id,
                    PendingStep {
                        source_cancellation: Some(cancellation.clone()),
                        callback: Some(callback.clone()),
                        operation_generation: active
                            .as_ref()
                            .map_or(generation.id, |active| active.generation.id),
                        turn: turn.to_owned(),
                        generation: generation.id,
                        allowed: vec![],
                        reply: prepare(reply),
                    },
                );
        }
        let _wait = StepWait {
            tools: self.clone(),
            id,
        };
        message["turn_id"] = json!(turn);
        message["thread"] = json!(thread);
        message["generation"] = json!(generation.id.to_string());
        message["request_id"] = json!(id.to_string());
        message["_sdk_callback"] = callback.receipt.clone();
        if let Some(step) = step {
            message["native_step"] = json!(step.level_id());
        }
        if let Some(profile) = profile {
            message["profile_id"] = json!(profile.profile_id);
            message["profile_epoch"] = json!(profile.epoch);
        }
        let tracing = codex_otel::sdk_trace::ContextLease::capture();
        if let Some(context) = &tracing {
            message["tracing_context"] = json!(context.token());
        }
        let mut event = json!({"id":turn, "msg":message});
        if let Some(instance) = &self.instance {
            event["subagent_id"] = json!(thread);
            event["subagent_incarnation"] = json!(instance);
            event["subagent_managed_tools"] = json!(true);
        }
        self.family
            .requests
            .send(FamilyRequest::Step(Arc::downgrade(self), id, event))
            .map_err(|_| anyhow::anyhow!("Model callback reader closed"))?;
        let received = tokio::select! { biased;
            _ = cancellation.cancelled() => {
                self.retire_step_callback(id);
                Err(anyhow::anyhow!("Model callback cancelled"))
            },
            received = receive => received.context("Model callback cancelled"),
        };
        {
            let replies = self
                .step_replies
                .lock()
                .expect("JavaScript step replies poisoned");
            if replies
                .get(&id)
                .is_some_and(|pending| pending.reply.is_closed())
                && !callback.entered.load(Ordering::Acquire)
            {
                callback.release();
            }
        }
        if received.is_err() {
            self.retire_step_callback(id);
        }
        tokio::select! { biased;
            _ = cancellation.cancelled() => { self.retire_step_callback(id); callback.wait().await; },
            _ = callback.wait() => {},
        }
        self.step_replies
            .lock()
            .expect("JavaScript step replies poisoned")
            .remove(&id);
        ensure!(
            !cancellation.is_cancelled() && self.admits_generation(&generation),
            "Expired model callback owner"
        );
        let current = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        ensure!(
            match (&active, &*current) {
                (Some(active), Some(current)) =>
                    current.turn == active.turn
                        && Arc::ptr_eq(&current.generation, &active.generation),
                (None, None) => true,
                _ => false,
            },
            "Expired model callback operation"
        );
        received?.map_err(|()| anyhow::anyhow!("Model callback failed"))
    }

    pub(crate) async fn transform_context(
        self: &Arc<Self>,
        input: ModelContextInput<'_>,
    ) -> Result<()> {
        if !self.transforms_context()
            || self
                .source_catalog(input.step_store)?
                .is_some_and(|catalog| !catalog.transform_context)
        {
            return Ok(());
        }
        let cancellation = input
            .step_store
            .and_then(|step| step.get::<codex_extension_api::ToolsOnlyWorkCancellation>())
            .map(|token| token.0.clone())
            .or_else(|| {
                self.context_stop(input.turn_id)
                    .ok()
                    .and_then(|stop| stop.callback_cancellation())
            })
            .context("Expired model context turn")?;
        let result = self.exchange_context(input.step_store, input.thread_id, input.turn_id, cancellation,
            json!({"type":"_sdk_transform_context", "model":input.model, "compaction":input.compaction, "items":input.items}),
            PreparationReply::Context).await?;
        if let Some(items) = result {
            *input.items = items;
        }
        Ok(())
    }

    pub(crate) async fn before_complete(
        self: &Arc<Self>,
        input: TurnCompletionInput<'_>,
    ) -> Result<Option<String>> {
        if !self.context_callbacks.before_complete
            || self
                .source_catalog(input.step_store)?
                .is_some_and(|catalog| !catalog.before_complete)
        {
            return Ok(None);
        }
        let stop = self.context_stop(input.turn_id)?;
        let cancellation = stop
            .callback_cancellation()
            .context("Expired completion turn")?;
        self.exchange_context(input.step_store, input.thread_store.level_id(), input.turn_id, cancellation,
            json!({"type":"_sdk_before_complete", "model":input.model, "text":input.last_assistant_message, "continuation_count":input.continuation_count}),
            |reply| PreparationReply::Completion { reply, stop }).await
    }

    pub(crate) fn reply_model_context(&self, response: ContextReply) -> Result<()> {
        ensure!(
            !(response.failed && response.items.is_some()),
            "Conflicting context reply"
        );
        let items = response
            .items
            .map(codex_core_api::parse_model_context_items)
            .transpose()
            .map_err(anyhow::Error::msg)?;
        let active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        let mut replies = self
            .step_replies
            .lock()
            .expect("JavaScript step replies poisoned");
        let id = crate::native_id(&response.owner.request_id)?;
        ensure!(
            replies.get(&id).is_some_and(|pending| self.step_matches(
                &response.owner.thread,
                &response.owner,
                active.as_ref(),
                pending
            ) && matches!(
                pending.reply,
                PreparationReply::Context(_)
            )),
            "Expired model context reply"
        );
        let pending = take_pending_step(&mut replies, id).expect("checked context reply");
        let PreparationReply::Context(reply) = pending.reply else {
            unreachable!()
        };
        reply
            .send(if response.failed { Err(()) } else { Ok(items) })
            .map_err(|_| anyhow::anyhow!("Expired model context reply"))
    }

    pub(crate) fn reply_natural_completion(&self, response: CompletionReply) -> Result<()> {
        ensure!(
            !(response.failed && response.decision.is_some()),
            "Conflicting completion reply"
        );
        if let Some(CompletionDecision::Continue { instructions }) = &response.decision {
            ensure!(
                !instructions.trim().is_empty(),
                "Completion continuation requires nonempty instructions"
            );
        }
        let active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        let mut replies = self
            .step_replies
            .lock()
            .expect("JavaScript step replies poisoned");
        let id = crate::native_id(&response.owner.request_id)?;
        ensure!(
            replies.get(&id).is_some_and(|pending| self.step_matches(
                &response.owner.thread,
                &response.owner,
                active.as_ref(),
                pending
            ) && matches!(
                pending.reply,
                PreparationReply::Completion { .. }
            )),
            "Expired completion reply"
        );
        let pending = take_pending_step(&mut replies, id).expect("checked completion reply");
        // Do not hold preparation locks while requesting the captured native stop.
        drop(replies);
        drop(active);
        let PreparationReply::Completion { reply, stop } = pending.reply else {
            unreachable!()
        };
        let should_stop = matches!(response.decision, Some(CompletionDecision::Stop));
        let result = match response.decision {
            Some(CompletionDecision::Stop) => Err(()),
            Some(CompletionDecision::Continue { instructions }) => Ok(Some(instructions)),
            None if response.failed => Err(()),
            None => Ok(None),
        };
        // Acknowledge the admitted reply before cancellation can drop its receiver.
        reply
            .send(result)
            .map_err(|_| anyhow::anyhow!("Expired completion reply"))?;
        if should_stop {
            stop.stop();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner() -> Value {
        json!({"thread":"root","turn_id":"turn","generation":"0","request_id":"17"})
    }
    fn pending(
        tools: &PythonTools,
    ) -> oneshot::Receiver<std::result::Result<Option<Vec<ResponseItem>>, ()>> {
        let (reply, receive) = oneshot::channel();
        tools.step_replies.lock().unwrap().insert(
            17,
            PendingStep {
                source_cancellation: Some(CancellationToken::new()),
                callback: None,
                operation_generation: 0,
                turn: "turn".into(),
                generation: 0,
                allowed: vec![],
                reply: PreparationReply::Context(reply),
            },
        );
        receive
    }
    #[tokio::test]
    async fn malformed_or_foreign_reply_leaves_the_original_context_waiter_available() {
        let tools = super::super::pending_tests::tools();
        let receive = pending(&tools);
        let mut stale = owner();
        stale["turn_id"] = json!("successor");
        assert!(
            tools
                .reply_model_context(serde_json::from_value(json!({"owner":stale})).unwrap())
                .is_err()
        );
        assert!(
            tools
                .reply_model_context(
                    serde_json::from_value(
                        json!({"owner":owner(),"items":[{"type":"item_reference","id":"lossy"}]})
                    )
                    .unwrap()
                )
                .is_err()
        );
        assert!(tools.step_replies.lock().unwrap().contains_key(&17));
        tools
            .reply_model_context(
                serde_json::from_value(json!({"owner":owner(),"items":[]})).unwrap(),
            )
            .unwrap();
        assert!(receive.await.unwrap().unwrap().unwrap().is_empty());
        assert!(!tools.step_replies.lock().unwrap().contains_key(&17));
    }
    #[tokio::test]
    async fn absent_items_preserve_input_and_explicit_failure_is_not_acceptance() {
        let tools = super::super::pending_tests::tools();
        let receive = pending(&tools);
        tools
            .reply_model_context(serde_json::from_value(json!({"owner":owner()})).unwrap())
            .unwrap();
        assert!(receive.await.unwrap().unwrap().is_none());
        let receive = pending(&tools);
        tools
            .reply_model_context(
                serde_json::from_value(json!({"owner":owner(),"failed":true})).unwrap(),
            )
            .unwrap();
        assert!(receive.await.unwrap().is_err());
    }
    fn callback_tools(child: bool) -> Arc<PythonTools> {
        let mut tools = super::super::pending_tests::tools();
        if child {
            Arc::get_mut(&mut tools).expect("unshared fixture").instance =
                Some("incarnation".into());
        }
        tools
    }
    fn callback_owner(child: bool) -> Value {
        let mut receipt = owner();
        if child {
            receipt["thread"] = json!("child");
            receipt["instance"] = json!("incarnation");
        }
        receipt
    }
    fn reject_legacy_replies(tools: &PythonTools, child: bool) {
        let receipt = callback_owner(child);
        let thread = if child { "child" } else { "root" };
        assert!(
            tools
                .reply_step(thread, serde_json::from_value(receipt.clone()).unwrap())
                .is_err()
        );
        if child {
            assert!(
                !tools
                    .reply_child_step(thread, serde_json::from_value(receipt.clone()).unwrap())
                    .unwrap()
            );
        }
        assert!(
            tools
                .check_step(thread, &serde_json::from_value(receipt).unwrap())
                .unwrap()
        );
    }
    #[tokio::test]
    async fn legacy_step_entry_points_cannot_consume_context_waiters() {
        for child in [false, true] {
            let tools = callback_tools(child);
            let receive = pending(&tools);
            reject_legacy_replies(&tools, child);
            tools
                .reply_model_context(
                    serde_json::from_value(json!({"owner":callback_owner(child),"items":[]}))
                        .unwrap(),
                )
                .unwrap();
            assert!(receive.await.unwrap().unwrap().unwrap().is_empty());
        }
    }
    #[tokio::test]
    async fn legacy_step_entry_points_cannot_consume_completion_waiters() {
        for child in [false, true] {
            let tools = callback_tools(child);
            let name = if child { "child" } else { "root" };
            let thread = ExtensionData::new(name);
            let turn = ExtensionData::new("turn");
            let session = ExtensionData::new("session");
            let control = thread
                .get_or_init(|| crate::native_interception::Control::new(name.into(), !child));
            let boundary = crate::native_interception::Boundary::new(
                Arc::new(crate::storage::MemoryAgentGraph::default()),
                Arc::new(RwLock::new(None)),
            );
            let mode = serde_json::from_value(json!({"mode":"default", "settings":{"model":"test", "reasoning_effort":null,"developer_instructions":null}})).unwrap();
            boundary
                .on_turn_start(TurnStartInput {
                    turn_id: "turn",
                    collaboration_mode: &mode,
                    token_usage_at_turn_start: None,
                    session_store: &session,
                    thread_store: &thread,
                    turn_store: &turn,
                })
                .await;
            let stop = control
                .capture_turn_stop("turn")
                .expect("actual lifecycle owner");
            let (reply, receive) = oneshot::channel();
            tools.step_replies.lock().unwrap().insert(
                17,
                PendingStep {
                    source_cancellation: stop.callback_cancellation(),
                    callback: None,
                    operation_generation: 0,
                    turn: "turn".into(),
                    generation: 0,
                    allowed: vec![],
                    reply: PreparationReply::Completion { reply, stop },
                },
            );
            reject_legacy_replies(&tools, child);
            tools
                .reply_natural_completion(
                    serde_json::from_value(json!({"owner":callback_owner(child)})).unwrap(),
                )
                .unwrap();
            assert!(receive.await.unwrap().unwrap().is_none());
        }
    }
}

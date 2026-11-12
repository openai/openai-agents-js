//! Request-only context edits and natural completion decisions share the preparation ledger.

use super::*;
use crate::native_interception::CapturedTurnStop;
use codex_extension_api::{
    CompactionInput, CompactionResult, CompactionWindow, ModelContextInput, TurnCompletionInput,
};
use tokio_util::sync::CancellationToken;

fn run_retry_policy_override(
    admission: &dyn codex_extension_api::ModelToolAdmission,
) -> Option<bool> {
    let settings = admission
        .step_store()
        .and_then(|store| store.get::<codex_extension_api::CapturedRunModelSettingsOverride>())
        .or_else(|| {
            admission
                .turn_store()
                .get::<codex_extension_api::CapturedRunModelSettingsOverride>()
        })?;
    match settings.0.request_controls.retry.as_ref() {
        Some(None) => Some(false),
        Some(Some(retry)) => retry.has_policy,
        None => None,
    }
}

pub(super) struct ContextProjection {
    items: Option<Vec<ResponseItem>>,
    hosted_prompt: Option<codex_protocol::model_request_controls::HostedPromptReference>,
    explicit_tools: bool,
}

// The same preparation nonce follows streaming consumption instead of ending at stream start.
struct ContextLease {
    wait: StepWait,
    callback: Arc<CallbackRelease>,
    cancellation: CancellationToken,
    generation: Arc<Generation>,
    active: Option<ActiveSelection>,
    _tracing: Option<codex_otel::sdk_trace::ContextLease>,
}
impl ContextLease {
    fn validate(&self) -> Result<()> {
        let tools = &self.wait.tools;
        ensure!(
            !self.cancellation.is_cancelled()
                && tools.admits_generation(&self.generation)
                && self.callback.model_attempt.as_ref().is_none_or(|attempt| {
                    !attempt.cancellation().is_cancelled() && !attempt.sampling_stop().requested()
                }),
            "Expired model callback owner"
        );
        let current = tools
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        ensure!(
            match (&self.active, &*current) {
                (Some(active), Some(current)) =>
                    current.turn == active.turn
                        && Arc::ptr_eq(&current.generation, &active.generation),
                (None, None) => true,
                _ => false,
            },
            "Expired model callback operation"
        );
        Ok(())
    }
    async fn finish(self) -> Result<()> {
        let tools = &self.wait.tools;
        let id = self.wait.id;
        {
            let replies = tools
                .step_replies
                .lock()
                .expect("JavaScript step replies poisoned");
            if replies
                .get(&id)
                .is_some_and(|pending| pending.reply.is_closed())
                && !self.callback.entered.load(Ordering::Acquire)
            {
                self.callback.release();
            }
        }
        tokio::select! { biased;
            _ = self.cancellation.cancelled() => { tools.retire_step_callback(id); self.callback.wait().await; },
            _ = self.callback.wait() => {},
        }
        if !self.callback.retains_failed_attempt() {
            tools
                .step_replies
                .lock()
                .expect("JavaScript step replies poisoned")
                .remove(&id);
        }
        ensure!(
            !self.callback.cleanup_failed.load(Ordering::Acquire),
            "Model callback cleanup failed"
        );
        self.validate()
    }
}

pub(super) enum PreparationReply {
    Model(ModelDelivery),
    ModelRetry(
        oneshot::Sender<std::result::Result<codex_protocol::model_retry::ModelRetryResolution, ()>>,
    ),
    PreparedRequest {
        owner: Arc<prepared_requests::Owner>,
        reply: oneshot::Sender<
            std::result::Result<Option<codex_extension_api::PreparedRequestData>, ()>,
        >,
    },
    Selection(oneshot::Sender<Option<Vec<ToolName>>>),
    Context(oneshot::Sender<std::result::Result<ContextProjection, ()>>),
    Compaction(oneshot::Sender<std::result::Result<Option<CompactionResult>, ()>>),
    CompactionPolicy(oneshot::Sender<std::result::Result<Option<bool>, ()>>),
    Completion {
        reply: oneshot::Sender<std::result::Result<Option<String>, ()>>,
        stop: Arc<CapturedTurnStop>,
    },
}

impl PreparationReply {
    pub(super) fn is_closed(&self) -> bool {
        match self {
            Self::Model(ModelDelivery::Waiting(reply)) => reply.is_closed(),
            Self::Model(ModelDelivery::Streaming { events, .. }) => events.is_closed(),
            Self::ModelRetry(reply) => reply.is_closed(),
            Self::PreparedRequest { reply, .. } => reply.is_closed(),
            Self::Selection(reply) => reply.is_closed(),
            Self::Context(reply) => reply.is_closed(),
            Self::Compaction(reply) => reply.is_closed(),
            Self::CompactionPolicy(reply) => reply.is_closed(),
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
    hosted_prompt: Option<codex_protocol::model_request_controls::HostedPromptReference>,
    #[serde(default)]
    explicit_tools: bool,
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
    window: Option<CompactionWindow>,
    admitted: Option<bool>,
    #[serde(default)]
    failed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ModelRetryReply {
    pub(crate) owner: StepReply,
    data: Option<codex_protocol::model_retry::ModelRetryResolution>,
    #[serde(default)]
    failed: bool,
}

impl PythonTools {
    pub(crate) fn publish_model_attempt(
        &self,
        input: codex_extension_api::ModelAttemptInput,
    ) -> Result<()> {
        let thread = input.admission.thread_id();
        let turn = input.admission.turn_store().level_id();
        if let Some(owner) = input
            .admission
            .turn_store()
            .get::<crate::turn_settlement::Turn>()
        {
            owner.retain_model_attempt(input.admission.model_attempt());
        }
        let mut data = serde_json::to_value(input.snapshot)?;
        crate::usage::model_attempt_to_wire(&mut data)?;
        data["attempt_id"] = json!(input.attempt_id);
        data["phase"] = json!(input.phase);
        let mut event = json!({"id":turn,"msg":{"type":"_sdk_model_attempt",
            "thread":thread,"turn_id":turn,"root_turn_id":input.admission.root_turn_id(),"data":data}});
        if let Some(instance) = &self.instance {
            event["subagent_id"] = json!(thread);
            event["subagent_incarnation"] = json!(instance);
            event["subagent_managed_tools"] = json!(true);
        }
        self.family
            .requests
            .send(FamilyRequest::Callback(event))
            .map_err(|_| anyhow::anyhow!("Model attempt reader closed"))
    }

    pub(crate) async fn decide_model_retry(
        self: &Arc<Self>,
        input: codex_extension_api::ModelRetryInput,
    ) -> Result<codex_protocol::model_retry::ModelRetryResolution> {
        let mut data = serde_json::to_value(&input.context)?;
        if let Some(usage) = &input.context.usage {
            data["usage"] = crate::usage::exact_usage(usage);
        }
        self.exchange_context(
            input.admission.step_store(),
            input.admission.thread_id(),
            input.admission.turn_store().level_id(),
            input.cancellation,
            None,
            json!({"type":"_sdk_model_retry", "instance":self.instance,
                "root_turn_id":input.admission.root_turn_id(),
                "run_retry_policy_override":run_retry_policy_override(input.admission.as_ref()),"data":data}),
            PreparationReply::ModelRetry,
        )
        .await
    }

    pub(crate) fn reply_model_retry(&self, response: ModelRetryReply) -> Result<()> {
        ensure!(
            !(response.failed && response.data.is_some()),
            "Conflicting retry reply"
        );
        if let Some(decision) = response
            .data
            .as_ref()
            .and_then(|data| data.decision.as_ref())
        {
            decision.validate().map_err(anyhow::Error::msg)?;
        }
        let active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        let mut replies = self.step_replies.lock().expect("Step replies poisoned");
        let id = crate::native_id(&response.owner.request_id)?;
        ensure!(
            replies.get(&id).is_some_and(|pending| self.step_matches(
                &response.owner.thread,
                &response.owner,
                active.as_ref(),
                pending
            ) && matches!(
                pending.reply,
                PreparationReply::ModelRetry(_)
            )),
            "Expired retry reply"
        );
        let pending = take_pending_step(&mut replies, id).expect("checked retry reply");
        let PreparationReply::ModelRetry(reply) = pending.reply else {
            unreachable!()
        };
        reply
            .send(if response.failed {
                Err(())
            } else {
                Ok(response.data.unwrap_or_default())
            })
            .map_err(|_| anyhow::anyhow!("Expired retry reply"))
    }

    pub(crate) fn transforms_context(&self) -> bool {
        self.context_callbacks.transform_context
    }

    pub(crate) fn customizes_compaction(&self) -> bool {
        self.context_callbacks.before_compact
    }

    pub(crate) fn schedules_post_turn_compaction(&self, step: &ExtensionData) -> bool {
        self.context_callbacks.post_turn_compact
            && self
                .source_catalog(Some(step))
                .is_ok_and(|catalog| catalog.is_none_or(|catalog| catalog.post_turn_compact))
    }

    pub(crate) async fn post_turn_compaction(
        self: &Arc<Self>,
        input: CompactionInput<'_>,
    ) -> Result<Option<bool>> {
        if !self.context_callbacks.post_turn_compact
            || self
                .source_catalog(input.step_store)?
                .is_some_and(|catalog| !catalog.post_turn_compact)
        {
            return Ok(None);
        }
        let cancellation = self
            .context_stop(input.turn_id)?
            .callback_cancellation()
            .context("Expired compaction policy turn")?;
        self.exchange_context(input.step_store, input.thread_id, input.turn_id, cancellation, None,
            json!({"type":"_sdk_before_compact_policy", "model":input.model,
                "automatic":input.automatic, "items":input.items, "candidate_indexes":input.candidate_indexes, "model_omitted":input.model_omitted, "provider_response":input.provider_response}),
            PreparationReply::CompactionPolicy).await
    }

    pub(crate) async fn before_compact(
        self: &Arc<Self>,
        input: CompactionInput<'_>,
    ) -> Result<Option<CompactionResult>> {
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
        self.exchange_context(input.step_store, input.thread_id, input.turn_id, cancellation, None,
            json!({"type":"_sdk_before_compact", "model":input.model, "automatic":input.automatic, "items":input.items,
                "optional":input.optional, "candidate_indexes":input.candidate_indexes, "model_omitted":input.model_omitted, "provider_response":input.provider_response}),
            PreparationReply::Compaction).await
    }

    pub(crate) fn reply_compaction(&self, response: CompactionReply) -> Result<()> {
        ensure!(
            !(response.failed
                && (response.summary.is_some()
                    || response.window.is_some()
                    || response.admitted.is_some()))
                && !(response.summary.is_some() && response.window.is_some()),
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
                PreparationReply::Compaction(_) | PreparationReply::CompactionPolicy(_)
            )),
            "Expired compaction reply"
        );
        match &replies.get(&id).expect("checked compaction reply").reply {
            PreparationReply::Compaction(_) => ensure!(
                response.admitted.is_none(),
                "Unexpected compaction policy decision"
            ),
            PreparationReply::CompactionPolicy(_) => ensure!(
                response.summary.is_none() && response.window.is_none(),
                "Unexpected compaction policy payload"
            ),
            _ => unreachable!(),
        }
        let pending = take_pending_step(&mut replies, id).expect("checked compaction reply");
        match pending.reply {
            PreparationReply::Compaction(reply) => {
                let value = response
                    .window
                    .map(CompactionResult::Window)
                    .or_else(|| response.summary.map(CompactionResult::Summary));
                reply
                    .send(if response.failed { Err(()) } else { Ok(value) })
                    .map_err(|_| anyhow::anyhow!("Expired compaction reply"))
            }
            PreparationReply::CompactionPolicy(reply) => reply
                .send(if response.failed {
                    Err(())
                } else {
                    Ok(response.admitted)
                })
                .map_err(|_| anyhow::anyhow!("Expired compaction policy reply")),
            _ => unreachable!(),
        }
    }

    pub(super) fn context_stop(&self, turn: &str) -> Result<Arc<CapturedTurnStop>> {
        self.context_control
            .get()
            .and_then(Weak::upgrade)
            .and_then(|control| control.capture_turn_stop(turn))
            .context("Expired model callback turn")
    }

    // Reuse the same nonce, exact owner, cancellation and physical callback join as beforeStep.
    pub(super) async fn exchange_context<T>(
        self: &Arc<Self>,
        step: Option<&ExtensionData>,
        thread: &str,
        turn: &str,
        cancellation: CancellationToken,
        model_attempt: Option<Arc<dyn codex_extension_api::ModelAttemptAdmission>>,
        message: Value,
        prepare: impl FnOnce(oneshot::Sender<std::result::Result<T, ()>>) -> PreparationReply,
    ) -> Result<T> {
        let (reply, lease) = self
            .exchange_context_retained(
                step,
                thread,
                turn,
                cancellation,
                model_attempt,
                message,
                prepare,
            )
            .await?;
        lease.finish().await?;
        Ok(reply)
    }

    async fn exchange_context_retained<T>(
        self: &Arc<Self>,
        step: Option<&ExtensionData>,
        thread: &str,
        turn: &str,
        cancellation: CancellationToken,
        model_attempt: Option<Arc<dyn codex_extension_api::ModelAttemptAdmission>>,
        mut message: Value,
        prepare: impl FnOnce(oneshot::Sender<std::result::Result<T, ()>>) -> PreparationReply,
    ) -> Result<(T, ContextLease)> {
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
        let callback = CallbackRelease::with_model_attempt(receipt, model_attempt);
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
        let wait = StepWait {
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
        if received.is_err() {
            self.retire_step_callback(id);
        }
        let lease = ContextLease {
            wait,
            callback,
            cancellation,
            generation,
            active,
            _tracing: tracing,
        };
        match received {
            Ok(Ok(value)) => Ok((value, lease)),
            received => {
                lease.finish().await?;
                received?
                    .map_err(|()| anyhow::anyhow!("Model callback failed"))
                    .map(|_| unreachable!())
            }
        }
    }

    pub(crate) async fn transform_context(
        self: &Arc<Self>,
        mut input: ModelContextInput<'_>,
    ) -> Result<()> {
        if !self.transforms_context()
            || self
                .source_catalog(input.step_store)?
                .is_some_and(|catalog| !catalog.transform_context)
        {
            return Ok(());
        }
        if let Some(prompt) = input.hosted_prompt.as_deref_mut() {
            if input
                .turn_store
                .and_then(|store| store.get::<Option<crate::python_tools::OperationSelection>>())
                .as_deref()
                .and_then(Option::as_ref)
                .is_some_and(|selection| selection.names.is_some() || selection.slots.is_some())
            {
                prompt.omit_tools = false;
            }
            if !prompt.omit_instructions {
                prompt.resolved_instructions = Some(
                    crate::application_instructions::captured_prompt_text(input.step_store)?,
                );
            }
            crate::application_instructions::remove_prompt_fragments(input.items)?;
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
        let model_attempt = input
            .step_store
            .and_then(|step| step.get::<codex_extension_api::CapturedModelAttempt>())
            .map(|captured| captured.0.clone());
        let result = self.exchange_context(input.step_store, input.thread_id, input.turn_id, cancellation, model_attempt,
            json!({"type":"_sdk_transform_context", "model":input.model, "compaction":input.compaction, "hosted_prompt":input.hosted_prompt.is_some(),
                "hosted_prompt_omissions":input.hosted_prompt.as_deref().map(|prompt| json!({
                    "omit_model":prompt.omit_model, "omit_instructions":prompt.omit_instructions,
                    "omit_tools":prompt.omit_tools,
                })), "items":input.items}),
            PreparationReply::Context).await?;
        if result.explicit_tools {
            input
                .hosted_prompt
                .as_deref_mut()
                .context("Unexpected hosted tool policy reply")?
                .omit_tools = false;
        }
        if let Some(reference) = result.hosted_prompt {
            let target = input
                .hosted_prompt
                .context("Unexpected hosted prompt reply")?;
            target.reference = Some(reference);
        }
        if let Some(items) = result.items {
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
        self.exchange_context(input.step_store, input.thread_store.level_id(), input.turn_id, cancellation, None,
            json!({"type":"_sdk_before_complete", "model":input.model, "text":input.last_assistant_message, "continuation_count":input.continuation_count}),
            |reply| PreparationReply::Completion { reply, stop }).await
    }

    pub(crate) fn reply_model_context(&self, response: ContextReply) -> Result<()> {
        ensure!(
            !(response.failed
                && (response.items.is_some()
                    || response.hosted_prompt.is_some()
                    || response.explicit_tools)),
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
            .send(if response.failed {
                Err(())
            } else {
                Ok(ContextProjection {
                    items,
                    hosted_prompt: response.hosted_prompt,
                    explicit_tools: response.explicit_tools,
                })
            })
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
    #[tokio::test]
    async fn cancelled_stream_closes_saturated_channel_before_joining_callback() {
        use futures_util::StreamExt;
        let tools = super::super::pending_tests::tools();
        let callback =
            CallbackRelease::new(json!({"kind":"preparation","thread":"root","id":"17"}));
        callback.entered.store(true, Ordering::Release);
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let (events, receiver) = tokio::sync::mpsc::channel(8);
        for _ in 0..8 {
            events
                .send(codex_api::ResponseEvent::Created { response_id: None })
                .await
                .unwrap();
        }
        let release = callback.clone();
        let producer = tokio::spawn(async move {
            assert!(events.reserve().await.is_err());
            release.release();
        });
        let (_finish_sender, finish) = oneshot::channel();
        let generation = tools.current.read().unwrap().clone();
        let cursor = ModelStreamCursor {
            events: receiver,
            finish: Some(finish),
            accepted: Vec::new().into_iter(),
            failed: false,
            lease: Some(ContextLease {
                wait: StepWait { tools, id: 17 },
                callback,
                cancellation,
                generation,
                active: None,
                _tracing: None,
            }),
        };
        let mut stream = cursor.into_stream();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
                .await
                .expect("saturated producer and callback cleanup must retire")
                .expect("cancellation event")
                .is_err()
        );
        producer.await.unwrap();
    }

    fn owner() -> Value {
        json!({"thread":"root","turn_id":"turn","generation":"0","request_id":"17"})
    }
    fn pending(
        tools: &PythonTools,
    ) -> oneshot::Receiver<std::result::Result<ContextProjection, ()>> {
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
                        json!({"owner":owner(),"items":[{"type":"item_reference","id":17}]})
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
        assert!(receive.await.unwrap().unwrap().items.unwrap().is_empty());
        assert!(!tools.step_replies.lock().unwrap().contains_key(&17));
    }
    #[tokio::test]
    async fn absent_items_preserve_input_and_explicit_failure_is_not_acceptance() {
        let tools = super::super::pending_tests::tools();
        let receive = pending(&tools);
        tools
            .reply_model_context(serde_json::from_value(json!({"owner":owner()})).unwrap())
            .unwrap();
        assert!(receive.await.unwrap().unwrap().items.is_none());
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
            assert!(receive.await.unwrap().unwrap().items.unwrap().is_empty());
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

type ModelStreamFinish = std::result::Result<Vec<codex_api::ResponseEvent>, codex_api::ApiError>;
pub(super) enum ProducedResponse {
    Complete(ModelReply),
    Stream {
        events: tokio::sync::mpsc::Receiver<codex_api::ResponseEvent>,
        finish: oneshot::Receiver<ModelStreamFinish>,
    },
}
pub(super) enum ModelDelivery {
    Waiting(oneshot::Sender<std::result::Result<ProducedResponse, ()>>),
    Streaming {
        events: tokio::sync::mpsc::Sender<codex_api::ResponseEvent>,
        finish: oneshot::Sender<ModelStreamFinish>,
        projection: codex_api::ApplicationModelStream,
    },
}
struct ModelStreamCursor {
    events: tokio::sync::mpsc::Receiver<codex_api::ResponseEvent>,
    finish: Option<oneshot::Receiver<ModelStreamFinish>>,
    accepted: std::vec::IntoIter<codex_api::ResponseEvent>,
    lease: Option<ContextLease>,
    failed: bool,
}
fn model_stream_error(error: impl std::fmt::Display) -> codex_api::ApiError {
    codex_api::ApiError::InvalidRequest {
        message: error.to_string(),
    }
}
impl ModelStreamCursor {
    fn into_stream(self) -> codex_extension_api::ModelResponseStream {
        use futures_util::StreamExt;
        futures_util::stream::unfold(self, |mut cursor| async move {
            match cursor.next().await {
                Ok(Some(event)) => Some((Ok(event), cursor)),
                Ok(None) => None,
                Err(error) => {
                    cursor.events.close();
                    if let Some(lease) = cursor.lease.take() {
                        let _ = lease.finish().await;
                    }
                    cursor.failed = true;
                    Some((Err(error), cursor))
                }
            }
        })
        .boxed()
    }
    async fn next(
        &mut self,
    ) -> std::result::Result<Option<codex_api::ResponseEvent>, codex_api::ApiError> {
        if self.failed {
            return Ok(None);
        }
        if let Some(event) = self.accepted.next() {
            return Ok(Some(event));
        }
        let Some(lease) = &self.lease else {
            return Ok(None);
        };
        lease.validate().map_err(model_stream_error)?;
        let event = tokio::select! { biased;
            _ = lease.cancellation.cancelled() => return Err(model_stream_error("Native model stream cancelled")),
            event = self.events.recv() => event,
        };
        if let Some(event) = event {
            lease.validate().map_err(model_stream_error)?;
            return Ok(Some(event));
        }
        let finish = self
            .finish
            .take()
            .ok_or_else(|| model_stream_error("Native model stream already finished"))?;
        let result = finish
            .await
            .map_err(|_| model_stream_error("Native model stream was abandoned"))?;
        self.lease
            .take()
            .expect("retained model callback lease")
            .finish()
            .await
            .map_err(model_stream_error)?;
        self.accepted = result?.into_iter();
        Ok(self.accepted.next())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ModelReply {
    response_id: String,
    output: Vec<Value>,
    #[serde(default)]
    usage: Option<codex_protocol::protocol::TokenUsage>,
    #[serde(default)]
    original_usage: Option<OriginalResponsesUsage>,
    #[serde(default)]
    received_cache_write_input_tokens: Option<i64>,
    #[serde(default)]
    raw_chat_completion: Option<serde_json::Map<String, Value>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OriginalResponsesUsage {
    response_id: String,
    #[serde(default)]
    upstream_request_id: Option<String>,
    usage: serde_json::Map<String, Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ModelProducerReply {
    pub(crate) owner: StepReply,
    data: Option<Value>,
    failure: Option<codex_protocol::model_retry::ModelProducerFailure>,
    #[serde(default)]
    failed: bool,
}
impl PythonTools {
    pub(crate) fn produces_model_response(&self) -> bool {
        self.context_callbacks.model_producer
    }
    pub(crate) async fn produce_model_response(
        self: &Arc<Self>,
        model: &str,
        mut request: Value,
        admission: Arc<dyn codex_extension_api::ModelToolAdmission>,
    ) -> Result<codex_extension_api::ModelResponseStream> {
        use futures_util::StreamExt;
        self.restore_schema_request(&mut request)?;
        let turn = admission.turn_store().level_id();
        let attempt = admission.model_attempt();
        let cancellation = attempt
            .as_ref()
            .map(|attempt| attempt.cancellation())
            .or_else(|| {
                self.context_stop(turn)
                    .ok()
                    .and_then(|stop| stop.callback_cancellation())
            })
            .context("Expired native model producer")?;
        let capture_raw_usage = self
            .context_control
            .get()
            .and_then(Weak::upgrade)
            .is_some_and(|control| control.raw_usage_active());
        let mut message = json!({"type":"_sdk_model_produce", "model":model, "data":request,
            "root_turn_id": admission.root_turn_id(), "capture_raw_usage":capture_raw_usage,
            "run_retry_policy_override":run_retry_policy_override(admission.as_ref())});
        if let Some(attempt) = &attempt {
            message["attempt_id"] = json!(attempt.id());
            message["attempt"] = json!(attempt.attempt());
            message["retry_configured"] = json!(attempt.retry_configured());
            message["disable_provider_retries"] = json!(attempt.disable_provider_retries());
        }
        let (reply, lease) = self
            .exchange_context_retained(
                admission.step_store(),
                admission.thread_id(),
                turn,
                cancellation,
                attempt.clone(),
                message,
                |reply| PreparationReply::Model(ModelDelivery::Waiting(reply)),
            )
            .await?;
        match reply {
            ProducedResponse::Complete(reply) => {
                lease.finish().await?;
                if let Some(id) = reply
                    .raw_chat_completion
                    .as_ref()
                    .and_then(|raw| raw.get("id"))
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                {
                    ensure!(
                        id == reply.response_id,
                        "Original Chat Completion does not match model response"
                    );
                }
                ensure!(
                    !reply.response_id.trim().is_empty(),
                    "Native model response requires an identifier"
                );
                let mut events = codex_extension_api::completed_model_response(
                    reply.response_id,
                    reply.output,
                    reply.usage,
                );
                if let Some(original) = reply.original_usage {
                    if let Some(Ok(codex_api::ResponseEvent::Completed {
                        response_id,
                        usage_metadata,
                        ..
                    })) = events.last_mut()
                    {
                        ensure!(
                            original.response_id == *response_id,
                            "Original Responses usage does not match model response"
                        );
                        let raw_usage = Value::Object(original.usage);
                        let count = |value: &Value| value.as_i64().filter(|count| *count >= 0);
                        let received_usage = codex_protocol::protocol::ReceivedResponseUsage {
                            input_tokens: raw_usage.get("input_tokens").and_then(count),
                            cached_input_tokens: raw_usage
                                .pointer("/input_tokens_details/cached_tokens")
                                .and_then(count),
                            cache_write_input_tokens: raw_usage
                                .pointer("/input_tokens_details/cache_write_tokens")
                                .and_then(count),
                            output_tokens: raw_usage.get("output_tokens").and_then(count),
                            reasoning_output_tokens: raw_usage
                                .pointer("/output_tokens_details/reasoning_tokens")
                                .and_then(count),
                            total_tokens: raw_usage.get("total_tokens").and_then(count),
                        };
                        let observation = codex_protocol::protocol::ResponseObservation {
                            response_id: Some(original.response_id),
                            upstream_request_id: original.upstream_request_id,
                            status: codex_protocol::protocol::ResponseObservationStatus::Completed,
                            incomplete_reason: None,
                            usage: Some(received_usage),
                        };
                        usage_metadata.get_or_insert_default().metadata = Some(raw_usage);
                        events.insert(
                            events.len() - 1,
                            Ok(codex_api::ResponseEvent::ResponseObserved(observation)),
                        );
                    }
                } else if matches!(
                    events.last(),
                    Some(Ok(codex_api::ResponseEvent::Completed { .. }))
                ) {
                    // Normalized application output has been supplying a completion
                    // boundary; original provider identifiers/usage have been remaining unknown.
                    events.insert(
                        events.len() - 1,
                        Ok(codex_api::ResponseEvent::ResponseObserved(
                            codex_protocol::protocol::ResponseObservation {
                                response_id: None,
                                upstream_request_id: None,
                                status:
                                    codex_protocol::protocol::ResponseObservationStatus::Completed,
                                incomplete_reason: None,
                                usage: reply.received_cache_write_input_tokens.map(|count| {
                                    codex_protocol::protocol::ReceivedResponseUsage {
                                        input_tokens: None,
                                        cached_input_tokens: None,
                                        cache_write_input_tokens: Some(count),
                                        output_tokens: None,
                                        reasoning_output_tokens: None,
                                        total_tokens: None,
                                    }
                                }),
                            },
                        )),
                    );
                }
                if let Some(raw) = reply.raw_chat_completion {
                    events.insert(
                        events.len() - 1,
                        Ok(codex_api::ResponseEvent::RawProvider(
                            codex_protocol::protocol::SdkRawProviderEvent {
                                source:
                                    codex_protocol::protocol::SdkRawProviderSource::ChatCompletions,
                                transport: codex_protocol::protocol::ResponsesEventTransport::Json,
                                payload: Value::Object(raw),
                            },
                        )),
                    );
                }
                Ok(futures_util::stream::iter(events).boxed())
            }
            ProducedResponse::Stream { events, finish } => {
                let cursor = ModelStreamCursor {
                    events,
                    finish: Some(finish),
                    accepted: Vec::new().into_iter(),
                    lease: Some(lease),
                    failed: false,
                };
                Ok(cursor.into_stream())
            }
        }
    }
    pub(crate) fn start_model_producer_stream(
        &self,
        response: &StepReply,
        observe_raw: bool,
    ) -> Result<()> {
        let active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        let mut replies = self
            .step_replies
            .lock()
            .expect("JavaScript step replies poisoned");
        let id = crate::native_id(&response.request_id)?;
        ensure!(
            replies.get(&id).is_some_and(|pending| self.step_matches(
                &response.thread,
                response,
                active.as_ref(),
                pending
            ) && matches!(
                pending.reply,
                PreparationReply::Model(ModelDelivery::Waiting(_))
            )),
            "Expired model stream start"
        );
        let (events, receive_events) = tokio::sync::mpsc::channel(8);
        let (finish, receive_finish) = oneshot::channel();
        let pending = replies.get_mut(&id).expect("checked model request");
        let PreparationReply::Model(ModelDelivery::Waiting(reply)) = std::mem::replace(
            &mut pending.reply,
            PreparationReply::Model(ModelDelivery::Streaming {
                events,
                finish,
                projection: codex_api::ApplicationModelStream::new(observe_raw),
            }),
        ) else {
            unreachable!()
        };
        reply
            .send(Ok(ProducedResponse::Stream {
                events: receive_events,
                finish: receive_finish,
            }))
            .map_err(|_| anyhow::anyhow!("Expired model stream start"))
    }
    pub(crate) async fn push_model_producer_event(
        &self,
        response: &StepReply,
        data: &str,
    ) -> Result<bool> {
        let id = crate::native_id(&response.request_id)?;
        let (projected, sender, continuing) = {
            let active = self
                .selection
                .lock()
                .expect("JavaScript selection poisoned");
            let mut replies = self
                .step_replies
                .lock()
                .expect("JavaScript step replies poisoned");
            ensure!(
                replies.get(&id).is_some_and(|pending| self.step_matches(
                    &response.thread,
                    response,
                    active.as_ref(),
                    pending
                )),
                "Expired model stream event"
            );
            let pending = replies.get_mut(&id).expect("checked model request");
            let attempt = pending
                .callback
                .as_ref()
                .and_then(|callback| callback.model_attempt.as_ref())
                .cloned();
            let PreparationReply::Model(ModelDelivery::Streaming {
                events, projection, ..
            }) = &mut pending.reply
            else {
                anyhow::bail!("Model stream has not started")
            };
            let had_usage = projection.completed_usage().is_some();
            let (projected, continuing) = projection.push(data);
            if !had_usage {
                if let (Some(attempt), Some(usage)) = (attempt, projection.completed_usage()) {
                    // Retirement can drop the projection before the normal reply reports usage.
                    let _ = attempt.report_usage(usage.clone());
                }
            }
            (projected, events.clone(), continuing)
        };
        for event in projected {
            let permit = sender
                .reserve()
                .await
                .context("Expired model stream reader")?;
            let active = self
                .selection
                .lock()
                .expect("JavaScript selection poisoned");
            let replies = self
                .step_replies
                .lock()
                .expect("JavaScript step replies poisoned");
            ensure!(
                replies.get(&id).is_some_and(|pending| self.step_matches(
                    &response.thread,
                    response,
                    active.as_ref(),
                    pending
                )),
                "Expired model stream event"
            );
            permit.send(event);
        }
        Ok(continuing)
    }
    pub(crate) fn reply_model_producer(&self, response: ModelProducerReply) -> Result<()> {
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
                PreparationReply::Model(_)
            )),
            "Expired model producer reply"
        );
        let attempt = replies
            .get(&id)
            .and_then(|pending| pending.callback.as_ref())
            .and_then(|callback| callback.model_attempt.as_ref())
            .cloned();
        let streaming = replies.get(&id).is_some_and(|pending| {
            matches!(
                pending.reply,
                PreparationReply::Model(ModelDelivery::Streaming { .. })
            )
        });
        let parsed = if response.failed {
            ensure!(
                response.data.is_none(),
                "Failed model reply contains output"
            );
            if let Some(failure) = response.failure {
                attempt
                    .as_ref()
                    .context("Missing model attempt for failure")?
                    .report_failure(failure)
                    .map_err(anyhow::Error::msg)?;
            }
            Err(())
        } else if streaming {
            ensure!(
                response.failure.is_none(),
                "Successful model reply contains failure"
            );
            if response.data.is_none() {
                Ok(None)
            } else {
                Err(())
            }
        } else {
            ensure!(
                response.failure.is_none(),
                "Successful model reply contains failure"
            );
            let reply: ModelReply =
                serde_json::from_value(response.data.context("Missing model response")?)
                    .map_err(|_| anyhow::anyhow!("Invalid model response"))?;
            ensure!(
                !reply.response_id.trim().is_empty(),
                "Model response requires an identifier"
            );
            if let Some(count) = reply.received_cache_write_input_tokens {
                ensure!(
                    (0..=9_007_199_254_740_991).contains(&count),
                    "Invalid received cache-write token count"
                );
            }
            if let (Some(attempt), Some(usage)) = (&attempt, &reply.usage) {
                attempt
                    .report_usage(usage.clone())
                    .map_err(anyhow::Error::msg)?;
            }
            Ok(Some(reply))
        };
        let pending = take_pending_step(&mut replies, id).expect("checked model producer reply");
        let PreparationReply::Model(reply) = pending.reply else {
            unreachable!()
        };
        match reply {
            ModelDelivery::Waiting(reply) => reply
                .send(parsed.map(|reply| {
                    ProducedResponse::Complete(reply.expect("parsed complete response"))
                }))
                .map_err(|_| anyhow::anyhow!("Expired model producer reply")),
            ModelDelivery::Streaming {
                finish, projection, ..
            } => {
                let usage = projection.completed_usage().cloned();
                let mut result = projection.finish(
                    parsed
                        .is_err()
                        .then_some("Native model stream producer failed"),
                );
                if let (Some(attempt), Some(usage)) = (&attempt, usage) {
                    if let Err(error) = attempt.report_usage(usage) {
                        if result.is_ok() {
                            result = Err(model_stream_error(error));
                        }
                    }
                }
                finish
                    .send(result)
                    .map_err(|_| anyhow::anyhow!("Expired model producer reply"))
            }
        }
    }
}

#[cfg(test)]
#[path = "model_attempt_tests.rs"]
mod model_attempt_tests;

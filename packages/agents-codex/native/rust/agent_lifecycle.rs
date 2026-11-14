//! Live callbacks acknowledge lifecycle without acquiring transfer authority.
use super::*;
use codex_extension_api::AgentLifecycleInput;

pub(crate) struct Bindings(pub(crate) Vec<String>);
pub(crate) fn enabled(store: &ExtensionData, profile: &str) -> bool {
    store
        .get::<Bindings>()
        .is_some_and(|bindings| bindings.0.iter().any(|id| id == profile))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reply {
    pub owner: StepReply,
    #[serde(default)]
    failed: bool,
}

impl PythonTools {
    pub(crate) async fn agent_lifecycle(
        self: &Arc<Self>,
        input: AgentLifecycleInput<'_>,
    ) -> Result<()> {
        let profile_id = input
            .source
            .map(|source| source.receipt.profile_id.as_str())
            .unwrap_or("");
        if !enabled(input.thread_store, profile_id) {
            return Ok(());
        }
        crate::agent_profiles::validate_lifecycle_handoff(&input)?;
        let step = ExtensionData::new(format!("agent-lifecycle:{}", input.turn_id));
        if let Some(source) = input.source {
            step.insert(source.clone());
            step.insert(
                source
                    .profile
                    .data
                    .get::<ProfileCatalog>()
                    .context("Lifecycle source lacks its captured catalog")?
                    .as_ref()
                    .clone(),
            );
        }
        let cancellation = self
            .context_stop(input.turn_id)?
            .callback_cancellation()
            .context("Lifecycle callback lacks its native turn stop")?;
        let combined = input.cancellation.child_token();
        if cancellation.is_cancelled() {
            combined.cancel();
        }
        let exchange = self.exchange_context(
            input.source.map(|_| &step), input.thread_store.level_id(), input.turn_id,
            combined.clone(), None,
            json!({"type":"_sdk_agent_lifecycle", "phase":if input.target_profile_id.is_some(){"handoff"}else{"start"},
                "target_profile_id": input.target_profile_id}),
            context_callbacks::PreparationReply::AgentLifecycle,
        );
        tokio::pin!(exchange);
        let result = tokio::select! {
            result = &mut exchange => result,
            _ = cancellation.cancelled() => {
                combined.cancel();
                exchange.await
            }
        };
        ensure!(
            !cancellation.is_cancelled(),
            "Agent lifecycle callback cancelled"
        );
        result
    }

    pub(crate) fn reply_agent_lifecycle(&self, response: Reply) -> Result<()> {
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
                context_callbacks::PreparationReply::AgentLifecycle(_)
            )),
            "Expired Agent lifecycle reply"
        );
        let pending = take_pending_step(&mut replies, id).expect("checked Agent lifecycle reply");
        let context_callbacks::PreparationReply::AgentLifecycle(reply) = pending.reply else {
            unreachable!()
        };
        reply
            .send(if response.failed { Err(()) } else { Ok(()) })
            .map_err(|_| anyhow::anyhow!("Expired Agent lifecycle reply"))
    }
}

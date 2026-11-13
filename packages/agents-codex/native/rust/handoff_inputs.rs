//! One scoped callback reply edits groups; Core retains the accepted transfer identity.
use super::*;
use codex_protocol::agent_profile::{
    AgentProfileHandoffInputRequest, AgentProfileHandoffPresentation,
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Groups {
    pub input: Vec<Value>,
    pub previous: Vec<Value>,
    pub generated: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reply {
    pub owner: StepReply,
    groups: Option<Groups>,
    #[serde(default)]
    failed: bool,
}

impl PythonTools {
    pub(crate) async fn prepare_handoff_input(
        self: &Arc<Self>,
        _store: &ExtensionData,
        thread: &str,
        turn: &str,
        source: &codex_extension_api::CapturedAgentProfile,
        request: &AgentProfileHandoffInputRequest,
        proposed: &AgentProfileHandoffPresentation,
    ) -> Result<AgentProfileHandoffPresentation> {
        ensure!(
            source.receipt == request.handoff.source && request.turn_id == turn,
            "Handoff preparation has another source owner"
        );
        let step = ExtensionData::new(format!("handoff-input:{turn}:{}", source.receipt.epoch));
        step.insert(source.clone());
        step.insert(
            source
                .profile
                .data
                .get::<ProfileCatalog>()
                .context("Handoff preparation lacks its captured source catalog")?
                .as_ref()
                .clone(),
        );
        let cancellation = self
            .context_stop(turn)?
            .callback_cancellation()
            .context("Handoff preparation lacks its native turn stop")?;
        let groups: Groups = self.exchange_context(
            Some(&step), thread, turn,
            cancellation, None,
            json!({"type":"_sdk_handoff_input", "tool_name":request.tool_name,
                "target_profile_id":request.handoff.target_profile_id,
                "input":proposed.input,"previous":proposed.previous,"generated":proposed.generated}),
            context_callbacks::PreparationReply::HandoffInput,
        ).await?;
        Ok(AgentProfileHandoffPresentation {
            input: groups.input,
            previous: groups.previous,
            generated: groups.generated,
            ..proposed.clone()
        })
    }

    pub(crate) fn reply_handoff_input(&self, response: Reply) -> Result<()> {
        ensure!(
            !response.failed || response.groups.is_none(),
            "Conflicting handoff input reply"
        );
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
                context_callbacks::PreparationReply::HandoffInput(_)
            )),
            "Expired handoff input reply"
        );
        let pending = take_pending_step(&mut replies, id).expect("checked handoff input reply");
        let context_callbacks::PreparationReply::HandoffInput(reply) = pending.reply else {
            unreachable!()
        };
        reply
            .send(if response.failed {
                Err(())
            } else {
                response.groups.ok_or(())
            })
            .map_err(|_| anyhow::anyhow!("Expired handoff input reply"))
    }
}

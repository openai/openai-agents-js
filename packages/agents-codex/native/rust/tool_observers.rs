//! Read-only application observation for exact raw native MCP invocations.
use super::*;
use codex_extension_api::{RecordedToolOutputObserver, ToolStartInput};

/// Installed only by a live SDK Session with captured application observers.
pub(crate) struct Bindings;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reply {
    pub owner: StepReply,
    #[serde(default)]
    failed: bool,
}

struct Observer {
    tools: Weak<PythonTools>,
    step: Option<ExtensionData>,
    thread_id: String,
    turn_id: String,
    call_id: String,
    name: ToolName,
    arguments: String,
    started: AtomicBool,
}

impl Observer {
    async fn deliver(&self, phase: &str, output: Option<Value>, succeeded: bool) -> Result<()> {
        let tools = self
            .tools
            .upgrade()
            .context("Tool lifecycle owner closed")?;
        let cancellation = tools
            .context_stop(&self.turn_id)?
            .callback_cancellation()
            .context("Tool lifecycle lacks its native turn stop")?;
        ensure!(
            !cancellation.is_cancelled(),
            "Tool lifecycle callback cancelled"
        );
        tools
            .exchange_context(
                self.step.as_ref(),
                &self.thread_id,
                &self.turn_id,
                cancellation.clone(),
                None,
                None,
                json!({"type":"_sdk_mcp_tool_lifecycle", "phase":phase,
                "call_id":self.call_id, "name":self.name.name,
                "namespace":self.name.namespace, "arguments":self.arguments,
                "output":output, "succeeded":succeeded}),
                context_callbacks::PreparationReply::ToolLifecycle,
            )
            .await?;
        ensure!(
            !cancellation.is_cancelled(),
            "Tool lifecycle callback cancelled"
        );
        Ok(())
    }
}

impl RecordedToolOutputObserver for Observer {
    fn on_mcp_entry(
        &self,
    ) -> codex_extension_api::ExtensionFuture<'_, std::result::Result<(), String>> {
        Box::pin(async move {
            self.deliver("start", None, true)
                .await
                .map_err(|error| error.to_string())?;
            self.started.store(true, Ordering::Release);
            Ok(())
        })
    }

    fn on_output<'a>(
        &'a self,
        output: &'a codex_history::ResponseItemEnvelope,
        succeeded: bool,
    ) -> codex_extension_api::ExtensionFuture<'a, std::result::Result<(), String>> {
        Box::pin(async move {
            if !self.started.load(Ordering::Acquire) {
                return Ok(());
            }
            let output = serde_json::to_value(&output.item).map_err(|error| error.to_string())?;
            self.deliver("end", Some(output), succeeded)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

pub(crate) fn capture(
    input: &ToolStartInput<'_>,
) -> Result<Option<Arc<dyn RecordedToolOutputObserver>>> {
    if input.mcp_tool.is_none() || input.thread_store.get::<Bindings>().is_none() {
        return Ok(None);
    }
    let tools = input
        .thread_store
        .get::<PythonTools>()
        .context("Tool lifecycle requires its SDK owner")?;
    let ToolPayload::Function { arguments } = input.payload else {
        return Ok(None);
    };
    let step = input.step_store.map(|captured| {
        let step = ExtensionData::new(format!(
            "tool-lifecycle:{}:{}",
            input.turn_id, input.call_id
        ));
        if let Some(source) = captured.get::<codex_extension_api::CapturedAgentProfile>() {
            step.insert(source.as_ref().clone());
        }
        if let Some(catalog) = captured.get::<ProfileCatalog>() {
            step.insert(catalog.as_ref().clone());
        }
        step
    });
    Ok(Some(Arc::new(Observer {
        tools: Arc::downgrade(&tools),
        step,
        thread_id: input.thread_store.level_id().to_owned(),
        turn_id: input.turn_id.to_owned(),
        call_id: input.call_id.to_owned(),
        name: input.tool_name.clone(),
        arguments: arguments.clone(),
        started: AtomicBool::new(false),
    })))
}

impl PythonTools {
    pub(crate) fn reply_tool_lifecycle(&self, response: Reply) -> Result<()> {
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
                context_callbacks::PreparationReply::ToolLifecycle(_)
            )),
            "Expired Tool lifecycle reply"
        );
        let pending = take_pending_step(&mut replies, id).expect("checked Tool lifecycle reply");
        let context_callbacks::PreparationReply::ToolLifecycle(reply) = pending.reply else {
            unreachable!()
        };
        reply
            .send(if response.failed { Err(()) } else { Ok(()) })
            .map_err(|_| anyhow::anyhow!("Expired Tool lifecycle reply"))
    }
}

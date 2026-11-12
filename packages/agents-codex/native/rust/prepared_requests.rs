//! One issuing turn owns each prepared sampling reply and dispatch capability.
use super::*;
use codex_extension_api::{
    ModelRequestContributor, ModelRequestInput, ModelResponseInterceptor, ModelToolAdmission,
    PreparedRequestAdmission, PreparedRequestData, PreparedRequestInput, PreparedRequestOutput,
};
use futures_util::future::BoxFuture;
use std::sync::atomic::AtomicBool;

pub(super) struct Owner {
    tools: Weak<PythonTools>,
    generation: Arc<Generation>,
    turn: String,
    thread: String,
    store: usize,
    live: AtomicBool,
}
impl Owner {
    fn check(&self) -> std::result::Result<Arc<PythonTools>, String> {
        let tools = self
            .tools
            .upgrade()
            .ok_or("Prepared request owner closed")?;
        if !self.live.load(Ordering::Acquire)
            || !tools.admits_generation(&self.generation)
            || !tools
                .prepared
                .lock()
                .expect("prepared owner poisoned")
                .as_ref()
                .is_some_and(|current| std::ptr::eq(current.as_ref(), self))
        {
            return Err("Prepared request owner retired".into());
        }
        Ok(tools)
    }
    pub(super) fn retire(&self) {
        self.live.store(false, Ordering::Release);
        if let Some(tools) = self.tools.upgrade() {
            let ids = {
                let replies = tools.step_replies.lock().expect("Step replies poisoned");
                replies.iter().filter_map(|(id, pending)| {
                    matches!(&pending.reply, context_callbacks::PreparationReply::PreparedRequest { owner, .. }
                        if std::ptr::eq(owner.as_ref(), self)).then_some(*id)
                }).collect::<Vec<_>>()
            };
            for id in ids {
                tools.retire_step_callback(id);
            }
        }
    }
}
#[derive(Default, Debug)]
pub(crate) struct Contributor;
impl ModelRequestContributor for Contributor {
    fn request(&self, _: ModelRequestInput<'_>) -> Option<Box<dyn ModelResponseInterceptor>> {
        None
    }
    fn prepares_request(&self, turn: &ExtensionData) -> bool {
        turn.get::<Owner>().is_some()
    }
    fn prepare_request(
        &self,
        input: PreparedRequestInput,
    ) -> BoxFuture<'_, std::result::Result<PreparedRequestOutput, String>> {
        Box::pin(async move {
            let owner = input
                .admission
                .turn_store()
                .get::<Owner>()
                .ok_or("Missing prepared request owner")?;
            let tools = owner.check()?;
            if owner.store != input.admission.turn_store() as *const ExtensionData as usize
                || owner.turn != input.admission.turn_store().level_id()
                || owner.thread != input.admission.thread_id()
                || tools.instance.is_some()
            {
                return Err("Expired prepared request store".into());
            }
            let generation = tools
                .generation_for_step(input.admission.step_store())
                .map_err(|error| error.to_string())?;
            let presentation = tools
                .schema_receipts
                .prepared(input.data)
                .map_err(|_| "Invalid prepared schema owner")?;
            let attempt = input.admission.model_attempt();
            let cancellation = attempt
                .as_ref()
                .map(|attempt| attempt.cancellation())
                .or_else(|| {
                    tools
                        .context_stop(&owner.turn)
                        .ok()
                        .and_then(|stop| stop.callback_cancellation())
                })
                .unwrap_or_else(tokio_util::sync::CancellationToken::new);
            let captured_owner = Arc::clone(&owner);
            let mut data = tools
                .exchange_context(
                    input.admission.step_store(),
                    input.admission.thread_id(),
                    &owner.turn,
                    cancellation,
                    attempt.clone(),
                    {
                        let mut message = json!({"type":"_sdk_prepare_request",
                        "recovery_attempt":input.recovery_attempt, "data":presentation.data,
                        "root_turn_id":input.admission.root_turn_id()});
                        if let Some(attempt) = &attempt {
                            message["attempt_id"] = json!(attempt.id());
                            message["attempt"] = json!(attempt.attempt());
                            message["retry_configured"] = json!(attempt.retry_configured());
                        }
                        message
                    },
                    |reply| context_callbacks::PreparationReply::PreparedRequest {
                        owner: captured_owner,
                        reply,
                    },
                )
                .await
                .map_err(|_| "Prepared request callback failed or cancelled")?;
            owner.check()?;
            let sampling_schemas = data
                .as_mut()
                .map(|data| {
                    tools
                        .schema_receipts
                        .reconcile_prepared(&presentation, data)
                })
                .transpose()
                .map_err(|_| "Invalid prepared schema presentation")?
                .flatten();
            Ok(PreparedRequestOutput {
                data,
                admission: Arc::new(Admission {
                    generation,
                    owner,
                    original: input.admission,
                    _sampling_schemas: sampling_schemas,
                }),
            })
        })
    }
}
struct Admission {
    generation: Arc<Generation>,
    owner: Arc<Owner>,
    original: Arc<dyn ModelToolAdmission>,
    // A sampling copy keeps only its own immutable presentation receipts alive.
    _sampling_schemas: Option<Arc<Generation>>,
}
impl std::fmt::Debug for Admission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PreparedRequestAdmission")
    }
}
impl PreparedRequestAdmission for Admission {
    fn admit_request(&self) -> std::result::Result<(), String> {
        let tools = self.owner.check()?;
        if self.original.model_attempt().is_some_and(|attempt| {
            attempt.cancellation().is_cancelled() || attempt.sampling_stop().requested()
        }) || !tools.admits_generation(&self.generation)
            || self.owner.store != self.original.turn_store() as *const ExtensionData as usize
            || !self
                .original
                .turn_store()
                .get::<Owner>()
                .is_some_and(|current| Arc::ptr_eq(&current, &self.owner))
        {
            return Err("Expired prepared request admission".into());
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reply {
    pub(crate) thread: String,
    turn_id: String,
    generation: String,
    request_id: String,
    // A failed callback closes the native wait without treating failure as no edit.
    failed: bool,
    data: Option<PreparedRequestData>,
}
impl PythonTools {
    pub(super) fn begin_preparation(self: &Arc<Self>, input: &TurnStartInput<'_>) {
        let enabled = input
            .turn_store
            .get::<Option<OperationSelection>>()
            .is_some_and(|operation| {
                operation
                    .as_ref()
                    .as_ref()
                    .is_some_and(|operation| operation.prepare_request)
            });
        if !enabled {
            self.retire_preparation(None);
            return;
        }
        let generation = input
            .turn_store
            .get::<Option<OperationSelection>>()
            .and_then(|operation| {
                operation.as_ref().as_ref().and_then(|operation| {
                    operation
                        .generation
                        .parse()
                        .ok()
                        .and_then(|id| self.resolve_generation(id))
                })
            })
            .unwrap_or_else(|| self.snapshot());
        let owner = input.turn_store.get_or_init(|| Owner {
            tools: Arc::downgrade(self),
            generation,
            turn: input.turn_id.to_owned(),
            thread: input.thread_store.level_id().to_owned(),
            store: input.turn_store as *const ExtensionData as usize,
            live: AtomicBool::new(true),
        });
        let previous = self
            .prepared
            .lock()
            .expect("prepared owner poisoned")
            .replace(owner.clone());
        if let Some(previous) = previous.filter(|previous| !Arc::ptr_eq(previous, &owner)) {
            previous.retire();
        }
    }
    pub(crate) fn reply_prepared(&self, thread: &str, response: Reply) -> Result<()> {
        let owner = self
            .prepared
            .lock()
            .expect("prepared owner poisoned")
            .clone()
            .context("Expired prepared request")?;
        owner.check().map_err(anyhow::Error::msg)?;
        ensure!(
            response.thread == thread && response.turn_id == owner.turn,
            "Expired prepared request owner"
        );
        ensure!(
            !(response.failed && response.data.is_some()),
            "Conflicting prepared reply"
        );
        let receipt = StepReply {
            thread: response.thread,
            instance: self.instance.clone(),
            turn_id: response.turn_id,
            generation: response.generation,
            request_id: response.request_id,
            slots: None,
            names: None,
        };
        let active = self
            .selection
            .lock()
            .expect("JavaScript selection poisoned");
        let mut replies = self.step_replies.lock().expect("Step replies poisoned");
        let id = crate::native_id(&receipt.request_id)?;
        ensure!(
            replies.get(&id).is_some_and(|pending| {
                self.step_matches(thread, &receipt, active.as_ref(), pending)
                    && matches!(&pending.reply,
                    context_callbacks::PreparationReply::PreparedRequest { owner: captured, .. }
                        if Arc::ptr_eq(captured, &owner))
            }),
            "Expired prepared source generation"
        );
        let pending = take_pending_step(&mut replies, id).expect("checked prepared reply");
        let context_callbacks::PreparationReply::PreparedRequest { reply, .. } = pending.reply
        else {
            unreachable!()
        };
        reply
            .send(if response.failed {
                Err(())
            } else {
                Ok(response.data)
            })
            .map_err(|_| anyhow::anyhow!("Expired prepared request reply"))
    }

    pub(crate) fn check_prepared_checkpoint(&self) -> Result<()> {
        ensure!(
            self.prepared
                .lock()
                .expect("prepared owner poisoned")
                .is_none(),
            "Cannot capture a prepared-request operation"
        );
        Ok(())
    }
    pub(super) fn retire_preparation(&self, turn: Option<&str>) {
        let retired = {
            let mut owner = self.prepared.lock().expect("prepared owner poisoned");
            if owner
                .as_ref()
                .is_some_and(|owner| turn.is_none_or(|turn| turn == owner.turn))
            {
                owner.take()
            } else {
                None
            }
        };
        if let Some(owner) = retired {
            owner.retire();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::ResponseItem;

    #[derive(Debug)]
    struct Original {
        turn: Arc<ExtensionData>,
    }
    impl ModelToolAdmission for Original {
        fn thread_id(&self) -> &str {
            "root"
        }
        fn turn_store(&self) -> &ExtensionData {
            &self.turn
        }
        fn admits(&self, _: &ResponseItem) -> bool {
            true
        }
    }
    fn fixture() -> (Arc<PythonTools>, Arc<ExtensionData>, Arc<Owner>) {
        let tools = super::super::pending_tests::tools();
        let turn = Arc::new(ExtensionData::new("turn"));
        let owner = turn.get_or_init(|| Owner {
            tools: Arc::downgrade(&tools),
            generation: tools.snapshot(),
            turn: "turn".into(),
            thread: "root".into(),
            store: turn.as_ref() as *const ExtensionData as usize,
            live: AtomicBool::new(true),
        });
        *tools.prepared.lock().unwrap() = Some(owner.clone());
        (tools, turn, owner)
    }
    fn input(turn: Arc<ExtensionData>) -> PreparedRequestInput {
        PreparedRequestInput {
            admission: Arc::new(Original { turn }),
            recovery_attempt: 0,
            data: PreparedRequestData {
                instructions: "original".into(),
                input: Vec::new(),
                tools: Vec::new(),
            },
        }
    }
    fn reply(event: &Value) -> Reply {
        serde_json::from_value(json!({ "thread":"root", "turn_id":"turn", "generation":"0", "request_id":event["msg"]["request_id"], "failed":false,"data":null })).unwrap()
    }
    #[tokio::test]
    async fn no_edit_retains_dispatch_admission_and_reply_is_one_shot() {
        let (tools, turn, owner) = fixture();
        let contributor = Contributor;
        let mut prepare = contributor.prepare_request(input(turn));
        assert!(futures_util::poll!(&mut prepare).is_pending());
        let event = tools.next_request().await;
        tools.reply_prepared("root", reply(&event)).unwrap();
        assert!(tools.reply_prepared("root", reply(&event)).is_err());
        let output = prepare.await.unwrap();
        assert!(output.data.is_none());
        assert!(output.admission.admit_request().is_ok());
        tools.retire_preparation(Some("turn"));
        assert!(!owner.live.load(Ordering::Acquire));
        assert!(output.admission.admit_request().is_err());
    }
    #[tokio::test]
    async fn dropped_wait_revokes_receipt_and_active_capture_is_refused() {
        let (tools, turn, _) = fixture();
        assert!(tools.check_prepared_checkpoint().is_err());
        let contributor = Contributor;
        let mut prepare = contributor.prepare_request(input(turn));
        assert!(futures_util::poll!(&mut prepare).is_pending());
        let event = tools.next_request().await;
        drop(prepare);
        assert!(tools.reply_prepared("root", reply(&event)).is_err());
        tools.retire_preparation(None);
        assert!(tools.check_prepared_checkpoint().is_ok());
    }
    #[tokio::test]
    async fn superseded_owner_and_exact_store_mismatch_cannot_dispatch() {
        let (tools, turn, owner) = fixture();
        let contributor = Contributor;
        let mut prepare = contributor.prepare_request(input(turn.clone()));
        assert!(futures_util::poll!(&mut prepare).is_pending());
        let event = tools.next_request().await;
        tools.reply_prepared("root", reply(&event)).unwrap();
        let output = prepare.await.unwrap();
        let impostor = Arc::new(ExtensionData::new("turn"));
        // Even the same marker and textual ID cannot change the original store identity.
        let wrong = Admission {
            generation: tools.resolve_generation(tools.generation()).unwrap(),
            owner: owner.clone(),
            original: Arc::new(Original { turn: impostor }),
            _sampling_schemas: None,
        };
        assert!(wrong.admit_request().is_err());
        *tools.prepared.lock().unwrap() = None;
        assert!(output.admission.admit_request().is_err());
        assert!(contributor.prepares_request(&turn));
    }
    #[tokio::test]
    async fn prepared_reply_waits_for_its_entered_callback_release() {
        let (tools, turn, _) = fixture();
        let contributor = Contributor;
        let mut prepare = contributor.prepare_request(input(turn));
        assert!(futures_util::poll!(&mut prepare).is_pending());
        let event = tools.next_request().await;
        let callback = event["msg"]["_sdk_callback"].clone();
        assert!(tools.callback_operation("root", &callback, "enter"));
        tools.reply_prepared("root", reply(&event)).unwrap();
        assert!(futures_util::poll!(&mut prepare).is_pending());
        assert!(tools.callback_operation("root", &callback, "release"));
        assert!(prepare.await.unwrap().admission.admit_request().is_ok());
    }
}

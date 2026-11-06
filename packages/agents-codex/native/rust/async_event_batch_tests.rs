//! Retained root-source lookahead must never apply control delivery effects.
use super::*;
use codex_protocol::protocol::AgentMessageContentDeltaEvent;
use pretty_assertions::{assert_eq, assert_ne};

const THREAD: &str = "00000000-0000-0000-0000-000000000001";
const TURN: &str = "original-turn";

fn delta(text: &str) -> Event {
    Event {
        id: TURN.into(),
        msg: EventMsg::AgentMessageContentDelta(AgentMessageContentDeltaEvent {
            thread_id: THREAD.into(),
            turn_id: TURN.into(),
            item_id: "message".into(),
            delta: text.into(),
        }),
    }
}

type SourceReceiver = Arc<Mutex<mpsc::UnboundedReceiver<Event>>>;

fn read(receiver: SourceReceiver, witness: Arc<AtomicBool>) -> NextNativeEvent {
    Box::pin(async move {
        let event = receiver
            .lock()
            .await
            .recv()
            .await
            .ok_or(codex_protocol::error::CodexErr::InternalAgentDied)?;
        witness.store(true, Ordering::Release);
        Ok((event, None))
    })
}

struct Source {
    send: mpsc::UnboundedSender<Event>,
    receive: SourceReceiver,
    witness: Arc<AtomicBool>,
    next: Option<NextNativeEvent>,
}

impl Source {
    fn new() -> Self {
        let (send, receive) = mpsc::unbounded_channel();
        let receive = Arc::new(Mutex::new(receive));
        let witness = Arc::new(AtomicBool::new(false));
        let next = Some(read(receive.clone(), witness.clone()));
        Self {
            send,
            receive,
            witness,
            next,
        }
    }

    fn take(&mut self, bytes: usize) -> Option<String> {
        let receive = self.receive.clone();
        let witness = self.witness.clone();
        take_ready_root_event(
            &mut self.next,
            &self.witness,
            THREAD,
            TURN,
            bytes,
            false,
            || read(receive, witness),
        )
        .map(|(raw, _)| raw)
    }
}

#[tokio::test]
async fn root_deltas_keep_exact_wire_order_and_the_next_source() {
    let mut source = Source::new();
    for text in ["zero", "one", "two", "α🙂"] {
        source.send.send(delta(text)).unwrap();
    }
    let mut output = Vec::new();
    while let Some(raw) = source.take(SESSION_EVENT_BATCH_BYTES) {
        let event: Event = serde_json::from_str(&raw).unwrap();
        let EventMsg::AgentMessageContentDelta(delta) = event.msg else {
            panic!("text expected")
        };
        output.push(delta.delta);
        assert!(!source.witness.load(Ordering::Acquire));
    }
    assert_eq!(output, ["zero", "one", "two", "α🙂"]);
    source.send.send(delta("later")).unwrap();
    let (received, question) = source.next.take().unwrap().await.unwrap();
    assert!(question.is_none());
    assert_eq!(
        serde_json::to_value(received).unwrap()["msg"]["delta"],
        "later"
    );
}

#[tokio::test]
async fn byte_budget_preserves_the_whole_original_event_and_witness() {
    let mut source = Source::new();
    let original = delta(&"🙂".repeat(100));
    let exact = serde_json::to_string(&original).unwrap();
    source.send.send(original).unwrap();
    assert!(source.take(exact.len() - 1).is_none());
    assert!(source.witness.load(Ordering::Acquire));
    assert_eq!(source.take(exact.len()), Some(exact));
    assert!(!source.witness.load(Ordering::Acquire));
}

#[tokio::test]
async fn a_control_event_stays_before_later_text_without_running_delivery() {
    let mut source = Source::new();
    source
        .send
        .send(Event {
            id: "control".into(),
            msg: EventMsg::ShutdownComplete,
        })
        .unwrap();
    source.send.send(delta("after-control")).unwrap();
    assert!(source.take(SESSION_EVENT_BATCH_BYTES).is_none());
    assert!(source.witness.load(Ordering::Acquire));
    // Repeated lookahead neither consumes the control nor reaches later text.
    assert!(source.take(SESSION_EVENT_BATCH_BYTES).is_none());
    assert_eq!(source.receive.lock().await.len(), 1);
    let (control, _) = source.next.take().unwrap().await.unwrap();
    assert_eq!(control.id, "control");
    assert!(matches!(control.msg, EventMsg::ShutdownComplete));
    assert_eq!(source.receive.lock().await.recv().await.unwrap().id, TURN);
}

#[tokio::test]
async fn text_from_another_turn_or_thread_is_not_committed() {
    for other in ["turn", "thread"] {
        let mut source = Source::new();
        let mut event = delta("belongs elsewhere");
        let EventMsg::AgentMessageContentDelta(data) = &mut event.msg else {
            unreachable!()
        };
        if other == "turn" {
            event.id = "successor-turn".into();
            data.turn_id = event.id.clone();
        } else {
            data.thread_id = "another-thread".into();
        }
        let expected = serde_json::to_value(&event).unwrap();
        source.send.send(event).unwrap();
        assert!(source.take(SESSION_EVENT_BATCH_BYTES).is_none());
        let (held, _) = source.next.take().unwrap().await.unwrap();
        assert_eq!(serde_json::to_value(held).unwrap(), expected);
    }
}

#[tokio::test]
async fn pending_question_metadata_survives_a_nonwaiting_poll() {
    let (metadata_send, metadata_receive) = tokio::sync::oneshot::channel();
    let witness = Arc::new(AtomicBool::new(false));
    let dequeued = witness.clone();
    let mut next: Option<NextNativeEvent> = Some(Box::pin(async move {
        // Model an event already removed from Core whose owned metadata is not ready.
        dequeued.store(true, Ordering::Release);
        metadata_receive.await.unwrap();
        Ok((
            Event {
                id: "held-control".into(),
                msg: EventMsg::ShutdownComplete,
            },
            None,
        ))
    }));
    assert!(
        take_ready_root_event(&mut next, &witness, THREAD, TURN, 1024, false, || panic!(
            "pending lookahead cannot replace the source"
        ))
        .is_none()
    );
    assert!(witness.load(Ordering::Acquire));
    // Ending the nonwaiting attempt must not cancel the still-owned future.
    metadata_send.send(()).unwrap();
    assert!(prefetch_event(&mut next, Some(&witness)).await.unwrap());
    let (event, _) = next.take().unwrap().await.unwrap();
    assert_eq!(event.id, "held-control");
}

#[tokio::test]
async fn source_closure_is_retained_instead_of_discarding_a_partial_batch() {
    let mut source = Source::new();
    source.receive.lock().await.close();
    assert!(source.take(SESSION_EVENT_BATCH_BYTES).is_none());
    assert!(source.next.take().unwrap().await.is_err());
}

#[tokio::test]
async fn a_dequeued_source_error_keeps_its_witness_until_normal_consumption() {
    let witness = Arc::new(AtomicBool::new(true));
    let mut next: Option<NextNativeEvent> = Some(Box::pin(async {
        Err(codex_protocol::error::CodexErr::InvalidRequest(
            "retained source error".into(),
        ))
    }));
    assert!(
        take_ready_root_event(&mut next, &witness, THREAD, TURN, 1024, false, || panic!(
            "failed lookahead cannot replace the source"
        ))
        .is_none()
    );
    assert!(witness.load(Ordering::Acquire));
    let Err(error) = next.take().unwrap().await else {
        panic!("source failure stays a failure")
    };
    assert!(
        matches!(error.details(), codex_protocol::error::CodexErrorDetails::InvalidRequest(message)
        if message == "retained source error")
    );
}

#[test]
fn certificate_requires_the_complete_fixed_root_text_shape() {
    let original = serde_json::to_value(delta("plain α🙂\n\\\" text")).unwrap();
    assert!(certified_root_text(&original, THREAD));
    assert!(!certified_root_text(&original, "another-thread"));
    for key in [
        "nonce",
        "generation",
        "subagent_id",
        "subagent_instance_id",
        "unknown",
    ] {
        let mut changed = original.clone();
        changed[key] = serde_json::json!(123);
        assert!(!certified_root_text(&changed, THREAD), "root field {key}");
    }
    for key in ["_sdk_python_tool", "generation", "unknown"] {
        let mut changed = original.clone();
        changed["msg"][key] = serde_json::json!(123);
        assert!(
            !certified_root_text(&changed, THREAD),
            "message field {key}"
        );
    }
    for key in ["type", "thread_id", "turn_id", "item_id", "delta"] {
        for replacement in [
            serde_json::Value::Null,
            serde_json::json!(7),
            serde_json::json!({}),
        ] {
            let mut changed = original.clone();
            changed["msg"][key] = replacement;
            assert!(!certified_root_text(&changed, THREAD), "non-string {key}");
        }
    }
    let mut wrong_turn = original.clone();
    wrong_turn["id"] = serde_json::json!("another-turn");
    assert!(!certified_root_text(&wrong_turn, THREAD));
    let control = Event {
        id: TURN.into(),
        msg: EventMsg::ShutdownComplete,
    };
    assert!(root_text_fields(&control).is_none());
    assert!(!certified_root_text(
        &serde_json::to_value(control).unwrap(),
        THREAD
    ));
}

#[tokio::test]
async fn changing_item_ids_and_unicode_keep_individual_wire_events() {
    let mut source = Source::new();
    let mut expected = Vec::new();
    for (item, text) in [
        ("first-item", "α🙂"),
        ("second-item", "line\n\\\"next"),
        ("first-item", ""),
    ] {
        let mut event = delta(text);
        if let EventMsg::AgentMessageContentDelta(data) = &mut event.msg {
            data.item_id = item.into();
        }
        expected.push(serde_json::to_value(&event).unwrap());
        source.send.send(event).unwrap();
    }
    let mut actual = Vec::new();
    while let Some(raw) = source.take(SESSION_EVENT_BATCH_BYTES) {
        let event: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(certified_root_text(&event, THREAD));
        actual.push(event);
    }
    assert_eq!(actual, expected);
    assert_eq!(actual.len(), 3);
}

// Exercise publication accounting through the actual ThreadState multiplexer,
// not only the source helper. Only the retained source result is prescribed.
#[tokio::test]
async fn retained_control_and_error_precede_publication_without_escaping_their_owner() {
    use codex_protocol::protocol::WarningEvent;
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = crate::local_storage_tests::Provider::start().await;
        let home = tempfile::tempdir().unwrap();
        let engine = crate::create_engine(
            provider.config().to_string(),
            serde_json::json!({"codex_home":home.path(),"cwd":home.path()}).to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        let thread = engine
            .start_replaceable_thread("{}".into(), "[]".into())
            .await
            .unwrap();
        let state = thread.current().unwrap();
        let mut oversized = delta(&"x".repeat(SESSION_EVENT_BATCH_BYTES));
        if let EventMsg::AgentMessageContentDelta(data) = &mut oversized.msg {
            data.thread_id = state.id.to_string();
        }
        state.events.lock().await.initial = Some(oversized);
        let (batch, root_text_only) = state.next_session_events().await.unwrap();
        assert_eq!(batch.len(), 1);
        assert!(batch[0].len() > SESSION_EVENT_BATCH_BYTES);
        assert!(!root_text_only);
        for error in [false, true] {
            let mut text = delta("before-control");
            if let EventMsg::AgentMessageContentDelta(data) = &mut text.msg {
                data.thread_id = state.id.to_string();
            }
            let control = Event {
                id: "retained-control".into(),
                msg: if error {
                    EventMsg::Error(
                        codex_protocol::error::CodexErr::InvalidRequest(
                            "retained diagnostic".into(),
                        )
                        .to_error_event(None),
                    )
                } else {
                    EventMsg::Warning(WarningEvent {
                        message: "retained control".into(),
                    })
                },
            };
            let expected = serde_json::to_value(&control).unwrap();
            let (metadata_send, metadata_receive) = tokio::sync::oneshot::channel();
            // Keep unrelated startup/discovery notifications from preempting
            // this prescribed root-source interleaving. Their senders stay
            // alive until the assertion completes. The real Core root queue,
            // prefix snapshot, projection, and close paths remain in use.
            let (_created_send, created_receive) = broadcast::channel(1);
            let (extensions_send, extensions_receive) = broadcast::channel(1);
            let (_graph_send, graph_receive) = mpsc::unbounded_channel();
            {
                let mut events = state.events.lock().await;
                events.created = created_receive;
                events.graph = graph_receive;
                events.extensions = extensions_receive;
                events.initial = Some(text);
                let witness = events.native_dequeued.clone();
                witness.store(false, Ordering::Release);
                events.native = Some(Box::pin(async move {
                    witness.store(true, Ordering::Release);
                    metadata_receive.await.expect("retained metadata owner");
                    Ok((control, None))
                }));
            }
            let (batch, root_text_only) = state.next_session_events().await.unwrap();
            assert!(root_text_only);
            assert_eq!(batch.len(), 1);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&batch[0]).unwrap()["msg"]["delta"],
                "before-control"
            );
            assert!(
                state
                    .events
                    .lock()
                    .await
                    .native_dequeued
                    .load(Ordering::Acquire)
            );
            state
                .request_publication_boundary("after-retained-control".into())
                .unwrap();
            let mut retained_read = Box::pin(state.next_session_events());
            let held = poll_fn(|cx| Poll::Ready(retained_read.as_mut().poll(cx))).await;
            assert!(
                matches!(held, Poll::Pending),
                "publication cannot bypass held metadata"
            );
            metadata_send.send(()).unwrap();
            let mut delivered = 0;
            let mut batch = retained_read.await.unwrap().0;
            loop {
                assert_eq!(batch.len(), 1);
                let value: serde_json::Value = serde_json::from_str(&batch[0]).unwrap();
                if value["id"] == "retained-control" {
                    delivered += 1;
                    assert_eq!(value["msg"], expected["msg"]);
                    assert!(
                        !state
                            .events
                            .lock()
                            .await
                            .native_dequeued
                            .load(Ordering::Acquire)
                    );
                }
                if value["msg"]["type"] == "sdk_mcp_publication_boundary" {
                    assert_eq!(value["id"], "after-retained-control");
                    break;
                }
                batch = state.next_session_events().await.unwrap().0;
            }
            assert_eq!(delivered, 1);
            let mut later = delta("after-boundary");
            if let EventMsg::AgentMessageContentDelta(data) = &mut later.msg {
                data.thread_id = state.id.to_string();
            }
            extensions_send.send((String::new(), later)).unwrap();
            // Core startup may enqueue events after the finite prefix snapshot.
            // They may interleave, but cannot cause duplicate control delivery.
            let mut later_delivered = false;
            while !later_delivered {
                let after = state.next_session_events().await.unwrap().0;
                for wire in after {
                    let value: serde_json::Value = serde_json::from_str(&wire).unwrap();
                    assert_ne!(value["id"], "retained-control");
                    if value["msg"]["delta"] == "after-boundary" {
                        later_delivered = true;
                    }
                }
            }
        }
        thread.close().await.unwrap();
        engine.close().await.unwrap();
    })
    .await
    .expect("retained publication must finish within the deadline");
}

// Apply only after the certified batching implementation is rebased onto 51e5.
// Use genuine selector receipts; prescribe only the retained-source seam already
// used above. No model response is allowed while these receipts await a reply.
struct RootStepBatchFixture {
    provider: crate::local_storage_tests::Provider,
    _home: tempfile::TempDir,
    engine: crate::Engine,
    thread: crate::NativeThread,
    state: crate::RuntimeOwned<ThreadState>,
    tools: Arc<crate::python_tools::PythonTools>,
    request: serde_json::Value,
    _created: broadcast::Sender<ThreadId>,
    _extensions: broadcast::Sender<(String, Event)>,
    _graph: mpsc::UnboundedSender<crate::storage::GraphEvent>,
}

impl RootStepBatchFixture {
    async fn new() -> Self {
        Self::with_manual(false).await
    }

    async fn with_manual(manual: bool) -> Self {
        let provider = crate::local_storage_tests::Provider::start().await;
        let home = tempfile::tempdir().unwrap();
        let engine = crate::create_engine(
            provider.config().to_string(),
            serde_json::json!({"codex_home":home.path(),"cwd":home.path()}).to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        let thread = engine
            .start_replaceable_thread(
                crate::local_storage_tests::options(None),
                crate::local_storage_tests::specs(),
            )
            .await
            .unwrap();
        let state = thread.current().unwrap();
        let tools = state
            .thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
            .unwrap();
        if manual {
            thread
                ._configure_manual_tools("[{\"name\":\"lookup\"}]".into())
                .unwrap();
            assert!(tools.has_manual_tools());
        }
        let started: serde_json::Value = serde_json::from_str(
            &thread
                ._submit(
                    serde_json::json!({
                        "mode":"start_if_idle",
                        "input":[{"type":"text","text":"root step batching boundary"}],
                        "selection":{
                            "generation":tools.generation().to_string(),
                            "slots":[0],
                            "before_step":true
                        }
                    })
                    .to_string(),
                )
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(started["status"], "started");
        // Capture the real issuer's request before installing its retained
        // ThreadEvents slot. This also empties the family inbox: that existing
        // batch stop condition must not mask the missing root_step guard.
        let request = tools.next_request().await;
        assert_eq!(request["msg"]["type"], "_sdk_select_step");
        assert!(request.get("subagent_id").is_none());
        assert_eq!(request["id"], started["turn_id"]);
        assert!(!tools.has_pending_request());
        let (created, created_receive) = broadcast::channel(1);
        let (extensions, extensions_receive) = broadcast::channel(1);
        let (graph, graph_receive) = mpsc::unbounded_channel();
        {
            let mut events = state.events.lock().await;
            events.created = created_receive;
            events.extensions = extensions_receive;
            events.graph = graph_receive;
            events.initial = None;
            assert!(events.root_step.is_none());
            assert!(events.publication_prefix.is_none());
            assert!(events.children.is_empty());
            assert!(events.pending.is_empty());
            assert!(events.deferred_child_steps.is_empty());
            assert!(events.boundary_requests.is_empty());
            assert!(events.session_terminal.is_none());
        }
        let fixture = Self {
            provider,
            _home: home,
            engine,
            thread,
            state,
            tools,
            request,
            _created: created,
            _extensions: extensions,
            _graph: graph,
        };
        assert!(fixture.selector_current());
        assert_eq!(fixture.provider.request_count(), 0);
        fixture
    }

    fn reply(&self) -> crate::python_tools::StepReply {
        serde_json::from_value(serde_json::json!({
            "thread":self.request["msg"]["thread"],
            "turn_id":self.request["msg"]["turn_id"],
            "generation":self.request["msg"]["generation"],
            "request_id":self.request["msg"]["request_id"]
        }))
        .unwrap()
    }

    fn selector_current(&self) -> bool {
        self.tools
            .check_step(&self.state.id.to_string(), &self.reply())
            .unwrap()
    }

    fn text(&self, value: &str) -> Event {
        Event {
            id: self.request["id"].as_str().unwrap().into(),
            msg: EventMsg::AgentMessageContentDelta(AgentMessageContentDeltaEvent {
                thread_id: self.state.id.to_string(),
                turn_id: self.request["id"].as_str().unwrap().into(),
                item_id: "root-step-text".into(),
                delta: value.into(),
            }),
        }
    }

    async fn retain_prefix(
        &self,
        initial: Option<Event>,
        source: impl FnOnce(Arc<AtomicBool>) -> NextNativeEvent,
    ) -> usize {
        let mut events = self.state.events.lock().await;
        let witness = events.native_dequeued.clone();
        witness.store(false, Ordering::Release);
        events.native = Some(source(witness.clone()));
        // Use the real 51e5 finite snapshot, including a dequeued source still
        // awaiting metadata. Remaining Core startup events stay in the queue.
        let count = snapshot_event_prefix(
            &self.state.thread,
            &mut events.native,
            Some(witness.as_ref()),
        )
        .await
        .unwrap();
        assert!(
            count > 0,
            "prescribed retained source belongs to the prefix"
        );
        events.root_step = Some((self.request.clone(), count));
        events.initial = initial;
        count
    }

    async fn batch(&self) -> (Vec<serde_json::Value>, bool) {
        let (wire, certified) = self.state.next_session_events().await.unwrap();
        assert_eq!(wire.len(), 1, "a retained root step forbids batch extras");
        (
            wire.iter()
                .map(|raw| serde_json::from_str(raw).unwrap())
                .collect(),
            certified,
        )
    }

    async fn drain_prefix(&self, count: usize) -> Vec<serde_json::Value> {
        let mut delivered = Vec::new();
        for remaining in (0..count).rev() {
            let (batch, _) = self.batch().await;
            assert_ne!(batch[0]["msg"]["type"], "_sdk_select_step");
            assert_eq!(
                self.state.events.lock().await.root_step.as_ref().unwrap().1,
                remaining,
                "only normal native delivery decrements the finite prefix"
            );
            delivered.extend(batch);
        }
        delivered
    }
}

#[tokio::test]
async fn root_step_batch_stops_at_positive_and_zero_remaining_prefixes() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = RootStepBatchFixture::new().await;
        let first = fixture.text("first-projection");
        let retained = fixture.text("captured-prefix");
        let count = fixture
            .retain_prefix(Some(first), move |witness| -> NextNativeEvent {
                Box::pin(async move {
                    witness.store(true, Ordering::Release);
                    Ok((retained, None))
                })
            })
            .await;
        assert!(!fixture.tools.has_pending_request());
        assert!(!fixture.state.request_metadata.has_pending());
        let (first, certified) = fixture.batch().await;
        assert!(certified);
        assert_eq!(first[0]["msg"]["delta"], "first-projection");
        assert_eq!(
            fixture
                .state
                .events
                .lock()
                .await
                .root_step
                .as_ref()
                .unwrap()
                .1,
            count
        );
        let prefix = fixture.drain_prefix(count).await;
        assert_eq!(
            prefix
                .iter()
                .filter(|event| event["msg"]["delta"] == "captured-prefix")
                .count(),
            1
        );
        assert!(fixture.selector_current());

        let tail = fixture.text("after-selector");
        let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let mut events = fixture.state.events.lock().await;
            // Reuse the existing first-projection seam to model the instant
            // after the final normal prefix delivery decremented its count to
            // zero, before batching considers another ready native event.
            events.initial = Some(fixture.text("last-prefix-projection"));
            let witness = events.native_dequeued.clone();
            witness.store(false, Ordering::Release);
            let polled = polls.clone();
            events.native = Some(Box::pin(async move {
                polled.fetch_add(1, Ordering::AcqRel);
                witness.store(true, Ordering::Release);
                Ok((tail, None))
            }));
        }
        let (last, certified) = fixture.batch().await;
        assert!(certified);
        assert_eq!(last[0]["msg"]["delta"], "last-prefix-projection");
        assert_eq!(polls.load(Ordering::Acquire), 0);
        assert_eq!(
            fixture
                .state
                .events
                .lock()
                .await
                .root_step
                .as_ref()
                .unwrap()
                .1,
            0
        );
        let (selected, certified) = fixture.batch().await;
        assert!(!certified);
        assert_eq!(selected[0], fixture.request);
        assert!(fixture.state.events.lock().await.root_step.is_none());
        assert_eq!(
            polls.load(Ordering::Acquire),
            0,
            "selector precedes future tail"
        );
        let (tail, _) = fixture.batch().await;
        assert_eq!(tail[0]["msg"]["delta"], "after-selector");
        assert_eq!(polls.load(Ordering::Acquire), 1);
        assert_eq!(fixture.provider.request_count(), 0);
        fixture.thread.close().await.unwrap();
        assert!(!fixture.selector_current());
        fixture.engine.close().await.unwrap();
    })
    .await
    .expect("root step prefix and selector must settle within the deadline");
}

#[tokio::test]
async fn canceled_root_step_read_retains_prefix_then_discards_revoked_selector() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = RootStepBatchFixture::new().await;
        let retained = fixture.text("held-prefix");
        let (send, receive) = tokio::sync::oneshot::channel();
        let count = fixture
            .retain_prefix(None, move |witness| -> NextNativeEvent {
                Box::pin(async move {
                    witness.store(true, Ordering::Release);
                    receive.await.expect("retained prefix metadata owner");
                    Ok((retained, None))
                })
            })
            .await;
        let mut reading = Box::pin(fixture.state.next_session_events());
        let first_poll = poll_fn(|cx| Poll::Ready(reading.as_mut().poll(cx))).await;
        assert!(matches!(first_poll, Poll::Pending));
        drop(reading);
        {
            let events = fixture.state.events.lock().await;
            assert_eq!(events.root_step.as_ref().unwrap().1, count);
            assert!(events.native_dequeued.load(Ordering::Acquire));
        }
        assert!(fixture.selector_current());
        fixture.thread.interrupt_session().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.selector_current() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Core interruption must revoke its original selector");
        send.send(())
            .expect("canceling a read must retain metadata receiver");
        let prefix = fixture.drain_prefix(count).await;
        assert_eq!(
            prefix
                .iter()
                .filter(|event| event["msg"]["delta"] == "held-prefix")
                .count(),
            1
        );
        {
            let mut events = fixture.state.events.lock().await;
            let witness = events.native_dequeued.clone();
            witness.store(false, Ordering::Release);
            events.native = Some(Box::pin(async move {
                witness.store(true, Ordering::Release);
                Ok((
                    Event {
                        id: "after-revoked-selector".into(),
                        msg: EventMsg::Warning(codex_protocol::protocol::WarningEvent {
                            message: "revoked selector was skipped".into(),
                        }),
                    },
                    None,
                ))
            }));
        }
        let (after, certified) = fixture.batch().await;
        assert!(!certified);
        assert_eq!(after[0]["id"], "after-revoked-selector");
        assert_ne!(after[0]["msg"]["type"], "_sdk_select_step");
        assert!(fixture.state.events.lock().await.root_step.is_none());
        assert_eq!(fixture.provider.request_count(), 0);
        fixture.thread.close().await.unwrap();
        fixture.engine.close().await.unwrap();
    })
    .await
    .expect("cancellation and selector revocation must settle within the deadline");
}

#[tokio::test]
async fn close_retires_root_step_and_its_metadata_wait_without_publishing() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = RootStepBatchFixture::new().await;
        let retained = fixture.text("must-not-publish-after-close");
        let (send, receive) = tokio::sync::oneshot::channel();
        fixture
            .retain_prefix(None, move |witness| -> NextNativeEvent {
                Box::pin(async move {
                    witness.store(true, Ordering::Release);
                    receive.await.expect("retained metadata before close");
                    Ok((retained, None))
                })
            })
            .await;
        let mut reading = Box::pin(fixture.state.next_session_events());
        assert!(matches!(
            poll_fn(|cx| Poll::Ready(reading.as_mut().poll(cx))).await,
            Poll::Pending
        ));
        drop(reading);
        fixture.thread.close().await.unwrap();
        {
            let events = fixture.state.events.lock().await;
            assert!(events.root_step.is_none());
            assert!(events.native.is_none());
        }
        assert!(
            send.send(()).is_err(),
            "close must release retained metadata ownership"
        );
        assert!(!fixture.selector_current());
        assert!(fixture.state.next_session_events().await.is_err());
        assert_eq!(fixture.provider.request_count(), 0);
        fixture.engine.close().await.unwrap();
    })
    .await
    .expect("closing a retained root step must settle within the deadline");
}

fn passive_event(kind: &str, fields: serde_json::Value) -> Event {
    let mut msg = fields.as_object().unwrap().clone();
    msg.insert("type".into(), kind.into());
    serde_json::from_value(serde_json::json!({"id": TURN, "msg": msg})).unwrap()
}

impl Source {
    fn take_passive(&mut self, bytes: usize) -> Option<(String, bool)> {
        let receive = self.receive.clone();
        let witness = self.witness.clone();
        take_ready_root_event(
            &mut self.next,
            &self.witness,
            THREAD,
            TURN,
            bytes,
            true,
            || read(receive, witness),
        )
    }
}

#[tokio::test]
async fn ready_passives_preserve_order_usage_strings_and_text_certification() {
    let mut source = Source::new();
    source
        .send
        .send(passive_event(
            "agent_reasoning",
            serde_json::json!({"text":"reason"}),
        ))
        .unwrap();
    source.send.send(delta("answer")).unwrap();
    let counters = passive_event(
        "token_count",
        serde_json::json!({
            "info": null, "rate_limits": null,
            "api_rate_limits":{
                "requests":{"limit":9007199254740993_u64,"remaining":7,"reset_after":"6m0s"},
                "tokens":{"reset_after":"1s"},
                "project_tokens":{"reset_after":"2s"},
                "retry_after":"3"
            }
        }),
    );
    assert_eq!(
        ready_passive_min_bytes(&counters, THREAD, TURN),
        Some(TURN.len() + 9)
    );
    source.send.send(counters).unwrap();
    let (raw, certified) = source.take_passive(SESSION_EVENT_BATCH_BYTES).unwrap();
    assert!(!certified);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["msg"]["text"],
        "reason"
    );
    let (raw, certified) = source.take_passive(SESSION_EVENT_BATCH_BYTES).unwrap();
    assert!(certified);
    assert_eq!(
        raw,
        serde_json::to_string(&delta("answer")).unwrap(),
        "existing text wire order stays intact"
    );
    let (raw, certified) = source.take_passive(SESSION_EVENT_BATCH_BYTES).unwrap();
    assert!(!certified);
    let usage: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        usage["msg"]["api_rate_limits"]["requests"]["limit"],
        "9007199254740993"
    );
    assert_eq!(usage["msg"]["api_rate_limits"]["requests"]["remaining"], 7);
    assert_eq!(
        usage["msg"]["api_rate_limits"]["requests"]["reset_after"],
        "6m0s"
    );
    assert_eq!(
        usage["msg"]["api_rate_limits"]["tokens"]["reset_after"],
        "1s"
    );
    assert_eq!(
        usage["msg"]["api_rate_limits"]["project_tokens"]["reset_after"],
        "2s"
    );
    assert_eq!(usage["msg"]["api_rate_limits"]["retry_after"], "3");
    // The ready-only attempt returns now and leaves the same pending source.
    assert!(source.take_passive(SESSION_EVENT_BATCH_BYTES).is_none());
    source.send.send(delta("later")).unwrap();
    assert_eq!(source.next.take().unwrap().await.unwrap().0.id, TURN);
}

#[tokio::test]
async fn passive_oversize_controls_and_errors_remain_in_the_raw_slot() {
    let mut source = Source::new();
    let oversized = passive_event(
        "agent_reasoning",
        serde_json::json!({"text":"🙂".repeat(100)}),
    );
    let expected = native_event(None, &oversized).unwrap();
    let bytes = serde_json::to_string(&expected).unwrap();
    source.send.send(oversized).unwrap();
    assert!(source.take_passive(bytes.len() - 1).is_none());
    assert!(source.witness.load(Ordering::Acquire));
    assert_eq!(source.take_passive(bytes.len()).unwrap().0, bytes);
    for msg in [
        EventMsg::ShutdownComplete,
        EventMsg::RawResponseCompleted(codex_protocol::protocol::RawResponseCompletedEvent {
            response_id: "barrier".into(),
            token_usage: None,
            usage_metadata: None,
        }),
    ] {
        source
            .send
            .send(Event {
                id: TURN.into(),
                msg,
            })
            .unwrap();
        assert!(source.take_passive(SESSION_EVENT_BATCH_BYTES).is_none());
        assert!(source.take_passive(SESSION_EVENT_BATCH_BYTES).is_none());
        assert!(source.witness.load(Ordering::Acquire));
        let (event, _) = source.next.take().unwrap().await.unwrap();
        assert!(matches!(
            event.msg,
            EventMsg::ShutdownComplete | EventMsg::RawResponseCompleted(_)
        ));
        source.witness.store(false, Ordering::Release);
        source.next = Some(read(source.receive.clone(), source.witness.clone()));
    }
    source.receive.lock().await.close();
    assert!(source.take_passive(SESSION_EVENT_BATCH_BYTES).is_none());
    assert!(source.next.take().unwrap().await.is_err());
}

#[tokio::test]
async fn passive_pending_metadata_keeps_the_original_future_and_witness() {
    let (send, receive) = tokio::sync::oneshot::channel();
    let witness = Arc::new(AtomicBool::new(false));
    let captured = witness.clone();
    let mut next: Option<NextNativeEvent> = Some(Box::pin(async move {
        captured.store(true, Ordering::Release);
        receive.await.unwrap();
        Ok((delta("owned"), None))
    }));
    assert!(
        take_ready_root_event(&mut next, &witness, THREAD, TURN, 1024, true, || panic!(
            "pending source must not be replaced"
        ))
        .is_none()
    );
    assert!(witness.load(Ordering::Acquire));
    send.send(()).unwrap();
    assert_eq!(next.take().unwrap().await.unwrap().0.id, TURN);
}

#[test]
fn passive_certificate_rejects_new_kinds_controls_children_and_search_completion() {
    for kind in [
        "unknown_future_kind",
        "_sdk_request_metadata",
        "_sdk_select_step",
        "_sdk_prepare_request",
        "error",
        "task_complete",
        "turn_aborted",
        "item_completed",
    ] {
        assert!(!ready_passive_root_value(
            &serde_json::json!({"id":TURN,"msg":{"type":kind}}),
            THREAD,
            TURN
        ));
    }
    for item in ["WebSearch", "ContextCompaction", "UnknownFutureItem"] {
        assert!(!ready_passive_root_value(
            &serde_json::json!({
                "id": TURN, "msg": {"type":"item_started", "thread_id":THREAD, "turn_id":TURN,
                "item":{"type":item}}
            }),
            THREAD,
            TURN
        ));
    }
    let mut root = serde_json::json!({"id":TURN,"msg":{"type":"agent_reasoning","text":"x"}});
    assert!(ready_passive_root_value(&root, THREAD, TURN));
    root["subagent_id"] = "child".into();
    assert!(!ready_passive_root_value(&root, THREAD, TURN));
    root.as_object_mut().unwrap().remove("subagent_id");
    assert!(!ready_passive_root_value(&root, THREAD, "other-turn"));
}

#[tokio::test]
async fn ready_passive_batch_still_stops_at_a_real_root_step_prefix() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = RootStepBatchFixture::new().await;
        let first = fixture.text("first");
        let extra = fixture.text("held");
        let count = fixture
            .retain_prefix(Some(first), move |witness| -> NextNativeEvent {
                Box::pin(async move {
                    witness.store(true, Ordering::Release);
                    Ok((extra, None))
                })
            })
            .await;
        assert!(!fixture.tools.has_manual_tools());
        let (batch, certified) = fixture.state.next_session_events().await.unwrap();
        assert_eq!(batch.len(), 1);
        assert!(certified);
        assert_eq!(
            fixture
                .state
                .events
                .lock()
                .await
                .root_step
                .as_ref()
                .unwrap()
                .1,
            count
        );
        assert_eq!(fixture.provider.request_count(), 0);
        fixture.thread.close().await.unwrap();
        fixture.engine.close().await.unwrap();
    })
    .await
    .expect("root step guard must settle");
}

#[tokio::test]
async fn ready_passive_batch_keeps_request_metadata_a_selector_boundary() {
    use codex_extension_api::{
        ExtensionData, ExtensionDataInit, ModelRequestDispatching, ModelRequestObservation,
        ModelRequestObservationRoute, ModelRequestTransport, ModelRequestWire,
    };
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = RootStepBatchFixture::new().await;
        let turn = fixture.request["id"].as_str().unwrap();
        assert!(!fixture.tools.has_manual_tools());
        let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let mut events = fixture.state.events.lock().await;
            events.initial = Some(fixture.text("first"));
            let counted = polls.clone();
            let extra = fixture.text("after-metadata");
            let witness = events.native_dequeued.clone();
            events.native = Some(Box::pin(async move {
                counted.fetch_add(1, Ordering::AcqRel);
                witness.store(true, Ordering::Release);
                Ok((extra, None))
            }));
        }
        let mut init = ExtensionDataInit::new();
        fixture.state.request_metadata.seed(
            &mut init,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            fixture.state.id.to_string(),
        );
        let store = ExtensionData::new_with_init(turn, init);
        store
            .get::<ModelRequestObservationRoute>()
            .unwrap()
            .0
            .observe(ModelRequestObservation::Dispatching(
                ModelRequestDispatching {
                    request_id: "metadata".into(),
                    thread_id: fixture.state.id.to_string(),
                    turn_id: turn.into(),
                    model: "model".into(),
                    reasoning_effort: None,
                    reasoning_summary: None,
                    service_tier: None,
                    wire: ModelRequestWire::Responses,
                    transport: ModelRequestTransport::HttpSse,
                },
            ));
        assert!(fixture.state.request_metadata.has_pending());
        let (first, _) = fixture.state.next_session_events().await.unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(polls.load(Ordering::Acquire), 0);
        let (metadata, _) = fixture.state.next_session_events().await.unwrap();
        assert_eq!(metadata.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&metadata[0]).unwrap()["msg"]["type"],
            "_sdk_request_metadata"
        );
        assert_eq!(polls.load(Ordering::Acquire), 0);
        let (next, _) = fixture.state.next_session_events().await.unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&next[0]).unwrap()["msg"]["delta"],
            "after-metadata"
        );
        assert_eq!(polls.load(Ordering::Acquire), 1);
        assert_eq!(fixture.provider.request_count(), 0);
        fixture.thread.close().await.unwrap();
        fixture.engine.close().await.unwrap();
    })
    .await
    .expect("metadata priority must settle");
}

#[tokio::test]
async fn mixed_ready_batch_projects_without_claiming_text_only() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = RootStepBatchFixture::with_manual(true).await;
        assert!(fixture.tools.has_manual_tools());
        let turn = fixture.request["id"].as_str().unwrap();
        // Observe the real root start before prescribing the retained source.
        loop {
            let started = fixture.state.next_session_event().await.unwrap();
            if started["msg"]["type"] == "task_started" {
                assert_eq!(started["id"], turn);
                break;
            }
        }
        {
            let mut events = fixture.state.events.lock().await;
            events.initial = Some(Event {
                id: turn.into(),
                msg: EventMsg::AgentReasoning(codex_protocol::protocol::AgentReasoningEvent {
                    text: "reason".into(),
                }),
            });
            let extra = fixture.text("answer");
            let witness = events.native_dequeued.clone();
            events.native = Some(Box::pin(async move {
                witness.store(true, Ordering::Release);
                Ok((extra, None))
            }));
        }
        let (batch, certified) = fixture.state.next_session_events().await.unwrap();
        assert!(batch.len() >= 2 && batch.len() <= SESSION_EVENT_BATCH_LIMIT);
        assert!(!certified, "mixed events must use the ordinary parser");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&batch[0]).unwrap()["msg"]["text"],
            "reason"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&batch[1]).unwrap()["msg"]["delta"],
            "answer"
        );
        assert!(batch.iter().map(String::len).sum::<usize>() <= SESSION_EVENT_BATCH_BYTES);
        assert_eq!(fixture.provider.request_count(), 0);
        fixture.thread.close().await.unwrap();
        fixture.engine.close().await.unwrap();
    })
    .await
    .expect("mixed ready batch must settle");
}

#[tokio::test]
async fn ready_passive_byte_boundary_leaves_the_projected_candidate_raw_for_normal_delivery() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = RootStepBatchFixture::new().await;
        assert!(!fixture.tools.has_manual_tools());
        let turn = fixture.request["id"].as_str().unwrap();
        let later = Event {
            id: turn.into(),
            msg: EventMsg::AgentReasoning(codex_protocol::protocol::AgentReasoningEvent {
                text: "🙂".repeat(100),
            }),
        };
        let expected = native_event(None, &later).unwrap();
        {
            let mut events = fixture.state.events.lock().await;
            events.initial = Some(Event {
                id: turn.into(),
                msg: EventMsg::AgentReasoning(codex_protocol::protocol::AgentReasoningEvent {
                    text: "x".repeat(SESSION_EVENT_BATCH_BYTES - 200),
                }),
            });
            let witness = events.native_dequeued.clone();
            events.native = Some(Box::pin(async move {
                witness.store(true, Ordering::Release);
                Ok((later, None))
            }));
        }
        let (first, _) = fixture.state.next_session_events().await.unwrap();
        assert_eq!(first.len(), 1);
        assert!(first[0].len() < SESSION_EVENT_BATCH_BYTES);
        assert!(
            fixture
                .state
                .events
                .lock()
                .await
                .native_dequeued
                .load(Ordering::Acquire)
        );
        let (normal, _) = fixture.state.next_session_events().await.unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&normal[0]).unwrap(),
            expected
        );
        assert_eq!(fixture.provider.request_count(), 0);
        fixture.thread.close().await.unwrap();
        fixture.engine.close().await.unwrap();
    })
    .await
    .expect("byte-boundary lookahead must settle");
}

#[tokio::test]
async fn typed_prefilter_leaves_large_controls_and_unfit_reasoning_unprojected() {
    let mut source = Source::new();
    let control = Event {
        id: TURN.into(),
        msg: EventMsg::RawResponseCompleted(codex_protocol::protocol::RawResponseCompletedEvent {
            response_id: "large-control".repeat(SESSION_EVENT_BATCH_BYTES),
            token_usage: None,
            usage_metadata: None,
        }),
    };
    assert_eq!(ready_passive_min_bytes(&control, THREAD, TURN), None);
    source.send.send(control).unwrap();
    assert!(source.take_passive(SESSION_EVENT_BATCH_BYTES).is_none());
    assert!(source.witness.load(Ordering::Acquire));
    let (retained, _) = source.next.take().unwrap().await.unwrap();
    assert!(matches!(retained.msg, EventMsg::RawResponseCompleted(_)));
    source.next = Some(read(source.receive.clone(), source.witness.clone()));
    let text = "🙂\\\"\n".repeat(1024);
    let reasoning = passive_event("agent_reasoning", serde_json::json!({"text":text}));
    let minimum = ready_passive_min_bytes(&reasoning, THREAD, TURN).unwrap();
    assert_eq!(minimum, text.len().saturating_add(TURN.len()));
    assert!(
        minimum
            <= serde_json::to_string(&native_event(None, &reasoning).unwrap())
                .unwrap()
                .len()
    );
    source.send.send(reasoning).unwrap();
    assert!(source.take_passive(minimum - 1).is_none());
    let (retained, _) = source.next.take().unwrap().await.unwrap();
    assert_eq!(native_event(None, &retained).unwrap()["msg"]["text"], text);
}

#[tokio::test]
async fn media_declines_and_reasoning_bounds_preserve_ordinary_payloads() {
    use codex_protocol::protocol::UserMessageEvent;
    let image = format!(
        "data:image/png;base64,{}",
        "A".repeat(SESSION_EVENT_BATCH_BYTES)
    );
    let user = Event {
        id: TURN.into(),
        msg: EventMsg::UserMessage(UserMessageEvent {
            message: "short".into(),
            images: Some(vec![image.clone()]),
            ..Default::default()
        }),
    };
    let summary = "summary\n\"🙂".repeat(2048);
    let reasoning = passive_event(
        "raw_response_item",
        serde_json::json!({"item": {
            "type":"reasoning", "summary":[{"type":"summary_text","text":summary}],
            "content":[{"type":"reasoning_text","text":"raw text"}], "encrypted_content":null
        }}),
    );
    for (event, simple) in [(user, false), (reasoning, true)] {
        let minimum = ready_passive_min_bytes(&event, THREAD, TURN);
        let expected = native_event(None, &event).unwrap();
        let wire = serde_json::to_string(&expected).unwrap();
        if simple {
            let minimum = minimum.unwrap();
            assert!(minimum > SESSION_EVENT_BATCH_BYTES);
            assert!(
                minimum <= wire.len(),
                "a byte lower bound must never exceed its wire size"
            );
        } else {
            assert_eq!(
                minimum, None,
                "media must remain an ordinary-delivery shape"
            );
        }
        let mut source = Source::new();
        source.send.send(event).unwrap();
        assert!(source.take_passive(SESSION_EVENT_BATCH_BYTES).is_none());
        assert!(source.witness.load(Ordering::Acquire));
        assert_eq!(
            native_event(None, &source.next.take().unwrap().await.unwrap().0).unwrap(),
            expected
        );
    }
    // The pinned serializer omits a Text-only raw-content vector, even if large.
    let omitted = passive_event(
        "raw_response_item",
        serde_json::json!({"item": {
            "type":"reasoning", "summary":[], "content":[{"type":"text","text":"x".repeat(SESSION_EVENT_BATCH_BYTES*2)}],
            "encrypted_content":null
        }}),
    );
    assert!(ready_passive_min_bytes(&omitted, THREAD, TURN).unwrap() < SESSION_EVENT_BATCH_BYTES);
    let mut source = Source::new();
    source.send.send(omitted).unwrap();
    let (wire, _) = source.take_passive(SESSION_EVENT_BATCH_BYTES).unwrap();
    assert!(
        serde_json::from_str::<serde_json::Value>(&wire).unwrap()["msg"]["item"]
            .get("content")
            .is_none()
    );
}

#[tokio::test]
async fn typed_item_scope_rejects_before_projecting_or_consuming_the_source() {
    use codex_protocol::items::{ReasoningItem, TurnItem};
    use codex_protocol::protocol::ItemStartedEvent;
    let mut event = Event {
        id: TURN.into(),
        msg: EventMsg::ItemStarted(ItemStartedEvent {
            thread_id: ThreadId::from_string(THREAD).unwrap(),
            turn_id: TURN.into(),
            item: TurnItem::Reasoning(ReasoningItem {
                id: "reasoning".into(),
                summary_text: vec!["summary".into()],
                raw_content: vec![],
            }),
            started_at_ms: 0,
        }),
    };
    assert!(ready_passive_min_bytes(&event, THREAD, TURN).is_some());
    if let EventMsg::ItemStarted(started) = &mut event.msg {
        started.thread_id = ThreadId::from_string("00000000-0000-0000-0000-000000000002").unwrap();
    }
    assert_eq!(ready_passive_min_bytes(&event, THREAD, TURN), None);
    let mut source = Source::new();
    let expected = native_event(None, &event).unwrap();
    source.send.send(event).unwrap();
    assert!(source.take_passive(SESSION_EVENT_BATCH_BYTES).is_none());
    let (mut event, _) = source.next.take().unwrap().await.unwrap();
    assert_eq!(native_event(None, &event).unwrap(), expected);
    if let EventMsg::ItemStarted(started) = &mut event.msg {
        started.thread_id = ThreadId::from_string(THREAD).unwrap();
        started.turn_id = "other-turn".into();
    }
    assert_eq!(ready_passive_min_bytes(&event, THREAD, TURN), None);
    if let EventMsg::ItemStarted(started) = &mut event.msg {
        started.turn_id = TURN.into();
    }
    assert!(ready_passive_min_bytes(&event, THREAD, TURN).is_some());
}

fn annotated_text_event(raw_item: bool, annotations: serde_json::Value) -> Event {
    if raw_item {
        passive_event(
            "raw_response_item",
            serde_json::json!({"item": {
                "type":"message", "id":"annotated-message", "role":"assistant",
                "content":[{"type":"output_text", "text":"short", "annotations":annotations}]
            }}),
        )
    } else {
        passive_event(
            "item_started",
            serde_json::json!({
                "thread_id":THREAD, "turn_id":TURN, "started_at_ms":0,
                "item":{"type":"AgentMessage", "id":"annotated-message",
                    "content":[{"type":"Text", "text":"short", "annotations":annotations}]}
            }),
        )
    }
}

#[tokio::test]
async fn opaque_annotations_stay_raw_until_ordinary_oversized_first_delivery() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for raw_item in [true, false] {
            let fixture = RootStepBatchFixture::new().await;
            let turn = fixture.request["id"].as_str().unwrap();
            let thread = fixture.state.id.to_string();
            let annotations = serde_json::json!([{
                "opaque":{"payload":"x".repeat(SESSION_EVENT_BATCH_BYTES * 2)}
            }]);
            let mut later = annotated_text_event(raw_item, annotations);
            later.id = turn.into();
            if let EventMsg::ItemStarted(started) = &mut later.msg {
                started.thread_id = fixture.state.id;
                started.turn_id = turn.into();
            }
            // This cheap predicate must reject before native_event can traverse
            // the opaque value. The previous text-only bound returned Some.
            assert_eq!(ready_passive_min_bytes(&later, &thread, turn), None);
            let expected = native_event(None, &later).unwrap();
            assert!(serde_json::to_string(&expected).unwrap().len() > SESSION_EVENT_BATCH_BYTES);
            {
                let mut events = fixture.state.events.lock().await;
                events.initial = Some(Event {
                    id: turn.into(),
                    msg: EventMsg::AgentReasoning(codex_protocol::protocol::AgentReasoningEvent {
                        text: "prefix".into(),
                    }),
                });
                let witness = events.native_dequeued.clone();
                events.native = Some(Box::pin(async move {
                    witness.store(true, Ordering::Release);
                    Ok((later, None))
                }));
            }
            let (prefix, _) = fixture.state.next_session_events().await.unwrap();
            assert_eq!(prefix.len(), 1);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&prefix[0]).unwrap()["msg"]["text"],
                "prefix"
            );
            {
                let mut events = fixture.state.events.lock().await;
                assert!(events.native_dequeued.load(Ordering::Acquire));
                for _ in 0..2 {
                    let witness = events.native_dequeued.clone();
                    assert!(
                        take_ready_root_event(
                            &mut events.native,
                            &witness,
                            &thread,
                            turn,
                            SESSION_EVENT_BATCH_BYTES,
                            true,
                            || panic!("an opaque retained event must not advance the source"),
                        )
                        .is_none()
                    );
                    assert!(witness.load(Ordering::Acquire));
                }
            }
            let (normal, _) = fixture.state.next_session_events().await.unwrap();
            assert_eq!(normal.len(), 1);
            assert!(normal[0].len() > SESSION_EVENT_BATCH_BYTES);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&normal[0]).unwrap(),
                expected
            );
            assert_eq!(fixture.provider.request_count(), 0);
            fixture.thread.close().await.unwrap();
            fixture.engine.close().await.unwrap();
        }
    })
    .await
    .expect("opaque annotation delivery must settle");
}

#[tokio::test]
async fn empty_annotations_keep_ready_delivery_and_opaque_shapes_decline() {
    assert!(ready_passive_annotations_are_empty(&None));
    assert!(ready_passive_annotations_are_empty(&Some(
        serde_json::Value::Null
    )));
    for raw_item in [true, false] {
        for annotations in [serde_json::Value::Null, serde_json::json!([])] {
            let event = annotated_text_event(raw_item, annotations);
            assert!(ready_passive_min_bytes(&event, THREAD, TURN).is_some());
            let expected = native_event(None, &event).unwrap();
            let mut source = Source::new();
            source.send.send(event).unwrap();
            let (wire, certified) = source.take_passive(SESSION_EVENT_BATCH_BYTES).unwrap();
            assert!(!certified);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&wire).unwrap(),
                expected
            );
        }
        for annotations in [
            serde_json::json!({}),
            serde_json::json!([null]),
            serde_json::json!(false),
        ] {
            let event = annotated_text_event(raw_item, annotations);
            assert_eq!(ready_passive_min_bytes(&event, THREAD, TURN), None);
        }
    }
}

#[tokio::test]
async fn large_variable_passive_fields_remain_raw_for_ordinary_delivery() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let large = "0".repeat(SESSION_EVENT_BATCH_BYTES * 2);
        let mut cases = vec![
            ("quota", true, passive_event("token_count", serde_json::json!({
                "info":null, "rate_limits":{"limit_id":"fixture", "credits":{
                    "has_credits":true, "unlimited":false, "balance":large.clone()
                }}
            }))),
            ("settings", true, passive_event("thread_settings_applied", serde_json::json!({
                "thread_settings":{
                    "model":"fixture", "model_provider_id":"fixture",
                    "approval_policy":"never", "approvals_reviewer":"user",
                    "permission_profile":{"type":"disabled"},
                    "active_permission_profile":{"id":large.clone()},
                    "cwd":"/tmp", "runtime_workspace_roots":["/tmp"],
                    "collaboration_mode":{"mode":"default", "settings":{"model":"fixture"}},
                    "disabled_plugin_ids":[]
                }
            }))),
            ("retry", false, passive_event("token_count", serde_json::json!({
                "info":null, "rate_limits":null, "api_rate_limits":{"retry_after":large.clone()}
            }))),
        ];
        for window in ["requests", "tokens", "project_tokens"] {
            let mut fields = serde_json::json!({"info":null,"rate_limits":null,"api_rate_limits":{}});
            fields["api_rate_limits"][window] = serde_json::json!({"reset_after":large.clone()});
            cases.push((window, false, passive_event("token_count", fields)));
        }
        for kind in ["message", "reasoning"] {
            let mut item = if kind == "message" {
                serde_json::json!({"type":"message","role":"assistant","content":[]})
            } else {
                serde_json::json!({"type":"reasoning","summary":[],"encrypted_content":null})
            };
            item["id"] = serde_json::json!(large.clone());
            cases.push(("raw-item-id", false, passive_event("raw_response_item", serde_json::json!({"item":item}))));
            item["id"] = serde_json::json!("small");
            item["internal_chat_message_metadata_passthrough"] = serde_json::json!({"turn_id":large.clone()});
            cases.push(("raw-passthrough", true, passive_event("raw_response_item", serde_json::json!({"item":item}))));
        }
        let citation = serde_json::json!({"entries":[],"rolloutIds":[large.clone()]});
        let questions = serde_json::json!([{"title":large.clone(),"options":[]}]);
        for (field, value) in [("memory_citation", citation), ("questions", questions)] {
            let mut message = serde_json::json!({"message":"short"});
            message[field] = value.clone();
            cases.push((field, true, passive_event("agent_message", message)));
            let mut started = serde_json::to_value(annotated_text_event(false, serde_json::Value::Null)).unwrap()["msg"].clone();
            started["item"][field] = value;
            cases.push((field, true, passive_event("item_started", started)));
        }
        for field in ["id", "display_text"] {
            let mut started = serde_json::to_value(annotated_text_event(false, serde_json::Value::Null)).unwrap()["msg"].clone();
            started["item"][field] = serde_json::json!(large.clone());
            cases.push((field, false, passive_event("item_started", started)));
        }
        cases.push(("reasoning-item-id", false, passive_event("item_started", serde_json::json!({
            "thread_id":THREAD,"turn_id":TURN,"started_at_ms":0,
            "item":{"type":"Reasoning","id":large.clone(),"summary_text":[],"raw_content":[]}
        }))));
        let mut header = delta("short");
        if let EventMsg::AgentMessageContentDelta(data) = &mut header.msg { data.item_id = large.clone(); }
        cases.push(("text-item-header", true, header));
        // Two media categories the old string-only walk did not count.
        for (field, value) in [
            ("image_details", serde_json::json!(vec![None::<u8>; SESSION_EVENT_BATCH_BYTES + 1])),
            ("text_elements", serde_json::json!([{"byte_range":{"start":0,"end":0},"placeholder":large.clone()}])),
        ] {
            let mut message = serde_json::json!({"message":"short","images":null,"audio":null});
            message[field] = value;
            cases.push((field, true, passive_event("user_message", message)));
        }
        for (label, complex, mut later) in cases {
            let fixture = RootStepBatchFixture::new().await;
            let turn = fixture.request["id"].as_str().unwrap();
            let thread = fixture.state.id.to_string();
            later.id = turn.into();
            match &mut later.msg {
                EventMsg::ItemStarted(started) => {
                    started.thread_id = fixture.state.id;
                    started.turn_id = turn.into();
                }
                EventMsg::AgentMessageContentDelta(data) => {
                    data.thread_id = thread.clone();
                    data.turn_id = turn.into();
                }
                _ => {}
            }
            let minimum = ready_passive_min_bytes(&later, &thread, turn);
            if complex {
                assert_eq!(minimum, None, "{label}");
            } else {
                assert!(minimum.is_some_and(|bytes| bytes > SESSION_EVENT_BATCH_BYTES), "{label}");
            }
            let expected = native_event(None, &later).unwrap();
            assert!(serde_json::to_string(&expected).unwrap().len() > SESSION_EVENT_BATCH_BYTES);
            {
                let mut events = fixture.state.events.lock().await;
                events.initial = Some(Event {
                    id:turn.into(),
                    msg:EventMsg::AgentReasoning(codex_protocol::protocol::AgentReasoningEvent {
                        text:"prefix".into(),
                    }),
                });
                let witness = events.native_dequeued.clone();
                events.native = Some(Box::pin(async move {
                    witness.store(true, Ordering::Release);
                    Ok((later, None))
                }));
            }
            let (prefix, _) = fixture.state.next_session_events().await.unwrap();
            assert_eq!(prefix.len(), 1, "{label}");
            assert_eq!(serde_json::from_str::<serde_json::Value>(&prefix[0]).unwrap()["msg"]["text"], "prefix");
            {
                let mut events = fixture.state.events.lock().await;
                for _ in 0..2 {
                    let witness = events.native_dequeued.clone();
                    assert!(witness.load(Ordering::Acquire));
                    assert!(take_ready_root_event(
                        &mut events.native, &witness, &thread, turn,
                        SESSION_EVENT_BATCH_BYTES, true,
                        || panic!("large metadata must not advance lookahead"),
                    ).is_none(), "{label}");
                    assert!(witness.load(Ordering::Acquire));
                }
            }
            let (normal, _) = fixture.state.next_session_events().await.unwrap();
            assert_eq!(normal.len(), 1, "{label}");
            assert!(normal[0].len() > SESSION_EVENT_BATCH_BYTES, "{label}");
            assert_eq!(serde_json::from_str::<serde_json::Value>(&normal[0]).unwrap(), expected, "{label}");
            assert_eq!(fixture.provider.request_count(), 0);
            fixture.thread.close().await.unwrap();
            fixture.engine.close().await.unwrap();
        }
    }).await.expect("large metadata delivery must settle");
}

#[tokio::test]
async fn simple_shapes_count_flat_fields_and_empty_collection_cardinality() {
    let user = passive_event(
        "user_message",
        serde_json::json!({
            "message":"text","client_id":"client","images":null,"audio":null
        }),
    );
    assert_eq!(
        ready_passive_min_bytes(&user, THREAD, TURN),
        Some(TURN.len() + 10)
    );
    let ordinary = passive_event("agent_message", serde_json::json!({"message":"text"}));
    assert_eq!(
        ready_passive_min_bytes(&ordinary, THREAD, TURN),
        Some(TURN.len() + 4)
    );
    let mcp = passive_event(
        "mcp_startup_complete",
        serde_json::json!({"ready":["",""],"failed":[],"cancelled":[]}),
    );
    assert_eq!(
        ready_passive_min_bytes(&mcp, THREAD, TURN),
        Some(TURN.len() + 2)
    );
    let n = SESSION_EVENT_BATCH_BYTES + 1;
    let cases = [
        passive_event(
            "mcp_startup_complete",
            serde_json::json!({"ready":vec!["";n],"failed":[],"cancelled":[]}),
        ),
        passive_event(
            "raw_response_item",
            serde_json::json!({"item":{
                "type":"message","role":"assistant","content":vec![serde_json::json!({"type":"input_text","text":""});n]
            }}),
        ),
        passive_event(
            "raw_response_item",
            serde_json::json!({"item":{
                "type":"reasoning","summary":vec![serde_json::json!({"type":"summary_text","text":""});n],"encrypted_content":null
            }}),
        ),
        // Even omitted Text-only content runs the serializer's skip predicate.
        passive_event(
            "raw_response_item",
            serde_json::json!({"item":{
                "type":"reasoning","summary":[],"content":vec![serde_json::json!({"type":"text","text":""});n],"encrypted_content":null
            }}),
        ),
        passive_event(
            "item_started",
            serde_json::json!({"thread_id":THREAD,"turn_id":TURN,"started_at_ms":0,
                "item":{"type":"AgentMessage","id":"small","content":vec![serde_json::json!({"type":"Text","text":""});n]}
            }),
        ),
        passive_event(
            "item_started",
            serde_json::json!({"thread_id":THREAD,"turn_id":TURN,"started_at_ms":0,
                "item":{"type":"Reasoning","id":"small","summary_text":vec!["";n],"raw_content":[]}
            }),
        ),
    ];
    for event in cases {
        assert_eq!(ready_passive_min_bytes(&event, THREAD, TURN), None);
        let expected = native_event(None, &event).unwrap();
        let mut source = Source::new();
        source.send.send(event).unwrap();
        source
            .send
            .send(delta("after-cardinality-boundary"))
            .unwrap();
        for _ in 0..2 {
            assert!(source.take_passive(SESSION_EVENT_BATCH_BYTES).is_none());
            assert!(source.witness.load(Ordering::Acquire));
            assert_eq!(source.receive.lock().await.len(), 1);
        }
        let (retained, _) = source.next.take().unwrap().await.unwrap();
        assert_eq!(native_event(None, &retained).unwrap(), expected);
        source.next = Some(read(source.receive.clone(), source.witness.clone()));
        let (after, certified) = source.take_passive(SESSION_EVENT_BATCH_BYTES).unwrap();
        assert!(certified);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&after).unwrap()["msg"]["delta"],
            "after-cardinality-boundary"
        );
    }
}

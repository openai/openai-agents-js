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

    fn take_bulk(&mut self, bytes: usize) -> Option<(usize, String)> {
        let receive = self.receive.clone();
        let witness = self.witness.clone();
        let mut text = None;
        let bytes = take_ready_bulk_root_text_delta(
            &mut self.next,
            &self.witness,
            THREAD,
            TURN,
            Some("message"),
            bytes,
            || read(receive, witness),
            |payload| match payload {
                BulkRootTextPayload::Join(delta) => text = Some(delta.to_owned()),
                BulkRootTextPayload::Separate(_) => panic!("join payload expected"),
            },
        )?;
        Some((bytes, text.expect("committed text")))
    }

    fn take(&mut self, bytes: usize) -> Option<String> {
        let receive = self.receive.clone();
        let witness = self.witness.clone();
        take_ready_root_text_delta(&mut self.next, &self.witness, THREAD, TURN, bytes, || {
            read(receive, witness)
        })
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
        take_ready_root_text_delta(&mut next, &witness, THREAD, TURN, 1024, || panic!(
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
        take_ready_root_text_delta(&mut next, &witness, THREAD, TURN, 1024, || panic!(
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
        let batch = state.next_session_events().await.unwrap();
        assert_eq!(batch.len(), 1);
        assert!(batch[0].len() > SESSION_EVENT_BATCH_BYTES);

        for (bulk_first, error) in [(false, false), (false, true), (true, false), (true, true)] {
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
            let batch = if bulk_first {
                state.next_session_events_bulk().await.unwrap()
            } else {
                state.next_session_events().await.unwrap()
            };

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
            let mut retained_read: Pin<
                Box<dyn Future<Output = anyhow::Result<Vec<String>>> + Send + '_>,
            > = if bulk_first {
                Box::pin(state.next_session_events())
            } else {
                Box::pin(state.next_session_events_bulk())
            };
            let held = poll_fn(|cx| Poll::Ready(retained_read.as_mut().poll(cx))).await;
            assert!(
                matches!(held, Poll::Pending),
                "publication cannot bypass held metadata"
            );
            metadata_send.send(()).unwrap();
            let mut delivered = 0;
            let mut batch = retained_read.await.unwrap();
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
                batch = state.next_session_events().await.unwrap();
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
                let after = state.next_session_events().await.unwrap();
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

// Use genuine selector receipts and the retained-source seam above.
// No model response is allowed while these receipts await a reply.
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

    async fn batch(&self) -> Vec<serde_json::Value> {
        let wire = self.state.next_session_events().await.unwrap();
        assert_eq!(wire.len(), 1, "a retained root step forbids batch extras");
        wire.iter()
            .map(|raw| serde_json::from_str(raw).unwrap())
            .collect()
    }

    async fn drain_prefix(&self, count: usize) -> Vec<serde_json::Value> {
        let mut delivered = Vec::new();
        for remaining in (0..count).rev() {
            let batch = self.batch().await;
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
        let first = fixture.batch().await;

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
        let last = fixture.batch().await;

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
        let selected = fixture.batch().await;

        assert_eq!(selected[0], fixture.request);
        assert!(fixture.state.events.lock().await.root_step.is_none());
        assert_eq!(
            polls.load(Ordering::Acquire),
            0,
            "selector precedes future tail"
        );
        let tail = fixture.batch().await;
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
        let after = fixture.batch().await;

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

#[tokio::test]
async fn root_text_batch_keeps_request_metadata_a_selector_boundary() {
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
        let first = fixture.state.next_session_events().await.unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(polls.load(Ordering::Acquire), 0);
        let metadata = fixture.state.next_session_events().await.unwrap();
        assert_eq!(metadata.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&metadata[0]).unwrap()["msg"]["type"],
            "_sdk_request_metadata"
        );
        assert_eq!(polls.load(Ordering::Acquire), 0);
        let next = fixture.state.next_session_events().await.unwrap();
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
async fn pending_metadata_future_survives_both_read_mode_orders() {
    for bulk_first in [false, true] {
        let (send, receive) = tokio::sync::oneshot::channel();
        let mut source = Source::new();
        let witness = source.witness.clone();
        source.next = Some(Box::pin(async move {
            witness.store(true, Ordering::Release);
            receive.await.expect("metadata future must remain owned");
            Ok((
                Event {
                    id: "held-metadata".into(),
                    msg: EventMsg::ShutdownComplete,
                },
                None,
            ))
        }));
        if bulk_first {
            assert!(source.take_bulk(1024).is_none());
            assert!(source.take(1024).is_none());
        } else {
            assert!(source.take(1024).is_none());
            assert!(source.take_bulk(1024).is_none());
        }
        assert!(source.witness.load(Ordering::Acquire));
        send.send(())
            .expect("neither mode may cancel the retained source");
        let (event, _) = source.next.take().unwrap().await.unwrap();
        assert_eq!(event.id, "held-metadata");
        assert!(source.receive.lock().await.is_empty());
    }
}

#[tokio::test]
async fn rejected_ready_results_survive_both_read_mode_orders() {
    for bulk_first in [false, true] {
        for error in [false, true] {
            let mut source = Source::new();
            source.send.send(delta("after-retained-result")).unwrap();
            source.witness.store(true, Ordering::Release);
            source.next = Some(Box::pin(std::future::ready(if error {
                Err(codex_protocol::error::CodexErr::InvalidRequest(
                    "held-error".into(),
                ))
            } else {
                Ok((
                    Event {
                        id: "held-control".into(),
                        msg: EventMsg::ShutdownComplete,
                    },
                    None,
                ))
            })));
            if bulk_first {
                assert!(source.take_bulk(1024).is_none());
                assert!(source.take(1024).is_none());
            } else {
                assert!(source.take(1024).is_none());
                assert!(source.take_bulk(1024).is_none());
            }
            assert!(source.witness.load(Ordering::Acquire));
            assert_eq!(source.receive.lock().await.len(), 1);
            match source.next.take().unwrap().await {
                Ok((event, _)) => {
                    assert!(!error);
                    assert_eq!(event.id, "held-control");
                }
                Err(error) => assert!(
                    matches!(error.details(), codex_protocol::error::CodexErrorDetails::InvalidRequest(text) if text == "held-error")
                ),
            }
            assert_eq!(source.receive.lock().await.recv().await.unwrap().id, TURN);
        }
    }
}

#[tokio::test]
async fn bulk_narrow_count_matches_canonical_escaped_and_unicode_wire_bytes() {
    for text in ["", "x", "α🙂\n\\\"end", "\r\t\u{0000}"] {
        let mut source = Source::new();
        let event = delta(text);
        let wire = serde_json::to_string(&event).unwrap();
        source.send.send(event).unwrap();
        assert!(source.take_bulk(wire.len() - 1).is_none());
        assert!(source.witness.load(Ordering::Acquire));
        assert_eq!(source.take(wire.len()), Some(wire.clone()));
        source.send.send(delta(text)).unwrap();
        assert!(source.take(wire.len() - 1).is_none());
        assert_eq!(
            source.take_bulk(wire.len()),
            Some((wire.len(), text.into()))
        );
        assert!(!source.witness.load(Ordering::Acquire));
    }
}

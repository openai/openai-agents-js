//! Real multiplexer/carrier tests with isolated typed event sources, not a second collector.
use super::*;
use crate::local_storage_tests::Provider;
use codex_protocol::protocol::{AgentMessageContentDeltaEvent, WarningEvent};
use serde_json::json;

const TURN: &str = "carrier-conformance-turn";

struct Rig {
    engine: crate::Engine,
    native: crate::NativeThread,
    state: Arc<ThreadState>,
    events: broadcast::Sender<(String, Event)>,
    _created: broadcast::Sender<ThreadId>,
    _graph: mpsc::UnboundedSender<crate::storage::GraphEvent>,
    _home: tempfile::TempDir,
    provider: Provider,
}

impl Rig {
    async fn new() -> Self {
        let provider = Provider::start().await;
        let home = tempfile::tempdir().unwrap();
        let engine = crate::create_engine(
            provider.config().to_string(),
            json!({"codex_home":home.path(),"cwd":home.path(),"_sdk_native_config":true,
                "loader":{"ignore_user_config":true,"ignore_project_config":true},
                "base_instructions":"Conformance fixture."})
            .to_string(),
            Some("synthetic-carrier-key".into()),
            None,
        )
        .await
        .unwrap();
        let native = engine
            .start_replaceable_thread(
                json!({"_managed_instructions":true,"instructions":"Conformance fixture.",
                "tool_policy":{"allowed_tools":[]}})
                .to_string(),
                "[]".into(),
            )
            .await
            .unwrap();
        let state = Arc::clone(&native.current().unwrap());
        let (events, receiver) = broadcast::channel(512);
        let (created, created_receiver) = broadcast::channel(8);
        let (graph, graph_receiver) = mpsc::unbounded_channel();
        {
            let mut sources = state.events.lock().await;
            // Core/Engine are real. Replace only this reader's input channels so
            // exact boundary/cap/error schedules do not depend on HTTP timing.
            sources.initial = None;
            sources.extensions = receiver;
            sources.created = created_receiver;
            sources.graph = graph_receiver;
            sources.native = Some(Box::pin(std::future::pending()));
        }
        Self {
            engine,
            native,
            state,
            events,
            _created: created,
            _graph: graph,
            _home: home,
            provider,
        }
    }

    fn delta(&self, text: &str) -> Event {
        Event {
            id: TURN.into(),
            msg: EventMsg::AgentMessageContentDelta(AgentMessageContentDeltaEvent {
                thread_id: self.state.id.to_string(),
                turn_id: TURN.into(),
                item_id: "message".into(),
                delta: text.into(),
            }),
        }
    }

    fn send(&self, event: Event) {
        self.events.send((String::new(), event)).unwrap();
    }

    fn wire(event: &Event) -> String {
        serde_json::to_string(&native_event(None, event).unwrap()).unwrap()
    }

    async fn finish(self) {
        self.native.close().await.unwrap();
        self.engine.close().await.unwrap();
        assert!(
            self.provider.requests.lock().unwrap().is_empty(),
            "typed event fixture must not make model requests"
        );
    }
}

#[tokio::test]
async fn terminal_carrier_matches_ordinary_wire_and_stops_before_control_tail() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let rig = Rig::new().await;
        let rows = vec![
            rig.delta("α🙂\0"),
            rig.delta(""),
            Event {
                id: TURN.into(),
                msg: EventMsg::Warning(WarningEvent {
                    message: "control boundary".into(),
                }),
            },
            rig.delta("after boundary"),
        ];
        let expected: Vec<_> = rows.iter().map(Rig::wire).collect();
        for row in &rows {
            rig.send(row.clone());
        }
        let prefix = rig
            .state
            .next_owned_session_events(TURN.into(), false)
            .await
            .unwrap();
        assert_eq!(prefix, expected[..3]);
        assert_eq!(
            serde_json::to_string(&rig.state.next_session_event().await.unwrap()).unwrap(),
            expected[3]
        );
        for row in rows {
            rig.send(row);
        }
        let mut ordinary = Vec::new();
        while ordinary.len() < expected.len() {
            ordinary.extend(rig.state.next_session_events().await.unwrap());
        }
        assert_eq!(ordinary, expected);
        rig.finish().await;
    })
    .await
    .expect("carrier wire/control fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_row_cap_leaves_the_next_row_for_the_original_reader() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let rig = Rig::new().await;
        let rows: Vec<_> = (0..65).map(|n| rig.delta(&format!("row-{n}"))).collect();
        let expected: Vec<_> = rows.iter().map(Rig::wire).collect();
        for row in rows {
            rig.send(row);
        }
        assert_eq!(
            rig.state
                .next_owned_session_events(TURN.into(), false)
                .await
                .unwrap(),
            expected[..64]
        );
        assert_eq!(
            serde_json::to_string(&rig.state.next_session_event().await.unwrap()).unwrap(),
            expected[64]
        );
        rig.finish().await;
    })
    .await
    .expect("carrier row cap fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_exact_utf8_cap_and_oversized_boundary_deliver_once() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let rig = Rig::new().await;
        let overhead = Rig::wire(&rig.delta("")).len();
        let exact = rig.delta(&"x".repeat(OWNED_TERMINAL_BYTES - overhead));
        assert_eq!(Rig::wire(&exact).len(), OWNED_TERMINAL_BYTES);
        rig.send(exact.clone());
        rig.send(rig.delta("remaining"));
        assert_eq!(
            rig.state
                .next_owned_session_events(TURN.into(), false)
                .await
                .unwrap(),
            vec![Rig::wire(&exact)]
        );
        assert_eq!(
            serde_json::to_string(&rig.state.next_session_event().await.unwrap()).unwrap(),
            Rig::wire(&rig.delta("remaining"))
        );
        let short = rig.delta("prefix");
        let oversized = rig.delta(&"🙂".repeat(OWNED_TERMINAL_BYTES));
        rig.send(short.clone());
        rig.send(oversized.clone());
        rig.send(rig.delta("last"));
        assert_eq!(
            rig.state
                .next_owned_session_events(TURN.into(), false)
                .await
                .unwrap(),
            vec![Rig::wire(&short), Rig::wire(&oversized)]
        );
        assert_eq!(
            serde_json::to_string(&rig.state.next_session_event().await.unwrap()).unwrap(),
            Rig::wire(&rig.delta("last"))
        );
        rig.send(oversized.clone());
        assert_eq!(
            rig.state
                .next_owned_session_events(TURN.into(), false)
                .await
                .unwrap(),
            vec![Rig::wire(&oversized)]
        );
        rig.finish().await;
    })
    .await
    .expect("carrier byte cap fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_prefix_precedes_original_error_and_next_ready_event() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let rig = Rig::new().await;
        let (send, receive) =
            tokio::sync::oneshot::channel::<anyhow::Result<(Event, Option<CapturedQuestion>)>>();
        rig.state.events.lock().await.native = Some(Box::pin(async move { receive.await? }));
        let first = rig.delta("accepted prefix");
        rig.send(first.clone());
        let read_state = Arc::clone(&rig.state);
        let read = read_state.next_owned_session_events(TURN.into(), false);
        tokio::pin!(read);
        assert!(futures_util::poll!(&mut read).is_pending());
        assert!(
            send.send(Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "original native failure"
            )
            .into()))
                .is_ok()
        );
        assert_eq!(read.await.unwrap(), vec![Rig::wire(&first)]);
        // The normal reader installs its next real Core future after an error.
        // Restore the fixture's idle source while keeping the retained error.
        rig.state.events.lock().await.native = Some(Box::pin(std::future::pending()));
        rig.send(rig.delta("after error"));
        let error = rig.state.next_session_event().await.unwrap_err();
        let original = error
            .downcast_ref::<std::io::Error>()
            .expect("must retain original typed error");
        assert_eq!(original.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(original.to_string(), "original native failure");
        assert_eq!(
            serde_json::to_string(&rig.state.next_session_event().await.unwrap()).unwrap(),
            Rig::wire(&rig.delta("after error"))
        );
        rig.finish().await;
    })
    .await
    .expect("carrier prefix/error fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_retained_error_refuses_overwrite_and_close_clears_it() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let rig = Rig::new().await;
        rig.state
            .defer_session_error(anyhow::anyhow!("first failure"))
            .await
            .unwrap();
        assert!(
            rig.state
                .defer_session_error(anyhow::anyhow!("second failure"))
                .await
                .is_err()
        );
        assert_eq!(
            rig.state
                .next_session_event()
                .await
                .unwrap_err()
                .to_string(),
            "first failure"
        );
        rig.state
            .defer_session_error(anyhow::anyhow!("close failure"))
            .await
            .unwrap();
        rig.native.close().await.unwrap();
        assert!(
            rig.state
                .events
                .lock()
                .await
                .deferred_session_error
                .is_none()
        );
        rig.finish().await;
    })
    .await
    .expect("carrier retained error fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_close_wakes_pending_read_with_and_without_prefix() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for prefix in [false, true] {
            let rig = Rig::new().await;
            if prefix {
                rig.send(rig.delta("before close"));
            }
            let read_state = Arc::clone(&rig.state);
            let read = read_state.next_owned_session_events(TURN.into(), false);
            tokio::pin!(read);
            assert!(futures_util::poll!(&mut read).is_pending());
            let (read, closed) = tokio::join!(read, rig.state.close());
            closed.unwrap();
            if prefix {
                assert_eq!(read.unwrap(), vec![Rig::wire(&rig.delta("before close"))]);
            } else {
                assert!(read.unwrap_err().to_string().contains("closed"));
            }
            assert!(
                rig.state
                    .events
                    .lock()
                    .await
                    .deferred_session_error
                    .is_none()
            );
            rig.finish().await;
        }
    })
    .await
    .expect("carrier close fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_foreign_turn_and_text_identity_end_collection() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for foreign_thread in [false, true] {
            let rig = Rig::new().await;
            let mut boundary = rig.delta("foreign identity");
            if let EventMsg::AgentMessageContentDelta(delta) = &mut boundary.msg {
                if foreign_thread {
                    delta.thread_id = "other-thread".into();
                } else {
                    delta.turn_id = "other-turn".into();
                }
            }
            rig.send(rig.delta("prefix"));
            rig.send(boundary.clone());
            rig.send(rig.delta("tail"));
            assert_eq!(
                rig.state
                    .next_owned_session_events(TURN.into(), false)
                    .await
                    .unwrap(),
                vec![Rig::wire(&rig.delta("prefix")), Rig::wire(&boundary)]
            );
            assert_eq!(
                serde_json::to_string(&rig.state.next_session_event().await.unwrap()).unwrap(),
                Rig::wire(&rig.delta("tail"))
            );
            rig.finish().await;
        }
    })
    .await
    .expect("carrier foreign identity fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_second_request_dispatch_ends_the_one_attempt() {
    use codex_extension_api::{
        ExtensionData, ExtensionDataInit, ModelRequestDispatching, ModelRequestObservation,
        ModelRequestObservationRoute, ModelRequestTransport, ModelRequestWire, ModelResponseLinked,
    };
    tokio::time::timeout(Duration::from_secs(30), async {
        for already_seen in [false, true] {
            let rig = Rig::new().await;
            let mut init = ExtensionDataInit::new();
            rig.state.request_metadata.seed(
                &mut init,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                rig.state.id.to_string(),
            );
            let store = ExtensionData::new_with_init("carrier-metadata", init);
            let route = store.get::<ModelRequestObservationRoute>().unwrap();
            let dispatch = |name: &str| {
                ModelRequestObservation::Dispatching(ModelRequestDispatching {
                    request_id: name.into(),
                    thread_id: rig.state.id.to_string(),
                    turn_id: TURN.into(),
                    model: "gpt-5".into(),
                    reasoning_effort: None,
                    reasoning_summary: None,
                    service_tier: None,
                    wire: ModelRequestWire::Responses,
                    transport: ModelRequestTransport::HttpSse,
                })
            };
            route.0.observe(dispatch("first"));
            if !already_seen {
                route.0.observe(dispatch("second"));
            }
            route.0.observe(ModelRequestObservation::ResponseLinked(
                ModelResponseLinked {
                    request_id: "after-boundary".into(),
                    thread_id: rig.state.id.to_string(),
                    turn_id: TURN.into(),
                    response_observation_id: "retained-response".into(),
                },
            ));
            let prefix = rig
                .state
                .next_owned_session_events(TURN.into(), already_seen)
                .await
                .unwrap();
            assert_eq!(prefix.len(), if already_seen { 1 } else { 2 });
            for row in prefix {
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&row).unwrap()["msg"]["observation"]
                        ["type"],
                    "model_request_dispatching"
                );
            }
            assert_eq!(
                rig.state.next_session_event().await.unwrap()["msg"]["observation"]["type"],
                "model_response_linked"
            );
            rig.finish().await;
        }
    })
    .await
    .expect("carrier second-request fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_nonplain_compaction_item_is_delivered_before_fallback_tail() {
    use codex_protocol::items::{ContextCompactionItem, TurnItem};
    use codex_protocol::protocol::ItemStartedEvent;
    tokio::time::timeout(Duration::from_secs(30), async {
        let rig = Rig::new().await;
        let boundary = Event {
            id: TURN.into(),
            msg: EventMsg::ItemStarted(ItemStartedEvent {
                thread_id: rig.state.id,
                turn_id: TURN.into(),
                started_at_ms: 0,
                item: TurnItem::ContextCompaction(ContextCompactionItem {
                    id: "compaction-boundary".into(),
                }),
            }),
        };
        rig.send(rig.delta("prefix"));
        rig.send(boundary.clone());
        rig.send(rig.delta("tail"));
        assert_eq!(
            rig.state
                .next_owned_session_events(TURN.into(), false)
                .await
                .unwrap(),
            vec![Rig::wire(&rig.delta("prefix")), Rig::wire(&boundary)]
        );
        assert_eq!(
            serde_json::to_string(&rig.state.next_session_event().await.unwrap()).unwrap(),
            Rig::wire(&rig.delta("tail"))
        );
        rig.finish().await;
    })
    .await
    .expect("carrier nonplain item fixture timed out");
}

#[tokio::test]
async fn terminal_carrier_preserves_large_integer_usage_wire_without_model_side_effects() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let rig = Rig::new().await;
        // Feed the actual typed token-count producer through the real multiplexer.
        // This checks exact integer transport without making a backend claim that
        // would itself trigger automatic compaction in a live inference fixture.
        let usage = json!({"input_tokens":9_007_199_254_740_993i64,"cached_input_tokens":0,
            "output_tokens":7,"reasoning_output_tokens":0,"total_tokens":9_007_199_254_741_000i64});
        let count: Event = serde_json::from_value(json!({"id":TURN,"msg":{"type":"token_count",
            "info":{"total_token_usage":usage,"last_token_usage":usage,"model_context_window":272000},
            "rate_limits":null}})).unwrap();
        let boundary = Event { id: TURN.into(), msg: EventMsg::Warning(WarningEvent { message:"usage boundary".into() }) };
        rig.send(count.clone()); rig.send(boundary.clone());
        let rows = rig.state.next_owned_session_events(TURN.into(), false).await.unwrap();
        assert_eq!(rows, vec![Rig::wire(&count), Rig::wire(&boundary)]);
        assert!(rows[0].contains("9007199254740993"));
        assert!(rows[0].contains("9007199254741000"));
        rig.finish().await;
    }).await.expect("carrier exact usage fixture timed out");
}

//! Real Core terminal/idle ordering, held only in the SDK's test ThreadStore.
use super::*;
use crate::storage::CompletionHold;
use crate::turn_settlement::{self, Settlement};
use bytes::Bytes;
use codex_extension_api::{
    ExtensionData, ModelRequestContributor, ModelRequestInput, ModelRequestKind,
    TurnLifecycleContributor, TurnStartInput,
};
use codex_protocol::items::{TurnItem, UserMessageItem};
use codex_protocol::protocol::{SubAgentSource, ThreadSource};
use codex_protocol::turn_input::{
    NotSubmittedReason, StartIfIdleSubmission, TurnInput, TurnInputRequest, TurnStartOptions,
};
use codex_protocol::user_input::UserInput;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::convert::Infallible;
use std::task::Poll;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};

const HELD_ERROR_BODY: &[u8] = br#"{"error":{"message":"held synthetic failure","type":"invalid_request_error","code":"held_error"}}"#;

struct Provider {
    url: String,
    requests: Arc<std::sync::Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl Provider {
    async fn start() -> Self {
        Self::start_with_http_error(None).await
    }

    async fn start_with_http_error(status: Option<u16>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = requests.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let received = received.clone();
                connections.spawn(async move {
                    let service = service_fn(move |request: Request<Incoming>| {
                        let received = received.clone();
                        async move {
                            assert!(request.uri().path().ends_with("/responses"));
                            let raw = request.into_body().collect().await.unwrap().to_bytes();
                            let body: Value = serde_json::from_slice(&raw).unwrap();
                            let output = if body["text"]["format"]["schema"].is_object() {
                                r#"{"answer":"done"}"#
                            } else {
                                "done"
                            };
                            let index = {
                                let mut requests = received.lock().unwrap();
                                requests.push(body);
                                requests.len()
                            };
                            if let Some(status) = status {
                                return Ok::<_, Infallible>(Response::builder()
                                    .status(status)
                                    .header("content-type", "application/json")
                                    .header("x-request-id", format!("withheld-child-{status}"))
                                    .body(Full::new(Bytes::from_static(HELD_ERROR_BODY)))
                                    .unwrap());
                            }
                            let id = format!("resp_{index}");
                            let item = json!({"type":"message", "id":format!("msg_{index}"),
                                "role":"assistant", "status":"completed", "phase":"final_answer",
                                "content":[{"type":"output_text", "text":output, "annotations":[]}]});
                            let events = [
                                json!({"type":"response.created","response":{"id":id}}),
                                json!({"type":"response.output_item.done","item":item}),
                                json!({"type":"response.completed","response":{"id":id,"output":[item],
                                    "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}),
                            ];
                            let body = events.into_iter().map(|e| format!("data: {e}\n\n")).collect::<String>();
                            Ok::<_, Infallible>(Response::builder()
                                .header("content-type", "text/event-stream")
                                .body(Full::new(Bytes::from(body))).unwrap())
                        }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(tcp), service).await;
                });
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }

    fn child_requests(&self, id: ThreadId) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| {
                let metadata: Value = serde_json::from_str(
                    request["client_metadata"]["x-codex-turn-metadata"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                metadata["thread_id"] == id.to_string()
            })
            .count()
    }

    async fn engine(&self) -> (tempfile::TempDir, Arc<EngineState>) {
        let home = tempfile::tempdir().unwrap();
        let config = json!({
            "model":"gpt-5.1-codex", "model_provider":"settlement",
            "model_providers.settlement":{
                "name":"Native settlement fixture", "base_url":self.url,
                "wire_api":"responses", "requires_openai_auth":false,
                "supports_websockets":false,"request_max_retries":0,"stream_max_retries":0,
                "stream_idle_timeout_ms":5000
            },
            "approval_policy":"never", "sandbox_mode":"danger-full-access", "web_search":"disabled",
            "agents.enabled":true, "features.multi_agent_v2":true,
            "features.shell_snapshot":false, "features.code_mode":false, "analytics.enabled":false
        });
        let runtime = json!({"codex_home":home.path(), "cwd":home.path()});
        let engine = Arc::new(
            EngineState::new(config.to_string(), runtime.to_string(), false, None)
                .await
                .unwrap(),
        );
        (home, engine)
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// The hold is inside the existing SDK test ThreadStore, after the actual
// provider request. No synthetic event can credit this native receipt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_root_continues_only_its_own_successfully_settled_tail() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for route in [
            "replaceable",
            "rejected",
            "superseded",
            "aborted",
            "graph_stopped",
        ] {
            let provider = Provider::start().await;
            let (_home, engine) = provider.engine().await;
            let native = engine
                .start_with_tools(
                    serde_json::from_value(json!({
                        "_managed_instructions":true, "instructions":"Continue accepted work once."
                    }))
                    .unwrap(),
                    Vec::new(),
                )
                .await
                .unwrap();
            let state = native.current().unwrap();
            let store = engine
                .store
                .as_any()
                .downcast_ref::<crate::storage::MemoryThreadStore>()
                .unwrap();
            let hold = Arc::new(CompletionHold {
                parent: state.id,
                entered: Semaphore::new(0),
                release: Semaphore::new(0),
            });
            *store.next_flush_hold.lock().unwrap() = Some(hold.clone());
            let schema = json!({"type":"object", "properties":{"answer":{"type":"string"}},
                "required":["answer"], "additionalProperties":false});
            let start = if route == "replaceable" {
                json!({"final_output_json_schema":schema})
            } else {
                json!({})
            };
            let params = json!({"mode":"start_if_idle", "input":[{"type":"text","text":"begin"}],
                "start":start, "observation_submission_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"});
            let started: Value = serde_json::from_str(&native._submit(params.to_string()).await.unwrap()).unwrap();
            assert_eq!(started["status"], "started");
            let first = started["turn_id"].as_str().unwrap();
            loop {
                hold.entered.acquire().await.unwrap().forget();
                let post_response = engine
                    .load_checkpoint_history(state.id)
                    .await
                    .unwrap()
                    .iter()
                    .any(|item| matches!(item,
                        codex_history::RolloutItem::EventMsg(EventMsg::TokenCount(event))
                            if event.info.as_ref().is_some_and(|info|
                                info.last_token_usage.input_tokens == 1
                                    && info.last_token_usage.output_tokens == 1
                                    && info.last_token_usage.total_tokens == 2)));
                if post_response {
                    assert_eq!(provider.requests.lock().unwrap().len(), 1);
                    break;
                }
                // Skip the initial and post-tool durability barriers. The
                // response's actual usage precedes the finalization flush.
                *store.next_flush_hold.lock().unwrap() = Some(hold.clone());
                hold.release.add_permits(1);
            }
            for text in ["retained-first-unique", "retained-second-unique"] {
                assert_eq!(
                    serde_json::from_str::<Value>(&native._submit(
                        json!({
                            "mode":"steer","expected_turn_id":first,
                            "input":[{"type":"text","text":text}]
                        }).to_string()
                    )
                    .await
                    .unwrap()).unwrap(),
                    json!({"status":"steered","turn_id":first})
                );
            }
            if route == "aborted" {
                state
                    .thread
                    .submit(codex_protocol::protocol::Op::Interrupt)
                    .await
                    .unwrap();
            } else {
                hold.release.add_permits(1);
            }
            let mut metadata = Vec::new();
            let original = loop {
                let event = state.next_session_event().await.unwrap();
                if event["msg"]["type"] == "_sdk_request_metadata" {
                    metadata.push(event.clone());
                }
                if matches!(
                    event["msg"]["type"].as_str(),
                    Some("task_complete" | "turn_complete" | "turn_aborted")
                ) {
                    assert_eq!(event["msg"]["turn_id"], first);
                    break event;
                }
            };
            if route == "rejected" {
                let settlement = state
                    .thread
                    .thread_extension_data()
                    .get::<Settlement>()
                    .unwrap();
                settlement.matching(first).unwrap().reject_model();
            }
            if route == "superseded" {
                let other: Value = serde_json::from_str(&native._submit(json!({
                    "mode":"start_if_idle","input":[{"type":"text","text":"independent submission"}]
                }).to_string()).await.unwrap()).unwrap();
                assert_eq!(other["status"], "started");
                session_terminal(&state, other["turn_id"].as_str().unwrap())
                    .await
                    .unwrap();
            }
            if route == "graph_stopped" {
                // A natural delivered result remains intact even though its
                // unsampled tail cannot start more work across a tree fence.
                let stop = native
                    .request_graph_stop("thread_tree".into(), "graceful".into())
                    .unwrap();
                assert_eq!(original["msg"]["last_agent_message"], "done");
                stop.settle().await.unwrap();
                stop.release(true).unwrap();
            }
            let submit =
                json!({"mode":"continue_if_idle", "expected_previous_turn_id":first, "input":[],
                    "start":start, "observation_submission_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"});
            let continued: Value =
                serde_json::from_str(&native._submit(submit.to_string()).await.unwrap()).unwrap();
            if route == "replaceable" {
                let output = if route == "replaceable" { r#"{"answer":"done"}"# } else { "done" };
                assert_eq!(original["sdk_unsampled_steering"], true);
                assert_eq!(original["msg"]["last_agent_message"], output);
                assert_eq!(continued["status"], "started");
                let next_id = continued["turn_id"].as_str().unwrap();
                assert_ne!(next_id, first);
                let next = loop {
                    let event = state.next_session_event().await.unwrap();
                    if event["msg"]["type"] == "_sdk_request_metadata" {
                        metadata.push(event.clone());
                    }
                    if matches!(event["msg"]["type"].as_str(), Some("task_complete" | "turn_complete")) {
                        assert_eq!(event["id"], next_id);
                        break event;
                    }
                };
                while let Some(notice) = state.request_metadata.try_next() {
                    metadata.push(notice);
                }
                for (turn_id, submission_id) in [
                    (first, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                    (next_id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                ] {
                    let owned: Vec<_> = metadata.iter().filter(|notice| notice["msg"]["submission_id"] == submission_id).collect();
                    assert_eq!(owned.len(), 2, "missing dispatch/link metadata for {submission_id}");
                    let dispatch = &owned[0]["msg"]["observation"];
                    let linked = &owned[1]["msg"]["observation"];
                    assert_eq!(dispatch["type"], "model_request_dispatching");
                    assert_eq!(linked["type"], "model_response_linked");
                    assert_eq!(dispatch["turn_id"], turn_id);
                    assert_eq!(linked["turn_id"], turn_id);
                    assert_eq!(dispatch["thread_id"], state.id.to_string());
                    assert_eq!(linked["request_id"], dispatch["request_id"]);
                    assert!(linked["response_observation_id"].as_str().is_some_and(|id| !id.is_empty()));
                }
                assert_ne!(metadata[0]["msg"]["observation"]["request_id"], metadata[2]["msg"]["observation"]["request_id"]);
                assert_eq!(next["sdk_unsampled_steering"], false);
                assert_eq!(next["msg"]["last_agent_message"], output);
                let requests = provider.requests.lock().unwrap();
                assert_eq!(requests.len(), 2);
                if route == "replaceable" {
                    assert_eq!(requests[0]["text"]["format"]["schema"], schema);
                    assert_eq!(requests[1]["text"]["format"]["schema"], schema);
                }
                let first_request = requests[0]["input"].to_string();
                let next_request = requests[1]["input"].to_string();
                for text in ["retained-first-unique", "retained-second-unique"] {
                    assert!(!first_request.contains(text));
                    assert_eq!(next_request.matches(text).count(), 1);
                }
                drop(requests);
                let repeat: Value =
                    serde_json::from_str(&native._submit(submit.to_string()).await.unwrap())
                        .unwrap();
                assert_eq!(repeat["reason"]["type"], "superseded");
            } else {
                assert_eq!(
                    continued,
                    json!({"status":"not_submitted","reason":{"type":"superseded"}}),
                    "{route}"
                );
                assert_eq!(
                    provider.requests.lock().unwrap().len(),
                    if route == "superseded" { 2 } else { 1 }
                );
            }
            if route == "graph_stopped" {
                let fresh: Value = serde_json::from_str(&native._submit(json!({
                    "mode":"start_if_idle", "input":[{"type":"text","text":"next explicit input"}]
                }).to_string()).await.unwrap()).unwrap();
                assert_eq!(fresh["status"], "started");
                session_terminal(&state, fresh["turn_id"].as_str().unwrap())
                    .await
                    .unwrap();
                assert_eq!(provider.requests.lock().unwrap().len(), 2);
                assert_eq!(original["msg"]["last_agent_message"], "done");
            }
            state.close().await.unwrap();
            engine.close().await.unwrap();
        }
    })
    .await
    .unwrap();
}

struct Fixture {
    _home: tempfile::TempDir,
    provider: Provider,
    engine: Arc<EngineState>,
    _parent: crate::NativeThread,
    _child: crate::NativeThread,
    state: Arc<ThreadState>,
    hold: Arc<CompletionHold>,
    old_turn: String,
}

fn request(text: &str) -> TurnInputRequest {
    TurnInputRequest {
        input: TurnInput::UserInput {
            content: vec![UserInput::Text {
                text: text.to_owned(),
                text_elements: vec![],
            }],
            client_id: None,
        },
        thread_settings: Default::default(),
        start: TurnStartOptions {
            // A real native child notifies this parent after queuing its terminal.
            parent_turn_id: Some("settlement-parent-turn".to_owned()),
            ..Default::default()
        },
        additional_context: Default::default(),
        responsesapi_client_metadata: None,
        trace: None,
    }
}

async fn managed(state: &ThreadState, text: &str) -> StartIfIdleSubmission {
    let mut mutation = Some(state.mutations.lock().await);
    let init = state.thread.config_snapshot().await.turn_extension_init;
    turn_settlement::start(state, &mut mutation, request(text), init)
        .await
        .unwrap()
}

async fn terminal(state: &Arc<ThreadState>, turn_id: &str) {
    loop {
        let native = state.thread.next_event().await.unwrap();
        let event = serde_json::to_value(&native).unwrap();
        if event["msg"]["type"] == "task_complete" && event["msg"]["turn_id"] == turn_id {
            assert!(event["subagent_id"].is_null());
            // This raw reader bypasses Session's idle wait, but consuming the
            // terminal must still report the actual delivery boundary.
            state
                .thread
                .thread_extension_data()
                .get::<Settlement>()
                .unwrap()
                .delivered(&native.msg);
            return;
        }
    }
}

async fn session_terminal(state: &Arc<ThreadState>, turn_id: &str) -> anyhow::Result<Value> {
    loop {
        let event = state.next_session_event().await?;
        if event["msg"]["type"] == "task_complete" && event["msg"]["turn_id"] == turn_id {
            assert!(event["subagent_id"].is_null());
            return Ok(event);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_steering_ids_cannot_credit_a_later_generation_or_recovery() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let provider = Provider::start().await;
        let (_home, engine) = provider.engine().await;
        let native = engine
            .start_with_tools(
                serde_json::from_value(json!({"_managed_instructions":true})).unwrap(),
                Vec::new(),
            )
            .await
            .unwrap();
        let state = native.current().unwrap();
        let thread_store = state.thread.thread_extension_data();
        let session_store = ExtensionData::new("session");
        let turn_store = ExtensionData::new("owned");
        let mode = serde_json::from_value(json!({
            "mode":"default",
            "settings":{"model":"gpt-5.1-codex","reasoning_effort":null,"developer_instructions":null}
        }))
        .unwrap();
        let start = || TurnStartInput {
            turn_id: "owned",
            collaboration_mode: &mode,
            token_usage_at_turn_start: None,
            session_store: &session_store,
            thread_store: &thread_store,
            turn_store: &turn_store,
        };
        turn_settlement::Contributor.on_turn_start(start()).await;
        engine.interception.on_turn_start(start()).await;
        let first = turn_store.get::<turn_settlement::Turn>().unwrap();
        let one = first.reserve_steering().unwrap();
        let two = first.reserve_steering().unwrap();
        let mut message = UserMessageItem::new(&[UserInput::Text {
            text: "issued input".into(),
            text_elements: vec![],
        }]);
        message.client_id = Some(one.clone());
        let completed = TurnItem::UserMessage(message);
        turn_settlement::Contributor
            .on_item_completed(&thread_store, &turn_store, &completed)
            .await;
        assert_eq!(first.unsampled_steering(), Some(true));
        let request = |kind| {
            let mut metadata = None;
            engine.interception.request(ModelRequestInput {
                kind,
                thread_id: &state.id.to_string(),
                model: "gpt-5.1-codex",
                client_metadata: &mut metadata,
            });
        };
        request(ModelRequestKind::Warmup);
        assert_eq!(first.unsampled_steering(), Some(true));
        request(ModelRequestKind::Generation);
        assert_eq!(first.unsampled_steering(), Some(false));
        // A public ItemCompleted exposes its ID, but the owned route already
        // consumed it. An untagged start_or_steer replay must not regain credit.
        turn_settlement::Contributor
            .on_item_completed(&thread_store, &turn_store, &completed)
            .await;
        assert_eq!(first.unsampled_steering(), Some(false));
        let mut pending = UserMessageItem::new(&[UserInput::Text {
            text: "second issued input".into(),
            text_elements: vec![],
        }]);
        pending.client_id = Some(two);
        let pending = TurnItem::UserMessage(pending);
        turn_settlement::Contributor
            .on_item_completed(&thread_store, &turn_store, &pending)
            .await;
        assert_eq!(first.unsampled_steering(), Some(true));
        // A fresh same-ID lifecycle may not clear or consume an old receipt.
        let recovered_store = ExtensionData::new("owned");
        for contributor in [
            &turn_settlement::Contributor as &dyn TurnLifecycleContributor,
            engine.interception.as_ref(),
        ] {
            contributor
                .on_turn_start(TurnStartInput {
                    turn_id: "owned",
                    collaboration_mode: &mode,
                    token_usage_at_turn_start: None,
                    session_store: &session_store,
                    thread_store: &thread_store,
                    turn_store: &recovered_store,
                })
                .await;
        }
        let recovered = recovered_store
            .get::<turn_settlement::Turn>()
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &recovered));
        request(ModelRequestKind::Generation);
        turn_settlement::Contributor
            .on_item_completed(&thread_store, &recovered_store, &pending)
            .await;
        assert_eq!(first.unsampled_steering(), Some(true));
        assert_eq!(recovered.unsampled_steering(), Some(false));
        state.close().await.unwrap();
        engine.close().await.unwrap();
    })
    .await
    .expect("steering lifecycle authority did not settle");
}

impl Fixture {
    async fn held() -> Self {
        let fixture = Self::held_before_terminal().await;
        terminal(&fixture.state, &fixture.old_turn).await;
        // This is the actual unfixed Core result, not an injected NotIdle.
        assert_eq!(
            fixture
                .state
                .thread
                .start_turn_if_idle(request("unaccepted probe"))
                .await
                .unwrap(),
            StartIfIdleSubmission::NotSubmitted {
                reason: NotSubmittedReason::NotIdle
            }
        );
        fixture
    }

    async fn held_before_terminal() -> Self {
        let provider = Provider::start().await;
        let (home, engine) = provider.engine().await;
        let parent = engine
            .start_with_tools(Default::default(), Vec::new())
            .await
            .unwrap();
        let parent_state = parent.current().unwrap();
        let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
            parent_thread_id: parent_state.id,
            depth: 1,
            agent_path: Some(
                codex_protocol::AgentPath::root()
                    .join("settlement")
                    .unwrap(),
            ),
            agent_nickname: None,
            agent_role: None,
        });
        let options = serde_json::from_value(json!({
            "session_source":source, "thread_source":ThreadSource::Subagent,
        }))
        .unwrap();
        let child = {
            let _lifecycle = engine.lifecycle.lock().await;
            let (startup, instructions) = engine.build_startup(options).await.unwrap();
            // The child uses native lifecycle services; replaceable catalogs
            // belong to the root and must not be installed again here.
            engine
                .start_prepared(startup, instructions, None)
                .await
                .unwrap()
        };
        let state = Arc::clone(&child.current().unwrap());
        let hold = Arc::new(CompletionHold {
            parent: parent_state.id,
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        *engine
            .store
            .as_any()
            .downcast_ref::<crate::storage::MemoryThreadStore>()
            .unwrap()
            .completion_hold
            .lock()
            .unwrap() = Some(hold.clone());
        let StartIfIdleSubmission::Started { turn_id } = managed(&state, "first input").await
        else {
            panic!("first managed input was not accepted");
        };
        hold.entered.acquire().await.unwrap().forget();
        Self {
            _home: home,
            provider,
            engine,
            _parent: parent,
            _child: child,
            state,
            hold,
            old_turn: turn_id,
        }
    }

    async fn retry(&self) -> JoinHandle<StartIfIdleSubmission> {
        let state = self.state.clone();
        let task = tokio::spawn(async move { managed(&state, "second input").await });
        self.state
            .thread
            .thread_extension_data()
            .get::<Settlement>()
            .unwrap()
            .waiting
            .acquire()
            .await
            .unwrap()
            .forget();
        assert!(!task.is_finished());
        task
    }

    async fn interrupt_session(&self) {
        let _mutation = self.state.mutations.lock().await;
        self.state
            .thread
            .thread_extension_data()
            .get::<Settlement>()
            .unwrap()
            .interrupt_session(&self.state.thread)
            .await
            .unwrap();
    }

    fn release(&self) {
        *self
            .engine
            .store
            .as_any()
            .downcast_ref::<crate::storage::MemoryThreadStore>()
            .unwrap()
            .completion_hold
            .lock()
            .unwrap() = None;
        self.hold.release.add_permits(1);
    }

    async fn close(self) {
        self.release();
        self.state.close().await.unwrap();
        self.engine.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_submit_waits_for_its_passive_native_turn_to_release_the_slot() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = Provider::start().await;
        let (_home, engine) = provider.engine().await;
        let session = engine.start_with_tools(Default::default(), Vec::new()).await.unwrap();
        let parent = session.current().unwrap();
        let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
            parent_thread_id: parent.id,
            depth: 1,
            agent_path: Some(codex_protocol::AgentPath::root().join("settlement").unwrap()),
            agent_nickname: None,
            agent_role: None,
        });
        let options = serde_json::from_value(json!({
            "session_source":source, "thread_source":ThreadSource::Subagent,
        })).unwrap();
        let child = {
            let _lifecycle = engine.lifecycle.lock().await;
            let (mut startup, _) = engine.build_startup(options).await.unwrap();
            startup.thread_extension_init.insert(crate::native_agents::Policy {
                roles: Vec::new(), max_depth: 1, inherited_instructions: None,
                allowed: Default::default(),
            });
            // The parent remains the only SDK event owner for this native child.
            engine.manager.start_thread(startup).await.unwrap()
        };
        let hold = Arc::new(CompletionHold {
            parent: parent.id, entered: Semaphore::new(0), release: Semaphore::new(0),
        });
        let store = engine.store.as_any().downcast_ref::<crate::storage::MemoryThreadStore>().unwrap();
        *store.completion_hold.lock().unwrap() = Some(hold.clone());
        let StartIfIdleSubmission::Started { turn_id: previous } = child.thread
            .start_turn_if_idle(request("first input")).await.unwrap() else {
            panic!("passive child did not start");
        };
        hold.entered.acquire().await.unwrap().forget();
        let settlement = child.thread.thread_extension_data().get::<Settlement>().unwrap();
        loop {
            let event = child.thread.next_event().await.unwrap();
            if matches!(&event.msg, EventMsg::TurnComplete(done) if done.turn_id == previous) {
                settlement.delivered(&event.msg);
                break;
            }
        }
        {
            let mut events = parent.events.lock().await;
            parent.discover_children(&mut events).await.unwrap();
        }
        let (instance, _, _) = crate::subagents::instance(&parent, child.thread_id)
            .await.unwrap().expect("passive child must be an owned descendant");
        let control = child.thread.thread_extension_data()
            .get::<crate::native_interception::Control>().unwrap();
        assert!(control.active_turn_id().is_none());
        assert!(settlement.completed_child().is_some());
        let id = child.thread_id;
        let owner = parent.clone();
        let mut submit = tokio::spawn(async move {
            Box::pin(crate::subagents::submit(&owner, id, instance, json!({
                "input":[{"type":"text", "text":"second input", "text_elements":[]}]
            }))).await
        });
        tokio::select! {
            permit = settlement.waiting.acquire() => permit.unwrap().forget(),
            result = &mut submit => {
                panic!("child submission returned before its native slot became idle: {}", result.is_ok());
            }
        }
        assert!(parent.mutations.try_lock().is_err(), "child admission must retain its serialization");
        assert_eq!(provider.child_requests(id), 1);
        *store.completion_hold.lock().unwrap() = None;
        hold.release.add_permits(1);
        let turn = submit.await.unwrap().unwrap();
        assert_ne!(turn.turn_id, previous);
        loop {
            let event = child.thread.next_event().await.unwrap();
            if matches!(&event.msg, EventMsg::TurnComplete(done) if done.turn_id == turn.turn_id) {
                break;
            }
        }
        assert_eq!(provider.child_requests(id), 2);
        parent.close().await.unwrap();
        engine.close().await.unwrap();
    }).await.expect("passive child admission did not settle");
}

#[tokio::test]
async fn passive_manual_observation_serializes_with_context_change() {
    let fixture = Fixture::held_before_terminal().await;
    let observation = fixture.engine.manual_observation();
    let observed = observation.is_some();
    let change_blocked = fixture
        .engine
        .context_gate
        .clone()
        .try_write_owned()
        .is_err();
    drop(observation);
    let change = fixture.engine.context_gate.clone().try_write_owned();
    let change_acquired = change.is_ok();
    let observation_blocked = fixture.engine.manual_observation().is_none();
    drop(change);
    let observation_resumed = fixture.engine.manual_observation().is_some();
    fixture.close().await;
    assert!(observed && change_blocked);
    assert!(change_acquired && observation_blocked && observation_resumed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_terminal_waits_for_idle_and_survives_cancelled_reader() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let fixture = Fixture::held_before_terminal().await;
        let settlement = fixture
            .state
            .thread
            .thread_extension_data()
            .get::<Settlement>()
            .unwrap();
        let original = settlement
            .admission_ready(&fixture.old_turn)
            .unwrap()
            .unwrap();
        let mut first_read = Box::pin(session_terminal(&fixture.state, &fixture.old_turn));
        assert!(
            futures_util::poll!(first_read.as_mut()).is_pending(),
            "managed terminal was delivered before Core released the active slot"
        );
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 1);
        drop(first_read);
        // The read reached the terminal; this is not just cancellation of an
        // earlier event wait. Its dequeued terminal must survive cancellation.
        assert!(fixture.state.events.lock().await.session_terminal.is_some());
        fixture.release();
        let event = session_terminal(&fixture.state, &fixture.old_turn)
            .await
            .unwrap();
        assert_eq!(event["id"], fixture.old_turn);
        let StartIfIdleSubmission::Started { turn_id } =
            managed(&fixture.state, "second input").await
        else {
            panic!("managed completion did not make the next input admissible");
        };
        assert_ne!(turn_id, fixture.old_turn);
        // An already ready receipt remains usable after the next real start.
        original.wait().await.unwrap();
        terminal(&fixture.state, &turn_id).await;
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 2);
        let history = fixture
            .engine
            .load_checkpoint_history(fixture.state.id)
            .await
            .unwrap();
        let inputs: Vec<_> = history
            .iter()
            .filter_map(|item| match item {
                RolloutItem::ResponseItem(item) => Some(&item.item),
                _ => None,
            })
            .collect();
        assert_eq!(
            serde_json::to_string(&inputs)
                .unwrap()
                .matches("second input")
                .count(),
            1
        );
        fixture.close().await;
    })
    .await
    .expect("managed terminal was lost or admission did not finish");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_releases_managed_terminal_without_idle() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let fixture = Fixture::held_before_terminal().await;
        let mut read = Box::pin(session_terminal(&fixture.state, &fixture.old_turn));
        assert!(
            futures_util::poll!(read.as_mut()).is_pending(),
            "managed terminal was delivered before Core released the active slot"
        );
        let state = fixture.state.clone();
        let close = tokio::spawn(async move { state.close().await });
        assert!(read.await.is_err(), "close cannot deliver a ready terminal");
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 1);
        fixture.release();
        close.await.unwrap().unwrap();
        fixture.engine.close().await.unwrap();
    })
    .await
    .expect("close did not release the managed terminal reader");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_detached_turn_does_not_strand_managed_completion() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let fixture = Fixture::held_before_terminal().await;
        let mut read = Box::pin(session_terminal(&fixture.state, &fixture.old_turn));
        assert!(
            futures_util::poll!(read.as_mut()).is_pending(),
            "managed terminal must initially wait for admission"
        );
        fixture.interrupt_session().await;
        // Interrupt removed the empty active slot while Core was notifying the
        // parent. Normal task completion can no longer emit the idle lifecycle.
        fixture.release();
        let event = tokio::time::timeout(Duration::from_secs(1), read)
            .await
            .expect("managed completion stranded after interrupt detached the active slot")
            .unwrap();
        assert_eq!(event["id"], fixture.old_turn);
        let StartIfIdleSubmission::Started { turn_id } =
            managed(&fixture.state, "input after detached interrupt").await
        else {
            panic!("settled interrupted completion did not admit the next input");
        };
        assert_ne!(turn_id, fixture.old_turn);
        session_terminal(&fixture.state, &turn_id).await.unwrap();
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 2);
        let history = fixture
            .engine
            .load_checkpoint_history(fixture.state.id)
            .await
            .unwrap();
        let inputs: Vec<_> = history
            .iter()
            .filter_map(|item| match item {
                RolloutItem::ResponseItem(item) => Some(&item.item),
                _ => None,
            })
            .collect();
        assert_eq!(
            serde_json::to_string(&inputs)
                .unwrap()
                .matches("input after detached interrupt")
                .count(),
            1
        );
        fixture.close().await;
    })
    .await
    .expect("detached interrupt regression exceeded its outer bound");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_id_lifecycle_replacement_cannot_authorize_held_completion() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let fixture = Fixture::held_before_terminal().await;
        let thread_store = fixture.state.thread.thread_extension_data();
        let settlement = thread_store.get::<Settlement>().unwrap();
        let original = settlement
            .admission_ready(&fixture.old_turn)
            .unwrap()
            .unwrap();
        let mut read = Box::pin(session_terminal(&fixture.state, &fixture.old_turn));
        assert!(futures_util::poll!(read.as_mut()).is_pending());
        let mode = serde_json::from_value(json!({
            "mode": "default",
            "settings": {"model": "test", "reasoning_effort": null, "developer_instructions": null}
        }))
        .unwrap();
        let session_store = ExtensionData::new("session");
        let turn_store = ExtensionData::new(&fixture.old_turn);
        // Recovery may keep the turn ID but receives a fresh lifecycle. Use the
        // actual SDK hook without fabricating or replacing the Core terminal.
        turn_settlement::Contributor
            .on_turn_start(TurnStartInput {
                turn_id: &fixture.old_turn,
                collaboration_mode: &mode,
                token_usage_at_turn_start: None,
                session_store: &session_store,
                thread_store: &thread_store,
                turn_store: &turn_store,
            })
            .await;
        let current = settlement
            .admission_ready(&fixture.old_turn)
            .unwrap()
            .unwrap();
        assert!(!Arc::ptr_eq(&current, &original));
        assert!(original.wait().await.is_err());
        assert!(futures_util::poll!(Box::pin(current.wait())).is_pending());
        assert!(
            read.await.is_err(),
            "old completion cannot use the new turn receipt"
        );
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 1);
        fixture.close().await;
    })
    .await
    .expect("same-ID replacement left an old terminal waiting");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delivered_terminal_retries_only_after_core_settles() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let fixture = Fixture::held().await;
        let retry = fixture.retry().await;
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 1);
        fixture.release();
        let StartIfIdleSubmission::Started { turn_id } = retry.await.unwrap() else {
            panic!("settled native slot did not accept the next input");
        };
        assert_ne!(turn_id, fixture.old_turn);
        terminal(&fixture.state, &turn_id).await;
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 2);
        let history = fixture
            .engine
            .load_checkpoint_history(fixture.state.id)
            .await
            .unwrap();
        let items: Vec<_> = history
            .iter()
            .filter_map(|item| match item {
                RolloutItem::ResponseItem(item) => Some(&item.item),
                _ => None,
            })
            .collect();
        let history = serde_json::to_value(items).unwrap().to_string();
        assert!(!history.contains("unaccepted probe"));
        assert_eq!(history.matches("second input").count(), 1);
        fixture.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_idle_returns_original_rejection_without_input() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let fixture = Fixture::held().await;
        assert_eq!(
            fixture.retry().await.await.unwrap(),
            StartIfIdleSubmission::NotSubmitted {
                reason: NotSubmittedReason::NotIdle
            }
        );
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 1);
        fixture.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_retires_waiter_without_needing_idle() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let fixture = Fixture::held().await;
        let retry = fixture.retry().await;
        let state = fixture.state.clone();
        let close = tokio::spawn(async move { state.close().await });
        assert_eq!(
            retry.await.unwrap(),
            StartIfIdleSubmission::NotSubmitted {
                reason: NotSubmittedReason::NotIdle
            }
        );
        fixture.release();
        close.await.unwrap().unwrap();
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 1);
        fixture.engine.close().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn competing_native_turn_retires_the_old_retry() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let fixture = Fixture::held().await;
        let retry = fixture.retry().await;
        let mutation = fixture.state.mutations.lock().await;
        // Core interruption can remove the old empty slot. The following
        // acknowledged settings operation orders this test after that command.
        fixture.state.thread.submit(Op::Interrupt).await.unwrap();
        fixture
            .state
            .thread
            .update_thread_settings(codex_protocol::protocol::ThreadSettingsOverrides::default())
            .await
            .unwrap();
        let mut competing = request("competing input");
        competing.start = Default::default();
        let StartIfIdleSubmission::Started { turn_id } = fixture
            .state
            .thread
            .start_turn_if_idle(competing)
            .await
            .unwrap()
        else {
            panic!("competing native turn was not admitted");
        };
        drop(mutation);
        assert_eq!(
            retry.await.unwrap(),
            StartIfIdleSubmission::NotSubmitted {
                reason: NotSubmittedReason::NotIdle,
            }
        );
        terminal(&fixture.state, &turn_id).await;
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 2);
        let history = fixture
            .engine
            .load_checkpoint_history(fixture.state.id)
            .await
            .unwrap();
        assert!(
            !serde_json::to_value(history)
                .unwrap()
                .to_string()
                .contains("second input")
        );
        fixture.close().await;
    })
    .await
    .unwrap();
}

// Exercise the actual child event reader and native receipt. The witness is
// observed only to establish the interleaving; this test never sets it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publication_waits_for_a_real_dequeued_child_error_receipt() {
    publication_waits_for_real_dequeued_error(422).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publication_preserves_a_generic_http400_child_error_without_invented_metadata() {
    publication_waits_for_real_dequeued_error(400).await;
}

async fn publication_waits_for_real_dequeued_error(status: u16) {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = Provider::start_with_http_error(Some(status)).await;
        let (_home, engine) = provider.engine().await;
        let session = engine
            .start_with_tools(Default::default(), Vec::new())
            .await
            .unwrap();
        let parent = session.current().unwrap();
        let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
            parent_thread_id: parent.id,
            depth: 1,
            agent_path: Some(
                codex_protocol::AgentPath::root()
                    .join("settlement")
                    .unwrap(),
            ),
            agent_nickname: None,
            agent_role: None,
        });
        let options = serde_json::from_value(json!({
            "session_source":source, "thread_source":ThreadSource::Subagent,
        }))
        .unwrap();
        let child = {
            let _lifecycle = engine.lifecycle.lock().await;
            let (startup, _) = engine.build_startup(options).await.unwrap();
            // A native child has no independent SDK Session. Let the parent's
            // production reader claim it, rather than creating a second owner.
            engine.manager.start_thread(startup).await.unwrap()
        };
        let idle_hold = Arc::new(crate::turn_settlement::IdleHold {
            entered: Semaphore::new(0),
            release: Arc::new(Semaphore::new(1)),
        });
        // The owned permit releases on panic or cancellation as well as success.
        let idle_permit = idle_hold.release.clone().acquire_owned().await.unwrap();
        *child
            .thread
            .thread_extension_data()
            .get_or_init(Settlement::default)
            .idle_hold
            .lock()
            .unwrap() = Some(idle_hold.clone());
        let StartIfIdleSubmission::Started { turn_id } = child
            .thread
            .start_turn_if_idle(request("first input"))
            .await
            .unwrap()
        else {
            panic!("first native child input was not accepted");
        };
        idle_hold.entered.acquire().await.unwrap().forget();
        let settlement = child
            .thread
            .thread_extension_data()
            .get::<Settlement>()
            .unwrap();
        let receipt = settlement.observed(&turn_id).unwrap();
        let (dequeued, instance) = {
            let mut events = parent.events.lock().await;
            parent.discover_children(&mut events).await.unwrap();
            let (_, reader) = events
                .children
                .iter()
                .find(|(id, _)| *id == child.thread_id)
                .expect("the actual Core child must have an owned reader");
            (reader.dequeued.clone(), reader.instance)
        };
        // Poll the sole production reader until it has dequeued the terminal
        // and parked on Settlement::wait. Cancelling this outer read must keep
        // that event and the production witness in its existing ChildReader.
        loop {
            let mut read = Box::pin(parent.next_session_event());
            let observed = tokio::select! {
                biased;
                event = &mut read => Some(event.unwrap()),
                _ = async {
                    while !dequeued.load(Ordering::Acquire) {
                        tokio::task::yield_now().await;
                    }
                } => None,
            };
            drop(read);
            let Some(event) = observed else { break };
            assert!(
                event["subagent_id"] != child.thread_id.to_string()
                    || !matches!(
                        event["msg"]["type"].as_str(),
                        Some("task_complete" | "turn_complete")
                    ),
                "the held native receipt must prevent child terminal delivery"
            );
        }
        let boundary_id = "real-held-child-boundary";
        {
            let mut events = parent.events.lock().await;
            parent
                .start_publication_prefix(&mut events, boundary_id.to_owned())
                .await
                .unwrap();
            let prefix = events.publication_prefix.as_ref().unwrap();
            assert!(!prefix.complete());
            assert!(prefix.children[&(child.thread_id, instance)] > 0);
        }
        let mut boundary = Box::pin(async {
            loop {
                let event = parent.next_session_event().await.unwrap();
                if event["msg"]["type"] == "sdk_mcp_publication_boundary" {
                    return event;
                }
            }
        });
        tokio::select! {
            biased;
            event = &mut boundary => panic!("publication bypassed held child metadata: {event}"),
            _ = tokio::task::yield_now() => {}
        }
        drop(boundary);
        assert!(dequeued.load(Ordering::Acquire));
        {
            let events = parent.events.lock().await;
            assert!(!events.publication_prefix.as_ref().unwrap().complete());
        }
        drop(idle_permit);
        let mut terminal = None;
        loop {
            let event = parent.next_session_event().await.unwrap();
            if event["subagent_id"] == child.thread_id.to_string()
                && event["msg"]["turn_id"] == turn_id
                && matches!(
                    event["msg"]["type"].as_str(),
                    Some("task_complete" | "turn_complete")
                )
            {
                assert!(terminal.is_none());
                terminal = Some(event);
            } else if event["msg"]["type"] == "sdk_mcp_publication_boundary" {
                assert_eq!(event["id"], boundary_id);
                break;
            }
        }
        let terminal = terminal.expect("exact child error must precede publication");
        let requests = provider.child_requests(child.thread_id);
        eprintln!("held HTTP{status} child_requests={requests} terminal={terminal}");
        assert_eq!(requests, 1, "terminal={terminal}");
        assert_eq!(terminal["id"], turn_id, "terminal={terminal}");
        assert_eq!(
            terminal["subagent_instance_id"], instance,
            "terminal={terminal}"
        );
        assert!(Arc::ptr_eq(
            &receipt,
            &settlement.observed(&turn_id).unwrap()
        ));
        assert!(!dequeued.load(Ordering::Acquire));
        let error = &terminal["msg"]["error"];
        if status == 422 {
            assert_eq!(
                error["codex_error_info"],
                serde_json::to_value(
                    codex_protocol::protocol::CodexErrorInfo::HttpConnectionFailed {
                        http_status_code: Some(422),
                    }
                )
                .unwrap(),
                "terminal={terminal}"
            );
            assert_eq!(
                error["_sdk_provider_error"],
                json!({"status_code":422,"code":"held_error","request_id":"withheld-child-422"}),
                "child_requests={requests} terminal={terminal}"
            );
        } else {
            assert_eq!(status, 400);
            assert_eq!(
                error["codex_error_info"],
                serde_json::to_value(codex_protocol::protocol::CodexErrorInfo::Other).unwrap(),
                "terminal={terminal}"
            );
            assert_eq!(
                error["message"],
                std::str::from_utf8(HELD_ERROR_BODY).unwrap(),
                "terminal={terminal}"
            );
            assert!(
                error.get("_sdk_provider_error").is_none(),
                "terminal={terminal}"
            );
        }
        parent.close().await.unwrap();
        engine.close().await.unwrap();
    })
    .await
    .expect("real child metadata/publication ordering did not settle");
}

// Diagnostics reuses the same real Core lifecycle and existing ThreadStore barriers.
struct ProbeFlushHold(Arc<CompletionHold>);
impl Drop for ProbeFlushHold {
    fn drop(&mut self) {
        self.0.release.add_permits(1);
    }
}
fn hold_probe_flush(state: &ThreadState) -> ProbeFlushHold {
    let hold = Arc::new(CompletionHold {
        parent: state.id,
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *state
        .engine
        .store
        .as_any()
        .downcast_ref::<crate::storage::MemoryThreadStore>()
        .unwrap()
        .next_flush_hold
        .lock()
        .unwrap() = Some(hold.clone());
    ProbeFlushHold(hold)
}
async fn ready_child_without_reading(fixture: &Fixture) {
    let receipt = fixture
        .state
        .thread
        .thread_extension_data()
        .get::<Settlement>()
        .unwrap()
        .observe()
        .receipt
        .unwrap();
    fixture.release();
    receipt.wait().await.unwrap();
}

// Opening normally publishes managed instructions. Legacy manual restore is the
// existing route which defers publication; after its frame is consumed the owner
// can remain Pending. Build that owner with the same SDK primitives, not a fake receipt.
async fn deferred_diagnostic_root(engine: &Arc<EngineState>, text: &str) -> NativeThread {
    let _lifecycle = engine.lifecycle.lock().await;
    let (mut startup, instructions) = engine
        .build_startup(
            serde_json::from_value(json!({
                "_managed_instructions":true, "instructions":text
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    instructions.defer_manual().unwrap();
    crate::python_tools::PythonTools::install(
        &mut startup,
        Vec::new(),
        crate::python_tools::ToolInstallOptions {
            preserve_schemas: false,
            strict_functions: false,
            allow_local_goals: false,
        },
    )
    .unwrap();
    engine
        .start_prepared(startup, instructions, None)
        .await
        .unwrap()
}

fn captured_settings(history: &[RolloutItem]) -> RolloutItem {
    history
        .iter()
        .rev()
        .find(|row| {
            matches!(
                row,
                RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(_))
            )
        })
        .expect("settled control has a settings checkpoint")
        .clone()
}
fn assert_one_settings_append(
    before: &[RolloutItem],
    after: &[RolloutItem],
    settings: &RolloutItem,
) {
    assert_eq!(
        after.len(),
        before.len() + 1,
        "capture must append only its counted settings record"
    );
    assert!(
        serde_json::to_value(before).unwrap()
            == serde_json::to_value(&after[..before.len()]).unwrap(),
        "capture changed an existing raw source field"
    );
    assert_eq!(
        serde_json::to_value(&after[before.len()]).unwrap(),
        serde_json::to_value(settings).unwrap(),
        "capture appended unexpected source data or different settings"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_probe_keeps_pending_instructions_passive_and_normal_export_unchanged() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = Provider::start().await;
        let (_home, engine) = provider.engine().await;
        let native = deferred_diagnostic_root(&engine, "Act without side effects.").await;
        let state = native.current().unwrap();
        // Settle initial source writes before measuring the probe. Capture itself
        // persists one identical settings event; it must add nothing else.
        state.thread.checkpoint_thread_settings().await.unwrap();
        state.thread.ensure_rollout_materialized().await;
        state.thread.flush_rollout().await.unwrap();
        let mut raw = engine.load_checkpoint_history(state.id).await.unwrap();
        let settings = captured_settings(&raw);
        assert!(state.instructions.needs_publication(true));
        assert!(state.instructions.accepted().is_none());
        assert!(
            crate::application_instructions::latest(&raw)
                .unwrap()
                .is_none()
        );
        assert!(provider.requests.lock().unwrap().is_empty());
        for _ in 0..2 {
            let value: Value = serde_json::from_str(
                &native
                    ._export_checkpoint(None, false, Some(true))
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(value["kind"], "snapshot");
            let snapshot: Value =
                serde_json::from_str(value["snapshot"].as_str().unwrap()).unwrap();
            assert_eq!(snapshot["format_version"], 2);
            let after = engine.load_checkpoint_history(state.id).await.unwrap();
            assert_one_settings_append(&raw, &after, &settings);
            assert_eq!(snapshot["history"], serde_json::to_value(&after).unwrap());
            assert!(
                crate::application_instructions::latest(&after)
                    .unwrap()
                    .is_none()
            );
            assert!(state.instructions.needs_publication(true));
            assert!(state.instructions.accepted().is_none());
            assert!(provider.requests.lock().unwrap().is_empty());
            raw = after;
        }
        let ordinary: Value =
            serde_json::from_str(&native._export_checkpoint(None, false, None).await.unwrap())
                .unwrap();
        assert!(ordinary.get("kind").is_none());
        assert_eq!(ordinary["format_version"], 2);
        assert!(state.instructions.accepted().is_some());
        let ordinary_history: Vec<RolloutItem> =
            serde_json::from_value(ordinary["history"].clone()).unwrap();
        let published: Vec<_> = ordinary_history
            .iter()
            .filter(|row| {
                matches!(row, RolloutItem::ResponseItem(_))
                    && crate::application_instructions::latest(std::slice::from_ref(*row))
                        .expect("valid original response item")
                        .is_some()
            })
            .collect();
        assert_eq!(published.len(), 1);
        assert_eq!(
            crate::application_instructions::latest(&ordinary_history)
                .unwrap()
                .unwrap()
                .text,
            "Act without side effects."
        );
        let explicit_false: Value = serde_json::from_str(
            &native
                ._export_checkpoint(None, false, Some(false))
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(explicit_false.get("kind").is_none());
        assert_eq!(explicit_false["format_version"], ordinary["format_version"]);
        assert_eq!(
            explicit_false["source_session_id"],
            ordinary["source_session_id"]
        );
        let false_history: Vec<RolloutItem> =
            serde_json::from_value(explicit_false["history"].clone()).unwrap();
        assert_one_settings_append(
            &ordinary_history,
            &false_history,
            &captured_settings(&ordinary_history),
        );
        let still_published: Vec<_> = false_history
            .iter()
            .filter(|row| {
                matches!(row, RolloutItem::ResponseItem(_))
                    && crate::application_instructions::latest(std::slice::from_ref(*row))
                        .expect("valid original response item")
                        .is_some()
            })
            .collect();
        assert_eq!(
            serde_json::to_value(&published).unwrap(),
            serde_json::to_value(&still_published).unwrap()
        );
        assert_eq!(still_published.len(), 1);
        assert_eq!(
            explicit_false["history"],
            serde_json::to_value(engine.load_checkpoint_history(state.id).await.unwrap()).unwrap()
        );
        assert!(provider.requests.lock().unwrap().is_empty());
        state.close().await.unwrap();
        engine.close().await.unwrap();
    })
    .await
    .expect("passive instruction capture exceeded its outer bound");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_capture_retains_context_admission_until_export_finishes() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for probe in [None, Some(false), Some(true)] {
            let provider = Provider::start().await;
            let (_home, engine) = provider.engine().await;
            let native = Arc::new(
                engine
                    .start_with_tools(Default::default(), Vec::new())
                    .await
                    .unwrap(),
            );
            let state = native.current().unwrap();
            let hold = hold_probe_flush(&state);
            let owned = native.clone();
            let exporting =
                tokio::spawn(async move { owned._export_checkpoint(None, false, probe).await });
            hold.0.entered.acquire().await.unwrap().forget();
            let mut change = Box::pin(crate::context::begin(Arc::clone(&state)));
            let admission = match futures_util::poll!(&mut change) {
                Poll::Ready(Err(error)) => error.to_string(),
                Poll::Ready(Ok(_)) => "context change was admitted".into(),
                Poll::Pending => "context change waited".into(),
            };
            drop(change);
            drop(hold);
            let result = exporting.await;
            let released = engine.context_gate.clone().try_write_owned().is_ok();
            let requests = provider.requests.lock().unwrap().len();
            state.close().await.unwrap();
            engine.close().await.unwrap();

            assert_eq!(admission, "native operations are still in progress");
            assert!(released, "completed capture retained context admission");
            assert_eq!(requests, 0);
            let value: Value = serde_json::from_str(&result.unwrap().unwrap()).unwrap();
            if probe == Some(true) {
                assert_eq!(value["kind"], "snapshot");
            } else {
                assert_eq!(value["format_version"], 2);
            }
        }
    })
    .await
    .expect("checkpoint context admission exceeded its outer bound");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_probe_refuses_native_admission_lock_without_waiting() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = Provider::start().await;
        let (_home, engine) = provider.engine().await;
        let native = engine
            .start_with_tools(Default::default(), Vec::new())
            .await
            .unwrap();
        let state = native.current().unwrap();
        let mutation = state.mutations.lock().await;
        let value: Value = serde_json::from_str(
            &native
                ._export_checkpoint(None, false, Some(true))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value, json!({"kind":"notReady","reason":"nativeBusy"}));
        assert!(provider.requests.lock().unwrap().is_empty());
        drop(mutation);
        state.close().await.unwrap();
        engine.close().await.unwrap();
    })
    .await
    .expect("probe queued behind an existing mutation");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_probe_uses_native_stop_and_idle_without_reader_delivery() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::held_before_terminal().await;
        let root = fixture._parent.current().unwrap();
        let settlement = fixture
            .state
            .thread
            .thread_extension_data()
            .get::<Settlement>()
            .unwrap();
        let observed = settlement.observe();
        assert!(observed.active);
        assert!(observed.receipt.as_ref().unwrap().terminal());
        assert_eq!(
            serde_json::to_value(crate::checkpoint::probe(&root).await.unwrap()).unwrap()["reason"],
            "nativeBusy"
        );
        ready_child_without_reading(&fixture).await;
        assert!(!settlement.observe().active);
        assert_eq!(
            serde_json::to_value(crate::checkpoint::probe(&root).await.unwrap()).unwrap()["kind"],
            "snapshot"
        );
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 1);
        fixture.close().await;
    })
    .await
    .expect("native probe depended on child reader delivery");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_probe_lock_precedes_later_admission_and_raw_close_retires_it() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = Provider::start().await;
        let (_home, engine) = provider.engine().await;
        let native = Arc::new(
            engine
                .start_with_tools(Default::default(), Vec::new())
                .await
                .unwrap(),
        );
        let state = native.current().unwrap();
        let hold = hold_probe_flush(&state);
        let owned = native.clone();
        let probing =
            tokio::spawn(async move { owned._export_checkpoint(None, false, Some(true)).await });
        hold.0.entered.acquire().await.unwrap().forget();
        let mut admission = Box::pin(state.mutations.lock());
        assert!(futures_util::poll!(admission.as_mut()).is_pending());
        let mut closing = Box::pin(state.close());
        assert!(futures_util::poll!(closing.as_mut()).is_pending());
        assert!(
            state
                .thread
                .thread_extension_data()
                .get::<Settlement>()
                .unwrap()
                .observe()
                .retired
        );
        hold.0.release.add_permits(1);
        let value: Value = serde_json::from_str(&probing.await.unwrap().unwrap()).unwrap();
        assert_eq!(value["kind"], "notReady");
        let mutation = admission.await;
        drop(mutation);
        closing.await.unwrap();
        engine.close().await.unwrap();
    })
    .await
    .expect("probe/close lock ownership did not settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_probe_rejects_same_id_receipt_replacement_during_capture() {
    use codex_extension_api::{
        ThreadIdleCause, ThreadIdleInput, ThreadLifecycleContributor, TurnStopInput,
    };
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::held_before_terminal().await;
        ready_child_without_reading(&fixture).await;
        let root = fixture._parent.current().unwrap();
        let hold = hold_probe_flush(&root);
        let state = root.clone();
        let probing = tokio::spawn(async move { let _mutation = state.mutations.lock().await; crate::checkpoint::probe(&state).await });
        hold.0.entered.acquire().await.unwrap().forget();
        let thread_store = fixture.state.thread.thread_extension_data();
        let before = thread_store.get::<Settlement>().unwrap().observe().receipt.unwrap();
        let session_store = ExtensionData::new("diagnostic-session");
        let turn_store = ExtensionData::new(&fixture.old_turn);
        let mode = serde_json::from_value(json!({"mode":"default", "settings":{"model":"test","reasoning_effort":null,"developer_instructions":null}})).unwrap();
        // Exercise the actual SDK lifecycle hook. Equal IDs must not authorize the old snapshot.
        turn_settlement::Contributor.on_turn_start(TurnStartInput {turn_id:&fixture.old_turn,
            collaboration_mode:&mode, token_usage_at_turn_start:None, session_store:&session_store,
            thread_store:&thread_store, turn_store:&turn_store}).await;
        turn_settlement::Contributor.on_turn_stop(TurnStopInput {session_store:&session_store,
            thread_store:&thread_store, turn_store:&turn_store}).await;
        turn_settlement::Contributor.on_thread_idle(ThreadIdleInput {cause:ThreadIdleCause::Completed,
            session_store:&session_store, thread_store:&thread_store}).await;
        let after = thread_store.get::<Settlement>().unwrap().observe();
        assert!(!after.active); assert!(!Arc::ptr_eq(&before, after.receipt.as_ref().unwrap()));
        hold.0.release.add_permits(1);
        assert_eq!(serde_json::to_value(probing.await.unwrap().unwrap()).unwrap(), json!({"kind":"notReady","reason":"nativeChanged"}));
        assert_eq!(fixture.provider.child_requests(fixture.state.id), 1);
        fixture.close().await;
    }).await.expect("same-ID receipt replacement was missed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_probe_rejects_real_native_turn_cycle_and_child_removal_during_capture() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for remove in [false, true] {
            let fixture = Fixture::held_before_terminal().await;
            ready_child_without_reading(&fixture).await;
            let root = fixture._parent.current().unwrap();
            let hold = hold_probe_flush(&root);
            let state = root.clone();
            let probing = tokio::spawn(async move {
                let _mutation = state.mutations.lock().await;
                crate::checkpoint::probe(&state).await
            });
            hold.0.entered.acquire().await.unwrap().forget();
            if remove {
                fixture.state.close().await.unwrap();
            } else {
                let StartIfIdleSubmission::Started { .. } =
                    managed(&fixture.state, "native work during probe").await
                else {
                    panic!("native cycle did not start");
                };
                fixture
                    .state
                    .thread
                    .thread_extension_data()
                    .get::<Settlement>()
                    .unwrap()
                    .observe()
                    .receipt
                    .unwrap()
                    .wait()
                    .await
                    .unwrap();
            }
            hold.0.release.add_permits(1);
            assert_eq!(
                serde_json::to_value(probing.await.unwrap().unwrap()).unwrap(),
                json!({"kind":"notReady","reason":"nativeChanged"})
            );
            fixture.close().await;
        }
    })
    .await
    .expect("completed native work or removal escaped observation");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_probe_cannot_hide_invalid_actual_instructions_with_a_prospective_revision() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = Provider::start().await;
        let (_home, engine) = provider.engine().await;
        let native = deferred_diagnostic_root(&engine, "C").await;
        let state = native.current().unwrap();
        state.thread.ensure_rollout_materialized().await;
        state.thread.flush_rollout().await.unwrap();
        let old = crate::application_instructions::publication("A");
        let current = crate::application_instructions::publication("B");
        let mut invalid = vec![RolloutItem::ResponseItem(old.clone().into()), RolloutItem::ResponseItem(current.clone().into()),
            serde_json::from_value(json!({"type":"compacted","payload":{"message":"summary","replacement_history":[current,old]}})).unwrap()];
        assert!(crate::application_instructions::latest(&invalid).is_err());
        // This counterexample requires validating actual authority before appending C.
        invalid.push(RolloutItem::ResponseItem(crate::application_instructions::publication("C").into()));
        assert!(crate::application_instructions::validate(&invalid, "C").is_ok());
        invalid.pop();
        engine.store.append_items(codex_thread_store::AppendThreadItemsParams {thread_id:state.id,items:invalid}).await.unwrap();
        let _mutation = state.mutations.lock().await;
        let error = crate::checkpoint::probe(&state).await.unwrap_err();
        assert!(format!("{error:#}").contains("compacted history places older application instructions after the latest accepted instructions"));
        assert!(state.instructions.needs_publication(true));
        assert!(state.instructions.accepted().is_none());
        assert!(provider.requests.lock().unwrap().is_empty());
        drop(_mutation);state.close().await.unwrap();engine.close().await.unwrap();
    }).await.expect("invalid source instruction evidence escaped passive validation");
}


#[test]
fn raw_child_steering_and_retained_continuation_preserve_carrier() {
    const CHILD: &str = "AGENTS_RAW_CHILD_CONTINUATION_TRACE_TEST";
    if std::env::var_os(CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "engine::settlement_tests::raw_child_steering_and_retained_continuation_preserve_carrier", "--nocapture"])
            .env(CHILD, "1").status().unwrap();
        assert!(status.success());
        return;
    }
    // This real Core fixture installs a process-global tracing subscriber and
    // constructs large turn futures. Keep both isolated from other unit cases.
    std::thread::Builder::new()
        .name("raw-child-carrier".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(raw_child_steering_and_retained_continuation_case());
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn raw_child_steering_and_retained_continuation_case() {
    use codex_otel::sdk_trace::FutureExt as _;
    let telemetry_home = tempfile::tempdir().unwrap();
    crate::telemetry::initialize(
        r#"{"otel.trace_processors":true,"analytics.enabled":false}"#,
        &json!({"codex_home":telemetry_home.path(),"cwd":telemetry_home.path()}).to_string(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        for flags in ["02", "03"] {
            let provider = Provider::start().await;
            let (_home, engine) = provider.engine().await;
            let (mut startup, instructions) = engine.build_startup(serde_json::from_value(json!({"_managed_instructions":true})).unwrap()).await.unwrap();
            startup.thread_extension_init.insert(crate::native_agents::Policy {
                roles: Vec::new(), max_depth: 1, inherited_instructions: None,
                allowed: Default::default(),
            });
            let parent = engine.start_prepared(startup, instructions, None).await.unwrap();
            let parent_state = parent.current().unwrap();
            let carrier = codex_protocol::protocol::W3cTraceContext {
                traceparent: Some(format!("00-11111111111111111111111111111111-2222222222222222-{flags}")),
                tracestate: Some("tenant=raw-child".into()),
            };
            let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id: parent_state.id, depth: 1,
                agent_path: Some(codex_protocol::AgentPath::root().join("raw_child").unwrap()),
                agent_nickname: None, agent_role: None,
            });
            let options = serde_json::from_value(json!({"session_source":source,"thread_source":ThreadSource::Subagent})).unwrap();
            let (startup, _) = engine.build_startup(options).await.unwrap();
            let child = engine.manager.start_thread(startup)
                .with_context(codex_otel::context_from_w3c_trace_context(&carrier).unwrap())
                .await.unwrap();
            let child_id = child.thread_id;
            {
                let mut events = parent_state.events.lock().await;
                parent_state.discover_children(&mut events).await.unwrap();
            }
            let (instance, _, _) = crate::subagents::instance(&parent_state, child_id).await.unwrap().unwrap();
            let store = engine.store.as_any().downcast_ref::<crate::storage::MemoryThreadStore>().unwrap();
            let traces = Arc::new(std::sync::Mutex::new(Vec::new()));
            *store.flush_traces.lock().unwrap() = Some(traces.clone());
            let hold = Arc::new(CompletionHold {
                parent: child_id, entered: Semaphore::new(0), release: Semaphore::new(0),
            });
            *store.completion_flush_hold.lock().unwrap() = Some(hold.clone());
            let mut initial = request("initial child input");
            initial.trace = child.thread.thread_extension_data()
                .get::<crate::native_interception::Control>().unwrap().creation_trace().unwrap();
            initial.start.final_output_json_schema = Some(json!({
                "type":"object", "properties":{"answer":{"type":"string"}},
                "required":["answer"], "additionalProperties":false,
            }));
            let seed = Arc::new(crate::turn_settlement::Seed::default());
            let mut init = child.thread.config_snapshot().await.turn_extension_init;
            init.insert(seed.clone());
            let StartIfIdleSubmission::Started { turn_id } = child.thread.start_turn_if_idle(
                codex_core_api::WithTurnExtensionData::new(initial, init)
            ).await.unwrap() else { panic!("initial child was not admitted"); };
            seed.confirm(&turn_id);
            let original = loop {
                if let Some((_, _, Some(turn))) = crate::subagents::instance(&parent_state, child_id).await.unwrap()
                    && turn.turn_id == turn_id {
                    break turn;
                }
                parent_state.next_session_event().await.unwrap();
            };
            hold.entered.acquire().await.unwrap().forget();
            assert_eq!(provider.child_requests(child_id), 1);
            let unrelated: Value = serde_json::from_str(&codex_otel::sdk_trace::start_trace_span(
                r#"{"name":"unrelated","kind":"workflow","trace_id":"33333333333333333333333333333333","include_sensitive_data":true}"#
            ).unwrap()).unwrap();
            let handle = unrelated["handle"].as_str().unwrap();
            let context = codex_otel::sdk_trace::context(handle).unwrap();
            let steered = crate::subagents::submit(&parent_state, child_id, instance,
                json!({"input":[{"type":"text","text":"RAW_RETAINED_AFTER_LAST_SAMPLE"}]}))
                .with_context(context.clone()).await.unwrap();
            assert!(Arc::ptr_eq(&original, &steered));
            assert_eq!(provider.child_requests(child_id), 1);
            hold.release.add_permits(1);
            loop {
                let event = parent_state.next_session_event().await.unwrap();
                if event["subagent_id"] == child_id.to_string()
                    && matches!(event["msg"]["type"].as_str(), Some("task_complete" | "turn_complete")) {
                    break;
                }
            }
            original.wait_with_usage().await.unwrap();
            assert_eq!(child.thread.thread_extension_data().get::<Settlement>().unwrap().observe().receipt.unwrap().unsampled_steering(), Some(true));
            let successor = crate::subagents::continue_retained(&parent_state, &original)
                .with_context(context).await.unwrap().expect("real retained child successor");
            assert_ne!(successor.turn_id, original.turn_id);
            loop {
                let event = parent_state.next_session_event().await.unwrap();
                if event["subagent_id"] == child_id.to_string()
                    && event["msg"]["turn_id"] == successor.turn_id
                    && matches!(event["msg"]["type"].as_str(), Some("task_complete" | "turn_complete")) {
                    break;
                }
            }
            successor.wait_with_usage().await.unwrap();
            assert_eq!(provider.child_requests(child_id), 2);
            {
            let requests = provider.requests.lock().unwrap();
            let requests: Vec<_> = requests.iter().filter(|request| {
                let metadata: Value = serde_json::from_str(request["client_metadata"]["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
                metadata["thread_id"] == child_id.to_string()
            }).collect();
            assert!(!requests[0]["input"].to_string().contains("RAW_RETAINED_AFTER_LAST_SAMPLE"));
            assert!(requests[1]["input"].to_string().contains("RAW_RETAINED_AFTER_LAST_SAMPLE"));
            }
            {
            let observed = traces.lock().unwrap();
            let observed: Vec<_> = observed.iter().filter(|(id, _)| *id == child_id).collect();
            assert!(observed.len() >= 2);
            let last = &observed.last().unwrap().1;
            assert_eq!(&last.traceparent.as_deref().unwrap()[3..35], "11111111111111111111111111111111", "retained successor completion");
            for (_, trace) in observed {
                assert_eq!(&trace.traceparent.as_deref().unwrap()[3..35], "11111111111111111111111111111111");
                assert!(trace.traceparent.as_deref().unwrap().ends_with(&format!("-{flags}")));
                assert_eq!(trace.tracestate, carrier.tracestate);
            }
            }
            codex_otel::sdk_trace::end_trace_span(handle, r#"{"status":"ok"}"#).unwrap();
            codex_otel::sdk_trace::release_trace_span(handle);
            parent_state.close().await.unwrap();
            engine.close().await.unwrap();
        }
    }).await.expect("raw child retained continuation must settle");
}

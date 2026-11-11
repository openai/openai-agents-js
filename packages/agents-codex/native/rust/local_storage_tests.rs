//! JSON entrypoint proof through the real Core runtime and scripted HTTP model.
use crate::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response, body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};

pub(crate) struct Provider {
    url: String,
    pub(crate) requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}
impl Provider {
    pub(crate) async fn start() -> Self {
        Self::start_with_hold(None).await
    }
    pub(crate) async fn start_with_hold(
        hold: Option<(
            usize,
            Arc<tokio::sync::Semaphore>,
            Arc<tokio::sync::Semaphore>,
        )>,
    ) -> Self {
        Self::start_scripted(hold, None).await
    }
    pub(crate) async fn start_with_items(items: Vec<Value>) -> Self {
        Self::start_scripted(None, Some(Arc::new(items))).await
    }
    async fn start_scripted(
        hold: Option<(
            usize,
            Arc<tokio::sync::Semaphore>,
            Arc<tokio::sync::Semaphore>,
        )>,
        items: Option<Arc<Vec<Value>>>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let received = requests.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let received = received.clone();
                let hold = hold.clone();
                let items = items.clone();
                connections.spawn(async move {
                    let service = service_fn(move |request: Request<Incoming>| {
                        let received = received.clone();
                        let hold = hold.clone();
                        let items = items.clone();
                        async move {
                            assert!(request.uri().path().ends_with("/responses"));
                            let raw = request.into_body().collect().await.unwrap().to_bytes();
                            let request: Value = serde_json::from_slice(&raw).unwrap();
                            let ordinal = { let mut requests = received.lock().unwrap(); requests.push(request); requests.len() };
                            if let Some((held, entered, release)) = hold
                                && ordinal == held
                            {
                                entered.add_permits(1);
                                release.acquire().await.unwrap().forget();
                            }
                            let item = if let Some(items) = &items {
                                items.get(ordinal - 1).expect("unexpected scripted model request").clone()
                            } else if ordinal == 1 {
                                json!({"type":"function_call", "id":"fc_original", "name":"lookup", "call_id":"call_original", "arguments":"{\"key\":\"x\"}", "status":"completed"})
                            } else {
                                json!({"type":"message", "id":format!("msg_{ordinal}"), "role":"assistant", "status":"completed", "phase":"final_answer", "content":[{"type":"output_text", "text":"done", "annotations":[]}]})
                            };
                            let id = format!("resp_{ordinal}");
                            let events = [
                                json!({"type":"response.created", "response":{"id":id}}),
                                json!({"type":"response.output_item.done", "item":item}),
                                json!({"type":"response.completed", "response":{"id":id,"output":[item],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}),
                            ];
                            let stream = events.iter().map(|event| format!("data: {event}\n\n")).collect::<String>();
                            Ok::<_, Infallible>(Response::builder().header("content-type", "text/event-stream").body(Full::new(Bytes::from(stream))).unwrap())
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
    pub(crate) fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
    pub(crate) fn config(&self) -> Value {
        json!({"model":"gpt-5.1-codex", "model_provider":"local-fixture",
            "model_providers.local-fixture":{"name":"Local storage fixture", "base_url":self.url,
                "wire_api":"responses", "requires_openai_auth":false,"supports_websockets":false,
                "request_max_retries":0,"stream_max_retries":0,"stream_idle_timeout_ms":5000},
            "approval_policy":"never", "sandbox_mode":"danger-full-access", "web_search":"disabled",
            "agents.enabled":false, "tools.update_plan.enabled":false, "features.code_mode":false, "features.goals":false,
            "features.shell_snapshot":false,"features.apps":false,"features.plugins":false,"features.tool_registry.error_on_tool_collisions":true,"analytics.enabled":false})
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn runtime(home: &std::path::Path, storage: &std::path::Path) -> Value {
    json!({"codex_home":home,"cwd":home,"native_thread_store":storage})
}
pub(crate) fn options(resume: Option<&str>) -> String {
    let mut options = json!({"_managed_instructions":true,"instructions":"Keep this accepted application instruction.","tool_policy":{"allowed_tools":[{"name":"lookup"}]}});
    if let Some(id) = resume {
        options["_sdk_resume_thread_id"] = json!(id);
    }
    options.to_string()
}
pub(crate) fn specs() -> String {
    json!([{"type":"function","name":"lookup","description":"Look up a key", "inputSchema":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"],"additionalProperties":false}}]).to_string()
}
async fn submit(native: &NativeThread, text: &str) {
    let started: Value = serde_json::from_str(
        &native
            ._submit(
                json!({"mode":"start_if_idle","input":[{"type":"text","text":text}]}).to_string(),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(started["status"], "started");
}
async fn terminal(native: &NativeThread) {
    loop {
        let event: Value =
            serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
        match event["msg"]["type"].as_str() {
            Some("task_complete" | "turn_complete") => return,
            Some("error" | "turn_aborted") => panic!("unexpected native failure: {event}"),
            _ => {}
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_json_create_tool_receipt_close_and_reopen() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let provider = Provider::start().await;
        let profile = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let engine = create_engine(provider.config().to_string(), runtime(work.path(), profile.path()).to_string(), None, None).await.unwrap();
        let native = engine.start_replaceable_thread(options(None), specs()).await.unwrap();
        let id = native.id();
        let created = engine.current().unwrap().read_stored_thread(codex_protocol::ThreadId::from_string(&id).unwrap()).await.unwrap().created_at;
        assert!(native.rollout_path().is_some());
        native._configure_manual_tools("[{\"name\":\"lookup\"}]".into(), None).unwrap();
        submit(&native, "first durable user message").await;
        let request = loop {
            let event: Value = serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
            if event["msg"]["type"] == "dynamic_tool_call_request" { break event["msg"].clone(); }
            assert_ne!(event["msg"]["type"], "error", "{event}");
        };
        assert!(request["_sdk_python_tool"]["manual_grant"].is_string());
        assert!(native._respond_python_tool(json!({"request":request,"response":{"contentItems":[{"type":"inputText","text":"unique committed lookup result"}],"success":true}}).to_string(), None).await.unwrap());
        terminal(&native).await;
        let owned = native.current().unwrap();
        let history = owned.engine.local_checklist_store.as_ref().unwrap().load_owned_history(owned.id).await.unwrap();
        assert_eq!(history.iter().filter(|row| matches!(row, codex_history::RolloutItem::ResponseItem(envelope) if matches!(envelope.item, codex_protocol::models::ResponseItem::FunctionCallOutput { .. }))).count(), 1);
        drop(owned);
        assert!(engine.start_replaceable_thread(options(Some(&id)), specs()).await.is_err());
        native.close().await.unwrap();
        assert!(engine.start_replaceable_thread(options(Some(&id)), specs()).await.is_err());
        assert_eq!(engine.current().unwrap().read_stored_thread(codex_protocol::ThreadId::from_string(&id).unwrap()).await.unwrap().created_at, created);
        engine.close().await.unwrap();
        let fresh_work = tempfile::tempdir().unwrap();
        let second = create_engine(provider.config().to_string(), runtime(fresh_work.path(), profile.path()).to_string(), None, None).await.unwrap();
        let reopened = second.start_replaceable_thread(options(Some(&id)), specs()).await.unwrap();
        assert_eq!(reopened.id(), id);
        let owned = reopened.current().unwrap();
        assert_eq!(owned.engine.read_stored_thread(owned.id).await.unwrap().created_at, created);
        assert_eq!(owned.instructions.text().unwrap().as_deref(), Some("Keep this accepted application instruction."));
        drop(owned);
        submit(&reopened, "next durable user message").await;
        terminal(&reopened).await;
        let requests = provider.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 3);
        let final_context = requests[2]["input"].to_string();
        assert!(final_context.contains("first durable user message"), "{final_context}");
        assert_eq!(final_context.matches("unique committed lookup result").count(), 1);
        reopened.close().await.unwrap(); second.close().await.unwrap();
    }).await.expect("local storage JSON lifecycle timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_json_close_preserves_unknown_effect_and_refuses_reopen() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let provider = Provider::start().await;
        let profile = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let engine = create_engine(
            provider.config().to_string(),
            runtime(work.path(), profile.path()).to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        let native = engine
            .start_replaceable_thread(options(None), specs())
            .await
            .unwrap();
        let id = native.id();
        submit(&native, "execute once").await;
        loop {
            let event: Value =
                serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
            if event["msg"]["type"] == "dynamic_tool_call_request" {
                break;
            }
            assert_ne!(event["msg"]["type"], "error", "{event}");
        }
        // Dispatch reached the application; no result certifies its effect.
        native.close().await.unwrap();
        engine.close().await.unwrap();
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
        let second = create_engine(
            provider.config().to_string(),
            runtime(work.path(), profile.path()).to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        let failure = second
            .start_replaceable_thread(options(Some(&id)), specs())
            .await
            .err()
            .expect("unknown effect must refuse reopen");
        assert!(
            failure.reason.contains("unknown tool effects"),
            "{}",
            failure.reason
        );
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
        second.close().await.unwrap();
    })
    .await
    .expect("unknown effect shutdown timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_json_rejects_unsupported_authority_and_keeps_checkpoints_in_memory() {
    let provider = Provider::start().await;
    let profile = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut ephemeral = runtime(work.path(), profile.path());
    ephemeral["ephemeral"] = json!(true);
    let error = create_engine(
        provider.config().to_string(),
        ephemeral.to_string(),
        None,
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(error.reason.contains("persistent"), "{}", error.reason);
    let mut conflicting = runtime(work.path(), profile.path());
    conflicting["native_goal_store"] = json!(work.path());
    let error = create_engine(
        provider.config().to_string(),
        conflicting.to_string(),
        None,
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(error.reason.contains("must agree"), "{}", error.reason);
    let mut agents = provider.config();
    agents["agents.enabled"] = json!(true);
    let error = create_engine(
        agents.to_string(),
        runtime(work.path(), profile.path()).to_string(),
        None,
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(
        error
            .reason
            .contains("current NativeAgents and no Code Mode"),
        "{}",
        error.reason
    );
    let portable = create_checkpoint_engine(
        provider.config().to_string(),
        runtime(work.path(), profile.path()).to_string(),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(
        portable
            .current()
            .unwrap()
            .store
            .as_any()
            .is::<crate::storage::MemoryThreadStore>()
    );
    assert!(
        portable
            .start_replaceable_thread(
                options(Some(&codex_protocol::ThreadId::new().to_string())),
                specs()
            )
            .await
            .is_err()
    );
    portable.close().await.unwrap();
    assert_eq!(provider.requests.lock().unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_json_failed_flush_never_acknowledges_a_tool_result() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let provider = Provider::start().await;
        let profile = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let engine = create_engine(provider.config().to_string(), runtime(work.path(), profile.path()).to_string(), None, None).await.unwrap();
        let native = engine.start_replaceable_thread(options(None), specs()).await.unwrap();
        let id = native.id();
        let owned = native.current().unwrap();
        submit(&native, "execute effect once").await;
        let request = loop {
            let event: Value = serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
            if event["msg"]["type"] == "dynamic_tool_call_request" { break event["msg"].clone(); }
            assert_ne!(event["msg"]["type"], "error", "{event}");
        };
        let local = engine.current().unwrap().local_checklist_store.as_ref().unwrap().clone();
        local.fail_receipt_flush.store(true, std::sync::atomic::Ordering::SeqCst);
        let failure = native._respond_python_tool(json!({"request":request,"response":{"contentItems":[{"type":"inputText","text":"real effect result"}],"success":true}}).to_string(), None).await.unwrap_err();
        assert!(failure.reason.contains("injected receipt flush failure"), "{}", failure.reason);
        let close = native.close().await.unwrap_err();
        assert!(close.reason.contains("injected receipt flush failure"), "{}", close.reason);
        // Compatibility close reports failure only after releasing the addon slot/readers.
        assert!(native.live().unwrap().is_none());
        assert!(native.inner.lock().unwrap().interception_reader.is_cancelled());
        assert!(native.inner.lock().unwrap().mcp_result_reader.is_cancelled());
        assert!(owned.close_report().await.unwrap().unwrap().contains("injected receipt flush failure"));
        assert!(owned.engine.manager.get_thread(owned.id).await.is_err());
        assert!(matches!(owned.thread.agent_status().await,
            codex_protocol::protocol::AgentStatus::Shutdown | codex_protocol::protocol::AgentStatus::NotFound));
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
        assert!(engine.close().await.is_err());
        assert!(engine.current().is_err());
        assert!(engine.inner.lock().unwrap().live.is_none());
        drop(owned);
        // A separate engine reacquires the OS writer after joined shutdown.
        // Its audit contains only the real application output, which the native
        // shutdown flush can preserve even though acknowledgement failed.
        let next = create_engine(provider.config().to_string(), runtime(work.path(), profile.path()).to_string(), None, None).await.unwrap();
        let reopened = next.start_replaceable_thread(options(Some(&id)), specs()).await.unwrap();
        let fresh = reopened.current().unwrap();
        let history = fresh.engine.local_checklist_store.as_ref().unwrap().load_owned_history(fresh.id).await.unwrap();
        let outputs = history.iter().filter_map(|row| match row {
            codex_history::RolloutItem::ResponseItem(envelope) if matches!(envelope.item, codex_protocol::models::ResponseItem::FunctionCallOutput { .. }) => Some(serde_json::to_value(&envelope.item).unwrap()),
            _ => None,
        }).collect::<Vec<_>>();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["output"], "real effect result");
        assert_eq!(outputs[0]["call_id"], "call_original");
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
        drop(fresh);
        reopened.close().await.unwrap(); next.close().await.unwrap();
    }).await.expect("failed receipt shutdown timed out");
}

fn no_peer_acquired(peer: &std::net::TcpListener, marker: &std::path::Path) {
    match peer.accept() {
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
        other => panic!("unsupported native peer was acquired: {other:?}"),
    }
    assert!(!marker.exists(), "unsupported MCP process was started");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_creation_rejects_native_authority_before_peer_or_process_acquisition() {
    let provider = Provider::start().await;
    let profile = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let peer = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    peer.set_nonblocking(true).unwrap();
    let url = format!("http://{}", peer.local_addr().unwrap());
    let marker = work.path().join("unexpected-process");
    let rosters = [
        json!({"peer":{"url":url,"enabled":true}}),
        json!({"process":{"command":"/bin/sh","args":["-c","touch \"$1\"","storage-test",marker],"enabled":true}}),
    ];
    for roster in rosters {
        let mut config = provider.config();
        config["mcp_servers"] = roster;
        let failure = create_engine(
            config.to_string(),
            runtime(work.path(), profile.path()).to_string(),
            None,
            None,
        )
        .await
        .err()
        .unwrap();
        assert!(
            failure.reason.contains("native MCP servers"),
            "{}",
            failure.reason
        );
        no_peer_acquired(&peer, &marker);
    }
    for feature in ["features.apps", "features.plugins"] {
        let mut config = provider.config();
        config[feature] = json!(true);
        let failure = create_engine(
            config.to_string(),
            runtime(work.path(), profile.path()).to_string(),
            None,
            None,
        )
        .await
        .err()
        .unwrap();
        assert!(
            failure.reason.contains("Apps and plugin discovery"),
            "{}",
            failure.reason
        );
        no_peer_acquired(&peer, &marker);
    }
    let mut hosted_web = provider.config();
    hosted_web["web_search"] = json!("live");
    let hosted_engine = create_engine(
        hosted_web.to_string(),
        runtime(work.path(), profile.path()).to_string(),
        None,
        None,
    )
    .await
    .unwrap();
    let started = hosted_engine
        .start_replaceable_thread(options(None), specs())
        .await;
    let published_threads = hosted_engine
        .current()
        .unwrap()
        .manager
        .list_thread_ids()
        .await;
    let close_thread = match &started {
        Ok(native) => native.close().await,
        Err(_) => Ok(()),
    };
    let close_engine = hosted_engine.close().await;
    close_thread.unwrap();
    close_engine.unwrap();
    let failure = started
        .err()
        .expect("local hosted web authority requires the current managed policy");
    assert!(
        failure
            .reason
            .contains("WebSearch is excluded by the current ToolPolicy"),
        "{}",
        failure.reason
    );
    assert!(published_threads.is_empty());
    no_peer_acquired(&peer, &marker);
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_creation_admits_remote_environment_and_reports_connection_failure() {
    let provider = Provider::start().await;
    let profile = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let peer = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    peer.set_nonblocking(true).unwrap();
    let mut remote = runtime(work.path(), profile.path());
    remote["environment"] = json!({
        "url": format!("ws://{}", peer.local_addr().unwrap()),
        "cwd": format!("file://{}", work.path().display()),
        "connect_timeout": 0.05
    });
    let failure = tokio::time::timeout(
        Duration::from_secs(5),
        create_engine(
            provider.config().to_string(),
            remote.to_string(),
            None,
            None,
        ),
    )
    .await
    .expect("remote executor connection did not settle")
    .err()
    .expect("a peer that never completes its WebSocket handshake cannot become ready");
    let (stream, _) = peer
        .accept()
        .expect("the admitted executor must reach its configured peer");
    drop(stream);
    assert!(
        failure
            .reason
            .contains("remote executor failed to become ready: WebSocket connection timed out"),
        "{}",
        failure.reason
    );
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_start_and_mutation_reject_unsupported_authority_before_native_publication() {
    let provider = Provider::start().await;
    let profile = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let peer = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    peer.set_nonblocking(true).unwrap();
    let url = format!("http://{}", peer.local_addr().unwrap());
    let marker = work.path().join("unexpected-process");
    let engine = create_engine(
        provider.config().to_string(),
        runtime(work.path(), profile.path()).to_string(),
        None,
        None,
    )
    .await
    .unwrap();
    for (extra, expected) in [
        (
            json!({"config":{"mcp_servers":{"peer":{"url":url}}}}),
            "native MCP servers",
        ),
        (
            json!({"config":{"features.apps":true}}),
            "Apps and plugin discovery",
        ),
        (
            json!({"config":{"features.plugins":true}}),
            "Apps and plugin discovery",
        ),
        (
            json!({"config":{"web_search":"live"}}),
            "WebSearch is excluded by the current ToolPolicy",
        ),
        (
            json!({"client_mcp_extensions":{"unsupported":{}}}),
            "client MCP extensions",
        ),
    ] {
        let mut requested: Value = serde_json::from_str(&options(None)).unwrap();
        requested
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let failure = engine
            .start_replaceable_thread(requested.to_string(), specs())
            .await
            .err()
            .unwrap();
        assert!(failure.reason.contains(expected), "{}", failure.reason);
        assert!(
            engine
                .current()
                .unwrap()
                .manager
                .list_thread_ids()
                .await
                .is_empty()
        );
        no_peer_acquired(&peer, &marker);
    }
    // This model-only engine has no registered executor. Raw thread input
    // cannot register one; Core filters selections for unknown environment IDs.
    let environment_manager = engine.current().unwrap().manager.environment_manager();
    assert!(environment_manager.get_environment("local").is_none());
    let mut local_options: Value = serde_json::from_str(&options(None)).unwrap();
    local_options["environments"] = json!([{
        "environment_id": "local",
        "cwd": format!("file://{}", work.path().display())
    }]);
    let local = engine
        .start_replaceable_thread(local_options.to_string(), specs())
        .await
        .unwrap();
    let selected = local
        .current()
        .unwrap()
        .thread
        .config_snapshot()
        .await
        .environments;
    assert!(
        selected.environments.is_empty(),
        "unregistered thread input must not grant an executor"
    );
    assert!(environment_manager.get_environment("local").is_none());
    drop(environment_manager);
    local.close().await.unwrap();
    assert!(
        engine
            .current()
            .unwrap()
            .manager
            .list_thread_ids()
            .await
            .is_empty()
    );
    no_peer_acquired(&peer, &marker);
    assert!(provider.requests.lock().unwrap().is_empty());
    let native = engine
        .start_replaceable_thread(options(None), specs())
        .await
        .unwrap();
    assert!(
        native
            .current()
            .unwrap()
            .thread
            .config_snapshot()
            .await
            .environments
            .environments
            .is_empty()
    );
    let failure = native
        ._replace_mcp_servers(
            json!({"peer":{"url":url}}).to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(
        failure.reason.contains("MCP roster replacement"),
        "{}",
        failure.reason
    );
    let failure = native._submit(json!({"input":[],"settings":{"environments":{"legacy_fallback_cwd":work.path(),"environments":[{"environment_id":"local","cwd":format!("file://{}",work.path().display())}]}}}).to_string()).await.unwrap_err();
    assert!(
        failure
            .reason
            .contains("native executor overrides cannot replace trusted environment policy"),
        "{}",
        failure.reason
    );
    assert!(
        native
            .current()
            .unwrap()
            .thread
            .config_snapshot()
            .await
            .environments
            .environments
            .is_empty()
    );
    let failure = native
        ._update_model_settings(json!({"environments":[]}).to_string())
        .await
        .unwrap_err();
    assert!(failure.reason.contains("unsupported model setting"));
    native.close().await.unwrap();
    engine.close().await.unwrap();
    no_peer_acquired(&peer, &marker);
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_requires_managed_policy_and_preserves_admitted_replacements() {
    let provider = Provider::start().await;
    let profile = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let engine = create_engine(
        provider.config().to_string(),
        runtime(work.path(), profile.path()).to_string(),
        None,
        None,
    )
    .await
    .unwrap();
    for (policy, expected) in [
        (Value::Null, "explicit managed ToolPolicy"),
        (
            json!({"allowed_tools":[{"name":"lookup"},{"namespace":"image_gen","name":"imagegen"}]}),
            "only allow admitted managed tools",
        ),
    ] {
        let failure = engine
            .start_replaceable_thread(json!({"tool_policy":policy}).to_string(), specs())
            .await
            .err()
            .unwrap();
        assert!(failure.reason.contains(expected), "{}", failure.reason);
        assert!(
            engine
                .current()
                .unwrap()
                .manager
                .list_thread_ids()
                .await
                .is_empty()
        );
    }
    let native = engine
        .start_replaceable_thread(options(None), specs())
        .await
        .unwrap();
    assert_eq!(
        native
            ._replace_tools("1".into(), specs(), None, None, None)
            .await
            .unwrap(),
        "1"
    );
    let mut renamed: Value = serde_json::from_str(&specs()).unwrap();
    renamed[0]["name"] = json!("outside_opening_ceiling");
    assert!(
        native
            ._replace_tools("2".into(), renamed.to_string(), None, None, None)
            .await
            .unwrap_err()
            .reason
            .contains("excluded by ToolPolicy")
    );
    assert_eq!(
        native
            ._replace_tools("2".into(), specs(), None, None, None)
            .await
            .unwrap(),
        "2"
    );
    native.close().await.unwrap();
    engine.close().await.unwrap();
    // Memory mode retains an unrestricted opening policy and replacement names.
    let mut memory_runtime = runtime(work.path(), profile.path());
    memory_runtime
        .as_object_mut()
        .unwrap()
        .remove("native_thread_store");
    let mut config = provider.config();
    config["features.apps"] = json!(true);
    config["features.plugins"] = json!(true);
    let memory = create_engine(config.to_string(), memory_runtime.to_string(), None, None)
        .await
        .unwrap();
    let native = memory
        .start_replaceable_thread("{}".into(), specs())
        .await
        .unwrap();
    assert_eq!(
        native
            ._replace_tools("1".into(), renamed.to_string(), None, None, None)
            .await
            .unwrap(),
        "1"
    );
    native.close().await.unwrap();
    memory.close().await.unwrap();
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_existing_policy_excludes_other_native_contributors() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let provider = Provider::start().await;
        let profile = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let mut config = provider.config();
        // This provider qualifies native image generation, while stable
        // environment tools can be advertised even without a selected executor.
        config["model_providers.local-fixture"]["requires_openai_auth"] = json!(true);
        config["features.stable_environment_tools"] = json!(true);
        let engine = create_engine(
            config.to_string(),
            runtime(work.path(), profile.path()).to_string(),
            Some("local-storage-fixture-key".into()),
            None,
        )
        .await
        .unwrap();
        let native = engine
            .start_replaceable_thread(options(None), specs())
            .await
            .unwrap();
        submit(&native, "use only the admitted managed tool").await;
        loop {
            let event: Value =
                serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
            if event["msg"]["type"] == "dynamic_tool_call_request" {
                break;
            }
            assert_ne!(event["msg"]["type"], "error", "{event}");
        }
        let requests = provider.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        let tools = requests[0]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1, "{tools:?}");
        assert_eq!(tools[0]["name"], "lookup");
        native.close().await.unwrap();
        engine.close().await.unwrap();
    })
    .await
    .expect("managed policy qualification timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_requires_collision_errors_before_native_or_managed_dispatch() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let provider = Provider::start().await;
        let profile = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let mut config = provider.config();
        config["features.token_budget"] = json!(true);
        config["features.tool_registry.error_on_tool_collisions"] = json!(false);
        let failure = create_engine(
            config.to_string(),
            runtime(work.path(), profile.path()).to_string(),
            None,
            None,
        )
        .await
        .err()
        .expect("local native tool collisions must not be ignored");
        assert!(
            failure.reason.contains("error_on_tool_collisions"),
            "{}",
            failure.reason
        );
        assert!(provider.requests.lock().unwrap().is_empty());
        config["features.tool_registry.error_on_tool_collisions"] = json!(true);
        let engine = create_engine(
            config.to_string(),
            runtime(work.path(), profile.path()).to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        let failure = engine
            .start_replaceable_thread(
                json!({"config":{"features.tool_registry.error_on_tool_collisions":false}})
                    .to_string(),
                specs(),
            )
            .await
            .err()
            .expect("startup cannot disable collision rejection");
        assert!(
            failure.reason.contains("error_on_tool_collisions"),
            "{}",
            failure.reason
        );
        assert!(
            engine
                .current()
                .unwrap()
                .manager
                .list_thread_ids()
                .await
                .is_empty()
        );
        let mut colliding: Value = serde_json::from_str(&specs()).unwrap();
        colliding[0]["name"] = json!("new_context");
        let native = engine
            .start_replaceable_thread(
                json!({"tool_policy":{"allowed_tools":[{"name":"new_context"}]}}).to_string(),
                colliding.to_string(),
            )
            .await
            .unwrap();
        submit(
            &native,
            "this must fail before either new_context handler can run",
        )
        .await;
        let error = loop {
            let event: Value =
                serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
            assert_ne!(
                event["msg"]["type"], "dynamic_tool_call_request",
                "managed executor was dispatched: {event}"
            );
            if event["msg"]["type"] == "error" {
                break event;
            }
            assert!(
                !matches!(
                    event["msg"]["type"].as_str(),
                    Some("task_complete" | "turn_complete")
                ),
                "collision was accepted: {event}"
            );
        };
        assert!(
            error["msg"]["message"]
                .as_str()
                .unwrap()
                .contains("duplicate tool: functions.new_context"),
            "{error}"
        );
        assert!(provider.requests.lock().unwrap().is_empty());
        let owned = native.current().unwrap();
        let history = owned
            .engine
            .local_checklist_store
            .as_ref()
            .unwrap()
            .load_owned_history(owned.id)
            .await
            .unwrap();
        assert!(!history.iter().any(|row| matches!(
            row,
            codex_history::RolloutItem::Compacted(_)
                | codex_history::RolloutItem::ResponseItem(codex_history::ResponseItemEnvelope {
                    item: codex_protocol::models::ResponseItem::FunctionCall { .. }
                        | codex_protocol::models::ResponseItem::FunctionCallOutput { .. },
                    ..
                })
        )));
        drop(owned);
        native.close().await.unwrap();
        engine.close().await.unwrap();
        // The new requirement applies only to the local storage owner.
        let mut memory_runtime = runtime(work.path(), profile.path());
        memory_runtime
            .as_object_mut()
            .unwrap()
            .remove("native_thread_store");
        config["features.tool_registry.error_on_tool_collisions"] = json!(false);
        let memory = create_engine(config.to_string(), memory_runtime.to_string(), None, None)
            .await
            .unwrap();
        let native = memory
            .start_replaceable_thread("{}".into(), colliding.to_string())
            .await
            .unwrap();
        assert!(
            !native
                .current()
                .unwrap()
                .thread
                .config()
                .await
                .tool_registry
                .error_on_tool_collisions
        );
        native.close().await.unwrap();
        memory.close().await.unwrap();
        assert!(provider.requests.lock().unwrap().is_empty());
    })
    .await
    .expect("native collision validation timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_close_report_completed_error_releases_owners() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let provider = Provider::start().await;
        let profile = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let engine = create_engine(provider.config().to_string(), runtime(work.path(), profile.path()).to_string(), None, None).await.unwrap();
        let native = engine.start_replaceable_thread(options(None), specs()).await.unwrap();
        let owned = native.current().unwrap();
        submit(&native, "effect with failed persistence acknowledgement").await;
        let request = loop {
            let event: Value = serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
            if event["msg"]["type"] == "dynamic_tool_call_request" { break event["msg"].clone(); }
            assert_ne!(event["msg"]["type"], "error", "{event}");
        };
        let local = owned.engine.local_checklist_store.as_ref().unwrap().clone();
        local.fail_receipt_flush.store(true, std::sync::atomic::Ordering::SeqCst);
        native._respond_python_tool(json!({"request":request,"response":{"contentItems":[{"type":"inputText","text":"real result"}],"success":true}}).to_string(), None).await.unwrap_err();
        let diagnostic = native._close_report().await.unwrap().unwrap();
        assert!(diagnostic.contains("injected receipt flush failure"));
        assert!(native.live().unwrap().is_none());
        assert!(native.inner.lock().unwrap().interception_reader.is_cancelled());
        assert!(native.inner.lock().unwrap().mcp_result_reader.is_cancelled());
        assert!(owned.engine.manager.get_thread(owned.id).await.is_err());
        assert!(local.check_failure(Some(owned.id)).await.is_err());
        assert!(owned.close().await.is_err());
        assert!(native._close_report().await.unwrap().is_none());
        let engine_diagnostic = engine._close_report().await.unwrap().unwrap();
        assert_eq!(diagnostic, engine_diagnostic);
        assert!(engine.current().is_err());
        assert!(engine.inner.lock().unwrap().live.is_none());
        assert!(engine.close().await.is_err());
        assert_eq!(engine._close_report().await.unwrap(), Some(engine_diagnostic));
        assert!(profile.path().read_dir().unwrap().next().is_some());
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
    }).await.expect("completed diagnostic cleanup timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_close_report_cancelled_thread_retains_live_owner() {
    let provider = Provider::start().await;
    let profile = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let engine = create_engine(
        provider.config().to_string(),
        runtime(work.path(), profile.path()).to_string(),
        None,
        None,
    )
    .await
    .unwrap();
    let native = engine
        .start_replaceable_thread(options(None), specs())
        .await
        .unwrap();
    let owned = native.current().unwrap();
    let mutation = owned.mutations.lock().await;
    let mut close = Box::pin(native._close_report());
    assert!(futures_util::poll!(close.as_mut()).is_pending());
    assert!(native.live().unwrap().is_some());
    assert!(
        !native
            .inner
            .lock()
            .unwrap()
            .interception_reader
            .is_cancelled()
    );
    drop(close);
    assert!(native.live().unwrap().is_some());
    drop(mutation);
    assert!(native._close_report().await.unwrap().is_none());
    assert!(native.live().unwrap().is_none());
    drop(owned);
    assert!(engine._close_report().await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_close_report_remote_drain_retains_diagnostic_on_retry() {
    let (sender, receiver) =
        tokio::sync::watch::channel(codex_exec_server::EnvironmentConnectionState::Connected);
    // This is the existing post-release owner shape, not a replacement engine.
    let engine = Engine {
        inner: Arc::new(Mutex::new(EngineOwner {
            live: None,
            remote_drain: Some(receiver),
            close_report: engine::EngineCloseReport {
                diagnostic: Some("original completed persistence failure".to_owned()),
                saved_login_refresh: Some("Saved Codex login refresh failed."),
            },
        })),
        startup_warnings: Vec::new(),
    };
    let timeout = engine._close_report().await.unwrap_err();
    assert!(timeout.reason.contains("environment shutdown timed out"));
    assert!(engine.inner.lock().unwrap().remote_drain.is_some());
    assert_eq!(
        engine
            .inner
            .lock()
            .unwrap()
            .close_report
            .diagnostic
            .as_deref(),
        Some("original completed persistence failure")
    );
    let mut retry = Box::pin(engine._close_report());
    assert!(futures_util::poll!(retry.as_mut()).is_pending());
    drop(retry);
    assert!(engine.inner.lock().unwrap().remote_drain.is_some());
    // A disconnected value alone is not physical drain completion: all senders must drop.
    sender.send_replace(codex_exec_server::EnvironmentConnectionState::Disconnected);
    let mut retry = Box::pin(engine._close_report());
    assert!(futures_util::poll!(retry.as_mut()).is_pending());
    drop(retry);
    drop(sender);
    let diagnostic = engine._close_report_defer_saved_login().await.unwrap();
    assert_eq!(
        diagnostic.as_deref(),
        Some("original completed persistence failure")
    );
    assert!(engine.inner.lock().unwrap().remote_drain.is_none());
    assert_eq!(
        engine._close_report().await.unwrap().as_deref(),
        Some("original completed persistence failure; Saved Codex login refresh failed.")
    );
    assert!(engine.close().await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_local_close_joins_an_already_terminated_root_and_releases_its_owner() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let provider = Provider::start().await;
        let profile = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let engine = create_engine(
            provider.config().to_string(),
            runtime(work.path(), profile.path()).to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        let native = engine
            .start_replaceable_thread(options(None), specs())
            .await
            .unwrap();
        let owned = native.current().unwrap();
        // Stop Core first while retaining the SDK root owner.
        owned.thread.shutdown_and_wait().await.unwrap();
        assert!(native.live().unwrap().is_some());
        assert!(native._close_report().await.unwrap().is_none());
        assert!(native.live().unwrap().is_none());
        assert!(owned.engine.manager.get_thread(owned.id).await.is_err());
        // Explicit close remains inert after releasing its exact root owner.
        assert!(native._close_report().await.unwrap().is_none());
        drop(owned);
        assert!(engine._close_report().await.unwrap().is_none());
        assert!(provider.requests.lock().unwrap().is_empty());
    })
    .await
    .expect("already-terminated root cleanup timed out");
}

//! Actual native compaction admission and existing-owner lifetime controls.
use super::*;
use crate::local_storage_tests::{Provider, options, specs};
use crate::{Engine, NativeThread, create_engine};
use std::time::Duration;

async fn setup() -> (
    Provider,
    tempfile::TempDir,
    tempfile::TempDir,
    Engine,
    NativeThread,
) {
    let provider = Provider::start().await;
    setup_with_provider(provider).await
}

async fn setup_with_provider(
    provider: Provider,
) -> (
    Provider,
    tempfile::TempDir,
    tempfile::TempDir,
    Engine,
    NativeThread,
) {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let mut config = provider.config();
    config["features.goals"] = serde_json::json!(true);
    let runtime = serde_json::json!({"codex_home":home.path(),"cwd":home.path(),
        "native_thread_store":profile.path(),"native_goal_store":profile.path()});
    let engine = create_engine(config.to_string(), runtime.to_string(), None, None)
        .await
        .unwrap();
    let mut policy: serde_json::Value = serde_json::from_str(&options(None)).unwrap();
    for name in ["create_goal", "get_goal", "update_goal"] {
        policy["tool_policy"]["allowed_tools"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"name":name}));
    }
    let native = engine
        .start_replaceable_thread(policy.to_string(), specs())
        .await
        .unwrap();
    (provider, profile, home, engine, native)
}

async fn terminal(native: &NativeThread, turn_id: &str) {
    loop {
        let event: serde_json::Value =
            serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
        match event["msg"]["type"].as_str() {
            Some("task_complete" | "turn_complete") => {
                assert_eq!(event["id"], turn_id, "foreign terminal: {event}");
                assert_eq!(event["msg"]["turn_id"], turn_id, "{event}");
                return;
            }
            Some("error" | "turn_aborted") => panic!("unexpected native failure: {event}"),
            _ => {}
        }
    }
}

async fn start_seed(native: &NativeThread) -> String {
    native
        ._configure_manual_tools("[{\"name\":\"lookup\"}]".into())
        .unwrap();
    let receipt: serde_json::Value = serde_json::from_str(&native._submit(serde_json::json!({"mode":"start_if_idle","input":[{"type":"text","text":"Seed real history"}]}).to_string()).await.unwrap()).unwrap();
    assert_eq!(receipt["status"], "started");
    let turn_id = receipt["turn_id"].as_str().unwrap().to_owned();
    let request = loop {
        let event: serde_json::Value =
            serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
        if event["msg"]["type"] == "dynamic_tool_call_request" {
            break event["msg"].clone();
        }
        assert_ne!(event["msg"]["type"], "error", "{event}");
    };
    native._respond_python_tool(serde_json::json!({"request":request,"response":{"contentItems":[{"type":"inputText","text":"accepted seed"}],"success":true}}).to_string()).await.unwrap();
    turn_id
}

async fn seed(native: &NativeThread) -> String {
    let turn_id = start_seed(native).await;
    terminal(native, &turn_id).await;
    turn_id
}

async fn persistence_diagnostic(native: &NativeThread, turn_id: &str) -> String {
    loop {
        match native.next_session_event().await {
            Err(error) => return error.reason,
            Ok(raw) => {
                let event: serde_json::Value = serde_json::from_str(&raw).unwrap();
                if matches!(
                    event["msg"]["type"].as_str(),
                    Some("error" | "task_complete" | "turn_complete" | "turn_aborted")
                ) {
                    assert_eq!(event["id"], turn_id, "foreign terminal/error: {event}");
                }
                if event["msg"]["type"] == "error" {
                    return raw;
                }
                assert_ne!(event["msg"]["type"], "task_complete", "{event}");
                assert_ne!(event["msg"]["type"], "turn_complete", "{event}");
                assert_ne!(event["msg"]["type"], "turn_aborted", "{event}");
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_retains_engine_thread_goal_service_and_local_writer() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, _profile, _home, engine, native) = setup().await;
        seed(&native).await;
        let before = native.current().unwrap();
        let old_engine = before.engine.clone();
        let old_thread = before.thread.clone();
        let old_store = before
            .engine
            .local_checklist_store
            .as_ref()
            .unwrap()
            .clone();
        let old_service = before.engine.goals.as_ref().unwrap().service.clone();
        let old_state = before.engine.goals.as_ref().unwrap().state_db.clone();
        assert!(Arc::ptr_eq(&old_state, &old_store.state));
        let id = before.id;
        drop(before);
        let receipt: serde_json::Value =
            serde_json::from_str(&native._compact().await.unwrap()).unwrap();
        assert_eq!(receipt["status"], "started");
        assert!(receipt["turn_id"].is_string());
        terminal(&native, receipt["turn_id"].as_str().unwrap()).await;
        let after = native.current().unwrap();
        assert_eq!(after.id, id);
        assert!(Arc::ptr_eq(&old_engine, &after.engine));
        assert!(Arc::ptr_eq(&old_thread, &after.thread));
        assert!(Arc::ptr_eq(
            &old_store,
            after.engine.local_checklist_store.as_ref().unwrap()
        ));
        assert!(Arc::ptr_eq(
            &old_service,
            &after.engine.goals.as_ref().unwrap().service
        ));
        assert!(Arc::ptr_eq(
            &old_state,
            &after.engine.goals.as_ref().unwrap().state_db
        ));
        drop(after);
        native.close().await.unwrap();
        engine.close().await.unwrap();
        assert_eq!(provider.request_count(), 3);
    })
    .await
    .expect("native compact identity control timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_pending_mutation_retains_context_exclusion_until_drop() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let provider = Provider::start().await;
        let home = tempfile::tempdir().unwrap();
        let mut config = provider.config();
        config["features.goals"] = serde_json::json!(false);
        let runtime = serde_json::json!({"codex_home":home.path(),"cwd":home.path()});
        let engine = create_engine(config.to_string(), runtime.to_string(), None, None)
            .await
            .unwrap();
        let native = engine
            .start_replaceable_thread(options(None), specs())
            .await
            .unwrap();
        let owner = native.current().unwrap();
        let memory_without_goals =
            owner.engine.local_checklist_store.is_none() && owner.engine.goals.is_none();
        let mutation = owner.mutations.lock().await;
        let mut compacting = Box::pin(native._compact());
        // Poll through uncontended admission without a cooperative-budget yield.
        let pending =
            futures_util::poll!(tokio::task::unconstrained(compacting.as_mut())).is_pending();
        let writer_excluded = owner.engine.context_gate.clone().try_write_owned().is_err();
        drop(compacting);
        let writer_released = owner.engine.context_gate.clone().try_write_owned().is_ok();
        drop(mutation);
        drop(owner);
        let closed = native.close().await;
        let engine_closed = engine.close().await;

        assert!(closed.is_ok(), "{closed:?}");
        assert!(engine_closed.is_ok(), "{engine_closed:?}");
        assert!(memory_without_goals);
        assert!(pending, "compact did not wait at the held mutation lock");
        assert!(
            writer_excluded,
            "pending compact released context exclusion"
        );
        assert!(
            writer_released,
            "dropping compact retained context exclusion"
        );
        assert_eq!(provider.request_count(), 0);
    })
    .await
    .expect("compact context exclusion control timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn engine_close_before_queued_compact_rejects_without_a_request() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, _profile, _home, engine, native) = setup().await;
        let state = engine.current().unwrap();
        let hold = state.lifecycle.lock().await;
        let mut closing = Box::pin(engine.close());
        tokio::select! { biased;
            result = &mut closing => panic!("close passed lifecycle hold: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        let mut compacting = Box::pin(native._compact());
        tokio::select! { biased;
            result = &mut compacting => panic!("compact passed lifecycle hold: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        drop(hold);
        let (closed, compacted) = tokio::join!(closing, compacting);
        closed.unwrap();
        let error = compacted.unwrap_err();
        assert!(error.reason.contains("closed"), "{}", error.reason);
        assert!(state.closed.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(provider.request_count(), 0);
    })
    .await
    .expect("engine-close admission control timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thread_close_before_queued_compact_rejects_without_a_request() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, _profile, _home, engine, native) = setup().await;
        let owner = native.current().unwrap();
        let mutations = owner.mutations.clone();
        drop(owner);
        let hold = mutations.lock().await;
        let mut closing = Box::pin(native.close());
        tokio::select! { biased;
            result = &mut closing => panic!("close passed mutations hold: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        let mut compacting = Box::pin(native._compact());
        tokio::select! { biased;
            result = &mut compacting => panic!("compact passed mutations hold: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        drop(hold);
        let (closed, compacted) = tokio::join!(closing, compacting);
        closed.unwrap();
        let error = compacted.unwrap_err();
        assert!(error.reason.contains("closed"), "{}", error.reason);
        engine.close().await.unwrap();
        assert_eq!(provider.request_count(), 0);
    })
    .await
    .expect("thread-close admission control timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_health_wait_retains_admission_and_releases_it_before_close() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, _profile, _home, engine, native) = setup().await;
        let state = engine.current().unwrap();
        let store = state.local_checklist_store.as_ref().unwrap();
        let health = store.writers.lock().await;
        let mut compacting = Box::pin(native._compact());
        tokio::select! { biased;
            result = &mut compacting => panic!("compact passed health hold: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(state.lifecycle.try_lock().is_err());
        assert!(native.current().unwrap().mutations.try_lock().is_err());
        let mut closing = Box::pin(native.close());
        tokio::select! { biased;
            result = &mut closing => panic!("close passed admitted compact: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        drop(health);
        let (compacted, closed) = tokio::join!(compacting, closing);
        let receipt: serde_json::Value = serde_json::from_str(&compacted.unwrap()).unwrap();
        assert_eq!(receipt["status"], "started");
        closed.unwrap();
        assert!(state.lifecycle.try_lock().is_ok());
        assert!(store.writers.lock().await.is_empty());
        engine.close().await.unwrap();
        assert!(provider.request_count() <= 1);
    })
    .await
    .expect("compact-first admission control timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_rejects_a_known_sticky_writer_failure_before_model_work() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, _profile, _home, engine, native) = setup().await;
        let owner = native.current().unwrap();
        let store = owner.engine.local_checklist_store.as_ref().unwrap().clone();
        store
            .writers
            .lock()
            .await
            .get_mut(&owner.id)
            .unwrap()
            .failure = Some("injected sticky compact writer failure".into());
        drop(owner);
        let error = native._compact().await.unwrap_err();
        assert!(
            error
                .reason
                .contains("injected sticky compact writer failure"),
            "{}",
            error.reason
        );
        assert_eq!(provider.request_count(), 0);
        assert!(native._close_report().await.unwrap().is_some());
        assert!(engine._close_report().await.unwrap().is_some());
        assert_eq!(provider.request_count(), 0);
    })
    .await
    .expect("sticky compact writer control timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_refuses_a_reserved_native_graph_stop_without_a_request() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, _profile, _home, engine, native) = setup().await;
        let stop = native
            .request_graph_stop("root".into(), "force".into())
            .unwrap();
        let error = native._compact().await.unwrap_err();
        assert!(error.reason.contains("stopping"), "{}", error.reason);
        assert_eq!(provider.request_count(), 0);
        stop.settle().await.unwrap();
        stop.release(true).unwrap();
        native.close().await.unwrap();
        engine.close().await.unwrap();
    })
    .await
    .expect("compact graph-stop refusal control timed out");
}

struct ReleaseResponse(Arc<tokio::sync::Semaphore>);
impl Drop for ReleaseResponse {
    fn drop(&mut self) {
        self.0.add_permits(1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_compact_reports_a_persistence_failure_after_model_activity() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let entered = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let _release_on_failure = ReleaseResponse(release.clone());
        let provider = Provider::start_with_hold(Some((3, entered.clone(), release.clone()))).await;
        let (provider, _profile, _home, engine, native) = setup_with_provider(provider).await;
        let seed_id = seed(&native).await;
        let receipt: serde_json::Value =
            serde_json::from_str(&native._compact().await.unwrap()).unwrap();
        assert_eq!(receipt["status"], "started");
        let turn_id = receipt["turn_id"].as_str().unwrap();
        assert_ne!(turn_id, seed_id);
        entered.acquire().await.unwrap().forget();
        assert_eq!(provider.request_count(), 3);
        let owner = native.current().unwrap();
        assert!(
            owner
                .thread
                .thread_extension_data()
                .get::<crate::turn_settlement::Settlement>()
                .unwrap()
                .admission_ready(turn_id)
                .unwrap()
                .is_some(),
            "held model request must belong to the exact compaction receipt"
        );
        owner
            .engine
            .local_checklist_store
            .as_ref()
            .unwrap()
            .writers
            .lock()
            .await
            .get_mut(&owner.id)
            .unwrap()
            .failure = Some("injected admitted compact persistence failure".into());
        drop(owner);
        release.add_permits(1);
        let diagnostic = persistence_diagnostic(&native, turn_id).await;
        assert!(
            diagnostic.contains("injected admitted compact persistence failure"),
            "{diagnostic}"
        );
        let error = native._read_goal().await.unwrap_err();
        assert!(
            error
                .reason
                .contains("injected admitted compact persistence failure"),
            "{}",
            error.reason
        );
        assert!(native._close_report().await.unwrap().is_some());
        assert!(engine._close_report().await.unwrap().is_some());
        assert_eq!(provider.request_count(), 3);
    })
    .await
    .expect("admitted compact persistence control timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_turn_reports_a_persistence_failure_before_success() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let entered = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let _release_on_failure = ReleaseResponse(release.clone());
        let provider = Provider::start_with_hold(Some((2, entered.clone(), release.clone()))).await;
        let (provider, _profile, _home, engine, native) = setup_with_provider(provider).await;
        let turn_id = start_seed(&native).await;
        entered.acquire().await.unwrap().forget();
        assert_eq!(provider.request_count(), 2);
        let owner = native.current().unwrap();
        assert!(
            owner
                .thread
                .thread_extension_data()
                .get::<crate::turn_settlement::Settlement>()
                .unwrap()
                .admission_ready(&turn_id)
                .unwrap()
                .is_some()
        );
        owner
            .engine
            .local_checklist_store
            .as_ref()
            .unwrap()
            .writers
            .lock()
            .await
            .get_mut(&owner.id)
            .unwrap()
            .failure = Some("injected managed terminal persistence failure".into());
        drop(owner);
        release.add_permits(1);
        let diagnostic = persistence_diagnostic(&native, &turn_id).await;
        assert!(
            diagnostic.contains("injected managed terminal persistence failure"),
            "{diagnostic}"
        );
        let error = native._read_goal().await.unwrap_err();
        assert!(
            error
                .reason
                .contains("injected managed terminal persistence failure"),
            "{}",
            error.reason
        );
        assert!(native._close_report().await.unwrap().is_some());
        assert!(engine._close_report().await.unwrap().is_some());
        assert_eq!(provider.request_count(), 2);
    })
    .await
    .expect("managed terminal persistence control timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_during_terminal_health_wait_rejects_success_and_joins() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, _profile, _home, engine, native) = setup().await;
        let seed_id = seed(&native).await;
        let receipt: serde_json::Value =
            serde_json::from_str(&native._compact().await.unwrap()).unwrap();
        let turn_id = receipt["turn_id"].as_str().unwrap();
        assert_eq!(receipt["status"], "started");
        assert_ne!(turn_id, seed_id);
        loop {
            let event: serde_json::Value =
                serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
            assert!(
                !matches!(
                    event["msg"]["type"].as_str(),
                    Some("error" | "turn_aborted" | "task_complete" | "turn_complete")
                ),
                "{event}"
            );
            if matches!(
                event["msg"]["type"].as_str(),
                Some("task_started" | "turn_started")
            ) {
                assert_eq!(event["id"], turn_id, "{event}");
                assert_eq!(event["msg"]["turn_id"], turn_id, "{event}");
                break;
            }
        }
        let owner = native.current().unwrap();
        let turn = owner
            .thread
            .thread_extension_data()
            .get::<crate::turn_settlement::Settlement>()
            .unwrap()
            .admission_ready(turn_id)
            .unwrap()
            .unwrap();
        // Core queues TurnComplete before clearing its active slot and calling
        // on_thread_idle, which makes this exact receipt Ready. No reader has
        // consumed that terminal, so Pending below cannot be an empty queue.
        turn.wait().await.unwrap();
        assert_eq!(provider.request_count(), 3);
        let store = owner.engine.local_checklist_store.as_ref().unwrap();
        let health = store.writers.lock().await;
        // Drain every queued nonterminal explicitly. A success before Pending
        // is a failure; the only held lock in this reader is writer health.
        let mut reading = loop {
            let mut read = Box::pin(native.next_session_event());
            match futures_util::poll!(read.as_mut()) {
                std::task::Poll::Ready(result) => {
                    let event: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
                    assert!(event["subagent_id"].is_null(), "{event}");
                    assert_eq!(event["id"], turn_id, "{event}");
                    assert!(
                        !matches!(
                            event["msg"]["type"].as_str(),
                            Some("error" | "turn_aborted" | "task_complete" | "turn_complete")
                        ),
                        "{event}"
                    );
                }
                std::task::Poll::Pending => break read,
            }
        };
        let mut closing = Box::pin(native.close());
        assert!(futures_util::poll!(closing.as_mut()).is_pending());
        assert!(
            owner.is_closed(),
            "close must set its fence before the health hold releases"
        );
        drop(health);
        let (read, closed) = tokio::join!(&mut reading, &mut closing);
        let error = read.unwrap_err();
        assert!(error.reason.contains("closed"), "{}", error.reason);
        closed.unwrap();
        engine.close().await.unwrap();
        assert_eq!(provider.request_count(), 3);
    })
    .await
    .expect("terminal health/close race timed out");
}

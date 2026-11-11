//! Receipt ownership tests against a real Core fork and exact store lookup.
use super::*;
use crate::local_storage_tests::Provider;
use serde_json::json;

async fn open() -> (Provider, tempfile::TempDir, crate::Engine, NativeThread) {
    let provider = Provider::start().await;
    let home = tempfile::tempdir().unwrap();
    let engine = crate::create_engine(
        provider.config().to_string(),
        json!({"codex_home":home.path(), "cwd":home.path()}).to_string(),
        None,
        None,
    )
    .await
    .unwrap();
    let source = engine
        .start_replaceable_thread(
            json!({"_managed_instructions":true,"instructions":"Keep history."}).to_string(),
            "[]".into(),
        )
        .await
        .unwrap();
    (provider, home, engine, source)
}

async fn assert_missing(engine: &EngineState, id: ThreadId) {
    let actual = engine.read_stored_thread(id).await.unwrap_err();
    let missing = engine
        .read_stored_thread(ThreadId::new())
        .await
        .unwrap_err();
    assert_eq!(
        std::mem::discriminant(&actual),
        std::mem::discriminant(&missing)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_fork_removes_only_the_copied_record() {
    let (_provider, _home, engine, source) = open().await;
    let state = source.current().unwrap();
    let original = crate::checkpoint::export(&state, None).await.unwrap();
    let copy = source._fork_settled().await.unwrap();
    let copied = copy.current().unwrap().id;
    assert_ne!(state.id, copied);
    assert!(state.engine.read_stored_thread(copied).await.is_ok());
    assert_eq!(copy._discard_fork().await.unwrap(), None);
    assert_missing(&state.engine, copied).await;
    let after: serde_json::Value =
        serde_json::from_str(&source._export_checkpoint(None, false, None).await.unwrap()).unwrap();
    assert_eq!(after["source_session_id"], original["source_session_id"]);
    assert_eq!(after["managed_tool_specs"], original["managed_tool_specs"]);
    assert!(
        after["history"].as_array().unwrap().len() >= original["history"].as_array().unwrap().len()
    );
    copy._discard_fork().await.unwrap();
    drop(state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_fork_stale_discard_cannot_retire_a_newer_copy() {
    let (_provider, _home, engine, source) = open().await;
    let first = source._fork_settled().await.unwrap();
    first._discard_fork().await.unwrap();
    let second = source._fork_settled().await.unwrap();
    let second_state = second.current().unwrap();
    let second_id = second_state.id;
    first._discard_fork().await.unwrap();
    assert!(
        second_state
            .engine
            .read_stored_thread(second_id)
            .await
            .is_ok()
    );
    assert!(!second_state.is_closed());
    second._export_checkpoint(None, false, None).await.unwrap();
    second._discard_fork().await.unwrap();
    assert_missing(&second_state.engine, second_id).await;
    drop(second_state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_fork_source_close_drains_a_lost_native_result() {
    let (_provider, _home, engine, source) = open().await;
    let copy = source._fork_settled().await.unwrap();
    let id = copy.current().unwrap().id;
    drop(copy);
    source.close().await.unwrap();
    let engine_state = engine.current().unwrap();
    assert_missing(&engine_state, id).await;
    assert!(
        engine_state
            .read_stored_thread(ThreadId::from_string(&source.id()).unwrap())
            .await
            .is_ok()
    );
    drop(engine_state);
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_fork_cleanup_retries_shutdown_and_deletion_stages() {
    for stage in [1, 2] {
        let (_provider, _home, engine, source) = open().await;
        let state = source.current().unwrap();
        let copy = source._fork_settled().await.unwrap();
        let id = copy.current().unwrap().id;
        state
            .fork_copy
            .lock()
            .await
            .as_ref()
            .unwrap()
            .test_failure
            .store(stage, Ordering::Release);
        assert!(copy._discard_fork().await.is_err());
        {
            let receipt = state.fork_copy.lock().await;
            let receipt = receipt.as_ref().unwrap();
            assert_eq!(receipt.id, id);
            assert_eq!(receipt.shutdown_complete, stage == 2);
        }
        assert!(state.engine.read_stored_thread(id).await.is_ok());
        // Explicit source close owns the retry even after the copy waiter failed.
        drop(copy);
        source.close().await.unwrap();
        assert_missing(&state.engine, id).await;
        drop(state);
        engine.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_fork_raw_receipt_survives_failure_before_wrapper_creation() {
    let (_provider, _home, engine, source) = open().await;
    let state = source.current().unwrap();
    state.fork_test_failure.store(3, Ordering::Release);
    let error = match source._fork_settled().await {
        Err(error) => error.to_string(),
        Ok(_) => panic!("injected wrapper failure did not run"),
    };
    let id = ThreadId::from_string(error.split_whitespace().last().unwrap()).unwrap();
    assert_missing(&state.engine, id).await;
    assert!(state.fork_copy.lock().await.is_none());
    assert_eq!(state.engine.manager.list_thread_ids().await, vec![state.id]);
    assert!(state.engine.read_stored_thread(state.id).await.is_ok());
    drop(state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_fork_engine_close_after_source_loss_retries_exact_deletion() {
    for fail_delete in [false, true] {
        let (_provider, _home, engine, source) = open().await;
        let copy = source._fork_settled().await.unwrap();
        let id = copy.current().unwrap().id;
        let state = source.current().unwrap();
        let source_weak = Arc::downgrade(&state);
        let original_id = state.id;
        let store = state.engine.store.clone();
        if fail_delete {
            state
                .fork_copy
                .lock()
                .await
                .as_ref()
                .unwrap()
                .test_failure
                .store(2, Ordering::Release);
        }
        drop(state);
        drop(copy);
        drop(source);
        assert!(
            source_weak.upgrade().is_none(),
            "source state must not retain its own receipt"
        );
        // Registering another wrapper must not prune an expired source whose
        // exact copy receipt still needs retirement.
        let successor = engine
            .start_replaceable_thread(
                json!({"_managed_instructions":true,"instructions":"Independent root."})
                    .to_string(),
                "[]".into(),
            )
            .await
            .unwrap();
        if fail_delete {
            assert!(engine.close().await.is_err());
        }
        engine.close().await.unwrap();
        drop(successor);
        let read = |id| codex_thread_store::ReadThreadParams {
            thread_id: id,
            include_archived: true,
            include_history: false,
        };
        let deleted = store.read_thread(read(id)).await.unwrap_err();
        let missing = store.read_thread(read(ThreadId::new())).await.unwrap_err();
        assert_eq!(
            std::mem::discriminant(&deleted),
            std::mem::discriminant(&missing)
        );
        assert!(store.read_thread(read(original_id)).await.is_ok());
        let closed = engine.inner.lock().unwrap();
        assert!(closed.live.is_none());
        drop(closed);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composed_final_engine_owner_drop_drains_lost_source_fork_receipt() {
    let (_provider, _home, engine, source) = open().await;
    let copy = source._fork_settled().await.unwrap();
    let copied_id = copy.current().unwrap().id;
    let state = source.current().unwrap();
    let original_id = state.id;
    let source_weak = Arc::downgrade(&state);
    let engine_state = engine.current().unwrap();
    let engine_weak = Arc::downgrade(&engine_state);
    let store = engine_state.store.clone();
    drop(engine_state);
    drop(state);
    drop(copy);
    drop(source);
    assert!(
        source_weak.upgrade().is_none(),
        "no source SDK state may survive before final engine drop"
    );
    drop(engine);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if engine_weak.upgrade().is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("final shared engine owner did not finish native shutdown");
    let read = |id| codex_thread_store::ReadThreadParams {
        thread_id: id,
        include_archived: true,
        include_history: false,
    };
    let deleted = store.read_thread(read(copied_id)).await.unwrap_err();
    let missing = store.read_thread(read(ThreadId::new())).await.unwrap_err();
    assert_eq!(
        std::mem::discriminant(&deleted),
        std::mem::discriminant(&missing)
    );
    assert!(
        store.read_thread(read(original_id)).await.is_ok(),
        "fallback must retain source history"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composed_temporary_engine_alias_drop_keeps_fork_owner_live() {
    let (_provider, _home, engine, source) = open().await;
    let alias = crate::Engine {
        inner: engine.inner.clone(),
        startup_warnings: engine.startup_warnings.clone(),
    };
    drop(alias);
    assert!(
        engine.current().is_ok(),
        "a temporary alias must not retire the shared engine owner"
    );
    let copy = source._fork_settled().await.unwrap();
    copy._discard_fork().await.unwrap();
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

// Combined fork/supplied-compaction admission regressions. These use existing
// lifecycle and receipt locks; no production barrier or synthetic fork exists.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integrated_fork_waiter_retains_context_read_admission() {
    let (provider, _home, engine, source) = open().await;
    let state = source.current().unwrap();
    source._export_checkpoint(None, false, None).await.unwrap();
    let before = serde_json::to_value(
        state
            .engine
            .load_checkpoint_history(state.id)
            .await
            .unwrap(),
    )
    .unwrap();
    let lifecycle = state.engine.lifecycle.lock().await;
    let mut fork = Box::pin(state.engine.fork_settled(&state));
    assert!(futures_util::poll!(&mut fork).is_pending());
    let mut change = Box::pin(crate::context::begin(Arc::clone(&state)));
    match futures_util::poll!(&mut change) {
        Poll::Ready(Err(error)) => assert!(
            error
                .to_string()
                .contains("native operations are still in progress"),
            "{error}"
        ),
        Poll::Ready(Ok(_)) => panic!("context admission ignored the admitted fork reader"),
        Poll::Pending => panic!("context admission waited instead of refusing the admitted fork"),
    }
    drop(change);
    assert!(state.fork_copy.lock().await.is_none());
    assert_eq!(state.engine.manager.list_thread_ids().await, vec![state.id]);
    assert_eq!(
        serde_json::to_value(
            state
                .engine
                .load_checkpoint_history(state.id)
                .await
                .unwrap()
        )
        .unwrap(),
        before
    );
    assert_eq!(provider.request_count(), 0);
    drop(lifecycle);
    let copy = fork.await.unwrap();
    copy._discard_fork().await.unwrap();
    assert_eq!(provider.request_count(), 0);
    drop(state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integrated_context_refuses_exact_deletion_still_owned_after_copy_shutdown() {
    let (provider, _home, engine, source) = open().await;
    let state = source.current().unwrap();
    let copy = source._fork_settled().await.unwrap();
    let copied_id = copy.current().unwrap().id;
    assert_ne!(copied_id, state.id);
    state
        .fork_copy
        .lock()
        .await
        .as_ref()
        .unwrap()
        .test_failure
        .store(2, Ordering::Release);
    assert!(copy._discard_fork().await.is_err());
    {
        let slot = state.fork_copy.lock().await;
        let receipt = slot.as_ref().unwrap();
        assert_eq!(receipt.id, copied_id);
        assert!(receipt.shutdown_complete);
    }
    assert_eq!(state.engine.manager.list_thread_ids().await, vec![state.id]);
    assert!(state.engine.read_stored_thread(copied_id).await.is_ok());
    let before = serde_json::to_value(
        state
            .engine
            .load_checkpoint_history(state.id)
            .await
            .unwrap(),
    )
    .unwrap();
    let mut change = Box::pin(crate::context::begin(Arc::clone(&state)));
    match futures_util::poll!(&mut change) {
        Poll::Ready(Err(error)) => assert!(
            error.to_string().contains("completed fork cleanup"),
            "{error}"
        ),
        Poll::Ready(Ok(_)) => panic!("context change abandoned an owned deleted-record stage"),
        Poll::Pending => panic!("owned fork cleanup must refuse context admission without waiting"),
    }
    drop(change);
    assert_eq!(
        serde_json::to_value(
            state
                .engine
                .load_checkpoint_history(state.id)
                .await
                .unwrap()
        )
        .unwrap(),
        before
    );
    assert_eq!(provider.request_count(), 0);
    copy._discard_fork().await.unwrap();
    assert!(state.fork_copy.lock().await.is_none());
    assert_missing(&state.engine, copied_id).await;
    assert!(state.engine.read_stored_thread(state.id).await.is_ok());
    let recovered = crate::context::begin(Arc::clone(&state)).await.unwrap();
    drop(recovered);
    source._export_checkpoint(None, false, None).await.unwrap();
    assert_eq!(provider.request_count(), 0);
    drop(state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integrated_locked_empty_fork_receipt_refuses_context_without_waiting() {
    let (provider, _home, engine, source) = open().await;
    let state = source.current().unwrap();
    source._export_checkpoint(None, false, None).await.unwrap();
    let before = serde_json::to_value(
        state
            .engine
            .load_checkpoint_history(state.id)
            .await
            .unwrap(),
    )
    .unwrap();
    let receipt = state.fork_copy.lock().await;
    assert!(
        receipt.is_none(),
        "this covers a locked empty receipt, not only an owned copy"
    );
    let mut change = Box::pin(crate::context::begin(Arc::clone(&state)));
    match futures_util::poll!(&mut change) {
        Poll::Ready(Err(error)) => assert!(
            error.to_string().contains("completed fork cleanup"),
            "{error}"
        ),
        Poll::Ready(Ok(_)) => panic!("context admission ignored a locked fork receipt"),
        Poll::Pending => panic!("context admission waited for a receipt lock"),
    }
    drop(change);
    assert_eq!(
        serde_json::to_value(
            state
                .engine
                .load_checkpoint_history(state.id)
                .await
                .unwrap()
        )
        .unwrap(),
        before
    );
    assert_eq!(provider.request_count(), 0);
    drop(receipt);
    let recovered = crate::context::begin(Arc::clone(&state)).await.unwrap();
    drop(recovered);
    assert_eq!(provider.request_count(), 0);
    drop(state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integrated_queued_close_then_fork_refuses_without_copy_or_model_effects() {
    let (provider, _home, engine, source) = open().await;
    let state = source.current().unwrap();
    source._export_checkpoint(None, false, None).await.unwrap();
    let lifecycle = state.engine.lifecycle.lock().await;
    // Tokio's FIFO mutex queues close before fork; both futures are real owners.
    let mut close = Box::pin(state.engine.close_report());
    assert!(futures_util::poll!(&mut close).is_pending());
    let mut fork = Box::pin(state.engine.fork_settled(&state));
    assert!(futures_util::poll!(&mut fork).is_pending());
    drop(lifecycle);
    assert!(close.await.unwrap().message(false).is_none());
    // Close may append legitimate records. Isolate only the resumed fork's effects.
    let after_close = serde_json::to_value(
        state
            .engine
            .load_checkpoint_history(state.id)
            .await
            .unwrap(),
    )
    .unwrap();
    let error = match fork.await {
        Err(error) => error,
        Ok(_) => panic!("fork published after its engine closed"),
    };
    assert!(
        error.to_string().contains("Codex engine is closed"),
        "{error}"
    );
    assert!(state.fork_copy.lock().await.is_none());
    assert!(state.engine.manager.list_thread_ids().await.is_empty());
    assert_eq!(
        serde_json::to_value(
            state
                .engine
                .load_checkpoint_history(state.id)
                .await
                .unwrap()
        )
        .unwrap(),
        after_close
    );
    assert_eq!(provider.request_count(), 0);
    drop(state);
    engine.close().await.unwrap();
}

// These records are portable data. Only fixture setup restores them into the
// source backend; the temporary fork must never stage its own planning records.
async fn metadata_source(
    status: &str,
) -> (Provider, tempfile::TempDir, crate::Engine, NativeThread) {
    let provider = Provider::start().await;
    let home = tempfile::tempdir().unwrap();
    let engine = crate::create_engine(
        provider.config().to_string(),
        json!({"codex_home":home.path(), "cwd":home.path(), "native_goal_store":home.path()})
            .to_string(),
        None,
        None,
    )
    .await
    .unwrap();
    let source = engine
        .start_replaceable_thread(
            crate::local_storage_tests::options(None),
            crate::local_storage_tests::specs(),
        )
        .await
        .unwrap();
    source
        ._configure_manual_tools("[{\"name\":\"lookup\"}]".into(), None)
        .unwrap();
    source._submit(json!({"mode":"start_if_idle","input":[{"type":"text","text":"Record metadata history."}]}).to_string()).await.unwrap();
    loop {
        let event: serde_json::Value =
            serde_json::from_str(&source.next_session_event().await.unwrap()).unwrap();
        if event["msg"]["type"] == "dynamic_tool_call_request" {
            assert!(source._respond_python_tool(json!({"request":event["msg"],"response":{"success":true,"contentItems":[{"type":"inputText","text":"recorded metadata effect"}]}}).to_string(), None).await.unwrap());
            break;
        }
        assert_ne!(event["msg"]["type"], "error", "{event}");
    }
    loop {
        let event: serde_json::Value =
            serde_json::from_str(&source.next_session_event().await.unwrap()).unwrap();
        match event["msg"]["type"].as_str() {
            Some("task_complete" | "turn_complete") => break,
            Some("error" | "turn_aborted") => panic!("metadata fixture failed: {event}"),
            _ => {}
        }
    }
    source._export_checkpoint(None, false, None).await.unwrap();
    let state = source.current().unwrap();
    let history = state
        .engine
        .load_checkpoint_history(state.id)
        .await
        .unwrap();
    let turn = history
        .iter()
        .find_map(|item| match item {
            codex_history::RolloutItem::EventMsg(
                codex_protocol::protocol::EventMsg::TurnStarted(turn),
            ) => Some(turn.turn_id.clone()),
            _ => None,
        })
        .unwrap();
    let checklist: crate::storage::ChecklistState = serde_json::from_value(json!({
        "thread_id":state.id,"turn_id":turn,"explanation":"Keep recorded order",
        "plan":[{"step":format!("Literal source {}",state.id),"status":"completed"},{"step":"Next step","status":"in_progress"},{"step":"Later step","status":"pending"}]
    })).unwrap();
    state
        .engine
        .store
        .as_any()
        .downcast_ref::<crate::storage::MemoryThreadStore>()
        .unwrap()
        .restore_checklist(checklist)
        .await;
    let goal: crate::goals::GoalSnapshot = serde_json::from_value(json!({
        "thread_id":state.id,"objective":format!("Preserve literal source {}",state.id),"status":status,
        "token_budget":2100,"tokens_used":850,"time_used_seconds":72,"created_at":1700000000,"updated_at":1700000072
    })).unwrap();
    let config = state.thread.config().await;
    goal.restore(&state.engine, config.as_ref()).await.unwrap();
    drop(state);
    (provider, home, engine, source)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_fork_preserves_fields_without_temporary_backend_records() {
    for status in ["paused", "complete"] {
        let (provider, _home, engine, source) = metadata_source(status).await;
        let before: serde_json::Value =
            serde_json::from_str(&source._export_checkpoint(None, false, None).await.unwrap())
                .unwrap();
        let copy = source._fork_settled().await.unwrap();
        let copied = copy.current().unwrap();
        let id = copied.id;
        assert_ne!(id.to_string(), source.id());
        assert!(
            copied
                .engine
                .goals
                .as_ref()
                .unwrap()
                .service
                .get_thread_goal(&copied.engine.goals.as_ref().unwrap().state_db, id)
                .await
                .unwrap()
                .is_none()
        );
        let store = copied
            .engine
            .store
            .as_any()
            .downcast_ref::<crate::storage::MemoryThreadStore>()
            .unwrap();
        assert!(store.checklist(id).await.unwrap().is_none());
        let exported: serde_json::Value =
            serde_json::from_str(&copy._export_checkpoint(None, false, None).await.unwrap())
                .unwrap();
        for field in ["root_goal", "root_checklist"] {
            let mut expected = before[field].clone();
            expected["thread_id"] = json!(id);
            assert_eq!(exported[field], expected);
        }
        assert_eq!(provider.request_count(), 2);
        copy._discard_fork().await.unwrap();
        assert_missing(&copied.engine, id).await;
        let after: serde_json::Value =
            serde_json::from_str(&source._export_checkpoint(None, false, None).await.unwrap())
                .unwrap();
        assert_eq!(after["root_goal"], before["root_goal"]);
        assert_eq!(after["root_checklist"], before["root_checklist"]);
        drop(copied);
        source.close().await.unwrap();
        engine.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_fork_admission_rejects_a_foreign_checklist_turn_before_allocation() {
    let (provider, _home, engine, source) = metadata_source("paused").await;
    let state = source.current().unwrap();
    let before: serde_json::Value =
        serde_json::from_str(&source._export_checkpoint(None, false, None).await.unwrap()).unwrap();
    let mut corrupt = before["root_checklist"].clone();
    corrupt["turn_id"] = json!("not-in-source-history");
    let store = state
        .engine
        .store
        .as_any()
        .downcast_ref::<crate::storage::MemoryThreadStore>()
        .unwrap();
    store
        .restore_checklist(serde_json::from_value(corrupt.clone()).unwrap())
        .await;
    let error = match source._fork_settled().await {
        Err(error) => error,
        Ok(_) => panic!("foreign checklist turn was forked"),
    };
    assert!(
        error.to_string().contains("checklist turn identity"),
        "{error}"
    );
    assert!(state.fork_copy.lock().await.is_none());
    assert_eq!(state.engine.manager.list_thread_ids().await, vec![state.id]);
    assert_eq!(
        serde_json::to_value(store.checklist(state.id).await.unwrap()).unwrap(),
        corrupt
    );
    assert_eq!(provider.request_count(), 2);
    store
        .restore_checklist(serde_json::from_value(before["root_checklist"].clone()).unwrap())
        .await;
    let copy = source._fork_settled().await.unwrap();
    copy._discard_fork().await.unwrap();
    drop(state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_fork_admission_does_not_pause_an_active_source_goal() {
    let (provider, _home, engine, source) = metadata_source("paused").await;
    let state = source.current().unwrap();
    let backend = state.engine.goals.as_ref().unwrap();
    let mut goal = backend
        .state_db
        .thread_goals()
        .get_thread_goal(state.id)
        .await
        .unwrap()
        .unwrap();
    // Test-only backend corruption reaches fork admission directly; this is not
    // an opening-schema refusal and applies no GoalService runtime effects.
    goal.status = codex_state::ThreadGoalStatus::Active;
    backend
        .state_db
        .thread_goals()
        .replace_thread_goal_snapshot(&goal)
        .await
        .unwrap();
    let error = match source._fork_settled().await {
        Err(error) => error,
        Ok(_) => panic!("active goal was forked"),
    };
    assert!(error.to_string().contains("paused or complete"), "{error}");
    assert!(state.fork_copy.lock().await.is_none());
    assert_eq!(state.engine.manager.list_thread_ids().await, vec![state.id]);
    let retained = backend
        .state_db
        .thread_goals()
        .get_thread_goal(state.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(retained.status).unwrap(),
        json!("active")
    );
    assert_eq!(retained.tokens_used, goal.tokens_used);
    assert_eq!(provider.request_count(), 2);
    goal.status = codex_state::ThreadGoalStatus::Paused;
    backend
        .state_db
        .thread_goals()
        .replace_thread_goal_snapshot(&goal)
        .await
        .unwrap();
    drop(state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_fork_write_once_validation_and_delete_retry_preserve_source_records() {
    let (provider, _home, engine, source) = metadata_source("complete").await;
    let state = source.current().unwrap();
    let before: serde_json::Value =
        serde_json::from_str(&source._export_checkpoint(None, false, None).await.unwrap()).unwrap();
    state.fork_test_failure.store(3, Ordering::Release);
    let wrap_error = match source._fork_settled().await {
        Err(error) => error.to_string(),
        Ok(_) => panic!("metadata wrapper failure did not run"),
    };
    let wrapped_id = ThreadId::from_string(wrap_error.split_whitespace().last().unwrap()).unwrap();
    assert_missing(&state.engine, wrapped_id).await;
    assert!(state.fork_copy.lock().await.is_none());
    let copy = source._fork_settled().await.unwrap();
    let id = copy.current().unwrap().id;
    let mut invalid = crate::checkpoint::ForkMetadata::capture(&before, state.id).unwrap();
    invalid.retarget(ThreadId::new());
    assert!(copy.current().unwrap().retain_metadata(invalid).is_err());
    let kept: serde_json::Value =
        serde_json::from_str(&copy._export_checkpoint(None, false, None).await.unwrap()).unwrap();
    assert_eq!(kept["root_goal"]["thread_id"], json!(id));
    state
        .fork_copy
        .lock()
        .await
        .as_ref()
        .unwrap()
        .test_failure
        .store(2, Ordering::Release);
    assert!(copy._discard_fork().await.is_err());
    assert!(
        state
            .fork_copy
            .lock()
            .await
            .as_ref()
            .unwrap()
            .shutdown_complete
    );
    assert!(state.engine.read_stored_thread(id).await.is_ok());
    copy._discard_fork().await.unwrap();
    assert_missing(&state.engine, id).await;
    let after: serde_json::Value =
        serde_json::from_str(&source._export_checkpoint(None, false, None).await.unwrap()).unwrap();
    assert_eq!(after["root_goal"], before["root_goal"]);
    assert_eq!(after["root_checklist"], before["root_checklist"]);
    assert_eq!(provider.request_count(), 2);
    drop(state);
    source.close().await.unwrap();
    engine.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_fork_lost_wrapper_and_final_owner_keep_only_raw_cleanup_ownership() {
    let (provider, _home, engine, source) = metadata_source("paused").await;
    let before: serde_json::Value =
        serde_json::from_str(&source._export_checkpoint(None, false, None).await.unwrap()).unwrap();
    let copy = source._fork_settled().await.unwrap();
    let id = copy.current().unwrap().id;
    let state = source.current().unwrap();
    let original_id = state.id;
    let source_weak = Arc::downgrade(&state);
    let engine_weak = Arc::downgrade(&state.engine);
    let store = state.engine.store.clone();
    let config = state.thread.config().await;
    let sqlite = config.sqlite_config().clone();
    let provider_id = config.model_provider_id.clone();
    drop(config);
    drop(state);
    drop(copy);
    drop(source);
    assert!(source_weak.upgrade().is_none());
    drop(engine);
    tokio::time::timeout(Duration::from_secs(10), async {
        while engine_weak.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("metadata retained a source or engine owner");
    let read = |id| codex_thread_store::ReadThreadParams {
        thread_id: id,
        include_archived: true,
        include_history: false,
    };
    let deleted = store.read_thread(read(id)).await.unwrap_err();
    let missing = store.read_thread(read(ThreadId::new())).await.unwrap_err();
    assert_eq!(
        std::mem::discriminant(&deleted),
        std::mem::discriminant(&missing)
    );
    assert!(store.read_thread(read(original_id)).await.is_ok());
    let memory = store
        .as_any()
        .downcast_ref::<crate::storage::MemoryThreadStore>()
        .unwrap();
    assert_eq!(
        serde_json::to_value(memory.checklist(original_id).await.unwrap()).unwrap(),
        before["root_checklist"]
    );
    // The original pool closed with EngineState. A fresh read-only observation
    // proves exact copy-row deletion and source goal preservation after disposal.
    let reopened = codex_state::StateRuntime::init(sqlite, provider_id)
        .await
        .unwrap();
    assert!(
        reopened
            .thread_goals()
            .get_thread_goal(id)
            .await
            .unwrap()
            .is_none()
    );
    let goal = reopened
        .thread_goals()
        .get_thread_goal(original_id)
        .await
        .unwrap()
        .unwrap();
    let saved = &before["root_goal"];
    assert_eq!(goal.objective, saved["objective"].as_str().unwrap());
    // Source close may own normal accounting finalization. Exact field
    // preservation is checked before close above; disposal must retain its row.
    reopened.close().await;
    assert_eq!(provider.request_count(), 2);
}

// These cases deliberately inspect the source SQL row. Public export alone
// cannot establish which same-ID store a failed candidate touched.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_engine_close_retains_cleanup_after_manager_removal() {
    let (_provider, _home, engine, _source) = open().await;
    let state = engine.current().unwrap();
    let hold = Arc::new(ProcessCleanupHold {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    *state.process_cleanup_hold.lock().unwrap() = Some(hold.clone());
    let closing = state.clone();
    let first = tokio::spawn(async move { closing.close_report().await });
    tokio::time::timeout(Duration::from_secs(5), hold.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(state.manager.list_thread_ids().await.is_empty());
    first.abort();
    assert!(matches!(first.await, Err(error) if error.is_cancelled()));

    let closing = state.clone();
    let mut retry = tokio::spawn(async move { closing.close_report().await });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut retry)
            .await
            .is_err(),
        "cleanup must remain pending after its registry entry is gone"
    );
    tokio::time::timeout(Duration::from_secs(5), hold.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    hold.release.add_permits(1);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), retry)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .message(false)
            .is_none()
    );
    engine.close().await.unwrap();
}

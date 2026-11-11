use crate::local_storage_tests::{Provider, specs};
use crate::*;
use serde_json::{Value, json};
use std::sync::Arc;

async fn local_goal_owner() -> (
    Engine,
    Arc<NativeThread>,
    tempfile::TempDir,
    tempfile::TempDir,
    Provider,
) {
    let provider = Provider::start().await;
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let mut config = provider.config();
    config["features.goals"] = json!(true);
    let runtime = json!({"codex_home":home.path(),"cwd":home.path(),"native_thread_store":profile.path(),"native_goal_store":profile.path()});
    let engine = create_engine(config.to_string(), runtime.to_string(), None, None)
        .await
        .unwrap();
    let policy = json!({"_managed_instructions":true,"instructions":"Manage the current goal.","tool_policy":{"allowed_tools":[{"name":"lookup"},{"name":"create_goal"},{"name":"get_goal"},{"name":"update_goal"}]}});
    let thread = Arc::new(
        engine
            .start_replaceable_thread(policy.to_string(), specs())
            .await
            .unwrap(),
    );
    (engine, thread, profile, home, provider)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_goal_read_preserves_stored_i64_fields_without_model_work() {
    let (engine, native, _profile, _home, provider) = local_goal_owner().await;
    let owner = native.current().unwrap();
    let snapshot: goals::GoalSnapshot = serde_json::from_value(json!({
        "thread_id":owner.id,"objective":"Retained exact native counters","status":"paused",
        "token_budget":9223372036854775807i64,"tokens_used":9007199254740993i64,
        "time_used_seconds":9007199254740993i64,"created_at":1700000000,"updated_at":1700000072
    }))
    .unwrap();
    snapshot
        .restore(&owner.engine, &*owner.thread.config().await)
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&native._read_goal().await.unwrap()).unwrap();
    assert_eq!(value["tokenBudget"], "9223372036854775807");
    assert_eq!(value["tokensUsed"], "9007199254740993");
    assert_eq!(value["timeUsedSeconds"], "9007199254740993");
    assert_eq!(value["threadId"], native.id());
    native.close().await.unwrap();
    engine.close().await.unwrap();
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_goal_read_and_close_use_the_same_mutation_owner() {
    let (engine, native, _profile, _home, provider) = local_goal_owner().await;
    assert_eq!(native._read_goal().await.unwrap(), "null");
    let owner = native.current().unwrap();
    let guard = owner.mutations.lock().await;
    let mut closing = Box::pin(native.close());
    tokio::select! {
        biased;
        result = &mut closing => panic!("close passed the held mutation owner: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    let mut reading = Box::pin(native._read_goal());
    tokio::select! {
        biased;
        result = &mut reading => panic!("read passed the held mutation owner: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    drop(guard);
    closing.await.unwrap();
    assert!(reading.await.is_err());
    assert!(native._read_goal().await.is_err());
    engine.close().await.unwrap();
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_goal_read_reports_sticky_receipt_failure_instead_of_absence() {
    let (engine, native, _profile, _home, provider) = local_goal_owner().await;
    let owner = native.current().unwrap();
    native._submit(json!({"mode":"start_if_idle","input":[{"type":"text","text":"Look up the current key"}]}).to_string()).await.unwrap();
    let request = loop {
        let event: Value =
            serde_json::from_str(&native.next_session_event().await.unwrap()).unwrap();
        if event["msg"]["type"] == "dynamic_tool_call_request" {
            break event["msg"].clone();
        }
        assert_ne!(event["msg"]["type"], "error", "{event}");
    };
    owner
        .engine
        .local_checklist_store
        .as_ref()
        .unwrap()
        .fail_receipt_flush
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(native._respond_python_tool(json!({"request":request,"response":{"contentItems":[{"type":"inputText","text":"real result"}],"success":true}}).to_string(), None).await.is_err());
    let error = native._read_goal().await.unwrap_err();
    assert!(
        error.reason.contains("injected receipt flush failure"),
        "{}",
        error.reason
    );
    assert!(native._close_report().await.unwrap().is_some());
    assert!(engine._close_report().await.unwrap().is_some());
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
}

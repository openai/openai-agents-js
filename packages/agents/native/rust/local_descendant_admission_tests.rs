//! Focused source tests for storage/admission pieces, not process-reopen proof.
use super::*;
use codex_protocol::protocol::{SessionSource, SubAgentSource};
use serde_json::json;

fn started(id: &str) -> RolloutItem {
    RolloutItem::EventMsg(
        serde_json::from_value(json!({
            "type": "task_started", "turn_id": id, "root_turn_id": id
        }))
        .unwrap(),
    )
}

fn completed(id: &str) -> RolloutItem {
    RolloutItem::EventMsg(
        serde_json::from_value(json!({
            "type": "task_complete", "turn_id": id, "last_agent_message": "settled"
        }))
        .unwrap(),
    )
}

fn call(id: &str) -> RolloutItem {
    RolloutItem::ResponseItem(ResponseItemEnvelope::new(
        serde_json::from_value(json!({
            "type": "function_call", "name": "managed", "call_id": id, "arguments": "{}"
        }))
        .unwrap(),
    ))
}

async fn append(store: &LocalChecklistStore, id: ThreadId, items: Vec<RolloutItem>) {
    store
        .append_items(AppendThreadItemsParams {
            thread_id: id,
            items,
        })
        .await
        .unwrap();
}

// Use real native creation and materialized headers, not inserted database rows.
async fn family(home: &Path) -> (LocalChecklistStore, [ThreadId; 3]) {
    let store = tests::store(home).await;
    let ids = [ThreadId::new(), ThreadId::new(), ThreadId::new()];
    for (depth, id) in ids.iter().copied().enumerate() {
        let mut params = tests::create_params(id, home);
        if depth != 0 {
            params.parent_thread_id = Some(ids[depth - 1]);
            params.source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id: ids[depth - 1],
                depth: depth as i32,
                agent_path: None,
                agent_nickname: None,
                agent_role: None,
            });
        }
        store.create_thread(params).await.unwrap();
        store
            .persist_thread(id, PersistContext::Standard)
            .await
            .unwrap();
    }
    (store, ids)
}

async fn snapshots(
    store: &LocalChecklistStore,
    ids: &[ThreadId],
) -> HashMap<ThreadId, Vec<RolloutItem>> {
    let mut histories = HashMap::new();
    for id in ids {
        histories.insert(*id, store.load_owned_history(*id).await.unwrap());
    }
    histories
}

async fn edges(store: &LocalChecklistStore, ids: &[ThreadId; 3]) -> Vec<(ThreadId, SpawnEdge)> {
    let mut edges = Vec::new();
    for child in &ids[1..] {
        edges.push((*child, store.graph.edge(*child).await.unwrap()));
    }
    edges
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_child_header_precedes_graph_publication_and_hydrates_closed_branches() {
    let home = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    for child in &ids[1..] {
        let path = store.inner.live_rollout_path(*child).await.unwrap();
        let header = codex_rollout::read_session_meta_line(&path).await.unwrap();
        assert_eq!(header.meta.id, *child);
        assert!(header.meta.source.parent_thread_id().is_some());
    }
    // Native creation has admitted durable edges but Core has not published readiness.
    let mut events = store.graph.subscribe(ids[0]).await;
    assert!(events.try_recv().is_err());
    store
        .graph
        .upsert_thread_spawn_edge(ids[0], ids[1], ThreadSpawnEdgeStatus::Open)
        .await
        .unwrap();
    assert_eq!(events.try_recv().unwrap().kind, "created");
    store
        .graph
        .set_thread_spawn_edge_status(ids[1], ThreadSpawnEdgeStatus::Closed)
        .await
        .unwrap();
    let cold = MemoryAgentGraph::local(store.state.clone());
    cold.hydrate(ids[0]).await.unwrap();
    assert_eq!(
        cold.edge(ids[1]).await.unwrap().status,
        ThreadSpawnEdgeStatus::Closed
    );
    assert_eq!(cold.edge(ids[2]).await.unwrap().parent, ids[1]);
    assert_eq!(
        cold.list_thread_spawn_descendants(ids[0], None)
            .await
            .unwrap()
            .len(),
        2
    );
    // A persisted closed edge has no known close timestamp in the pinned API.
    assert!(cold.edge(ids[1]).await.unwrap().closed_at.is_none());
    for id in ids {
        store.shutdown_thread(id).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_edges_accept_settled_own_turns_but_not_only_inherited_turns() {
    let home = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    let edges = edges(&store, &ids).await;
    let mut histories = snapshots(&store, &ids).await;
    for id in ids {
        histories
            .get_mut(&id)
            .unwrap()
            .extend([started("parent"), completed("parent")]);
    }
    assert!(
        validate_local_tree(ids[0], &edges, &histories)
            .unwrap_err()
            .to_string()
            .contains("active descendant")
    );
    histories
        .get_mut(&ids[1])
        .unwrap()
        .extend([started("child"), completed("child")]);
    histories.get_mut(&ids[2]).unwrap().extend([
        started("child"),
        completed("child"),
        started("grandchild"),
        completed("grandchild"),
    ]);
    validate_local_tree(ids[0], &edges, &histories).unwrap();
    histories
        .get_mut(&ids[2])
        .unwrap()
        .push(started("unfinished-without-tool"));
    for _ in 0..2 {
        assert!(
            validate_local_tree(ids[0], &edges, &histories)
                .unwrap_err()
                .to_string()
                .contains("active descendant")
        );
    }
    for id in ids {
        store.shutdown_thread(id).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_effect_below_closed_ancestor_and_missing_history_fail_repeatedly() {
    let home = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    let mut edges = edges(&store, &ids).await;
    for (_, edge) in &mut edges {
        edge.status = ThreadSpawnEdgeStatus::Closed;
    }
    let mut histories = snapshots(&store, &ids).await;
    histories.get_mut(&ids[2]).unwrap().extend([
        started("effect"),
        call("unreceipted"),
        completed("effect"),
    ]);
    for _ in 0..2 {
        assert!(
            validate_local_tree(ids[0], &edges, &histories)
                .unwrap_err()
                .to_string()
                .contains("unknown tool effects")
        );
    }
    histories.remove(&ids[2]);
    assert!(validate_local_tree(ids[0], &edges, &histories).is_err());
    for id in ids {
        store.shutdown_thread(id).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stored_unknown_grandchild_below_closed_ancestor_fails_complete_tree_admission_twice() {
    // Storage/admission coverage with real native headers and rollouts, not a public close route.
    let home = tempfile::tempdir().unwrap();
    let (mut store, ids) = family(home.path()).await;
    append(
        &store,
        ids[0],
        vec![started("root-own"), completed("root-own")],
    )
    .await;
    append(
        &store,
        ids[1],
        vec![started("child-own"), completed("child-own")],
    )
    .await;
    append(
        &store,
        ids[2],
        vec![
            started("grandchild-own"),
            call("unreceipted-grandchild"),
            completed("grandchild-own"),
        ],
    )
    .await;
    store
        .graph
        .set_thread_spawn_edge_status(ids[1], ThreadSpawnEdgeStatus::Closed)
        .await
        .unwrap();
    for id in [ids[2], ids[1]] {
        store.shutdown_thread(id).await.unwrap();
    }
    for _ in 0..2 {
        // Discard the graph cache on each attempt; admission reads descendant histories from disk.
        store.graph = Arc::new(MemoryAgentGraph::local(store.state.clone()));
        store.graph.hydrate(ids[0]).await.unwrap();
        assert_eq!(
            store.graph.edge(ids[1]).await.unwrap().status,
            ThreadSpawnEdgeStatus::Closed
        );
        assert_eq!(
            store.graph.edge(ids[2]).await.unwrap().status,
            ThreadSpawnEdgeStatus::Open
        );
        let history = store.load_owned_history(ids[0]).await.unwrap();
        let writers = store.writers.lock().await;
        let error = store
            .check_tree_settled_inner(ids[0], &history, &writers)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("unknown tool effects"),
            "{error}"
        );
    }
    store.shutdown_thread(ids[0]).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn descendant_id_cannot_be_reopened_as_a_root() {
    let home = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    for child in &ids[1..] {
        let history = store.load_owned_history(*child).await.unwrap();
        assert!(validate_root_header(*child, &history).is_err());
        store.shutdown_thread(*child).await.unwrap();
        let error = store
            .resume_thread(tests::resume(*child, home.path()))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("root header identity"),
            "{error}"
        );
    }
    store.shutdown_thread(ids[0]).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn early_child_receipt_uses_child_writer_turn_and_call_and_survives_drain() {
    let home = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    let child = ids[2];
    append(&store, child, vec![started("own-turn"), call("owned-call")]).await;
    store
        .register_call(child, "own-turn", "owned-call")
        .await
        .unwrap();
    let key = crate::python_tools::PendingKey {
        reply: crate::python_tools::ReplyKey {
            thread: child.to_string(),
            generation: 0,
            slot: 0,
            instance: Some("current-child".into()),
            manual_grant: None,
        },
        turn: "own-turn".into(),
        call: "owned-call".into(),
    };
    let receipt = crate::python_tools::PythonOutput(
        serde_json::from_value(json!({
            "contentItems": [{"type": "inputText", "text": "real child receipt"}], "success": true
        }))
        .unwrap(),
    )
    .receipt(&key);
    assert!(
        store
            .commit_sdk_receipt(ids[0], &key, receipt.clone())
            .await
            .is_err()
    );
    let mut wrong = key.clone();
    wrong.turn = "parent-turn".into();
    assert!(
        store
            .commit_sdk_receipt(child, &wrong, receipt.clone())
            .await
            .is_err()
    );
    store
        .commit_sdk_receipt(child, &key, receipt.clone())
        .await
        .unwrap();
    append(
        &store,
        child,
        vec![
            RolloutItem::ResponseItem(ResponseItemEnvelope::new(receipt)),
            completed("own-turn"),
        ],
    )
    .await;
    let history = store.load_owned_history(child).await.unwrap();
    validate_settled(&history).unwrap();
    assert_eq!(history.iter().filter(|row| matches!(row,
        RolloutItem::ResponseItem(item) if matches!(&item.item,
            ResponseItem::FunctionCallOutput { call_id: Some(id), .. } if id == "owned-call")
    )).count(), 1);
    for id in ids {
        store.shutdown_thread(id).await.unwrap();
    }
}

pub(super) async fn root_profile(
    home: &Path,
) -> (Arc<LocalChecklistStore>, ThreadId, ResumeThreadParams) {
    let store = Arc::new(tests::store(home).await);
    let id = ThreadId::new();
    store
        .create_thread(tests::create_params(id, home))
        .await
        .unwrap();
    store
        .persist_thread(id, PersistContext::Standard)
        .await
        .unwrap();
    store.shutdown_thread(id).await.unwrap();
    let selected = store
        .load_latest_model_context(LoadThreadHistoryParams {
            thread_id: id,
            include_archived: true,
        })
        .await
        .unwrap();
    let mut params = tests::resume(id, home);
    params.history = Some(Arc::new(selected.items));
    params.history_revision = selected.revision;
    (store, id, params)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepared_writer_transfers_once_and_binds_current_native_inputs() {
    let home = tempfile::tempdir().unwrap();
    let (store, id, params) = root_profile(home.path()).await;
    let instructions = Arc::new(crate::options::ThreadInstructions::for_test(None, false));
    let admission = store
        .prepare_resume(
            params,
            None,
            instructions.clone(),
            Default::default(),
            Vec::new(),
        )
        .await
        .unwrap();
    let prepared = admission.prepared_params().unwrap().clone();
    let history = prepared.history.as_ref().unwrap();
    admission
        .validate(&store, id, history, &instructions)
        .unwrap();
    let competitor = tests::store(home.path()).await;
    assert!(
        competitor
            .resume_thread(tests::resume(id, home.path()))
            .await
            .is_err()
    );
    let consumed = store.resume_thread(prepared.clone()).await.unwrap();
    assert!(Arc::ptr_eq(history, &consumed));
    assert!(store.resume_thread(prepared).await.is_err());
    drop(admission);
    assert!(!store.writers.lock().await[&id].resume_cleanup_pending);
    store.shutdown_thread(id).await.unwrap();
    competitor
        .resume_thread(tests::resume(id, home.path()))
        .await
        .unwrap();
    competitor.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mismatched_prepared_claim_preserves_the_valid_consumer() {
    let home = tempfile::tempdir().unwrap();
    let (store, id, params) = root_profile(home.path()).await;
    let instructions = Arc::new(crate::options::ThreadInstructions::for_test(None, false));
    let admission = store
        .prepare_resume(
            params,
            None,
            instructions.clone(),
            Default::default(),
            Vec::new(),
        )
        .await
        .unwrap();
    let prepared = admission.prepared_params().unwrap().clone();
    for field in [
        "root", "path", "archive", "cwd", "provider", "memory", "history", "revision",
    ] {
        let mut wrong = prepared.clone();
        match field {
            "root" => wrong.thread_id = ThreadId::new(),
            "path" => wrong.rollout_path = Some(home.path().join("foreign-rollout")),
            "archive" => wrong.include_archived = false,
            "cwd" => wrong.metadata.cwd = Some(home.path().join("foreign-cwd")),
            "provider" => wrong.metadata.model_provider = "foreign-provider".into(),
            "memory" => {
                wrong.metadata.memory_mode = codex_protocol::protocol::ThreadMemoryMode::Enabled
            }
            "history" => {
                wrong.history = Some(Arc::new(
                    prepared.history.as_ref().unwrap().as_ref().clone(),
                ))
            }
            "revision" => wrong.history_revision = Some("foreign-revision".into()),
            _ => unreachable!(),
        }
        assert!(store.resume_thread(wrong).await.is_err(), "{field}");
        assert!(
            store
                .resume_admissions
                .lock()
                .unwrap()
                .active
                .contains_key(&id),
            "{field}"
        );
        assert!(store.writers.lock().await[&id].resume_cleanup_pending);
    }
    let foreign = Arc::new(crate::options::ThreadInstructions::for_test(None, false));
    assert!(
        admission
            .validate(&store, id, prepared.history.as_ref().unwrap(), &foreign)
            .is_err()
    );
    let consumed = store.resume_thread(prepared.clone()).await.unwrap();
    assert!(Arc::ptr_eq(&consumed, prepared.history.as_ref().unwrap()));
    drop(admission);
    store.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retired_prepared_writer_retains_failed_cleanup_for_close_retry() {
    let home = tempfile::tempdir().unwrap();
    let (store, id, params) = root_profile(home.path()).await;
    let admission = store
        .prepare_resume(
            params,
            None,
            Arc::new(crate::options::ThreadInstructions::for_test(None, false)),
            Default::default(),
            Vec::new(),
        )
        .await
        .unwrap();
    let stale = admission.prepared_params().unwrap().clone();
    drop(admission);
    assert!(store.resume_thread(stale).await.is_err());
    assert!(store.writers.lock().await[&id].resume_cleanup_pending);
    store.fail_writer_shutdown.store(true, Ordering::SeqCst);
    assert!(store.close_database().await.is_err());
    assert!(store.writers.lock().await.contains_key(&id));
    store.fail_writer_shutdown.store(false, Ordering::SeqCst);
    store.close_database().await.unwrap();
    assert!(!store.writers.lock().await.contains_key(&id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_before_and_after_native_registration_retires_the_same_owner() {
    for point in [
        StartupClosePoint::BeforePreparedAcquire,
        StartupClosePoint::PreparedNativeWriter,
    ] {
        let home = tempfile::tempdir().unwrap();
        let (store, id, params) = root_profile(home.path()).await;
        let probe = StartupCloseProbe::new(Some(id), point);
        *store.startup_close_probe.lock().unwrap() = Some(probe.clone());
        let opening = store.clone();
        let operation = tokio::spawn(async move {
            let _admission = opening
                .prepare_resume(
                    params,
                    None,
                    Arc::new(crate::options::ThreadInstructions::for_test(None, false)),
                    Default::default(),
                    Vec::new(),
                )
                .await?;
            Ok::<(), anyhow::Error>(())
        });
        probe.entered.acquire().await.unwrap().forget();
        operation.abort();
        assert!(operation.await.unwrap_err().is_cancelled());
        probe.release.add_permits(1);
        // close_database joins the retained worker through the existing writer
        // mutex and then drains its exact pending recorder before closing SQLite.
        store.close_database().await.unwrap();
        assert!(!store.writers.lock().await.contains_key(&id));
        assert!(store.resume_admissions.lock().unwrap().active.is_empty());
    }
}

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
    recovery_family(home).await
}

async fn recovery_family<const N: usize>(home: &Path) -> (LocalChecklistStore, [ThreadId; N]) {
    let store = tests::store(home).await;
    let ids = std::array::from_fn(|_| ThreadId::new());
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

async fn validate_local_tree(
    store: &LocalChecklistStore,
    ids: [ThreadId; 3],
    edges: &[(ThreadId, SpawnEdge)],
    histories: &HashMap<ThreadId, Vec<RolloutItem>>,
) -> anyhow::Result<()> {
    let mut sources = Vec::new();
    for (index, id) in ids.into_iter().enumerate() {
        let items = histories
            .get(&id)
            .ok_or_else(|| anyhow::anyhow!("missing audit"))?;
        let parent = if index == 0 {
            None
        } else {
            Some((index - 1, &sources[index - 1], edges[index - 1].1.status))
        };
        sources.push(RecoverySource::from_items(id, PathBuf::new(), items.clone(), parent).await?);
    }
    plan_recovery_tree(&store.inner, &sources, &histories[&ids[0]], Vec::new()).await?;
    Ok(())
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
        validate_local_tree(&store, ids, &edges, &histories)
            .await
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
    validate_local_tree(&store, ids, &edges, &histories)
        .await
        .unwrap();
    histories
        .get_mut(&ids[2])
        .unwrap()
        .push(started("unfinished-without-tool"));
    validate_local_tree(&store, ids, &edges, &histories)
        .await
        .unwrap();
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
            validate_local_tree(&store, ids, &edges, &histories)
                .await
                .unwrap_err()
                .to_string()
                .contains("unknown tool effects")
        );
    }
    histories
        .get_mut(&ids[0])
        .unwrap()
        .push(started("unrelated-root"));
    assert!(
        validate_local_tree(&store, ids, &edges, &histories)
            .await
            .unwrap_err()
            .to_string()
            .contains("unrelated active")
    );
    histories.remove(&ids[2]);
    assert!(
        validate_local_tree(&store, ids, &edges, &histories)
            .await
            .is_err()
    );
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
        vec![
            started("child-own"),
            completed("child-own"),
            started("safe-current-child"),
        ],
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
        let path = store.inner.live_rollout_path(ids[0]).await.unwrap();
        let edges = store.recovery_edges(ids[0]).await.unwrap();
        let root = RecoverySource::read(ids[0], path, None).await.unwrap();
        let sources = store.read_recovery_sources(root, &edges).await.unwrap();
        let history = store.load_owned_history(ids[0]).await.unwrap();
        let error = plan_recovery_tree(&store.inner, &sources, &history, Vec::new())
            .await
            .err()
            .expect("unknown grandchild holds admission");
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
fn spawn(id: &str, child: ThreadId) -> Vec<RolloutItem> {
    vec![
        RolloutItem::ResponseItem(ResponseItemEnvelope::new(
            serde_json::from_value(json!({
                "type": "function_call", "name": "spawn_agent", "namespace": "collaboration",
                "call_id": id, "arguments": "{}"
            }))
            .unwrap(),
        )),
        RolloutItem::EventMsg(
            serde_json::from_value(json!({
                "type": "sub_agent_activity", "kind": "started", "event_id": id,
                "agent_thread_id": child, "agent_path": "/root/child"
            }))
            .unwrap(),
        ),
        RolloutItem::ResponseItem(ResponseItemEnvelope::new(
            serde_json::from_value(json!({
                "type": "function_call_output", "call_id": id, "output": "{\"task_name\":\"/root/child\"}"
            }))
            .unwrap(),
        )),
    ]
}

fn recovery_receipt(thread: ThreadId, turn: &str) -> Receipt {
    serde_json::from_value(json!({
        "threadId": thread, "turnId": turn, "callId": "effect",
        "outcome": "not_applied", "result": "confirmed absent"
    }))
    .unwrap()
}

const RECOVERY_FIXTURE_MODEL: &str = "synthetic-model";

fn legacy_context(home: &Path, turn: &str) -> RolloutItem {
    use codex_protocol::protocol::{AskForApproval, SandboxPolicy};

    serde_json::from_value(json!({
        "type": "turn_context",
        "payload": {
            "turn_id": turn,
            "cwd": home,
            "approval_policy": AskForApproval::Never,
            "sandbox_policy": SandboxPolicy::new_read_only_policy(),
            "model": RECOVERY_FIXTURE_MODEL,
            "summary": "auto",
        },
    }))
    .unwrap()
}

async fn prepare_recovery<'a>(
    store: &'a Arc<LocalChecklistStore>,
    home: &Path,
    root: ThreadId,
    receipts: Vec<Receipt>,
) -> anyhow::Result<LocalResumeAdmission<'a>> {
    let model = store
        .load_latest_model_context(LoadThreadHistoryParams {
            thread_id: root,
            include_archived: true,
        })
        .await?;
    let mut params = tests::resume(root, home);
    params.history = Some(Arc::new(model.items));
    params.history_revision = model.revision;
    store
        .prepare_resume(
            params,
            Some(RECOVERY_FIXTURE_MODEL.to_owned()),
            Arc::new(crate::options::ThreadInstructions::for_test(None, false)),
            Default::default(),
            receipts,
        )
        .await
}

async fn rollout_paths(store: &LocalChecklistStore, ids: &[ThreadId]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for id in ids {
        paths.push(store.inner.live_rollout_path(*id).await.unwrap());
    }
    paths
}

async fn bytes(paths: &[PathBuf]) -> Vec<Vec<u8>> {
    let mut result = Vec::new();
    for path in paths {
        result.push(tokio::fs::read(path).await.unwrap());
    }
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cold_safe_descendant_interruption_survives_partial_publication_and_reopen() {
    let home = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    let [root, child, leaf] = ids;
    let paths = rollout_paths(&store, &ids).await;
    append(
        &store,
        root,
        [
            vec![started("root"), legacy_context(home.path(), "root")],
            spawn("spawn-child", child),
        ]
        .concat(),
    )
    .await;
    append(
        &store,
        child,
        [vec![started("child")], spawn("spawn-leaf", leaf)].concat(),
    )
    .await;
    append(&store, leaf, vec![started("leaf")]).await;
    for id in ids.into_iter().rev() {
        store.shutdown_thread(id).await.unwrap();
    }
    let store = Arc::new(store);
    let original = bytes(&paths).await;
    for _ in 0..2 {
        *store.fail_recovery_write.lock().unwrap() =
            Some((child, RecoveryWritePoint::BeforeDirectorySync));
        let error = prepare_recovery(&store, home.path(), root, Vec::new())
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("injected failure"), "{error}");
        assert_eq!(bytes(&paths).await[2], original[2]);
    }
    // Retry must sync an already visible leaf abort after directory sync fails.
    for _ in 0..2 {
        *store.fail_recovery_write.lock().unwrap() =
            Some((leaf, RecoveryWritePoint::BeforeDirectorySync));
        let error = prepare_recovery(&store, home.path(), root, Vec::new())
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("injected failure"), "{error}");
    }
    let admitted = prepare_recovery(&store, home.path(), root, Vec::new())
        .await
        .unwrap();
    let prepared = admitted.prepared_params().unwrap().clone();
    store.resume_thread(prepared).await.unwrap();
    drop(admitted);
    store.shutdown_thread(root).await.unwrap();
    let recovered = bytes(&paths).await;
    for (index, bytes) in recovered.iter().enumerate() {
        assert!(bytes.starts_with(&original[index]));
        assert_eq!(
            String::from_utf8_lossy(bytes)
                .matches("\"turn_aborted\"")
                .count(),
            1
        );
        assert!(String::from_utf8_lossy(bytes).contains("interrupted"));
    }
    let admitted = prepare_recovery(&store, home.path(), root, Vec::new())
        .await
        .unwrap();
    drop(admitted);
    assert_eq!(bytes(&paths).await, recovered);
    store.close_database().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copied_legacy_calls_keep_their_owner_across_partial_replacement_and_retry() {
    let home = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    let paths = rollout_paths(&store, &ids).await;
    let [root, child, leaf] = ids;
    let copied_root = || {
        vec![
            started("root"),
            legacy_context(home.path(), "root"),
            call("effect"),
        ]
    };
    append(
        &store,
        root,
        [copied_root(), spawn("spawn-child", child)].concat(),
    )
    .await;
    append(
        &store,
        child,
        [
            copied_root(),
            vec![started("child")],
            spawn("spawn-leaf", leaf),
        ]
        .concat(),
    )
    .await;
    append(&store, leaf, vec![started("leaf"), call("effect")]).await;
    for id in ids.into_iter().rev() {
        store.shutdown_thread(id).await.unwrap();
    }
    let store = Arc::new(store);
    let original = bytes(&paths).await;
    let hold = prepare_recovery(&store, home.path(), root, Vec::new())
        .await
        .err()
        .unwrap()
        .downcast::<local_reconciliation::RecoveryRequired>()
        .unwrap();
    let calls = serde_json::to_value(hold.calls).unwrap();
    assert_eq!(calls.as_array().unwrap().len(), 2);
    for (index, (id, turn)) in [(root, "root"), (leaf, "leaf")].into_iter().enumerate() {
        assert_eq!(calls[index]["threadId"], id.to_string());
        assert_eq!(calls[index]["turnId"], turn);
    }
    let receipts = || {
        vec![
            recovery_receipt(root, "root"),
            recovery_receipt(leaf, "leaf"),
        ]
    };
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        let original_leaf = paths[2].with_extension("saved");
        let foreign = outside.path().join("leaf.jsonl");
        tokio::fs::rename(&paths[2], &original_leaf).await.unwrap();
        tokio::fs::copy(&paths[0], &foreign).await.unwrap();
        tokio::fs::symlink(&foreign, &paths[2]).await.unwrap();
        let error = prepare_recovery(&store, home.path(), root, receipts())
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("belongs to thread"), "{error}");
        assert_eq!(tokio::fs::read(&foreign).await.unwrap(), original[0]);
        tokio::fs::remove_file(&paths[2]).await.unwrap();
        tokio::fs::rename(original_leaf, &paths[2]).await.unwrap();
        assert_eq!(bytes(&paths).await, original);
    }
    let mut partial = receipts();
    partial.pop();
    assert!(
        prepare_recovery(&store, home.path(), root, partial)
            .await
            .is_err()
    );
    assert_eq!(bytes(&paths).await, original);

    // First replace the abort-only ancestor, then fail its directory sync
    // again on retry. The retry must reach that sync before changing the leaf.
    for _ in 0..2 {
        *store.fail_recovery_write.lock().unwrap() =
            Some((child, RecoveryWritePoint::BeforeDirectorySync));
        let error = prepare_recovery(&store, home.path(), root, receipts())
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("injected failure"), "{error}");
        let current = bytes(&paths).await;
        assert!(current[1].starts_with(&original[1]));
        assert_eq!(
            String::from_utf8_lossy(&current[1])
                .matches("\"turn_aborted\"")
                .count(),
            1
        );
        assert_eq!(current[2], original[2]);
    }

    for point in [
        RecoveryWritePoint::BeforeReplace,
        RecoveryWritePoint::BeforeDirectorySync,
    ] {
        *store.fail_recovery_write.lock().unwrap() = Some((leaf, point));
        let error = prepare_recovery(&store, home.path(), root, receipts())
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("injected failure"), "{error}");
        let current = bytes(&paths).await;
        for (index, saved) in current.iter().enumerate() {
            assert!(saved.starts_with(&original[index]));
            assert_eq!(
                String::from_utf8_lossy(saved)
                    .matches("sdk_reconciliation.not_applied")
                    .count(),
                usize::from(
                    index == 0 || index == 2 && point == RecoveryWritePoint::BeforeDirectorySync
                ),
            );
        }
    }
    let final_bytes = bytes(&paths).await;
    for source in [root, leaf] {
        *store.fail_recovery_write.lock().unwrap() =
            Some((source, RecoveryWritePoint::BeforeDirectorySync));
        let error = prepare_recovery(&store, home.path(), root, Vec::new())
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("injected failure"), "{error}");
        assert_eq!(bytes(&paths).await, final_bytes);
    }
    let admitted = prepare_recovery(&store, home.path(), root, receipts())
        .await
        .unwrap();
    assert_eq!(
        admitted.protected_call_ids(),
        &HashSet::from(["effect".to_owned()])
    );
    assert_eq!(bytes(&paths).await, final_bytes);
    let params = admitted.prepared_params().unwrap().clone();
    store.resume_thread(params).await.unwrap();
    drop(admitted);
    store.shutdown_thread(root).await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staged_compressed_root_alias_is_readable_before_writer_sync() {
    staged_root_alias_is_readable_before_writer_sync(false).await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staged_root_uses_the_already_materialized_rollout() {
    staged_root_alias_is_readable_before_writer_sync(true).await;
}

#[cfg(unix)]
async fn staged_root_alias_is_readable_before_writer_sync(already_materialized: bool) {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (store, [root, child]) = recovery_family(home.path()).await;
    let paths = rollout_paths(&store, &[root, child]).await;
    append(
        &store,
        root,
        [
            vec![
                started("root"),
                legacy_context(home.path(), "root"),
                call("effect"),
            ],
            spawn("spawn-child", child),
        ]
        .concat(),
    )
    .await;
    append(&store, child, vec![started("child"), call("effect")]).await;
    let original = snapshots(&store, &[root, child]).await;
    for id in [child, root] {
        store.shutdown_thread(id).await.unwrap();
    }

    let plain = &paths[0];
    let alias = plain.with_extension("jsonl.zst");
    let target = outside.path().join(alias.file_name().unwrap());
    let audit = tokio::fs::read(plain).await.unwrap();
    let compressed =
        zstd::stream::encode_all(audit.as_slice(), zstd::DEFAULT_COMPRESSION_LEVEL).unwrap();
    tokio::fs::write(&target, &compressed).await.unwrap();
    tokio::fs::remove_file(plain).await.unwrap();
    tokio::fs::symlink(&target, &alias).await.unwrap();
    let materialized = codex_rollout::plain_rollout_path(&target);
    let child_shadow = if already_materialized {
        // Core publishes the plain sibling before it removes the compressed source.
        tokio::fs::write(&materialized, &audit).await.unwrap();

        let child_path = &paths[1];
        let child_audit = tokio::fs::read_to_string(child_path).await.unwrap();
        let (header, body) = child_audit.split_once('\n').unwrap();
        let mut header: serde_json::Value = serde_json::from_str(header).unwrap();
        // Older persisted headers select Legacy through the missing field default.
        assert_eq!(
            header["payload"]
                .as_object_mut()
                .unwrap()
                .remove("history_mode"),
            Some(json!("legacy"))
        );
        let child_audit = format!("{header}\n{body}");
        let child_alias = child_path.with_extension("jsonl.zst");
        let child_target = outside.path().join(child_alias.file_name().unwrap());
        let child_compressed =
            zstd::stream::encode_all(child_audit.as_bytes(), zstd::DEFAULT_COMPRESSION_LEVEL)
                .unwrap();
        tokio::fs::write(&child_target, &child_compressed)
            .await
            .unwrap();
        tokio::fs::write(
            codex_rollout::plain_rollout_path(&child_target),
            child_audit,
        )
        .await
        .unwrap();
        tokio::fs::remove_file(child_path).await.unwrap();
        tokio::fs::symlink(&child_target, &child_alias)
            .await
            .unwrap();
        Some((child_alias, child_target, child_compressed))
    } else {
        None
    };

    let store = Arc::new(store);
    let probe = StartupCloseProbe::new(Some(root), StartupClosePoint::PreparedNativeWriter);
    *store.startup_close_probe.lock().unwrap() = Some(probe.clone());
    let mut opening = tokio::spawn({
        let store = store.clone();
        let home = home.path().to_path_buf();
        async move {
            let _admission = prepare_recovery(
                &store,
                &home,
                root,
                vec![
                    recovery_receipt(root, "root"),
                    recovery_receipt(child, "child"),
                ],
            )
            .await?;
            Ok::<(), anyhow::Error>(())
        }
    });
    tokio::select! {
        entered = probe.entered.acquire() => entered.unwrap().forget(),
        result = &mut opening => panic!("admission ended before writer handoff: {result:?}"),
    }

    if already_materialized {
        assert_eq!(tokio::fs::read_link(&alias).await.unwrap(), target);
        assert_eq!(tokio::fs::read(&target).await.unwrap(), compressed);
    } else {
        assert!(!alias.exists());
    }
    let staged = tokio::fs::read_to_string(materialized).await.unwrap();
    assert!(staged.contains("sdk_reconciliation.not_applied"));

    let cold = tests::store(home.path()).await;
    for (id, turn) in [(root, "root"), (child, "child")] {
        let recovered = cold
            .load_history(LoadThreadHistoryParams {
                thread_id: id,
                include_archived: true,
            })
            .await
            .expect("a fresh store can read the staged audit before writer sync");
        assert_eq!(recovered.thread_id, id);
        assert!(recovered.revision.is_some());
        let mut expected = original[&id].clone();
        expected.push(RolloutItem::ResponseItem(ResponseItemEnvelope::new(
            serde_json::from_value(json!({
                "type": "function_call_output", "call_id": "effect",
                "name": "managed", "output": "confirmed absent",
                "internal_chat_message_metadata_passthrough": {
                    "turn_id": turn, "content_item_kinds": ["sdk_reconciliation.not_applied"]
                }
            }))
            .unwrap(),
        )));
        expected.push(RolloutItem::EventMsg(
            serde_json::from_value(json!({
                "type": "turn_aborted", "turn_id": turn, "reason": "interrupted"
            }))
            .unwrap(),
        ));
        assert_eq!(
            serde_json::to_value(recovered.items).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }
    if let Some((alias, target, compressed)) = child_shadow {
        assert_eq!(tokio::fs::read_link(&alias).await.unwrap(), target);
        assert_eq!(tokio::fs::read(&alias).await.unwrap(), compressed);
    }
    probe.release.add_permits(1);
    opening.await.unwrap().unwrap();
    store.close_database().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compressed_descendant_alias_survives_failure_before_replacement() {
    use std::os::unix::fs::PermissionsExt;

    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    let [root, parent, child] = ids;
    let paths = rollout_paths(&store, &ids).await;
    append(
        &store,
        root,
        [
            vec![started("root"), legacy_context(home.path(), "root")],
            spawn("spawn-parent", parent),
            vec![completed("root")],
        ]
        .concat(),
    )
    .await;
    append(
        &store,
        parent,
        [
            vec![started("parent")],
            spawn("spawn-child", child),
            vec![completed("parent")],
        ]
        .concat(),
    )
    .await;
    append(&store, child, vec![started("child"), call("effect")]).await;
    for id in ids.into_iter().rev() {
        store.shutdown_thread(id).await.unwrap();
    }
    let store = Arc::new(store);
    let plain = &paths[2];
    let audit = tokio::fs::read(plain).await.unwrap();
    let original =
        zstd::stream::encode_all(audit.as_slice(), zstd::DEFAULT_COMPRESSION_LEVEL).unwrap();
    let alias = plain.with_extension("jsonl.zst");
    let target = outside.path().join(alias.file_name().unwrap());
    tokio::fs::write(&target, &original).await.unwrap();
    let mode = 0o640;
    tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))
        .await
        .unwrap();
    tokio::fs::remove_file(plain).await.unwrap();
    tokio::fs::symlink(&target, &alias).await.unwrap();

    let receipts = || vec![recovery_receipt(child, "child")];
    *store.fail_recovery_write.lock().unwrap() = Some((child, RecoveryWritePoint::BeforeReplace));
    let error = prepare_recovery(&store, home.path(), root, receipts())
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("injected failure"), "{error}");
    assert_eq!(tokio::fs::read_link(&alias).await.unwrap(), target);
    assert_eq!(tokio::fs::read(&alias).await.unwrap(), original);

    let admitted = prepare_recovery(&store, home.path(), root, receipts())
        .await
        .unwrap();
    assert_eq!(tokio::fs::read_link(&alias).await.unwrap(), target);
    assert_eq!(
        tokio::fs::metadata(&alias)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        mode
    );
    let encoded = tokio::fs::read(&alias).await.unwrap();
    let decoded = zstd::stream::decode_all(encoded.as_slice()).unwrap();
    assert_eq!(
        zstd::zstd_safe::get_frame_content_size(&encoded).unwrap(),
        Some(decoded.len() as u64)
    );
    assert!(decoded.starts_with(&audit));
    let (_, owner, errors) = codex_rollout::RolloutRecorder::load_rollout_items(&alias)
        .await
        .unwrap();
    assert_eq!((owner, errors), (Some(child), 0));
    assert_eq!(
        String::from_utf8_lossy(&decoded)
            .matches("sdk_reconciliation.not_applied")
            .count(),
        1
    );
    drop(admitted);
    store.close_database().await.unwrap();
}

const CHILD_OWNER_PROFILE: &str = "AGENTS_SDK_RECOVERY_CHILD_OWNER_PROFILE";
const CHILD_OWNER_ID: &str = "AGENTS_SDK_RECOVERY_CHILD_OWNER_ID";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_child_writer_fixture() {
    let Some(home) = std::env::var_os(CHILD_OWNER_PROFILE).map(PathBuf::from) else {
        return;
    };
    let child = ThreadId::from_string(&std::env::var(CHILD_OWNER_ID).unwrap()).unwrap();
    let store = tests::store(&home).await;
    store
        .inner
        .resume_thread(tests::resume(child, &home))
        .await
        .unwrap();
    tokio::fs::write(home.join("child-writer-ready"), [])
        .await
        .unwrap();
    let mut input = [0];
    if std::io::Read::read_exact(&mut std::io::stdin().lock(), &mut input).is_ok() {
        store
            .inner
            .append_items(AppendThreadItemsParams {
                thread_id: child,
                items: vec![started("surviving-writer"), completed("surviving-writer")],
            })
            .await
            .unwrap();
    }
    store.inner.shutdown_thread(child).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn root_admission_fences_an_independent_core_child_writer_below_a_closed_edge() {
    let home = tempfile::tempdir().unwrap();
    let (store, ids) = family(home.path()).await;
    let [root, parent, child] = ids;
    let paths = rollout_paths(&store, &ids).await;
    append(
        &store,
        root,
        vec![
            started("root"),
            legacy_context(home.path(), "root"),
            completed("root"),
        ],
    )
    .await;
    append(&store, parent, vec![started("parent"), completed("parent")]).await;
    append(
        &store,
        child,
        vec![started("child"), call("effect"), completed("child")],
    )
    .await;
    store
        .graph
        .set_thread_spawn_edge_status(parent, ThreadSpawnEdgeStatus::Closed)
        .await
        .unwrap();
    for id in ids.into_iter().rev() {
        store.shutdown_thread(id).await.unwrap();
    }
    let store = Arc::new(store);
    let initial = bytes(&paths).await;
    let mut worker = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "local_storage::local_descendant_admission_tests::independent_child_writer_fixture",
            "--nocapture",
        ])
        .env(CHILD_OWNER_PROFILE, home.path())
        .env(CHILD_OWNER_ID, child.to_string())
        .env_remove("OPENAI_API_KEY")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !home.path().join("child-writer-ready").exists() {
            assert!(
                worker.try_wait().unwrap().is_none(),
                "child writer exited before claiming the lease"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let error = prepare_recovery(
        &store,
        home.path(),
        root,
        vec![recovery_receipt(child, "child")],
    )
    .await
    .err()
    .unwrap();
    assert!(error.to_string().contains("active writer"), "{error}");
    assert_eq!(bytes(&paths).await, initial);
    worker.stdin.take().unwrap().write_all(&[1]).unwrap();
    assert!(worker.wait().unwrap().success());
    assert!(String::from_utf8_lossy(&bytes(&paths).await[2]).contains("surviving-writer"));
    let admitted = prepare_recovery(
        &store,
        home.path(),
        root,
        vec![recovery_receipt(child, "child")],
    )
    .await
    .unwrap();
    drop(admitted);
    store.close_database().await.unwrap();
}

//! Real local writer admission; no model transport or second execution engine.
use super::*;
use crate::application_instructions;
use crate::options::ThreadInstructions;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::Ordering;

fn owner(text: &str) -> Arc<ThreadInstructions> {
    Arc::new(ThreadInstructions::for_test(Some(text.to_owned()), true))
}

fn projected(original: &ResponseItem) -> ResponseItem {
    let mut value = serde_json::to_value(original).unwrap();
    value["id"] = json!(format!("msg_{}", ThreadId::new()));
    value["internal_chat_message_metadata_passthrough"]["content_item_kinds"] =
        json!(["sdk_application.instructions"]);
    serde_json::from_value(value).unwrap()
}

fn row(item: ResponseItem) -> RolloutItem {
    RolloutItem::ResponseItem(item.into())
}

fn compacted(original: &ResponseItem) -> RolloutItem {
    serde_json::from_value(json!({
        "type": "compacted",
        "payload": {
            "message": "ordinary compaction",
            "replacement_history": [projected(original)],
            "window_number": 1
        }
    }))
    .unwrap()
}

async fn append(owner: &LocalChecklistStore, id: ThreadId, items: Vec<RolloutItem>) {
    owner
        .append_items(AppendThreadItemsParams {
            thread_id: id,
            items,
        })
        .await
        .unwrap();
    owner.flush_thread(id).await.unwrap();
}

async fn saved(home: &Path, items: Vec<RolloutItem>) -> (LocalChecklistStore, ThreadId) {
    let owner = tests::store(home).await;
    let id = ThreadId::new();
    let mut params = tests::create_params(id, home);
    params.history_mode = ThreadHistoryMode::Paginated;
    owner.create_thread(params).await.unwrap();
    owner
        .persist_thread(id, PersistContext::Standard)
        .await
        .unwrap();
    append(&owner, id, items).await;
    owner.shutdown_thread(id).await.unwrap();
    (owner, id)
}

async fn replay(
    owner: &LocalChecklistStore,
    id: ThreadId,
    home: &Path,
) -> (Arc<Vec<RolloutItem>>, ResumeThreadParams) {
    let selected = owner
        .load_latest_model_context(LoadThreadHistoryParams {
            thread_id: id,
            include_archived: true,
        })
        .await
        .unwrap();
    let history = Arc::new(selected.items);
    let mut params = tests::resume(id, home);
    params.history = Some(history.clone());
    params.history_revision = selected.revision;
    (history, params)
}

async fn complete(owner: &LocalChecklistStore, id: ThreadId) -> Vec<RolloutItem> {
    owner
        .load_history(LoadThreadHistoryParams {
            thread_id: id,
            include_archived: true,
        })
        .await
        .unwrap()
        .items
}

#[tokio::test]
async fn local_writer_rechecks_plan_binding_after_preflight() {
    let home = tempfile::tempdir().unwrap();
    let store = tests::store(home.path()).await;
    let id = ThreadId::new();
    let binding = format!("{CHATGPT_PLAN_PROVIDER_PREFIX}{}", "a".repeat(64));
    let changed_binding = format!("{CHATGPT_PLAN_PROVIDER_PREFIX}{}", "b".repeat(64));
    let mut create = tests::create_params(id, home.path());
    create.metadata.model_provider.clone_from(&binding);
    store.create_thread(create).await.unwrap();
    store
        .persist_thread(id, PersistContext::Standard)
        .await
        .unwrap();
    store.flush_thread(id).await.unwrap();
    store.shutdown_thread(id).await.unwrap();

    let saved = store
        .read_thread(ReadThreadParams {
            thread_id: id,
            include_archived: true,
            include_history: false,
        })
        .await
        .unwrap();
    store
        .validate_resume_binding(&saved, &binding)
        .await
        .unwrap();
    let (_, mut resume) = replay(&store, id, home.path()).await;
    let path = saved.rollout_path.unwrap();
    resume.rollout_path = Some(path.clone());
    resume.metadata.model_provider = binding.clone();

    let original = std::fs::read_to_string(&path).unwrap();
    let changed = original.replacen(&binding, &changed_binding, 1);
    assert_ne!(changed, original);
    std::fs::write(&path, &changed).unwrap();
    let error = store.inner.resume_thread(resume.clone()).await.unwrap_err();
    assert!(error.to_string().contains("matching Sign in with ChatGPT"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), changed);

    std::fs::write(&path, original).unwrap();
    store.inner.resume_thread(resume).await.unwrap();
    store.inner.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn constructor_model_expectation_survives_drop_and_acquisition_failure() {
    let home = tempfile::tempdir().unwrap();
    let (store, id) = saved(home.path(), Vec::new()).await;
    let initial_model = Some("model-before-construction-finished".to_owned());
    store.expect_resume_model(id, initial_model.clone());
    let instructions = Arc::new(ThreadInstructions::for_test(None, false));

    let (history, _) = replay(&store, id, home.path()).await;
    let abandoned = store
        .admit_resume(id, None, history, instructions.clone())
        .unwrap();
    assert_eq!(abandoned.expected.model, initial_model);
    drop(abandoned);
    assert_eq!(
        store.resume_admissions.lock().unwrap().initial,
        Some((id, initial_model.clone()))
    );
    assert!(
        store
            .resume_thread(tests::resume(id, home.path()))
            .await
            .is_err()
    );

    let competitor = tests::store(home.path()).await;
    competitor
        .resume_thread(tests::resume(id, home.path()))
        .await
        .unwrap();
    let (history, params) = replay(&store, id, home.path()).await;
    let blocked = store
        .admit_resume(id, None, history, instructions.clone())
        .unwrap();
    assert!(store.resume_thread(params).await.is_err());
    drop(blocked);
    assert_eq!(
        store.resume_admissions.lock().unwrap().initial,
        Some((id, initial_model.clone()))
    );
    competitor.shutdown_thread(id).await.unwrap();

    let (history, params) = replay(&store, id, home.path()).await;
    let admitted = store
        .admit_resume(id, None, history, instructions.clone())
        .unwrap();
    let error = store.resume_thread(params).await.unwrap_err().to_string();
    assert!(error.contains("model changed"), "{error}");
    assert!(store.resume_admissions.lock().unwrap().initial.is_none());
    assert!(store.writers.lock().await.is_empty());
    drop(admitted);

    // A later opening uses its current saved model after successful acquisition
    // consumed the constructor's one-time expectation, even if validation failed.
    let (history, params) = replay(&store, id, home.path()).await;
    let current = store.admit_resume(id, None, history, instructions).unwrap();
    assert_eq!(current.expected.model, None);
    store.resume_thread(params).await.unwrap();
    store.shutdown_thread(id).await.unwrap();
    drop(current);
    store.close_database().await.unwrap();
    competitor.close_database().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compacted_window_uses_full_audit_to_seed_the_exact_owner() {
    let home = tempfile::tempdir().unwrap();
    let original = application_instructions::publication("  trusted\n");
    let (store, id) = saved(
        home.path(),
        vec![row(original.clone()), compacted(&original)],
    )
    .await;
    let (history, params) = replay(&store, id, home.path()).await;
    assert!(application_instructions::validate(&history, "  trusted\n").is_err());
    let audit = complete(&store, id).await;
    let expected = application_instructions::validate(&audit, "  trusted\n").unwrap();
    assert!(expected.is_some());
    let instructions = owner("  trusted\n");
    let unrelated = owner("  trusted\n");
    let admission = store
        .admit_resume(id, None, history.clone(), instructions.clone())
        .unwrap();
    admission
        .validate(&store, id, &history, &instructions)
        .unwrap();
    let resumed = store.resume_thread(params).await.unwrap();
    assert_eq!(instructions.accepted(), expected);
    assert!(unrelated.accepted().is_none());
    assert!(!instructions.needs_publication(true));
    assert_eq!(
        serde_json::to_value(&*resumed).unwrap(),
        serde_json::to_value(&*history).unwrap()
    );
    // Consuming metadata ends the borrowed shortcut, even while its guard exists.
    assert!(
        admission
            .validate(&store, id, &history, &instructions)
            .is_err()
    );
    let after = complete(&store, id).await;
    assert_eq!(application_instructions::latest(&after).unwrap(), expected);
    store.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admission_checks_store_thread_history_owner_and_registration() {
    let home = tempfile::tempdir().unwrap();
    let other_home = tempfile::tempdir().unwrap();
    let store = tests::store(home.path()).await;
    let other = tests::store(other_home.path()).await;
    let id = ThreadId::new();
    let history = Arc::new(Vec::new());
    let instructions = owner("trusted");
    let admission = store
        .admit_resume(id, None, history.clone(), instructions.clone())
        .unwrap();
    admission
        .validate(&store, id, &history, &instructions)
        .unwrap();
    assert!(
        admission
            .validate(&other, id, &history, &instructions)
            .is_err()
    );
    assert!(
        admission
            .validate(&store, ThreadId::new(), &history, &instructions)
            .is_err()
    );
    assert!(
        admission
            .validate(&store, id, &Arc::new(Vec::new()), &instructions)
            .is_err()
    );
    assert!(
        admission
            .validate(&store, id, &history, &owner("trusted"))
            .is_err()
    );
    assert!(
        store
            .admit_resume(id, None, history.clone(), instructions.clone())
            .is_err()
    );
    drop(admission);
    assert!(store.resume_admissions.lock().unwrap().active.is_empty());
    let retry = store
        .admit_resume(
            id,
            Some("new model".into()),
            history.clone(),
            instructions.clone(),
        )
        .unwrap();
    retry.validate(&store, id, &history, &instructions).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_core_acquisition_cannot_consume_the_next_same_id_admission() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let home = tempfile::tempdir().unwrap();
        let original = application_instructions::publication("trusted");
        let (store, id) = saved(
            home.path(),
            vec![row(original.clone()), compacted(&original)],
        )
        .await;
        let store = Arc::new(store);
        let (history_a, params_a) = replay(&store, id, home.path()).await;
        let owner_a = owner("trusted");
        let admission_a = store
            .admit_resume(id, None, history_a, owner_a.clone())
            .unwrap();
        let entered = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let signal = entered.clone();
        let held = release.clone();
        let native_store: Arc<dyn ThreadStore> = store.clone();
        let mut guard = LiveThreadInitGuard::new(None);
        let mut opening_a = Box::pin(guard.acquire(async move {
            signal.add_permits(1);
            held.acquire().await.unwrap().forget();
            let (live, _) =
                LiveThread::resume(native_store, ThreadHistoryMode::Paginated, params_a).await?;
            Ok(live)
        }));
        tokio::select! { biased;
            _ = &mut opening_a => panic!("opening escaped callback barrier"),
            permit = entered.acquire() => permit.unwrap().forget()
        }
        // Core retains A's exact acquisition, but A's SDK opening is canceled.
        drop(opening_a);
        drop(admission_a);
        let (history_b, params_b) = replay(&store, id, home.path()).await;
        let owner_b = owner("trusted");
        let admission_b = store
            .admit_resume(id, None, history_b.clone(), owner_b.clone())
            .unwrap();
        release.add_permits(1);
        let error = guard.discard().await.unwrap_err();
        assert!(error.to_string().contains("another opening"), "{error}");
        assert!(guard.as_ref().is_none());
        assert!(owner_a.accepted().is_none());
        assert!(owner_b.accepted().is_none());
        admission_b
            .validate(&store, id, &history_b, &owner_b)
            .unwrap();
        store.resume_thread(params_b).await.unwrap();
        assert!(owner_a.accepted().is_none());
        assert!(owner_b.accepted().is_some());
        store.shutdown_thread(id).await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claimed_acquisition_keeps_its_owner_and_old_drop_cannot_erase_new_metadata() {
    let home = tempfile::tempdir().unwrap();
    let original = application_instructions::publication("trusted");
    let (store, id) = saved(home.path(), vec![row(original)]).await;
    let (history_a, params_a) = replay(&store, id, home.path()).await;
    let (history_b, _) = replay(&store, id, home.path()).await;
    let owner_a = owner("trusted");
    let owner_b = owner("trusted");
    let admission_a = store
        .admit_resume(id, None, history_a, owner_a.clone())
        .unwrap();
    let gate = store.writers.lock().await;
    let mut acquisition_a = store.resume_thread(params_a);
    tokio::select! { biased;
        result = &mut acquisition_a => panic!("acquisition escaped held writer gate: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    // A has claimed metadata before its first writer await.
    assert!(store.resume_admissions.lock().unwrap().active.is_empty());
    let admission_b = store
        .admit_resume(id, None, history_b.clone(), owner_b.clone())
        .unwrap();
    drop(admission_a);
    admission_b
        .validate(&store, id, &history_b, &owner_b)
        .unwrap();
    drop(gate);
    // Retaining A's acquisition, rather than its opening guard, retains A's owner.
    acquisition_a.await.unwrap();
    assert!(owner_a.accepted().is_some());
    assert!(owner_b.accepted().is_none());
    admission_b
        .validate(&store, id, &history_b, &owner_b)
        .unwrap();
    store.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_claimed_wait_before_native_acquisition_leaves_no_writer() {
    let home = tempfile::tempdir().unwrap();
    let (store, id) = saved(home.path(), Vec::new()).await;
    let (history, params) = replay(&store, id, home.path()).await;
    let instructions = owner("legacy");
    let admission = store
        .admit_resume(id, None, history, instructions.clone())
        .unwrap();
    let gate = store.writers.lock().await;
    let mut acquisition = store.resume_thread(params);
    tokio::select! { biased;
        result = &mut acquisition => panic!("acquisition escaped held writer gate: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    drop(acquisition);
    drop(admission);
    drop(gate);
    assert!(instructions.accepted().is_none());
    assert!(store.resume_admissions.lock().unwrap().active.is_empty());
    store
        .resume_thread(tests::resume(id, home.path()))
        .await
        .unwrap();
    store.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_text_revision_advance_seeds_current_receipt_and_core_reloads_context() {
    let home = tempfile::tempdir().unwrap();
    let original = application_instructions::publication("trusted");
    let (store, id) = saved(
        home.path(),
        vec![row(original.clone()), compacted(&original)],
    )
    .await;
    let (history, params) = replay(&store, id, home.path()).await;
    assert!(params.history_revision.is_some());
    let instructions = owner("trusted");
    let _admission = store
        .admit_resume(id, None, history.clone(), instructions.clone())
        .unwrap();
    let cooperating = tests::store(home.path()).await;
    cooperating
        .resume_thread(tests::resume(id, home.path()))
        .await
        .unwrap();
    let newer = application_instructions::publication("trusted");
    let newer_id = newer.id().unwrap().clone();
    append(&cooperating, id, vec![row(newer)]).await;
    cooperating.shutdown_thread(id).await.unwrap();
    let expected =
        application_instructions::validate(&complete(&store, id).await, "trusted").unwrap();
    let resumed = store.resume_thread(params).await.unwrap();
    assert_eq!(instructions.accepted(), expected);
    assert_ne!(
        serde_json::to_value(&*resumed).unwrap(),
        serde_json::to_value(&*history).unwrap()
    );
    assert!(resumed.iter().any(|row| matches!(row, RolloutItem::ResponseItem(envelope) if envelope.item.id() == Some(&newer_id))));
    // The native replay still is not a complete original-receipt audit.
    assert!(application_instructions::validate(&resumed, "trusted").is_err());
    store.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forged_original_revision_leaving_an_orphan_projection_stays_rejected() {
    let home = tempfile::tempdir().unwrap();
    let original = application_instructions::publication("trusted");
    let forged = application_instructions::publication("trusted");
    let (store, id) = saved(home.path(), vec![row(forged), compacted(&original)]).await;
    let (history, params) = replay(&store, id, home.path()).await;
    let instructions = owner("trusted");
    let _admission = store
        .admit_resume(id, None, history, instructions.clone())
        .unwrap();
    let error = store.resume_thread(params).await.unwrap_err();
    assert!(
        error.to_string().contains("no accepted original"),
        "{error}"
    );
    assert!(instructions.accepted().is_none());
    assert!(!store.writers.lock().await.contains_key(&id));
    // Failed validation joined native shutdown, so the OS lock is available.
    store
        .inner
        .resume_thread(tests::resume(id, home.path()))
        .await
        .unwrap();
    store.inner.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn validation_and_pre_shutdown_errors_retain_writer_until_joined_close_retry() {
    let home = tempfile::tempdir().unwrap();
    let original = application_instructions::publication("trusted");
    let (store, id) = saved(home.path(), vec![row(original)]).await;
    let (history, params) = replay(&store, id, home.path()).await;
    let instructions = owner("different");
    let _admission = store
        .admit_resume(id, None, history, instructions.clone())
        .unwrap();
    // This hook fails before native recorder shutdown. It does not cover a
    // recorder drained successfully before a later path-sync/removal failure.
    store.fail_writer_shutdown.store(true, Ordering::SeqCst);
    let error = store.resume_thread(params).await.unwrap_err().to_string();
    assert!(error.contains("Agent.instructions"), "{error}");
    assert!(error.contains("native writer cleanup failed"), "{error}");
    assert!(error.contains("injected"), "{error}");
    assert!(instructions.accepted().is_none());
    assert!(
        store
            .writers
            .lock()
            .await
            .get(&id)
            .unwrap()
            .resume_cleanup_pending
    );
    assert!(store.check_failure(Some(id)).await.is_err());
    let competitor = tests::store(home.path()).await;
    assert!(
        competitor
            .inner
            .resume_thread(tests::resume(id, home.path()))
            .await
            .is_err()
    );
    assert!(store.close_database().await.is_err());
    assert!(
        store
            .writers
            .lock()
            .await
            .get(&id)
            .unwrap()
            .resume_cleanup_pending
    );
    assert!(
        competitor
            .inner
            .resume_thread(tests::resume(id, home.path()))
            .await
            .is_err()
    );
    store.fail_writer_shutdown.store(false, Ordering::SeqCst);
    store.close_database().await.unwrap();
    assert!(!store.writers.lock().await.contains_key(&id));
    competitor
        .inner
        .resume_thread(tests::resume(id, home.path()))
        .await
        .unwrap();
    competitor.inner.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn receipt_free_legacy_stays_pending_and_empty_instructions_keep_their_receipt() {
    let home = tempfile::tempdir().unwrap();
    let (store, id) = saved(home.path(), Vec::new()).await;
    let (history, params) = replay(&store, id, home.path()).await;
    let instructions = owner("legacy");
    let admission = store
        .admit_resume(id, None, history, instructions.clone())
        .unwrap();
    store.resume_thread(params).await.unwrap();
    assert!(instructions.accepted().is_none());
    assert!(instructions.needs_publication(true));
    store.shutdown_thread(id).await.unwrap();
    drop(admission);

    let original = application_instructions::publication("");
    let other_home = tempfile::tempdir().unwrap();
    let (other, other_id) = saved(
        other_home.path(),
        vec![row(original.clone()), compacted(&original)],
    )
    .await;
    let (history, params) = replay(&other, other_id, other_home.path()).await;
    let empty = owner("");
    let _admission = other
        .admit_resume(other_id, None, history, empty.clone())
        .unwrap();
    other.resume_thread(params).await.unwrap();
    assert_eq!(empty.text().unwrap(), Some(String::new()));
    assert!(empty.accepted().is_some());
    assert!(!empty.needs_publication(true));
    other.shutdown_thread(other_id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn supplied_history_without_admission_does_not_gain_managed_authority() {
    let home = tempfile::tempdir().unwrap();
    let (store, id) = saved(home.path(), Vec::new()).await;
    let (_, params) = replay(&store, id, home.path()).await;
    let error = store.resume_thread(params).await.unwrap_err();
    assert!(error.to_string().contains("no longer active"), "{error}");
    assert!(store.writers.lock().await.is_empty());
    // The pre-existing unmanaged direct-store API remains available.
    store
        .resume_thread(tests::resume(id, home.path()))
        .await
        .unwrap();
    store.shutdown_thread(id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn core_init_guard_drains_cancelled_acquisition_before_releasing_native_writer() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let home = tempfile::tempdir().unwrap();
        let original = application_instructions::publication("trusted");
        let (store, id) = saved(
            home.path(),
            vec![row(original.clone()), compacted(&original)],
        )
        .await;
        let store = Arc::new(store);
        let audit_before = serde_json::to_value(complete(&store, id).await).unwrap();
        let (history, params) = replay(&store, id, home.path()).await;
        let instructions = owner("trusted");
        let admission = store.admit_resume(id, None, history, instructions).unwrap();
        let gate = store.writers.lock().await;
        let acquired = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let observed = acquired.clone();
        let held = release.clone();
        let native_store: Arc<dyn ThreadStore> = store.clone();
        let mut guard = LiveThreadInitGuard::new(None);
        let mut opening = Box::pin(guard.acquire(async move {
            let (live, _) =
                LiveThread::resume(native_store, ThreadHistoryMode::Paginated, params).await?;
            observed.add_permits(1);
            held.acquire().await.unwrap().forget();
            Ok(live)
        }));
        // LiveThread can await state metadata before calling our adapter. Drive
        // its real acquisition until the entry is claimed, without timing sleeps.
        while !store.resume_admissions.lock().unwrap().active.is_empty() {
            tokio::select! { biased;
                _ = &mut opening => panic!("opening escaped held writer gate"),
                _ = tokio::task::yield_now() => {}
            }
        }
        drop(opening);
        drop(admission);
        drop(gate);
        // Core's guard, not a detached task, retains the acquisition after its
        // caller stops waiting. Hold the acquired writer before cleanup completes.
        let mut discard = Box::pin(guard.discard());
        tokio::select! { biased;
            _ = &mut discard => panic!("discard escaped held acquisition"),
            permit = acquired.acquire() => permit.unwrap().forget()
        }
        let competitor = tests::store(home.path()).await;
        assert!(
            competitor
                .inner
                .resume_thread(tests::resume(id, home.path()))
                .await
                .is_err()
        );
        release.add_permits(1);
        discard.await.unwrap();
        assert!(guard.as_ref().is_none());
        assert!(store.writers.lock().await.is_empty());
        assert!(store.resume_admissions.lock().unwrap().active.is_empty());
        assert_eq!(
            serde_json::to_value(complete(&store, id).await).unwrap(),
            audit_before
        );
        competitor
            .inner
            .resume_thread(tests::resume(id, home.path()))
            .await
            .unwrap();
        competitor.inner.shutdown_thread(id).await.unwrap();
    })
    .await
    .unwrap();
}

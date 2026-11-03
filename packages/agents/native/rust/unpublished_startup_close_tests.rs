//! Native startup and close ownership regressions using actual Engine startup/close.
//! Rust future cancellation is explicit; ordinary JS Promise abandonment is not tested.
use super::*;
use crate::local_storage_tests::{Provider, options, specs};
use crate::{Engine, create_engine};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

fn runtime(work: &Path, profile: &Path) -> String {
    serde_json::json!({"codex_home":work,"cwd":work,"native_thread_store":profile}).to_string()
}

async fn setup() -> (
    Provider,
    tempfile::TempDir,
    tempfile::TempDir,
    Engine,
    ThreadId,
) {
    let provider = Provider::start().await;
    let profile = tempfile::tempdir().unwrap();
    let seed_work = tempfile::tempdir().unwrap();
    let seed = create_engine(
        provider.config().to_string(),
        runtime(seed_work.path(), profile.path()),
        None,
        None,
    )
    .await
    .unwrap();
    let session = seed
        .start_replaceable_thread(options(None), specs())
        .await
        .unwrap();
    let id = ThreadId::from_string(&session.id()).unwrap();
    session.close().await.unwrap();
    seed.close().await.unwrap();
    let work = tempfile::tempdir().unwrap();
    let engine = create_engine(
        provider.config().to_string(),
        runtime(work.path(), profile.path()),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(provider.request_count(), 0);
    (provider, profile, work, engine, id)
}

fn install(
    store: &LocalChecklistStore,
    thread: Option<ThreadId>,
    point: StartupClosePoint,
) -> Arc<StartupCloseProbe> {
    let probe = StartupCloseProbe::new(thread, point);
    *store.startup_close_probe.lock().unwrap() = Some(probe.clone());
    probe
}

// Release every armed hold on assertion failure as well as on the normal path.
struct ReleaseOnDrop(Arc<StartupCloseProbe>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release.add_permits(1);
    }
}

async fn writer_removed(store: &LocalChecklistStore, id: ThreadId) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let writer = store.writers.lock().await;
            match writer.get(&id) {
                None => return Ok(()),
                Some(writer) if writer.failure.is_some() => {
                    return Err(writer.failure.clone().unwrap());
                }
                Some(_) => {}
            }
            drop(writer);
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| "Core cleanup did not remove its native writer".to_owned())?
}

async fn cleanup_created(store: &LocalChecklistStore, id: ThreadId) -> Result<(), String> {
    if store.inner.live_rollout_path(id).await.is_ok() {
        store
            .shutdown_thread(id)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_engine_close_refuses_acquired_unpublished_writer_until_cleanup_joins() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, profile, _work, engine, id) = setup().await;
        let state = engine.current().unwrap();
        let store = state.local_checklist_store.as_ref().unwrap().clone();
        let probe = install(&store, Some(id), StartupClosePoint::RegisteredResume);
        let _release_on_failure = ReleaseOnDrop(probe.clone());
        let mut opening = Box::pin(engine.start_replaceable_thread(options(Some(&id.to_string())), specs()));
        tokio::select! { biased;
            result = &mut opening => {
                if let Ok(session) = result { session.close().await.unwrap(); }
                panic!("startup completed before acquired-writer hold");
            }
            permit = probe.entered.acquire() => permit.unwrap().forget()
        }
        drop(opening);
        assert!(state.manager.get_thread(id).await.is_err());
        {
            let writers = store.writers.lock().await;
            assert!(!writers.get(&id).unwrap().resume_cleanup_pending);
        }
        let competitor = tests::store(profile.path()).await;
        assert!(competitor.inner.resume_thread(tests::resume(id, profile.path())).await.is_err());
        // Record the unsafe baseline result before cleanup, but never assert it
        // until the hold is released and the exact writer has had a joined drain.
        let first_close = tokio::time::timeout(Duration::from_secs(3), engine.close()).await;
        let owner_retained = engine.inner.lock().unwrap().live.is_some();
        let marked_closed = state.closed.load(Ordering::Acquire);
        probe.release.add_permits(1);
        let completed = tokio::time::timeout(Duration::from_secs(10), probe.completed.acquire()).await;
        if let Ok(Ok(permit)) = completed { permit.forget(); }
        let cleanup = writer_removed(&store, id).await;
        let reopen = competitor.inner.resume_thread(tests::resume(id, profile.path())).await;
        let reopen_error = reopen.as_ref().err().map(ToString::to_string);
        if reopen.is_ok() { competitor.inner.shutdown_thread(id).await.unwrap(); }
        let retry = engine.close().await;
        assert_eq!(provider.request_count(), 0);
        assert!(cleanup.is_ok() && reopen_error.is_none() && retry.is_ok(),
            "first close={first_close:?}; Core cleanup={cleanup:?}; reopen={reopen_error:?}; retry={retry:?}");
        assert!(first_close.as_ref().is_ok_and(|result| result.is_err()) && owner_retained && !marked_closed,
            "close accepted acquired unpublished writer: result={first_close:?}, owner_retained={owner_retained}, closed={marked_closed}");
        assert!(engine.inner.lock().unwrap().live.is_none());
        assert!(state.closed.load(Ordering::Acquire));
    }).await.expect("unpublished writer close probe timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpolled_create_captured_before_engine_close_cannot_enter_native_store() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, profile, _work, engine, _seed_id) = setup().await;
        let state = engine.current().unwrap();
        let store = state.local_checklist_store.as_ref().unwrap().clone();
        let id = ThreadId::new();
        let probe = install(&store, Some(id), StartupClosePoint::ObserveOnly);
        let creating = store.create_thread(tests::create_params(id, profile.path()));
        engine.close().await.unwrap();
        let result = creating.await;
        let result_text = result.as_ref().err().map(ToString::to_string);
        let attempted = probe.native_creates.load(Ordering::SeqCst);
        let cleanup = cleanup_created(&store, id).await;
        assert_eq!(provider.request_count(), 0);
        assert!(
            cleanup.is_ok(),
            "late create={result_text:?}; cleanup={cleanup:?}"
        );
        assert!(
            result.is_err()
                && attempted == 0
                && result_text
                    .as_deref()
                    .is_some_and(|error| error.contains("closed")),
            "unpolled create was not fenced: attempts={attempted}, result={result_text:?}"
        );
        assert!(store.writers.lock().await.is_empty());
    })
    .await
    .expect("late create close probe timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_close_before_database_drain_keeps_admission_fenced_and_owner_retryable() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (provider, profile, _work, engine, _seed_id) = setup().await;
        let state = engine.current().unwrap();
        let store = state.local_checklist_store.as_ref().unwrap().clone();
        let probe = install(&store, None, StartupClosePoint::BeforeDatabaseClose);
        let _release_on_failure = ReleaseOnDrop(probe.clone());
        let mut closing = Box::pin(engine.close());
        tokio::select! { biased;
            result = &mut closing => panic!("close completed before database-drain hold: {result:?}"),
            permit = probe.entered.acquire() => permit.unwrap().forget()
        }
        drop(closing);
        let owner_retained = engine.inner.lock().unwrap().live.is_some();
        let marked_closed = state.closed.load(Ordering::Acquire);
        let id = ThreadId::new();
        let late = store.create_thread(tests::create_params(id, profile.path())).await;
        let late_error = late.as_ref().err().map(ToString::to_string);
        let attempted = probe.native_creates.load(Ordering::SeqCst);
        let cleanup = cleanup_created(&store, id).await;
        // The one-shot hold was consumed by the canceled close; retry must call
        // the real database close and complete the existing EngineOwner handoff.
        let retried = engine.close().await;
        assert_eq!(provider.request_count(), 0);
        assert!(cleanup.is_ok() && retried.is_ok(), "late={late_error:?}; cleanup={cleanup:?}; retry={retried:?}");
        assert!(owner_retained && !marked_closed && late.is_err() && attempted == 0,
            "interrupted close lost fence/owner: retained={owner_retained}, closed={marked_closed}, native_creates={attempted}, result={late_error:?}");
        assert!(late_error.as_deref().is_some_and(|error| error.contains("closed")));
        assert!(engine.inner.lock().unwrap().live.is_none());
        assert!(state.closed.load(Ordering::Acquire));
    }).await.expect("interrupted close fence probe timed out");
}

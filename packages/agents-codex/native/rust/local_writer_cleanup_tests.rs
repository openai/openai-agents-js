use super::local_descendant_admission_tests::root_profile;
use super::*;

async fn transferred_profile(home: &Path) -> (Arc<LocalChecklistStore>, ThreadId) {
    let (store, id, params) = root_profile(home).await;
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
    store
        .resume_thread(admission.prepared_params().unwrap().clone())
        .await
        .unwrap();
    drop(admission);
    (store, id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transferred_discard_reports_joined_failure_and_allows_database_close() {
    let home = tempfile::tempdir().unwrap();
    let (store, id) = transferred_profile(home.path()).await;
    store.fail_discard_after_join.store(true, Ordering::SeqCst);
    let error = store.discard_thread(id).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("discard error after native join")
    );
    {
        let writers = store.writers.lock().await;
        let writer = &writers[&id];
        assert!(writer.native_drain_joined);
        assert!(!writer.resume_cleanup_pending);
        assert!(writer.discard.is_none());
        assert!(
            writer
                .failure
                .as_ref()
                .unwrap()
                .contains("discard error after native join")
        );
    }
    assert!(matches!(
        store.inner.live_rollout_path(id).await,
        Err(ThreadStoreError::ThreadNotFound { .. })
    ));
    assert!(store.check_failure(Some(id)).await.is_err());
    store.close_database().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_discard_retains_the_earlier_writer_failure() {
    let home = tempfile::tempdir().unwrap();
    let (store, id) = transferred_profile(home.path()).await;
    store.writers.lock().await.get_mut(&id).unwrap().failure =
        Some("earlier persistence failure".into());
    let error = store.discard_thread(id).await.unwrap_err();
    assert!(error.to_string().contains("earlier persistence failure"));
    {
        let writers = store.writers.lock().await;
        assert!(writers[&id].native_drain_joined);
        assert_eq!(
            writers[&id].failure.as_deref(),
            Some("earlier persistence failure")
        );
    }
    assert!(store.check_failure(Some(id)).await.is_err());
    store.close_database().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_discard_keeps_the_exact_operation_until_close_joins_it() {
    let home = tempfile::tempdir().unwrap();
    let (store, id) = transferred_profile(home.path()).await;
    let probe = StartupCloseProbe::new(Some(id), StartupClosePoint::DiscardNativeJoined);
    *store.startup_close_probe.lock().unwrap() = Some(probe.clone());
    let owner = store.clone();
    let discard = tokio::spawn(async move { owner.discard_thread(id).await });
    probe.entered.acquire().await.unwrap().forget();
    discard.abort();
    assert!(discard.await.unwrap_err().is_cancelled());
    {
        let writers = store.writers.lock().await;
        assert!(writers[&id].discard.is_some());
        assert!(writers[&id].resume_cleanup_pending);
        assert!(!writers[&id].native_drain_joined);
    }
    let close = store.close_database();
    tokio::pin!(close);
    assert!(
        std::future::poll_fn(|context| std::task::Poll::Ready(
            std::future::Future::poll(close.as_mut(), context).is_pending()
        ))
        .await
    );
    probe.release.add_permits(1);
    close.await.unwrap();
    assert!(store.writers.lock().await.is_empty());
    assert!(matches!(
        store.inner.live_rollout_path(id).await,
        Err(ThreadStoreError::ThreadNotFound { .. })
    ));
}

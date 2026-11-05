//! Checklist reads use existing close fences, not a second retained owner.
use super::*;
use crate::{Engine, NativeThread, create_checkpoint_engine, local_storage_tests::Provider};
use serde_json::json;

async fn fixture() -> (Provider, tempfile::TempDir, Engine, Arc<NativeThread>) {
    let provider = Provider::start().await;
    let home = tempfile::tempdir().unwrap();
    let engine = create_checkpoint_engine(
        provider.config().to_string(),
        json!({"codex_home":home.path(),"cwd":home.path()}).to_string(),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let native = engine
        .start_replaceable_thread(
            crate::local_storage_tests::options(None),
            crate::local_storage_tests::specs(),
        )
        .await
        .unwrap();
    (provider, home, engine, Arc::new(native))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checklist_admitted_read_joins_thread_and_engine_close() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for close_engine in [false, true] {
            let (_provider, _home, engine, native) = fixture().await;
            let state = native.current().unwrap();
            let store = state
                .engine
                .store
                .as_any()
                .downcast_ref::<crate::storage::MemoryThreadStore>()
                .unwrap();
            let hold = Arc::new(crate::storage::CompletionHold {
                parent: state.id,
                entered: tokio::sync::Semaphore::new(0),
                release: tokio::sync::Semaphore::new(0),
            });
            *store.next_flush_hold.lock().unwrap() = Some(hold.clone());
            let reader = native.clone();
            let read = tokio::spawn(async move { reader.read_checklist(None).await });
            hold.entered.acquire().await.unwrap().forget();
            assert!(state.mutations.try_lock().is_err());
            assert!(state.engine.lifecycle.try_lock().is_err());
            let close = async {
                if close_engine {
                    engine.close().await
                } else {
                    native.close().await
                }
            };
            tokio::pin!(close);
            // Poll close once so pending means it really reached the read's fence.
            tokio::select! {
                biased;
                result = &mut close => panic!("close bypassed admitted read: {result:?}"),
                _ = tokio::task::yield_now() => {}
            }
            hold.release.add_permits(1);
            assert_eq!(read.await.unwrap().unwrap(), "null");
            close.await.unwrap();
            assert!(native.live().unwrap().is_none());
            assert!(native.read_checklist(None).await.is_err());
            engine.close().await.unwrap();
        }
    })
    .await
    .expect("admitted checklist read/close ordering timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checklist_queued_after_thread_close_rejects() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let (_provider, _home, engine, native) = fixture().await;
        let state = native.current().unwrap();
        let mutation = state.mutations.lock().await;
        let close = native.close();
        tokio::pin!(close);
        tokio::select! {
            biased;
            result = &mut close => panic!("close bypassed held mutation: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        let read = native.read_checklist(None);
        tokio::pin!(read);
        tokio::select! {
            biased;
            result = &mut read => panic!("read bypassed queued close: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        drop(mutation);
        let (closed, result) = tokio::join!(close, read);
        closed.unwrap();
        assert!(result.is_err());
        assert!(native.live().unwrap().is_none());
        engine.close().await.unwrap();
    })
    .await
    .expect("checklist read queued after thread close timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checklist_queued_after_successful_engine_close_rejects() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let (_provider, _home, engine, native) = fixture().await;
        let state = native.current().unwrap();
        let lifecycle = state.engine.lifecycle.lock().await;
        let close = engine.close();
        tokio::pin!(close);
        tokio::select! {
            biased;
            result = &mut close => panic!("engine close bypassed lifecycle: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        let read = native.read_checklist(None);
        tokio::pin!(read);
        tokio::select! {
            biased;
            result = &mut read => panic!("read bypassed queued engine close: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        drop(lifecycle);
        let (closed, result) = tokio::join!(close, read);
        closed.unwrap();
        assert!(result.is_err());
        assert!(native.live().unwrap().is_none());
    })
    .await
    .expect("checklist read queued after engine close timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checklist_incomplete_thread_close_keeps_read_retirement_until_retry() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let (_provider, _home, engine, native) = fixture().await;
        let state = native.current().unwrap();
        // The existing events mutex pauses close after its closing flag is set.
        let events = state.events.lock().await;
        let mut close = Box::pin(native.close());
        tokio::select! {
            biased;
            result = &mut close => panic!("close bypassed held event owner: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(state.is_closed());
        drop(close);
        drop(events);
        assert!(native.live().unwrap().is_some());
        assert!(native.read_checklist(None).await.is_err());
        native.close().await.unwrap();
        assert!(native.live().unwrap().is_none());
        engine.close().await.unwrap();
    })
    .await
    .expect("incomplete checklist close/retry timed out");
}

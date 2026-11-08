//! One-generation native frame bridge. Application objects stay in the SDK driver.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use codex_api::{
    RealtimeAdapter, RealtimeAdapterConnection, RealtimeAdapterContext, RealtimeAdapterError,
};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use napi_derive::napi;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const CAPACITY: usize = 16;
const BYTES: usize = 8 * 1024 * 1024;
fn error() -> napi::Error {
    napi::Error::from_reason("Native Realtime adapter failed")
}
type CloseResult = Shared<BoxFuture<'static, Result<(), RealtimeAdapterError>>>;

struct Request {
    event: Mutex<String>,
    reply: Mutex<Option<oneshot::Sender<bool>>>,
    permit: Mutex<Option<OwnedSemaphorePermit>>,
}
struct Incoming {
    frame: String,
    _permit: OwnedSemaphorePermit,
}
struct State {
    owner: Weak<crate::engine::ThreadState>,
    generation: String,
    attached: AtomicBool,
    connected: AtomicBool,
    requests: mpsc::Sender<Request>,
    next: AsyncMutex<mpsc::Receiver<Request>>,
    inbound: mpsc::Sender<Incoming>,
    incoming: AsyncMutex<mpsc::Receiver<Incoming>>,
    outgoing_budget: Arc<Semaphore>,
    incoming_budget: Arc<Semaphore>,
    cancel: CancellationToken,
    context_cancellation: Mutex<Option<CancellationToken>>,
    cancel_delivered: AtomicBool,
    finished: CancellationToken,
    incoming_end: Mutex<Option<bool>>,
    incoming_changed: Notify,
    close_request: Mutex<Option<Request>>,
    control_changed: Notify,
    close: Mutex<Option<CloseResult>>,
}
impl State {
    async fn request(self: &Arc<Self>, event: Value) -> Result<(), RealtimeAdapterError> {
        let event = event.to_string();
        let bytes = u32::try_from(event.len()).map_err(|_| RealtimeAdapterError)?;
        if event.len() > BYTES {
            return Err(RealtimeAdapterError);
        }
        let permit = tokio::select! {
            _ = self.finished.cancelled() => return Err(RealtimeAdapterError),
            permit = self.outgoing_budget.clone().acquire_many_owned(bytes) => permit.map_err(|_| RealtimeAdapterError)?,
        };
        let (reply, result) = oneshot::channel();
        let mut cancellation_owner = CancelOnDrop {
            state: self.clone(),
            armed: true,
        };
        tokio::select! {
            _ = self.finished.cancelled() => return Err(RealtimeAdapterError),
            sent = self.requests.send(Request {event:Mutex::new(event),reply:Mutex::new(Some(reply)),permit:Mutex::new(Some(permit))}) => sent.map_err(|_| RealtimeAdapterError)?,
        }
        let accepted = tokio::select! {biased;
            _=self.finished.cancelled()=>return Err(RealtimeAdapterError),
            reply=result=>reply,
        };
        cancellation_owner.armed = false;
        match accepted {
            Ok(true) => Ok(()),
            _ => Err(RealtimeAdapterError),
        }
    }
    fn end(&self, success: bool) {
        let mut end = self.incoming_end.lock().expect("adapter ingress poisoned");
        *end = Some(end.unwrap_or(true) && success);
        drop(end);
        self.incoming_changed.notify_waiters();
    }
    fn begin_close(self: &Arc<Self>) -> CloseResult {
        self.cancel.cancel();
        self.end(true);
        let mut receipt = self.close.lock().expect("adapter close poisoned");
        if let Some(pending) = receipt.as_ref()
            && !matches!(pending.peek(), Some(Err(_)))
        {
            return pending.clone();
        }
        let state = self.clone();
        let task = tokio::spawn(async move {
            if state.finished.is_cancelled() {
                return Ok(());
            }
            let (reply, result) = oneshot::channel();
            *state.close_request.lock().expect("adapter close poisoned") = Some(Request {
                event: Mutex::new(json!({"type":"close"}).to_string()),
                reply: Mutex::new(Some(reply)),
                permit: Mutex::new(None),
            });
            state.control_changed.notify_one();
            match result.await {
                Ok(true) => Ok(()),
                _ => Err(RealtimeAdapterError),
            }
        });
        let pending = async move { task.await.unwrap_or(Err(RealtimeAdapterError)) }
            .boxed()
            .shared();
        *receipt = Some(pending.clone());
        pending
    }
}

struct CancelOnDrop {
    state: Arc<State>,
    armed: bool,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.state.cancel.cancel();
            self.state.end(false);
        }
    }
}

#[napi(js_name = "_NativeRealtimeAdapterRequest")]
pub struct NativeRealtimeAdapterRequest {
    request: Request,
}
#[napi]
impl NativeRealtimeAdapterRequest {
    #[napi(getter, js_name = "event_json")]
    pub fn event_json(&self) -> String {
        self.request
            .event
            .lock()
            .expect("adapter event poisoned")
            .clone()
    }
    #[napi]
    pub fn complete(&self, success: bool) -> bool {
        // Receipt settlement releases native memory without waiting for JS GC.
        self.request
            .permit
            .lock()
            .expect("adapter bytes poisoned")
            .take();
        *self.request.event.lock().expect("adapter event poisoned") = String::new();
        self.request
            .reply
            .lock()
            .expect("adapter reply poisoned")
            .take()
            .is_some_and(|reply| reply.send(success).is_ok())
    }
}

#[napi(js_name = "_NativeRealtimeAdapter")]
pub struct NativeRealtimeAdapter {
    state: Arc<State>,
}
impl NativeRealtimeAdapter {
    pub(crate) fn new(owner: &Arc<crate::engine::ThreadState>, generation: String) -> Self {
        Self::with_owner(Arc::downgrade(owner), generation)
    }
    fn with_owner(owner: Weak<crate::engine::ThreadState>, generation: String) -> Self {
        let (requests, next) = mpsc::channel(CAPACITY);
        let (inbound, incoming) = mpsc::channel(CAPACITY);
        Self {
            state: Arc::new(State {
                owner,
                generation,
                attached: AtomicBool::new(false),
                connected: AtomicBool::new(false),
                requests,
                next: AsyncMutex::new(next),
                inbound,
                incoming: AsyncMutex::new(incoming),
                outgoing_budget: Arc::new(Semaphore::new(BYTES)),
                incoming_budget: Arc::new(Semaphore::new(BYTES)),
                cancel: CancellationToken::new(),
                context_cancellation: Mutex::new(None),
                cancel_delivered: AtomicBool::new(false),
                finished: CancellationToken::new(),
                incoming_end: Mutex::new(None),
                incoming_changed: Notify::new(),
                close_request: Mutex::new(None),
                control_changed: Notify::new(),
                close: Mutex::new(None),
            }),
        }
    }
    pub(crate) fn attach(
        &self,
        owner: &Arc<crate::engine::ThreadState>,
        generation: &str,
    ) -> anyhow::Result<Arc<dyn RealtimeAdapter>> {
        anyhow::ensure!(
            Weak::ptr_eq(&self.state.owner, &Arc::downgrade(owner))
                && self.state.generation == generation
                && !self.state.finished.is_cancelled(),
            "Realtime adapter does not belong to this Session and generation"
        );
        anyhow::ensure!(
            self.state
                .attached
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "Realtime adapter was already attached"
        );
        Ok(Arc::new(Adapter(self.state.clone())))
    }
}
#[napi]
impl NativeRealtimeAdapter {
    #[napi]
    pub async fn next(&self) -> napi::Result<Option<NativeRealtimeAdapterRequest>> {
        let mut next = self.state.next.lock().await;
        loop {
            let control = self.state.control_changed.notified();
            if self.state.finished.is_cancelled() {
                while next.try_recv().is_ok() {}
                return Ok(None);
            }
            if let Some(request) = self
                .state
                .close_request
                .lock()
                .expect("adapter close poisoned")
                .take()
            {
                return Ok(Some(NativeRealtimeAdapterRequest { request }));
            }
            let context_cancellation = self
                .state
                .context_cancellation
                .lock()
                .expect("adapter cancellation poisoned")
                .clone();
            if (self.state.cancel.is_cancelled()
                || context_cancellation
                    .as_ref()
                    .is_some_and(CancellationToken::is_cancelled))
                && !self.state.cancel_delivered.swap(true, Ordering::AcqRel)
            {
                return Ok(Some(NativeRealtimeAdapterRequest {
                    request: Request {
                        event: Mutex::new(json!({"type":"cancel"}).to_string()),
                        reply: Mutex::new(None),
                        permit: Mutex::new(None),
                    },
                }));
            }
            tokio::select! {biased;
                _=self.state.finished.cancelled()=>continue,
                _=control=>continue,
                _=self.state.cancel.cancelled(), if !self.state.cancel_delivered.load(Ordering::Acquire)=>continue,
                _=async {match context_cancellation {Some(token)=>token.cancelled().await,None=>std::future::pending().await}}, if !self.state.cancel_delivered.load(Ordering::Acquire)=>continue,
                request=next.recv()=>return Ok(request.map(|request|NativeRealtimeAdapterRequest {request})),
            }
        }
    }
    #[napi]
    pub async fn receive(&self, frame: String) -> napi::Result<()> {
        let changed = self.state.incoming_changed.notified();
        if frame.len() > BYTES
            || self
                .state
                .incoming_end
                .lock()
                .expect("adapter ingress poisoned")
                .is_some()
        {
            return Err(error());
        }
        let bytes = u32::try_from(frame.len()).map_err(|_| error())?;
        let permit = tokio::select! {biased;
            _=self.state.finished.cancelled()=>return Err(error()),
            _=changed=>return Err(error()),
            permit=self.state.incoming_budget.clone().acquire_many_owned(bytes)=>permit.map_err(|_|error())?,
        };
        let changed = self.state.incoming_changed.notified();
        if self
            .state
            .incoming_end
            .lock()
            .expect("adapter ingress poisoned")
            .is_some()
        {
            return Err(error());
        }
        tokio::select! {biased;
            _=self.state.finished.cancelled()=>Err(error()),
            _=changed=>Err(error()),
            sent=self.state.inbound.send(Incoming {frame,_permit:permit})=>sent.map_err(|_|error()),
        }
    }
    #[napi]
    pub fn end(&self, success: bool) {
        self.state.end(success);
    }
    #[napi]
    pub fn finish(&self) {
        self.state.finished.cancel();
        self.state.cancel.cancel();
        self.state.end(true);
        self.state
            .close_request
            .lock()
            .expect("adapter close poisoned")
            .take();
        if let Ok(mut next) = self.state.next.try_lock() {
            while next.try_recv().is_ok() {}
        }
    }
}

struct Adapter(Arc<State>);
impl RealtimeAdapter for Adapter {
    fn connect(
        &self,
        context: RealtimeAdapterContext,
    ) -> BoxFuture<'_, Result<Arc<dyn RealtimeAdapterConnection>, RealtimeAdapterError>> {
        Box::pin(async move {
            if self.0.connected.swap(true, Ordering::AcqRel) || self.0.finished.is_cancelled() {
                return Err(RealtimeAdapterError);
            }
            let mut headers = serde_json::Map::new();
            for (name, value) in &context.headers {
                headers.insert(
                    name.as_str().into(),
                    Value::String(value.to_str().map_err(|_| RealtimeAdapterError)?.into()),
                );
            }
            *self
                .0
                .context_cancellation
                .lock()
                .expect("adapter cancellation poisoned") = Some(context.cancellation);
            self.0.control_changed.notify_one();
            self.0.request(json!({"type":"connect","url":context.url,"headers":headers,"model":context.model})).await?;
            Ok(Arc::new(Connection(self.0.clone())) as Arc<dyn RealtimeAdapterConnection>)
        })
    }
}
struct Connection(Arc<State>);
impl RealtimeAdapterConnection for Connection {
    fn send(&self, frame: String) -> BoxFuture<'_, Result<(), RealtimeAdapterError>> {
        Box::pin(async move { self.0.request(json!({"type":"send","frame":frame})).await })
    }
    fn receive(&self) -> BoxFuture<'_, Result<Option<String>, RealtimeAdapterError>> {
        Box::pin(async move {
            let mut incoming = self.0.incoming.lock().await;
            loop {
                let changed = self.0.incoming_changed.notified();
                if let Ok(frame) = incoming.try_recv() {
                    return Ok(Some(frame.frame));
                }
                if let Some(success) = *self
                    .0
                    .incoming_end
                    .lock()
                    .expect("adapter ingress poisoned")
                {
                    return if success {
                        Ok(None)
                    } else {
                        Err(RealtimeAdapterError)
                    };
                }
                tokio::select! {biased;
                    _=self.0.finished.cancelled()=>return Err(RealtimeAdapterError),
                    _=changed=>continue,
                    frame=incoming.recv()=>return frame.map(|frame|Some(frame.frame)).ok_or(RealtimeAdapterError),
                }
            }
        })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), RealtimeAdapterError>> {
        Box::pin(self.0.begin_close())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn finish_drains_queued_receipts_while_next_owns_receiver() {
        let cap = Arc::new(NativeRealtimeAdapter::with_owner(
            Weak::new(),
            "generation".into(),
        ));
        let waiting = tokio::spawn({
            let cap = cap.clone();
            async move { cap.next().await.unwrap() }
        });
        tokio::task::yield_now().await;
        let connection = Connection(cap.state.clone());
        let mut queued = connection.send("queued".into());
        assert!(futures_util::poll!(queued.as_mut()).is_pending());
        cap.finish();
        assert!(waiting.await.unwrap().is_none());
        assert!(queued.await.is_err());
        assert_eq!(cap.state.outgoing_budget.available_permits(), BYTES);
        assert!(cap.next().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn physical_send_ack_and_close_control_are_independent_of_blocked_frames() {
        let cap = Arc::new(NativeRealtimeAdapter::with_owner(
            Weak::new(),
            "generation".into(),
        ));
        let adapter = Adapter(cap.state.clone());
        let connecting = tokio::spawn(async move {
            adapter
                .connect(RealtimeAdapterContext {
                    url: "wss://provider.invalid/v1/realtime".into(),
                    headers: http::HeaderMap::new(),
                    model: Some("model".into()),
                    cancellation: CancellationToken::new(),
                })
                .await
        });
        let request = cap.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request.event_json()).unwrap()["type"],
            "connect"
        );
        assert!(!connecting.is_finished());
        assert!(request.complete(true));
        assert!(!request.complete(true));
        let connection = connecting.await.unwrap().unwrap();
        let sending = tokio::spawn({
            let connection = connection.clone();
            async move { connection.send("frame".into()).await }
        });
        let request = cap.next().await.unwrap().unwrap();
        assert!(!sending.is_finished());
        assert!(request.complete(true));
        assert_eq!(cap.state.outgoing_budget.available_permits(), BYTES);
        assert!(request.event_json().is_empty());
        sending.await.unwrap().unwrap();
        let mut blocked = Vec::new();
        for _ in 0..CAPACITY {
            blocked.push(tokio::spawn({
                let connection = connection.clone();
                async move { connection.send("held".into()).await }
            }));
        }
        while cap.state.requests.capacity() != 0 {
            tokio::task::yield_now().await;
        }
        let closing = connection.close();
        tokio::task::yield_now().await;
        let close = cap.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&close.event_json()).unwrap()["type"],
            "close"
        );
        assert!(close.complete(true));
        closing.await.unwrap();
        cap.finish();
        for blocked in blocked {
            assert!(blocked.await.unwrap().is_err());
        }
        assert!(cap.next().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn dropped_connect_waiter_cancels_factory_and_rejects_late_ack() {
        let cap = Arc::new(NativeRealtimeAdapter::with_owner(
            Weak::new(),
            "generation".into(),
        ));
        let state = Arc::downgrade(&cap.state);
        let adapter = Adapter(cap.state.clone());
        let connecting = tokio::spawn(async move {
            adapter
                .connect(RealtimeAdapterContext {
                    url: "wss://provider.invalid/v1/realtime".into(),
                    headers: http::HeaderMap::new(),
                    model: None,
                    cancellation: CancellationToken::new(),
                })
                .await
        });
        let request = cap.next().await.unwrap().unwrap();
        connecting.abort();
        assert!(matches!(connecting.await,Err(error) if error.is_cancelled()));
        let cancel = cap.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&cancel.event_json()).unwrap()["type"],
            "cancel"
        );
        assert!(!request.complete(true));
        cap.finish();
        drop(cancel);
        drop(request);
        drop(cap);
        assert!(state.upgrade().is_none());
    }
    #[tokio::test]
    async fn native_cancellation_and_ingress_end_wake_without_detached_watcher() {
        let cap = Arc::new(NativeRealtimeAdapter::with_owner(
            Weak::new(),
            "generation".into(),
        ));
        let token = CancellationToken::new();
        let adapter = Adapter(cap.state.clone());
        let connecting = tokio::spawn({
            let token = token.clone();
            async move {
                adapter
                    .connect(RealtimeAdapterContext {
                        url: "wss://provider.invalid/v1/realtime".into(),
                        headers: http::HeaderMap::new(),
                        model: None,
                        cancellation: token,
                    })
                    .await
            }
        });
        let connect = cap.next().await.unwrap().unwrap();
        token.cancel();
        let cancel = cap.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&cancel.event_json()).unwrap()["type"],
            "cancel"
        );
        connect.complete(true);
        let connection = connecting.await.unwrap().unwrap();
        for _ in 0..CAPACITY {
            cap.receive("frame".into()).await.unwrap();
        }
        let blocked = tokio::spawn({
            let cap = cap.clone();
            async move { cap.receive("overflow".into()).await }
        });
        tokio::task::yield_now().await;
        assert!(!blocked.is_finished());
        cap.end(false);
        assert!(blocked.await.unwrap().is_err());
        for _ in 0..CAPACITY {
            assert_eq!(
                connection.receive().await.unwrap().as_deref(),
                Some("frame")
            );
        }
        assert!(connection.receive().await.is_err());
        cap.finish();
    }
}

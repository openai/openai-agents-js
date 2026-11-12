//! Joined physical WebSocket ownership for one private ModelClient invocation.

use std::sync::{Arc, Mutex, Weak};

use base64::Engine as _;
use codex_api::{ApiError, ResponsesWebsocketCommand, ResponsesWebsocketMessageTransport};
use codex_extension_api::{ModelResponseInterceptor, ModelResponseStream, TurnSamplingStop};
use futures_util::{FutureExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::engine::EngineState;
use crate::model_websocket::{
    Frame, MAX_REQUEST_BYTES, NativeModelWebSocket, open_message_transport,
};
use crate::native_interception::SentinelFailure;

#[derive(Debug, Default)]
enum DispatchState {
    #[default]
    NotStarted,
    Started,
    Oversized,
}

#[derive(Clone, Debug, Default)]
struct Dispatch(Arc<Mutex<DispatchState>>);

impl Dispatch {
    fn mark(&self, state: DispatchState) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state;
    }
}

impl ModelResponseInterceptor for Dispatch {
    fn preserves_provider_message_window(&self) -> bool {
        true
    }

    fn intercept(self: Box<Self>, stream: ModelResponseStream) -> ModelResponseStream {
        Box::pin(stream.map(move |event| {
            event.map_err(|error| {
                // A typed provider rejection can still permit retry. A generic
                // stream failure after a physical send has no such proof.
                if !matches!(&error, ApiError::Stream(_)) {
                    return error;
                }
                let oversized = match *self
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                {
                    DispatchState::NotStarted => return error,
                    DispatchState::Started => false,
                    DispatchState::Oversized => true,
                };
                SentinelFailure::WebSocket { oversized }.into_response_error()
            })
        }))
    }
}

#[derive(Debug, Default)]
struct State {
    tasks: TaskTracker,
    closing: bool,
    dispatch: Option<Dispatch>,
    cleanup_error: Option<String>,
}

struct DriverChannels {
    ready: Option<oneshot::Sender<Result<http::HeaderMap, ApiError>>>,
    commands: mpsc::Receiver<ResponsesWebsocketCommand>,
    messages: mpsc::UnboundedSender<Result<Message, WsError>>,
    pending_send: Option<oneshot::Sender<Result<(), WsError>>>,
}

impl DriverChannels {
    fn finish_send(&mut self, result: Result<(), WsError>) {
        let reply = self.pending_send.take().expect("pending WebSocket send");
        let _ = reply.send(result);
    }
}

#[derive(Debug, Default)]
pub(crate) struct PlainWebSocket {
    state: Arc<Mutex<State>>,
}

impl PlainWebSocket {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn interceptor(&self) -> Option<Box<dyn ModelResponseInterceptor>> {
        let dispatch = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .dispatch
            .clone()?;
        Some(Box::new(dispatch))
    }

    pub(crate) fn clear_dispatch(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .dispatch = None;
    }

    pub(crate) async fn connect(
        &self,
        engine: Weak<EngineState>,
        expected_url: String,
        request: http::Request<()>,
        stop: Arc<TurnSamplingStop>,
        cancel: CancellationToken,
    ) -> Result<ResponsesWebsocketMessageTransport, ApiError> {
        let (commands, command_rx) = mpsc::channel(32);
        let (message_tx, messages) = mpsc::unbounded_channel();
        let (ready, connected) = oneshot::channel();
        let state = Arc::clone(&self.state);
        let driver = {
            let mut slot = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if slot.closing || slot.cleanup_error.is_some() || cancel.is_cancelled() {
                return Err(unavailable());
            }
            let dispatch = Dispatch::default();
            slot.dispatch = Some(dispatch.clone());
            // Enroll before spawning, including cancellation before the first poll.
            let tracked = slot.tasks.track_future(async move {
                // Keep the endpoints alive until a panic fences the next attempt.
                let mut channels = DriverChannels {
                    ready: Some(ready),
                    commands: command_rx,
                    messages: message_tx,
                    pending_send: None,
                };
                let driver = async {
                    let opened = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return,
                        _ = channels.ready.as_mut().expect("opening WebSocket").closed() => return,
                        opened = dial(engine, expected_url, request) => opened,
                    };
                    let ready = channels.ready.take().expect("opening WebSocket");
                    let (_, socket, headers) = match opened {
                        Ok(opened) => opened,
                        Err(error) => {
                            let _ = ready.send(Err(error));
                            return;
                        }
                    };
                    let result = if ready.send(Ok(headers)).is_ok() {
                        relay(&socket, &mut channels, &dispatch, &stop, &cancel).await
                    } else {
                        Ok(None)
                    };
                    let _ = socket.close(1000, String::new()).await;
                    // Retire the failed socket before releasing Core to retry.
                    match result {
                        Ok(Some(frame)) => {
                            let _ = channels.messages.send(Ok(frame));
                        }
                        Ok(None) => {}
                        Err(error) if channels.pending_send.is_some() => {
                            channels.finish_send(Err(error));
                        }
                        Err(error) => {
                            let _ = channels.messages.send(Err(error));
                        }
                    }
                };
                if std::panic::AssertUnwindSafe(driver)
                    .catch_unwind()
                    .await
                    .is_err()
                {
                    state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .cleanup_error
                        .get_or_insert_with(|| "Plain WebSocket driver panicked".into());
                    stop.request();
                    cancel.cancel();
                }
            });
            tokio::spawn(tracked)
        };
        let headers = connected.await.map_err(|_| unavailable())??;
        Ok(ResponsesWebsocketMessageTransport {
            commands,
            messages,
            driver,
            headers,
        })
    }

    /// The caller drops the complete ModelClient owner before joining its sockets.
    pub(crate) async fn join(&self) -> Result<(), String> {
        let tasks = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.closing = true;
            state.tasks.close();
            state.tasks.clone()
        };
        tasks.wait().await;
        match &self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cleanup_error
        {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

async fn dial(
    engine: Weak<EngineState>,
    expected_url: String,
    mut request: http::Request<()>,
) -> Result<(String, NativeModelWebSocket, http::HeaderMap), ApiError> {
    if request.method() != http::Method::GET || request.uri().to_string() != expected_url {
        return Err(unavailable());
    }
    let engine = engine.upgrade().ok_or_else(unavailable)?;
    let (origin, grant, excluded) = engine
        .sentinel
        .read()
        .map_err(|_| unavailable())?
        .clone()
        .ok_or_else(unavailable)?;
    if excluded.is_some() {
        return Err(unavailable());
    }
    let base = if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{}", rest.trim_end_matches('/'))
    } else if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{}", rest.trim_end_matches('/'))
    } else {
        return Err(unavailable());
    };
    let provider = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(engine.service_config.model_provider_id.as_bytes());
    let private_url = format!("{base}/p-{provider}/responses");
    *request.uri_mut() = private_url.parse().map_err(|_| unavailable())?;
    request.headers_mut().insert(
        "x-sdk-sentinel-grant",
        http::HeaderValue::from_str(&grant).map_err(|_| unavailable())?,
    );
    // Reuse the authenticated adapter directly; no loopback network request.
    let opened = open_message_transport(&engine, &private_url, request).await;
    drop(engine);
    opened
}

async fn relay(
    socket: &NativeModelWebSocket,
    channels: &mut DriverChannels,
    dispatch: &Dispatch,
    stop: &TurnSamplingStop,
    cancel: &CancellationToken,
) -> Result<Option<Message>, WsError> {
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(None),
            _ = channels.messages.closed() => return Ok(None),
            command = channels.commands.recv() => {
                let Some(ResponsesWebsocketCommand::Send { message, tx_result }) = command else {
                    return Ok(None);
                };
                channels.pending_send = Some(tx_result);
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) {
                        channels.finish_send(Ok(()));
                        return Ok(None);
                    }
                    return Err(operation_failed());
                };
                if text.len() > MAX_REQUEST_BYTES {
                    stop.try_commit(|| {
                        if !cancel.is_cancelled() {
                            dispatch.mark(DispatchState::Oversized);
                        }
                    });
                    return Err(operation_failed());
                }
                // Copy outside the synchronous sampling-admission lock.
                let text = text.to_string();
                let admitted = stop.try_commit(|| {
                    if cancel.is_cancelled()
                        || channels.pending_send.as_ref().expect("pending WebSocket send").is_closed()
                    {
                        return Err(operation_failed());
                    }
                    // Publish before polling the write: a partial write may
                    // already have reached the provider when the send fails.
                    dispatch.mark(DispatchState::Started);
                    Ok(socket.send_text(text))
                });
                match admitted {
                    Some(Ok(send)) => tokio::select! {
                        biased;
                        _ = cancel.cancelled() => Err(operation_failed()),
                        _ = channels.messages.closed() => Err(operation_failed()),
                        _ = channels.pending_send.as_mut().expect("pending WebSocket send").closed() => Err(operation_failed()),
                        result = send => result.map_err(|_| operation_failed()),
                    },
                    Some(Err(error)) => Err(error),
                    None => Err(operation_failed()),
                }?;
                channels.finish_send(Ok(()));
            }
            frame = socket.receive_frame() => {
                let message = match frame.map_err(|_| operation_failed())? {
                    Some(Frame::Text(text)) => Message::Text(text.into()),
                    Some(Frame::Binary(data)) => Message::Binary(data.into()),
                    Some(Frame::Close(code, reason)) => return Ok(Some(Message::Close(Some(
                        CloseFrame { code: code.into(), reason: reason.into() }
                    )))),
                    Some(Frame::Closed) | None => return Ok(None),
                };
                if channels.messages.send(Ok(message)).is_err() {
                    return Ok(None);
                }
            }
        }
    }
}

fn unavailable() -> ApiError {
    ApiError::Stream("Plain WebSocket route unavailable".into())
}

fn operation_failed() -> WsError {
    WsError::Io(std::io::Error::other("Native WebSocket operation failed"))
}

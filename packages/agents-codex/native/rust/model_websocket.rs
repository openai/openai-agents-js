//! Provider transport limits apply to encoded requests, not model context.
//!
//! This carrier accepts at most 64 MiB of UTF-8 request text and writes RFC
//! 6455 frames of at most 4 MiB, including their headers. A model can impose a
//! lower input-token limit; transport admission does not promise model admission.
//! Uncertain partial sends retire their socket and cannot be refreshed/replayed.

use napi_derive::napi;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use codex_protocol::models::ResponseItem;
use codex_websocket_client::{WebSocketConnection, WebSocketConnector};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::extensions::ExtensionsConfig;
use tokio_tungstenite::tungstenite::extensions::compression::deflate::DeflateConfig;
use tokio_tungstenite::tungstenite::protocol::frame::Frame as WireFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::{Data, OpCode};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error, Message};

use super::{NativeModelRoute, RuntimeOwned, native_error};

pub(crate) const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
// The largest client header consists of two bytes, eight length bytes and four mask bytes.
const MAX_FRAME_PAYLOAD_BYTES: usize = 4 * 1024 * 1024 - 14;

pub(crate) const CERTIFICATE_REJECTED: &str = "Native provider TLS certificate verification failed";

// Only local TLS types can establish a certificate rejection. A provider body,
// peer alert, ordinary reset or request error text must not suppress retries.
pub(crate) fn tls_certificate_rejected(error: &(dyn std::error::Error + 'static)) -> bool {
    use tokio_rustls::rustls;
    let mut source = Some(error);
    while let Some(error) = source {
        if matches!(
            error.downcast_ref::<rustls::Error>(),
            Some(rustls::Error::InvalidCertificate(_))
        ) {
            return true;
        }
        #[cfg(target_os = "linux")]
        if let Some(error) = error.downcast_ref::<native_tls::Error>()
            && linux_certificate_status(&format!("{error:?}"))
        {
            return true;
        }
        #[cfg(target_os = "macos")]
        if let Some(error) = error.downcast_ref::<native_tls::Error>()
            && macos_certificate_status(&format!("{error:?}"))
        {
            return true;
        }
        #[cfg(target_os = "windows")]
        if let Some(error) = error.downcast_ref::<native_tls::Error>()
            && windows_certificate_status(&format!("{error:?}"))
        {
            return true;
        }
        source = error
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
            .map(|inner| inner as &(dyn std::error::Error + 'static))
            .or_else(|| error.source());
    }
    false
}

#[cfg(any(target_os = "linux", test))]
fn linux_certificate_status(debug: &str) -> bool {
    // The pinned native-tls/OpenSSL error omits the local X509 verify result
    // from source(). Only its final typed Debug field contains that result.
    let Some(debug) = debug.strip_prefix("Ssl(") else {
        return false;
    };
    let Some((_, result)) = debug.rsplit_once(", X509VerifyResult { code: ") else {
        return false;
    };
    let Some(result) = result.strip_suffix(" })") else {
        return false;
    };
    let Some((code, message)) = result.split_once(", error: ") else {
        return false;
    };
    let Ok(status) = code.parse::<i32>() else {
        return false;
    };
    status > 0 && status.to_string() == code && serde_json::from_str::<String>(message).is_ok()
}

#[cfg(any(target_os = "macos", test))]
fn macos_certificate_status(debug: &str) -> bool {
    let Some(fields) = debug
        .strip_prefix("Error { code: ")
        .and_then(|fields| fields.strip_suffix(" }"))
    else {
        return false;
    };
    let code = match fields.split_once(", message: ") {
        Some((code, message)) => {
            if serde_json::from_str::<String>(message).is_err() {
                return false;
            }
            code
        }
        None => fields,
    };
    matches!(
        code,
        "-9807" | "-9812" | "-9813" | "-9814" | "-9815" | "-67843"
    )
}

#[cfg(any(target_os = "windows", test))]
fn windows_certificate_status(debug: &str) -> bool {
    // Pinned native-tls/schannel wraps the io::Error from chain verification
    // but source() skips it. Read only the raw OS status of that typed error.
    let Some(fields) = debug
        .strip_prefix("Os { code: ")
        .and_then(|fields| fields.strip_suffix(" }"))
    else {
        return false;
    };
    let Some((code, fields)) = fields.split_once(", kind: ") else {
        return false;
    };
    let Some((kind, message)) = fields.split_once(", message: ") else {
        return false;
    };
    let Ok(status) = code.parse::<i32>() else {
        return false;
    };
    if status.to_string() != code
        || kind.is_empty()
        || !kind.bytes().all(|byte| byte.is_ascii_alphabetic())
        || serde_json::from_str::<String>(message).is_err()
    {
        return false;
    }
    // CERT_E_* local chain policy failures. Missing or offline revocation
    // services and SEC_E_* handshake/peer alerts must keep their retry behavior.
    matches!(
        status as u32,
        0x800b0101..=0x800b010a
            | 0x800b010c
            | 0x800b010d
            | 0x800b010f
            | 0x800b0110
            | 0x800b0112..=0x800b0114
            | 0x80092010 // CRYPT_E_REVOKED
    )
}

#[derive(Clone, Default)]
pub(crate) struct ConnectorCache(
    Arc<std::sync::Mutex<Option<codex_websocket_client::WebSocketConnector>>>,
);

impl ConnectorCache {
    fn connector(
        &self,
        factory: &codex_http_client::HttpClientFactory,
    ) -> napi::Result<WebSocketConnector> {
        let mut current = self.0.lock().map_err(|_| socket_error())?;
        if current.is_none() {
            *current = Some(WebSocketConnector::new(factory).map_err(|_| socket_error())?);
        }
        Ok(current.as_ref().expect("connector initialized").clone())
    }
}

struct SocketState {
    write: Mutex<Option<SplitSink<WebSocketConnection, Message>>>,
    read: Mutex<Option<SplitStream<WebSocketConnection>>>,
    terminal: watch::Sender<SocketTerminal>,
}

// Only an ordinary, observed peer end may reconnect before a generating send.
// A late read must never turn local retirement or policy denial into that permission.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum SocketTerminal {
    Live,
    PeerClosed,
    Retired,
    PolicyDenied,
}

impl SocketTerminal {
    fn from_transport_error(error: &Error) -> Self {
        if codex_websocket_client::network_policy_denial(error).is_some() {
            Self::PolicyDenied
        } else {
            Self::Retired
        }
    }

    fn error(self) -> napi::Error {
        if self == Self::PolicyDenied {
            crate::native_error("Native WebSocket network policy denied the operation")
        } else {
            socket_error()
        }
    }
}

impl SocketState {
    fn publish(&self, reason: SocketTerminal) {
        self.terminal.send_if_modified(|current| {
            if reason > *current {
                *current = reason;
                true
            } else {
                false
            }
        });
    }

    fn transport_error(&self, error: Error) -> napi::Error {
        self.publish(SocketTerminal::from_transport_error(&error));
        self.terminal.borrow().error()
    }

    fn peer_closed(&self, frame: Frame) -> napi::Result<Frame> {
        self.publish(SocketTerminal::PeerClosed);
        match *self.terminal.borrow() {
            SocketTerminal::PolicyDenied => Err(SocketTerminal::PolicyDenied.error()),
            SocketTerminal::Retired => Ok(Frame::Closed),
            _ => Ok(frame),
        }
    }

    async fn close(&self, code: u16, reason: String) {
        let already_retired = *self.terminal.borrow() >= SocketTerminal::Retired;
        self.publish(SocketTerminal::Retired);
        if let Some(mut write) = self.write.lock().await.take() {
            // Tungstenite buffers a failed or cancelled write. Never flush
            // that unknown prefix during cleanup of a retired socket.
            if !already_retired {
                let _ = tokio::time::timeout(Duration::from_millis(250), async {
                    let _ = write
                        .send(Message::Close(Some(CloseFrame {
                            code: code.into(),
                            reason: reason.into(),
                        })))
                        .await;
                    let _ = write.close().await;
                })
                .await;
            }
        }
        self.read.lock().await.take();
    }
}

// Cancellation after the first write may leave any prefix in the network.
// Dropping an incomplete native send retires the socket before another send.
struct PendingSend<'a> {
    state: &'a SocketState,
    write: tokio::sync::MutexGuard<'a, Option<SplitSink<WebSocketConnection, Message>>>,
    complete: bool,
}

impl Drop for PendingSend<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.write.take();
            self.state.publish(SocketTerminal::Retired);
        }
    }
}

// Unavailable upgrade results have no socket/receiver. They keep their
// existing refresh behavior; only a real socket has a local lifetime to fence.
impl Drop for SocketState {
    fn drop(&mut self) {
        self.publish(SocketTerminal::Retired);
    }
}

#[napi(js_name = "NativeModelWebSocket")]
pub struct NativeModelWebSocket {
    inner: Option<RuntimeOwned<SocketState>>,

    status: u16,
    headers: Vec<(String, String)>,
    error_body: Vec<u8>,
}

pub(crate) enum Frame {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
    Closed,
}

#[napi(object)]
pub struct NativeFrame {
    #[napi(js_name = "type")]
    pub kind: String,
    pub text: Option<String>,
    pub data: Option<napi::bindgen_prelude::Buffer>,
    pub code: Option<u16>,
    pub reason: Option<String>,
}

impl Frame {
    fn into_native(self) -> NativeFrame {
        let mut frame = NativeFrame {
            kind: String::new(),
            text: None,
            data: None,
            code: None,
            reason: None,
        };
        match self {
            Self::Text(text) => {
                frame.kind = "text".into();
                frame.text = Some(text);
            }
            Self::Binary(data) => {
                frame.kind = "binary".into();
                frame.data = Some(data.into());
            }
            Self::Close(code, reason) => {
                frame.kind = "close".into();
                frame.code = Some(code);
                frame.reason = Some(reason);
            }
            Self::Closed => frame.kind = "closed".into(),
        }
        frame
    }
}

fn socket_error() -> napi::Error {
    crate::native_error("Native WebSocket operation failed")
}

fn transport_error(error: Error) -> napi::Error {
    SocketTerminal::from_transport_error(&error).error()
}

impl NativeModelWebSocket {
    fn state(&self) -> napi::Result<Arc<SocketState>> {
        self.inner
            .as_ref()
            .map(|inner| Arc::clone(inner))
            .ok_or_else(socket_error)
    }

    async fn send(&self, data: Bytes, kind: Data) -> napi::Result<()> {
        let state = self.state()?;
        (async move {
            let mut terminal = state.terminal.subscribe();
            tokio::select! {
                biased;
                reason = terminal.wait_for(|reason| *reason != SocketTerminal::Live) => {
                    let reason = *reason.expect("send owns socket sender");
                    Err(reason.error())
                }
                result = async {
                    let write = state.write.lock().await;
                    let mut pending = PendingSend { state: &state, write, complete: false };
                    let mut start = 0;
                    loop {
                        let end = (start + MAX_FRAME_PAYLOAD_BYTES).min(data.len());
                        let final_frame = end == data.len();
                        let opcode = if start == 0 { kind } else { Data::Continue };
                        // Raw RFC data frames retain the client mask and skip per-message
                        // compression. This also bounds incompressible requests and permits
                        // UTF-8 code points to cross continuation boundaries.
                        let frame = WireFrame::message(
                            data.slice(start..end), OpCode::Data(opcode), final_frame,
                        );
                        pending.write.as_mut().ok_or_else(socket_error)?
                            .send(Message::Frame(frame)).await
                            .map_err(|error| state.transport_error(error))?;
                        if final_frame {
                            pending.complete = true;
                            return Ok(());
                        }
                        start = end;
                    }
                } => result,
            }
        })
        .await
    }
}

#[napi]
impl NativeModelWebSocket {
    #[napi(getter, js_name = "status")]
    pub fn get_status(&self) -> u16 {
        self.status
    }

    #[napi(getter, js_name = "headers")]
    pub fn get_headers(&self) -> Vec<Vec<String>> {
        self.headers
            .iter()
            .map(|(k, v)| vec![k.clone(), v.clone()])
            .collect()
    }
    #[napi(getter, js_name = "available")]
    pub fn available(&self) -> bool {
        self.inner.is_some()
    }

    #[napi(getter, js_name = "error_body")]
    pub fn error_body(&self) -> napi::bindgen_prelude::Buffer {
        self.error_body.clone().into()
    }

    #[napi(js_name = "project_response_items")]
    pub fn project_response_items(
        &self,
        items_json: String,
        content_item_kinds: bool,
    ) -> napi::Result<String> {
        let items_json = items_json.as_str();

        project_items(items_json, content_item_kinds)
    }

    #[napi(js_name = "send_text")]
    pub async fn send_text(&self, text: String) -> napi::Result<()> {
        if text.len() > MAX_REQUEST_BYTES {
            return Err(crate::input_error(format!(
                concat!(
                    "Native WebSocket request is {} UTF-8 bytes; the transport limit is {} bytes (64 MiB). ",
                    "Reduce the encoded input, instructions or tool schemas. Model context limits are separate."
                ),
                text.len(),
                MAX_REQUEST_BYTES,
            )));
        }
        self.send(Bytes::from(text), Data::Text).await
    }

    #[napi(js_name = "receive")]
    pub async fn receive(&self) -> napi::Result<Option<NativeFrame>> {
        Ok(self.receive_frame().await?.map(Frame::into_native))
    }
}

impl NativeModelWebSocket {
    pub(crate) async fn receive_frame(&self) -> napi::Result<Option<Frame>> {
        let state = self.state()?;
        (async move {
            let mut terminal = state.terminal.subscribe();
            let frame = tokio::select! {
                biased;
                reason = terminal.wait_for(|reason| *reason != SocketTerminal::Live) => {
                    let reason = *reason.expect("receive owns socket sender");
                    if reason == SocketTerminal::PolicyDenied {
                        return Err(reason.error());
                    }
                    Some(Frame::Closed)
                }
                result = async {
                    let mut read = state.read.lock().await;
                    let Some(read) = read.as_mut() else { return Ok(Some(Frame::Closed)) };
                    loop {
                        let message = read.next().await;
                        match message {
                            Some(Ok(Message::Text(text))) => return Ok(Some(Frame::Text(text.to_string()))),
                            Some(Ok(Message::Binary(data))) => return Ok(Some(Frame::Binary(data.to_vec()))),
                            Some(Ok(Message::Close(frame))) => {
                                return state.peer_closed(frame.map_or(Frame::Close(1000, String::new()), |frame| {
                                    Frame::Close(frame.code.into(), frame.reason.to_string())
                                })).map(Some);
                            }
                            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                            Some(Err(Error::ConnectionClosed | Error::AlreadyClosed)) | None => {
                                return state.peer_closed(Frame::Closed).map(Some);
                            }
                            Some(Err(error)) => {
                                let reason = SocketTerminal::from_transport_error(&error);
                                state.publish(if reason == SocketTerminal::PolicyDenied {
                                    reason
                                } else {
                                    SocketTerminal::PeerClosed
                                });
                                return Err(state.terminal.borrow().error());
                            }
                        }
                    }
                } => result?,
            };
            Ok(frame)
        }).await
    }
}

#[napi]
impl NativeModelWebSocket {
    #[napi(js_name = "close")]
    pub async fn close(&self, code: u16, reason: String) -> napi::Result<()> {
        let state = self.inner.as_ref().map(|inner| Arc::clone(inner));
        (async move {
            if let Some(state) = state {
                state.close(code, reason).await;
            }
            Ok(())
        })
        .await
    }
}

fn header_pairs(headers: &http::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
}

pub(super) fn sentinel_headers(
    value: &str,
    provider: &codex_api::Provider,
) -> napi::Result<http::HeaderMap> {
    let pairs: Vec<(String, String)> = serde_json::from_str(value).map_err(native_error)?;
    let nominated: Vec<String> = pairs
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, v)| v.split(',').map(|s| s.trim().to_ascii_lowercase()))
        .collect();
    let mut headers = http::HeaderMap::new();
    for (name, value) in pairs {
        let lower = name.to_ascii_lowercase();
        if nominated.contains(&lower)
            || matches!(
                lower.as_str(),
                "host"
                    | "connection"
                    | "upgrade"
                    | "content-length"
                    | "transfer-encoding"
                    | "keep-alive"
                    | "proxy-authorization"
                    | "proxy-authenticate"
                    | "proxy-connection"
                    | "te"
                    | "trailer"
                    | "sec-websocket-key"
                    | "sec-websocket-version"
                    | "sec-websocket-extensions"
                    | "sec-websocket-accept"
                    | "x-sdk-sentinel-grant"
            )
        {
            continue;
        }
        headers.append(
            name.parse::<http::HeaderName>().map_err(native_error)?,
            value.parse::<http::HeaderValue>().map_err(native_error)?,
        );
    }
    // The authenticated inbound grant and loopback Host are never provider
    // values. Restore only names declared by this original selected provider.
    for name in ["x-sdk-sentinel-grant", "host"] {
        if let Some(value) = provider.headers.get(name) {
            headers.insert(http::HeaderName::from_static(name), value.clone());
        }
    }
    Ok(headers)
}

pub(super) async fn sentinel_open(
    route: Arc<NativeModelRoute>,
    headers: &str,
) -> napi::Result<NativeModelWebSocket> {
    let provider = route.provider.api_provider().await.map_err(native_error)?;
    let forwarded = sentinel_headers(headers, &provider)?;
    let url = provider
        .websocket_url_for_path("responses")
        .map_err(native_error)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| socket_error())?;
    request.headers_mut().extend(forwarded.clone());
    let connector = route
        .websocket
        .connector(&route.client_factory)?
        .with_tcp_nodelay();
    let mut extensions = ExtensionsConfig::default();
    extensions.permessage_deflate = Some(DeflateConfig::default());
    let mut config = WebSocketConfig::default();
    config.extensions = extensions;
    let result = tokio::time::timeout(
        route.provider.info().websocket_connect_timeout(),
        connector.connect(request, config),
    )
    .await
    .map_err(|_| socket_error())?;
    let (inner, status, response_headers, error_body) = match result {
        Ok((socket, response)) => {
            let (write, read) = socket.split();
            (
                Some(RuntimeOwned::new(Arc::new(SocketState {
                    write: Mutex::new(Some(write)),
                    read: Mutex::new(Some(read)),
                    terminal: watch::channel(SocketTerminal::Live).0,
                }))),
                response.status().as_u16(),
                header_pairs(response.headers()),
                Vec::new(),
            )
        }
        Err(Error::Http(response)) => (
            None,
            response.status().as_u16(),
            header_pairs(response.headers()),
            response.body().clone().unwrap_or_default(),
        ),
        Err(error) if tls_certificate_rejected(&error) => (
            None,
            http::StatusCode::BAD_REQUEST.as_u16(),
            vec![("content-type".into(), "text/plain; charset=utf-8".into())],
            CERTIFICATE_REJECTED.as_bytes().to_vec(),
        ),
        Err(error) => return Err(transport_error(error)),
    };
    Ok(NativeModelWebSocket {
        inner,

        status,
        headers: response_headers,
        error_body,
    })
}

// The message bridge has been retaining the existing dialer and socket owner.
// Its only success metadata has been matching the old loopback upgrade surface.
pub(crate) async fn open_message_transport(
    engine: &super::engine::EngineState,
    expected_url: &str,
    request: http::Request<()>,
) -> Result<(String, NativeModelWebSocket, http::HeaderMap), codex_api::ApiError> {
    use base64::Engine as _;

    let unmatched = || {
        codex_api::ApiError::Transport(codex_client::TransportError::Http {
            status: http::StatusCode::UNAUTHORIZED,
            url: None,
            headers: Some(http::HeaderMap::new()),
            body: Some(String::new()),
            retry_after: None,
        })
    };
    if request.uri().to_string() != expected_url || request.method() != http::Method::GET {
        return Err(unmatched());
    }
    let binding = engine
        .sentinel
        .read()
        .expect("sentinel poisoned")
        .clone()
        .ok_or_else(unmatched)?;
    let websocket_base = if let Some(base) = binding.0.strip_prefix("http://") {
        format!("ws://{}", base.trim_end_matches('/'))
    } else if let Some(base) = binding.0.strip_prefix("https://") {
        format!("wss://{}", base.trim_end_matches('/'))
    } else {
        return Err(unmatched());
    };
    let prefix = format!("{websocket_base}/p-");
    let encoded = expected_url
        .strip_prefix(&prefix)
        .and_then(|path| path.strip_suffix("/responses"))
        .filter(|encoded| {
            !encoded.is_empty()
                && encoded
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        .ok_or_else(unmatched)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| unmatched())?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&decoded) != encoded
        || !request
            .headers()
            .get_all("x-sdk-sentinel-grant")
            .iter()
            .map(|value| value.as_bytes().trim_ascii())
            .eq(std::iter::once(binding.1.as_bytes()))
    {
        return Err(unmatched());
    }
    let provider_id = String::from_utf8(decoded).map_err(|_| message_transport_error())?;
    // Node rawHeaders has been decoding bytes as Latin-1 after trimming HTTP OWS.
    // HeaderValue validation has been excluding other ASCII control whitespace.
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|(name, value)| {
            let value: String = value
                .as_bytes()
                .trim_ascii()
                .iter()
                .copied()
                .map(char::from)
                .collect();
            (name.as_str().to_owned(), value)
        })
        .collect();
    let headers = serde_json::to_string(&headers).map_err(|_| message_transport_error())?;
    if engine.plan_authorization.is_some()
        || engine.manager.auth_manager().auth_mode() != Some(codex_protocol::auth::AuthMode::ApiKey)
    {
        return Err(message_transport_error());
    }
    let _permit = engine
        .operation(false)
        .map_err(|_| message_transport_error())?;
    let route = engine
        .sentinel_route(&provider_id, &headers)
        .map_err(|_| message_transport_error())?;
    let remote = sentinel_open(route, &headers)
        .await
        .map_err(|_| message_transport_error())?;
    let forwarded = match message_transport_headers(&remote.headers, remote.available()) {
        Ok(headers) => headers,
        Err(error) => {
            let _ = remote.close(1000, String::new()).await;
            return Err(error);
        }
    };
    if !remote.available() {
        let mut headers = forwarded;
        let body = &remote.error_body[..remote.error_body.len().min(64 * 1024)];
        headers.insert(
            http::header::CONTENT_LENGTH,
            http::HeaderValue::from_str(&body.len().to_string())
                .map_err(|_| message_transport_error())?,
        );
        headers.insert(
            http::header::CONNECTION,
            http::HeaderValue::from_static("close"),
        );
        return Err(codex_api::ApiError::Transport(
            codex_client::TransportError::Http {
                status: http::StatusCode::from_u16(remote.status)
                    .map_err(|_| message_transport_error())?,
                url: None,
                retry_after: codex_client::RetryAfter::from_headers(&headers),
                headers: Some(headers),
                // The old WebSocket client has been accepting only a UTF-8 error body.
                body: String::from_utf8(body.to_vec()).ok(),
            },
        ));
    }
    Ok((provider_id, remote, forwarded))
}

fn message_transport_error() -> codex_api::ApiError {
    // The old upgrade handler has been destroying the local socket on dial errors.
    // Neither private endpoint/grant nor upstream credentials have been entering this error.
    codex_api::ApiError::Transport(codex_client::TransportError::Network(
        "Native WebSocket operation failed".into(),
    ))
}

fn message_transport_headers(
    headers: &[(String, String)],
    rates_only: bool,
) -> Result<http::HeaderMap, codex_api::ApiError> {
    let nominated: Vec<String> = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, value)| {
            value
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
        })
        .collect();
    let mut forwarded = http::HeaderMap::new();
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        if nominated.contains(&name)
            || matches!(
                name.as_str(),
                "connection"
                    | "content-length"
                    | "content-encoding"
                    | "transfer-encoding"
                    | "keep-alive"
                    | "proxy-authenticate"
                    | "proxy-authorization"
                    | "te"
                    | "trailer"
                    | "upgrade"
                    | "x-agents-model-grant"
                    | "x-codex-agents-native-route"
                    | "x-sdk-sentinel-grant"
            )
        {
            continue;
        }
        let rate = name == "retry-after"
            || ["limit", "remaining", "reset"].iter().any(|kind| {
                ["requests", "tokens", "project-tokens"]
                    .iter()
                    .any(|scope| name == format!("x-ratelimit-{kind}-{scope}"))
            });
        if rates_only && !rate {
            continue;
        }
        forwarded.append(
            name.parse::<http::HeaderName>()
                .map_err(|_| message_transport_error())?,
            http::HeaderValue::from_str(value).map_err(|_| message_transport_error())?,
        );
    }
    Ok(forwarded)
}

#[cfg(test)]
mod certificate_tests {
    use super::*;
    use tokio_rustls::rustls;

    #[test]
    fn only_actual_local_certificate_failures_disable_retry() {
        assert!(tls_certificate_rejected(
            &rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)
        ));
        assert!(tls_certificate_rejected(&std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
        )));
        for error in [
            rustls::Error::AlertReceived(rustls::AlertDescription::UnknownCA),
            rustls::Error::AlertReceived(rustls::AlertDescription::CertificateUnknown),
        ] {
            assert!(!tls_certificate_rejected(&std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                error
            )));
        }
        assert!(!tls_certificate_rejected(&std::io::Error::other(
            "Native provider TLS certificate verification failed"
        )));
        assert!(!tls_certificate_rejected(&std::io::Error::other(
            "Error { code: -9812, message: \"invalid certificate\" }"
        )));
        assert!(!tls_certificate_rejected(&std::io::Error::other(
            "Os { code: -2146762487, kind: Uncategorized, message: \"untrusted root\" }"
        )));
    }

    #[test]
    fn decodes_pinned_local_verify_statuses_and_rejects_other_layouts() {
        assert!(linux_certificate_status(
            "Ssl(Error { code: ErrorCode(1), cause: None }, X509VerifyResult { code: 20, error: \"unable to get local issuer certificate\" })"
        ));
        for status in [
            "Ssl(Error { code: ErrorCode(1), cause: None }, X509VerifyResult { code: 0, error: \"ok\" })",
            "Ssl(Error { code: ErrorCode(1), cause: None }, X509VerifyResult { code: 020, error: \"bad\" })",
            "Ssl(Error { code: ErrorCode(1), cause: None }, X509VerifyResult { code: 20, error: null })",
            "provider: Ssl(Error, X509VerifyResult { code: 20, error: \"bad\" })",
        ] {
            assert!(!linux_certificate_status(status), "{status}");
        }
        for code in ["-9807", "-9812", "-9813", "-9814", "-9815", "-67843"] {
            assert!(macos_certificate_status(&format!(
                "Error {{ code: {code} }}"
            )));
        }
        for status in [
            "Error { code: -9836, message: \"Error { code: -9812 }\" }",
            "Error { code: -9800 }",
            "Error { code: -09812 }",
            "Error { code: -9812, message: null }",
        ] {
            assert!(!macos_certificate_status(status), "{status}");
        }
        for code in [0x800b0101u32, 0x800b0109, 0x800b010f, 0x80092010] {
            assert!(windows_certificate_status(&format!(
                "Os {{ code: {}, kind: Uncategorized, message: \"local policy\" }}",
                code as i32
            )));
        }
        for code in [
            0u32, 0x800b010e, // CERT_E_REVOCATION_FAILURE
            0x80092012, // CRYPT_E_NO_REVOCATION_CHECK
            0x80092013, // CRYPT_E_REVOCATION_OFFLINE
            0x80090325, // SEC_E_UNTRUSTED_ROOT: not manual chain verification
            10054,      // reset
        ] {
            assert!(!windows_certificate_status(&format!(
                "Os {{ code: {}, kind: Uncategorized, message: \"untrusted root\" }}",
                code as i32
            )));
        }
        for status in [
            "Custom { kind: Other, error: \"Os { code: -2146762487 }\" }",
            "provider: Os { code: -2146762487, kind: Uncategorized, message: \"no\" }",
            "Os { code: -02146762487, kind: Uncategorized, message: \"no\" }",
            "Os { code: -2146762487, kind: Uncategorized, message: null }",
        ] {
            assert!(!windows_certificate_status(status), "{status}");
        }
    }
}

pub(super) fn project_items(items_json: &str, content_item_kinds: bool) -> napi::Result<String> {
    let values: Vec<serde_json::Value> = serde_json::from_str(items_json).map_err(native_error)?;
    serde_json::to_string(&project_response_items(values, content_item_kinds)).map_err(native_error)
}

pub(crate) fn project_response_items(
    values: Vec<serde_json::Value>,
    content_item_kinds: bool,
) -> Vec<ResponseItem> {
    values
        .into_iter()
        .filter_map(|value| {
            let mut item: ResponseItem = serde_json::from_value(value).ok()?;
            if item.id().is_some_and(|id| !id.is_prefixed()) {
                item.set_id(None);
            }
            if !content_item_kinds {
                item.clear_content_item_kinds();
            }
            Some(item)
        })
        .collect()
}

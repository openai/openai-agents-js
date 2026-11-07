//! Real native dispatch tests with the existing Review delegate ownership path.
//! Managed ThreadManager turns and JavaScript task lifetimes also need the JS tests.
use super::*;
use codex_client::{Request, RequestBody, TransportError};
use futures_util::poll;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

struct Fixture {
    _home: tempfile::TempDir,
    engine: Arc<crate::engine::EngineState>,
    control: Arc<Control>,
    listener: Option<TcpListener>,
    url: String,
}

impl Fixture {
    async fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = json!({
            "model":"test-model", "model_provider":"direct",
            "model_providers.direct": {
                "name":"Direct transport fixture",
                "base_url":format!("http://{}/v1", listener.local_addr().unwrap()),
                "wire_api":"responses", "requires_openai_auth":false,
                "supports_websockets":false,
                "request_max_retries":0, "stream_max_retries":0
            },
            "approval_policy":"never", "sandbox_mode":"read-only",
            "web_search":"disabled", "features.code_mode":false,
            "features.shell_snapshot":false, "features.api_key_model_discovery":false
        });
        let runtime = json!({
            "codex_home":home.path(), "cwd":home.path(),
            "loader": {
                "ignore_user_config":true, "ignore_project_config":true,
                "ignore_user_and_project_exec_policy_rules":true,
                "ignore_managed_requirements":true, "ignore_login_requirements":true,
                "managed_config_path":home.path().join("managed.toml"),
                "system_config_path":home.path().join("system.toml"),
                "system_requirements_path":home.path().join("requirements.toml")
            }
        });
        let engine = Arc::new(
            crate::engine::EngineState::new(config.to_string(), runtime.to_string(), false, None)
                .await
                .unwrap(),
        );
        *engine.sentinel.write().unwrap() = Some((
            "http://127.0.0.1:1".into(),
            "synthetic-private-grant".into(),
            None,
        ));
        engine.interception.bind_engine(Arc::downgrade(&engine));
        let control = Arc::new(Control::new(
            codex_protocol::ThreadId::new().to_string(),
            true,
        ));
        control.review_delegate.set(true).unwrap();
        control
            .sentinel_provider
            .set(("direct".into(), false))
            .unwrap();
        engine.interception.register_control(&control);
        Self {
            _home: home,
            engine,
            control,
            listener: Some(listener),
            url: "http://127.0.0.1:1/p-ZGlyZWN0/responses".into(),
        }
    }

    fn issue(&self) -> (Request, Box<dyn ModelResponseInterceptor>) {
        let admission = test_tool_admission(
            &self.control.id,
            &codex_protocol::ThreadId::new().to_string(),
            None,
        );
        *self.control.direct_turn.lock().unwrap() = admission.turn_store().get::<DirectTurn>();
        let mut metadata = None;
        let guard = self
            .engine
            .interception
            .request(ModelRequestInput {
                kind: ModelRequestKind::Generation,
                thread_id: &self.control.id,
                client_metadata: &mut metadata,
                model: "test-model",
            })
            .expect("issued exact native ticket");
        let body = json!({"model":"test-model", "stream":true, "input":[],
            "client_metadata":metadata});
        let mut request = Request::new(http::Method::POST, self.url.clone()).with_json(&body);
        request.headers.insert(
            "x-sdk-sentinel-grant",
            "synthetic-private-grant".parse().unwrap(),
        );
        (request.into_prepared().unwrap(), guard)
    }

    fn dispatch(
        &self,
        request: Request,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<codex_client::StreamResponse, TransportError>,
    > {
        self.engine
            .interception
            .http_stream(&request.url)
            .expect("private route claimed")(request)
    }

    async fn assert_no_upstream(&self) {
        let mut accept = std::pin::pin!(self.listener.as_ref().unwrap().accept());
        assert!(
            poll!(&mut accept).is_pending(),
            "invalid private request opened an upstream connection"
        );
    }
}

async fn read_request(stream: TcpStream) -> (BufReader<TcpStream>, Vec<(String, Vec<u8>)>, Value) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line).await.unwrap();
    assert_eq!(line, b"POST /v1/responses HTTP/1.1\r\n");
    let mut headers = Vec::new();
    loop {
        line.clear();
        reader.read_until(b'\n', &mut line).await.unwrap();
        if line == b"\r\n" {
            break;
        }
        let colon = line.iter().position(|byte| *byte == b':').unwrap();
        headers.push((
            String::from_utf8(line[..colon].to_vec())
                .unwrap()
                .to_ascii_lowercase(),
            line[colon + 1..].trim_ascii().to_vec(),
        ));
    }
    let size: usize = std::str::from_utf8(
        &headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .unwrap()
            .1,
    )
    .unwrap()
    .parse()
    .unwrap();
    let mut body = vec![0; size];
    reader.read_exact(&mut body).await.unwrap();
    (reader, headers, serde_json::from_slice(&body).unwrap())
}

fn http_status(error: TransportError) -> http::StatusCode {
    match error {
        TransportError::Http { status, .. } => status,
        error => panic!("expected carrier HTTP category, got {error:?}"),
    }
}

fn edit_body(request: &mut Request, edit: impl FnOnce(&mut Value)) {
    let raw = request.prepare_body_for_send().unwrap().body_bytes();
    let mut body: Value = serde_json::from_slice(&raw).unwrap();
    edit(&mut body);
    request.body = Some(RequestBody::Raw(serde_json::to_vec(&body).unwrap().into()));
}

#[tokio::test]
async fn direct_http_exact_negative_receipts_never_open_upstream() {
    let fixture = Fixture::new().await;
    for case in [
        "grant",
        "duplicate grant",
        "provider",
        "model",
        "nonce",
        "turn",
        "cancel",
        "ticket",
    ] {
        let (mut request, guard) = fixture.issue();
        match case {
            "grant" => {
                request
                    .headers
                    .insert("x-sdk-sentinel-grant", "wrong".parse().unwrap());
            }
            "duplicate grant" => {
                request.headers.append(
                    "x-sdk-sentinel-grant",
                    "synthetic-private-grant".parse().unwrap(),
                );
            }
            "provider" => request.url = fixture.url.replace("ZGlyZWN0", "b3RoZXI"),
            "model" => edit_body(&mut request, |body| body["model"] = json!("wrong-model")),
            "nonce" => edit_body(&mut request, |body| {
                body["client_metadata"]["sdk_sentinel_nonce"] = json!("stale-nonce")
            }),
            "turn" => {
                *fixture.control.direct_turn.lock().unwrap() =
                    test_tool_admission(&fixture.control.id, "successor-turn", None)
                        .turn_store()
                        .get::<DirectTurn>();
            }
            "cancel" => fixture
                .control
                .direct_turn
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .cancelled
                .cancel(),
            "ticket" => {
                fixture
                    .control
                    .sentinel_request
                    .lock()
                    .unwrap()
                    .request
                    .take();
            }
            _ => unreachable!(),
        }
        let error = fixture
            .dispatch(request)
            .await
            .err()
            .expect("invalid receipt rejected");
        let expected = if matches!(case, "grant" | "duplicate grant") {
            http::StatusCode::UNAUTHORIZED
        } else {
            http::StatusCode::BAD_GATEWAY
        };
        assert_eq!(http_status(error), expected, "{case}");
        fixture.assert_no_upstream().await;
        drop(guard);
    }
    fixture.engine.close().await.unwrap();
}

#[tokio::test]
async fn direct_http_duplicate_content_encoding_is_rejected_before_admission() {
    let fixture = Fixture::new().await;
    for values in [
        vec!["identity", "identity"],
        vec!["identity", "gzip"],
        vec!["identity, identity"],
        vec!["gzip"],
    ] {
        let (mut request, guard) = fixture.issue();
        for value in values {
            request
                .headers
                .append("content-encoding", value.parse().unwrap());
        }
        let error = fixture
            .dispatch(request)
            .await
            .err()
            .expect("encoding rejected");
        assert_eq!(http_status(error), http::StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(
            !fixture
                .control
                .sentinel_request
                .lock()
                .unwrap()
                .request
                .as_ref()
                .unwrap()
                .admitted
                .load(Ordering::Acquire)
        );
        fixture.assert_no_upstream().await;
        drop(guard);
    }
    fixture.engine.close().await.unwrap();
}

#[tokio::test]
async fn direct_http_headers_and_private_metadata_reach_actual_provider_correctly() {
    for identity in [false, true] {
        let mut fixture = Fixture::new().await;
        let listener = fixture.listener.take().unwrap();
        let upstream = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut reader, headers, body) = read_request(stream).await;
            reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 4\r\nX-Request-Id: direct-provider\r\n\r\none\n").await.unwrap();
            (headers, body)
        });
        let (mut request, guard) = fixture.issue();
        request
            .headers
            .insert("authorization", "Bearer current-auth".parse().unwrap());
        request
            .headers
            .insert("originator", "current-origin".parse().unwrap());
        request
            .headers
            .insert("traceparent", "trace-marker".parse().unwrap());
        request
            .headers
            .append("x-repeated", "first".parse().unwrap());
        request
            .headers
            .append("x-repeated", "second".parse().unwrap());
        request.headers.insert(
            "x-obs-text",
            http::HeaderValue::from_bytes(b"\xe9").unwrap(),
        );
        if identity {
            request
                .headers
                .insert("content-encoding", "identity".parse().unwrap());
        }
        let mut response = fixture.dispatch(request).await.unwrap();
        assert_eq!(response.headers["x-request-id"], "direct-provider");
        let mut returned = Vec::new();
        while let Some(chunk) = response.bytes.next().await {
            returned.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(returned, b"one\n");
        let (headers, body) = upstream.await.unwrap();
        let values = |key: &str| {
            headers
                .iter()
                .filter(|(name, _)| name == key)
                .map(|(_, value)| value.as_slice())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            values("authorization"),
            vec![b"Bearer current-auth".as_slice()]
        );
        assert_eq!(values("originator"), vec![b"current-origin".as_slice()]);
        assert_eq!(values("traceparent"), vec![b"trace-marker".as_slice()]);
        assert_eq!(
            values("x-repeated"),
            vec![b"first".as_slice(), b"second".as_slice()]
        );
        assert_eq!(values("x-obs-text"), vec![b"\xc3\xa9".as_slice()]);
        assert!(values("x-sdk-sentinel-grant").is_empty());
        assert!(body["client_metadata"].get("sdk_sentinel_thread").is_none());
        assert!(body["client_metadata"].get("sdk_sentinel_nonce").is_none());
        assert_eq!(body["model"], "test-model");
        drop(response);
        drop(guard);
        fixture.engine.close().await.unwrap();
    }
}

#[test]
fn direct_http_response_headers_keep_carrier_encoding_and_private_filter() {
    let mut headers = http::HeaderMap::new();
    headers.insert("connection", "x-drop".parse().unwrap());
    headers.insert("x-drop", http::HeaderValue::from_bytes(b"\xe9").unwrap());
    headers.insert("x-sdk-sentinel-grant", "private".parse().unwrap());
    headers.append("x-repeated", "one".parse().unwrap());
    headers.append("x-repeated", "two".parse().unwrap());
    headers.insert(
        "x-obs-text",
        http::HeaderValue::from_bytes(b"\xc3\xa9").unwrap(),
    );
    let forwarded = crate::sentinel_response_headers(headers).unwrap();
    assert!(!forwarded.contains_key("x-drop"));
    assert!(!forwarded.contains_key("x-sdk-sentinel-grant"));
    assert_eq!(forwarded["x-obs-text"].as_bytes(), b"\xe9");
    assert_eq!(forwarded.get_all("x-repeated").iter().count(), 2);
    let mut invalid = http::HeaderMap::new();
    invalid.insert(
        "x-obs-text",
        http::HeaderValue::from_bytes(b"\xe9").unwrap(),
    );
    assert!(crate::sentinel_response_headers(invalid).is_err());
}

#[tokio::test]
async fn direct_http_drop_releases_upstream_before_headers_and_during_sse() {
    for before_headers in [true, false] {
        let mut fixture = Fixture::new().await;
        let listener = fixture.listener.take().unwrap();
        let (entered, ready) = tokio::sync::oneshot::channel();
        let upstream = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut reader, _, _) = read_request(stream).await;
            if !before_headers {
                reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n").await.unwrap();
            }
            entered.send(()).unwrap();
            let mut byte = [0];
            assert_eq!(
                reader.read(&mut byte).await.unwrap(),
                0,
                "upstream stayed open"
            );
        });
        let (request, guard) = fixture.issue();
        if before_headers {
            let send = tokio::spawn(fixture.dispatch(request));
            ready.await.unwrap();
            send.abort();
            assert!(matches!(send.await, Err(error) if error.is_cancelled()));
        } else {
            let mut response = fixture.dispatch(request).await.unwrap();
            ready.await.unwrap();
            let mut returned = Vec::new();
            while returned.len() < 3 {
                returned.extend_from_slice(&response.bytes.next().await.unwrap().unwrap());
            }
            assert_eq!(returned, b"one");
            drop(response);
        }
        tokio::time::timeout(Duration::from_secs(5), upstream)
            .await
            .expect("dropping direct transport must close upstream")
            .unwrap();
        drop(guard);
        tokio::time::timeout(Duration::from_secs(5), fixture.engine.close())
            .await
            .expect("transport drop must release context permits")
            .unwrap();
    }
}

#[tokio::test]
async fn direct_http_retired_weak_owner_fails_closed_without_upstream() {
    let fixture = Fixture::new().await;
    let (request, guard) = fixture.issue();
    let callback = fixture
        .engine
        .interception
        .http_stream(&request.url)
        .unwrap();
    let weak = Arc::downgrade(&fixture.engine);
    fixture.engine.close().await.unwrap();
    let Fixture {
        engine,
        control,
        listener,
        _home,
        ..
    } = fixture;
    drop(guard);
    drop(control);
    drop(engine);
    assert!(
        weak.upgrade().is_none(),
        "callback retained the engine strongly"
    );
    let error = callback(request)
        .await
        .err()
        .expect("retired owner rejected");
    assert_eq!(http_status(error), http::StatusCode::UNAUTHORIZED);
    let listener = listener.unwrap();
    let mut accept = std::pin::pin!(listener.accept());
    assert!(poll!(&mut accept).is_pending());
}

#[tokio::test]
async fn direct_http_route_errors_keep_401_vs_502_without_upstream() {
    let fixture = Fixture::new().await;
    for (segment, expected) in [
        ("", http::StatusCode::UNAUTHORIZED),
        ("Z", http::StatusCode::UNAUTHORIZED),
        ("bad!", http::StatusCode::UNAUTHORIZED),
        ("_w", http::StatusCode::BAD_GATEWAY),
    ] {
        let (mut request, guard) = fixture.issue();
        request.url = format!("http://127.0.0.1:1/p-{segment}/responses");
        let error = fixture
            .dispatch(request)
            .await
            .err()
            .expect("route rejected");
        assert_eq!(http_status(error), expected, "{segment}");
        fixture.assert_no_upstream().await;
        drop(guard);
    }
    fixture.engine.close().await.unwrap();
}

#[tokio::test]
async fn direct_http_review_admit_and_schema_restore_reject_cancelled_and_retired_receipt() {
    let fixture = Fixture::new().await;
    for cancelled in [true, false] {
        let (request, guard) = fixture.issue();
        let mut guard = Some(guard);
        let raw = request.prepare_body_for_send().unwrap().body_bytes();
        let body: Value = serde_json::from_slice(&raw).unwrap();
        let metadata = body["client_metadata"].clone();
        let owner = fixture.control.direct_turn.lock().unwrap().clone().unwrap();
        // Each independent case first proves that its fresh receipt works.
        let admitted = sentinel_admit(&fixture.engine, "direct", &metadata)
            .await
            .unwrap();
        let admitted: Value = serde_json::from_str(&admitted).unwrap();
        assert_eq!(admitted["kind"], "generation");
        assert_eq!(admitted["model"], "test-model");
        sentinel_restore_schemas(&fixture.engine, "direct", &metadata, &mut body.clone())
            .await
            .unwrap();
        for (provider, ticket) in [
            ("wrong-provider", metadata.clone()),
            (
                "direct",
                json!({
                    "sdk_sentinel_thread": metadata["sdk_sentinel_thread"],
                    "sdk_sentinel_nonce": "wrong-request",
                }),
            ),
        ] {
            assert!(
                sentinel_admit(&fixture.engine, provider, &ticket)
                    .await
                    .is_err()
            );
            assert!(
                sentinel_restore_schemas(&fixture.engine, provider, &ticket, &mut body.clone())
                    .await
                    .is_err()
            );
        }
        assert!(!owner.cancelled.is_cancelled());
        if cancelled {
            owner.cancelled.cancel();
        } else {
            // Retire a still-active receipt through the actual interceptor Drop.
            // Cancellation cannot explain the rejection in this fresh case.
            drop(guard.take());
            assert!(
                fixture
                    .control
                    .sentinel_request
                    .lock()
                    .unwrap()
                    .request
                    .is_none()
            );
            assert!(!owner.cancelled.is_cancelled());
        }
        assert!(
            sentinel_admit(&fixture.engine, "direct", &metadata)
                .await
                .is_err()
        );
        assert!(
            sentinel_restore_schemas(&fixture.engine, "direct", &metadata, &mut body.clone())
                .await
                .is_err()
        );
        fixture.assert_no_upstream().await;
        drop(guard);
    }
    fixture.engine.close().await.unwrap();
}
